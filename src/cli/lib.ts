// CLI-local pure helpers: streaming-event formatting, run summary rendering,
// usage aggregation. Parsing of machine transcripts lives in
// src/monitors/transcripts.ts; pricing in src/core/pricing.ts.
import path from "node:path";

import { HarnessError, type AgentEvent, type UsageAvailability } from "../core/types.ts";
import { bucketKey, type TimeGranularity } from "./time-window.ts";
import type { LatencyMetrics } from "../web/derive.ts";

/**
 * `--dir` is a transcript root for `stats`/`watch` but a state dir for
 * `archive`/`audit`/`dash`/`web`. Each command also takes the unambiguous
 * spelling (`--transcript-dir` / `--state-dir`); this resolves the pair to one
 * value. Both given with different values is a usage error, never a silent pick.
 */
export function resolveDirFlag(
  values: { dir?: string | undefined; "state-dir"?: string | undefined; "transcript-dir"?: string | undefined },
  alias: "state-dir" | "transcript-dir",
): string | undefined {
  const dir = values.dir;
  const named = values[alias];
  if (dir !== undefined && named !== undefined && path.resolve(dir) !== path.resolve(named)) {
    throw new HarnessError(`--${alias} '${named}' and --dir '${dir}' disagree (--dir is an alias of --${alias}; pass one)`, "USAGE");
  }
  return named ?? dir;
}

// ---------- argv preprocessing (#101/#104) ----------

/**
 * True when argv asks for help: a standalone `-h`/`--help` token before any
 * `--` end-of-options marker. After `--` everything is a positional (a
 * literal "--help" prompt word), so the scan stops there.
 */
export function wantsHelp(argv: readonly string[]): boolean {
  for (const tok of argv) {
    if (tok === "--") return false;
    if (tok === "-h" || tok === "--help") return true;
  }
  return false;
}

/**
 * Rewrite the space-separated form of the given long flags (`["--flag",
 * value]`) into the unambiguous `--flag=value` form BEFORE parseArgs sees
 * them (#104), so a value that starts with `-` is taken as the flag's
 * argument instead of being rejected as ambiguous. The `=` form passes
 * through untouched; everything after a `--` separator is positional and is
 * left alone. A trailing flag with no following token is left as-is for
 * parseArgs to reject as a one-line usage error.
 */
export function joinOptionValues(argv: readonly string[], flags: readonly string[]): string[] {
  const exact = new Set(flags.map((f) => `--${f}`));
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i]!;
    if (tok === "--") {
      out.push(...argv.slice(i));
      return out;
    }
    if (exact.has(tok) && i + 1 < argv.length) {
      out.push(`${tok}=${argv[i + 1]!}`);
      i += 1;
      continue;
    }
    out.push(tok);
  }
  return out;
}

/**
 * `--extra-args` values across occurrences (#104): the flag is repeatable
 * (`multiple: true`), each occurrence still splits on spaces for backwards
 * compatibility, and the tokens accumulate in order — so an argument with
 * spaces can be passed one argv token per occurrence. undefined when the
 * flag never appeared (RunSpec keeps extraArgs optional).
 */
export function extraArgsFromValues(values: readonly string[] | undefined): string[] | undefined {
  if (values === undefined) return undefined;
  return values.flatMap((v) => v.split(" ")).filter(Boolean);
}

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

/**
 * One compact stderr line per streamed event, or null for an event that
 * prints nothing on its own: a `model_call_start` is folded into its
 * `model_call_end` row (#32), so each model call costs one line, not two.
 * Pass the same `starts` map across calls to get the call's duration.
 */
export function formatEventLine(e: AgentEvent, starts?: Map<string, number>): string | null {
  const c = clock(Date.now());
  switch (e.type) {
    case "model_call_start":
      if (starts && e.callId && typeof e.timestamp === "number") starts.set(e.callId, e.timestamp);
      return null;
    case "model_call_end": {
      const t0 = e.callId ? starts?.get(e.callId) : undefined;
      if (e.callId) starts?.delete(e.callId);
      const parts = [e.model ?? ""];
      if (typeof e.outputTokens === "number") parts.push(`${e.outputTokens} out`);
      if (t0 !== undefined && typeof e.timestamp === "number") parts.push(`${e.timestamp - t0}ms`);
      // A derived boundary (#108, kiro ACP) must never read as a native span.
      if (e.provenance === "estimated") parts.push("estimated");
      return `[${c}] model   ${parts.filter(Boolean).join(" · ")}`.trimEnd();
    }
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
      `context    ${formatContextCell(ctx)}${ctx.windowSource === "assumed" ? " (assumed window)" : ""}` +
        (ctx.toolOutputShare !== undefined ? ` tool-output ~${(ctx.toolOutputShare * 100).toFixed(0)}% (estimated)` : ""),
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
  // #21: a turn-total basis is an upper bound on occupancy.
  return `ctx ${ctx.basis === "turn-total" ? "<=" : "~="} ${fmtInt(ctx.tokens)} tok${pct}`;
}

function fmtLatMs(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)}s`;
}

/**
 * Latency lines for the `ach run` summary (#32). Each line appears only when
 * its metric was measured; a run whose log cannot support a metric prints
 * nothing for it (never `0ms`, never NaN). Tools: top 5 by total time.
 */
export function formatLatencyLines(l: LatencyMetrics | undefined): string[] {
  if (l === undefined) return [];
  const lines: string[] = [];
  if (l.ttft !== null) {
    const t = l.ttft;
    lines.push(`ttft       avg ${fmtLatMs(t.avgMs)} · p50 ${fmtLatMs(t.p50Ms)} · p95 ${fmtLatMs(t.p95Ms)} (${t.count} call${t.count === 1 ? "" : "s"})`);
  }
  if (l.outputTokensPerSec !== null && l.tpotMs !== null) {
    lines.push(`throughput ${l.outputTokensPerSec.toFixed(1)} tok/s · tpot ${l.tpotMs.toFixed(1)}ms`);
  }
  if (l.tools.length > 0) {
    const cells = l.tools.slice(0, 5).map((r) => `${r.name} ${r.count}× avg ${fmtLatMs(r.avgMs)} max ${fmtLatMs(r.maxMs)}`);
    const more = l.tools.length > 5 ? ` · +${l.tools.length - 5} more` : "";
    lines.push(`tools      ${cells.join(" · ")}${more}`);
  }
  return lines;
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
  /**
   * Where costUsd came from (issue #28): "reported" or "computed" when every
   * cost-bearing record in the bucket shares that source; null when no record
   * carried a cost OR when both sources contributed (costBySource splits it).
   */
  costSource: CostSource | null;
  /** Per-source split of costUsd; a source no record used is null. */
  costBySource: { reported: number | null; computed: number | null };
  /**
   * Records for which the active cost mode produced no cost (in `auto`: no
   * CLI-reported cost and a model the pricer cannot price; in `display`: no
   * reported cost; in `calculate`: an unpriceable model). They count in
   * `records` and the token sums but are excluded from costUsd, so a nonzero
   * count means costUsd is a lower bound.
   */
  unpricedRecords: number;
}

/** Cost provenance label (issue #28). Exactly these two values; #33 builds on them. */
export type CostSource = "reported" | "computed";

export function emptyBucket(): UsageBucket {
  return {
    records: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    costUsd: 0,
    costSource: null,
    costBySource: { reported: null, computed: null },
    unpricedRecords: 0,
  };
}

function add(a: UsageBucket, r: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; reasoningTokens: number; costUsd?: number; costSource?: CostSource }): void {
  a.records += 1;
  a.inputTokens += r.inputTokens;
  a.outputTokens += r.outputTokens;
  a.cacheReadTokens += r.cacheReadTokens;
  a.cacheWriteTokens += r.cacheWriteTokens;
  a.reasoningTokens += r.reasoningTokens;
  a.costUsd += r.costUsd ?? 0;
  if (r.costUsd === undefined) a.unpricedRecords += 1;
  if (r.costSource !== undefined && r.costUsd !== undefined) {
    a.costBySource[r.costSource] = (a.costBySource[r.costSource] ?? 0) + r.costUsd;
  }
}

const round6 = (n: number): number => Math.round(n * 1e6) / 1e6;

function roundCost(a: UsageBucket): UsageBucket {
  a.costUsd = round6(a.costUsd);
  const { reported, computed } = a.costBySource;
  a.costBySource = {
    reported: reported === null ? null : round6(reported),
    computed: computed === null ? null : round6(computed),
  };
  a.costSource =
    reported !== null && computed === null ? "reported" : computed !== null && reported === null ? "computed" : null;
  return a;
}

export interface Aggregates {
  totals: UsageBucket;
  byAgent: Record<string, UsageBucket>;
  byDay: Record<string, UsageBucket>;
  /** ISO-week (`2026-W39`) rollup; present only when requested. */
  byWeek?: Record<string, UsageBucket>;
  /** Calendar-month (`2026-09`) rollup; present only when requested. */
  byMonth?: Record<string, UsageBucket>;
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
  /** Provenance of costUsd (issue #28); undefined = untagged, not tallied by source. */
  costSource?: CostSource;
}

/** Optional calendar bucketing (#44 week/month rollups, #84 time zones). */
export interface AggregateTimeOptions {
  /** IANA zone for day/week/month keys. Omitted: legacy UTC slice of `ts`. */
  timeZone?: string;
  /** Extra calendar maps to build; "day" (byDay) is always built. */
  by?: TimeGranularity[];
}

export function aggregate(records: AggregatableRecord[], timeOpts: AggregateTimeOptions = {}): Aggregates {
  const totals = emptyBucket();
  const byAgent: Record<string, UsageBucket> = {};
  const byDay: Record<string, UsageBucket> = {};
  const tz = timeOpts.timeZone;
  const byWeek: Record<string, UsageBucket> | undefined = timeOpts.by?.includes("week") ? {} : undefined;
  const byMonth: Record<string, UsageBucket> | undefined = timeOpts.by?.includes("month") ? {} : undefined;
  for (const r of records) {
    add(totals, r);
    add((byAgent[r.agent] ??= emptyBucket()), r);
    const dayK = tz === undefined ? (r.ts ? r.ts.slice(0, 10) : "unknown") : bucketKey(r.ts, "day", tz);
    add((byDay[dayK] ??= emptyBucket()), r);
    if (byWeek) add((byWeek[bucketKey(r.ts, "week", tz ?? "UTC")] ??= emptyBucket()), r);
    if (byMonth) add((byMonth[bucketKey(r.ts, "month", tz ?? "UTC")] ??= emptyBucket()), r);
  }
  const out: Aggregates = { totals: roundCost(totals), byAgent: mapRound(byAgent), byDay: mapRound(byDay) };
  if (byWeek) out.byWeek = mapRound(byWeek);
  if (byMonth) out.byMonth = mapRound(byMonth);
  return out;
}

function mapRound(m: Record<string, UsageBucket>): Record<string, UsageBucket> {
  return Object.fromEntries(Object.entries(m).map(([k, v]) => [k, roundCost(v)]));
}
