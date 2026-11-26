import { randomUUID } from 'node:crypto';
import { VERSION } from '../version.ts';
import { SpanKind, ROOT_CONTEXT, trace } from '@opentelemetry/api';
import type { Span, Tracer } from '@opentelemetry/api';
import { BatchSpanProcessor, NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import type { AgentEvent, CanonicalTokenRecord, EventTimestamp } from '../core/types.js';

export type HrTime = [number, number];

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

export interface TracerBundle {
  tracer: Tracer;
  provider: NodeTracerProvider;
  shutdown: () => Promise<void>;
}

export interface CreateTracerOptions {
  endpoint?: string;
  serviceName?: string;
  register?: boolean;
}

export function createTracer(opts: CreateTracerOptions = {}): TracerBundle {
  const endpoint = opts.endpoint ?? 'http://localhost:4318/v1/traces';
  const serviceName = opts.serviceName ?? 'agentic-coding-harness';
  const provider = new NodeTracerProvider({
    resource: resourceFromAttributes({ 'service.name': serviceName }),
    // OTel SDK v2: processors are constructor config; addSpanProcessor() is gone.
    spanProcessors: [new BatchSpanProcessor(new OTLPTraceExporter({ url: endpoint }))],
  });
  if (opts.register !== false) provider.register();
  return {
    tracer: provider.getTracer('agentic-coding-harness'),
    provider,
    shutdown: () => provider.shutdown(),
  };
}

function toEpochMs(ts?: EventTimestamp): number | undefined {
  if (ts === undefined) return undefined;
  if (ts instanceof Date) return ts.getTime();
  if (typeof ts === 'number') return ts;
  const parsed = Date.parse(ts);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function toHrTime(ms: number): HrTime {
  return [Math.floor(ms / 1000), Math.round((ms % 1000) * 1e6)];
}

function toUnixNano(ms: number): string {
  return (BigInt(Math.round(ms)) * 1_000_000n).toString();
}

function newIds(): { traceId: string; spanId: string } {
  const traceId = randomUUID().replaceAll('-', '');
  let spanId = randomUUID().replaceAll('-', '').slice(0, 16);
  if (spanId.startsWith('0')) spanId = `1${spanId.slice(1)}`;
  return { traceId, spanId };
}

type SpanRole = 'root' | 'chat' | 'tool';

interface SpanSpec {
  role: SpanRole;
  name: string;
  kind: SpanKind.CLIENT | SpanKind.INTERNAL;
  startMs: number;
  endMs: number;
  attributes: Record<string, string | number>;
  toolCallId?: string;
}

export interface EmitRunOptions {
  sessionId: string;
  agentName: string;
  model: string;
  events: AgentEvent[];
  /** #95: custom enricher attributes (src/emitters/enrich.ts) stamped on every
   *  span and the OTLP resource; built-in keys win on a clash. */
  attributes?: Record<string, string>;
  /** #95: per-span attributes from a user enricher, indexed in deriveSpans
   *  order (root first, then children); layered over `attributes`. */
  spanAttributes?: readonly (Record<string, string> | undefined)[];
}

/**
 * #73: stored W3C ids of a run (RunRecord/RunResult `trace`). When given, the
 * export adopts the trace id, the root span takes the run's own span id, and
 * the root's parent is the upstream span. Absent: ids are generated as before.
 */
export interface ExportTraceIds {
  traceId: string;
  spanId?: string;
  parentSpanId?: string;
  traceFlags?: string;
}

export interface DerivedSpans {
  root: SpanSpec;
  children: SpanSpec[];
}

/**
 * Pure derivation of the span tree from an event stream, shared by emitRun and toOtlpJson.
 * usage/model_call_end events -> chat spans; tool_call events -> execute_tool spans.
 */
export function deriveSpans(
  events: AgentEvent[],
  opts: Omit<EmitRunOptions, 'events'>,
): DerivedSpans {
  const times = events
    .map((e) => toEpochMs(e.timestamp))
    .filter((ms): ms is number => ms !== undefined);
  const fallback = times.length > 0 ? times : [Date.now()];
  const rootStart = Math.min(...fallback);
  const rootEnd = Math.max(...fallback);

  const root: SpanSpec = {
    role: 'root',
    name: `invoke_agent ${opts.agentName}`,
    kind: SpanKind.CLIENT,
    startMs: rootStart,
    endMs: rootEnd,
    attributes: {
      'gen_ai.operation.name': 'invoke_agent',
      'gen_ai.agent.name': opts.agentName,
      'gen_ai.conversation.id': opts.sessionId,
      'gen_ai.request.model': opts.model,
    },
  };

  const children: SpanSpec[] = [];
  const resultTimeByCall = new Map<string, number>();
  for (const ev of events) {
    if (ev.type === 'tool_result') {
      const ms = toEpochMs(ev.timestamp);
      if (ms !== undefined && ev.toolCallId !== undefined && !resultTimeByCall.has(ev.toolCallId)) {
        resultTimeByCall.set(ev.toolCallId, ms);
      }
    }
  }

  for (const ev of events) {
    const ms = toEpochMs(ev.timestamp) ?? rootStart;
    if (ev.type === 'usage' || ev.type === 'model_call_end') {
      const usage = ev.usage;
      if (!usage) continue;
      const e = effectiveUsage(usage);
      const model = ev.type === 'model_call_end' ? (ev.model ?? opts.model) : opts.model;
      const attrs: Record<string, string | number> = {
        'gen_ai.operation.name': 'chat',
        'gen_ai.request.model': model,
        'gen_ai.usage.input_tokens': e.prompt,
        'gen_ai.usage.output_tokens': e.completion,
      };
      if (e.cached > 0) {
        attrs['gen_ai.usage.cache_read.input_tokens'] = e.cached;
      }
      if (e.cacheWrite > 0) {
        attrs['gen_ai.usage.cache_write.input_tokens'] = e.cacheWrite;
      }
      if (e.reasoning > 0) {
        attrs['gen_ai.usage.reasoning.output_tokens'] = e.reasoning;
      }
      children.push({
        role: 'chat',
        name: `chat ${model}`,
        kind: SpanKind.CLIENT,
        startMs: ms,
        endMs: ms,
        attributes: attrs,
      });
    } else if (ev.type === 'tool_call') {
      if (typeof ev.toolCallId !== 'string' || typeof ev.functionName !== 'string') continue;
      children.push({
        role: 'tool',
        name: `execute_tool ${ev.functionName}`,
        kind: SpanKind.INTERNAL,
        startMs: ms,
        endMs: resultTimeByCall.get(ev.toolCallId) ?? ms,
        attributes: {
          'gen_ai.operation.name': 'execute_tool',
          'gen_ai.tool.name': ev.functionName,
          'gen_ai.tool.call.id': ev.toolCallId,
        },
        toolCallId: ev.toolCallId,
      });
    }
  }
  if (opts.attributes || opts.spanAttributes) {
    [root, ...children].forEach((spec, i) => {
      spec.attributes = { ...opts.attributes, ...opts.spanAttributes?.[i], ...spec.attributes };
    });
  }
  return { root, children };
}

function spanKindString(kind: SpanKind): string {
  switch (kind) {
    case SpanKind.CLIENT:
      return 'SPAN_KIND_CLIENT';
    case SpanKind.INTERNAL:
      return 'SPAN_KIND_INTERNAL';
    case SpanKind.SERVER:
      return 'SPAN_KIND_SERVER';
    case SpanKind.PRODUCER:
      return 'SPAN_KIND_PRODUCER';
    case SpanKind.CONSUMER:
      return 'SPAN_KIND_CONSUMER';
    default:
      return 'SPAN_KIND_UNSPECIFIED';
  }
}

function attrValue(v: string | number): Record<string, string | number | boolean> {
  return typeof v === 'number' ? { intValue: String(v) } : { stringValue: v };
}

export interface OtlpSpanJson {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: string;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: { key: string; value: Record<string, string | number | boolean> }[];
  status: { code: string };
}

export interface OtlpResourceSpansJson {
  resourceSpans: {
    resource: { attributes: { key: string; value: Record<string, string> }[] };
    scopeSpans: {
      scope: { name: string; version: string };
      spans: OtlpSpanJson[];
    }[];
  }[];
}

/**
 * Pure function: event stream -> OTLP ResourceSpans JSON (proto-JSON shape).
 * Testable without network; mirrors what emitRun would export.
 */
export function toOtlpJson(
  events: AgentEvent[],
  opts: Omit<EmitRunOptions, 'events'> & {
    serviceName?: string;
    /** Extra resource attributes after `service.name` (#46: `ach.privacy`). */
    resourceAttributes?: Record<string, string>;
    captureMode?: string;
    trace?: ExportTraceIds;
  },
): OtlpResourceSpansJson {
  const serviceName = opts.serviceName ?? 'agentic-coding-harness';
  const { root, children } = deriveSpans(events, opts);
  const { traceId: generatedTraceId, spanId: rootSpanId } = newIds();
  const traceId = opts.trace?.traceId ?? generatedTraceId;

  const toJsonSpan = (spec: SpanSpec, parentSpanId?: string): OtlpSpanJson => {
    const { spanId: generatedSpanId } = newIds();
    const spanId = spec.role === 'root' && opts.trace?.spanId !== undefined ? opts.trace.spanId : generatedSpanId;
    const span: OtlpSpanJson = {
      traceId,
      spanId,
      name: spec.name,
      kind: spanKindString(spec.kind),
      startTimeUnixNano: toUnixNano(spec.startMs),
      endTimeUnixNano: toUnixNano(spec.endMs),
      attributes: Object.entries(spec.attributes).map(([key, value]) => ({ key, value: attrValue(value) })),
      status: { code: 'STATUS_CODE_UNSET' },
    };
    if (parentSpanId) span.parentSpanId = parentSpanId;
    return span;
  };

  const rootJson = toJsonSpan(root, opts.trace?.parentSpanId);
  const childJson = children.map((c) => toJsonSpan(c, rootJson.spanId));

  return {
    resourceSpans: [
      {
        resource: {
          attributes: [
            { key: 'service.name', value: { stringValue: serviceName } },
            ...Object.entries(opts.resourceAttributes ?? {}).map(([key, v]) => ({ key, value: { stringValue: v } })),
            // #72: the run's content-capture tier, so a consumer can tell a
            // metadata-only trace from one whose content is just empty.
            ...(opts.captureMode !== undefined ? [{ key: 'ach.capture_mode', value: { stringValue: opts.captureMode } }] : []),
            ...Object.entries(opts.attributes ?? {})
              .filter(([key]) => key !== 'service.name')
              .map(([key, value]) => ({ key, value: { stringValue: value } })),
          ],
        },
        scopeSpans: [
          {
            scope: { name: 'agentic-coding-harness', version: VERSION },
            spans: [rootJson, ...childJson],
          },
        ],
      },
    ],
  };
}

/** Side-effectful variant: emits the same span tree through a real tracer/provider. */
export function emitRun(
  tracer: Tracer,
  opts: EmitRunOptions & { trace?: ExportTraceIds },
): { root: Span; spans: Span[] } {
  const { root: rootSpec, children } = deriveSpans(opts.events, opts);
  // #73: the tracer API mints span ids itself, so a live export adopts the
  // trace id and upstream parent (as a remote parent context) but not the
  // run's stored span id; toOtlpJson pins all three.
  const upstream = opts.trace?.parentSpanId !== undefined
    ? trace.setSpanContext(ROOT_CONTEXT, {
        traceId: opts.trace.traceId,
        spanId: opts.trace.parentSpanId,
        traceFlags: parseInt(opts.trace.traceFlags ?? '01', 16),
        isRemote: true,
      })
    : undefined;
  const root = tracer.startSpan(rootSpec.name, {
    kind: rootSpec.kind,
    startTime: toHrTime(rootSpec.startMs),
    attributes: rootSpec.attributes,
  }, upstream);
  const parentCtx = trace.setSpan(ROOT_CONTEXT, root);
  const spans: Span[] = children.map((spec) => {
    const span = tracer.startSpan(
      spec.name,
      { kind: spec.kind, startTime: toHrTime(spec.startMs), attributes: spec.attributes },
      parentCtx,
    );
    span.end(toHrTime(spec.endMs));
    return span;
  });
  root.end(toHrTime(rootSpec.endMs));
  return { root, spans };
}
