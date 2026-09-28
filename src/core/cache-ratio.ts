// Prompt-cache hit ratio (#69).
//
// Definition, on CANONICAL records (inputTokens is uncached-only for every
// provider — normalize.ts subtracts OpenAI/Gemini cached input before it gets
// here):
//
//   cacheHitRatio = cacheRead / (input + cacheRead + cacheWrite)
//
// i.e. the share of all prompt tokens that were served from the cache. A cache
// WRITE is prompt the provider had to process uncached (Anthropic
// cache_creation_input_tokens), so it counts as a miss; for OpenAI/Gemini
// cacheWrite is 0 and the ratio equals the provider's own cached/prompt.
//
// Returns null (rendered "n/a") when there are no prompt tokens at all, so a
// zero-input run never yields NaN. A provider without caching support reports
// cacheRead=0 and gets a real 0, not n/a.

export interface CacheTokens {
  inputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

const finite = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);

export function cacheHitRatio(t: CacheTokens): number | null {
  const read = finite(t.cacheReadTokens);
  const denom = finite(t.inputTokens) + read + finite(t.cacheWriteTokens);
  if (denom <= 0) return null;
  return read / denom;
}

/** "42.0%" or "n/a". */
export function fmtCacheHit(ratio: number | null | undefined): string {
  return ratio === null || ratio === undefined || !Number.isFinite(ratio) ? "n/a" : `${(ratio * 100).toFixed(1)}%`;
}
