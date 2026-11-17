// #204: desk host metering (src/desks/host-metering.ts). Offline: pricing + stats never touch the network.
import "./support/no-network.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { alertStateFile } from "../src/core/budget-alerts.ts";
import { readRunRecord } from "../src/core/registry.ts";
import { readAllRecords } from "../src/core/store.ts";
import { createHostMeter, type UsageSample } from "../src/desks/host-metering.ts";
import type { HostSpec } from "../src/desks/types.ts";

const cli = new URL("../src/cli/ach.ts", import.meta.url).pathname;

let tmp: string;
let n = 0;
const prevEnv = process.env.AGENTIC_CODING_HARNESS_STATE_DIR;

before(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ach-desk-meter-")));
});
after(() => {
  if (prevEnv === undefined) delete process.env.AGENTIC_CODING_HARNESS_STATE_DIR;
  else process.env.AGENTIC_CODING_HARNESS_STATE_DIR = prevEnv;
  fs.rmSync(tmp, { recursive: true, force: true });
});

function mkState(): string {
  const dir = path.join(tmp, `s${n++}`);
  fs.mkdirSync(dir, { recursive: true });
  process.env.AGENTIC_CODING_HARNESS_STATE_DIR = dir;
  return dir;
}

function mkSpec(stateDir: string, over: Partial<HostSpec> = {}): HostSpec {
  return {
    stack: "default",
    stateDir,
    name: "TRIAGE",
    kind: "desk",
    role: "triage",
    roleFiles: [],
    agent: "opencode",
    engine: "opencode",
    model: "claude-sonnet-5-5",
    mcps: [],
    port: 4801,
    cwd: "/work/repo",
    runId: `run-${n++}`,
    ...over,
  };
}

function sample(over: Partial<UsageSample> = {}): UsageSample {
  return { model: "claude-sonnet-5-5", inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: null, at: Date.now(), ...over };
}

function stats(state: string): { totals: Record<string, number>; raw: string } {
  const bun = Boolean((process.versions as { bun?: string }).bun);
  const r = spawnSync(process.execPath, bun ? [cli, "stats", "--json", "--state-only"] : ["--import", "tsx", cli, "stats", "--json", "--state-only"], {
    encoding: "utf8",
    timeout: 60000,
    env: { ...process.env, HOME: state, AGENTIC_CODING_HARNESS_STATE_DIR: state, AGENTIC_CODING_HARNESS_COST_MODE: "auto", AGENTIC_CODING_HARNESS_TZ: "UTC", AGENTIC_CODING_HARNESS_PROJECT_ALIASES: "" },
  });
  assert.equal(r.status, 0, r.stderr);
  const j = JSON.parse(r.stdout) as { total: Record<string, number> };
  return { totals: j.total, raw: r.stdout };
}

describe("host meter: begin", () => {
  it("writes a schema-valid running RunRecord with desk + parentRunId", () => {
    const state = mkState();
    const spec = mkSpec(state, { kind: "lane", name: "LANE-A", parentRunId: "parent-1" });
    const m = createHostMeter(spec);
    m.begin({ sessionId: "ses_1", pid: 4242 });
    const rec = readRunRecord(state, spec.runId);
    assert.ok(rec, "record must parse through RunRecordSchema");
    assert.equal(rec.status, "running");
    assert.equal(rec.agent, "opencode");
    assert.equal(rec.sessionId, "ses_1");
    assert.equal(rec.pid, 4242);
    assert.equal(rec.cwd, "/work/repo");
    assert.equal(rec.parentRunId, "parent-1");
    assert.deepEqual(rec.desk, { stack: "default", name: "LANE-A", kind: "lane" });
    assert.equal(typeof rec.startedAt, "number");
  });

  it("a second begin (host: pid first, then sessionId) only fills the session, never resets startedAt", () => {
    const state = mkState();
    let t = 1000;
    const spec = mkSpec(state);
    const m = createHostMeter(spec, { now: () => t });
    m.begin({ pid: 7 });
    const first = readRunRecord(state, spec.runId);
    assert.ok(first);
    assert.equal(first.sessionId, undefined);
    t = 5000;
    m.begin({ sessionId: "ses_late", pid: 7 });
    const second = readRunRecord(state, spec.runId);
    assert.ok(second);
    assert.equal(second.sessionId, "ses_late");
    assert.equal(second.startedAt, first.startedAt);
    assert.equal(second.updatedAt, 5000);
  });
});

describe("host meter: token records and ach stats", () => {
  it("usage samples are readable by readAllRecords and summed by `ach stats --json`", async () => {
    const state = mkState();
    const spec = mkSpec(state);
    const m = createHostMeter(spec);
    m.begin({ sessionId: "ses_2", pid: 1 });
    m.usage(sample({ messageId: "m1", inputTokens: 1000, outputTokens: 100 }));
    m.usage(sample({ messageId: "m2", inputTokens: 2000, outputTokens: 300, cacheReadTokens: 500 }));
    const recs = await readAllRecords();
    assert.equal(recs.length, 2);
    assert.ok(recs.every((r) => r.agent === "opencode" && r.sessionId === "ses_2" && r.model === "claude-sonnet-5-5"));
    const { totals } = stats(state);
    assert.equal(totals.inputTokens, 3000);
    assert.equal(totals.outputTokens, 400);
    assert.equal(totals.cacheReadTokens, 500);
    // stats priced the unreported lines itself: sonnet-5-5 = $2/M in, $10/M out, $0.2/M cache read.
    const expected = (3000 * 2 + 400 * 10 + 500 * 0.2) / 1e6;
    assert.ok(Math.abs(totals.costUsd! - expected) < 1e-9, `costUsd ${totals.costUsd} vs ${expected}`);
  });

  it("recorded usage (driver turn runs wrote their own records) counts toward totals but writes no raw line", async () => {
    const state = mkState();
    const m = createHostMeter(mkSpec(state, { agent: "claude", engine: "driver" }));
    m.begin({ sessionId: "ses_r", pid: 1 });
    m.usage(sample({ messageId: "turn-1", inputTokens: 1000, outputTokens: 100, costUsd: 0.5, recorded: true }));
    assert.equal((await readAllRecords()).length, 0);
    assert.equal(m.totals().inputTokens, 1000);
    assert.equal(m.totals().costUsd, 0.5);
  });

  it("a repeated messageId is not double counted (deltas are written; stats sums to the latest total)", async () => {
    const state = mkState();
    const m = createHostMeter(mkSpec(state));
    m.begin({ sessionId: "ses_3", pid: 1 });
    m.usage(sample({ messageId: "m1", inputTokens: 100, outputTokens: 10 }));
    m.usage(sample({ messageId: "m1", inputTokens: 400, outputTokens: 50 }));
    m.usage(sample({ messageId: "m1", inputTokens: 400, outputTokens: 50 })); // identical re-report: no line
    assert.equal((await readAllRecords()).length, 2);
    assert.deepEqual(m.totals(), { costUsd: (400 * 2 + 50 * 10) / 1e6, inputTokens: 400, outputTokens: 50 });
    const { totals } = stats(state);
    assert.equal(totals.inputTokens, 400);
    assert.equal(totals.outputTokens, 50);
  });

  it("reported cost on a repeated message is written as a delta; stats shows the engine figure once", () => {
    const state = mkState();
    const m = createHostMeter(mkSpec(state, { model: "ferry/unpriced-thing" }));
    m.begin({ pid: 1 });
    m.usage({ ...sample({ model: "ferry/unpriced-thing", messageId: "m1", costUsd: 0.01 }), inputTokens: 10 });
    m.usage({ ...sample({ model: "ferry/unpriced-thing", messageId: "m1", costUsd: 0.04 }), inputTokens: 40 });
    assert.ok(Math.abs(m.totals().costUsd! - 0.04) < 1e-12);
    const { totals } = stats(state);
    assert.ok(Math.abs(totals.costUsd! - 0.04) < 1e-9, `costUsd ${totals.costUsd}`);
  });
});

describe("host meter: pricing", () => {
  it("costUsd null or 0 + known model -> priced by the ach pricer", () => {
    const state = mkState();
    const m = createHostMeter(mkSpec(state));
    m.begin({ pid: 1 });
    m.usage(sample({ messageId: "a", costUsd: null, inputTokens: 1_000_000, outputTokens: 0 }));
    m.usage(sample({ messageId: "b", costUsd: 0, inputTokens: 0, outputTokens: 1_000_000 }));
    assert.ok(Math.abs(m.totals().costUsd! - 12) < 1e-9);
  });

  it("unknown model -> costUsd stays null, never invented", () => {
    const state = mkState();
    const spec = mkSpec(state, { model: "ferry/no-such-model-xyz" });
    const m = createHostMeter(spec);
    m.begin({ pid: 1 });
    m.usage(sample({ model: "ferry/no-such-model-xyz", costUsd: null }));
    assert.equal(m.totals().costUsd, null);
    assert.equal(m.totals().inputTokens, 1000);
    assert.equal(m.overBudget(), false);
  });
});

describe("host meter: totals throttle, heartbeat, finish", () => {
  it("patches RunRecord totals at most once per 2 s and always on finish", () => {
    const state = mkState();
    const spec = mkSpec(state);
    let t = 1_000_000;
    const m = createHostMeter(spec, { now: () => t });
    m.begin({ sessionId: "s", pid: 1 });
    m.usage(sample({ messageId: "m1", inputTokens: 100 })); // t0: within 2 s of begin -> no patch
    assert.equal(readRunRecord(state, spec.runId)!.totals!.inputTokens, 0);
    t += 1999;
    m.usage(sample({ messageId: "m2", inputTokens: 100 }));
    assert.equal(readRunRecord(state, spec.runId)!.totals!.inputTokens, 0);
    t += 1;
    m.usage(sample({ messageId: "m3", inputTokens: 100 })); // 2000 ms since begin -> patch
    assert.equal(readRunRecord(state, spec.runId)!.totals!.inputTokens, 300);
    t += 10;
    m.usage(sample({ messageId: "m4", inputTokens: 100 })); // throttled
    assert.equal(readRunRecord(state, spec.runId)!.totals!.inputTokens, 300);
    m.finish("success");
    const fin = readRunRecord(state, spec.runId)!;
    assert.equal(fin.totals!.inputTokens, 400);
    assert.ok(fin.totals!.costUsd > 0);
  });

  it("heartbeat patches updatedAt + lastEvent (<= 200 chars)", () => {
    const state = mkState();
    const spec = mkSpec(state);
    let t = 5_000;
    const m = createHostMeter(spec, { now: () => t });
    m.begin({ pid: 1 });
    t = 9_000;
    m.heartbeat("busy", "x".repeat(500));
    const rec = readRunRecord(state, spec.runId)!;
    assert.equal(rec.updatedAt, 9_000);
    assert.equal(rec.lastEvent!.length, 200);
    assert.equal(rec.metadata!.hostState, "busy");
    assert.equal(rec.status, "running");
  });

  for (const [input, expected] of [["success", "success"], ["error", "error"], ["aborted", "aborted"]] as const) {
    it(`finish(${input}) records status ${expected}, endedAt and exitStatus`, () => {
      const state = mkState();
      const spec = mkSpec(state);
      const m = createHostMeter(spec, { now: () => 77_000 });
      m.begin({ pid: 1 });
      m.finish(input);
      const rec = readRunRecord(state, spec.runId)!;
      assert.equal(rec.status, expected);
      assert.equal(rec.exitStatus, input);
      assert.equal(rec.endedAt, 77_000);
    });
  }
});

describe("host meter: budget", () => {
  it("crossing budgetUsd -> overBudget true and exactly one recorded alert", () => {
    const state = mkState();
    const spec = mkSpec(state, { budgetUsd: 0.01 });
    const m = createHostMeter(spec);
    m.begin({ pid: 1 });
    // $2/M input: 2000 tokens = $0.004
    m.usage(sample({ messageId: "a", inputTokens: 2000, outputTokens: 0 }));
    assert.equal(m.overBudget(), false);
    m.usage(sample({ messageId: "b", inputTokens: 2000, outputTokens: 0 }));
    assert.equal(m.overBudget(), false); // $0.008
    m.usage(sample({ messageId: "c", inputTokens: 2000, outputTokens: 0 })); // $0.012
    assert.equal(m.overBudget(), true);
    m.usage(sample({ messageId: "d", inputTokens: 2000, outputTokens: 0 }));
    m.usage(sample({ messageId: "e", inputTokens: 2000, outputTokens: 0 }));
    m.finish("aborted");
    const rec = readRunRecord(state, spec.runId)!;
    assert.equal(rec.alerts?.length, 1);
    assert.equal(rec.alerts![0]!.family, "budget");
    assert.equal(rec.alerts![0]!.metric, "usd");
    assert.equal(rec.alerts![0]!.threshold, 1);
    assert.equal(rec.alerts![0]!.limit, 0.01);
    assert.ok(fs.existsSync(alertStateFile(state)), "alert cooldown state persisted via the shared engine");
    assert.equal(m.overBudget(), true);
  });

  it("no budgetUsd -> overBudget false and no alerts file", () => {
    const state = mkState();
    const spec = mkSpec(state);
    const m = createHostMeter(spec);
    m.begin({ pid: 1 });
    m.usage(sample({ inputTokens: 5_000_000 }));
    assert.equal(m.overBudget(), false);
    assert.equal(fs.existsSync(alertStateFile(state)), false);
    assert.equal(readRunRecord(state, spec.runId)!.alerts, undefined);
  });
});
