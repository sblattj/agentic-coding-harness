import { readFileSync } from 'node:fs';
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
// prices for the newer entries, all subject to override by an external map.
// cache_creation for Claude is the 5m-TTL blended default (1.25x base).
const FALLBACK_PRICES: Record<string, ModelPrice> = {
  'claude-sonnet-4': { input: 3, output: 15, cache_read: 0.3, cache_creation: 3.75 },
  'claude-haiku-4-5': { input: 1, output: 5, cache_read: 0.1, cache_creation: 1.25 },
  'claude-opus-4': { input: 15, output: 75, cache_read: 1.5, cache_creation: 18.75 },
  'claude-fable-5-1': { input: 5, output: 25, cache_read: 0.5, cache_creation: 6.25 },
  'gpt-5': { input: 1.25, output: 10, cache_read: 0.125, cache_creation: 0 },
  'gemini-2.5-pro': { input: 1.25, output: 10, cache_read: 0.31, cache_creation: 0 },
  'gemini-3-pro': { input: 2, output: 12, cache_read: 0.5, cache_creation: 0 },
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

export function createPricer(costMapPath?: string): Pricer {
  let prices = { ...FALLBACK_PRICES };
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
    const model = rec.model;
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
