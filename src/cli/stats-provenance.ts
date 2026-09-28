// Per-bucket provenance maps for `ach stats --json` (issue #33).
//
// Grouped with EXACTLY the keys aggregate() (src/cli/lib.ts) uses — agent,
// and ts.slice(0, 10) or "unknown" for the day — so every bucket in the JSON
// gets a sibling `provenance` map. Rules:
//   token lanes  `reported` when any record in the bucket carried token counts
//                (extra.tokensAvailable !== false); absent otherwise (n/a)
//   costUsd      the one source every cost-bearing record shares; a blend of
//                reported + computed is `computed`; absent when none had a cost
import { bucketKey, type TimeGranularity } from "./time-window.ts";
import type { CostSource } from "./lib.ts";
import type { ProvenanceMap } from "../core/provenance.ts";

export interface StatsProvenanceRecord {
  ts: string | null;
  agent: string;
  costUsd?: number;
  costSource?: CostSource;
  /** False when the producer stated it has no token counts (kiro credits-only). */
  tokensAvailable?: boolean;
}

export interface StatsProvenance {
  total: ProvenanceMap;
  byAgent: Record<string, ProvenanceMap>;
  byDay: Record<string, ProvenanceMap>;
  byWeek?: Record<string, ProvenanceMap>;
  byMonth?: Record<string, ProvenanceMap>;
}

const LANES = ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "reasoningTokens"] as const;

interface Tally {
  tokens: boolean;
  reported: boolean;
  computed: boolean;
}

const empty = (): Tally => ({ tokens: false, reported: false, computed: false });

function tally(t: Tally, r: StatsProvenanceRecord): void {
  if (r.tokensAvailable !== false) t.tokens = true;
  if (r.costUsd !== undefined && r.costSource === "reported") t.reported = true;
  if (r.costUsd !== undefined && r.costSource === "computed") t.computed = true;
}

function toMap(t: Tally): ProvenanceMap {
  const out: ProvenanceMap = {};
  if (t.tokens) for (const k of LANES) out[k] = "reported";
  if (t.computed) out.costUsd = "computed";
  else if (t.reported) out.costUsd = "reported";
  return out;
}

export function statsProvenance(records: StatsProvenanceRecord[], opts: { timeZone?: string; by?: TimeGranularity[] } = {}): StatsProvenance {
  const total = empty();
  const byAgent: Record<string, Tally> = {};
  const byDay: Record<string, Tally> = {};
  const byWeek: Record<string, Tally> = {};
  const byMonth: Record<string, Tally> = {};
  for (const r of records) {
    tally(total, r);
    tally((byAgent[r.agent] ??= empty()), r);
    tally((byDay[opts.timeZone ? bucketKey(r.ts, "day", opts.timeZone) : r.ts ? r.ts.slice(0, 10) : "unknown"] ??= empty()), r);
    if (opts.by?.includes("week")) tally((byWeek[bucketKey(r.ts, "week", opts.timeZone ?? "UTC")] ??= empty()), r);
    if (opts.by?.includes("month")) tally((byMonth[bucketKey(r.ts, "month", opts.timeZone ?? "UTC")] ??= empty()), r);
  }
  const mapAll = (m: Record<string, Tally>) => Object.fromEntries(Object.entries(m).map(([k, v]) => [k, toMap(v)]));
  return { total: toMap(total), byAgent: mapAll(byAgent), byDay: mapAll(byDay), ...(opts.by?.includes("week") ? { byWeek: mapAll(byWeek) } : {}), ...(opts.by?.includes("month") ? { byMonth: mapAll(byMonth) } : {}) };
}
