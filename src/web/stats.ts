// Global stats rollup for GET /api/stats (#94): totals across ALL recorded runs
// (runs, tokens by type, USD, active), distributions by agent / model / status /
// exitStatus, per-agent and per-model success rates, and avg / p50 / p95 of
// duration, tokens and cost per run. Pure function over a RunRecord[] snapshot:
// no server, no fs, no rounding, so it stays O(n) over the in-memory hub
// snapshot. Honesty rules mirror compare.ts: an unpriced run (metering none,
// usage.usd unavailable, missing or non-finite cost) is counted in
// `unpricedRuns` and kept OUT of the USD sums (never a fabricated $0); an
// `unavailable` outage carries no task verdict and stays out of success-rate
// denominators.
import { effectiveStatus, type RunRecord } from "../core/registry.ts";

export const UNKNOWN_MODEL = "unknown";

export interface Distribution {
  avg: number;
  p50: number;
  p95: number;
}

export interface StatsGroup {
  runs: number;
  /** successes / runs with a verdict (unavailable excluded); null when no verdicts. */
  successRate: number | null;
  tokens: number;
  /** Sum over priced runs only. */
  costUsd: number;
  unpricedRuns: number;
}

export interface GlobalStats {
  totalRuns: number;
  /** Runs whose effective status is `running` (live heartbeat). */
  activeRuns: number;
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
  costUsd: number;
  unpricedRuns: number;
  successRate: number | null;
  byAgent: Record<string, StatsGroup>;
  byModel: Record<string, StatsGroup>;
  byStatus: Record<string, number>;
  byExitStatus: Record<string, number>;
  perRun: { durationMs: Distribution | null; tokens: Distribution | null; costUsd: Distribution | null };
}

/** Model label of a run: observed model(s) from the usage verdict (joined by
 *  `+` when several), else the requested model, else `unknown`. */
export function runModel(rec: RunRecord): string {
  const m = rec.usage?.model;
  if (m?.observed !== undefined && m.observed.length > 0) return [...m.observed].sort().join("+");
  if (m?.requested !== undefined && m.requested !== "") return m.requested;
  return UNKNOWN_MODEL;
}

function isPriced(rec: RunRecord): boolean {
  const v = rec.totals?.costUsd;
  return !(rec.metering === "none" || rec.usage?.usd.available === false || v === undefined || !Number.isFinite(v));
}

/** Nearest-rank percentile of an ascending-sorted, non-empty array. */
function percentile(sorted: number[], p: number): number {
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[Math.min(sorted.length, rank) - 1]!;
}

function distribution(values: number[]): Distribution | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return {
    avg: sorted.reduce((a, b) => a + b, 0) / sorted.length,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
  };
}

interface Acc {
  runs: number;
  successes: number;
  unavailable: number;
  tokens: number;
  costUsd: number;
  unpricedRuns: number;
}

const newAcc = (): Acc => ({ runs: 0, successes: 0, unavailable: 0, tokens: 0, costUsd: 0, unpricedRuns: 0 });

function finish(a: Acc): StatsGroup {
  const verdicts = a.runs - a.unavailable;
  return {
    runs: a.runs,
    successRate: verdicts > 0 ? a.successes / verdicts : null,
    tokens: a.tokens,
    costUsd: a.costUsd,
    unpricedRuns: a.unpricedRuns,
  };
}

export function computeGlobalStats(records: RunRecord[], now: number = Date.now()): GlobalStats {
  const all = newAcc();
  const agents = new Map<string, Acc>();
  const models = new Map<string, Acc>();
  const byStatus: Record<string, number> = {};
  const byExitStatus: Record<string, number> = {};
  const tok = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const durations: number[] = [];
  const tokenCounts: number[] = [];
  const costs: number[] = [];
  let active = 0;

  const slot = (m: Map<string, Acc>, key: string): Acc => {
    let a = m.get(key);
    if (a === undefined) m.set(key, (a = newAcc()));
    return a;
  };

  for (const rec of records) {
    const status = effectiveStatus(rec, now);
    if (status === "running") active++;
    byStatus[status] = (byStatus[status] ?? 0) + 1;
    if (rec.exitStatus !== undefined) byExitStatus[rec.exitStatus] = (byExitStatus[rec.exitStatus] ?? 0) + 1;

    const input = rec.totals?.inputTokens ?? 0;
    const output = rec.totals?.outputTokens ?? 0;
    tok.input += input;
    tok.output += output;
    tok.cacheRead += rec.totals?.cacheReadTokens ?? 0;
    tok.cacheWrite += rec.totals?.cacheWriteTokens ?? 0;
    const runTokens = input + output;
    tokenCounts.push(runTokens);

    const end = rec.endedAt ?? rec.updatedAt ?? rec.startedAt;
    durations.push(Math.max(0, end - rec.startedAt));

    const priced = isPriced(rec);
    const cost = priced ? rec.totals!.costUsd : 0;
    if (priced) costs.push(cost);

    const unavailable = rec.exitStatus === "unavailable" || rec.status === "unavailable";
    const success = !unavailable && (rec.status ?? rec.exitStatus) === "success";

    for (const a of [all, slot(agents, rec.agent), slot(models, runModel(rec))]) {
      a.runs++;
      a.tokens += runTokens;
      if (priced) a.costUsd += cost;
      else a.unpricedRuns++;
      if (unavailable) a.unavailable++;
      else if (success) a.successes++;
    }
  }

  const groups = (m: Map<string, Acc>): Record<string, StatsGroup> =>
    Object.fromEntries([...m.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, finish(v)]));

  return {
    totalRuns: all.runs,
    activeRuns: active,
    tokens: { ...tok, total: tok.input + tok.output + tok.cacheRead + tok.cacheWrite },
    costUsd: all.costUsd,
    unpricedRuns: all.unpricedRuns,
    successRate: finish(all).successRate,
    byAgent: groups(agents),
    byModel: groups(models),
    byStatus,
    byExitStatus,
    perRun: { durationMs: distribution(durations), tokens: distribution(tokenCounts), costUsd: distribution(costs) },
  };
}
