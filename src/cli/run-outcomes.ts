// Run-outcome rollup for `ach stats` (#60): per-agent run counts and a
// success rate over the run registry (<stateDir>/runs/*.json). The rate uses
// the shared rule (runVerdict in core/registry.ts, same as `ach web` and
// /api/compare): successes / runs that reached a verdict (success, error,
// aborted). Interrupted and still-running runs have no verdict: they stay in
// `runs` and show as `noVerdict`, but never enter the denominator. Runs whose
// exitStatus is `unavailable` (CLI/service outage) are also left OUT by
// default; `--include-unavailable` adds back only those. A rate with an empty
// denominator is null (rendered n/a), never 0 and never 100%.
import { runVerdict, type RunRecord } from "../core/registry.ts";
import { fmtInt } from "./lib.ts";

export interface OutcomeBucket {
  /** Every settled or running record seen. */
  runs: number;
  success: number;
  unavailable: number;
  /** Runs with no verdict (interrupted, still running, status-less); never in the denominator. */
  noVerdict: number;
  /** success / denominator; null when the denominator is 0. */
  successRate: number | null;
}

export interface RunOutcomes {
  total: OutcomeBucket;
  byAgent: Record<string, OutcomeBucket>;
  /** Whether unavailable runs were counted in the denominators. */
  includeUnavailable: boolean;
}

function bucket(recs: RunRecord[], includeUnavailable: boolean, now: number): OutcomeBucket {
  let success = 0;
  let unavailable = 0;
  let verdicts = 0;
  let noVerdict = 0;
  for (const r of recs) {
    const v = runVerdict(r, now);
    if (v === "unavailable") unavailable++;
    else if (v === "none") noVerdict++;
    else {
      verdicts++;
      if (v === "success") success++;
    }
  }
  const denominator = verdicts + (includeUnavailable ? unavailable : 0);
  return {
    runs: recs.length,
    success,
    unavailable,
    noVerdict,
    successRate: denominator > 0 ? success / denominator : null,
  };
}

export function summarizeRunOutcomes(
  records: RunRecord[],
  opts: { includeUnavailable?: boolean; now?: number } = {},
): RunOutcomes {
  const includeUnavailable = opts.includeUnavailable === true;
  const now = opts.now ?? Date.now();
  const groups = new Map<string, RunRecord[]>();
  for (const r of records) {
    const list = groups.get(r.agent) ?? [];
    list.push(r);
    groups.set(r.agent, list);
  }
  const byAgent: Record<string, OutcomeBucket> = {};
  for (const [agent, recs] of [...groups.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    byAgent[agent] = bucket(recs, includeUnavailable, now);
  }
  return { total: bucket(records, includeUnavailable, now), byAgent, includeUnavailable };
}

function fmtRate(rate: number | null): string {
  return rate === null ? "n/a" : `${(rate * 100).toFixed(1)}%`;
}

/** One text line per bucket: `runs      codex runs=4 success=1 unavailable=2 successRate=50.0%`. */
export function formatOutcomeLine(label: string, b: OutcomeBucket): string {
  const base = `runs ${label.padEnd(9)} runs=${fmtInt(b.runs)} success=${fmtInt(b.success)} unavailable=${fmtInt(b.unavailable)} successRate=${fmtRate(b.successRate)}`;
  return b.noVerdict > 0 ? `${base} noVerdict=${fmtInt(b.noVerdict)}` : base;
}
