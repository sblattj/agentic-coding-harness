// HTTP event tap (#64): `--event-webhook` POSTs run lifecycle events.
// Every receiver is a local http server on port 0, started and closed per test.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  createEventWebhook,
  DEFAULT_WEBHOOK_FLUSH_MS,
  DEFAULT_WEBHOOK_RETRY,
  parseWebhookEvents,
  signWebhookBody,
  verifyWebhookSignature,
  WEBHOOK_EVENT_TYPES,
  WEBHOOK_SCHEMA_VERSION,
  WEBHOOK_SIGNATURE_HEADER,
  type EventWebhook,
} from "../src/core/event-webhook.ts";
import { createDriver } from "../src/core/driver.ts";
import { MASK_SINKS, resolveMaskPolicy } from "../src/core/masking.ts";
import { NullAdapter } from "../src/adapters/null.ts";
import { anonId } from "../src/core/privacy.ts";
import { listRunRecords } from "../src/core/registry.ts";
import type { AgentAdapter, AgentEvent, AgentHandle, RunResult, RunSpec } from "../src/core/types.ts";

const CLI = new URL("../src/cli/ach.ts", import.meta.url).pathname;
const DOC = new URL("../docs/EVENT-WEBHOOK.md", import.meta.url).pathname;

// ---------------------------------------------------------------- helpers

interface Hit {
  at: number;
  headers: http.IncomingHttpHeaders;
  body: string;
  json: { schemaVersion: number; runId: string; type: string; timestamp: string; payload: Record<string, unknown> };
}

interface Receiver {
  url: string;
  hits: Hit[];
  close(): Promise<void>;
}

/**
 * A local receiver on port 0. `statuses[i]` answers the i-th request (default
 * 204); `hang: true` accepts every request and never answers.
 */
async function receiver(opts: { statuses?: number[]; hang?: boolean } = {}): Promise<Receiver> {
  const hits: Hit[] = [];
  let n = 0;
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      hits.push({ at: performance.now(), headers: req.headers, body, json: JSON.parse(body) });
      if (opts.hang) return;
      const status = opts.statuses?.[n] ?? 204;
      n++;
      res.writeHead(status).end();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/hook`,
    hits,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

/** A port nothing listens on (bound then released). */
async function closedPortUrl(): Promise<string> {
  const s = http.createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const { port } = s.address() as AddressInfo;
  await new Promise<void>((r) => s.close(() => r()));
  return `http://127.0.0.1:${port}/hook`;
}

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ach-webhook-"));
}

type Scripted = { type: "step"; delayMs?: number } | { type: "usage_raw"; data: unknown; delayMs?: number };

/** Scripted adapter: steps and priced usage records, optionally paced. */
class ScriptAdapter implements AgentAdapter {
  readonly name = "mock";
  async launch(spec: RunSpec): Promise<AgentHandle> {
    const script = (spec as { script?: Scripted[] }).script ?? [];
    const sessionId = `mock-${Math.random().toString(36).slice(2, 8)}`;
    let aborted = false;
    return {
      sessionId,
      async *attach(): AsyncIterable<AgentEvent> {
        for (const e of script) {
          if (aborted) return;
          if (e.delayMs) await new Promise((r) => setTimeout(r, e.delayMs));
          yield e.type === "step"
            ? { type: "step", sessionId, timestamp: Date.now() }
            : { type: "usage_raw", agent: "mock", data: e.data, sessionId, timestamp: Date.now() };
        }
      },
      abort() {
        aborted = true;
      },
      async wait() {
        return aborted ? "aborted" : "success";
      },
    };
  }
}

// 100k input tokens of claude-sonnet-4 at $3/1M = $0.30 per record.
const usd030 = (delayMs?: number): Scripted => ({
  type: "usage_raw",
  data: { modelUsage: { "claude-sonnet-4": { model: "claude-sonnet-4", inputTokens: 100_000, outputTokens: 0 } } },
  ...(delayMs !== undefined ? { delayMs } : {}),
});

function driverWith(webhook?: EventWebhook, stateDir = tmpDir()) {
  return createDriver({
    adapters: { mock: new ScriptAdapter(), null: new NullAdapter({ turns: 20 }) },
    stateDir,
    ...(webhook !== undefined ? { webhook } : {}),
  });
}

const quiet = (lines: string[]) => (l: string) => void lines.push(l);

/** The deterministic part of a RunResult (ids and timings vary per run). */
function stable(r: RunResult) {
  return {
    exitStatus: r.exitStatus,
    totalCost: r.totalCost,
    tokens: r.tokens.map((t) => [t.inputTokens, t.outputTokens, t.model]),
    eventTypes: r.events.map((e) => e.type),
    warnings: r.warnings,
    usage: r.usage,
  };
}

async function runCliAsync(args: string[], env: Record<string, string>): Promise<{ code: number; stdout: string; stderr: string }> {
  const isBun = (process.versions as { bun?: string }).bun !== undefined;
  const child = spawn(process.execPath, isBun ? [CLI, ...args] : ["--import", "tsx", CLI, ...args], {
    env: { PATH: process.env.PATH ?? "", HOME: env.HOME ?? tmpDir(), ...env },
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => (stdout += String(d)));
  child.stderr.on("data", (d) => (stderr += String(d)));
  const code = await new Promise<number>((r) => child.once("close", (c) => r(c ?? -1)));
  return { code, stdout, stderr };
}

// ---------------------------------------------------------------- AC 1: start + exit with the envelope

describe("#64 AC1: start and exit events with the documented envelope", () => {
  it("a run with a webhook delivers start then exit, each exactly {schemaVersion, runId, type, timestamp, payload}", async () => {
    const rx = await receiver();
    try {
      const webhook = createEventWebhook({ url: rx.url, log: () => {} });
      const result = await driverWith(webhook).run("null", { prompt: "hi" });
      assert.deepEqual(rx.hits.map((h) => h.json.type), ["start", "exit"]);
      for (const h of rx.hits) {
        assert.deepEqual(Object.keys(h.json).sort(), ["payload", "runId", "schemaVersion", "timestamp", "type"]);
        assert.equal(h.json.schemaVersion, WEBHOOK_SCHEMA_VERSION);
        assert.equal(h.json.schemaVersion, 1);
        assert.equal(h.json.runId, result.runId);
        assert.match(h.json.timestamp, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
        assert.equal(h.headers["content-type"], "application/json");
        assert.equal(h.headers["x-ach-event"], h.json.type);
        assert.equal(h.headers[WEBHOOK_SIGNATURE_HEADER], undefined, "no secret, no signature header");
      }
      assert.equal(rx.hits[0]!.json.payload.agent, "null");
      assert.equal(rx.hits[0]!.json.payload.sessionId, result.sessionId);
      assert.equal(rx.hits[1]!.json.payload.exitStatus, "success");
    } finally {
      await rx.close();
    }
  });

  it("e2e: ach run --agent null --event-webhook posts start and exit; the env var works too", async () => {
    const rx = await receiver();
    try {
      const env = { AGENTIC_CODING_HARNESS_STATE_DIR: tmpDir() };
      const r = await runCliAsync(["run", "--agent", "null", "--event-webhook", rx.url, "--json", "hello"], env);
      assert.equal(r.code, 0, r.stderr);
      const runId = JSON.parse(r.stdout).runId;
      assert.deepEqual(rx.hits.map((h) => [h.json.type, h.json.runId, h.json.schemaVersion]), [
        ["start", runId, 1],
        ["exit", runId, 1],
      ]);
      const viaEnv = await runCliAsync(["run", "--agent", "null", "hello"], { ...env, AGENTIC_CODING_HARNESS_EVENT_WEBHOOK: rx.url });
      assert.equal(viaEnv.code, 0, viaEnv.stderr);
      assert.deepEqual(rx.hits.slice(2).map((h) => h.json.type), ["start", "exit"]);
    } finally {
      await rx.close();
    }
  });

  it("no webhook configured: nothing is posted and the driver is unchanged", async () => {
    const rx = await receiver();
    try {
      await driverWith().run("null", { prompt: "hi" });
      assert.equal(rx.hits.length, 0);
    } finally {
      await rx.close();
    }
  });
});

// ---------------------------------------------------------------- AC 2: filter

describe("#64 AC2: --webhook-events filter; default is lifecycle only", () => {
  it("--webhook-events exit suppresses the start event", async () => {
    const rx = await receiver();
    try {
      const webhook = createEventWebhook({ url: rx.url, events: parseWebhookEvents("exit"), log: () => {} });
      await driverWith(webhook).run("null", { prompt: "hi" });
      assert.deepEqual(rx.hits.map((h) => h.json.type), ["exit"]);
    } finally {
      await rx.close();
    }
  });

  it("e2e: --webhook-events exit posts only exit", async () => {
    const rx = await receiver();
    try {
      const r = await runCliAsync(["run", "--agent", "null", "--event-webhook", rx.url, "--webhook-events", "exit", "hello"], { AGENTIC_CODING_HARNESS_STATE_DIR: tmpDir() });
      assert.equal(r.code, 0, r.stderr);
      assert.deepEqual(rx.hits.map((h) => h.json.type), ["exit"]);
    } finally {
      await rx.close();
    }
  });

  it("the default posts lifecycle events only: a 20-turn run (40 usage+message events) posts start and exit, nothing per token", async () => {
    const rx = await receiver();
    try {
      const webhook = createEventWebhook({ url: rx.url, log: () => {} });
      assert.deepEqual([...webhook.events].sort(), [...WEBHOOK_EVENT_TYPES].sort());
      const result = await driverWith(webhook).run("null", { prompt: "hi" });
      assert.ok(result.events.filter((e) => e.type === "usage" || e.type === "usage_raw").length >= 20, "the run had per-token usage events");
      assert.deepEqual(rx.hits.map((h) => h.json.type), ["start", "exit"]);
    } finally {
      await rx.close();
    }
  });

  it("parseWebhookEvents: default = all four, 'all' works, an unknown name is a usage error", () => {
    assert.deepEqual([...parseWebhookEvents(undefined)].sort(), ["budget", "exit", "start", "usage"]);
    assert.deepEqual([...parseWebhookEvents("all")].sort(), ["budget", "exit", "start", "usage"]);
    assert.deepEqual([...parseWebhookEvents(" exit , BUDGET ")].sort(), ["budget", "exit"]);
    assert.throws(() => parseWebhookEvents("exit,token"), /unknown event 'token'/);
  });

  it("e2e: a typo in --webhook-events refuses the run before launch", async () => {
    const rx = await receiver();
    try {
      const r = await runCliAsync(["run", "--agent", "null", "--event-webhook", rx.url, "--webhook-events", "exitt", "hello"], { AGENTIC_CODING_HARNESS_STATE_DIR: tmpDir() });
      assert.notEqual(r.code, 0);
      assert.match(r.stderr, /--webhook-events: unknown event 'exitt'/);
      assert.equal(rx.hits.length, 0);
      const badUrl = await runCliAsync(["run", "--agent", "null", "--event-webhook", "ftp://example.invalid/x", "hello"], { AGENTIC_CODING_HARNESS_STATE_DIR: tmpDir() });
      assert.notEqual(badUrl.code, 0);
      assert.match(badUrl.stderr, /--event-webhook expects an http\(s\) URL/);
    } finally {
      await rx.close();
    }
  });

  it("budget events fire on budget-alert crossings and usage summaries on the interval", async () => {
    const rx = await receiver();
    try {
      const webhook = createEventWebhook({ url: rx.url, usageIntervalMs: 40, log: () => {} });
      const result = await driverWith(webhook).run("mock", {
        prompt: "hi",
        budget: { usd: 1, alerts: [0.5, 0.8], alertCooldownMs: 0 },
        script: [usd030(60), usd030(60), usd030(60), { type: "step", delayMs: 60 }],
      } as RunSpec);
      assert.equal(result.exitStatus, "success");
      const types = rx.hits.map((h) => h.json.type);
      assert.equal(types[0], "start");
      assert.equal(types.at(-1), "exit");
      const budget = rx.hits.filter((h) => h.json.type === "budget").map((h) => h.json.payload);
      assert.deepEqual(budget.map((p) => [p.family, p.metric, p.threshold, p.limit]), [
        ["budget", "usd", 0.5, 1],
        ["budget", "usd", 0.8, 1],
      ]);
      assert.match(String(budget[0]!.description), /usd 50%/);
      const usage = rx.hits.filter((h) => h.json.type === "usage").map((h) => h.json.payload);
      assert.ok(usage.length >= 2, `periodic usage posts: ${types.join(",")}`);
      assert.ok(usage.length <= 10, `time-clocked, not per event: ${usage.length}`);
      for (const p of usage) assert.deepEqual(Object.keys(p).sort(), ["agent", "costUsd", "elapsedMs", "sessionId", "tokens", "turns"]);
    } finally {
      await rx.close();
    }
  });
});

// ---------------------------------------------------------------- AC 3: retries with backoff

describe("#64 AC3: a receiver failing 500 three times gets the documented backoff; the run is unaffected", () => {
  it("exit is retried at 250ms, 500ms, 1000ms gaps and lands on the 4th attempt; RunResult equals a no-webhook run", async () => {
    const rx = await receiver({ statuses: [500, 500, 500, 204] });
    try {
      const log: string[] = [];
      const webhook = createEventWebhook({ url: rx.url, events: parseWebhookEvents("exit"), log: quiet(log) });
      const spec = { prompt: "hi", script: [usd030(), { type: "step" }] } as RunSpec;
      const withHook = await driverWith(webhook).run("mock", spec);
      const without = await driverWith().run("mock", spec);
      assert.deepEqual(stable(withHook), stable(without), "fail open: the run is unaffected");
      assert.equal(rx.hits.length, 4, "1 attempt + 3 retries");
      assert.deepEqual(DEFAULT_WEBHOOK_RETRY, { maxAttempts: 4, baseDelayMs: 250, attemptTimeoutMs: 2000 });
      const ids = new Set(rx.hits.map((h) => h.headers["x-ach-delivery"]));
      assert.equal(ids.size, 1, "one delivery id across retries");
      assert.equal(new Set(rx.hits.map((h) => h.body)).size, 1, "identical bytes on every retry");
      const gaps = rx.hits.slice(1).map((h, i) => h.at - rx.hits[i]!.at);
      for (const [i, want] of [250, 500, 1000].entries()) {
        assert.ok(gaps[i]! >= want - 20 && gaps[i]! < want + 600, `gap ${i + 1} = ${Math.round(gaps[i]!)}ms, want about ${want}ms (all: ${gaps.map(Math.round)})`);
      }
      assert.equal(webhook.stats(withHook.runId).delivered, 1);
      assert.equal(webhook.stats(withHook.runId).failed, 0);
      assert.deepEqual(log, [], "delivered in the end: no failure line");
    } finally {
      await rx.close();
    }
  });

  it("a receiver that always answers 500: 4 attempts, a per-run failure counter on the log, exit status untouched", async () => {
    const rx = await receiver({ statuses: Array(20).fill(500) });
    try {
      const log: string[] = [];
      const webhook = createEventWebhook({ url: rx.url, retry: { baseDelayMs: 5 }, log: quiet(log) });
      const result = await createDriver({ adapters: { null: new NullAdapter({ forceExit: "error" }) }, stateDir: tmpDir(), webhook }).run("null", { prompt: "hi" });
      assert.equal(result.exitStatus, "error", "the run's own verdict, unchanged");
      assert.equal(rx.hits.length, 8, "start and exit, 4 attempts each");
      assert.equal(webhook.stats(result.runId).failed, 2);
      assert.match(log.join(""), /start event for run \w{8} not delivered to http:\/\/127\.0\.0\.1:\d+ \(HTTP 500\); failures this run: 1/);
      assert.match(log.join(""), /exit event .* failures this run: 2/);
      assert.match(log.join(""), /2 of 2 events for run \w{8} not delivered .* the run itself is unaffected/);
      assert.doesNotMatch(log.join(""), /\/hook/, "the URL path (a credential for Slack) is never logged");
      assert.ok(!result.warnings.some((w) => /webhook/.test(w)), "failures stay out of RunResult.warnings");
    } finally {
      await rx.close();
    }
  });

  it("e2e: receiver 500 three times; ach run exits 0 with the same --json result shape", async () => {
    const rx = await receiver({ statuses: [500, 500, 500, 204, 204] });
    try {
      const r = await runCliAsync(["run", "--agent", "null", "--event-webhook", rx.url, "--webhook-events", "start", "--json", "hello"], { AGENTIC_CODING_HARNESS_STATE_DIR: tmpDir() });
      assert.equal(r.code, 0, r.stderr);
      assert.equal(JSON.parse(r.stdout).exitStatus, "success");
      assert.equal(rx.hits.length, 4);
      assert.doesNotMatch(r.stderr, /webhook/, "delivered on attempt 4: nothing to report");
    } finally {
      await rx.close();
    }
  });
});

// ---------------------------------------------------------------- AC 4: HMAC

describe("#64 AC4: with a secret, every POST carries a verifiable HMAC-SHA256 header", () => {
  it("receiver-side verification with node:crypto over the raw body", async () => {
    const rx = await receiver();
    try {
      const secret = "test-signing-key";
      const webhook = createEventWebhook({ url: rx.url, secret, log: () => {} });
      await driverWith(webhook).run("null", { prompt: "hi" });
      assert.equal(rx.hits.length, 2);
      for (const h of rx.hits) {
        const header = h.headers[WEBHOOK_SIGNATURE_HEADER];
        // Independent of the module under test: the receiver's own HMAC.
        const want = `sha256=${createHmac("sha256", secret).update(h.body, "utf8").digest("hex")}`;
        assert.equal(header, want, `${h.json.type} signature`);
        assert.equal(verifyWebhookSignature(secret, h.body, String(header)), true);
        assert.equal(verifyWebhookSignature("wrong-key", h.body, String(header)), false);
        assert.equal(verifyWebhookSignature(secret, h.body.replace(h.json.runId, "tampered-run-id"), String(header)), false);
      }
    } finally {
      await rx.close();
    }
  });

  it("e2e: AGENTIC_CODING_HARNESS_EVENT_WEBHOOK_SECRET signs every POST", async () => {
    const rx = await receiver();
    try {
      const secret = "e2e-key";
      const r = await runCliAsync(["run", "--agent", "null", "--event-webhook", rx.url, "hello"], {
        AGENTIC_CODING_HARNESS_STATE_DIR: tmpDir(),
        AGENTIC_CODING_HARNESS_EVENT_WEBHOOK_SECRET: secret,
      });
      assert.equal(r.code, 0, r.stderr);
      assert.equal(rx.hits.length, 2);
      for (const h of rx.hits) {
        assert.equal(h.headers[WEBHOOK_SIGNATURE_HEADER], `sha256=${createHmac("sha256", secret).update(h.body).digest("hex")}`);
      }
    } finally {
      await rx.close();
    }
  });

  it("signWebhookBody matches a known HMAC-SHA256 vector", () => {
    // RFC 4231-style check computed independently: HMAC-SHA256("key", "The quick brown fox jumps over the lazy dog").
    assert.equal(signWebhookBody("key", "The quick brown fox jumps over the lazy dog"), "sha256=f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8");
  });
});

// ---------------------------------------------------------------- AC 5: exit payload

describe("#64 AC5: the exit payload carries the full exitStatus and the cost summary", () => {
  it("success run: exitStatus, cost.usd, tokens, turns, duration", async () => {
    const rx = await receiver();
    try {
      const webhook = createEventWebhook({ url: rx.url, events: parseWebhookEvents("exit"), log: () => {} });
      const result = await driverWith(webhook).run("mock", { prompt: "hi", script: [usd030(), { type: "step" }, usd030(), { type: "step" }] } as RunSpec);
      const p = rx.hits[0]!.json.payload as Record<string, any>;
      assert.equal(p.exitStatus, "success");
      assert.equal(p.exitStatus, result.exitStatus);
      assert.ok(Math.abs(p.cost.usd - 0.6) < 1e-9, `cost.usd ${p.cost.usd}`);
      assert.equal(p.cost.usd, result.totalCost);
      assert.equal(p.cost.usdAvailable, true);
      assert.equal(p.cost.source, "computed");
      assert.deepEqual(p.tokens, { inputTokens: 200_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });
      assert.equal(p.turns, 2);
      assert.equal(p.durationMs, result.durationMs);
      assert.equal(p.agent, "mock");
      assert.equal(p.sessionId, result.sessionId);
    } finally {
      await rx.close();
    }
  });

  it("non-success verdicts arrive as-is: budget_exceeded (driver cap), timeout (wall), error (adapter)", async () => {
    const rx = await receiver();
    try {
      const webhook = createEventWebhook({ url: rx.url, events: parseWebhookEvents("exit"), log: () => {} });
      const driver = driverWith(webhook);
      await driver.run("mock", { prompt: "hi", budget: { usd: 0.5, onExceed: "abort" }, script: [usd030(), usd030(), usd030()] } as RunSpec);
      await driver.run("mock", { prompt: "hi", budget: { wallMs: 50 }, script: [{ type: "step", delayMs: 2000 }] } as RunSpec);
      await createDriver({ adapters: { null: new NullAdapter({ forceExit: "error" }) }, stateDir: tmpDir(), webhook }).run("null", { prompt: "hi" });
      const ps = rx.hits.map((h) => h.json.payload as Record<string, any>);
      assert.deepEqual(ps.map((p) => p.exitStatus), ["budget_exceeded", "timeout", "error"]);
      assert.ok(ps[0]!.cost.usd > 0.5, "the cost that tripped the cap");
      assert.equal(ps[1]!.timeoutKind, "wall");
    } finally {
      await rx.close();
    }
  });

  it("a launch that throws still posts exit (error, with the message), and the error still propagates", async () => {
    const rx = await receiver();
    try {
      const webhook = createEventWebhook({ url: rx.url, log: () => {} });
      const broken: AgentAdapter = {
        name: "broken",
        async launch() {
          throw new Error("launch exploded");
        },
      } as unknown as AgentAdapter;
      const driver = createDriver({ adapters: { broken }, stateDir: tmpDir(), webhook });
      await assert.rejects(() => driver.run("broken", { prompt: "hi" }), /launch exploded/);
      assert.deepEqual(rx.hits.map((h) => h.json.type), ["exit"]);
      assert.equal(rx.hits[0]!.json.payload.exitStatus, "error");
      assert.match(String(rx.hits[0]!.json.payload.error), /launch exploded/);
    } finally {
      await rx.close();
    }
  });
});

// ---------------------------------------------------------------- AC 6: unreachable URL

describe("#64 AC6: an unreachable URL never crashes or slows the run beyond the backoff budget", () => {
  it(`refused connection (closed port): the run completes, unchanged, well inside ${DEFAULT_WEBHOOK_FLUSH_MS}ms of extra time`, async () => {
    const url = await closedPortUrl();
    const log: string[] = [];
    const webhook = createEventWebhook({ url, log: quiet(log) });
    const spec = { prompt: "hi", script: [usd030(), { type: "step" }] } as RunSpec;
    const t0 = performance.now();
    const withHook = await driverWith(webhook).run("mock", spec);
    const elapsed = performance.now() - t0;
    const without = await driverWith().run("mock", spec);
    assert.deepEqual(stable(withHook), stable(without));
    assert.ok(elapsed < DEFAULT_WEBHOOK_FLUSH_MS + 1000, `run took ${Math.round(elapsed)}ms`);
    assert.match(log.join(""), /ECONNREFUSED/);
    assert.match(log.join(""), /2 of 2 events .* not delivered/);
  });

  it(`a receiver that accepts and never answers: run end waits at most the ${DEFAULT_WEBHOOK_FLUSH_MS}ms flush bound`, async () => {
    const rx = await receiver({ hang: true });
    try {
      const log: string[] = [];
      const webhook = createEventWebhook({ url: rx.url, log: quiet(log) });
      const spec = { prompt: "hi", script: [usd030(), { type: "step" }] } as RunSpec;
      const t0 = performance.now();
      const withHook = await driverWith(webhook).run("mock", spec);
      const elapsed = performance.now() - t0;
      const without = await driverWith().run("mock", spec);
      assert.deepEqual(stable(withHook), stable(without));
      assert.ok(elapsed >= DEFAULT_WEBHOOK_FLUSH_MS - 100, `the flush did wait for the bound: ${Math.round(elapsed)}ms`);
      assert.ok(elapsed < DEFAULT_WEBHOOK_FLUSH_MS + 1000, `bounded: ${Math.round(elapsed)}ms`);
      assert.match(log.join(""), /(dropped at the 5000ms flush deadline|flush deadline reached|timed out)/);
      assert.equal(webhook.stats(withHook.runId).delivered, 0);
      assert.equal(webhook.stats(withHook.runId).failed, 2);
    } finally {
      await rx.close();
    }
  });

  it("e2e: ach run with an unreachable webhook exits 0 and prints the failure counter on stderr", async () => {
    const url = await closedPortUrl();
    const t0 = performance.now();
    const r = await runCliAsync(["run", "--agent", "null", "--event-webhook", url, "--json", "hello"], { AGENTIC_CODING_HARNESS_STATE_DIR: tmpDir() });
    const elapsed = performance.now() - t0;
    assert.equal(r.code, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).exitStatus, "success");
    assert.match(r.stderr, /\[warn\] webhook: 2 of 2 events for run \w{8} not delivered/);
    assert.ok(elapsed < DEFAULT_WEBHOOK_FLUSH_MS + 10_000, `cli run took ${Math.round(elapsed)}ms`);
  });

  it("post() never blocks the caller, even against a hanging receiver", async () => {
    const rx = await receiver({ hang: true });
    try {
      const webhook = createEventWebhook({ url: rx.url, flushMs: 200, log: () => {} });
      const t0 = performance.now();
      for (let i = 0; i < 50; i++) webhook.post("run-1", "usage", { i });
      assert.ok(performance.now() - t0 < 100, "queued, not sent inline");
      const f0 = performance.now();
      await webhook.flush("run-1");
      assert.ok(performance.now() - f0 < 1000, "flush honours its bound");
      assert.equal(webhook.stats("run-1").failed, 50);
    } finally {
      await rx.close();
    }
  });
});

// ---------------------------------------------------------------- masking (#71 sink)

describe("#64 masking: payloads go through the export gate as sink `webhook`", () => {
  const SECRET = "sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWX";

  it("webhook is a mask sink; mask.webhook=all masks, mask.webhook=none beats mask.mode=all, preview POSTs nothing", async () => {
    assert.ok((MASK_SINKS as readonly string[]).includes("webhook"));
    const rx = await receiver();
    try {
      const masked = createEventWebhook({ url: rx.url, mask: resolveMaskPolicy({ sink: "webhook", config: { webhook: "all" }, env: {} }), log: () => {} });
      masked.post("r1", "exit", { error: `boom ${SECRET}` });
      await masked.flush("r1");
      assert.equal(rx.hits.length, 1);
      assert.ok(!rx.hits[0]!.body.includes(SECRET), rx.hits[0]!.body);
      assert.match(rx.hits[0]!.body, /\[REDACTED_API_KEY\]/);

      const perSink = createEventWebhook({ url: rx.url, mask: resolveMaskPolicy({ sink: "webhook", config: { mode: "all", webhook: "none" }, env: {} }), log: () => {} });
      perSink.post("r2", "exit", { error: `boom ${SECRET}` });
      await perSink.flush("r2");
      assert.ok(rx.hits[1]!.body.includes(SECRET), "mask.webhook beats mask.mode");

      const log: string[] = [];
      const preview = createEventWebhook({ url: rx.url, mask: resolveMaskPolicy({ sink: "webhook", flags: { mask: "preview" }, env: {} }), log: quiet(log) });
      preview.post("r3", "exit", { error: `boom ${SECRET}` });
      await preview.flush("r3");
      assert.equal(rx.hits.length, 2, "preview sends nothing");
      assert.match(log.join(""), /anthropic-key/);
      assert.match(log.join(""), /no event is POSTed/);
      assert.ok(!log.join("").includes(SECRET), "preview never prints the secret");
    } finally {
      await rx.close();
    }
  });

  it("e2e: with no mask setting the webhook masks by default (Q188 outbound); --mask none posts raw", async () => {
    const rx = await receiver();
    try {
      const r = await runCliAsync(["run", "--agent", "null", "--model", SECRET, "--event-webhook", rx.url, "hello"], { AGENTIC_CODING_HARNESS_STATE_DIR: tmpDir() });
      assert.equal(r.code, 0, r.stderr);
      const start = rx.hits.find((h) => h.json.type === "start")!;
      assert.ok(!start.body.includes(SECRET), "default: secret masked");
      assert.match(start.body, /REDACTED_API_KEY/);
      rx.hits.length = 0;
      const raw = await runCliAsync(["run", "--agent", "null", "--model", SECRET, "--event-webhook", rx.url, "--mask", "none", "hello"], { AGENTIC_CODING_HARNESS_STATE_DIR: tmpDir() });
      assert.equal(raw.code, 0, raw.stderr);
      const rawStart = rx.hits.find((h) => h.json.type === "start")!;
      assert.ok(rawStart.body.includes(SECRET), "--mask none: secret posted raw");
    } finally {
      await rx.close();
    }
  });

  it("e2e: ach run --mask all masks a secret in the posted start payload (--model)", async () => {
    const rx = await receiver();
    try {
      // The start payload echoes --model, so a key-shaped value there must arrive masked.
      const r = await runCliAsync(["run", "--agent", "null", "--model", SECRET, "--event-webhook", rx.url, "--mask", "all", "hello"], { AGENTIC_CODING_HARNESS_STATE_DIR: tmpDir() });
      assert.equal(r.code, 0, r.stderr);
      const start = rx.hits.find((h) => h.json.type === "start")!;
      assert.ok(!start.body.includes(SECRET), start.body);
      assert.match(start.body, /REDACTED_API_KEY/);
      assert.match(r.stderr, /mask: webhook start: masked 1 finding/);
    } finally {
      await rx.close();
    }
  });
});

describe("#64 privacy: --privacy anon applies to webhook payloads", () => {
  it("e2e: ach run --privacy anon hashes runId and sessionId in every posted envelope", async () => {
    const rx = await receiver();
    try {
      const r = await runCliAsync(["run", "--agent", "null", "--event-webhook", rx.url, "--privacy", "anon", "--json", "hello"], { AGENTIC_CODING_HARNESS_STATE_DIR: tmpDir() });
      assert.equal(r.code, 0, r.stderr);
      const out = JSON.parse(r.stdout);
      assert.equal(rx.hits.length, 2);
      for (const h of rx.hits) {
        assert.equal(h.json.runId, anonId(out.runId), "envelope runId is the anon hash");
        assert.equal(h.json.payload.sessionId, anonId(out.sessionId));
        assert.ok(!h.body.includes(out.runId) && !h.body.includes(out.sessionId), "no raw id anywhere in the body");
      }
      assert.match(r.stderr, /privacy/i, "sanitizing is never silent");
    } finally {
      await rx.close();
    }
  });
});

// ---------------------------------------------------------------- config + profile redaction

describe("#64 config: run.eventWebhook / profiles, URL redacted on the RunRecord", () => {
  it("a profile's eventWebhook delivers, and the RunRecord keeps only the origin", async () => {
    const rx = await receiver();
    try {
      const dir = tmpDir();
      const stateDir = path.join(dir, "state");
      const cfg = path.join(dir, "config.json");
      const secretUrl = `${rx.url}/T000/B000/tokenpart`;
      fs.writeFileSync(cfg, JSON.stringify({ profiles: { hooked: { agent: "null", eventWebhook: secretUrl, webhookEvents: "exit" } } }));
      const r = await runCliAsync(["--config", cfg, "run", "--profile", "hooked", "hello"], { AGENTIC_CODING_HARNESS_STATE_DIR: stateDir, HOME: dir });
      assert.equal(r.code, 0, r.stderr);
      assert.deepEqual(rx.hits.map((h) => h.json.type), ["exit"]);
      const recs = listRunRecords(stateDir);
      assert.equal(recs.length, 1);
      const text = JSON.stringify(recs[0]);
      assert.ok(!text.includes("tokenpart"), "the webhook URL path is not recorded");
      assert.equal((recs[0]!.profile as { expanded: Record<string, unknown> }).expanded["event-webhook"], `${new URL(rx.url).origin}/<redacted>`);
    } finally {
      await rx.close();
    }
  });
});

// ---------------------------------------------------------------- watch

describe("#64 ach watch: per-poll usage deltas are posted", () => {
  it("watch posts one usage event per session delta and flushes on SIGINT", async () => {
    const rx = await receiver();
    try {
      const root = tmpDir();
      const home = path.join(root, "home");
      fs.cpSync(new URL("./fixtures/multi-dir/home-a", import.meta.url).pathname, home, { recursive: true });
      const state = path.join(root, "state");
      const isBun = (process.versions as { bun?: string }).bun !== undefined;
      const argv = ["watch", "--dir", home, "--since", "2026-01-01", "--event-webhook", rx.url];
      const child = spawn(process.execPath, isBun ? [CLI, ...argv] : ["--import", "tsx", CLI, ...argv], {
        env: { PATH: process.env.PATH ?? "", HOME: root, AGENTIC_CODING_HARNESS_STATE_DIR: state, AGENTIC_CODING_HARNESS_TZ: "UTC" },
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => (stdout += String(d)));
      child.stderr.on("data", (d) => (stderr += String(d)));
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline && rx.hits.length < 2 && child.exitCode === null) await new Promise((r) => setTimeout(r, 100));
      const closed = new Promise<number>((r) => child.once("close", (c) => r(c ?? -1)));
      child.kill("SIGINT");
      const code = await closed;
      assert.equal(code, 0, stderr);
      const lines = stdout.split("\n").filter((l) => / source: transcript/.test(l));
      assert.ok(lines.length >= 2, stdout + stderr);
      assert.equal(rx.hits.length, lines.length, "one post per printed delta");
      for (const h of rx.hits) {
        assert.equal(h.json.type, "usage");
        assert.match(h.json.runId, /^watch-[0-9a-f-]{36}$/);
        assert.equal(h.json.payload.source, "watch");
        assert.ok(typeof h.json.payload.sessionId === "string");
        assert.deepEqual(Object.keys(h.json.payload.delta as object).sort(), ["cacheReadTokens", "cacheWriteTokens", "inputTokens", "outputTokens"]);
      }
    } finally {
      await rx.close();
    }
  });

  it("watch --offline refuses a non-loopback webhook", async () => {
    const r = await runCliAsync(["watch", "--offline", "--event-webhook", "https://hooks.example.com/x"], { AGENTIC_CODING_HARNESS_STATE_DIR: tmpDir() });
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /--offline refuses a non-loopback webhook \(https:\/\/hooks\.example\.com\)/);
  });
});

// ---------------------------------------------------------------- AC 7: docs

describe("#64 AC7: docs cover envelope, event types, signing and a working receiver", () => {
  const doc = fs.readFileSync(DOC, "utf8");

  it("documents the envelope keys, every event type, the signature header, the retry/backoff budget and Slack", () => {
    for (const k of ["schemaVersion", "runId", "type", "timestamp", "payload"]) assert.ok(doc.includes(`\`${k}\``), k);
    for (const t of WEBHOOK_EVENT_TYPES) assert.match(doc, new RegExp(`### \`${t}\``), t);
    assert.ok(doc.includes(WEBHOOK_SIGNATURE_HEADER));
    assert.ok(doc.includes("AGENTIC_CODING_HARNESS_EVENT_WEBHOOK_SECRET"));
    assert.ok(doc.includes(`**${DEFAULT_WEBHOOK_FLUSH_MS / 1000}s**`), "flush bound documented");
    assert.ok(doc.includes(`**${DEFAULT_WEBHOOK_RETRY.maxAttempts} attempts**`));
    assert.ok(doc.includes("**250ms, 500ms, then 1000ms**"));
    assert.match(doc, /## Slack/);
    assert.match(doc, /"text":/);
  });

  it("the docs' ten-line receiver runs: it accepts a correctly signed event and rejects a bad signature", async () => {
    const m = /<!-- receiver:start -->\n```js\n([\s\S]*?)```\n<!-- receiver:end -->/.exec(doc);
    assert.ok(m, "receiver block present");
    const code = m[1]!;
    assert.equal(code.trimEnd().split("\n").length, 10, "ten lines");
    const dir = tmpDir();
    const file = path.join(dir, "receiver.mjs");
    fs.writeFileSync(file, code);
    const secret = "doc-key";
    const child = spawn(process.execPath, [file], { env: { PATH: process.env.PATH ?? "", PORT: "0", SECRET: secret } });
    let out = "";
    child.stdout.on("data", (d) => (out += String(d)));
    try {
      const deadline = Date.now() + 10_000;
      while (!/listening on \d+/.test(out) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
      const port = Number(/listening on (\d+)/.exec(out)![1]);
      // A real run against it, signed by the tap.
      const webhook = createEventWebhook({ url: `http://127.0.0.1:${port}/`, secret, log: () => {} });
      const result = await driverWith(webhook).run("null", { prompt: "hi" });
      assert.equal(webhook.stats(result.runId).delivered, 2, "both events accepted (204)");
      const forged = await fetch(`http://127.0.0.1:${port}/`, { method: "POST", headers: { [WEBHOOK_SIGNATURE_HEADER]: "sha256=00" }, body: "{}" });
      assert.equal(forged.status, 401);
      await new Promise((r) => setTimeout(r, 100));
      assert.match(out, new RegExp(`^start ${result.runId} `, "m"));
      assert.match(out, new RegExp(`^exit ${result.runId} .*"exitStatus":"success"`, "m"));
    } finally {
      const closed = new Promise((r) => child.once("close", r));
      child.kill();
      await closed;
    }
  });
});
