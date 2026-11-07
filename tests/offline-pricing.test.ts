// Offline pricing guarantee (#40): snapshot stamp + stats `pricing` block,
// staleness notice, the `--offline` fetch guard, and the throw-on-network test
// preload. This file imports the preload FIRST, so every test below runs with
// the network primitives replaced by throwing stubs.
import "./support/no-network.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

import {
  DEFAULT_PRICING_STALE_DAYS,
  PRICING_STALE_DAYS_ENV,
  createPricer,
  pricingMeta,
  pricingStaleNotice,
  resolveStaleDays,
} from "../src/core/pricing.ts";
import {
  OfflineViolation,
  assertOfflineSource,
  installOfflineGuard,
  isLoopbackUrl,
  offlineGuardInstalled,
  uninstallOfflineGuard,
} from "../src/core/offline.ts";

const CLI = new URL("../src/cli/ach.ts", import.meta.url).pathname;
const DATA = JSON.parse(readFileSync(new URL("../src/core/pricing-data.json", import.meta.url), "utf8")) as Record<string, unknown>;

function runCli(args: string[], env: Record<string, string> = {}) {
  const state = mkdtempSync(join(tmpdir(), "ach-offline-"));
  const p = spawnSync(process.execPath, ["--import", "tsx", CLI, ...args], {
    env: { ...process.env, AGENTIC_CODING_HARNESS_STATE_DIR: state, HOME: state, AGENTIC_CODING_HARNESS_TZ: "utc", ...env },
    encoding: "utf8",
  });
  return { code: p.status ?? -1, stdout: p.stdout ?? "", stderr: p.stderr ?? "" };
}

const DAY = 86_400_000;
const SNAP_MS = Date.parse(`${DATA.snapshotDate as string}T00:00:00Z`);

describe("snapshot stamp and stats pricing block (#40)", () => {
  it("pricing-data.json carries snapshotDate and sourceUrl", () => {
    assert.match(DATA.snapshotDate as string, /^\d{4}-\d{2}-\d{2}$/);
    assert.match(DATA.sourceUrl as string, /^https:\/\/.*litellm/i);
  });

  it("pricingMeta surfaces them with the model count (non-model keys excluded)", () => {
    const m = pricingMeta({ now: SNAP_MS + 5 * DAY, env: {} });
    assert.equal(m.snapshotDate, DATA.snapshotDate);
    assert.equal(m.sourceUrl, DATA.sourceUrl);
    assert.equal(m.modelCount, Object.keys(DATA).length - 2);
    assert.equal(m.ageDays, 5);
    assert.equal(m.stale, false);
    assert.equal(m.source, "bundled");
  });

  it("ach stats --json emits the pricing block", () => {
    const r = runCli(["stats", "--json", "--state-only"]);
    assert.equal(r.code, 0, r.stderr);
    const j = JSON.parse(r.stdout) as { pricing: Record<string, unknown> };
    assert.equal(j.pricing.snapshotDate, DATA.snapshotDate);
    assert.equal(j.pricing.sourceUrl, DATA.sourceUrl);
    assert.equal(j.pricing.source, "bundled");
    assert.equal(typeof j.pricing.modelCount, "number");
    assert.equal(typeof j.pricing.ageDays, "number");
  });
});

describe("staleness notice (#40)", () => {
  const now = SNAP_MS + 181 * DAY;
  it("older than the default 180 days: one-line notice", () => {
    const n = pricingStaleNotice(pricingMeta({ now, env: {} }));
    assert.ok(n !== null);
    assert.equal(n.split("\n").length, 1);
    assert.match(n, /181 days old/);
  });
  it("env override is honored (365 days: fresh)", () => {
    assert.equal(resolveStaleDays({ [PRICING_STALE_DAYS_ENV]: "365" }), 365);
    assert.equal(pricingStaleNotice(pricingMeta({ now, env: { [PRICING_STALE_DAYS_ENV]: "365" } })), null);
    const tight = pricingMeta({ now: SNAP_MS + 11 * DAY, env: { [PRICING_STALE_DAYS_ENV]: "10" } });
    assert.equal(tight.stale, true);
  });
  it("0 silences it; junk falls back to the default", () => {
    const m = pricingMeta({ now: SNAP_MS + 4000 * DAY, env: { [PRICING_STALE_DAYS_ENV]: "0" } });
    assert.equal(m.stale, false);
    assert.equal(pricingStaleNotice(m), null);
    assert.equal(resolveStaleDays({ [PRICING_STALE_DAYS_ENV]: "abc" }), DEFAULT_PRICING_STALE_DAYS);
  });
  it("ach stats prints the notice on stderr only, honoring the env", () => {
    const loud = runCli(["stats", "--json", "--state-only"], { [PRICING_STALE_DAYS_ENV]: "1" });
    assert.match(loud.stderr, /\[notice\] pricing snapshot is \d+ days old/);
    JSON.parse(loud.stdout); // stdout stays pure JSON
    const quiet = runCli(["stats", "--json", "--state-only"], { [PRICING_STALE_DAYS_ENV]: "0" });
    assert.doesNotMatch(quiet.stderr, /\[notice\]/);
  });
});

describe("snapshot refresh script (#40)", () => {
  it("stamps only the snapshotDate line", () => {
    const f = join(mkdtempSync(join(tmpdir(), "ach-stamp-")), "p.json");
    const orig = readFileSync(new URL("../src/core/pricing-data.json", import.meta.url), "utf8");
    writeFileSync(f, orig);
    const script = new URL("../scripts/stamp-pricing-snapshot.mjs", import.meta.url).pathname;
    const r = spawnSync(process.execPath, [script, "2031-02-03", "--file", f], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(readFileSync(f, "utf8"), orig.replace(/"snapshotDate": "[^"]*"/, '"snapshotDate": "2031-02-03"'));
    const bad = spawnSync(process.execPath, [script, "nope", "--file", f], { encoding: "utf8" });
    assert.equal(bad.status, 2);
  });
});

describe("pricing sources (#40)", () => {
  const flagships = ["claude-sonnet-4", "gpt-5", "gemini-2.5-pro"];

  it("bundled: the default pricer reports source bundled", () => {
    const p = createPricer();
    assert.equal(p.meta?.().source, "bundled");
    assert.equal(p.sourceOf?.("claude-3-haiku"), "bundled");
  });

  it("embedded-fallback: a model only the embedded table knows says so", () => {
    assert.equal(createPricer().sourceOf?.("null"), "embedded-fallback");
  });

  it("embedded-fallback: an empty or corrupt bundled extract leaves the flagships priced", () => {
    for (const bundled of [{}, "garbage", { snapshotDate: "2026-01-01" }]) {
      const p = createPricer(undefined, { bundled });
      assert.equal(p.meta?.().source, "embedded-fallback");
      assert.equal(p.meta?.().modelCount, 0);
      for (const model of flagships) {
        const cost = p.price({ agent: "test", model, inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, timestamp: 0 });
        assert.ok(Number.isFinite(cost) && cost > 0, `${model} priced from the embedded table`);
        assert.equal(p.sourceOf?.(model), "embedded-fallback");
      }
      // claude-3-haiku prices ONLY through the extract, so it is unpriced here.
      assert.equal(p.sourceOf?.("claude-3-haiku"), null);
    }
  });

  it("cost-map: a user map (even one carrying snapshot stamps) wins and is reported", () => {
    const f = join(mkdtempSync(join(tmpdir(), "ach-costmap-")), "map.json");
    writeFileSync(f, JSON.stringify({ snapshotDate: "2020-01-01", sourceUrl: "x", "my-model": { input: 1, output: 2, cache_read: 0.1, cache_creation: 1 } }));
    const p = createPricer(f);
    assert.equal(p.meta?.().source, "cost-map");
    assert.equal(p.sourceOf?.("my-model"), "cost-map");
    assert.deepEqual(p.drainWarnings(), []);
  });
});

describe("--offline guard (#40)", () => {
  afterEach(() => uninstallOfflineGuard());

  it("a deliberately injected fetch trips a loud, named OfflineViolation with the URL", async () => {
    installOfflineGuard();
    assert.ok(offlineGuardInstalled());
    await assert.rejects(fetch("https://example.com/prices.json"), (e: unknown) => {
      assert.ok(e instanceof OfflineViolation);
      assert.equal((e as OfflineViolation).name, "OfflineViolation");
      assert.equal((e as OfflineViolation).url, "https://example.com/prices.json");
      assert.match((e as Error).message, /--offline refused a network call via fetch/);
      return true;
    });
  });

  it("covers node:http / node:https request and get", () => {
    installOfflineGuard();
    assert.throws(() => https.get("https://example.com/x"), OfflineViolation);
    assert.throws(() => http.request({ hostname: "example.com", port: 80, path: "/" }), OfflineViolation);
    assert.throws(() => http.get("http://example.com/"), OfflineViolation);
  });

  it("loopback is allowed through the guard (it then meets the test preload, not OfflineViolation)", async () => {
    installOfflineGuard();
    await assert.rejects(fetch("http://127.0.0.1:1/x"), (e: unknown) => {
      assert.ok(!(e instanceof OfflineViolation));
      assert.equal((e as Error).name, "NetworkBlocked");
      return true;
    });
    assert.ok(isLoopbackUrl("http://localhost:8399/") && isLoopbackUrl("http://[::1]:1/"));
    assert.ok(!isLoopbackUrl("https://example.com") && !isLoopbackUrl("not a url"));
  });

  it("uninstall restores the previous fetch", async () => {
    const before = globalThis.fetch;
    installOfflineGuard();
    assert.notEqual(globalThis.fetch, before);
    uninstallOfflineGuard();
    assert.equal(globalThis.fetch, before);
  });

  it("assertOfflineSource refuses a remote feed, accepts loopback", () => {
    assert.throws(() => assertOfflineSource("https://runs.example.com/feed"), OfflineViolation);
    assert.doesNotThrow(() => assertOfflineSource("http://127.0.0.1:8398"));
  });

  it("ach web --offline --source https://... refuses before serving", () => {
    const r = runCli(["web", "--offline", "--no-open", "--port", "0", "--source", "https://runs.example.com/feed"]);
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /OfflineViolation/);
    assert.match(r.stderr, /runs\.example\.com/);
  });

  it("stats / watch / dash accept --offline", () => {
    assert.equal(runCli(["stats", "--offline", "--json", "--state-only"]).code, 0);
    assert.equal(runCli(["dash", "--offline", "--json", "--state-only"]).code, 0);
    assert.match(runCli(["stats", "--help"]).stdout, /--offline/);
    assert.match(runCli(["watch", "--help"]).stdout, /--offline/);
  });
});

describe("test preload throws on network (#40 guarantee)", () => {
  it("fetch throws NetworkBlocked", async () => {
    await assert.rejects(fetch("https://example.com"), { name: "NetworkBlocked" });
  });
  it("http/https/tcp connect throw, IPC connect does not", () => {
    assert.throws(() => http.get("http://127.0.0.1:1/"), { name: "NetworkBlocked" });
    assert.throws(() => https.request("https://example.com"), { name: "NetworkBlocked" });
    assert.throws(() => net.connect(80, "example.com"), { name: "NetworkBlocked" });
    const s = net.connect("/nonexistent/ach.sock");
    s.on("error", () => {});
    s.destroy();
  });
  it("a spawned child inherits the guard (this is how `ach stats` subprocesses are covered)", () => {
    const p = spawnSync(process.execPath, ["-e", "fetch('https://example.com').catch((e) => console.log(e.name))"], { env: process.env, encoding: "utf8" });
    assert.equal(p.stdout.trim(), "NetworkBlocked");
  });
});
