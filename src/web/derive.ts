import type { AgentEvent, CanonicalTokenRecord, EventTimestamp } from "../core/types.ts";

/**
 * Pure derivations of the dashboard's three observability views (spans,
 * metrics, logs) from a run's AgentEvent[]. No I/O: cost is a flat-rate
 * estimate because src/core/pricing.ts's createPricer reads bundled data
 * files at construction time.
 */

export function toEventMs(t: EventTimestamp): number | null {
  if (t instanceof Date && Number.isFinite(t.getTime())) return t.getTime();
  if (typeof t === "number" && Number.isFinite(t)) return t;
  if (typeof t === "string") {
    const p = Date.parse(t);
    if (Number.isFinite(p)) return p;
  }
  return null;
}

interface TimedEvent {
  ev: AgentEvent;
  tMs: number;
}

/** Normalize, carry forward missing timestamps, sort by ms, offset from t0. */
function normalizeTimeline(events: AgentEvent[]): TimedEvent[] {
  const rows = events.map((ev) => ({ ev, ms: toEventMs(ev.timestamp) }));
  let carry: number | null = null;
  for (const row of rows) {
    if (row.ms === null) row.ms = carry;
    else carry = row.ms;
  }
  const firstFinite = rows.find((row) => row.ms !== null)?.ms;
  if (firstFinite === undefined) {
    for (const row of rows) row.ms = 0;
  } else {
    for (const row of rows) {
      if (row.ms === null) row.ms = firstFinite;
    }
  }
  rows.sort((a, b) => (a.ms as number) - (b.ms as number));
  const t0 = rows.length > 0 ? (rows[0]!.ms as number) : 0;
  return rows.map((row) => ({ ev: row.ev, tMs: (row.ms as number) - t0 }));
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function truncate(s: string, max: number): string {
  const oneLine = s.replace(/\s+/g, " ").trim();
  if (oneLine.length <= max) return oneLine;
  return oneLine.slice(0, max - 3) + "...";
}

// ------------------------------------------------------------------ spans

export interface Span {
  id: string;
  kind: "model" | "tool" | "sys" | "test";
  name: string;
  startMs: number;
  durationMs: number;
  depth: number;
  parentId: string | null;
  usage?: CanonicalTokenRecord;
  isError?: boolean;
}

interface OpenSpanRef {
  span: Span;
  callId: string | undefined;
}

/** Exact id match wins; id-less events match the most recent id-less open span. */
function matchOpen(open: OpenSpanRef[], callId: string | undefined): number {
  if (callId !== undefined) return open.findIndex((o) => o.callId === callId);
  for (let i = open.length - 1; i >= 0; i--) {
    if (open[i]!.callId === undefined) return i;
  }
  return -1;
}

const TEST_NAME_RE = /test|vitest|pytest|jest|spec/i;

export function deriveSpans(events: AgentEvent[]): Span[] {
  const rows = normalizeTimeline(events);
  if (rows.length === 0) return [];
  const lastMs = rows[rows.length - 1]!.tMs;
  const root: Span = {
    id: "s0",
    kind: "sys",
    name: "session",
    startMs: 0,
    durationMs: lastMs,
    depth: 0,
    parentId: null,
  };
  const spans: Span[] = [root];
  let next = 1;
  const newId = (): string => `s${next++}`;
  const openModels: OpenSpanRef[] = [];
  const openTools: OpenSpanRef[] = [];

  for (const { ev, tMs } of rows) {
    switch (ev.type) {
      case "model_call_start": {
        const span: Span = {
          id: newId(),
          kind: "model",
          name: `llm ${ev.model || "call"}`,
          startMs: tMs,
          durationMs: 0,
          depth: 1,
          parentId: root.id,
        };
        spans.push(span);
        openModels.push({ span, callId: ev.callId });
        break;
      }
      case "model_call_end": {
        const idx = matchOpen(openModels, ev.callId);
        if (idx !== -1) {
          const { span } = openModels[idx]!;
          span.durationMs = tMs - span.startMs;
          if (ev.usage !== undefined) span.usage = ev.usage;
          openModels.splice(idx, 1);
        }
        break;
      }
      case "tool_call": {
        const fn = ev.functionName || "tool";
        const parent = openModels[openModels.length - 1];
        const span: Span = {
          id: newId(),
          kind: TEST_NAME_RE.test(fn) ? "test" : "tool",
          name: fn,
          startMs: tMs,
          durationMs: 0,
          depth: parent !== undefined ? 2 : 1,
          parentId: parent !== undefined ? parent.span.id : root.id,
        };
        spans.push(span);
        openTools.push({ span, callId: ev.toolCallId });
        break;
      }
      case "tool_result": {
        const idx = matchOpen(openTools, ev.toolCallId);
        if (idx !== -1) {
          const { span } = openTools[idx]!;
          span.durationMs = tMs - span.startMs;
          span.isError = ev.isError;
          openTools.splice(idx, 1);
        }
        break;
      }
      default:
        break;
    }
  }
  for (const { span } of openModels) span.durationMs = lastMs - span.startMs;
  for (const { span } of openTools) span.durationMs = lastMs - span.startMs;
  return spans;
}

// ----------------------------------------------------------------- metrics

export interface MetricPoint {
  tMs: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** Cumulative USD; omitted for credit-metered runs (kiro) that report no USD. */
  costUsd?: number;
  /** Cumulative metering credits, when the source bills credits not tokens (kiro). */
  credits?: number;
}

export interface FlatPrices {
  inputPerM: number;
  outputPerM: number;
  cacheReadPerM: number;
  cacheWritePerM: number;
}

/** Flat per-1M-token USD estimate (claude-sonnet-4-class rates). */
export const FALLBACK_PRICES: FlatPrices = {
  inputPerM: 3,
  outputPerM: 15,
  cacheReadPerM: 0.3,
  cacheWritePerM: 3.75,
};

function flatCost(u: CanonicalTokenRecord): number {
  return (
    (num(u.inputTokens) * FALLBACK_PRICES.inputPerM +
      num(u.outputTokens) * FALLBACK_PRICES.outputPerM +
      num(u.cacheReadTokens) * FALLBACK_PRICES.cacheReadPerM +
      num(u.cacheWriteTokens) * FALLBACK_PRICES.cacheWritePerM) /
    1_000_000
  );
}

function finiteNum(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

export function deriveMetrics(events: AgentEvent[]): MetricPoint[] {
  const rows = normalizeTimeline(events);
  const points: MetricPoint[] = [];
  const tot = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0, credits: 0 };
  let sawUsd = false;
  let sawCredits = false;
  for (const { ev, tMs } of rows) {
    const u = ev.type === "usage" ? ev.usage : ev.type === "model_call_end" ? ev.usage : undefined;
    if (u === undefined) continue;
    const extra = u.extra as Record<string, unknown> | undefined;
    // Credits-only records (kiro) carry placeholder zero tokens; pricing them
    // would emit a false $0. Price only token-bearing records; surface credits.
    const tokensAvailable = extra?.tokensAvailable !== false;
    tot.input += num(u.inputTokens);
    tot.output += num(u.outputTokens);
    tot.cacheRead += num(u.cacheReadTokens);
    tot.cacheWrite += num(u.cacheWriteTokens);
    if (tokensAvailable) {
      tot.costUsd += flatCost(u);
      sawUsd = true;
    }
    const cum = finiteNum(extra?.creditsCumulative);
    if (cum !== null) {
      tot.credits = Math.max(tot.credits, cum); // cumulative gauge, not a sum
      sawCredits = true;
    } else {
      const c = finiteNum(extra?.credits);
      if (c !== null) {
        tot.credits += c; // per-record credits sum
        sawCredits = true;
      }
    }
    const point: MetricPoint = {
      tMs,
      input: tot.input,
      output: tot.output,
      cacheRead: tot.cacheRead,
      cacheWrite: tot.cacheWrite,
    };
    if (sawUsd) point.costUsd = tot.costUsd;
    if (sawCredits) point.credits = tot.credits;
    points.push(point);
  }
  return points.sort((a, b) => a.tMs - b.tMs);
}

// -------------------------------------------------------------------- logs

export interface LogLine {
  tMs: number;
  level: "info" | "warn" | "error" | "usage";
  span: string;
  text: string;
}

const WARN_RE = /fail|retry|warn/i;

function argsSummary(args: Record<string, unknown> | string | undefined): string {
  let s: string;
  if (typeof args === "string") s = args;
  else if (args === undefined) s = "";
  else s = JSON.stringify(args);
  return truncate(s, 100);
}

function resultText(content: string | Record<string, unknown> | undefined): string {
  if (typeof content === "string") return content;
  if (content !== undefined) return JSON.stringify(content);
  return "";
}

export function deriveLogs(events: AgentEvent[]): LogLine[] {
  const rows = normalizeTimeline(events);
  const logs: LogLine[] = [];
  const open: { kind: "model" | "tool"; name: string; callId: string | undefined }[] = [];
  const innermost = (): string => (open.length > 0 ? open[open.length - 1]!.name : "session");
  const close = (kind: "model" | "tool", callId: string | undefined): string | null => {
    let idx = -1;
    if (callId !== undefined) idx = open.findIndex((o) => o.kind === kind && o.callId === callId);
    else {
      for (let i = open.length - 1; i >= 0; i--) {
        if (open[i]!.kind === kind && open[i]!.callId === undefined) {
          idx = i;
          break;
        }
      }
    }
    if (idx === -1) return null;
    return open.splice(idx, 1)[0]!.name;
  };

  for (const { ev, tMs } of rows) {
    switch (ev.type) {
      case "tool_call": {
        const name = ev.functionName || "tool";
        const summary = argsSummary(ev.arguments);
        open.push({ kind: "tool", name, callId: ev.toolCallId });
        logs.push({
          tMs,
          level: "info",
          span: name,
          text: `$ ${name}${summary.length > 0 ? ` ${summary}` : ""}`,
        });
        break;
      }
      case "tool_result": {
        const content = truncate(resultText(ev.content), 100);
        if (content.length === 0) break;
        const closed = close("tool", ev.toolCallId);
        logs.push({
          tMs,
          level: ev.isError ? "error" : "info",
          span: closed ?? innermost(),
          text: ev.isError ? `! ${content}` : content,
        });
        break;
      }
      case "message": {
        const content = typeof ev.content === "string" ? ev.content.trim() : "";
        if (content.length === 0) break;
        logs.push({ tMs, level: "info", span: innermost(), text: truncate(content, 100) });
        break;
      }
      case "model_call_start": {
        const name = `llm ${ev.model || "call"}`;
        open.push({ kind: "model", name, callId: ev.callId });
        logs.push({ tMs, level: "info", span: name, text: `${name} begin` });
        break;
      }
      case "model_call_end": {
        const name = `llm ${ev.model || "call"}`;
        const closed = close("model", ev.callId);
        logs.push({ tMs, level: "info", span: closed ?? innermost(), text: `${name} end` });
        break;
      }
      case "usage": {
        const u = ev.usage;
        logs.push({
          tMs,
          level: "usage",
          span: innermost(),
          text: `usage ${num(u.inputTokens)} in · ${num(u.outputTokens)} out · ${num(u.cacheReadTokens)} cacheRead`,
        });
        break;
      }
      case "progress": {
        const text = ev.text ?? "";
        if (text.trim().length === 0) break;
        logs.push({
          tMs,
          level: WARN_RE.test(text) ? "warn" : "info",
          span: innermost(),
          text: truncate(text, 100),
        });
        break;
      }
      case "error": {
        const message = ev.message ?? "";
        if (message.trim().length === 0) break;
        logs.push({ tMs, level: "error", span: innermost(), text: truncate(message, 100) });
        break;
      }
      case "done": {
        logs.push({
          tMs,
          level: "info",
          span: "session",
          text: ev.exitStatus !== undefined ? `done ${String(ev.exitStatus)}` : "done",
        });
        break;
      }
      case "aborted": {
        logs.push({ tMs, level: "info", span: "session", text: "aborted" });
        break;
      }
      default:
        break;
    }
  }
  return logs;
}

// ------------------------------------------------------- run observability

export interface RunObservability {
  spans: Span[];
  metrics: MetricPoint[];
  logs: LogLine[];
  /** Cumulative USD; omitted for credit-metered runs that report no USD. */
  totalCostUsd?: number;
  /** Cumulative metering credits, when the source bills credits (kiro). */
  totalCredits?: number;
  durationMs: number;
}

export function deriveRunObservability(events: AgentEvent[]): RunObservability {
  const spans = deriveSpans(events);
  const metrics = deriveMetrics(events);
  const logs = deriveLogs(events);
  const last = metrics.length > 0 ? metrics[metrics.length - 1]! : undefined;
  const durationMs = spans.length > 0 ? spans[0]!.durationMs : 0;
  const out: RunObservability = { spans, metrics, logs, durationMs };
  if (last?.costUsd !== undefined) out.totalCostUsd = last.costUsd;
  else if (metrics.length === 0) out.totalCostUsd = 0; // no usage at all → USD knowable as zero
  if (last?.credits !== undefined) out.totalCredits = last.credits;
  return out;
}
