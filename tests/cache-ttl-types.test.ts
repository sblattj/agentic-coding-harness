// #83: type-level honesty for the prompt-cache TTL. Each @ts-expect-error line
// below MUST fail to compile: `npm run typecheck` (tsc -p tests/tsconfig.json)
// reports an unused directive if CacheTtl ever accepts an unlabeled value or a
// tier outside est|reported|measured. The runtime assertions only keep the
// file a real test.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { DEFAULT_CACHE_TTL_MS, type CachePanel, type CacheTtl, type CacheTtlTier } from "../src/core/cache-ttl.ts";

describe("CacheTtl is a tagged union (#83, compile-level)", () => {
  it("rejects unlabeled and off-enum values at compile time", () => {
    // @ts-expect-error a bare number is an unlabeled estimate
    const bare: CacheTtl = DEFAULT_CACHE_TTL_MS;
    // @ts-expect-error an object without a tier is an unlabeled estimate
    const untagged: CacheTtl = { value: DEFAULT_CACHE_TTL_MS };
    // @ts-expect-error the tier enum is est|reported|measured only
    const offEnum: CacheTtl = { tier: "guess", value: DEFAULT_CACHE_TTL_MS };
    // @ts-expect-error "n/a" is the rendering of null, not a tier
    const naTier: CacheTtlTier = "n/a";
    // @ts-expect-error a measurement must say how many gaps it rests on
    const noSamples: CacheTtl = { tier: "measured", value: 1 };
    // @ts-expect-error the panel's ttl is CacheTtl | null, never a number
    const panel: CachePanel = { cacheRead: 0, cacheCreation: 0, input: 0, ttl: 300_000 };
    const ok: CacheTtl[] = [
      { tier: "est", value: DEFAULT_CACHE_TTL_MS },
      { tier: "reported", value: 1 },
      { tier: "measured", value: 1, samples: 1 },
    ];
    assert.equal(ok.length, 3);
    assert.ok([bare, untagged, offEnum, naTier, noSamples, panel].length === 6);
  });
});
