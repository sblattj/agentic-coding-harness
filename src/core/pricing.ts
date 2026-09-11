import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { CanonicalTokenRecord } from './types.js';

/** Per-1M-token USD prices. */
export interface ModelPrice {
  input: number;
  output: number;
  cache_read: number;
  cache_creation: number;
}

export interface Pricer {
  /** Price one canonical record in USD. Unknown model -> NaN (warning recorded, never silent 0). */
  price(record: CanonicalTokenRecord): number;
  /** Strip provider prefixes and date/-latest suffixes: "anthropic/claude-sonnet-4-20250514" -> "claude-sonnet-4". */
  resolveAlias(model: string): string;
  /** Warnings accumulated so far (and drained): unpriced models, malformed map entries. */
  drainWarnings(): string[];
}

// Embedded fallback: LiteLLM-verified (flagships) plus plausible per-1M USD
// prices for the newer entries, all subject to override by the bundled
// pricing-data.json extract and any external map. cache_creation for Claude
// is the 5m-TTL blended default (1.25x base).
const FALLBACK_PRICES: Record<string, ModelPrice> = {
  'claude-sonnet-4': { input: 3, output: 15, cache_read: 0.3, cache_creation: 3.75 },
  'claude-sonnet-4-5': { input: 2, output: 10, cache_read: 0.2, cache_creation: 2.5 },
  'claude-sonnet-5': { input: 2, output: 10, cache_read: 0.2, cache_creation: 2.5 },
  'claude-haiku-4-5': { input: 1, output: 5, cache_read: 0.1, cache_creation: 1.25 },
  'claude-opus-4': { input: 15, output: 75, cache_read: 1.5, cache_creation: 18.75 },
  'claude-opus-4-8': { input: 5, output: 25, cache_read: 0.5, cache_creation: 6.25 },
  'claude-opus-5': { input: 5, output: 25, cache_read: 0.5, cache_creation: 6.25 },
  'claude-fable-5-1': { input: 10, output: 50, cache_read: 0.25, cache_creation: 12.5 },
  'gpt-5': { input: 1.25, output: 10, cache_read: 0.125, cache_creation: 0 },
  'gpt-5.6': { input: 4, output: 20, cache_read: 0.4, cache_creation: 5 },
  'gemini-2.5-pro': { input: 1.25, output: 10, cache_read: 0.125, cache_creation: 0 },
  'gemini-3-pro': { input: 2, output: 12, cache_read: 0.2, cache_creation: 0 },
  'gemini-3-flash': { input: 0.5, output: 3, cache_read: 0.05, cache_creation: 0 },
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
    input_cost_per_token: z.number().nonnegative().optional(),
    output_cost_per_token: z.number().nonnegative().optional(),
    cache_read_input_token_cost: z.number().nonnegative().optional(),
    cache_creation_input_token_cost: z.number().nonnegative().optional(),
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

function loadExternalMap(path: string): Record<string, ModelPrice> {
  const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
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
    map[key.toLowerCase()] = price;
    map[resolveAlias(key)] = price;
  }
  return map;
}

/**
 * Bundled LiteLLM extract (claude / gpt / gemini prefixed entries from
 * model_prices_and_context_window.json). Loaded as the base price map;
 * returns {} when the file is absent so the embedded fallback still covers
 * the flagships.
 */
function loadBundledData(): Record<string, ModelPrice> {
  try {
    return loadExternalMap(fileURLToPath(new URL('./pricing-data.json', import.meta.url)));
  } catch {
    return {};
  }
}

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
  costUsd?: number;
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
      ...(typeof e.costUsd === 'number' && Number.isFinite(e.costUsd)
        ? { costUsd: e.costUsd }
        : {}),
    });
  }
  return slices;
}

export function createPricer(costMapPath?: string): Pricer {
  // Base map: embedded fallback, layered with the bundled LiteLLM extract
  // (src/core/pricing-data.json) when it is present — a missing file (e.g.
  // in the standalone bun build) silently keeps the embedded fallback.
  let prices = { ...FALLBACK_PRICES, ...loadBundledData() };
  const warnings: string[] = [];

  if (costMapPath !== undefined) {
    try {
      prices = { ...prices, ...loadExternalMap(costMapPath) };
    } catch (err) {
      warnings.push(`pricing: failed to load cost map at ${costMapPath} (${err instanceof Error ? err.message : String(err)}); using embedded fallback`);
    }
  }

  const lookup = (model: string): ModelPrice | undefined => {
    const alias = resolveAlias(model);
    return prices[model.toLowerCase()] ?? prices[alias];
  };

  return {
    price(rec: CanonicalTokenRecord): number {
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
      let total = 0;
      for (const s of slices) {
        if (s.costUsd !== undefined) {
          total += s.costUsd;
          continue;
        }
        const p = lookup(s.model);
        if (!p) {
          warnings.push(
            `pricing: unknown model "${s.model}" (alias "${resolveAlias(s.model)}") in per-model breakdown; cost not computed`,
          );
          return NaN;
        }
        total +=
          (s.input * p.input +
            s.cacheRead * p.cache_read +
            s.cacheWrite * p.cache_creation +
            s.output * p.output) /
          1_000_000;
      }
      return total;
    }
    const model = rec.model;
    // Credit-metered records (kiro MITM tap carriers): extra.credits is the
    // metering signal in kiro units, NOT USD (the "never priced" contract in
    // driver.ts / adapters/kiro.ts / cli/harness.ts), and kiro v2's wire
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
      warnings.push(`pricing: unknown model "${model}" (alias "${resolveAlias(model)}"); cost not computed`);
      return NaN;
    }
    // Cache-aware, per 1M: each token class billed exactly once at its own
    // rate. inputTokens is uncached-only by canonical convention, so fresh
    // input is never double-billed against cache reads/writes.
    return (
      ((rec.inputTokens ?? 0) * p.input +
        (rec.cacheReadTokens ?? 0) * p.cache_read +
        (rec.cacheWriteTokens ?? 0) * p.cache_creation +
        (rec.outputTokens ?? 0) * p.output) /
      1_000_000
    );
  },
    resolveAlias,
    drainWarnings(): string[] {
      const out = warnings.splice(0, warnings.length);
      return out;
    },
  };
}
