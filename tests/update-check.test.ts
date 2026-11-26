import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import type { AddressInfo } from "node:net";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";

import { VERSION } from "../src/version.ts";
import { autoUpdateNotice, compareVersions, fetchLatestRelease } from "../src/cli/update-check.ts";

const CLI = new URL("../src/cli/ach.ts", import.meta.url).pathname;

interface RunOut { code: number; stdout: string; stderr: string }

/** Async spawn: the stub server lives in this process, so spawnSync would deadlock. */
function runCli(args: string[], env: Record<string, string>): Promise<RunOut> {
  const isBun = (process.versions as { bun?: string }).bun !== undefined;
  const base = { ...process.env };
  delete base.AGENTIC_CODING_HARNESS_UPDATE_CHECK;
  delete base.AGENTIC_CODING_HARNESS_UPDATE_FEED_URL;
  return new Promise((resolve) => {
    const p = spawn(process.execPath, isBun ? [CLI, ...args] : ["--import", "tsx", CLI, ...args], {
      env: { ...base, ...env },
    });
    let stdout = "";
    let stderr = "";
    p.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    p.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    p.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

let server: http.Server;
let base = "";
let hits = 0;
let body = JSON.stringify({ tag_name: "v999.0.0", html_url: "https://example.test/releases/v999.0.0" });
let hang = false;

before(async () => {
  server = http.createServer((_req, res) => {
    hits++;
    if (hang) return; // never answer
    res.setHeader("content-type", "application/json");
    res.end(body);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/releases/latest`;
});
after(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
});

async function freshState(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "ach-update-"));
}

describe("compareVersions", () => {
  test("semver precedence", () => {
    assert.equal(compareVersions("1.2.3", "1.2.3"), 0);
    assert.equal(compareVersions("v1.2.4", "1.2.3"), 1);
    assert.equal(compareVersions("0.9.0", "0.10.0"), -1);
    assert.equal(compareVersions("1.0.0", "1.0.0-rc.1"), 1);
    assert.equal(compareVersions("1.0.0-rc.2", "1.0.0-rc.10"), -1);
    assert.equal(compareVersions("nope", "1.0.0"), null);
  });
});

describe("ach update --check (explicit)", () => {
  test("newer release: prints version and URL, exit 0, writes only the cache file", async () => {
    hang = false;
    body = JSON.stringify({ tag_name: "v999.0.0", html_url: "https://example.test/releases/v999.0.0" });
    const state = await freshState();
    const r = await runCli(["update", "--check"], { AGENTIC_CODING_HARNESS_STATE_DIR: state, AGENTIC_CODING_HARNESS_UPDATE_FEED_URL: base });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /new version 999\.0\.0 available: https:\/\/example\.test\/releases\/v999\.0\.0/);
    assert.deepEqual(await fs.readdir(state), ["update-check.json"]);
    const cache = JSON.parse(await fs.readFile(path.join(state, "update-check.json"), "utf8"));
    assert.equal(cache.latest, "999.0.0");
    assert.equal(typeof cache.checkedAt, "number");
  });

  test("up to date: prints 'up to date'", async () => {
    body = JSON.stringify({ tag_name: `v${VERSION}`, html_url: "https://example.test/r" });
    const r = await runCli(["update", "--check"], { AGENTIC_CODING_HARNESS_STATE_DIR: await freshState(), AGENTIC_CODING_HARNESS_UPDATE_FEED_URL: base });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /up to date/);
  });

  test("--json is machine readable", async () => {
    body = JSON.stringify({ tag_name: "v999.0.0", html_url: "https://example.test/r" });
    const r = await runCli(["update", "--check", "--json"], { AGENTIC_CODING_HARNESS_STATE_DIR: await freshState(), AGENTIC_CODING_HARNESS_UPDATE_FEED_URL: base });
    assert.equal(r.code, 0, r.stderr);
    const j = JSON.parse(r.stdout);
    assert.equal(j.current, VERSION);
    assert.equal(j.latest, "999.0.0");
    assert.equal(j.url, "https://example.test/r");
    assert.equal(j.updateAvailable, true);
  });

  test("explicit always hits the network, even with a fresh cache", async () => {
    const state = await freshState();
    const env = { AGENTIC_CODING_HARNESS_STATE_DIR: state, AGENTIC_CODING_HARNESS_UPDATE_FEED_URL: base };
    await runCli(["update", "--check"], env);
    const before = hits;
    await runCli(["update", "--check"], env);
    assert.equal(hits - before, 1);
  });

  test("unreachable feed: clear failure on stderr, non-zero, no cache written", async () => {
    const state = await freshState();
    const dead = await new Promise<string>((resolve) => {
      const s = http.createServer().listen(0, "127.0.0.1", () => {
        const port = (s.address() as AddressInfo).port;
        s.close(() => resolve(`http://127.0.0.1:${port}/x`));
      });
    });
    const r = await runCli(["update", "--check"], { AGENTIC_CODING_HARNESS_STATE_DIR: state, AGENTIC_CODING_HARNESS_UPDATE_FEED_URL: dead });
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /update check failed: could not reach the release feed/);
    assert.equal(r.stdout, "");
    assert.deepEqual(await fs.readdir(state), []);
  });

  test("--offline refuses a non-loopback feed with the guard's error", async () => {
    const r = await runCli(["update", "--check", "--offline"], {
      AGENTIC_CODING_HARNESS_STATE_DIR: await freshState(),
      AGENTIC_CODING_HARNESS_UPDATE_FEED_URL: "http://example.invalid/releases/latest",
    });
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /OfflineViolation/);
  });

  test("--offline still allows a loopback feed", async () => {
    body = JSON.stringify({ tag_name: "v999.0.0", html_url: "https://example.test/r" });
    const r = await runCli(["update", "--check", "--offline"], { AGENTIC_CODING_HARNESS_STATE_DIR: await freshState(), AGENTIC_CODING_HARNESS_UPDATE_FEED_URL: base });
    assert.equal(r.code, 0, r.stderr);
  });

  test("help states it never installs; no --check shows usage and exits non-zero", async () => {
    const h = await runCli(["update", "--help"], {});
    assert.equal(h.code, 0);
    assert.match(h.stdout, /NEVER downloads, installs, replaces/);
    const n = await runCli(["update"], {});
    assert.equal(n.code, 1);
    assert.match(n.stderr, /ach update --check/);
  });
});

describe("automatic check (env opt-in)", () => {
  test("enabled: one request, one stderr line, second invocation within 24h makes 0 requests", async () => {
    hang = false;
    body = JSON.stringify({ tag_name: "v999.0.0", html_url: "https://example.test/r" });
    const state = await freshState();
    const env = { AGENTIC_CODING_HARNESS_STATE_DIR: state, AGENTIC_CODING_HARNESS_UPDATE_FEED_URL: base, AGENTIC_CODING_HARNESS_UPDATE_CHECK: "1" };
    const h0 = hits;
    const a = await runCli(["agents", "--json"], env);
    assert.equal(a.code, 0, a.stderr);
    assert.equal(hits - h0, 1);
    assert.match(a.stderr, /new version 999\.0\.0 available: https:\/\/example\.test\/r/);
    assert.equal(a.stderr.trim().split("\n").length, 1);
    JSON.parse(a.stdout); // stdout stays clean JSON
    const h1 = hits;
    const b = await runCli(["agents", "--json"], env);
    assert.equal(hits - h1, 0);
    assert.equal(b.stderr, "");
  });

  test("a stale cache (over 24h) triggers a new request", async () => {
    const state = await freshState();
    await fs.writeFile(path.join(state, "update-check.json"), JSON.stringify({ checkedAt: Date.now() - 25 * 3600_000 }));
    const h0 = hits;
    await runCli(["agents", "--json"], { AGENTIC_CODING_HARNESS_STATE_DIR: state, AGENTIC_CODING_HARNESS_UPDATE_FEED_URL: base, AGENTIC_CODING_HARNESS_UPDATE_CHECK: "1" });
    assert.equal(hits - h0, 1);
  });

  test("failures are silent and still stamp the cache", async () => {
    const state = await freshState();
    const prev = process.env.AGENTIC_CODING_HARNESS_STATE_DIR;
    process.env.AGENTIC_CODING_HARNESS_STATE_DIR = state;
    try {
      const line = await autoUpdateNotice(VERSION, {
        env: { AGENTIC_CODING_HARNESS_UPDATE_CHECK: "1" },
        url: "http://127.0.0.1:1/none",
        timeoutMs: 500,
      });
      assert.equal(line, null);
      const cache = JSON.parse(await fs.readFile(path.join(state, "update-check.json"), "utf8"));
      assert.equal(typeof cache.checkedAt, "number");
      assert.equal(cache.latest, undefined);
    } finally {
      if (prev === undefined) delete process.env.AGENTIC_CODING_HARNESS_STATE_DIR;
      else process.env.AGENTIC_CODING_HARNESS_STATE_DIR = prev;
    }
  });

  test("a hanging feed is cut off by the timeout", async () => {
    hang = true;
    try {
      const t0 = Date.now();
      await assert.rejects(fetchLatestRelease(base, VERSION, 300), /timed out after 300 ms/);
      assert.ok(Date.now() - t0 < 3000);
    } finally {
      hang = false;
    }
  });

  test("not run for `update`, --version or help even when enabled", async () => {
    const env = { AGENTIC_CODING_HARNESS_STATE_DIR: await freshState(), AGENTIC_CODING_HARNESS_UPDATE_FEED_URL: base, AGENTIC_CODING_HARNESS_UPDATE_CHECK: "1" };
    const h0 = hits;
    await runCli(["--version"], env);
    await runCli(["--help"], env);
    await runCli(["agents", "--help"], env);
    await runCli(["update"], env);
    assert.equal(hits - h0, 0);
  });
});

describe("default configuration: zero network calls", () => {
  test("smoke set with the feed pointed at the counting stub", async () => {
    const state = await freshState();
    const env = { AGENTIC_CODING_HARNESS_STATE_DIR: state, AGENTIC_CODING_HARNESS_UPDATE_FEED_URL: base };
    const h0 = hits;
    for (const args of [["--version"], ["--help"], ["agents"], ["agents", "--json"], ["stats", "--json"], ["config", "--show"], ["gc", "--dry-run"]]) {
      await runCli(args, env);
    }
    assert.equal(hits - h0, 0);
    assert.deepEqual(await fs.readdir(state).then((f) => f.filter((x) => x === "update-check.json")), []);
  });

  test("env set to 0 or empty also stays off", async () => {
    const state = await freshState();
    const h0 = hits;
    for (const v of ["0", ""]) {
      await runCli(["agents"], { AGENTIC_CODING_HARNESS_STATE_DIR: state, AGENTIC_CODING_HARNESS_UPDATE_FEED_URL: base, AGENTIC_CODING_HARNESS_UPDATE_CHECK: v });
    }
    assert.equal(hits - h0, 0);
  });
});
