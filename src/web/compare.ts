// Compare rollup math for /api/compare (spec §6.1): group run records by
// experiment × variant (or workflow × agent) and compute per-group means —
// runs, avg total tokens, avg cost, avg duration, success rate. Pure
// functions only: no server, no fs, no rounding. Field mapping follows THIS
// tree's RunRecord (totals/endedAt/status), not the spec's older names.
import type { RunRecord } from "../core/registry.ts";

export const COMPARE_GROUP_KEYS = ["experiment", "variant", "workflow", "agent"] as const;

export type CompareGroupKey = (typeof COMPARE_GROUP_KEYS)[number];

const DEFAULT_GROUP_BY: CompareGroupKey[] = ["experiment", "variant"];

export interface CompareRow {
  [key: string]: string | number | undefined;
  runs: number;
  avgTotalTokens: number;
  avgCostUsd: number;
  avgDurationMs: number;
  successRate: number;
}

/** Filter to the allowed keys; an empty (or all-unknown) list means the
 *  default grouping. The route validates and 400s before calling this, so
 *  here unknown keys are dropped rather than thrown — tolerant, like every
 *  other read path in the registry. */
export function resolveCompareGroupBy(groupBy: string[]): CompareGroupKey[] {
  const keys = groupBy.filter((k): k is CompareGroupKey =>
    (COMPARE_GROUP_KEYS as readonly string[]).includes(k),
  );
  return keys.length > 0 ? keys : DEFAULT_GROUP_BY;
}

/** Group-key value for one record: `experiment` falls back to `agent` so
 *  unlabeled local runs still group (spec §6.1); other keys pass through,
 *  possibly undefined. */
function groupValue(rec: RunRecord, key: CompareGroupKey): string | undefined {
  if (key === "experiment") return rec.experiment ?? rec.agent;
  return rec[key];
}

/** Aggregate records into one CompareRow per distinct group-key tuple.
 *  Undefined group values OMIT the column (JSON drops it); rows sort by
 *  group-key values ascending with undefined last, then runs descending. */
export function computeCompareRows(records: RunRecord[], groupBy: string[]): CompareRow[] {
  const keys = resolveCompareGroupBy(groupBy);
  const groups = new Map<string, { values: (string | undefined)[]; records: RunRecord[] }>();
  for (const rec of records) {
    const values = keys.map((k) => groupValue(rec, k));
    const id = JSON.stringify(values);
    let group = groups.get(id);
    if (group === undefined) {
      group = { values, records: [] };
      groups.set(id, group);
    }
    group.records.push(rec);
  }

  const rows: CompareRow[] = [];
  for (const group of groups.values()) {
    const runs = group.records.length;
    let totalTokens = 0;
    let costUsd = 0;
    let durationMs = 0;
    let successes = 0;
    for (const rec of group.records) {
      totalTokens += (rec.totals?.inputTokens ?? 0) + (rec.totals?.outputTokens ?? 0);
      costUsd += rec.totals?.costUsd ?? 0;
      const end = rec.endedAt ?? rec.updatedAt ?? rec.startedAt;
      durationMs += Math.max(0, end - rec.startedAt);
      if ((rec.status ?? rec.exitStatus) === "success") successes++;
    }
    const row: CompareRow = {
      agent: group.records[0]!.agent, // display convenience: first record's agent
      runs,
      avgTotalTokens: totalTokens / runs,
      avgCostUsd: costUsd / runs,
      avgDurationMs: durationMs / runs,
      successRate: successes / runs,
    };
    keys.forEach((key, i) => {
      const value = group.values[i];
      if (value !== undefined) row[key] = value;
    });
    rows.push(row);
  }

  rows.sort((a, b) => {
    for (const key of keys) {
      const av = a[key];
      const bv = b[key];
      if (av === bv) continue;
      if (av === undefined) return 1; // undefined sorts last
      if (bv === undefined) return -1;
      return av < bv ? -1 : 1;
    }
    return b.runs - a.runs;
  });
  return rows;
}
