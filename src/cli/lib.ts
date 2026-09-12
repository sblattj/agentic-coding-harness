// CLI-local pure helpers: streaming-event formatting, run summary rendering,
// usage aggregation. Parsing of machine transcripts lives in
// src/monitors/transcripts.ts; pricing in src/core/pricing.ts.
import type { AgentEvent, UsageAvailability } from "../core/types.ts";

const pad2 = (n: number) => String(n).padStart(2, "0");

function clock(ts: number): string {
  const d = new Date(ts);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

export function fmtInt(n: number): string {
  return n.toLocaleString("en-US");
}

export function fmtUsd(usd: number): string {
  return `$${usd.toFixed(4)}`;
}

const CLIP = 60;
function clip(s: string, max = CLIP): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > max ? one.slice(0, max - 1) + "…" : one;
}

/** One compact stderr line per streamed event. */
export function formatEventLine(e: AgentEvent): string {
  const c = clock(Date.now());
  switch (e.type) {
    case "step":
      return `[${c}] step`;
    case "usage_raw":
      return `[${c}] usage   (${typeof e.agent === "string" ? e.agent : "agent"})`;
    case "usage":
      return `[${c}] usage`;
    case "message":
      return `[${c}] text    ${clip(typeof e.data === "string" ? e.data : String(e.content ?? ""))}`;
    case "tool_call":
      return `[${c}] tool    ${String(e.functionName ?? "?")}`;
    case "tool_result":
      return `[${c}] result  ${String(e.toolCallId ?? "")}`;
    case "progress":
      return `[${c}] »       ${clip(String(e.data ?? ""))}`;
    case "error":
      return `[${c}] error   ${clip(typeof e.data === "string" ? e.data : String(e.message ?? ""))}`;
    default: {
      const detail = typeof e.data === "string" ? e.data : "";
      return `[${c}] ${e.type.padEnd(7)} ${clip(detail)}`.trimEnd();
    }
  }
}

export interface RunSummaryInput {
  agent: string;
  sessionId: string | null;
  model?: string;
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; reasoning: number };
  costUsd: number;
  durationMs: number;
  exitStatus: string;
  /** Truthful-usage verdict (RunResult.usage). Absent => render as before. */
  usage?: UsageAvailability;
}

/**
 * Run summary. When RunResult.usage says a lane is unavailable the row reads
 * `n/a`, never `0` / `$0.0000` — a credits-only agent (kiro on 2.21.x) reports
 * no token counts at all, and printing zeros there is a fabricated measurement.
 * A RunResult without `usage` (older artifact) renders exactly as it always did.
 */
export function formatSummary(r: RunSummaryInput): string {
  const t = r.tokens;
  const tokensUnavailable = r.usage?.tokens.available === false;
  const usdUnavailable = r.usage?.usd.available === false;
  const lines = [
    `sessionId  ${r.sessionId ?? "-"}`,
    tokensUnavailable
      ? `tokens     input=n/a output=n/a cacheRead=n/a cacheWrite=n/a reasoning=n/a`
      : `tokens     input=${fmtInt(t.input)} output=${fmtInt(t.output)} cacheRead=${fmtInt(t.cacheRead)} cacheWrite=${fmtInt(t.cacheWrite)} reasoning=${fmtInt(t.reasoning)}`,
    `cost       ${usdUnavailable ? "n/a" : fmtUsd(r.costUsd)}`,
  ];
  const ctx = r.usage?.context;
  if (ctx?.available === true && ctx.tokens !== undefined) {
    lines.push(
      `context    ${formatContextCell(ctx)}${ctx.windowSource === "assumed" ? " (assumed window)" : ""}`,
    );
  }
  lines.push(`duration   ${(r.durationMs / 1000).toFixed(1)}s`, `exit       ${r.exitStatus}`);
  return lines.join("\n");
}

/**
 * Context-window occupancy cell: `ctx ~= 10,016 tok (5.0%)`. DERIVED from a
 * percentage and a window size — deliberately spelled differently from billed
 * token counts so the two are never read as the same measurement.
 */
export function formatContextCell(ctx: NonNullable<UsageAvailability["context"]>): string {
  if (ctx.available !== true || ctx.tokens === undefined) return "n/a";
  const pct = ctx.percentage === undefined ? "" : ` (${ctx.percentage.toFixed(1)}%)`;
  return `ctx ~= ${fmtInt(ctx.tokens)} tok${pct}`;
}

// ---------- Aggregation ----------

export interface UsageBucket {
  records: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  costUsd: number;
}

export function emptyBucket(): UsageBucket {
  return {
    records: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    costUsd: 0,
  };
}

function add(a: UsageBucket, r: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; reasoningTokens: number; costUsd?: number }): void {
  a.records += 1;
  a.inputTokens += r.inputTokens;
  a.outputTokens += r.outputTokens;
  a.cacheReadTokens += r.cacheReadTokens;
  a.cacheWriteTokens += r.cacheWriteTokens;
  a.reasoningTokens += r.reasoningTokens;
  a.costUsd += r.costUsd ?? 0;
}

function roundCost(a: UsageBucket): UsageBucket {
  a.costUsd = Math.round(a.costUsd * 1e6) / 1e6;
  return a;
}

export interface Aggregates {
  totals: UsageBucket;
  byAgent: Record<string, UsageBucket>;
  byDay: Record<string, UsageBucket>;
}

export interface AggregatableRecord {
  /** ISO-8601; null when the source exposes no timestamp (day bucket "unknown"). */
  ts: string | null;
  agent: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  /** Summed only when defined (records without a price contribute nothing). */
  costUsd?: number;
}

export function aggregate(records: AggregatableRecord[]): Aggregates {
  const totals = emptyBucket();
  const byAgent: Record<string, UsageBucket> = {};
  const byDay: Record<string, UsageBucket> = {};
  for (const r of records) {
    add(totals, r);
    add((byAgent[r.agent] ??= emptyBucket()), r);
    add((byDay[r.ts ? r.ts.slice(0, 10) : "unknown"] ??= emptyBucket()), r);
  }
  return { totals: roundCost(totals), byAgent: mapRound(byAgent), byDay: mapRound(byDay) };
}

function mapRound(m: Record<string, UsageBucket>): Record<string, UsageBucket> {
  return Object.fromEntries(Object.entries(m).map(([k, v]) => [k, roundCost(v)]));
}
