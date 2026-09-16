// Truthful usage reporting — wave 2/F of the kiro-acp plan.
//
// ONE rule governs this module: NEVER FABRICATE. A number is reported only when
// a source actually produced it. On kiro 2.21.x every token counter in every
// available source is zero (MITM tap `tokenUsage`, session-store
// `*_token_count`, stream `metadata`), so `tokens.available` comes back FALSE
// and the renderers print `n/a` — not `0`, and not `$0.0000`. See
// `docs/TOKEN-COUNTING.md` § "Kiro on 2.21.x".
//
// What IS knowable there: credits (three independent sources, reconciled here)
// and context-window occupancy (derived from a percentage and a window size,
// labelled `source:'derived'` so nobody mistakes it for billed tokens).
//
// Pure: no I/O, no clock, no env. The driver does the reading.
import type { CanonicalTokenRecord, NormalizedUsageTokens, ReportedUsageCost, UsageAvailability } from './types.js';
import type { ParsedKiroSessionStore } from '../adapters/kiro-session-store.js';

/** Credits agreeing to within this absolute delta are treated as one charge. */
export const CREDIT_TOLERANCE = 1e-9;

/**
 * Context-window fallback when no source states the real window. Deliberately
 * one conservative entry: a guess is always labelled `windowSource:'assumed'`
 * so a reader can discount it. NEVER grow this into a pricing-style table of
 * per-model guesses — add real sources instead.
 */
export const ASSUMED_CONTEXT_WINDOWS: Record<string, number> = { default: 200_000 };

export interface ComputeUsageInput {
  agent: string;
  tokens: CanonicalTokenRecord[];
  sessionStore?: ParsedKiroSessionStore | null;
  /** Cumulative credits reported by the live stream (kiro `metadata` frames). */
  streamCreditsCumulative?: number | null;
  /** Driver's running USD total (0 when nothing could be priced). */
  totalCost: number;
  /** True when the pricer returned a real (non-NaN) price for some record. */
  pricerPriced: boolean;
}

export interface ComputeUsageResult {
  usage: UsageAvailability;
  /** Reconciliation problems for RunResult.warnings; empty when all agree. */
  warnings: string[];
}

function extraOf(rec: CanonicalTokenRecord): Record<string, unknown> {
  return (rec.extra ?? {}) as Record<string, unknown>;
}

function finite(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/** A record counts as carrying tokens only when it says so AND a counter is
 *  non-zero. `extra.tokensAvailable === false` vetoes it outright. */
function recordHasTokens(rec: CanonicalTokenRecord): boolean {
  if (extraOf(rec).tokensAvailable === false) return false;
  return (
    (rec.inputTokens ?? 0) > 0 ||
    (rec.outputTokens ?? 0) > 0 ||
    (rec.cacheReadTokens ?? 0) > 0 ||
    (rec.cacheWriteTokens ?? 0) > 0
  );
}

function storeHasTokens(store: ParsedKiroSessionStore): boolean {
  return store.turns.some(
    (t) => t.inputTokens > 0 || t.outputTokens > 0 || t.cacheReadTokens > 0 || t.cacheWriteTokens > 0,
  );
}

/**
 * Sum `extra.credits` across TAP records; null when no tap record reported
 * any. Records stamped `extra.source:'native'` are the stream's own snapshot
 * of the same charge (kiro-events) and are reported via
 * `streamCreditsCumulative` — summing them here would double-count every
 * headless run and raise a bogus "credit sources disagree" warning.
 */
function tapCredits(tokens: CanonicalTokenRecord[]): number | null {
  let total: number | null = null;
  for (const rec of tokens) {
    const extra = extraOf(rec);
    if (extra.source === 'native') continue;
    const c = finite(extra.credits);
    if (c === undefined) continue;
    total = (total ?? 0) + c;
  }
  return total;
}

/** Latest `extra.contextUsagePercentage` seen on a usage record. */
function streamContextPercentage(tokens: CanonicalTokenRecord[]): number | undefined {
  for (let i = tokens.length - 1; i >= 0; i -= 1) {
    const rec = tokens[i];
    if (!rec) continue;
    const pct = finite(extraOf(rec).contextUsagePercentage);
    if (pct !== undefined) return pct;
  }
  return undefined;
}

/**
 * Sum the provider-reported USD cost across records (issue #7). `costUsd` on a
 * record exists ONLY when the provider's own output stated a USD figure
 * (claude result.total_cost_usd, opencode per-step cost); the pricer's
 * estimate never writes it and kiro credits live in extra.credits. Null when
 * no record reported one — a missing cost never silently becomes $0.
 */
function sumReportedCostUsd(tokens: CanonicalTokenRecord[]): number | null {
  let total: number | null = null;
  for (const rec of tokens) {
    const cost = finite(rec.costUsd);
    if (cost === undefined) continue;
    total = (total ?? 0) + cost;
  }
  return total;
}

/** Sum store turns into run-total counts (kiro's native per-turn records). */
function sumStoreTurns(store: ParsedKiroSessionStore): NormalizedUsageTokens {
  const total: NormalizedUsageTokens = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  for (const t of store.turns) {
    total.inputTokens += t.inputTokens;
    total.outputTokens += t.outputTokens;
    total.cacheReadTokens += t.cacheReadTokens;
    total.cacheWriteTokens += t.cacheWriteTokens;
  }
  return total;
}

/**
 * Sum run-total counts from the usage records. Placeholder records
 * (extra.tokensAvailable === false, kiro 2.21.x zeros) are skipped — the same
 * rule the registry totals use. Null when nothing real remains.
 */
function sumRecordTokens(tokens: CanonicalTokenRecord[]): NormalizedUsageTokens | null {
  const usable = tokens.filter((rec) => extraOf(rec).tokensAvailable !== false);
  if (usable.length === 0) return null;
  const total: NormalizedUsageTokens = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  let reasoning: number | undefined;
  for (const rec of usable) {
    total.inputTokens += rec.inputTokens ?? 0;
    total.outputTokens += rec.outputTokens ?? 0;
    total.cacheReadTokens += rec.cacheReadTokens ?? 0;
    total.cacheWriteTokens += rec.cacheWriteTokens ?? 0;
    if (rec.reasoningTokens !== undefined) reasoning = (reasoning ?? 0) + rec.reasoningTokens;
  }
  if (reasoning !== undefined) total.reasoningTokens = reasoning;
  return total;
}

/**
 * Decide what this run actually knows about tokens, credits, USD and context.
 *
 * Credits authority order (PLAN amendment rule 4): live stream > session store
 * > MITM tap. Every source that reported a value lands in `credits.sources`
 * whether or not it won, and any disagreement beyond CREDIT_TOLERANCE becomes a
 * warning listing all three — the charge is reported ONCE, never summed across
 * sources.
 */
export function computeUsageAvailability(input: ComputeUsageInput): ComputeUsageResult {
  const warnings: string[] = [];
  const store = input.sessionStore ?? null;

  // ------------------------------------------------------------------ tokens
  const recordsWithTokens = input.tokens.filter(recordHasTokens);
  const storeTokens = store !== null && storeHasTokens(store);
  const tokens: UsageAvailability['tokens'] = storeTokens
    ? { available: true, source: 'session-store', scope: 'turn', cumulative: false, complete: true }
    : recordsWithTokens.length > 0
      ? { available: true, source: 'tap', scope: 'call', cumulative: false, complete: false }
      : { available: false };

  // ----------------------------------------------------------------- credits
  const sources: NonNullable<UsageAvailability['credits']['sources']> = {};
  const stream = finite(input.streamCreditsCumulative);
  if (stream !== undefined) sources.stream = stream;
  if (store !== null && store.creditsTotal !== null) sources['session-store'] = store.creditsTotal;
  const tap = tapCredits(input.tokens);
  if (tap !== null) sources.tap = tap;

  const reported = Object.entries(sources) as Array<[keyof typeof sources, number]>;
  let credits: UsageAvailability['credits'];
  if (reported.length === 0) {
    credits = { available: false };
  } else {
    // Authority order, not a sum: the same charge observed three ways.
    const order: Array<[keyof typeof sources, UsageAvailability['credits']['source']]> = [
      ['stream', 'native'],
      ['session-store', 'native'],
      ['tap', 'tap'],
    ];
    let value = 0;
    let source: UsageAvailability['credits']['source'] = 'tap';
    for (const [key, src] of order) {
      const v = sources[key];
      if (v === undefined) continue;
      value = v;
      source = src;
      break;
    }
    const disagreement = reported.some(([, v]) => Math.abs(v - value) > CREDIT_TOLERANCE);
    if (disagreement) {
      warnings.push(
        `usage: credit sources disagree (${reported
          .map(([k, v]) => `${k}=${v}`)
          .join(', ')}); reporting ${value} from ${source}`,
      );
    }
    credits = {
      available: true,
      source: reported.length > 1 ? 'reconciled' : source,
      scope: 'run',
      cumulative: true,
      complete: true,
      value,
      sources,
    };
  }

  // --------------------------------------------------------------------- usd
  // USD is real only when the pricer priced a record that HAS tokens. Pricing
  // zero tokens yields $0.0000, which is a lie dressed as a number.
  const usd: UsageAvailability['usd'] =
    input.pricerPriced && tokens.available && Number.isFinite(input.totalCost)
      ? { available: true, source: 'pricer', value: input.totalCost }
      : { available: false };

  // ----------------------------------------------------------------- context
  const percentage = store?.lastContextUsagePercentage ?? streamContextPercentage(input.tokens);
  const model = store?.model;
  const storeWindow = store?.contextWindowTokens;
  const windowTokens = storeWindow ?? ASSUMED_CONTEXT_WINDOWS.default;
  const windowSource: 'session-store' | 'assumed' = storeWindow !== undefined ? 'session-store' : 'assumed';
  const context: UsageAvailability['context'] =
    percentage === undefined || windowTokens === undefined
      ? { available: false, source: 'derived', ...(model !== undefined ? { model } : {}) }
      : {
          available: true,
          source: 'derived',
          percentage,
          windowTokens,
          windowSource,
          tokens: Math.round((percentage / 100) * windowTokens),
          ...(model !== undefined ? { model } : {}),
        };

  // ------------------------------------------------- reported cost (issue #7)
  // Per adapter from native output, one normalized shape (ReportedUsageCost):
  // "reported" only when a provider-stated USD figure exists; tokens totals
  // prefer the kiro session store (turn-scoped, complete) over stream records,
  // mirroring the `tokens` availability preference above.
  const reportedCostUsd = sumReportedCostUsd(input.tokens);
  const tokenTotals = storeTokens ? sumStoreTurns(store) : sumRecordTokens(input.tokens);
  const cost: ReportedUsageCost = {
    costAvailability: reportedCostUsd !== null ? 'reported' : 'unavailable',
    reportedCostUsd,
    ...(tokenTotals !== null ? { tokens: tokenTotals } : {}),
  };

  return { usage: { tokens, credits, usd, context, cost }, warnings };
}
