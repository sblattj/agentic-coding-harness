// #83: prompt-cache TTL with honesty tiers (est | reported | measured), the
// stats JSON cache panel, and the web run view's TTL rendering.
import "./support/no-network.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createContext, runInContext } from "node:vm";
import { after, before, describe, it } from "node:test";

import {
  ANTHROPIC_TTL_1H_MS,
  ANTHROPIC_TTL_5M_MS,
  CACHE_TTL_TIERS,
  DEFAULT_CACHE_TTL_MS,
  cachePanel,
  cachePanelsBySession,
  deriveCacheTtl,
  fmtCacheTtl,
  observedCacheGaps,
  type CacheSample,
  type CacheTtl,
} from "../src/core/cache-ttl.ts";
import { deriveRunObservability } from "../src/web/derive.ts";
import type { AgentEvent } from "../src/core/types.ts";

const T0 = Date.parse("2026-09-01T10:00:00.000Z");
const MIN = 60_000;

const sample = (over: Partial<CacheSample>): CacheSample => ({
  ts: T0,
  agent: "claude",
  sessionId: "s-1",
  model: "claude-sonnet-4-5",
  inputTokens: 10,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  ...over,
});

const usageEvent = (tMs: number, over: Record<string, unknown>): AgentEvent =>
  ({
    type: "usage",
    timestamp: tMs,
    usage: { agent: "claude", model: "claude-sonnet-4-5", inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, ...over },
  }) as AgentEvent;

describe("cache TTL constant and est tier (#83)", () => {
  it("the default estimate is 5 minutes, in one exported constant", () => {
    assert.equal(DEFAULT_CACHE_TTL_MS, 5 * 60_000);
    const src = fs.readFileSync(new URL("../src/core/cache-ttl.ts", import.meta.url), "utf8");
    // Defined exactly once, and documented (a doc comment directly above it).
    assert.equal(src.match(/export const DEFAULT_CACHE_TTL_MS\b/g)?.length, 1);
    assert.match(src, /\*\/\nexport const DEFAULT_CACHE_TTL_MS = 5 \* 60_000;/);
    // No other source file hard-codes its own estimate.
    const docs = fs.readFileSync(new URL("../docs/CACHE-TTL.md", import.meta.url), "utf8");
    assert.match(docs, /DEFAULT_CACHE_TTL_MS/);
  });

  it("cache tokens with nothing better known yield est at the default value", () => {
    const ttl = deriveCacheTtl([sample({ cacheReadTokens: 500 })]);
    assert.deepEqual(ttl, { tier: "est", value: DEFAULT_CACHE_TTL_MS });
    assert.equal(fmtCacheTtl(ttl), "5m est");
  });

  it("no cache tokens at all yields null (n/a), never an estimate", () => {
    assert.equal(deriveCacheTtl([sample({})]), null);
    assert.equal(deriveCacheTtl([]), null);
    assert.equal(fmtCacheTtl(null), "n/a");
  });

  it("the tier enum is est|reported|measured only", () => {
    assert.deepEqual([...CACHE_TTL_TIERS], ["est", "reported", "measured"]);
  });
});

describe("reported tier (#83)", () => {
  it("a synthetic adapter event with a vendor TTL renders as reported", () => {
    const obs = deriveRunObservability([
      usageEvent(T0, { cacheWriteTokens: 900, extra: { cacheTtlMs: 10 * MIN } }),
      usageEvent(T0 + 2 * MIN, { cacheReadTokens: 900 }),
    ]);
    assert.deepEqual(obs.cache?.ttl, { tier: "reported", value: 10 * MIN });
    assert.equal(fmtCacheTtl(obs.cache?.ttl), "10m reported");
  });

  it("a vendor expiry timestamp becomes a reported TTL relative to the event", () => {
    const at = new Date(T0 + 7 * MIN).toISOString();
    assert.deepEqual(deriveCacheTtl([sample({ cacheWriteTokens: 100, extra: { cacheExpiresAt: at } })]), { tier: "reported", value: 7 * MIN });
  });

  it("Anthropic's cache_creation split reports 1h for an all-1h write and 5m when any 5m slice exists", () => {
    assert.deepEqual(deriveCacheTtl([sample({ cacheWriteTokens: 400, cacheWrite1hTokens: 400 })]), { tier: "reported", value: ANTHROPIC_TTL_1H_MS });
    assert.deepEqual(deriveCacheTtl([sample({ cacheWriteTokens: 400, cacheWrite1hTokens: 0 })]), { tier: "reported", value: ANTHROPIC_TTL_5M_MS });
    assert.deepEqual(deriveCacheTtl([sample({ cacheWriteTokens: 400, cacheWrite1hTokens: 100 })]), { tier: "reported", value: ANTHROPIC_TTL_5M_MS });
    // No split reported: nothing vendor-backed, so the estimate stands.
    assert.deepEqual(deriveCacheTtl([sample({ cacheWriteTokens: 400 })])?.tier, "est");
  });

  it("reported wins over a measurement on the same records", () => {
    const ttl = deriveCacheTtl([
      sample({ ts: T0, cacheWriteTokens: 100, extra: { cacheTtlMs: 60 * MIN } }),
      sample({ ts: T0 + 3 * MIN, cacheReadTokens: 100 }),
    ]);
    assert.equal(ttl?.tier, "reported");
  });
});

describe("measured tier: observed creation-to-read gap (#83)", () => {
  it("creation then read 3m apart on a matching prefix yields measured ~3m", () => {
    const rows = [
      sample({ ts: T0, cacheWriteTokens: 2_000, extra: { cachePrefix: "p-a" } }),
      sample({ ts: T0 + 3 * MIN, cacheReadTokens: 2_000, extra: { cachePrefix: "p-a" } }),
    ];
    assert.deepEqual(observedCacheGaps(rows), [3 * MIN]);
    assert.deepEqual(deriveCacheTtl(rows), { tier: "measured", value: 3 * MIN, samples: 1 });
    assert.equal(fmtCacheTtl(deriveCacheTtl(rows)), "3m measured");
  });

  it("a non-matching prefix yields no measurement (null), never a false one", () => {
    const rows = [
      sample({ ts: T0, cacheWriteTokens: 2_000, extra: { cachePrefix: "p-a" } }),
      sample({ ts: T0 + 3 * MIN, cacheReadTokens: 2_000, extra: { cachePrefix: "p-b" } }),
    ];
    assert.deepEqual(observedCacheGaps(rows), []);
    assert.notEqual(deriveCacheTtl(rows)?.tier, "measured");
  });

  it("without an explicit prefix, different sessions or models never pair; an unknown session never pairs", () => {
    const otherSession = [sample({ ts: T0, cacheWriteTokens: 50 }), sample({ ts: T0 + 3 * MIN, sessionId: "s-2", cacheReadTokens: 50 })];
    assert.deepEqual(observedCacheGaps(otherSession), []);
    const otherModel = [sample({ ts: T0, cacheWriteTokens: 50 }), sample({ ts: T0 + 3 * MIN, model: "gpt-5", cacheReadTokens: 50 })];
    assert.deepEqual(observedCacheGaps(otherModel), []);
    const unknown = [sample({ ts: T0, sessionId: "unknown", cacheWriteTokens: 50 }), sample({ ts: T0 + 3 * MIN, sessionId: "unknown", cacheReadTokens: 50 })];
    assert.deepEqual(observedCacheGaps(unknown), []);
    // Same session and model: the conversation is the prefix.
    const same = [sample({ ts: T0, cacheWriteTokens: 50 }), sample({ ts: T0 + 3 * MIN, cacheReadTokens: 50 })];
    assert.deepEqual(observedCacheGaps(same), [3 * MIN]);
  });

  it("a miss re-arms at the newer write; equal timestamps and untimed rows never measure", () => {
    const rows = [
      sample({ ts: T0, cacheWriteTokens: 50 }),
      sample({ ts: T0 + 9 * MIN, cacheWriteTokens: 50 }), // expired: re-created, no read
      sample({ ts: T0 + 11 * MIN, cacheReadTokens: 50 }),
    ];
    assert.deepEqual(observedCacheGaps(rows), [2 * MIN]);
    assert.deepEqual(observedCacheGaps([sample({ ts: T0, cacheWriteTokens: 5, cacheReadTokens: 5 }), sample({ ts: T0, cacheReadTokens: 5 })]), []);
    assert.deepEqual(observedCacheGaps([sample({ ts: null, cacheWriteTokens: 5 }), sample({ ts: null, cacheReadTokens: 5 })]), []);
  });

  it("the web run view measures within a run and labels it", () => {
    const obs = deriveRunObservability([
      usageEvent(T0, { cacheWriteTokens: 1_000 }),
      usageEvent(T0 + 3 * MIN, { cacheReadTokens: 1_000, cacheWriteTokens: 20 }),
    ]);
    assert.deepEqual(obs.cache, { cacheRead: 1_000, cacheCreation: 1_020, input: 20, ttl: { tier: "measured", value: 3 * MIN, samples: 1 } });
  });
});

describe("cache panel shape (#83)", () => {
  it("carries cacheRead, cacheCreation, input and ttl", () => {
    const p = cachePanel([sample({ inputTokens: 7, cacheReadTokens: 30, cacheWriteTokens: 5 })]);
    assert.deepEqual(Object.keys(p).sort(), ["cacheCreation", "cacheRead", "input", "ttl"]);
    assert.deepEqual(p, { cacheRead: 30, cacheCreation: 5, input: 7, ttl: { tier: "est", value: DEFAULT_CACHE_TTL_MS } });
  });

  it("per-session panels skip sessions with no cache tokens", () => {
    const panels = cachePanelsBySession([sample({ cacheReadTokens: 3 }), sample({ sessionId: "s-cold" })]);
    assert.deepEqual(panels.map((p) => p.sessionId), ["s-1"]);
  });

  it("fmtCacheTtl prints the tier next to every value", () => {
    const all: CacheTtl[] = [
      { tier: "est", value: DEFAULT_CACHE_TTL_MS },
      { tier: "reported", value: ANTHROPIC_TTL_1H_MS },
      { tier: "measured", value: 90_000, samples: 2 },
    ];
    assert.deepEqual(all.map(fmtCacheTtl), ["5m est", "1h reported", "1.5m measured"]);
    for (const t of all) assert.match(fmtCacheTtl(t), /\s(est|reported|measured)$/);
  });
});

describe("web run view TTL rendering (index.html)", () => {
  const html = fs.readFileSync(new URL("../src/web/index.html", import.meta.url), "utf8");
  const block = /\/\* cachettl:begin \*\/([\s\S]*?)\/\* cachettl:end \*\//.exec(html);
  const ctx = createContext({});

  it("embeds the TTL helper and renders it in the run meta strip", () => {
    assert.ok(block, "index.html must carry the cachettl block");
    runInContext(block![1], ctx);
    assert.match(html, /kv\("cache ttl", ttl\.text\)/);
  });

  it("shows the tier label next to every TTL value and never a bare number", () => {
    const text = (p: unknown) => (ctx.cacheTtlText as (p: unknown) => { text: string }).call(null, p).text;
    assert.equal(text({ ttl: { tier: "est", value: DEFAULT_CACHE_TTL_MS } }), "5m est");
    assert.equal(text({ ttl: { tier: "reported", value: ANTHROPIC_TTL_1H_MS } }), "1h reported");
    assert.equal(text({ ttl: { tier: "measured", value: 3 * MIN, samples: 1 } }), "3m measured");
    // Missing, unknown-tier or tierless values: n/a, not a number.
    for (const p of [undefined, null, {}, { ttl: null }, { ttl: { value: 300000 } }, { ttl: { tier: "guess", value: 300000 } }, { ttl: 300000 }]) {
      assert.equal(text(p), "n/a", JSON.stringify(p));
    }
  });
});

// ---------------------------------------------------------------------------
// ach stats --json / text (subprocess)
// ---------------------------------------------------------------------------

const CLI = new URL("../src/cli/ach.ts", import.meta.url).pathname;

function runCli(args: string[], env: Record<string, string>): { code: number; stdout: string; stderr: string } {
  const isBun = (process.versions as { bun?: string }).bun !== undefined;
  const p = spawnSync(process.execPath, isBun ? [CLI, ...args] : ["--import", "tsx", CLI, ...args], {
    env: { ...process.env, AGENTIC_CODING_HARNESS_PROJECT_ALIASES: "", AGENTIC_CODING_HARNESS_TZ: "UTC", ...env },
    encoding: "utf8",
  });
  return { code: p.status ?? -1, stdout: p.stdout ?? "", stderr: p.stderr ?? "" };
}

describe("ach stats cache panel (CLI, #83)", () => {
  let stateDir: string;
  let home: string;
  const base = Date.now() - 86_400_000;
  const at = (ms: number) => new Date(base + ms).toISOString();
  const row = (over: Record<string, unknown>) =>
    JSON.stringify({ agent: "claude", model: "claude-sonnet-4-5", inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, ...over });

  before(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "ach-ttl-state-"));
    home = fs.mkdtempSync(path.join(os.tmpdir(), "ach-ttl-home-"));
    fs.mkdirSync(path.join(stateDir, "raw", "claude"), { recursive: true });
    fs.mkdirSync(path.join(stateDir, "runs"), { recursive: true });
    fs.writeFileSync(
      path.join(stateDir, "raw", "claude", "s-warm.jsonl"),
      [
        row({ ts: at(0), sessionId: "s-warm", cacheWriteTokens: 4_000 }),
        row({ ts: at(3 * MIN), sessionId: "s-warm", cacheReadTokens: 4_000 }),
      ].join("\n") + "\n",
    );
    fs.writeFileSync(
      path.join(stateDir, "raw", "claude", "s-vendor.jsonl"),
      row({ ts: at(10 * MIN), sessionId: "s-vendor", cacheWriteTokens: 300, extra: { cacheTtlMs: 60 * MIN } }) + "\n",
    );
  });
  after(() => {
    for (const d of [stateDir, home]) fs.rmSync(d, { recursive: true, force: true });
  });
  const env = () => ({ AGENTIC_CODING_HARNESS_STATE_DIR: stateDir, HOME: home });

  it("--json carries cache {cacheRead, cacheCreation, input, ttl} overall and per session", () => {
    const res = runCli(["stats", "--json", "--state-only"], env());
    assert.equal(res.code, 0, res.stderr);
    const out = JSON.parse(res.stdout);
    assert.ok(out.cache, "stats JSON must carry a cache panel");
    assert.equal(out.cache.cacheRead, 4_000);
    assert.equal(out.cache.cacheCreation, 4_300);
    assert.equal(out.cache.input, 30);
    // A vendor TTL anywhere in the window wins overall.
    assert.deepEqual(out.cache.ttl, { tier: "reported", value: 60 * MIN });
    const by = Object.fromEntries(out.cache.bySession.map((p: { sessionId: string }) => [p.sessionId, p]));
    assert.deepEqual(by["s-warm"].ttl, { tier: "measured", value: 3 * MIN, samples: 1 });
    assert.deepEqual(by["s-vendor"].ttl, { tier: "reported", value: 60 * MIN });
    for (const p of [out.cache, ...out.cache.bySession]) {
      assert.ok(p.ttl === null || ["est", "reported", "measured"].includes(p.ttl.tier));
    }
  });

  it("text output prints the TTL with its tier", () => {
    const res = runCli(["stats", "--state-only"], env());
    assert.equal(res.code, 0, res.stderr);
    assert.match(res.stdout, /^cache {5}read=4,000 creation=4,300 input=30 ttl=1h reported sessions=2$/m);
  });
});
