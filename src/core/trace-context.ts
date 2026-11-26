// W3C Trace Context propagation (#73).
//
// Spec: https://www.w3.org/TR/trace-context/ (traceparent / tracestate) and the
// OpenTelemetry environment-variable carrier (TRACEPARENT / TRACESTATE).
//
// At run start the driver reads TRACEPARENT (and TRACESTATE) from the run's
// env; a valid value makes the run a child span of that upstream trace, an
// absent one starts a fresh trace, and an invalid one starts a fresh trace with
// one warning. The run gets its own span id; every agent child process is
// launched with TRACEPARENT = 00-<traceId>-<run span id>-<flags>, so whatever
// the child emits nests under the run. The ids are stored on the RunRecord and
// RunResult (`trace`) and adopted by the OTel and Langfuse exports.
import { randomBytes } from "node:crypto";
import { z } from "zod";

export const TRACEPARENT_ENV = "TRACEPARENT";
export const TRACESTATE_ENV = "TRACESTATE";

/** The trace identity of one run. */
export interface RunTraceContext {
  /** 32 lowercase hex chars, never all zeros. Shared with the upstream trace when one was given. */
  traceId: string;
  /** 16 lowercase hex chars: this run's own span (the exported root span, and the parent of every child process). */
  spanId: string;
  /** 16 lowercase hex chars: the upstream span this run is a child of; absent when the run started the trace. */
  parentSpanId?: string;
  /** 2 lowercase hex chars (W3C trace-flags; 01 = sampled). */
  traceFlags: string;
  /** Upstream tracestate, propagated unchanged; absent when none was given. */
  traceState?: string;
  /** `env`: adopted from an incoming TRACEPARENT; `generated`: this run started the trace. */
  source: "env" | "generated";
}

const HEX32 = /^[0-9a-f]{32}$/;
const HEX16 = /^[0-9a-f]{16}$/;
const HEX2 = /^[0-9a-f]{2}$/;

export const RunTraceContextSchema = z.object({
  traceId: z.string().regex(HEX32).refine((s) => !/^0+$/.test(s)),
  spanId: z.string().regex(HEX16).refine((s) => !/^0+$/.test(s)),
  parentSpanId: z.string().regex(HEX16).refine((s) => !/^0+$/.test(s)).optional(),
  traceFlags: z.string().regex(HEX2),
  traceState: z.string().optional(),
  source: z.enum(["env", "generated"]),
});

export interface ParsedTraceparent {
  version: string;
  traceId: string;
  parentId: string;
  traceFlags: string;
}

/**
 * Parse a traceparent header value per W3C Trace Context level 1:
 * `version-traceid-parentid-flags`, lowercase hex. Version 00 must be exactly
 * 55 chars; a higher version (never ff) is parsed by its first four fields when
 * followed by end of string or `-` (the spec's forward-compatibility rule).
 * All-zero trace or parent ids are invalid. Returns null when invalid.
 */
export function parseTraceparent(value: string): ParsedTraceparent | null {
  const v = value.trim();
  const version = v.slice(0, 2);
  if (!HEX2.test(version) || version === "ff") return null;
  if (version === "00" && v.length !== 55) return null;
  if (v.length < 55 || (v.length > 55 && v[55] !== "-")) return null;
  const head = v.slice(0, 55).split("-");
  if (head.length !== 4) return null;
  const [, traceId, parentId, traceFlags] = head as [string, string, string, string];
  if (!HEX32.test(traceId) || /^0+$/.test(traceId)) return null;
  if (!HEX16.test(parentId) || /^0+$/.test(parentId)) return null;
  if (!HEX2.test(traceFlags)) return null;
  return { version, traceId, parentId, traceFlags };
}

function randomHex(bytes: number): string {
  for (;;) {
    const hex = randomBytes(bytes).toString("hex");
    if (!/^0+$/.test(hex)) return hex;
  }
}

/** A fresh W3C trace id (32 hex, not all zeros). */
export function newTraceId(): string {
  return randomHex(16);
}

/** A fresh W3C span id (16 hex, not all zeros). */
export function newSpanId(): string {
  return randomHex(8);
}

/** The traceparent value naming this run's own span: `00-<traceId>-<spanId>-<flags>`. */
export function formatTraceparent(ctx: Pick<RunTraceContext, "traceId" | "spanId" | "traceFlags">): string {
  return `00-${ctx.traceId}-${ctx.spanId}-${ctx.traceFlags}`;
}

export interface ResolvedTraceContext {
  trace: RunTraceContext;
  /** Set when an incoming TRACEPARENT was present but invalid (the run started a fresh trace). */
  warning?: string;
}

/**
 * Resolve a run's trace context from its env. Valid TRACEPARENT: adopt its
 * trace id and flags, its parent id becomes the run's parentSpanId, and
 * TRACESTATE rides along. Absent: a fresh trace (sampled). Invalid: a fresh
 * trace plus a warning, and any TRACESTATE is dropped (the spec ties
 * tracestate to a valid traceparent). The run always gets a new span id.
 */
export function resolveRunTraceContext(env: Record<string, string | undefined>): ResolvedTraceContext {
  const raw = env[TRACEPARENT_ENV];
  const spanId = newSpanId();
  if (raw === undefined || raw.trim() === "") {
    return { trace: { traceId: newTraceId(), spanId, traceFlags: "01", source: "generated" } };
  }
  const parsed = parseTraceparent(raw);
  if (parsed === null) {
    const shown = raw.length > 80 ? `${raw.slice(0, 80)}...` : raw;
    return {
      trace: { traceId: newTraceId(), spanId, traceFlags: "01", source: "generated" },
      warning: `trace: ignoring invalid ${TRACEPARENT_ENV} ${JSON.stringify(shown)} (W3C format 00-<32 hex>-<16 hex>-<2 hex>); started a new trace`,
    };
  }
  const state = env[TRACESTATE_ENV]?.trim();
  return {
    trace: {
      traceId: parsed.traceId,
      spanId,
      parentSpanId: parsed.parentId,
      traceFlags: parsed.traceFlags,
      ...(state !== undefined && state !== "" ? { traceState: state } : {}),
      source: "env",
    },
  };
}

/** The env a child process of this run gets: TRACEPARENT naming the run's span, plus TRACESTATE when known. */
export function childTraceEnv(ctx: RunTraceContext): Record<string, string> {
  return {
    [TRACEPARENT_ENV]: formatTraceparent(ctx),
    ...(ctx.traceState !== undefined ? { [TRACESTATE_ENV]: ctx.traceState } : {}),
  };
}

/** Read a `trace` field off an untrusted object (an `ach run --json` result); undefined when absent or malformed. */
export function readRunTraceContext(value: unknown): RunTraceContext | undefined {
  const r = RunTraceContextSchema.safeParse(value);
  return r.success ? (r.data as RunTraceContext) : undefined;
}

/**
 * The `ach run` summary line: `trace      00-<traceId>-<spanId>-<flags>`,
 * plus the upstream parent span when the run joined an existing trace.
 */
export function formatTraceLine(ctx: RunTraceContext): string {
  const upstream = ctx.parentSpanId !== undefined ? ` (child of upstream span ${ctx.parentSpanId})` : " (new trace)";
  return `trace      ${formatTraceparent(ctx)}${upstream}`;
}

/** `env` plus the run's child TRACEPARENT/TRACESTATE (post-run checkers); `env` unchanged when the run has no trace. */
export function withRunTrace<T extends Record<string, string | undefined>>(env: T, ctx: RunTraceContext | undefined): T {
  if (ctx === undefined) return env;
  const { [TRACESTATE_ENV]: _drop, ...rest } = env;
  void _drop;
  return { ...rest, ...childTraceEnv(ctx) } as T;
}
