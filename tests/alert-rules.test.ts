// Alert rules engine (#74): error_rate and idle rules, webhook and desktop
// destinations, debounce + cooldown, `ach watch` live evaluation and
// `ach alerts --dry-run`. Receivers are local http servers on port 0, started
// and closed per test. No test pops a real notification: desktop delivery is
// asserted through an injected launcher.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  alertRulesStateFile,
  alertsConfigProblems,
  evaluateAlertRules,
  freshAlertRulesState,
  isInFlight,
  parseAlertsConfig,
  replayAlertHistory,
  type AlertRule,
} from "../src/core/alert-rules.ts";
import { createAlertRunner, transcriptEventTimes } from "../src/cli/alerts-cli.ts";
import { configProblems } from "../src/cli/config.ts";
import { ChainWriter } from "../src/core/hash-chain.ts";
import { createDriver } from "../src/core/driver.ts";
import { NullAdapter } from "../src/adapters/null.ts";
import { ALERT_WEBHOOK_EVENT, EVENT_WEBHOOK_SECRET_ENV, verifyWebhookSignature, WEBHOOK_EVENT_TYPES, WEBHOOK_SIGNATURE_HEADER } from "../src/core/event-webhook.ts";
import { listRunRecords, writeRunRecord, type RunRecord } from "../src/core/registry.ts";

const CLI = new URL("../src/cli/ach.ts", import.meta.url).pathname;
const ROOT = new URL("..", import.meta.url).pathname;

// ---------------------------------------------------------------- helpers

interface Hit {
  headers: http.IncomingHttpHeaders;
  body: string;
  json: { schemaVersion: number; runId: string; type: string; timestamp: string; payload: Record<string, unknown> };
}

async function receiver(): Promise<{ url: string; hits: Hit[]; close(): Promise<void> }> {
  const hits: Hit[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      hits.push({ headers: req.headers, body, json: JSON.parse(body) });
      res.writeHead(204).end();
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

async function closedPortUrl(): Promise<string> {
  const s = http.createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const { port } = s.address() as AddressInfo;
  await new Promise<void>((r) => s.close(() => r()));
  return `http://127.0.0.1:${port}/hook`;
}

const tmpDir = (): string => fs.mkdtempSync(path.join(os.tmpdir(), "ach-alerts-"));

const T0 = Date.parse("2026-06-01T00:00:00.000Z");
const MIN = 60_000;

let seq = 0;
/** A terminal run that ended at `endedAt`. */
function run(status: "success" | "error", endedAt: number, extra: Partial<RunRecord> = {}): RunRecord {
  seq++;
  const id = `${String(seq).padStart(8, "0")}-0000-4000-8000-000000000000`;
  return { runId: id, agent: "mock", startedAt: endedAt - 1000, updatedAt: endedAt, endedAt, status, exitStatus: status, source: "local", ...extra };
}

/** A running record owned by `pid` whose last event was at `lastEventAt`. */
function live(lastEventAt: number, extra: Partial<RunRecord> = {}): RunRecord {
  seq++;
  return {
    runId: `${String(seq).padStart(8, "0")}-1111-4000-8000-000000000000`,
    agent: "mock",
    startedAt: lastEventAt - 5000,
    updatedAt: lastEventAt,
    lastEventAt,
    status: "running",
    pid: 4242,
    source: "local",
    ...extra,
  };
}

const desktop = [{ type: "desktop" as const }];
const streakRule = (extra: Partial<AlertRule> = {}): AlertRule => ({ name: "streak", type: "error_rate", consecutive: 3, cooldownSec: 0, destinations: desktop, ...extra }) as AlertRule;
const idleRule = (extra: Partial<AlertRule> = {}): AlertRule => ({ name: "hung", type: "idle", idleSec: 60, cooldownSec: 0, destinations: desktop, ...extra }) as AlertRule;

async function runCli(args: string[], env: Record<string, string>): Promise<{ code: number; stdout: string; stderr: string }> {
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

/** Start `ach watch`, wait until `done()` (or 30s), SIGINT it, return its exit code and output. */
async function watchUntil(args: string[], env: Record<string, string>, done: (stderr: string) => boolean): Promise<{ code: number; stdout: string; stderr: string }> {
  const isBun = (process.versions as { bun?: string }).bun !== undefined;
  const argv = [...args];
  const child = spawn(process.execPath, isBun ? [CLI, ...argv] : ["--import", "tsx", CLI, ...argv], {
    env: { PATH: process.env.PATH ?? "", ...env },
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => (stdout += String(d)));
  child.stderr.on("data", (d) => (stderr += String(d)));
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline && !done(stderr) && child.exitCode === null) await new Promise((r) => setTimeout(r, 100));
  const closed = new Promise<number>((r) => child.once("close", (c) => r(c ?? -1)));
  if (child.exitCode === null) child.kill("SIGINT");
  const code = await closed;
  return { code, stdout, stderr };
}

// ---------------------------------------------------------------- AC1: schema

describe("#74 AC1: rule file schema (error_rate + idle, thresholds, strict)", () => {
  it("parses error_rate (N of M and consecutive) and idle rules with both destination types", () => {
    const rules = parseAlertsConfig({
      rules: [
        { name: "flaky", type: "error_rate", failures: 3, window: 10, agent: "claude", destinations: [{ type: "webhook", url: "https://hooks.example.com/x" }] },
        { name: "streak", type: "error_rate", consecutive: 4, cooldownSec: 0, destinations: [{ type: "desktop", sound: true }] },
        { name: "hung", type: "idle", idleSec: 600, destinations: [{ type: "desktop" }, { type: "webhook", url: "http://127.0.0.1:1/h" }] },
      ],
    });
    assert.deepEqual(rules.map((r) => [r.name, r.type]), [["flaky", "error_rate"], ["streak", "error_rate"], ["hung", "idle"]]);
  });

  it("rejects unknown keys, bad thresholds and bad cross-field combinations with dotted paths", () => {
    const problems = alertsConfigProblems({
      bogus: 1,
      rules: [{ name: "a", type: "idle", idleSec: 0, oops: true, destinations: [{ type: "desktop" }] }],
    });
    assert.ok(problems.some((p) => p === "'alerts' has unknown key 'bogus'"), problems.join("\n"));
    assert.ok(problems.some((p) => p === "'alerts.rules.0' has unknown key 'oops'"), problems.join("\n"));
    assert.ok(problems.some((p) => p === "'alerts.rules.0.idleSec' must be > 0"), problems.join("\n"));
    const typo = alertsConfigProblems({ rules: [{ name: "a", type: "errors", destinations: desktop }] });
    assert.deepEqual(typo, ["'alerts.rules.0.type' must be one of: error_rate, idle"]);
    const dest = alertsConfigProblems({ rules: [{ name: "a", type: "idle", idleSec: 5, destinations: [{ type: "pager" }] }] });
    assert.deepEqual(dest, ["'alerts.rules.0.destinations.0.type' must be one of: webhook, desktop"]);
    const url = alertsConfigProblems({ rules: [{ name: "a", type: "idle", idleSec: 5, destinations: [{ type: "webhook", url: "ftp://x" }] }] });
    assert.deepEqual(url, ["'alerts.rules.0.destinations.0.url' must be an absolute http(s) URL"]);
    const cross = alertsConfigProblems({
      rules: [
        { name: "a", type: "error_rate", failures: 5, window: 3, destinations: desktop },
        { name: "a", type: "error_rate", window: 3, failures: 1, consecutive: 1.5, destinations: desktop },
      ],
    });
    assert.deepEqual(cross, ["'alerts.rules.1.consecutive' must be a whole number"]);
    const cross2 = alertsConfigProblems({
      rules: [
        { name: "a", type: "error_rate", failures: 5, window: 3, destinations: desktop },
        { name: "a", type: "error_rate", window: 3, destinations: desktop },
        { name: "c", type: "error_rate", destinations: desktop },
      ],
    });
    assert.deepEqual(cross2, [
      "'alerts.rules.0.failures' (5) cannot exceed window (3)",
      "'alerts.rules.1.name' duplicates rule 'a' (names must be unique)",
      "'alerts.rules.1' (error_rate) sets window without failures; give both",
      "'alerts.rules.2' (error_rate) needs failures + window, consecutive, or both",
    ]);
  });

  it("the config file validator reports an alerts problem with the file path (and accepts a valid section)", () => {
    const tables = { run: {}, stats: {}, web: {}, serve: {}, emit: {} };
    assert.deepEqual(configProblems({ path: "/x/config.json", kind: "explicit", data: { alerts: { rules: [streakRule()] } } }, tables), []);
    assert.deepEqual(configProblems({ path: "/x/config.json", kind: "explicit", data: { alerts: { rules: [{ ...streakRule(), consecutive: 0 }] } } }, tables), [
      "config /x/config.json: 'alerts.rules.0.consecutive' must be at least 1",
    ]);
  });

  it("e2e: `ach alerts` lists valid rules and refuses an invalid file (exit 1, message)", async () => {
    const dir = tmpDir();
    const good = path.join(dir, "good.json");
    const bad = path.join(dir, "bad.json");
    fs.writeFileSync(good, JSON.stringify({ alerts: { rules: [streakRule(), idleRule()] } }));
    fs.writeFileSync(bad, JSON.stringify({ alerts: { rules: [{ name: "x", type: "idle", destinations: desktop }] } }));
    const ok = await runCli(["--config", good, "alerts"], { AGENTIC_CODING_HARNESS_STATE_DIR: dir });
    assert.equal(ok.code, 0, ok.stderr);
    assert.match(ok.stdout, /alerts: 2 rules valid/);
    assert.match(ok.stdout, /streak {2}error_rate {2}3 consecutive failures/);
    assert.match(ok.stdout, /hung {2}idle {2}no event for 60s while running/);
    const no = await runCli(["--config", bad, "alerts"], { AGENTIC_CODING_HARNESS_STATE_DIR: dir });
    assert.equal(no.code, 1);
    assert.match(no.stderr, /'alerts\.rules\.0\.idleSec'/);
  });

  it("the published config schema carries the alerts section", () => {
    const schema = JSON.parse(fs.readFileSync(path.join(ROOT, "docs/config.schema.json"), "utf8"));
    const alerts = schema.properties.alerts;
    assert.ok(alerts !== undefined, "alerts in docs/config.schema.json");
    assert.equal(alerts.additionalProperties, false);
  });
});

// ---------------------------------------------------------------- AC2: evaluation, debounce, cooldown

describe("#74 AC2: evaluation with debounce and per-rule cooldown (injected clock)", () => {
  it("error_rate consecutive: fires once per streak, re-arms after a success", () => {
    const rules = [streakRule()];
    const state = freshAlertRulesState();
    const recs: RunRecord[] = [run("error", T0), run("error", T0 + MIN)];
    assert.equal(evaluateAlertRules({ rules, records: recs, state, now: T0 + 2 * MIN }).length, 0, "2 < 3");
    recs.push(run("error", T0 + 2 * MIN));
    const first = evaluateAlertRules({ rules, records: recs, state, now: T0 + 3 * MIN });
    assert.equal(first.length, 1);
    assert.equal(first[0]!.suppressed, false);
    assert.equal(first[0]!.hit.metric, "consecutive_failures");
    assert.equal(first[0]!.hit.value, 3);
    assert.equal(first[0]!.hit.runId, recs[2]!.runId, "the tipping run");
    assert.equal(evaluateAlertRules({ rules, records: recs, state, now: T0 + 4 * MIN }).length, 0, "same snapshot: debounced");
    recs.push(run("error", T0 + 4 * MIN));
    assert.equal(evaluateAlertRules({ rules, records: recs, state, now: T0 + 5 * MIN }).length, 0, "a 4th failure extends the same episode");
    recs.push(run("success", T0 + 6 * MIN), run("error", T0 + 7 * MIN), run("error", T0 + 8 * MIN), run("error", T0 + 9 * MIN));
    const again = evaluateAlertRules({ rules, records: recs, state, now: T0 + 10 * MIN });
    assert.equal(again.length, 1, "a new streak after a success fires again");
    assert.equal(again[0]!.hit.runId, recs[recs.length - 1]!.runId);
  });

  it("error_rate N of M: fires when failures in the window reach N; outages and running records are not verdicts", () => {
    const rules: AlertRule[] = [{ name: "flaky", type: "error_rate", failures: 2, window: 4, cooldownSec: 0, destinations: desktop }];
    const state = freshAlertRulesState();
    const recs = [run("error", T0), run("success", T0 + MIN), run("success", T0 + 2 * MIN), { ...run("error", T0 + 3 * MIN), status: "unavailable" as const, exitStatus: "unavailable" }];
    assert.equal(evaluateAlertRules({ rules, records: recs, state, now: T0 + 4 * MIN }).length, 0, "only 3 verdict runs, 1 failure");
    recs.push(run("error", T0 + 5 * MIN));
    const d = evaluateAlertRules({ rules, records: recs, state, now: T0 + 6 * MIN });
    assert.equal(d.length, 1);
    assert.deepEqual([d[0]!.hit.metric, d[0]!.hit.threshold, d[0]!.hit.value, d[0]!.hit.window], ["failures_in_window", 2, 2, 4]);
    assert.equal(d[0]!.hit.runs?.length, 2);
  });

  it("cooldown rate-limits: a new episode inside it is suppressed and counted; the next delivered hit reports it", () => {
    const rules = [streakRule({ consecutive: 1, cooldownSec: 600 })];
    const state = freshAlertRulesState();
    const recs: RunRecord[] = [run("error", T0)];
    assert.equal(evaluateAlertRules({ rules, records: recs, state, now: T0 })[0]!.suppressed, false);
    recs.push(run("success", T0 + MIN), run("error", T0 + 2 * MIN));
    const inside = evaluateAlertRules({ rules, records: recs, state, now: T0 + 2 * MIN });
    assert.equal(inside.length, 1);
    assert.equal(inside[0]!.suppressed, true, "2 min after a hit, inside 600s");
    recs.push(run("success", T0 + 3 * MIN), run("error", T0 + 11 * MIN));
    const after = evaluateAlertRules({ rules, records: recs, state, now: T0 + 11 * MIN });
    assert.equal(after.length, 1);
    assert.equal(after[0]!.suppressed, false, "11 min after the delivered hit");
    assert.equal(after[0]!.hit.suppressedSinceLastFire, 1);
  });

  it("idle: an in-flight run quiet past idleSec fires once per quiet spell; it reads lastEventAt, not updatedAt", () => {
    const rules = [idleRule()];
    const state = freshAlertRulesState();
    const alive = () => true;
    // A keepalive moved updatedAt to now; the last event is 90s old.
    const rec = live(T0, { updatedAt: T0 + 90_000 });
    assert.equal(evaluateAlertRules({ rules, records: [rec], state, now: T0 + 59_000, pidAlive: alive }).length, 0);
    const d = evaluateAlertRules({ rules, records: [rec], state, now: T0 + 90_000, pidAlive: alive });
    assert.equal(d.length, 1);
    assert.deepEqual([d[0]!.hit.metric, d[0]!.hit.threshold, d[0]!.hit.value, d[0]!.hit.runId], ["idle_seconds", 60, 90, rec.runId]);
    assert.equal(evaluateAlertRules({ rules, records: [rec], state, now: T0 + 120_000, pidAlive: alive }).length, 0, "same spell: debounced");
    const resumed = { ...rec, lastEventAt: T0 + 130_000 };
    assert.equal(evaluateAlertRules({ rules, records: [resumed], state, now: T0 + 150_000, pidAlive: alive }).length, 0, "events resumed");
    assert.equal(evaluateAlertRules({ rules, records: [resumed], state, now: T0 + 200_000, pidAlive: alive }).length, 1, "a new quiet spell");
  });

  it("idle ignores finished runs, dead pids and external records", () => {
    const rules = [idleRule()];
    const now = T0 + 10 * MIN;
    const recs = [live(T0), live(T0, { status: "success" }), live(T0, { source: "external" })];
    assert.equal(evaluateAlertRules({ rules, records: recs, state: freshAlertRulesState(), now, pidAlive: () => false }).length, 0, "dead pid");
    assert.equal(evaluateAlertRules({ rules, records: recs, state: freshAlertRulesState(), now, pidAlive: () => true }).length, 1, "only the live local one");
    assert.equal(isInFlight(live(T0, { pid: process.pid })), true, "this process is alive");
  });

  it("the runner persists episodes: a second runner (a restarted watch) does not re-announce", () => {
    const dir = tmpDir();
    writeRunRecord(dir, run("error", T0));
    writeRunRecord(dir, run("error", T0 + MIN));
    writeRunRecord(dir, run("error", T0 + 2 * MIN));
    const sent: string[] = [];
    const mk = () => createAlertRunner({ rules: [streakRule()], stateDir: dir, notify: (t) => void sent.push(t), log: () => {} });
    assert.equal(mk().tick(T0 + 3 * MIN).length, 1);
    assert.ok(fs.existsSync(alertRulesStateFile(dir)));
    assert.equal(mk().tick(T0 + 4 * MIN).length, 0, "restart: same episode");
    assert.deepEqual(sent, ["ach alert: streak"]);
  });

  it("e2e: `ach watch` evaluates an idle rule on its first poll and POSTs the hit; SIGINT exits 0", async () => {
    const rx = await receiver();
    try {
      const dir = tmpDir();
      const state = path.join(dir, "state");
      // pid = this test process: alive for the whole watch.
      const rec = live(Date.now() - 120_000, { pid: process.pid });
      writeRunRecord(state, rec);
      const cfg = path.join(dir, "config.json");
      fs.writeFileSync(cfg, JSON.stringify({ alerts: { rules: [idleRule({ destinations: [{ type: "webhook", url: rx.url }] })] } }));
      const r = await watchUntil(["--config", cfg, "watch", "--dir", path.join(dir, "empty-home")], { HOME: dir, AGENTIC_CODING_HARNESS_STATE_DIR: state }, () => rx.hits.length >= 1);
      assert.equal(r.code, 0, r.stderr);
      assert.equal(rx.hits.length, 1, r.stderr);
      assert.equal(rx.hits[0]!.json.type, "alert");
      assert.equal(rx.hits[0]!.json.runId, rec.runId);
      assert.equal(rx.hits[0]!.json.payload.metric, "idle_seconds");
      assert.match(r.stderr, /watch: alerts: 1 rule \(hung\)/);
      assert.match(r.stderr, /alert: hung fired: run [0-9a-f-]{8} \(mock\) recorded no event for \d+s \(limit 60s\) -> webhook http:\/\/127\.0\.0\.1:\d+/);
    } finally {
      await rx.close();
    }
  });
});

// ---------------------------------------------------------------- AC3: webhook payload

describe("#74 AC3: webhook destination POSTs a structured alert (run id, metric, threshold)", () => {
  it("posts the #64 envelope with type alert, the tipping run id, metric, threshold, value; signed when a secret is set", async () => {
    const rx = await receiver();
    try {
      const dir = tmpDir();
      const recs = [run("error", T0), run("error", T0 + MIN), run("error", T0 + 2 * MIN)];
      for (const r of recs) writeRunRecord(dir, r);
      const runner = createAlertRunner({
        rules: [streakRule({ destinations: [{ type: "webhook", url: rx.url }] })],
        stateDir: dir,
        env: { [EVENT_WEBHOOK_SECRET_ENV]: "s3cret" },
        log: () => {},
      });
      runner.tick(T0 + 3 * MIN);
      await runner.flush();
      assert.equal(rx.hits.length, 1);
      const h = rx.hits[0]!;
      assert.deepEqual(Object.keys(h.json).sort(), ["payload", "runId", "schemaVersion", "timestamp", "type"]);
      assert.equal(h.json.schemaVersion, 1);
      assert.equal(h.json.type, ALERT_WEBHOOK_EVENT);
      assert.equal(h.headers["x-ach-event"], "alert");
      assert.equal(h.json.runId, recs[2]!.runId);
      assert.equal(h.json.timestamp, new Date(T0 + 2 * MIN).toISOString(), "when the condition tipped");
      const p = h.json.payload;
      assert.equal(p.rule, "streak");
      assert.equal(p.ruleType, "error_rate");
      assert.equal(p.metric, "consecutive_failures");
      assert.equal(p.threshold, 3);
      assert.equal(p.value, 3);
      assert.deepEqual((p.runs as Array<{ runId: string }>).map((r) => r.runId), recs.map((r) => r.runId));
      assert.ok(verifyWebhookSignature("s3cret", h.body, h.headers[WEBHOOK_SIGNATURE_HEADER] as string), "HMAC over the raw body");
    } finally {
      await rx.close();
    }
  });

  it("`alert` is an envelope type only: a run's --webhook-events list never names it", () => {
    assert.ok(!(WEBHOOK_EVENT_TYPES as readonly string[]).includes("alert"));
  });
});

// ---------------------------------------------------------------- AC4: desktop

describe("#74 AC4: desktop destination on macOS and Linux (injected launcher)", () => {
  const fire = (platform: NodeJS.Platform, sound: boolean) => {
    const dir = tmpDir();
    writeRunRecord(dir, run("error", T0));
    const calls: Array<[string, string[]]> = [];
    createAlertRunner({
      rules: [streakRule({ consecutive: 1, destinations: [{ type: "desktop", sound }] })],
      stateDir: dir,
      platform,
      exec: (file, args) => void calls.push([file, args]),
      log: () => {},
    }).tick(T0 + MIN);
    return calls;
  };

  it("macOS: osascript display notification with the rule as title", () => {
    const calls = fire("darwin", true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]![0], "osascript");
    assert.match(calls[0]![1][1]!, /^display notification "1 consecutive failed runs \(limit 1\)" with title "ach alert: streak" sound name "default"$/);
  });

  it("Linux: notify-send title and body", () => {
    const calls = fire("linux", false);
    assert.deepEqual(calls, [["notify-send", ["--", "ach alert: streak", "1 consecutive failed runs (limit 1)"]]]);
  });

  it("other platforms: a silent no-op", () => {
    assert.deepEqual(fire("win32", false), []);
  });
});

// ---------------------------------------------------------------- fail open

describe("#74 fail open: a failing destination never changes the exit status", () => {
  it("`ach alerts --once` against a closed port exits 0 and logs the failure", async () => {
    const dir = tmpDir();
    for (const r of [run("error", T0), run("error", T0 + MIN), run("error", T0 + 2 * MIN)]) writeRunRecord(dir, r);
    const cfg = path.join(dir, "config.json");
    fs.writeFileSync(cfg, JSON.stringify({ alerts: { rules: [streakRule({ destinations: [{ type: "webhook", url: await closedPortUrl() }] })] } }));
    const r = await runCli(["--config", cfg, "alerts", "--once"], { AGENTIC_CODING_HARNESS_STATE_DIR: dir });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stderr, /alert: streak fired/);
    assert.match(r.stderr, /\[warn\] webhook: alert event for run 00000\d{3} not delivered/);
  });

  it("`ach watch` with an unreachable alert webhook still exits 0 on SIGINT", async () => {
    const dir = tmpDir();
    const state = path.join(dir, "state");
    writeRunRecord(state, live(Date.now() - 120_000, { pid: process.pid }));
    const cfg = path.join(dir, "config.json");
    fs.writeFileSync(cfg, JSON.stringify({ alerts: { rules: [idleRule({ destinations: [{ type: "webhook", url: await closedPortUrl() }] })] } }));
    const r = await watchUntil(["--config", cfg, "watch", "--dir", path.join(dir, "empty-home")], { HOME: dir, AGENTIC_CODING_HARNESS_STATE_DIR: state }, (err) => /alert: hung fired/.test(err));
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stderr, /alert: hung fired/);
    assert.match(r.stderr, /\[warn\] webhook: alert event for run \S+ not delivered/, "the bounded flush on SIGINT reports the failure");
  });

  it("--offline refuses a non-loopback alert webhook (USAGE)", async () => {
    const dir = tmpDir();
    const cfg = path.join(dir, "config.json");
    fs.writeFileSync(cfg, JSON.stringify({ alerts: { rules: [streakRule({ destinations: [{ type: "webhook", url: "https://hooks.example.com/x" }] })] } }));
    const r = await runCli(["--config", cfg, "alerts", "--once", "--offline"], { AGENTIC_CODING_HARNESS_STATE_DIR: dir });
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /--offline refuses a non-loopback webhook \(https:\/\/hooks\.example\.com\) in alert rule 'streak'/);
  });
});

// ---------------------------------------------------------------- AC5: dry run

describe("#74 AC5: --dry-run replays history and prints what would have fired", () => {
  it("replayAlertHistory: error_rate hits at history's times, cooldown applied on history's clock", () => {
    const recs = [
      run("error", T0), run("error", T0 + MIN), // hit 1 at +1m (consecutive 2)
      run("success", T0 + 2 * MIN),
      run("error", T0 + 3 * MIN), run("error", T0 + 4 * MIN), // hit 2 at +4m: inside 10m cooldown -> suppressed
      run("success", T0 + 5 * MIN),
      run("error", T0 + 20 * MIN), run("error", T0 + 21 * MIN), // hit 3 at +21m: delivered, reports 1 suppressed
    ];
    const d = replayAlertHistory({ rules: [streakRule({ consecutive: 2, cooldownSec: 600 })], records: [...recs].reverse(), eventTimes: () => [] });
    assert.deepEqual(d.map((x) => [x.hit.at - T0, x.suppressed, x.hit.suppressedSinceLastFire]), [
      [MIN, false, 0],
      [4 * MIN, true, 0],
      [21 * MIN, false, 1],
    ]);
  });

  it("replayAlertHistory: idle gaps between recorded events fire at gap start + idleSec", () => {
    const rec = run("success", T0 + 10 * MIN, { startedAt: T0 });
    const d = replayAlertHistory({ rules: [idleRule({ idleSec: 120 })], records: [rec], eventTimes: () => [T0 + 30_000, T0 + 60_000, T0 + 6 * MIN] });
    assert.deepEqual(d.map((x) => [x.hit.at - T0, x.hit.value]), [
      [60_000 + 120_000, 300], // 1m -> 6m gap
      [6 * MIN + 120_000, 240], // 6m -> 10m (end)
    ]);
  });

  it("transcriptEventTimes reads this run's chained lines only", () => {
    const dir = tmpDir();
    const file = path.join(dir, "raw", "mock-s.jsonl");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const mine = new ChainWriter("run-a");
    const other = new ChainWriter("run-b");
    fs.writeFileSync(
      file,
      [
        mine.frame(JSON.stringify({ type: "step", timestamp: T0 + 1000 })),
        other.frame(JSON.stringify({ type: "step", timestamp: T0 + 2000 })),
        mine.frame(JSON.stringify({ type: "usage", timestamp: new Date(T0 + 3000).toISOString() })),
      ].join("\n") + "\n",
    );
    const rec = { ...run("success", T0 + 5000), runId: "run-a", rawTranscript: file };
    assert.deepEqual(transcriptEventTimes(dir, rec), [T0 + 1000, T0 + 3000]);
  });

  it("e2e: `ach alerts --dry-run` prints each would-be hit with its time, sends nothing and writes no state", async () => {
    const rx = await receiver();
    try {
      const dir = tmpDir();
      const recs = [run("error", T0), run("error", T0 + MIN), run("error", T0 + 2 * MIN), run("success", T0 + 3 * MIN)];
      for (const r of recs) writeRunRecord(dir, r);
      // An idle spell, replayed from the run's raw transcript.
      const raw = path.join(dir, "raw", "mock-idle.jsonl");
      fs.mkdirSync(path.dirname(raw), { recursive: true });
      const idleRun = run("success", T0 + 30 * MIN, { startedAt: T0 + 10 * MIN, rawTranscript: raw });
      const chain = new ChainWriter(idleRun.runId);
      fs.writeFileSync(raw, [T0 + 11 * MIN, T0 + 29 * MIN].map((t) => chain.frame(JSON.stringify({ type: "step", timestamp: t }))).join("\n") + "\n");
      writeRunRecord(dir, idleRun);
      const cfg = path.join(dir, "config.json");
      fs.writeFileSync(
        cfg,
        JSON.stringify({ alerts: { rules: [streakRule({ destinations: [{ type: "webhook", url: rx.url }] }), idleRule({ idleSec: 300, destinations: [{ type: "webhook", url: rx.url }] })] } }),
      );
      const r = await runCli(["--config", cfg, "alerts", "--dry-run"], { AGENTIC_CODING_HARNESS_STATE_DIR: dir });
      assert.equal(r.code, 0, r.stderr);
      assert.match(r.stdout, /alerts: dry run over 5 runs \(no destination is contacted, no state is written\)/);
      assert.match(r.stdout, new RegExp(`^2026-06-01T00:02:00\\.000Z {2}streak {2}error_rate {2}run ${recs[2]!.runId.slice(0, 8)} {2}3 consecutive failed runs \\(limit 3\\) {2}-> webhook http://127\\.0\\.0\\.1:\\d+$`, "m"));
      assert.match(r.stdout, /^2026-06-01T00:16:00\.000Z {2}hung {2}idle {2}run \S+ {2}run \S+ \(mock\) recorded no event for 1080s \(limit 300s\)/m);
      assert.match(r.stdout, /^rule streak \(error_rate\): 1 would fire$/m);
      assert.match(r.stdout, /^rule hung \(idle\): 1 would fire$/m);
      assert.equal(rx.hits.length, 0, "a dry run sends nothing");
      assert.equal(fs.existsSync(alertRulesStateFile(dir)), false, "and writes no state");
      const j = await runCli(["--config", cfg, "alerts", "--dry-run", "--json"], { AGENTIC_CODING_HARNESS_STATE_DIR: dir });
      const doc = JSON.parse(j.stdout);
      assert.equal(doc.dryRun, true);
      assert.deepEqual(doc.hits.map((h: { rule: string; at: string }) => [h.rule, h.at]), [
        ["streak", "2026-06-01T00:02:00.000Z"],
        ["hung", "2026-06-01T00:16:00.000Z"],
      ]);
    } finally {
      await rx.close();
    }
  });
});

// ---------------------------------------------------------------- driver: lastEventAt

describe("#74 driver: RunRecord.lastEventAt marks the latest agent event", () => {
  it("a run records lastEventAt within its lifetime", async () => {
    const dir = tmpDir();
    const before = Date.now();
    await createDriver({ adapters: { null: new NullAdapter({ turns: 3 }) }, stateDir: dir, registry: { stateDir: dir } }).run("null", { prompt: "hi" });
    const [rec] = listRunRecords(dir);
    assert.ok(rec !== undefined);
    assert.equal(typeof rec.lastEventAt, "number", JSON.stringify(rec));
    assert.ok(rec.lastEventAt! >= before && rec.lastEventAt! <= Date.now());
  });
});
