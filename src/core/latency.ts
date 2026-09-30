import type { AgentEvent, EventTimestamp } from "./types.ts";

/**
 * Latency metrics (#32) derived from a run's AgentEvent[] timestamps. Pure, no
 * I/O. Lives in core so the driver can record it on the RunRecord at finalize
 * without importing from the web layer; src/web/derive.ts re-exports it.
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

function finiteNum(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

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
