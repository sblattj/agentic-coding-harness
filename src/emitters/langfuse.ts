import { Buffer } from 'node:buffer';
import type { AgentEvent, CanonicalTokenRecord } from '../core/types.js';
import { toOtlpJson } from './otel.js';
import type { EmitRunOptions, OtlpResourceSpansJson, OtlpSpanJson } from './otel.js';

/**
 * Canonical-first usage reader: uses the 5-field canonical record when the
 * legacy promptTokens/completionTokens/cachedTokens aliases are absent
 * (prompt = input + cache slices; see docs/TOKEN-COUNTING.md).
 */
function effectiveUsage(u: CanonicalTokenRecord): {
  prompt: number;
  completion: number;
  cached: number;
  cacheWrite: number;
  reasoning: number;
  cost: number;
} {
  const cacheRead = u.cacheReadTokens ?? 0;
  const cacheWrite = u.cacheWriteTokens ?? 0;
  return {
    prompt: u.promptTokens ?? (u.inputTokens ?? 0) + cacheRead + cacheWrite,
    completion: u.completionTokens ?? (u.outputTokens ?? 0),
    cached: u.cachedTokens ?? cacheRead,
    cacheWrite,
    reasoning: u.reasoningTokens ?? 0,
    cost: u.costUsd ?? 0,
  };
}

export interface LangfuseIngestOptions {
  baseUrl: string;
  publicKey: string;
  secretKey: string;
}

export interface LangfusePayloadOptions {
  sessionId: string;
  agentName: string;
  model: string;
}

export interface LangfuseEmitOptions extends LangfuseIngestOptions, LangfusePayloadOptions {
  /** Injectable fetch for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

export interface LangfuseEmitResult {
  ok: boolean;
  url: string;
  status: number;
  body: string;
  /** OTLP trace id (32 hex chars) the payload was built around. */
  traceId: string;
  spanCount: number;
  /** The exact JSON document that was POSTed. */
  payload: OtlpResourceSpansJson;
}

/**
 * Langfuse usage_details contract (langfuse.com/docs → Token & Cost Tracking):
 * every key is a mutually-exclusive bucket — each token counted exactly once.
 * `input` excludes cache slices; cache reads/writes are their own buckets.
 * Flat usage_details keys are stored verbatim (no normalization server-side).
 * `total` is derived by Langfuse as the sum of buckets when omitted.
 */
function usageBuckets(u: CanonicalTokenRecord): Record<string, number> {
  const e = effectiveUsage(u);
  const buckets: Record<string, number> = {
    input: Math.max(0, e.prompt - e.cached - e.cacheWrite),
    output: e.completion,
  };
  if (e.cached > 0) buckets.cache_read_input_tokens = e.cached;
  if (e.cacheWrite > 0) buckets.cache_creation_input_tokens = e.cacheWrite;
  return buckets;
}

function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

function attr(span: OtlpSpanJson, key: string): string | undefined {
  const value = span.attributes.find((a) => a.key === key)?.value.stringValue;
  return typeof value === 'string' ? value : undefined;
}

function setAttr(span: OtlpSpanJson, key: string, value: string): void {
  span.attributes.push({ key, value: { stringValue: value } });
}

/**
 * usage/model_call_end usage records in stream order — mirrors deriveSpans'
 * filter in otel.ts (one chat span per event carrying `usage`), so entries
 * zip 1:1 with the chat spans toOtlpJson emits.
 */
function chatUsageRecords(
  events: AgentEvent[],
  opts: LangfusePayloadOptions,
): Array<{ usage: CanonicalTokenRecord; model: string }> {
  const out: Array<{ usage: CanonicalTokenRecord; model: string }> = [];
  for (const ev of events) {
    if (ev.type !== 'usage' && ev.type !== 'model_call_end') continue;
    const usage = ev.usage;
    if (!usage) continue;
    out.push({
      usage,
      model:
        (usage.model as string | undefined) ??
        (ev.type === 'model_call_end' ? ((ev.model as string | undefined) ?? opts.model) : opts.model),
    });
  }
  return out;
}


interface ModelSlice {
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
  costUsd: number;
}

/** Read extra.raw.models from a CanonicalTokenRecord; [] when absent. */
function modelSlices(u: CanonicalTokenRecord): ModelSlice[] {
  const extra = u.extra as { raw?: { models?: unknown } } | undefined;
  const list = extra?.raw?.models;
  if (!Array.isArray(list)) return [];
  return list.filter((x): x is ModelSlice =>
    typeof x === 'object' && x !== null &&
    typeof (x as ModelSlice).model === 'string' &&
    typeof (x as ModelSlice).input === 'number');
}

let spanCounter = 0;
function newSpanId(): string {
  // 16-hex chars, never all-zero; monotonic within a payload for testability.
  spanCounter = (spanCounter + 1) & 0xffffffff;
  const hex = (Date.now() & 0xffffffff).toString(16).padStart(8, '0') +
    spanCounter.toString(16).padStart(8, '0');
  return hex.startsWith('0') ? `1${hex.slice(1)}` : hex;
}

/**
 * Pure function: reuse the gen_ai OTLP payload from otel.ts, then layer the
 * langfuse.* namespace on top (langfuse.* attributes take precedence in
 * Langfuse's OTLP mapping):
 *   - every span: `langfuse.session.id` (propagated so filters aggregate)
 *   - root `invoke_agent` span: observation type `span` + trace name
 *   - chat spans: observation type `generation` + `langfuse.observation.model.name`
 *     + `langfuse.observation.usage_details` (exclusive buckets) +
 *     `langfuse.observation.cost_details` when costUsd is present
 *   - tool spans: observation type `span` (tool name already in gen_ai.tool.name)
 */
export function toLangfuseOtlpJson(
  events: AgentEvent[],
  opts: LangfusePayloadOptions,
): OtlpResourceSpansJson {
  const doc = toOtlpJson(events, opts);
  const resource = doc.resourceSpans[0];
  const scope = resource?.scopeSpans[0];
  const spans = scope?.spans ?? [];
  const chats = chatUsageRecords(events, opts);
  let chatIndex = 0;

  const outSpans: OtlpSpanJson[] = [];
  for (const span of spans) {
    const operation = attr(span, 'gen_ai.operation.name');
    if (operation === 'invoke_agent') {
      setAttr(span, 'langfuse.observation.type', 'span');
      setAttr(span, 'langfuse.trace.name', span.name);
      setAttr(span, 'langfuse.session.id', opts.sessionId);
      outSpans.push(span);
    } else if (operation === 'chat') {
      const record = chats[chatIndex++];
      const slices = record ? modelSlices(record.usage) : [];
      if (record && slices.length > 1) {
        // Multi-model run (e.g. Haiku probe inside an Opus session): replace
        // the flattened chat span with one generation per slice so Langfuse
        // prices each model at its own rate instead of lumping into one.
        for (const slice of slices) {
          const sliceSpan: OtlpSpanJson = {
            ...span,
            spanId: newSpanId(),
            name: `chat ${slice.model}`,
            attributes: span.attributes.filter((a) =>
              !a.key.startsWith('langfuse.observation.') &&
              a.key !== 'gen_ai.request.model' &&
              a.key !== 'gen_ai.usage.input_tokens' &&
              a.key !== 'gen_ai.usage.output_tokens' &&
              a.key !== 'gen_ai.usage.cache_read.input_tokens' &&
              a.key !== 'gen_ai.usage.cache_write.input_tokens' &&
              a.key !== 'gen_ai.usage.reasoning.output_tokens'),
          };
          setAttr(sliceSpan, 'gen_ai.operation.name', 'chat');
          setAttr(sliceSpan, 'gen_ai.request.model', slice.model);
          const buckets: Record<string, number> = {
            input: Math.max(0, slice.input),
            output: slice.output,
          };
          if (slice.cacheRead > 0) buckets.cache_read_input_tokens = slice.cacheRead;
          if (slice.cacheWrite > 0) buckets.cache_creation_input_tokens = slice.cacheWrite;
          if (slice.reasoning > 0) buckets.reasoning_output_tokens = slice.reasoning;
          setAttr(sliceSpan, 'langfuse.observation.type', 'generation');
          setAttr(sliceSpan, 'langfuse.observation.model.name', slice.model);
          setAttr(sliceSpan, 'langfuse.observation.usage_details', JSON.stringify(buckets));
          if (slice.costUsd > 0) {
            setAttr(sliceSpan, 'langfuse.observation.cost_details', JSON.stringify({ total: round6(slice.costUsd) }));
          }
          setAttr(sliceSpan, 'langfuse.session.id', opts.sessionId);
          outSpans.push(sliceSpan);
        }
      } else {
        setAttr(span, 'langfuse.observation.type', 'generation');
        if (record) {
          setAttr(span, 'langfuse.observation.model.name', record.model);
          setAttr(span, 'langfuse.observation.usage_details', JSON.stringify(usageBuckets(record.usage)));
          const cost = effectiveUsage(record.usage).cost;
          if (cost > 0) {
            setAttr(span, 'langfuse.observation.cost_details', JSON.stringify({ total: round6(cost) }));
          }
        }
        setAttr(span, 'langfuse.session.id', opts.sessionId);
        outSpans.push(span);
      }
    } else {
      setAttr(span, 'langfuse.observation.type', 'span');
      setAttr(span, 'langfuse.session.id', opts.sessionId);
      outSpans.push(span);
    }
  }
  if (scope) scope.spans = outSpans;
  return doc;
}

/**
 * POST the OTLP/HTTP JSON payload to Langfuse's OTLP traces endpoint with
 * Basic auth (pk:sk) and `x-langfuse-ingestion-version: 4` (real-time ingest
 * onto the v4 data model).
 */
export async function emitToLangfuse(
  events: AgentEvent[],
  opts: LangfuseEmitOptions,
): Promise<LangfuseEmitResult> {
  const payload = toLangfuseOtlpJson(events, opts);
  const url = `${opts.baseUrl.replace(/\/+$/, '')}/api/public/otel/v1/traces`;
  const auth = Buffer.from(`${opts.publicKey}:${opts.secretKey}`).toString('base64');
  const fetchImpl = opts.fetchImpl ?? fetch;

  const res = await fetchImpl(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Basic ${auth}`,
      'x-langfuse-ingestion-version': '4',
    },
    body: JSON.stringify(payload),
  });
  const body = await res.text();
  const spans = payload.resourceSpans[0]?.scopeSpans[0]?.spans ?? [];
  return {
    ok: res.ok,
    url,
    status: res.status,
    body,
    traceId: spans[0]?.traceId ?? '',
    spanCount: spans.length,
    payload,
  };
}
