// Usage windows: Claude 5-hour billing blocks (#18) and burn-rate / pace
// analytics (#19). Pure functions over usage records: every entry point takes
// `now` explicitly so callers (stats, dash, status/statusline) and tests agree
// on one clock and nothing here touches I/O.
//
// Honesty rule (repo-wide): a number the tool cannot know is `null`, never 0.
// An empty trailing window has no rate; a block whose records carry no price
// has no $ projection.

/** One usage event. Structurally compatible with src/cli/lib.ts AggregatableRecord. */
export interface UsageWindowRecord {
  /** ISO-8601 string or ms epoch; null when the source exposes no timestamp. */
  ts: string | number | null;
  agent: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens?: number;
  /** Undefined when the record has no price (unknown model): contributes no cost. */
  costUsd?: number;
}

const HOUR_MS = 3_600_000;
const MIN_MS = 60_000;

/** Claude subscription plans meter usage in rolling 5-hour windows. */
export const BLOCK_MS = 5 * HOUR_MS;

/** Agents whose vendor bills in 5h blocks. Other vendors do not meter this way. */
export const BLOCK_AGENTS: readonly string[] = ["claude"];

function tsMs(ts: UsageWindowRecord["ts"]): number {
  if (ts === null || ts === undefined) return NaN;
  return typeof ts === "number" ? ts : Date.parse(ts);
}

/** Billed tokens of one record: input + output + cache read + cache write
 *  (reasoning is a subset of output, never added). */
function recordTokens(r: UsageWindowRecord): number {
  return r.inputTokens + r.outputTokens + r.cacheReadTokens + r.cacheWriteTokens;
}

const round6 = (n: number): number => Math.round(n * 1e6) / 1e6;
const iso = (ms: number): string => new Date(ms).toISOString();

// ---------------------------------------------------------------- blocks

export interface BlockProjection {
  /** ms from the block's first event to `now` (the rate denominator). */
  elapsedMs: number;
  /** ms from `now` to the block end. */
  remainingMs: number;
  /** costUsd / elapsed hours; null when no record in the block is priced. */
  usdPerHour: number | null;
  /** tokens / elapsed minutes; null when elapsedMs is 0. */
  tokensPerMinute: number | null;
  /** costUsd + usdPerHour * remaining hours. */
  projectedCostUsd: number | null;
  /** tokens + tokensPerMinute * remaining minutes. */
  projectedTokens: number | null;
}

export interface UsageBlock {
  /** Hour-floored timestamp of the block's first event (ISO). */
  start: string;
  /** start + 5h (ISO). An event at exactly `end` opens the next block. */
  end: string;
  firstEventAt: string;
  lastEventAt: string;
  /** Records (assistant messages) in the block. */
  records: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** input + output + cacheRead + cacheWrite. */
  tokens: number;
  /** Sum of priced records only (see unpricedRecords). */
  costUsd: number;
  /** Records with no price: their tokens count, their cost is unknown. */
  unpricedRecords: number;
  /** now ∈ [start, end). */
  active: boolean;
  /** Burn rate + block-end projection for the active block; null otherwise. */
  projection: BlockProjection | null;
}

export interface BlockOptions {
  now: number;
  /** Agents to include (default: BLOCK_AGENTS = claude). */
  agents?: readonly string[];
}

/**
 * Group records into 5-hour billing blocks, ccusage semantics: a block starts
 * at its first event's timestamp floored to the UTC hour and spans 5h; the
 * first event at or after `start + 5h` opens a new block (a gap longer than 5h
 * always does, since it necessarily crosses the previous block's end).
 * Records without a timestamp cannot be placed and are skipped.
 */
export function computeBlocks(records: Iterable<UsageWindowRecord>, opts: BlockOptions): UsageBlock[] {
  const agents = opts.agents ?? BLOCK_AGENTS;
  const dated: Array<{ t: number; r: UsageWindowRecord }> = [];
  for (const r of records) {
    if (!agents.includes(r.agent)) continue;
    const t = tsMs(r.ts);
    if (Number.isFinite(t)) dated.push({ t, r });
  }
  dated.sort((a, b) => a.t - b.t);

  const out: UsageBlock[] = [];
  let cur: { startMs: number; first: number; last: number; recs: UsageWindowRecord[] } | undefined;
  const close = (): void => {
    if (cur) out.push(finishBlock(cur.startMs, cur.first, cur.last, cur.recs, opts.now));
  };
  for (const { t, r } of dated) {
    if (!cur || t >= cur.startMs + BLOCK_MS) {
      close();
      cur = { startMs: Math.floor(t / HOUR_MS) * HOUR_MS, first: t, last: t, recs: [] };
    }
    cur.last = t;
    cur.recs.push(r);
  }
  close();
  return out;
}

function finishBlock(
  startMs: number,
  first: number,
  last: number,
  recs: UsageWindowRecord[],
  now: number,
): UsageBlock {
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let costUsd = 0;
  let unpriced = 0;
  for (const r of recs) {
    inputTokens += r.inputTokens;
    outputTokens += r.outputTokens;
    cacheReadTokens += r.cacheReadTokens;
    cacheWriteTokens += r.cacheWriteTokens;
    if (r.costUsd === undefined || !Number.isFinite(r.costUsd)) unpriced += 1;
    else costUsd += r.costUsd;
  }
  const endMs = startMs + BLOCK_MS;
  const tokens = inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens;
  const active = now >= startMs && now < endMs;
  const block: UsageBlock = {
    start: iso(startMs),
    end: iso(endMs),
    firstEventAt: iso(first),
    lastEventAt: iso(last),
    records: recs.length,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    tokens,
    costUsd: round6(costUsd),
    unpricedRecords: unpriced,
    active,
    projection: null,
  };
  if (active) block.projection = projectBlock(block, now);
  return block;
}

/**
 * Burn rate + projection for a block, documented formula:
 *   elapsed   = now - firstEventAt
 *   usdPerHour = costUsd / elapsed_hours
 *   projectedCostUsd = costUsd + usdPerHour * (end - now)_hours
 * (tokens analogous per minute). Rates are null when elapsed is 0 or, for $,
 * when no record in the block is priced.
 */
export function projectBlock(block: UsageBlock, now: number): BlockProjection {
  const elapsedMs = Math.max(0, now - Date.parse(block.firstEventAt));
  const remainingMs = Math.max(0, Date.parse(block.end) - now);
  const priced = block.records - block.unpricedRecords > 0;
  const usdPerHour = elapsedMs > 0 && priced ? block.costUsd / (elapsedMs / HOUR_MS) : null;
  const tokensPerMinute = elapsedMs > 0 ? block.tokens / (elapsedMs / MIN_MS) : null;
  return {
    elapsedMs,
    remainingMs,
    usdPerHour: usdPerHour === null ? null : round6(usdPerHour),
    tokensPerMinute: tokensPerMinute === null ? null : round6(tokensPerMinute),
    projectedCostUsd: usdPerHour === null ? null : round6(block.costUsd + usdPerHour * (remainingMs / HOUR_MS)),
    projectedTokens:
      tokensPerMinute === null ? null : Math.round(block.tokens + tokensPerMinute * (remainingMs / MIN_MS)),
  };
}

/**
 * The block containing `now`, or null when no block is open. This is the seam
 * for `ach status` / statusline: "how much has this 5h window cost me".
 */
export function currentBlock(
  records: Iterable<UsageWindowRecord>,
  now: number = Date.now(),
  agents: readonly string[] = BLOCK_AGENTS,
): UsageBlock | null {
  const blocks = computeBlocks(records, { now, agents });
  const last = blocks[blocks.length - 1];
  return last?.active ? last : null;
}

// ---------------------------------------------------------------- pace

/** The two documented trailing windows: short spikes (15m) and steady state (1h). */
export const PACE_WINDOWS = { "15m": 15 * MIN_MS, "1h": HOUR_MS } as const;
export type PaceWindowName = keyof typeof PACE_WINDOWS;

export interface PaceWindow {
  windowMs: number;
  /** Denominator actually used: min(windowMs, now - sinceMs). */
  effectiveMs: number;
  /** Events in (now - windowMs, now] (for sample-based pace: samples used). */
  records: number;
  usdPerHour: number | null;
  tokensPerMinute: number | null;
  /** ISO time the budget is hit at this rate; null when no budget, no rate,
   *  rate 0, or the budget is already exhausted. */
  etaBudgetHit: string | null;
}

export interface Pace {
  asOf: string;
  budgetUsd: number | null;
  spentUsd: number | null;
  /** null when no budget is set; "exhausted" once spent >= budget. */
  budget: "ok" | "exhausted" | null;
  windows: Record<PaceWindowName, PaceWindow>;
}

export interface PaceOptions {
  now: number;
  budgetUsd?: number;
  /** What counts as spent against the budget (the caller defines the scope). */
  spentUsd?: number;
  /** Observation start (e.g. a run's startedAt): shortens the denominator when
   *  the observation is younger than the window. Undefined = full window. */
  sinceMs?: number;
}

function budgetState(budgetUsd: number | undefined, spentUsd: number | undefined): Pace["budget"] {
  if (budgetUsd === undefined) return null;
  return (spentUsd ?? 0) >= budgetUsd ? "exhausted" : "ok";
}

function eta(
  now: number,
  usdPerHour: number | null,
  budgetUsd: number | undefined,
  spentUsd: number | undefined,
): string | null {
  if (budgetUsd === undefined || usdPerHour === null || usdPerHour <= 0) return null;
  const left = budgetUsd - (spentUsd ?? 0);
  if (left <= 0) return null;
  return iso(now + (left / usdPerHour) * HOUR_MS);
}

/**
 * Pace over discrete events (stats): for each trailing window W, the events
 * with timestamp in (now - W, now] are summed and divided by
 * min(W, now - sinceMs). No events in the window → null rates (never 0).
 */
export function computePace(records: Iterable<UsageWindowRecord>, opts: PaceOptions): Pace {
  const { now, budgetUsd, spentUsd, sinceMs } = opts;
  const dated: Array<{ t: number; r: UsageWindowRecord }> = [];
  for (const r of records) {
    const t = tsMs(r.ts);
    if (Number.isFinite(t)) dated.push({ t, r });
  }
  const windows = {} as Record<PaceWindowName, PaceWindow>;
  for (const [name, windowMs] of Object.entries(PACE_WINDOWS) as Array<[PaceWindowName, number]>) {
    const effectiveMs = sinceMs === undefined ? windowMs : Math.max(0, Math.min(windowMs, now - sinceMs));
    let n = 0;
    let priced = 0;
    let cost = 0;
    let tokens = 0;
    for (const { t, r } of dated) {
      if (t <= now - windowMs || t > now) continue;
      n += 1;
      tokens += recordTokens(r);
      if (r.costUsd !== undefined && Number.isFinite(r.costUsd)) {
        priced += 1;
        cost += r.costUsd;
      }
    }
    const usdPerHour = n > 0 && priced > 0 && effectiveMs > 0 ? round6(cost / (effectiveMs / HOUR_MS)) : null;
    const tokensPerMinute = n > 0 && effectiveMs > 0 ? round6(tokens / (effectiveMs / MIN_MS)) : null;
    windows[name] = {
      windowMs,
      effectiveMs,
      records: n,
      usdPerHour,
      tokensPerMinute,
      etaBudgetHit: eta(now, usdPerHour, budgetUsd, spentUsd),
    };
  }
  return {
    asOf: iso(now),
    budgetUsd: budgetUsd ?? null,
    spentUsd: spentUsd === undefined ? null : round6(spentUsd),
    budget: budgetState(budgetUsd, spentUsd),
    windows,
  };
}

/** One cumulative observation of a live run (cost/tokens so far at time t).
 *  `costUsd` / `tokens` null when the agent does not report that lane. */
export interface PaceSample {
  t: number;
  costUsd: number | null;
  tokens: number | null;
}

function valueAt(samples: PaceSample[], t: number, key: "costUsd" | "tokens"): number | null {
  // samples sorted by t; linear interpolation between the bracketing pair.
  let prev: PaceSample | undefined;
  for (const s of samples) {
    if (s.t >= t) {
      const v = s[key];
      if (!prev || s.t === t) return v;
      const pv = prev[key];
      if (v === null || pv === null) return null;
      return pv + ((v - pv) * (t - prev.t)) / (s.t - prev.t);
    }
    prev = s;
  }
  return prev ? prev[key] : null;
}

/**
 * Pace over cumulative samples (dash: a live run's totals observed at each
 * redraw, seeded with {startedAt, 0}). The rate over window W is
 *   (value(now) - value(now - W')) / W',  W' = min(W, now - firstSample)
 * with value() linearly interpolated between samples. Fewer than two samples
 * or W' = 0 → null rates. spentUsd = the latest sample's cost.
 */
export function paceFromSamples(samples: PaceSample[], opts: { now: number; budgetUsd?: number }): Pace {
  const { now, budgetUsd } = opts;
  const sorted = [...samples].filter((s) => s.t <= now).sort((a, b) => a.t - b.t);
  const first = sorted[0];
  const latest = sorted[sorted.length - 1];
  const spent = latest?.costUsd ?? undefined;
  const windows = {} as Record<PaceWindowName, PaceWindow>;
  for (const [name, windowMs] of Object.entries(PACE_WINDOWS) as Array<[PaceWindowName, number]>) {
    const effectiveMs = first && latest ? Math.max(0, Math.min(windowMs, latest.t - first.t)) : 0;
    let usdPerHour: number | null = null;
    let tokensPerMinute: number | null = null;
    if (sorted.length >= 2 && effectiveMs > 0 && latest) {
      const from = latest.t - effectiveMs;
      const c0 = valueAt(sorted, from, "costUsd");
      const k0 = valueAt(sorted, from, "tokens");
      if (c0 !== null && latest.costUsd !== null) usdPerHour = round6((latest.costUsd - c0) / (effectiveMs / HOUR_MS));
      if (k0 !== null && latest.tokens !== null) tokensPerMinute = round6((latest.tokens - k0) / (effectiveMs / MIN_MS));
    }
    windows[name] = {
      windowMs,
      effectiveMs,
      records: sorted.filter((s) => latest !== undefined && s.t >= latest.t - effectiveMs).length,
      usdPerHour,
      tokensPerMinute,
      etaBudgetHit: eta(now, usdPerHour, budgetUsd, spent),
    };
  }
  return {
    asOf: iso(now),
    budgetUsd: budgetUsd ?? null,
    spentUsd: spent === undefined ? null : round6(spent),
    budget: budgetState(budgetUsd, spent),
    windows,
  };
}
