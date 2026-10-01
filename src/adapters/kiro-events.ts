// Kiro event normalizer (pure) — wave 1/C of the kiro-acp plan.
//
// One normalizer for BOTH kiro transports:
//   * headless: `kiro-cli chat --output-format stream-json` stdout lines
//     (`{type:'runStarted'|'metadata'|'sessionUpdate'|'runFinished', data:{…}}`)
//     plus the LEGACY top-level shapes src/adapters/kiro.ts has always
//     handled (session/assistant/tool_use/tool_result/usage/error families).
//   * acp: parsed JSON-RPC messages from `kiro-cli acp` stdio
//     (`session/update`, vendor `_kiro.dev/*`, and a `session/prompt` result
//     handed in as `{kind:'promptResult', result}`).
//
// The module is PURE: no I/O, no timers, no process access. It owns no
// transport. Wave 2 (`kiro-headless`, `kiro-acp-wire`, `usage-truth`) wires it
// into the adapter and the driver.
//
// ---------------------------------------------------------------------------
// Decided semantics (see PLAN-kiro-acp.md § Events)
//
// CHUNKS vs TURNS. `agent_message_chunk` updates are emitted immediately as
// `step` events with `payload.kind:'chunk'` (so a live dashboard still ticks)
// and are ALSO buffered; the buffer is flushed as exactly ONE `message` event
// per turn when the turn ends — on `runFinished`, on a `session/prompt`
// result, or on the turn's final `metadata` (the one carrying
// `meteringUsage`), whichever arrives first. Every `step` this module emits
// carries `payload.countsAsTurn === false`; `state().turns` increments ONLY on
// a native turn terminator (`runFinished` / prompt result), never on a chunk,
// a vendor notification or a metadata frame. Wave 2's driver must count turns
// from that signal, not from `step`.
//
// USAGE. `metadata.meteringUsage` is CUMULATIVE across the run: one array
// entry per model call so far, so credits = sum of the LATEST array — never a
// sum of sums. Each accepted snapshot emits one `usage` event whose
// `tokens.extra` carries `credits` (the DELTA since the previous snapshot),
// `creditsCumulative`, `contextUsagePercentage`, `source:'native'` and
// `tokensAvailable:false`. kiro reports NO token counts natively, and
// AdapterTokenRecord requires numeric token fields, so those fields are 0 —
// the consumer MUST treat `extra.tokensAvailable === false` as "tokens
// unavailable" and render `unavailable`, never `0`/`$0.0000`. A snapshot whose
// cumulative sum equals the previous one emits nothing (double-count guard).
//
// NOTE for wave 2: `houseEventToCore` (src/adapters/shared.ts) rebuilds
// `extra` from scratch in its `usage` case and therefore DROPS
// `tokens.extra`. The `usage-truth` seat must merge `tokens.extra` through
// that bridge or the credits never reach the registry.
//
// DEFERRED TOOL STARTS (#107). kiro-cli announces a tool call twice for one
// `toolCallId`: first an id-only `tool_call` (2.26.x; 2.21.2 sends a
// `tool_call_chunk` with just kind/title), then the rich `tool_call` with
// `title`, `kind`, `locations[]`, `rawInput` and `_meta.kiro.toolName`. A
// message WITHOUT `rawInput` therefore does not emit the canonical start: it is
// kept as a `toolCallPending` step and its fields are buffered. The ONE `tool`
// start goes out when `rawInput` arrives (the rich follow-up, whose raw object
// stays as a `toolCallDuplicate` step) or, as fallbacks, on the first
// `tool_call_update` for that id (whose own rawInput/title/locations are merged
// first), on the next chunk, on the turn terminator, or on `flush()` at end of
// stream. The fallback is event-driven — no timers — so it is deterministic.
// Metadata frames and other tool calls do NOT flush: 2.21.2 puts a
// `_kiro.dev/metadata` frame between the two announcements. The start carries
// the richest `rawInput` seen as `input`, plus `title` / `locations` as display
// metadata. A start whose first message already has `rawInput` is emitted
// immediately, as before.
//
// RAW EVIDENCE. Every emitted `step` keeps the native object verbatim under
// `payload.raw`, and every `usage` keeps the native `metadata` payload under
// `tokens.raw`. Nothing is fabricated and nothing is discarded.

import type { AdapterTokenRecord, CanonicalEvent } from '../core/types.js';

// --------------------------------------------------------------- public types

export type KiroTransport = 'headless' | 'acp';

/** `tokens.extra` shape on every credits-only `usage` event this module emits. */
export interface KiroUsageExtra {
  /** Credits charged SINCE the previous snapshot (what a total should sum). */
  credits: number;
  /** Credits charged since the start of the run (the latest snapshot's sum). */
  creditsCumulative: number;
  /** Always 'native' here — these come from kiro's own metadata frames. */
  source: 'native';
  /** kiro reports no token counts: the numeric token fields are placeholders. */
  tokensAvailable: false;
  /** kiro's own context-window percentage on the same metadata frame. */
  contextUsagePercentage?: number;
  /** Per-model-call credit values of the latest snapshot, verbatim. */
  meteringUsage: unknown;
  /** kiro's reported turn wall time, when the frame carries it. */
  turnDurationMs?: number;
}

/** AdapterTokenRecord plus the kiro credits sidecar. */
export type KiroUsageTokens = AdapterTokenRecord & { extra: KiroUsageExtra };

export interface KiroToolCallState {
  name: string;
  status: 'started' | 'in_progress' | 'completed' | 'failed';
  startedSeen: boolean;
  resultSeen: boolean;
}

export interface KiroNormalizerState {
  nativeSessionId?: string;
  stopReason?: string;
  status?: string;
  credits: { latest: number | null; snapshots: number };
  contextUsagePercentage?: number;
  toolCalls: Map<string, KiroToolCallState>;
  turns: number;
  /** All assistant text seen in the run, chunks concatenated in order. */
  messageText: string;
}

export interface KiroNormalizer {
  pushHeadlessLine(line: string): CanonicalEvent[];
  pushAcpMessage(msg: unknown): CanonicalEvent[];
  /**
   * End of stream: emit anything still buffered (deferred tool starts). Call
   * once when the transport closes; a normal run has already flushed on its
   * terminator, so this returns [] then.
   */
  flush(): CanonicalEvent[];
  state(): KiroNormalizerState;
}

/** A tool start held back until its input arrives (#107). */
interface PendingTool {
  id: string;
  name: string;
  /** True once `_meta.kiro.toolName` named the tool (beats kind/title). */
  nameFromMeta: boolean;
  input: unknown;
  title?: string;
  locations?: unknown[];
}

export interface KiroStderrModelAck {
  kind: 'modelAckUnsupported';
  model: string;
}

export interface KiroStderrNotice {
  notice: 'mcpRegistrationFailed';
  warning: string;
}

// ----------------------------------------------------------------- helpers

const SESSION_TYPES = new Set(['session', 'session_start']);
const MESSAGE_TYPES = new Set(['assistant', 'assistant_message', 'assistantResponse', 'message']);
const TOOL_START_TYPES = new Set(['tool_use', 'toolUse', 'toolInvocation']);
const TOOL_RESULT_TYPES = new Set(['tool_result', 'toolResult']);
const USAGE_TYPES = new Set(['usage', 'metering', 'token_usage']);
const ERROR_TYPES = new Set(['error', 'systemError']);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function str(o: Record<string, unknown>, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === 'string' && v !== '') return v;
  }
  return undefined;
}

function hasValue(v: unknown): boolean {
  return v !== undefined && v !== null;
}

/** An input that carries nothing: absent, null, '' or {}. */
function isEmptyInput(v: unknown): boolean {
  return !hasValue(v) || v === '' || (isRecord(v) && Object.keys(v).length === 0);
}

/**
 * The richer of two `rawInput` values seen for one toolCallId: a present value
 * beats an absent one, a non-empty one beats an empty one, and between two
 * non-empty values the larger serialization wins (ties: the later one).
 */
function richerInput(current: unknown, next: unknown): unknown {
  if (!hasValue(next)) return current;
  if (!hasValue(current) || isEmptyInput(current)) return next;
  if (isEmptyInput(next)) return current;
  const size = (v: unknown): number => {
    try {
      return JSON.stringify(v)?.length ?? 0;
    } catch {
      return 0;
    }
  };
  return size(next) >= size(current) ? next : current;
}

function num(v: unknown): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return 0;
}

/** Sum the `value` fields of a `meteringUsage` array. Non-arrays → null. */
export function sumMeteringUsage(metering: unknown): number | null {
  if (!Array.isArray(metering)) return null;
  let total = 0;
  for (const entry of metering) {
    if (isRecord(entry)) total += num(entry.value);
  }
  return total;
}

/**
 * Legacy token vocabulary mapper (kept byte-compatible with
 * `mapKiroTokens` in kiro.ts so the legacy `usage` lines normalize the same).
 */
function mapLegacyTokens(o: Record<string, unknown>): AdapterTokenRecord {
  const tu = (o.tokenUsage ?? o.usage ?? o) as Record<string, unknown>;
  return {
    inputTokens: num(tu.inputTokens ?? tu.uncachedInputTokens),
    cacheReadTokens: num(tu.cacheReadTokens ?? tu.cacheReadInputTokens),
    cacheWriteTokens: num(tu.cacheWriteTokens ?? tu.cacheWriteInputTokens),
    outputTokens: num(tu.outputTokens),
    reasoningTokens: null,
    totalTokens: num(tu.totalTokens ?? tu.total) || null,
    durationMs: null,
    raw: o,
  };
}

/**
 * Parse the headless stderr line kiro-cli 2.21.2 prints when `--model` is not
 * supported by the running engine:
 *   `[warn] failed to set model 'claude-haiku-4.5': Method not found`
 * Anything else → null. Pure; wave 2 maps the hit to `modelAck:'unsupported'`.
 */
export function parseKiroStderrLine(line: string): KiroStderrModelAck | null {
  const m = /^\s*\[warn\]\s+failed to set model\s+'([^']*)'\s*:/.exec(line);
  if (!m) return null;
  return { kind: 'modelAckUnsupported', model: m[1] ?? '' };
}

/**
 * Parse a headless stderr notice worth surfacing as a `stderrNotice` step and
 * a driver warning, distinct from `parseKiroStderrLine`'s model-ack signal.
 * Currently recognizes kiro-cli's MCP dynamic client registration failure,
 * e.g. when a `~/.kiro/settings/mcp.json` (or agent `mcpServers`) entry points
 * at a server that rejects OAuth dynamic registration:
 *   `Dynamic registration failed: Registration failed: HTTP 400 Bad Request: ...`
 * The line never names the offending server; do not try to extract one.
 * Anything else → null. Pure.
 */
export function parseKiroStderrNotice(line: string): KiroStderrNotice | null {
  if (!/^\s*Dynamic registration failed:/.test(line)) return null;
  return {
    notice: 'mcpRegistrationFailed',
    warning:
      "kiro: MCP dynamic client registration failed (a server in ~/.kiro/settings/mcp.json or the agent's mcpServers rejected registration): " +
      line,
  };
}

// -------------------------------------------------------------- normalizer

export function createKiroNormalizer(opts: { transport?: KiroTransport } = {}): KiroNormalizer {
  const transport: KiroTransport = opts.transport ?? 'headless';
  const toolCalls = new Map<string, KiroToolCallState>();
  const pendingTools = new Map<string, PendingTool>();

  let nativeSessionId: string | undefined;
  let sessionEmitted = false;
  let stopReason: string | undefined;
  let status: string | undefined;
  let creditsLatest: number | null = null;
  let creditSnapshots = 0;
  let contextUsagePercentage: number | undefined;
  let turns = 0;
  let messageText = '';
  let pendingText = '';

  function vendorStep(kind: string, raw: unknown, extra: Record<string, unknown> = {}): CanonicalEvent {
    return { type: 'step', payload: { kind, transport, countsAsTurn: false, ...extra, raw } };
  }

  function captureSession(id: unknown, out: CanonicalEvent[]): void {
    if (typeof id !== 'string' || id === '') return;
    if (nativeSessionId === undefined) nativeSessionId = id;
    if (!sessionEmitted) {
      sessionEmitted = true;
      out.push({ type: 'session', sessionId: id });
    }
  }

  /** Flush the buffered chunk text as exactly one `message` event, if any. */
  function flushMessage(out: CanonicalEvent[]): void {
    if (pendingText === '') return;
    out.push({ type: 'message', role: 'assistant', text: pendingText });
    pendingText = '';
  }

  function handleMetadata(params: Record<string, unknown>, out: CanonicalEvent[]): void {
    captureSession(params.sessionId, out);
    if (typeof params.contextUsagePercentage === 'number') {
      contextUsagePercentage = params.contextUsagePercentage;
    }
    const sum = sumMeteringUsage(params.meteringUsage);
    if (sum === null) {
      out.push(vendorStep('metadata', params));
      return;
    }
    // A metering-bearing metadata frame is the turn's final frame: flush the
    // coalesced message BEFORE the usage event so consumers see text→usage.
    flushMessage(out);
    const previous = creditsLatest ?? 0;
    if (creditsLatest !== null && sum === creditsLatest) {
      // Same cumulative snapshot re-delivered: no charge, no event.
      out.push(vendorStep('metadata', params, { duplicateSnapshot: true }));
      return;
    }
    creditsLatest = sum;
    creditSnapshots += 1;
    const extra: KiroUsageExtra = {
      credits: sum - previous,
      creditsCumulative: sum,
      source: 'native',
      tokensAvailable: false,
      ...(contextUsagePercentage !== undefined ? { contextUsagePercentage } : {}),
      meteringUsage: params.meteringUsage,
      ...(typeof params.turnDurationMs === 'number' ? { turnDurationMs: params.turnDurationMs } : {}),
    };
    const tokens: KiroUsageTokens = {
      // kiro reports NO token counts; these zeros are placeholders and are
      // meaningless unless extra.tokensAvailable is true (it never is here).
      inputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 0,
      reasoningTokens: null,
      totalTokens: null,
      durationMs: typeof params.turnDurationMs === 'number' ? params.turnDurationMs : null,
      raw: params,
      extra,
    };
    out.push({ type: 'usage', tokens });
  }

  /** One ACP `update` object (`params.update`), from either transport. */
  function handleSessionUpdate(update: Record<string, unknown>, out: CanonicalEvent[]): void {
    const kind = typeof update.sessionUpdate === 'string' ? update.sessionUpdate : '';
    switch (kind) {
      case 'agent_message_chunk':
      case 'agent_thought_chunk': {
        const content = isRecord(update.content) ? update.content : undefined;
        const text = content && typeof content.text === 'string' ? content.text : '';
        // The model is talking again: no rich follow-up is coming for a
        // still-deferred tool start, so emit it now (event-driven fallback).
        flushPendingTools(out);
        if (kind === 'agent_message_chunk') {
          pendingText += text;
          messageText += text;
        }
        out.push(vendorStep('chunk', update, { text, chunkKind: kind }));
        return;
      }
      case 'tool_call':
      case 'tool_call_chunk': {
        const id = typeof update.toolCallId === 'string' ? update.toolCallId : '';
        if (id === '') {
          // No id to merge on: emit as-is (nothing could ever refine it).
          const p = newPendingTool('');
          mergePendingTool(p, update);
          out.push(toolStartEvent(p));
          return;
        }
        const existing = toolCalls.get(id);
        if (existing && existing.startedSeen) {
          // The start already went out (it carried rawInput): a later message
          // for the same id only refines the name and stays as raw evidence.
          const name = toolName(update);
          if (name !== 'unknown') existing.name = name;
          out.push(vendorStep('toolCallDuplicate', update, { toolCallId: id }));
          return;
        }
        const pending = pendingTools.get(id);
        const p = pending ?? newPendingTool(id);
        mergePendingTool(p, update);
        if (existing) existing.name = p.name;
        else toolCalls.set(id, { name: p.name, status: 'started', startedSeen: false, resultSeen: false });
        if (hasValue(p.input)) {
          // Rich message (rawInput present): the ONE canonical start (#107).
          emitToolStart(p, out);
          if (pending) out.push(vendorStep('toolCallDuplicate', update, { toolCallId: id }));
          return;
        }
        // Id-only (or input-less) announcement: defer the start until the
        // rich follow-up or the first tool_call_update (see DEFERRED TOOL
        // STARTS in the header). The raw message is kept as a step.
        pendingTools.set(id, p);
        out.push(vendorStep(pending ? 'toolCallDuplicate' : 'toolCallPending', update, { toolCallId: id }));
        return;
      }
      case 'tool_call_update': {
        const id = typeof update.toolCallId === 'string' ? update.toolCallId : '';
        const st = typeof update.status === 'string' ? update.status : '';
        const pending = id !== '' ? pendingTools.get(id) : undefined;
        if (pending) {
          // First update for a deferred start: it may carry the input too.
          mergePendingTool(pending, update);
          const known = toolCalls.get(id);
          if (known) known.name = pending.name;
          emitToolStart(pending, out);
        }
        const entry = id !== '' ? toolCalls.get(id) : undefined;
        if (st !== 'completed' && st !== 'failed') {
          if (entry) entry.status = st === 'in_progress' ? 'in_progress' : entry.status;
          out.push(vendorStep('toolCallUpdate', update, { toolCallId: id, status: st }));
          return;
        }
        if (entry) {
          entry.status = st;
          entry.resultSeen = true;
        }
        // A result for an id we never saw start is still emitted — never
        // dropped — with an explicitly unknown tool name.
        out.push({
          type: 'tool',
          toolName: entry ? entry.name : 'unknown',
          phase: 'result',
          ...(id !== '' ? { toolCallId: id } : {}),
          output: update.rawOutput ?? null,
          status: st === 'completed' ? 'success' : 'error',
        });
        return;
      }
      default:
        out.push(vendorStep('vendor', update, { sessionUpdate: kind }));
    }
  }

  function metaToolName(update: Record<string, unknown>): string | undefined {
    const meta = isRecord(update._meta) ? update._meta : undefined;
    const kiro = meta && isRecord(meta.kiro) ? meta.kiro : undefined;
    if (kiro && typeof kiro.toolName === 'string' && kiro.toolName !== '') return kiro.toolName;
    return undefined;
  }

  function toolName(update: Record<string, unknown>): string {
    return metaToolName(update) ?? str(update, ['kind', 'title']) ?? 'unknown';
  }

  function newPendingTool(id: string): PendingTool {
    return { id, name: 'unknown', nameFromMeta: false, input: undefined };
  }

  /** Fold one tool_call / tool_call_chunk / tool_call_update into a pending start. */
  function mergePendingTool(p: PendingTool, update: Record<string, unknown>): void {
    const meta = metaToolName(update);
    if (meta !== undefined) {
      p.name = meta;
      p.nameFromMeta = true;
    } else if (!p.nameFromMeta) {
      const fallback = str(update, ['kind', 'title']);
      if (fallback !== undefined) p.name = fallback;
    }
    p.input = richerInput(p.input, update.rawInput);
    if (typeof update.title === 'string' && update.title !== '') p.title = update.title;
    if (Array.isArray(update.locations) && update.locations.length > 0) p.locations = update.locations;
  }

  function toolStartEvent(p: PendingTool): CanonicalEvent {
    return {
      type: 'tool',
      toolName: p.name,
      phase: 'start',
      ...(p.id !== '' ? { toolCallId: p.id } : {}),
      input: p.input ?? null,
      ...(p.title !== undefined ? { title: p.title } : {}),
      ...(p.locations !== undefined ? { locations: p.locations } : {}),
    };
  }

  function emitToolStart(p: PendingTool, out: CanonicalEvent[]): void {
    pendingTools.delete(p.id);
    const entry = toolCalls.get(p.id);
    if (entry) entry.startedSeen = true;
    out.push(toolStartEvent(p));
  }

  /** Deterministic fallback: emit every still-deferred start, in arrival order. */
  function flushPendingTools(out: CanonicalEvent[]): void {
    for (const p of [...pendingTools.values()]) emitToolStart(p, out);
  }

  /** `runFinished` / `session/prompt` result: the ONLY native turn boundary. */
  function handleTerminal(data: Record<string, unknown>, out: CanonicalEvent[]): void {
    captureSession(data.sessionId, out);
    flushPendingTools(out);
    flushMessage(out);
    if (typeof data.status === 'string') status = data.status;
    if (typeof data.stopReason === 'string') stopReason = data.stopReason;
    turns += 1;
    // CanonicalEvent has no terminal variant (see src/core/types.ts,
    // `CanonicalEvent`) — the run's real terminal event is synthesized by the
    // driver from process exit. Carry the native fields on a step instead.
    out.push(
      vendorStep('runFinished', data, {
        ...(typeof data.status === 'string' ? { status: data.status } : {}),
        ...(typeof data.stopReason === 'string' ? { stopReason: data.stopReason } : {}),
        turn: turns,
      }),
    );
  }

  // ---------------------------------------------------------- legacy shapes

  function handleLegacy(o: Record<string, unknown>, type: string, out: CanonicalEvent[]): boolean {
    const sessionId = str(o, ['sessionId', 'session_id', 'sessionID']);
    if (SESSION_TYPES.has(type)) {
      if (sessionId) captureSession(sessionId, out);
      else out.push(vendorStep('vendor', o));
      return true;
    }
    if (MESSAGE_TYPES.has(type)) {
      const role = str(o, ['role']);
      out.push({
        type: 'message',
        role: role === 'user' || role === 'system' ? role : 'assistant',
        text: str(o, ['text', 'content', 'message']) ?? '',
      });
      return true;
    }
    if (TOOL_START_TYPES.has(type)) {
      const id = str(o, ['toolCallId', 'tool_call_id', 'id']);
      out.push({
        type: 'tool',
        toolName: str(o, ['name', 'tool_name', 'toolName']) ?? 'unknown',
        phase: 'start',
        ...(id ? { toolCallId: id } : {}),
        input: o.input ?? o.arguments ?? o.args ?? null,
      });
      return true;
    }
    if (TOOL_RESULT_TYPES.has(type)) {
      const id = str(o, ['toolCallId', 'tool_call_id', 'id']);
      out.push({
        type: 'tool',
        toolName: str(o, ['name', 'tool_name', 'toolName']) ?? 'unknown',
        phase: 'result',
        ...(id ? { toolCallId: id } : {}),
        output: o.output ?? o.result ?? o.content ?? null,
        ...(typeof o.isError === 'boolean' ? { status: o.isError ? ('error' as const) : ('success' as const) } : {}),
      });
      return true;
    }
    if (USAGE_TYPES.has(type)) {
      out.push({ type: 'usage', tokens: mapLegacyTokens(o) });
      return true;
    }
    if (ERROR_TYPES.has(type)) {
      out.push({ type: 'error', message: str(o, ['message', 'error', 'reason']) ?? 'unknown error' });
      return true;
    }
    return false;
  }

  // ----------------------------------------------------------------- inputs

  function pushHeadlessLine(line: string): CanonicalEvent[] {
    const out: CanonicalEvent[] = [];
    if (typeof line !== 'string' || line.trim() === '') return out;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line.trim());
    } catch {
      return out;
    }
    if (!isRecord(parsed)) return out;
    const o = parsed;
    const type = typeof o.type === 'string' ? o.type : '';
    const data = isRecord(o.data) ? o.data : {};
    switch (type) {
      case 'runStarted':
        out.push(vendorStep('runStarted', data));
        return out;
      case 'metadata':
        handleMetadata(data, out);
        return out;
      case 'sessionUpdate': {
        captureSession(data.sessionId, out);
        if (isRecord(data.update)) handleSessionUpdate(data.update, out);
        else out.push(vendorStep('vendor', o));
        return out;
      }
      case 'runFinished':
        handleTerminal(data, out);
        return out;
      default:
        if (handleLegacy(o, type, out)) return out;
        out.push(vendorStep('vendor', o));
        return out;
    }
  }

  function pushAcpMessage(msg: unknown): CanonicalEvent[] {
    const out: CanonicalEvent[] = [];
    if (!isRecord(msg)) return out;
    // Prompt result handed in by the ACP client as {kind:'promptResult', result}.
    if (msg.kind === 'promptResult') {
      handleTerminal(isRecord(msg.result) ? msg.result : {}, out);
      return out;
    }
    const method = typeof msg.method === 'string' ? msg.method : '';
    const params = isRecord(msg.params) ? msg.params : {};
    if (method === 'session/update' || method === '_kiro.dev/session/update') {
      captureSession(params.sessionId, out);
      if (isRecord(params.update)) handleSessionUpdate(params.update, out);
      else out.push(vendorStep('vendor', msg));
      return out;
    }
    if (method === '_kiro.dev/metadata') {
      handleMetadata(params, out);
      return out;
    }
    if (method !== '') {
      captureSession(params.sessionId, out);
      out.push(vendorStep('vendor', msg, { method }));
      return out;
    }
    // A JSON-RPC response: capture a session id (session/new) and keep it raw.
    if (isRecord(msg.result)) captureSession(msg.result.sessionId, out);
    out.push(vendorStep('vendor', msg));
    return out;
  }

  function flush(): CanonicalEvent[] {
    const out: CanonicalEvent[] = [];
    flushPendingTools(out);
    flushMessage(out);
    return out;
  }

  function state(): KiroNormalizerState {
    return {
      ...(nativeSessionId !== undefined ? { nativeSessionId } : {}),
      ...(stopReason !== undefined ? { stopReason } : {}),
      ...(status !== undefined ? { status } : {}),
      credits: { latest: creditsLatest, snapshots: creditSnapshots },
      ...(contextUsagePercentage !== undefined ? { contextUsagePercentage } : {}),
      toolCalls,
      turns,
      messageText,
    };
  }

  return { pushHeadlessLine, pushAcpMessage, flush, state };
}
