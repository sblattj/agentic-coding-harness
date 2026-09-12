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
  state(): KiroNormalizerState;
}

export interface KiroStderrModelAck {
  kind: 'modelAckUnsupported';
  model: string;
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

// -------------------------------------------------------------- normalizer

export function createKiroNormalizer(opts: { transport?: KiroTransport } = {}): KiroNormalizer {
  const transport: KiroTransport = opts.transport ?? 'headless';
  const toolCalls = new Map<string, KiroToolCallState>();

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
        const name = toolName(update);
        const existing = id !== '' ? toolCalls.get(id) : undefined;
        if (existing) {
          // Dedupe: one `tool` start per toolCallId. A later, richer start
          // (the one carrying _meta.kiro.toolName) only refines the state.
          if (name !== 'unknown') existing.name = name;
          out.push(vendorStep('toolCallDuplicate', update, { toolCallId: id }));
          return;
        }
        if (id !== '') {
          toolCalls.set(id, { name, status: 'started', startedSeen: true, resultSeen: false });
        }
        out.push({
          type: 'tool',
          toolName: name,
          phase: 'start',
          ...(id !== '' ? { toolCallId: id } : {}),
          input: update.rawInput ?? null,
        });
        return;
      }
      case 'tool_call_update': {
        const id = typeof update.toolCallId === 'string' ? update.toolCallId : '';
        const st = typeof update.status === 'string' ? update.status : '';
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

  function toolName(update: Record<string, unknown>): string {
    const meta = isRecord(update._meta) ? update._meta : undefined;
    const kiro = meta && isRecord(meta.kiro) ? meta.kiro : undefined;
    if (kiro && typeof kiro.toolName === 'string' && kiro.toolName !== '') return kiro.toolName;
    return str(update, ['kind', 'title']) ?? 'unknown';
  }

  /** `runFinished` / `session/prompt` result: the ONLY native turn boundary. */
  function handleTerminal(data: Record<string, unknown>, out: CanonicalEvent[]): void {
    captureSession(data.sessionId, out);
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

  return { pushHeadlessLine, pushAcpMessage, state };
}
