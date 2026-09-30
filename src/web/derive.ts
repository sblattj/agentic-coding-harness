import type { AgentEvent, CanonicalTokenRecord, EventTimestamp } from "../core/types.ts";
import { cacheHitRatio } from "../core/cache-ratio.ts";

/**
 * Pure derivations of the dashboard's three observability views (spans,
 * metrics, logs) from a run's AgentEvent[]. No I/O: USD comes from canonical
 * recorded costs. Missing prices remain unknown; no substitute model rates.
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

function finiteNum(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

export function deriveMetrics(events: AgentEvent[]): MetricPoint[] {
  const rows = normalizeTimeline(events);
  const points: MetricPoint[] = [];
  const tot = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0, credits: 0 };
  let sawUsd = false;
  let unpriced = false;
  let sawCredits = false;
  for (const { ev, tMs } of rows) {
    const u = ev.type === "usage" ? ev.usage : ev.type === "model_call_end" ? ev.usage : undefined;
    if (u === undefined) continue;
    const extra = u.extra as Record<string, unknown> | undefined;
    // Sum explicit canonical USD values only. A partial sum is not a total;
    // once any record is unpriced, leave the cumulative USD series absent.
    tot.input += num(u.inputTokens);
    tot.output += num(u.outputTokens);
    tot.cacheRead += num(u.cacheReadTokens);
    tot.cacheWrite += num(u.cacheWriteTokens);
    const cost = finiteNum(u.costUsd);
    if (cost === null || extra?.usdAvailable === false) unpriced = true;
    else { tot.costUsd += cost; sawUsd = true; }
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
    if (sawUsd && !unpriced) point.costUsd = tot.costUsd;
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

// ------------------------------------------------------------------ latency

/** Summary of a set of measured durations (ms). p95 is nearest-rank. */
export interface DurationStats {
  count: number;
  totalMs: number;
  avgMs: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
}

/** Per-tool execution durations (#32): one row per functionName. */
export interface ToolLatencyRow extends DurationStats {
  name: string;
  /** How many of the measured calls reported isError. */
  errors: number;
}

/**
 * Latency metrics derived from event timestamps (#32). Every field that the
 * log cannot support is `null` (or `[]`), never 0 and never NaN.
 *
 * - ttft: model_call_start -> first output event (agent message or
 *   tool_call) inside that call. Only producers that mark a request start
 *   with model_call_start can have it.
 * - modelCalls: end-to-end latency of closed model calls (start -> end).
 * - outputTokensPerSec / tpotMs: output tokens of each call over its
 *   post-TTFT window (first output -> model_call_end), pooled across calls.
 * - tools: tool_call -> tool_result per tool name (a call whose result never
 *   arrived is not measured).
 *
 * Only real, finite timestamps are used — unlike the span view, missing
 * timestamps are never carried forward, so an unmeasurable interval is
 * skipped rather than reported as 0ms.
 */
export interface LatencyMetrics {
  ttft: DurationStats | null;
  modelCalls: DurationStats | null;
  outputTokensPerSec: number | null;
  tpotMs: number | null;
  tools: ToolLatencyRow[];
}

function durationStats(values: number[]): DurationStats | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const total = sorted.reduce((s, v) => s + v, 0);
  const rank = (p: number): number => sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)]!;
  return {
    count: sorted.length,
    totalMs: total,
    avgMs: total / sorted.length,
    p50Ms: rank(0.5),
    p95Ms: rank(0.95),
    maxMs: sorted[sorted.length - 1]!,
  };
}

interface OpenModelCall {
  callId: string | undefined;
  startMs: number | null;
  firstOutputMs: number | null;
  outputTokens: number | null;
}

interface OpenToolCall {
  callId: string | undefined;
  name: string;
  startMs: number | null;
  endMs: number | null;
  isError: boolean;
  closed: boolean;
}

function isOutputEvent(ev: AgentEvent): boolean {
  if (ev.type === "tool_call") return true;
  if (ev.type !== "message") return false;
  const src = (ev as { source?: unknown }).source;
  return src === "agent" || src === "assistant";
}

export function deriveLatency(events: AgentEvent[]): LatencyMetrics {
  const openModels: OpenModelCall[] = [];
  const ttfts: number[] = [];
  const e2es: number[] = [];
  let genTokens = 0;
  let genMs = 0;
  const tools: OpenToolCall[] = [];
  const findModel = (callId: string | undefined): number => {
    if (callId !== undefined) return openModels.findIndex((m) => m.callId === callId);
    for (let i = openModels.length - 1; i >= 0; i--) if (openModels[i]!.callId === undefined) return i;
    return -1;
  };

  for (const ev of events) {
    const ms = toEventMs(ev.timestamp);
    switch (ev.type) {
      case "model_call_start":
        openModels.push({ callId: ev.callId, startMs: ms, firstOutputMs: null, outputTokens: null });
        break;
      case "model_call_end": {
        const idx = findModel(ev.callId);
        if (idx === -1) break;
        const call = openModels.splice(idx, 1)[0]!;
        const out = finiteNum(ev.usage?.outputTokens) ?? call.outputTokens;
        if (call.startMs === null || ms === null || ms < call.startMs) break;
        e2es.push(ms - call.startMs);
        if (call.firstOutputMs === null || call.firstOutputMs > ms) break;
        ttfts.push(call.firstOutputMs - call.startMs);
        const gen = ms - call.firstOutputMs;
        if (out !== null && out > 0 && gen > 0) {
          genTokens += out;
          genMs += gen;
        }
        break;
      }
      case "usage": {
        // A usage record tagged with an open call's id carries that call's output.
        if (ev.callId === undefined) break;
        const idx = findModel(ev.callId);
        const out = finiteNum(ev.usage?.outputTokens);
        if (idx !== -1 && out !== null) openModels[idx]!.outputTokens = (openModels[idx]!.outputTokens ?? 0) + out;
        break;
      }
      case "tool_call":
        tools.push({
          callId: ev.toolCallId || undefined,
          name: ev.functionName || "tool",
          startMs: ms,
          endMs: null,
          isError: false,
          closed: false,
        });
        break;
      case "tool_result": {
        // Exact id match; the LAST result for an id wins (codex reports
        // item.updated and item.completed both as results). Id-less results
        // close the most recent still-open id-less call.
        const id = ev.toolCallId || undefined;
        let t: OpenToolCall | undefined;
        if (id !== undefined) {
          for (let i = tools.length - 1; i >= 0; i--) {
            if (tools[i]!.callId === id) {
              t = tools[i];
              break;
            }
          }
        } else {
          for (let i = tools.length - 1; i >= 0; i--) {
            if (tools[i]!.callId === undefined && !tools[i]!.closed) {
              t = tools[i];
              break;
            }
          }
        }
        if (t === undefined) break;
        t.closed = true;
        t.endMs = ms;
        t.isError = ev.isError === true;
        break;
      }
      default:
        break;
    }
    if (isOutputEvent(ev) && openModels.length > 0) {
      const inner = openModels[openModels.length - 1]!;
      if (inner.firstOutputMs === null && ms !== null && inner.startMs !== null && ms >= inner.startMs) {
        inner.firstOutputMs = ms;
      }
    }
  }

  const byTool = new Map<string, { values: number[]; errors: number }>();
  for (const t of tools) {
    if (!t.closed || t.startMs === null || t.endMs === null || t.endMs < t.startMs) continue;
    const row = byTool.get(t.name) ?? { values: [], errors: 0 };
    row.values.push(t.endMs - t.startMs);
    if (t.isError) row.errors++;
    byTool.set(t.name, row);
  }
  const toolRows: ToolLatencyRow[] = [];
  for (const [name, { values, errors }] of byTool) {
    const stats = durationStats(values);
    if (stats !== null) toolRows.push({ name, ...stats, errors });
  }
  toolRows.sort((a, b) => b.totalMs - a.totalMs || a.name.localeCompare(b.name));

  const haveGen = genTokens > 0 && genMs > 0;
  return {
    ttft: durationStats(ttfts),
    modelCalls: durationStats(e2es),
    outputTokensPerSec: haveGen ? genTokens / (genMs / 1000) : null,
    tpotMs: haveGen ? genMs / genTokens : null,
    tools: toolRows,
  };
}

/** True when the metrics hold at least one measured value. */
export function hasLatency(l: LatencyMetrics): boolean {
  return l.ttft !== null || l.modelCalls !== null || l.outputTokensPerSec !== null || l.tools.length > 0;
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
  /** Run prompt-cache hit ratio (#69); null = no prompt tokens. Present only when usage exists. */
  cacheHitRatio?: number | null;
  /** Per-model token split with cache-hit ratio (#69). Present only when usage exists. */
  byModel?: ModelCacheRow[];
  /** TTFT, throughput/TPOT, per-tool durations (#32). Present whenever the run has events. */
  latency?: LatencyMetrics;
}

export interface ModelCacheRow {
  /** Model id, or "unattributed" when the usage names no single model. */
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cacheHitRatio: number | null;
}

/**
 * Per-model token rows over the same usage-bearing events deriveMetrics
 * counts. A record carrying per-model slices (extra.raw.models) splits by
 * slice; otherwise the record's (or the model_call_end's) model owns it, and
 * a composite/absent label lands in "unattributed".
 */
export function deriveModelCache(events: AgentEvent[]): ModelCacheRow[] {
  const rows = new Map<string, ModelCacheRow>();
  const add = (model: string, i: number, o: number, cr: number, cw: number) => {
    const row = rows.get(model) ?? {
      model,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      cacheHitRatio: null,
    };
    row.inputTokens += i;
    row.outputTokens += o;
    row.cacheReadTokens += cr;
    row.cacheWriteTokens += cw;
    rows.set(model, row);
  };
  for (const ev of events) {
    const u = ev.type === "usage" ? ev.usage : ev.type === "model_call_end" ? ev.usage : undefined;
    if (u === undefined) continue;
    const slices = (u.extra as { raw?: { models?: unknown } } | undefined)?.raw?.models;
    if (Array.isArray(slices) && slices.length > 0 && slices.every((s) => typeof (s as { model?: unknown })?.model === "string")) {
      for (const s of slices as Array<Record<string, unknown>>) {
        add(s.model as string, num(s.input), num(s.output), num(s.cacheRead), num(s.cacheWrite));
      }
      continue;
    }
    const label = u.model ?? (ev.type === "model_call_end" ? ev.model : undefined);
    const model = !label || label === "multi" || label === "unknown" || label.includes("+") ? "unattributed" : label;
    add(model, num(u.inputTokens), num(u.outputTokens), num(u.cacheReadTokens), num(u.cacheWriteTokens));
  }
  return [...rows.values()]
    .map((r) => ({ ...r, cacheHitRatio: cacheHitRatio(r) }))
    .sort((a, b) => a.model.localeCompare(b.model));
}

export function deriveRunObservability(events: AgentEvent[]): RunObservability {
  const spans = deriveSpans(events);
  const metrics = deriveMetrics(events);
  const logs = deriveLogs(events);
  const last = metrics.length > 0 ? metrics[metrics.length - 1]! : undefined;
  const durationMs = spans.length > 0 ? spans[0]!.durationMs : 0;
  const out: RunObservability = { spans, metrics, logs, durationMs };
  if (last?.costUsd !== undefined) out.totalCostUsd = last.costUsd;
  if (last?.credits !== undefined) out.totalCredits = last.credits;
  if (last !== undefined) {
    out.cacheHitRatio = cacheHitRatio({
      inputTokens: last.input,
      cacheReadTokens: last.cacheRead,
      cacheWriteTokens: last.cacheWrite,
    });
    out.byModel = deriveModelCache(events);
  }
  if (events.length > 0) out.latency = deriveLatency(events);
  return out;
}
