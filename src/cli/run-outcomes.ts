// Run-outcome rollup for `ach stats` (#60): per-agent run counts and a
// success rate over the run registry (<stateDir>/runs/*.json). Runs whose
// exitStatus is `unavailable` (CLI/service outage) carry no verdict about the
// task, so they are left OUT of the success-rate denominator by default;
// `--include-unavailable` puts them back. A rate with an empty denominator is
// null (rendered n/a), never 0 and never 100%.
import type { RunRecord } from "../core/registry.ts";
import { fmtInt } from "./lib.ts";

export interface OutcomeBucket {
  /** Every settled or running record seen. */
  runs: number;
  success: number;
  unavailable: number;
  /** success / denominator; null when the denominator is 0. */
  successRate: number | null;
}

export interface RunOutcomes {
  total: OutcomeBucket;
  byAgent: Record<string, OutcomeBucket>;
  /** Whether unavailable runs were counted in the denominators. */
  includeUnavailable: boolean;
}

/** A record is unavailable when its final exitStatus (or status) says so. */
export function isUnavailableRecord(rec: Pick<RunRecord, "status" | "exitStatus">): boolean {
  return rec.exitStatus === "unavailable" || rec.status === "unavailable";
}

function isSuccessRecord(rec: Pick<RunRecord, "status" | "exitStatus">): boolean {
  return (rec.exitStatus ?? rec.status) === "success";
}

function bucket(recs: RunRecord[], includeUnavailable: boolean): OutcomeBucket {
  let success = 0;
  let unavailable = 0;
  for (const r of recs) {
    if (isUnavailableRecord(r)) unavailable++;
    else if (isSuccessRecord(r)) success++;
  }
  const denominator = includeUnavailable ? recs.length : recs.length - unavailable;
  return {
    runs: recs.length,
    success,
    unavailable,
    successRate: denominator > 0 ? success / denominator : null,
  };
}

export function summarizeRunOutcomes(
  records: RunRecord[],
  opts: { includeUnavailable?: boolean } = {},
): RunOutcomes {
  const includeUnavailable = opts.includeUnavailable === true;
  const groups = new Map<string, RunRecord[]>();
  for (const r of records) {
    const list = groups.get(r.agent) ?? [];
    list.push(r);
    groups.set(r.agent, list);
  }
  const byAgent: Record<string, OutcomeBucket> = {};
  for (const [agent, recs] of [...groups.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    byAgent[agent] = bucket(recs, includeUnavailable);
  }
  return { total: bucket(records, includeUnavailable), byAgent, includeUnavailable };
}

function fmtRate(rate: number | null): string {
  return rate === null ? "n/a" : `${(rate * 100).toFixed(1)}%`;
}

/** One text line per bucket: `runs      codex runs=4 success=1 unavailable=2 successRate=50.0%`. */
export function formatOutcomeLine(label: string, b: OutcomeBucket): string {
  return `runs ${label.padEnd(9)} runs=${fmtInt(b.runs)} success=${fmtInt(b.success)} unavailable=${fmtInt(b.unavailable)} successRate=${fmtRate(b.successRate)}`;
}
