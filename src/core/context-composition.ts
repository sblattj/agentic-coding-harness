// Context composition breakdown per run (issue #87).
//
// `totals.contextTokens` says HOW FULL the window was at the latest model
// call; this module says WHAT FILLED IT. It reads only the run's persisted
// events (no agent re-run, no network) and splits the window into:
//
//   prompt         user-role message text recorded in the event log
//   assistantText  assistant message text (not reasoning)
//   reasoning      reasoning text (`reasoning: true` messages, `reasoningContent`)
//   toolCalls      tool-call arguments the assistant emitted
//   toolResults    tool output fed back to the model, also split per tool
//   unattributed   the measured total minus everything above: system prompt,
//                  tool schemas, and any text the adapter never recorded
//
// HONESTY RULES
//  - The total is MEASURED (the latest-call occupancy the driver recorded, or
//    the same context meter re-run over the events). Components are
//    ESTIMATED from text size: characters / CHARS_PER_TOKEN_ESTIMATE, the same
//    rule `usage.context.toolOutputTokens` uses, so the two agree.
//  - Only events BEFORE the event that fed the latest-call reading count: what
//    that call's output says is not in that call's prompt. After an explicit
//    compaction marker, only events after the last marker count.
//  - A component is `null` (rendered n/a) when no event carrying it was seen:
//    an adapter without a reasoning split (claude drops thinking blocks), no
//    user message in the log, no tool events. Never a fabricated 0.
//  - Below `full` content capture (#72) every text component is n/a: a
//    "[STRIPPED]" marker has no size worth counting.
//  - Sum rule: when the estimates fit inside the total, `unattributed` is the
//    remainder and the parts sum to the total exactly. When the estimates
//    EXCEED the total, `unattributed` is n/a (never negative, never clamped,
//    nothing rescaled) and `withinTolerance` says whether the overshoot is
//    inside CONTEXT_COMPOSITION_TOLERANCE of the total (estimate error) or
//    beyond it (content dropped from the window, e.g. an unrecorded compaction,
//    or sub-agent traffic, which the persisted events cannot tell apart).
//  - With no last-call total (turn-total usage only, no usage, unknown
//    model), shares are fractions of the attributed estimate and labelled so.
//
// The output carries numbers and tool names only, never content.
import { STRIPPED } from './capture.ts';
import { CHARS_PER_TOKEN_ESTIMATE, charLength, createContextMeter, type ContextReading } from './context-meter.ts';
import { toEventMs } from './latency.ts';
import type { RunRecord } from './registry.ts';
import type { AgentEvent, UsageAvailability } from './types.ts';

/** Overshoot of the estimates over the measured total still called consistent (fraction of the total). */
export const CONTEXT_COMPOSITION_TOLERANCE = 0.1;

/** Tool rows the text table prints (the JSON carries every tool). */
export const CONTEXT_TOP_TOOLS = 5;

export const COMPOSITION_KEYS = ['prompt', 'assistantText', 'reasoning', 'toolCalls', 'toolResults', 'unattributed'] as const;
export type CompositionKey = (typeof COMPOSITION_KEYS)[number];

export const COMPOSITION_LABELS: Record<CompositionKey, string> = {
  prompt: 'prompt / user',
  assistantText: 'assistant text',
  reasoning: 'reasoning',
  toolCalls: 'tool calls',
  toolResults: 'tool results',
  unattributed: 'unattributed',
};

export interface CompositionComponent {
  key: CompositionKey;
  label: string;
  /** Tokens; null = n/a (the adapter or the capture tier gave no data for it). */
  tokens: number | null;
  /** tokens / denominator; null when tokens is n/a or there is no denominator. */
  share: number | null;
  /** True for the chars-per-token estimates; false for the measured remainder. */
  estimated: boolean;
  /** Why the component is n/a, in plain words. */
  reason?: string;
}

export interface ToolCompositionRow {
  name: string;
  calls: number;
  results: number;
  /** Estimated tokens of this tool's call arguments; null below full capture. */
  callTokens: number | null;
  /** Estimated tokens of this tool's output; null below full capture. */
  resultTokens: number | null;
  /** callTokens + resultTokens; null below full capture. */
  tokens: number | null;
  share: number | null;
}

export interface ContextComposition {
  total: {
    /** Latest-call occupancy; null when not knowable. */
    tokens: number | null;
    /** 'record' = the RunRecord's sealed reading; 'events' = re-derived by the context meter over the events. */
    source: 'record' | 'events' | null;
    reason?: string;
  };
  /** What `share` is a fraction of. */
  denominator: 'context-total' | 'attributed' | null;
  /** Always in COMPOSITION_KEYS order. */
  components: CompositionComponent[];
  /** Every tool, largest context share first (ties by name). */
  tools: ToolCompositionRow[];
  /** Sum of the estimated components that are not n/a; null when none is known. */
  attributedTokens: number | null;
  /** Sum of every component that is not n/a (equals total.tokens whenever unattributed is known). */
  sumTokens: number | null;
  /** (attributed - total) / total when the estimates exceed the total, else 0; null without a total. */
  overshoot: number | null;
  /** Parts reconcile with the total: exact remainder, or overshoot within the tolerance. Null without a total. */
  withinTolerance: boolean | null;
  tolerance: number;
  compactions: { count: number | null; reason?: string };
  /** Events counted (before the latest-call reading, after the last compaction marker). */
  eventsCounted: number;
  eventsTotal: number;
  /** Agent-reported category split (kiro context_usage), verbatim, when the record has one. */
  reported?: Record<string, number>;
  method: string;
}

export interface CompositionInput {
  agent?: string;
  /** The run's `usage.context` snapshot. */
  context?: UsageAvailability['context'];
  /** The run's `totals.contextTokens` (sealed last-call occupancy). */
  contextTokens?: number;
  /** The run's content-capture tier (#72); absent = full. */
  captureMode?: 'off' | 'metadata' | 'full';
  /** Model requested on the run (meter fallback when no event names one). */
  model?: string;
  /**
   * Exclusive upper bound (ms) of the events this run owns. A resumed session
   * appends to the same transcript, so a record owns its events up to the next
   * record's start (the `ach audit` rule); earlier runs' events stay, since a
   * resumed window really holds them.
   */
  windowEndMs?: number;
}

/** The RunRecord fields the derivation reads. */
export function compositionInput(rec: RunRecord, peers: RunRecord[] = []): CompositionInput {
  const end = compositionWindowEnd(rec, peers);
  return {
    ...(end !== undefined ? { windowEndMs: end } : {}),
    agent: rec.agent,
    ...(rec.usage?.context !== undefined ? { context: rec.usage.context } : {}),
    ...(rec.totals?.contextTokens !== undefined ? { contextTokens: rec.totals.contextTokens } : {}),
    ...(rec.captureMode !== undefined ? { captureMode: rec.captureMode } : {}),
    ...(rec.usage?.model?.requested !== undefined ? { model: rec.usage.model.requested } : {}),
  };
}

/**
 * The start of the next record that shares `rec`'s raw transcript (a resumed
 * session), or undefined when `rec` is the latest (or only) owner.
 */
export function compositionWindowEnd(rec: RunRecord, peers: RunRecord[]): number | undefined {
  if (rec.rawTranscript === undefined) return undefined;
  let end: number | undefined;
  for (const p of peers) {
    if (p.runId === rec.runId || p.rawTranscript !== rec.rawTranscript || p.startedAt <= rec.startedAt) continue;
    if (end === undefined || p.startedAt < end) end = p.startedAt;
  }
  return end;
}

/** The events before `endMs` (missing timestamps carry the previous one forward). */
function eventsBefore(events: AgentEvent[], endMs: number | undefined): AgentEvent[] {
  if (endMs === undefined) return events;
  let carry: number | null = null;
  const out: AgentEvent[] = [];
  for (const ev of events) {
    const ms = toEventMs(ev.timestamp);
    if (ms !== null) carry = ms;
    if (carry !== null && carry >= endMs) break;
    out.push(ev);
  }
  return out;
}

export const COMPOSITION_METHOD =
  `components estimated as characters / ${CHARS_PER_TOKEN_ESTIMATE} over the events before the latest model call; ` +
  `total = that call's measured prompt tokens; unattributed = total minus the estimates ` +
  `(system prompt, tool schemas, text the adapter does not record)`;

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object';
const isFiniteNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;

function isCompactionMarker(e: Record<string, unknown>): boolean {
  if (e.type === 'compaction' || e.type === 'compact_boundary') return true;
  if (e.subtype === 'compact_boundary') return true;
  return isObj(e.data) && e.data.subtype === 'compact_boundary';
}

/** True when a captured string (or any string inside a captured value) is the #72 strip marker. */
function isStripped(v: unknown): boolean {
  if (v === STRIPPED) return true;
  if (Array.isArray(v)) return v.some(isStripped);
  if (isObj(v)) return Object.values(v).some(isStripped);
  return false;
}

const toTokens = (chars: number): number => Math.ceil(chars / CHARS_PER_TOKEN_ESTIMATE);

/** The measured total and where it came from. */
function measuredTotal(
  input: CompositionInput,
  reading: ContextReading | undefined,
): ContextComposition['total'] {
  const ctx = input.context;
  // Same "known" rule as `ach stats --json` (src/cli/context-stats.ts): an
  // available, non-aggregate reading is occupancy.
  if (ctx?.available === true && ctx.basis !== 'turn-total' && isFiniteNum(ctx.tokens)) {
    return { tokens: ctx.tokens, source: 'record' };
  }
  if (ctx?.basis !== 'turn-total' && isFiniteNum(input.contextTokens)) return { tokens: input.contextTokens, source: 'record' };
  if (reading?.basis === 'last-call') return { tokens: reading.tokens, source: 'events' };
  if (ctx?.basis === 'turn-total' || reading?.basis === 'turn-total') {
    return { tokens: null, source: null, reason: 'only cumulative turn-total usage was reported; occupancy is unknown' };
  }
  return { tokens: null, source: null, reason: 'no latest-call usage reading for this run' };
}

/**
 * Split a run's context window into components, from its persisted events
 * and its RunRecord's context reading. Pure: no I/O.
 */
export function deriveContextComposition(allEvents: AgentEvent[], input: CompositionInput = {}): ContextComposition {
  const events = eventsBefore(allEvents, input.windowEndMs);
  // 1. Find the event that fed the latest-call reading (same meter the driver runs).
  const meter = input.agent !== undefined ? createContextMeter({ agent: input.agent, ...(input.model !== undefined ? { requestedModel: input.model } : {}) }) : null;
  let boundary = events.length;
  let reading: ContextReading | undefined;
  if (meter !== null) {
    let lastRecord: unknown;
    events.forEach((ev, i) => {
      meter.observe(ev);
      const r = meter.reading();
      if (r !== undefined && r.basis === 'last-call' && r.record !== lastRecord) {
        lastRecord = r.record;
        boundary = i;
      }
    });
    reading = meter.reading();
  }
  const total = measuredTotal(input, reading);

  // 2. Compaction markers before the boundary; count only what follows the last one.
  let start = 0;
  let markers = 0;
  for (let i = 0; i < boundary; i++) {
    const e = events[i] as Record<string, unknown>;
    if (isCompactionMarker(e)) {
      markers += 1;
      start = i + 1;
    }
  }

  // 3. Character sizes per component.
  let promptChars = 0;
  let assistantChars = 0;
  let reasoningChars = 0;
  let seenPrompt = false;
  let seenAssistant = false;
  let seenReasoning = false;
  let seenToolCall = false;
  let seenToolResult = false;
  let stripped = false;
  const tools = new Map<string, { calls: number; results: number; callChars: number; resultChars: number }>();
  const byId = new Map<string, string>();
  const idless: string[] = [];
  const tool = (name: string) => {
    let t = tools.get(name);
    if (t === undefined) {
      t = { calls: 0, results: 0, callChars: 0, resultChars: 0 };
      tools.set(name, t);
    }
    return t;
  };
  const noteCall = (name: unknown, id: unknown, args: unknown) => {
    const n = typeof name === 'string' && name.trim() !== '' ? name : 'unknown';
    seenToolCall = true;
    if (isStripped(args) || n === STRIPPED) stripped = true;
    const t = tool(n);
    t.calls += 1;
    t.callChars += charLength(args);
    if (typeof id === 'string' && id !== '') byId.set(id, n);
    else idless.push(n);
  };
  const noteResult = (name: unknown, id: unknown, output: unknown) => {
    seenToolResult = true;
    if (isStripped(output)) stripped = true;
    let n: string | undefined = typeof name === 'string' && name.trim() !== '' ? name : undefined;
    if (n === undefined && typeof id === 'string' && id !== '') n = byId.get(id);
    if (n === undefined && (typeof id !== 'string' || id === '')) n = idless.pop();
    const t = tool(n ?? 'unknown');
    t.results += 1;
    t.resultChars += charLength(output);
  };

  for (let i = start; i < boundary; i++) {
    const e = events[i] as Record<string, unknown>;
    switch (e.type) {
      case 'message': {
        const role = e.source ?? e.role;
        const text = e.content ?? e.text;
        if (isStripped(text) || isStripped(e.reasoningContent)) stripped = true;
        if (role === 'user') {
          seenPrompt = true;
          promptChars += charLength(text);
        } else if (role === 'agent' || role === 'assistant') {
          if (e.reasoning === true) {
            seenReasoning = true;
            reasoningChars += charLength(text);
          } else {
            seenAssistant = true;
            assistantChars += charLength(text);
          }
          if (typeof e.reasoningContent === 'string') {
            seenReasoning = true;
            reasoningChars += e.reasoningContent.length;
          }
        }
        break;
      }
      case 'tool_call':
        noteCall(e.functionName, e.toolCallId, e.arguments);
        break;
      case 'tool_result':
        noteResult(undefined, e.toolCallId, e.content);
        break;
      case 'tool':
        if (e.phase === 'start') noteCall(e.toolName, e.toolCallId, e.input);
        else if (e.phase === 'result') noteResult(e.toolName, e.toolCallId, e.output);
        break;
      default:
        break;
    }
  }

  // 4. Components (n/a rules), then the remainder.
  const captured = !stripped && (input.captureMode === undefined || input.captureMode === 'full');
  const notCaptured = `content not captured (capture mode ${input.captureMode ?? 'metadata'})`;
  let toolCallChars = 0;
  let toolResultChars = 0;
  for (const t of tools.values()) {
    toolCallChars += t.callChars;
    toolResultChars += t.resultChars;
  }
  const est = (seen: boolean, chars: number, missing: string): { tokens: number | null; reason?: string } => {
    if (!captured) return { tokens: null, reason: notCaptured };
    if (!seen) return { tokens: null, reason: missing };
    return { tokens: toTokens(chars) };
  };
  const parts: Record<Exclude<CompositionKey, 'unattributed'>, { tokens: number | null; reason?: string }> = {
    prompt: est(seenPrompt, promptChars, 'no user message in the event log (this adapter does not record the prompt)'),
    assistantText: est(seenAssistant, assistantChars, 'no assistant message in the event log'),
    reasoning: est(seenReasoning, reasoningChars, 'this adapter records no reasoning text'),
    toolCalls: est(seenToolCall, toolCallChars, 'no tool calls in the event log'),
    toolResults: est(seenToolResult, toolResultChars, 'no tool results in the event log'),
  };
  const known = Object.values(parts).filter((p) => p.tokens !== null).map((p) => p.tokens as number);
  const attributed = known.length > 0 ? known.reduce((a, b) => a + b, 0) : null;

  let unattributed: { tokens: number | null; reason?: string };
  let overshoot: number | null = null;
  let withinTolerance: boolean | null = null;
  if (total.tokens === null) {
    unattributed = { tokens: null, reason: total.reason ?? 'no context total' };
  } else if (attributed === null) {
    unattributed = { tokens: null, reason: captured ? 'no component could be estimated' : notCaptured };
  } else if (attributed <= total.tokens) {
    unattributed = { tokens: total.tokens - attributed };
    overshoot = 0;
    withinTolerance = true;
  } else {
    overshoot = total.tokens > 0 ? (attributed - total.tokens) / total.tokens : Infinity;
    withinTolerance = overshoot <= CONTEXT_COMPOSITION_TOLERANCE;
    unattributed = {
      tokens: null,
      reason: withinTolerance
        ? `estimates exceed the total by ${(overshoot * 100).toFixed(1)}% (inside the ${CONTEXT_COMPOSITION_TOLERANCE * 100}% estimate tolerance)`
        : `estimates exceed the total by ${Number.isFinite(overshoot) ? (overshoot * 100).toFixed(1) + '%' : 'a zero total'}: content left the window (compaction?), sub-agent traffic counted as main-window content, or the chars-per-token estimate is off`,
    };
  }

  const denomValue = total.tokens !== null && total.tokens > 0 ? total.tokens : attributed !== null && attributed > 0 ? attributed : null;
  const denominator: ContextComposition['denominator'] =
    denomValue === null ? null : total.tokens !== null && total.tokens > 0 ? 'context-total' : 'attributed';
  const share = (tokens: number | null): number | null => (tokens === null || denomValue === null ? null : tokens / denomValue);

  const all = { ...parts, unattributed };
  const components: CompositionComponent[] = COMPOSITION_KEYS.map((key) => {
    const p = all[key];
    return {
      key,
      label: COMPOSITION_LABELS[key],
      tokens: p.tokens,
      share: share(p.tokens),
      estimated: key !== 'unattributed',
      ...(p.reason !== undefined ? { reason: p.reason } : {}),
    };
  });
  const sumKnown = components.filter((c) => c.tokens !== null).map((c) => c.tokens as number);

  const toolRows: ToolCompositionRow[] = [...tools.entries()]
    .map(([name, t]) => {
      const callTokens = captured ? toTokens(t.callChars) : null;
      const resultTokens = captured ? toTokens(t.resultChars) : null;
      const tokens = callTokens === null || resultTokens === null ? null : callTokens + resultTokens;
      return { name, calls: t.calls, results: t.results, callTokens, resultTokens, tokens, share: share(tokens) };
    })
    .sort((a, b) => (b.tokens ?? -1) - (a.tokens ?? -1) || b.calls + b.results - (a.calls + a.results) || a.name.localeCompare(b.name));

  const breakdown = input.context?.breakdown;
  const reported =
    isObj(breakdown) && Object.values(breakdown).every(isFiniteNum) && Object.keys(breakdown).length > 0
      ? { ...(breakdown as Record<string, number>) }
      : undefined;

  return {
    total,
    denominator,
    components,
    tools: toolRows,
    attributedTokens: attributed,
    sumTokens: sumKnown.length > 0 ? sumKnown.reduce((a, b) => a + b, 0) : null,
    overshoot,
    withinTolerance,
    tolerance: CONTEXT_COMPOSITION_TOLERANCE,
    compactions: markers > 0 ? { count: markers } : { count: null, reason: 'this adapter records no compaction marker' },
    eventsCounted: Math.max(0, boundary - start),
    eventsTotal: events.length,
    ...(reported !== undefined ? { reported } : {}),
    method: COMPOSITION_METHOD,
  };
}
