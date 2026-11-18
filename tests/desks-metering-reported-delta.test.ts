// prxref #208 finding: a repeated message with the SAME reported cost but more tokens must not be repriced by stats.
// Offline: pricing + stats never touch the network.
import "./support/no-network.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { createHostMeter, type UsageSample } from "../src/desks/host-metering.ts";
import type { HostSpec } from "../src/desks/types.ts";

const cli = new URL("../src/cli/ach.ts", import.meta.url).pathname;

let tmp: string;
let n = 0;
const prevEnv = process.env.AGENTIC_CODING_HARNESS_STATE_DIR;

before(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ach-desks-meter-")));
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

function mkSpec(stateDir: string): HostSpec {
  return {
    stack: "default", stateDir, name: "TRIAGE", kind: "desk", role: "triage", roleFiles: [],
    agent: "opencode", engine: "opencode", model: "claude-sonnet-5-5", mcps: [], port: 4801,
    cwd: "/work/repo", runId: `run-${n++}`,
  };
}

function sample(over: Partial<UsageSample> = {}): UsageSample {
  return { model: "claude-sonnet-5-5", inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: null, at: Date.now(), ...over };
}

function stats(state: string): Record<string, number> {
  const bun = Boolean((process.versions as { bun?: string }).bun);
  const r = spawnSync(process.execPath, bun ? [cli, "stats", "--json", "--state-only"] : ["--import", "tsx", cli, "stats", "--json", "--state-only"], {
    encoding: "utf8",
    timeout: 60000,
    env: { ...process.env, HOME: state, AGENTIC_CODING_HARNESS_STATE_DIR: state, AGENTIC_CODING_HARNESS_COST_MODE: "auto", AGENTIC_CODING_HARNESS_TZ: "UTC", AGENTIC_CODING_HARNESS_PROJECT_ALIASES: "" },
  });
  assert.equal(r.status, 0, r.stderr);
  return (JSON.parse(r.stdout) as { total: Record<string, number> }).total;
}

describe("host meter: reported cost covers later token growth (priceable model)", () => {
  it("same reported cost + more tokens: stats shows the engine figure once, tokens still sum", () => {
    const state = mkState();
    const m = createHostMeter(mkSpec(state));
    m.begin({ sessionId: "ses_fixA_1", pid: 1 });
    m.usage(sample({ messageId: "m1", costUsd: 0.5, inputTokens: 1000, outputTokens: 100 }));
    m.usage(sample({ messageId: "m1", costUsd: 0.5, inputTokens: 2000, outputTokens: 100 }));
    assert.equal(m.totals().costUsd, 0.5);
    const total = stats(state);
    assert.equal(total.inputTokens, 2000);
    assert.equal(total.outputTokens, 100);
    assert.ok(Math.abs(total.costUsd! - 0.5) < 1e-9, `stats costUsd ${total.costUsd} vs 0.5`);
  });

  it("a later sample without a reported cost keeps the message engine-priced", () => {
    const state = mkState();
    const m = createHostMeter(mkSpec(state));
    m.begin({ sessionId: "ses_fixA_2", pid: 1 });
    m.usage(sample({ messageId: "m1", costUsd: 0.5, inputTokens: 1000, outputTokens: 100 }));
    m.usage(sample({ messageId: "m1", costUsd: null, inputTokens: 3000, outputTokens: 100 }));
    assert.equal(m.totals().costUsd, 0.5);
    const total = stats(state);
    assert.equal(total.inputTokens, 3000);
    assert.ok(Math.abs(total.costUsd! - 0.5) < 1e-9, `stats costUsd ${total.costUsd} vs 0.5`);
  });

  it("a reported cost that arrives late is not added on top of the stats price of the earlier lines", () => {
    const state = mkState();
    const m = createHostMeter(mkSpec(state));
    m.begin({ sessionId: "ses_fixA_3", pid: 1 });
    // First sample is unreported: its line carries no costUsd, so stats prices those tokens itself.
    m.usage(sample({ messageId: "m1", costUsd: null, inputTokens: 1000, outputTokens: 100 }));
    const early = stats(state).costUsd!;
    assert.ok(early > 0, "the model must be priceable for this test to mean anything");
    m.usage(sample({ messageId: "m1", costUsd: 0.5, inputTokens: 2000, outputTokens: 100 }));
    assert.equal(m.totals().costUsd, 0.5);
    const total = stats(state);
    assert.equal(total.inputTokens, 2000);
    assert.ok(Math.abs(total.costUsd! - 0.5) < 1e-9, `stats costUsd ${total.costUsd} vs 0.5 (early price ${early} counted twice?)`);
  });

  it("a late reported cost BELOW the earlier stats estimate still sums to the reported figure", () => {
    const state = mkState();
    const m = createHostMeter(mkSpec(state));
    m.begin({ sessionId: "ses_fixA_4", pid: 1 });
    m.usage(sample({ messageId: "m1", costUsd: null, inputTokens: 100000, outputTokens: 10000 }));
    const early = stats(state).costUsd!;
    const reported = early / 4;
    assert.ok(reported > 0 && reported < early, `estimate ${early} must exceed the reported ${reported}`);
    m.usage(sample({ messageId: "m1", costUsd: reported, inputTokens: 100000, outputTokens: 10000 }));
    assert.ok(Math.abs(m.totals().costUsd! - reported) < 1e-12);
    const total = stats(state);
    assert.equal(total.inputTokens, 100000);
    assert.ok(Math.abs(total.costUsd! - reported) < 1e-9, `stats costUsd ${total.costUsd} vs reported ${reported} (estimate ${early})`);
  });
});
