// desk-host delta lines (costUsd 0 on a line that only adds tokens to an engine-priced message) must not count
// as cost disagreements; a genuine engine-vs-computed mismatch on the same kind of message still must.
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
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ach-desks-cost-")));
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

function stats(state: string, mode = "auto"): { total: Record<string, number>; stderr: string } {
  const bun = Boolean((process.versions as { bun?: string }).bun);
  const r = spawnSync(process.execPath, bun ? [cli, "stats", "--json", "--state-only"] : ["--import", "tsx", cli, "stats", "--json", "--state-only"], {
    encoding: "utf8",
    timeout: 60000,
    env: { ...process.env, HOME: state, AGENTIC_CODING_HARNESS_STATE_DIR: state, AGENTIC_CODING_HARNESS_COST_MODE: mode, AGENTIC_CODING_HARNESS_TZ: "UTC", AGENTIC_CODING_HARNESS_PROJECT_ALIASES: "" },
  });
  assert.equal(r.status, 0, r.stderr);
  return { total: (JSON.parse(r.stdout) as { total: Record<string, number> }).total, stderr: r.stderr };
}

/** The bundled price of 2000 input + 100 output tokens of the model, read from `stats` itself (calculate mode). */
function computedPrice(): number {
  const state = mkState();
  const m = createHostMeter(mkSpec(state));
  m.begin({ sessionId: "ses_fixG_price", pid: 1 });
  m.usage(sample({ messageId: "p1", inputTokens: 2000, outputTokens: 100 }));
  const c = stats(state, "calculate").total.costUsd!;
  assert.ok(c > 0, `model is priced (${c})`);
  return c;
}

describe("cost disagreements on desk delta lines", () => {
  let price = 0;
  before(() => {
    price = computedPrice();
  });

  it("an engine figure that matches the computed price, spread as cost + a token-only delta line: no disagreement", () => {
    const state = mkState();
    const m = createHostMeter(mkSpec(state));
    m.begin({ sessionId: "ses_fixG_1", pid: 1 });
    m.usage(sample({ messageId: "m1", costUsd: price, inputTokens: 1000, outputTokens: 100 }));
    m.usage(sample({ messageId: "m1", costUsd: price, inputTokens: 2000, outputTokens: 100 })); // costUsd 0 delta line
    const raw = fs.readFileSync(path.join(state, "raw", "opencode", "ses_fixG_1.jsonl"), "utf8");
    assert.match(raw, /"costUsd":0[,}]/, "precondition: a delta line with costUsd 0 was written");
    const { total, stderr } = stats(state);
    assert.equal(total.costDisagreements, 0, `no disagreement expected; stderr: ${stderr}`);
    assert.ok(Math.abs(total.costUsd! - price) < 1e-9, "stats still shows the engine figure");
  });

  it("an engine figure twice the computed price across the same two lines: exactly one disagreement", () => {
    const state = mkState();
    const m = createHostMeter(mkSpec(state));
    m.begin({ sessionId: "ses_fixG_2", pid: 1 });
    m.usage(sample({ messageId: "m1", costUsd: 2 * price, inputTokens: 1000, outputTokens: 100 }));
    m.usage(sample({ messageId: "m1", costUsd: 2 * price, inputTokens: 2000, outputTokens: 100 }));
    const { total, stderr } = stats(state);
    assert.equal(total.costDisagreements, 1, `one per message; stderr: ${stderr}`);
    assert.match(stderr, /cost disagreement: opencode session=ses_fixG_2/);
  });
});
