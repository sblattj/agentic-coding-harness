// League table for `ach report` (#90): one row per experiment x variant,
// folded from run records with the SAME grouping and math as /api/compare
// (computeCompareGroups in src/web/compare.ts), plus medians and the run ids
// each row aggregates. One object feeds both the HTML league table and the
// `leaderboard.json` artifact, so the two can never disagree.
//
// Determinism: records are folded newest first with run id breaking ties
// (the order /api/compare reads the registry in, so float sums and the
// display agent match it exactly), members list oldest first, rows keep the
// compare order, and the only timestamp is `dataAsOf`, the newest real run
// time in the set (null when no run carries one). Regenerating from unchanged
// runs gives byte-identical output.
import type { RunRecord } from "../core/registry.ts";
import { runVerdict, type RunVerdict } from "../core/registry.ts";
import { computeCompareGroups, type CompareGroupKey } from "../web/compare.ts";
import type { LoadedRun } from "./model.ts";

/** `schema` value of every leaderboard document. */
export const LEADERBOARD_SCHEMA = "ach.leaderboard";
/** Bumped on any breaking change to the row shape (docs/LEADERBOARD.md). */
export const LEADERBOARD_SCHEMA_VERSION = 1;
/** The league is always experiment x variant (the /api/compare default). */
export const LEADERBOARD_GROUP_BY: readonly CompareGroupKey[] = ["experiment", "variant"];
/** File name written next to the report HTML. */
export const LEADERBOARD_FILE = "leaderboard.json";

export type SealStatus = "ok" | "tampered" | "unsealed" | "open";

/** One run inside a league row. */
export interface LeaderboardMember {
  runId: string;
  agent: string;
  /** The success-rate verdict this run contributed (registry runVerdict). */
  verdict: RunVerdict;
  /** `ach verify-run` verdict of the run's transcript seal (#59); null when the run has no RunRecord. */
  seal: SealStatus | null;
}

/** One league row. Every field is always present (null = not known), so the shape is stable. */
export interface LeaderboardRow {
  experiment: string;
  variant: string | null;
  /** First run's agent (the same display convenience as /api/compare). */
  agent: string;
  runs: number;
  /** successes / runs with a verdict; null when none had one (same rule as /api/compare). */
  successRate: number | null;
  /** Mean USD per run; null when any run in the row is unpriced (as /api/compare). */
  avgCostUsd: number | null;
  /** Median USD per run; null under the same rule as avgCostUsd. */
  medianCostUsd: number | null;
  unpricedRuns: number;
  /** Mean of input + output tokens per run. */
  avgTotalTokens: number;
  medianTotalTokens: number;
  /** Mean wall time per run (end minus start), ms. */
  avgDurationMs: number;
  medianDurationMs: number;
  unavailable: number;
  noVerdict: number;
  /** Share of verified runs whose checker passed (#29); null when no run was verified. */
  passRate: number | null;
  /** The runs this row aggregates, oldest first. */
  members: LeaderboardMember[];
}

export interface LeaderboardDoc {
  schema: typeof LEADERBOARD_SCHEMA;
  schemaVersion: typeof LEADERBOARD_SCHEMA_VERSION;
  groupBy: CompareGroupKey[];
  /** ISO time of the newest run end in the set; null when no run carries a real time. */
  dataAsOf: string | null;
  /** Runs folded into the table. */
  runs: number;
  rows: LeaderboardRow[];
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/** Same unpriced rule as computeCompareRows. */
function priced(rec: RunRecord): number | null {
  const value = rec.totals?.costUsd;
  if (rec.metering === "none" || rec.usage?.usd.available === false || value === undefined || !Number.isFinite(value)) return null;
  return value;
}

/** Same duration rule as computeCompareRows. */
function durationOf(rec: RunRecord): number {
  const end = rec.endedAt ?? rec.updatedAt ?? rec.startedAt;
  return Math.max(0, end - rec.startedAt);
}

const byRunId = (a: RunRecord, b: RunRecord): number => (a.runId < b.runId ? -1 : a.runId > b.runId ? 1 : 0);

/** Stable member order: oldest first, run id breaks ties (readdir order never leaks in). */
export function sortRecords(records: readonly RunRecord[]): RunRecord[] {
  return [...records].sort((a, b) => a.startedAt - b.startedAt || byRunId(a, b));
}

/** Rollup order: newest first like listRunRecords (what /api/compare folds), run id breaks ties. */
function rollupOrder(records: readonly RunRecord[]): RunRecord[] {
  return [...records].sort((a, b) => b.startedAt - a.startedAt || byRunId(a, b));
}

/** Stand-in records (recordFromLoadedRun) have no real start time. */
const STAND_IN_STARTED_AT = 0;

/**
 * Fold run records into the league document. `seals` maps run id to the
 * seal verdict for runs that have a RunRecord. `now` only matters for a
 * record still marked running (live vs interrupted), exactly as in
 * /api/compare.
 */
export function computeLeaderboard(
  records: readonly RunRecord[],
  seals: ReadonlyMap<string, SealStatus> = new Map(),
  now: number = Date.now(),
): LeaderboardDoc {
  const sorted = rollupOrder(records);
  const groups = computeCompareGroups(sorted, [...LEADERBOARD_GROUP_BY], now);
  const rows: LeaderboardRow[] = groups.map(({ row, records: recs }) => {
    const costs = recs.map(priced);
    const allPriced = costs.every((c) => c !== null);
    return {
      experiment: String(row.experiment),
      variant: typeof row.variant === "string" ? row.variant : null,
      agent: String(row.agent),
      runs: row.runs,
      successRate: row.successRate,
      avgCostUsd: row.avgCostUsd,
      medianCostUsd: allPriced ? median(costs as number[]) : null,
      unpricedRuns: row.unpricedRuns ?? 0,
      avgTotalTokens: row.avgTotalTokens,
      medianTotalTokens: median(recs.map((r) => (r.totals?.inputTokens ?? 0) + (r.totals?.outputTokens ?? 0))),
      avgDurationMs: row.avgDurationMs,
      medianDurationMs: median(recs.map(durationOf)),
      unavailable: row.unavailable ?? 0,
      noVerdict: row.noVerdict ?? 0,
      passRate: row.passRate ?? null,
      members: sortRecords(recs).map((r) => ({ runId: r.runId, agent: r.agent, verdict: runVerdict(r, now), seal: seals.get(r.runId) ?? null })),
    };
  });
  let newest = 0;
  for (const r of sorted) {
    // A stand-in's endedAt is its duration, not a time: it never moves dataAsOf.
    if (r.startedAt <= STAND_IN_STARTED_AT) continue;
    const t = r.endedAt ?? r.updatedAt ?? r.startedAt;
    if (Number.isFinite(t) && t > newest) newest = t;
  }
  return {
    schema: LEADERBOARD_SCHEMA,
    schemaVersion: LEADERBOARD_SCHEMA_VERSION,
    groupBy: [...LEADERBOARD_GROUP_BY],
    dataAsOf: newest > 0 ? new Date(newest).toISOString() : null,
    runs: sorted.length,
    rows,
  };
}

/** The `leaderboard.json` bytes: two-space JSON plus a trailing newline. */
export function leaderboardJson(doc: LeaderboardDoc): string {
  return JSON.stringify(doc, null, 2) + "\n";
}

/** The registry status a RunResult exitStatus finalizes to (src/core/driver.ts finalizeRunRecord). */
export function statusForExit(exit: string | undefined): RunRecord["status"] {
  if (exit === undefined) return undefined;
  if (exit === "success") return "success";
  if (exit === "aborted" || exit === "cancelled" || exit === "budget_exceeded" || exit === "turn_limit" || exit === "timeout") return "aborted";
  if (exit === "unavailable") return "unavailable";
  return "error";
}

/**
 * A stand-in RunRecord for a trial artifact with no registry record (a run
 * copied from another machine, or one written before the registry). It
 * carries only what the RunResult states: tokens, cost, duration, status,
 * variant. It has no real start time, so it never moves `dataAsOf`.
 */
export function recordFromLoadedRun(run: LoadedRun): RunRecord {
  const durationMs =
    typeof run.result.durationMs === "number" && Number.isFinite(run.result.durationMs)
      ? run.result.durationMs
      : run.wallSecs !== null
        ? run.wallSecs * 1000
        : 0;
  const status = statusForExit(run.result.exitStatus);
  return {
    runId: run.result.runId ?? `${run.trialLabel}/${run.agent}`,
    agent: run.agent,
    startedAt: STAND_IN_STARTED_AT,
    endedAt: STAND_IN_STARTED_AT + durationMs,
    ...(status !== undefined ? { status } : {}),
    ...(run.result.exitStatus !== undefined ? { exitStatus: run.result.exitStatus } : {}),
    ...(run.variant !== undefined ? { variant: run.variant } : {}),
    ...(run.usage !== undefined ? { usage: run.usage } : {}),
    ...(run.verify !== undefined ? { verify: run.verify } : {}),
    totals: {
      inputTokens: run.inputTokens,
      outputTokens: run.outputTokens,
      cacheReadTokens: run.cacheReadTokens,
      cacheWriteTokens: run.cacheWriteTokens,
      // NaN marks "no price" for the compare rollup's unpriced rule.
      costUsd: run.usdUnavailable || run.costUsd === undefined ? Number.NaN : run.costUsd,
    },
  };
}
