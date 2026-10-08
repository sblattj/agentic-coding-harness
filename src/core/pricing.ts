import { readFileSync } from 'node:fs';
import bundledPricingData from './pricing-data.json' with { type: 'json' };
import { z } from 'zod';
import type { CanonicalTokenRecord } from './types.js';

/** Per-1M-token USD prices. */
export interface ModelPrice {
  input: number;
  output: number;
  cache_read: number;
  /** Cache write at the 5-minute TTL (Anthropic: 1.25x input). */
  cache_creation: number;
  /**
   * Cache write at the 1-hour TTL (Anthropic: 2x input), issue #105. Billed
   * for a record's cacheWrite1hTokens; absent = the model has no 1h tier and
   * every write is billed at cache_creation.
   */
  cache_creation_1h?: number;
}

/** Options for {@link Pricer.price}. */
export interface PriceOptions {
  /**
   * Pure token × price math: ignore every CLI-reported per-model slice cost
   * (extra.raw.models[].costUsd) and price each slice from its own tokens.
   * `ach stats --cost-mode calculate` and the disagreement check use this.
   */
  computedOnly?: boolean;
}

export interface Pricer {
  /**
   * Price one canonical record in USD. Unknown model -> NaN (warning recorded,
   * never silent 0). By default a multi-model record sums its slices' CLI-
   * reported costUsd where present (see {@link pricedSources}); pass
   * `{ computedOnly: true }` for pure token math. The second parameter is
   * optional, so a custom Pricer that ignores it still type-checks.
   */
  price(record: CanonicalTokenRecord, opts?: PriceOptions): number;
  /** Strip provider prefixes and date/-latest suffixes: "anthropic/claude-sonnet-4-20250514" -> "claude-sonnet-4". */
  resolveAlias(model: string): string;
  /** Warnings accumulated so far (and drained): unpriced models, malformed map entries, family-fallback estimates. */
  drainWarnings(): string[];
}

// Embedded fallback: LiteLLM-verified (flagships) plus plausible per-1M USD
// prices for the newer entries, all subject to override by the bundled
// pricing-data.json extract and any external map. Claude cache writes carry
// both TTL tiers: cache_creation is the 5m rate (1.25x input) and
// cache_creation_1h the 1h rate (2x input) that Claude Code actually uses
// (issue #105).
const FALLBACK_PRICES: Record<string, ModelPrice> = {
  'claude-sonnet-4': { input: 3, output: 15, cache_read: 0.3, cache_creation: 3.75, cache_creation_1h: 6 },
  'claude-sonnet-4-5': { input: 2, output: 10, cache_read: 0.2, cache_creation: 2.5, cache_creation_1h: 4 },
  'claude-sonnet-5': { input: 2, output: 10, cache_read: 0.2, cache_creation: 2.5, cache_creation_1h: 4 },
  // claude-sonnet-5-5 (issue #103): mirrors the -5 family rates — the LiteLLM
  // extract predates it; pricing-data.json marks its copy with the estimated
  // provenance.
  'claude-sonnet-5-5': { input: 2, output: 10, cache_read: 0.2, cache_creation: 2.5, cache_creation_1h: 4 },
  'claude-haiku-4-5': { input: 1, output: 5, cache_read: 0.1, cache_creation: 1.25, cache_creation_1h: 2 },
  'claude-opus-4': { input: 15, output: 75, cache_read: 1.5, cache_creation: 18.75, cache_creation_1h: 30 },
  'claude-opus-4-8': { input: 5, output: 25, cache_read: 0.5, cache_creation: 6.25, cache_creation_1h: 10 },
  'claude-opus-5': { input: 5, output: 25, cache_read: 0.5, cache_creation: 6.25, cache_creation_1h: 10 },
  // claude-opus-5-5: actual Anthropic list rates (issue #105), not the -5
  // mirror #103 shipped — it reproduces CLI-reported costs to the micro-dollar.
  'claude-opus-5-5': { input: 4, output: 20, cache_read: 0.2, cache_creation: 5, cache_creation_1h: 8 },
  'claude-fable-5-1': { input: 10, output: 50, cache_read: 0.25, cache_creation: 12.5, cache_creation_1h: 20 },
  'gpt-5': { input: 1.25, output: 10, cache_read: 0.125, cache_creation: 0 },
  'gpt-5.6': { input: 4, output: 20, cache_read: 0.4, cache_creation: 5 },
  'gemini-2.5-pro': { input: 1.25, output: 10, cache_read: 0.125, cache_creation: 0 },
  'gemini-3-pro': { input: 2, output: 12, cache_read: 0.2, cache_creation: 0 },
  'gemini-3-flash': { input: 0.5, output: 3, cache_read: 0.05, cache_creation: 0 },
  // Negative-control null adapter (issue #55, src/adapters/null.ts): no real
  // model backs a null run, so every rate is 0 — deterministic $0 cost with
  // no "unknown model" pricer warning, and no reuse of kiro's credits-only
  // carve-out below.
  'null': { input: 0, output: 0, cache_read: 0, cache_creation: 0 },
  // Claude Code writes model "<synthetic>" on assistant messages it generates
  // locally ("Not logged in", API error notices, "No response requested."):
  // no model call happened, nothing is billable (issue #116). A zero-rate
  // pseudo-model prices them $0 with no unknown-model warning, on both the
  // single-model and per-model-breakdown paths. The Claude transcript reader
  // also drops them at parse time so they never reach a breakdown.
  '<synthetic>': { input: 0, output: 0, cache_read: 0, cache_creation: 0 },
};

/**
 * External LiteLLM-style cost map. Accepts either per-1M fields
 * (input/output/cache_read/cache_creation) or LiteLLM per-token fields
 * (*_cost_per_token), which are detected and scaled by 1e6.
 */
const ExternalPrice = z
  .object({
    input: z.number().nonnegative().optional(),
    output: z.number().nonnegative().optional(),
    cache_read: z.number().nonnegative().optional(),
    cache_creation: z.number().nonnegative().optional(),
    cache_creation_1h: z.number().nonnegative().optional(),
    input_cost_per_token: z.number().nonnegative().optional(),
    output_cost_per_token: z.number().nonnegative().optional(),
    cache_read_input_token_cost: z.number().nonnegative().optional(),
    cache_creation_input_token_cost: z.number().nonnegative().optional(),
    cache_creation_input_token_cost_above_1hr: z.number().nonnegative().optional(),
  })
  .passthrough();

export function resolveAlias(model: string): string {
  let m = model.trim().toLowerCase();
  // Strip one or more provider prefixes: anthropic/, openai/, gemini/,
  // google/, vertex_ai/, openrouter/... (anything before the last '/').
  m = m.replace(/^(?:[a-z0-9_-]+\/)+/, '');
  // Strip a trailing date stamp: claude-sonnet-4-20250514 -> claude-sonnet-4.
  m = m.replace(/-(?:19|20)\d{6}$/, '');
  // Strip rolling/preview channels.
  m = m.replace(/-(?:latest|preview|stable)$/, '');
  // Strip a trailing context-window tag: claude-opus-5[1m] -> claude-opus-5.
  m = m.replace(/\[[^\]]*\]$/, '');
  return m;
}

/**
 * Env var naming a local pricing-override JSON file (a LiteLLM-style cost
 * map, per-1M or per-token fields) layered over the bundled data at pricer
 * creation. A missing file is a no-op (unset-equivalent); a present but
 * malformed file warns once and never crashes. An explicit costMapPath
 * argument to {@link createPricer} wins over this env var.
 */
export const PRICING_OVERRIDE_ENV = 'AGENTIC_CODING_HARNESS_PRICING_OVERRIDE';

function loadExternalMap(path: string): Record<string, ModelPrice> {
  return parsePriceMap(JSON.parse(readFileSync(path, 'utf8')));
}

function parsePriceMap(raw: unknown): Record<string, ModelPrice> {
  const parsed = z.record(z.string(), ExternalPrice).parse(raw);
  const map: Record<string, ModelPrice> = {};
  for (const [key, entry] of Object.entries(parsed)) {
    const per1m = (perToken: number | undefined) =>
      perToken === undefined ? undefined : perToken * 1_000_000;
    const price: ModelPrice = {
      input: entry.input ?? per1m(entry.input_cost_per_token) ?? 0,
      output: entry.output ?? per1m(entry.output_cost_per_token) ?? 0,
      cache_read: entry.cache_read ?? per1m(entry.cache_read_input_token_cost) ?? 0,
      cache_creation: entry.cache_creation ?? per1m(entry.cache_creation_input_token_cost) ?? 0,
    };
    const oneHour = entry.cache_creation_1h ?? per1m(entry.cache_creation_input_token_cost_above_1hr);
    if (oneHour !== undefined) price.cache_creation_1h = oneHour;
    map[key.toLowerCase()] = price;
    map[resolveAlias(key)] = price;
  }
  return map;
}

// Static JSON import keeps the authoritative extract inside every distributed
// bundle (Node CLI/library, Bun and standalone), without sibling-file lookups.
const BUNDLED_PRICES = parsePriceMap(bundledPricingData);

/**
 * Per-model usage slice as embedded by the adapters under extra.raw.models
 * (claude result.modelUsage via canonicalFromModelUsage). Field names are the
 * adapter-lane camelCase spellings; costUsd is the CLI-reported per-model cost.
 */
interface ModelUsageSlice {
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** 1h-TTL subset of cacheWrite, when the producer split it per slice. */
  cacheWrite1h?: number;
  costUsd?: number;
}

/**
 * USD-per-1M cost of `total` cache-write tokens of which `oneHour` were
 * written with the 1h TTL (issue #105). Each TTL bucket is billed at its own
 * rate; the 1h count is clamped to [0, total] so a malformed split never
 * bills more tokens than were written. A model with no 1h rate bills every
 * write at the 5m rate.
 */
function cacheWriteCost(total: number, oneHour: number | undefined, p: ModelPrice): number {
  const oneH = Math.min(Math.max(0, oneHour ?? 0), Math.max(0, total));
  return (total - oneH) * p.cache_creation + oneH * (p.cache_creation_1h ?? p.cache_creation);
}

/**
 * Extract a multi-model breakdown from extra.raw.models. Returns null unless
 * the array holds ≥2 well-formed entries — single-entry arrays (assistant
 * message usage) stay on the unchanged single-model path, where the aggregate
 * IS that model's usage.
 */
function modelSlices(rec: CanonicalTokenRecord): ModelUsageSlice[] | null {
  const rawModels = (rec.extra as { raw?: { models?: unknown } } | undefined)?.raw?.models;
  if (!Array.isArray(rawModels) || rawModels.length < 2) return null;
  const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  const slices: ModelUsageSlice[] = [];
  for (const entry of rawModels) {
    if (typeof entry !== 'object' || entry === null) return null;
    const e = entry as Record<string, unknown>;
    if (typeof e.model !== 'string' || e.model === '') return null;
    slices.push({
      model: e.model,
      input: num(e.input),
      output: num(e.output),
      cacheRead: num(e.cacheRead),
      cacheWrite: num(e.cacheWrite),
      ...(typeof e.cacheWrite1h === 'number' && Number.isFinite(e.cacheWrite1h)
        ? { cacheWrite1h: e.cacheWrite1h }
        : {}),
      ...(typeof e.costUsd === 'number' && Number.isFinite(e.costUsd)
        ? { costUsd: e.costUsd }
        : {}),
    });
  }
  return slices;
}

/**
 * A record whose cost is metered by the vendor in its own units (Copilot CLI:
 * AIU, converted at a fixed rate by the adapter) and stated on `costUsd`.
 * `extra.vendorMetered === true` is the producer's claim that token math is
 * NOT a valid cost for this record: the pricer returns the stated `costUsd`,
 * or NaN (unpriced) when there is none — it never prices the tokens, even
 * when the model name is in the price table.
 */
export function isVendorMetered(rec: Pick<CanonicalTokenRecord, 'extra'>): boolean {
  return (rec.extra as { vendorMetered?: unknown } | undefined)?.vendorMetered === true;
}

/**
 * Which cost paths the default `Pricer.price` takes for this record:
 * `reported` when at least one multi-model slice carries a CLI-reported
 * costUsd (summed verbatim), `computed` when any part is token × price math.
 * A single-model record is always `computed` (price never reads the record's
 * own top-level costUsd). The driver uses this to label RunRecord totals.
 */
export function pricedSources(rec: CanonicalTokenRecord): { reported: boolean; computed: boolean } {
  if (isVendorMetered(rec)) return { reported: true, computed: false };
  const slices = modelSlices(rec);
  if (!slices) return { reported: false, computed: true };
  const reported = slices.some((s) => s.costUsd !== undefined);
  const computed = slices.some((s) => s.costUsd === undefined);
  return { reported, computed };
}

export function createPricer(costMapPath?: string): Pricer {
  // Preserve precedence: fallback < authoritative extract < external override.
  let prices = { ...FALLBACK_PRICES, ...BUNDLED_PRICES };
  const warnings: string[] = [];
  // Unknown-model warnings are collapsed at drain (issue #116): one line per
  // distinct (model, path) with the number of sessions it hit, instead of one
  // line per priced record. Keyed by the single-occurrence text; the value
  // counts distinct session ids, plus records that carried none.
  const unknown = new Map<string, { model: string; alias: string; path: string; sessions: Set<string>; anon: number }>();
  const noteUnknown = (model: string, path: string, sessionId: string | null | undefined): void => {
    const alias = resolveAlias(model);
    const key = `${model}\0${path}`;
    let e = unknown.get(key);
    if (!e) {
      e = { model, alias, path, sessions: new Set(), anon: 0 };
      unknown.set(key, e);
    }
    if (sessionId) e.sessions.add(sessionId);
    else e.anon++;
  };

  // An explicit costMapPath wins; otherwise AGENTIC_CODING_HARNESS_PRICING_OVERRIDE
  // names a local override file. A missing override file is a no-op
  // (unset-equivalent); only a present-but-broken file warns.
  const fromEnv = costMapPath === undefined;
  let overridePath = costMapPath;
  if (fromEnv) {
    const envPath = process.env[PRICING_OVERRIDE_ENV];
    if (envPath !== undefined && envPath.trim() !== '') overridePath = envPath.trim();
  }
  if (overridePath !== undefined) {
    try {
      prices = { ...prices, ...loadExternalMap(overridePath) };
    } catch (err) {
      const absent = err instanceof Error && (err as NodeJS.ErrnoException).code === 'ENOENT';
      if (!(fromEnv && absent)) {
        warnings.push(`pricing: failed to load cost map at ${overridePath} (${err instanceof Error ? err.message : String(err)}); using embedded fallback`);
      }
    }
  }

  // Family fallback (issue #103): with no exact entry, price at the longest
  // table key that is a segment-prefix of the resolved alias
  // (claude-opus-5-5-20261001 -> claude-opus-5-5 -> claude-opus-5), so dated
  // or preview variants of a known family cost an estimate instead of n/a.
  // The estimate is never silent: one warning per model records the family
  // used and the `estimated` provenance. Prefixes shorter than 2 segments
  // never match, so an unrelated model still falls through to the
  // unknown-model NaN below — arbitrary models are never silently priced.
  const estimatedFamilies = new Set<string>();
  const lookup = (model: string): ModelPrice | undefined => {
    const alias = resolveAlias(model);
    const exact = prices[model.toLowerCase()] ?? prices[alias];
    if (exact !== undefined) return exact;
    const segments = alias.split('-');
    for (let n = segments.length - 1; n >= 2; n--) {
      const family = segments.slice(0, n).join('-');
      const p = prices[family];
      if (p !== undefined) {
        if (!estimatedFamilies.has(model)) {
          estimatedFamilies.add(model);
          warnings.push(
            `pricing: no exact price for "${model}"; priced via family fallback "${family}" (provenance: estimated)`,
          );
        }
        return p;
      }
    }
    return undefined;
  };

  return {
    price(rec: CanonicalTokenRecord, opts?: PriceOptions): number {
    const computedOnly = opts?.computedOnly === true;
    // Vendor-metered record (copilot AIU): the stated cost or nothing. A
    // computed-only call (pure token math) has no valid answer for it.
    if (isVendorMetered(rec)) {
      return !computedOnly && typeof rec.costUsd === 'number' && Number.isFinite(rec.costUsd) ? rec.costUsd : NaN;
    }
    // Multi-model record (claude runs route sub-agent/probe turns through a
    // second model): the aggregate token counts mix models, so pricing them
    // at any single model's rates is wrong — observed a haiku-labeled
    // aggregate underprice an opus-dominant run at $0.0214 vs the true
    // $0.1028. Sum per-model costs instead: the CLI-reported costUsd when
    // present, else the slice's own tokens priced at its own model's rates.
    // One unpriceable slice voids the whole record (NaN + warning), never a
    // silent partial sum.
    const slices = modelSlices(rec);
    if (slices) {
      // TTL split for slices (issue #105): claude's result.modelUsage carries
      // no per-model split, only result.usage does (aggregate). A slice with
      // its own cacheWrite1h uses it; otherwise the record-level 1h share
      // (cacheWrite1hTokens / sum of slice writes, clamped to [0,1]) is
      // applied to each slice's writes proportionally. `auto` cost mode
      // prefers a slice's CLI-reported costUsd, so the apportionment only
      // matters for computed (`calculate` / audit) costs.
      const sliceWrites = slices.reduce((a, s) => a + s.cacheWrite, 0);
      const share =
        typeof rec.cacheWrite1hTokens === 'number' && sliceWrites > 0
          ? Math.min(1, Math.max(0, rec.cacheWrite1hTokens / sliceWrites))
          : 0;
      let total = 0;
      for (const s of slices) {
        if (s.costUsd !== undefined && !computedOnly) {
          total += s.costUsd;
          continue;
        }
        const p = lookup(s.model);
        if (!p) {
          noteUnknown(s.model, ' in per-model breakdown', rec.sessionId);
          return NaN;
        }
        total +=
          (s.input * p.input +
            s.cacheRead * p.cache_read +
            cacheWriteCost(s.cacheWrite, s.cacheWrite1h ?? s.cacheWrite * share, p) +
            s.output * p.output) /
          1_000_000;
      }
      return total;
    }
    const model = rec.model;
    // Credit-metered records (kiro MITM tap carriers): extra.credits is the
    // metering signal in kiro units, NOT USD (the "never priced" contract in
    // driver.ts / adapters/kiro.ts / cli/ach.ts), and kiro v2's wire
    // exposes no model id — the model here is undefined or the 'unknown'
    // sentinel filled in upstream. There is nothing to price: return 0 with
    // no warning (a warning per record spammed every kiro run 8x).
    const credits = rec.extra?.credits;
    if (
      (model === undefined || model === 'unknown') &&
      typeof credits === 'number' &&
      Number.isFinite(credits)
    ) {
      return 0;
    }
    if (!model) {
      warnings.push('pricing: record has no model field; cost not computed');
      return NaN;
    }
    const p = lookup(model);
    if (!p) {
      noteUnknown(model, '', rec.sessionId);
      return NaN;
    }
    // Cache-aware, per 1M: each token class billed exactly once at its own
    // rate. inputTokens is uncached-only by canonical convention, so fresh
    // input is never double-billed against cache reads/writes. Cache writes
    // bill per TTL bucket when the record carries the 1h split (issue #105);
    // with no split every write is billed at the 5m rate.
    return (
      ((rec.inputTokens ?? 0) * p.input +
        (rec.cacheReadTokens ?? 0) * p.cache_read +
        cacheWriteCost(rec.cacheWriteTokens ?? 0, rec.cacheWrite1hTokens, p) +
        (rec.outputTokens ?? 0) * p.output) /
      1_000_000
    );
  },
    resolveAlias,
    drainWarnings(): string[] {
      const out = warnings.splice(0, warnings.length);
      for (const e of unknown.values()) {
        const n = e.sessions.size + e.anon;
        const head = `pricing: unknown model "${e.model}" (alias "${e.alias}")${e.path}`;
        out.push(n <= 1 ? `${head}; cost not computed` : `${head} in ${n} ${e.anon === 0 ? 'sessions' : 'records'}; cost not computed`);
      }
      unknown.clear();
      return [...new Set(out)];
    },
  };
}
