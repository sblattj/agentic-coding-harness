// PR #206 review: mixed priced/unpriced totals stay unknown, and a lost token record is visible.
import "./support/no-network.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { readRunRecord } from "../src/core/registry.ts";
import { createHostMeter, type UsageSample } from "../src/desks/host-metering.ts";
import type { HostSpec } from "../src/desks/types.ts";

let tmp: string;
let n = 0;
const prevEnv = process.env.AGENTIC_CODING_HARNESS_STATE_DIR;
before(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ach-desk-meter-mixed-")));
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
    stack: "default", stateDir, name: "TRIAGE", kind: "desk", role: "triage", roleFiles: [], agent: "opencode", engine: "opencode",
    model: "claude-sonnet-5-5", mcps: [], port: 4801, cwd: "/work/repo", runId: `run-${n++}`, ...over,
  };
}
function sample(over: Partial<UsageSample> = {}): UsageSample {
  return { model: "claude-sonnet-5-5", inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: null, at: Date.now(), ...over };
}

describe("host meter: mixed priced and unpriced usage", () => {
  it("one priced + one unpriced message -> totals().costUsd null and costUnpriced flagged (never a partial sum)", () => {
    const state = mkState();
    const spec = mkSpec(state);
    const m = createHostMeter(spec);
    m.begin({ pid: 1 });
    m.usage(sample({ messageId: "a", costUsd: 0.5 }));
    m.usage(sample({ messageId: "b", model: "ferry/no-such-model-xyz", costUsd: null }));
    assert.equal(m.totals().costUsd, null, "mixed total must be unknown");
    m.finish("success");
    assert.equal(readRunRecord(state, spec.runId)?.totals?.costUnpriced, true);
  });

  it("an unpriced message with no tokens does not poison a priced total", () => {
    const state = mkState();
    const m = createHostMeter(mkSpec(state));
    m.begin({ pid: 1 });
    m.usage(sample({ messageId: "a", costUsd: 0.5 }));
    m.usage(sample({ messageId: "z", model: "ferry/no-such-model-xyz", inputTokens: 0, outputTokens: 0 }));
    assert.equal(m.totals().costUsd, 0.5);
  });

  it("budget still trips on the known part of a mixed run", () => {
    const state = mkState();
    const m = createHostMeter(mkSpec(state, { budgetUsd: 1 }));
    m.begin({ pid: 1 });
    m.usage(sample({ messageId: "b", model: "ferry/no-such-model-xyz", costUsd: null }));
    m.usage(sample({ messageId: "a", costUsd: 2 }));
    assert.equal(m.overBudget(), true);
  });
});

describe("host meter: token record persistence failure", () => {
  it("a failed append does not throw, warns, is counted in totals() and in the run record metadata", () => {
    const state = mkState();
    fs.writeFileSync(path.join(state, "raw"), "not a dir"); // mkdirSync(raw/<agent>) now fails
    const warnings: string[] = [];
    const spec = mkSpec(state);
    const m = createHostMeter(spec, { onWarning: (w) => warnings.push(w) });
    m.begin({ pid: 1 });
    assert.doesNotThrow(() => m.usage(sample({ messageId: "a", costUsd: 0.5 })));
    assert.doesNotThrow(() => m.usage(sample({ messageId: "b", costUsd: 0.5 })));
    assert.equal(m.totals().costUsd, 1, "cost still counted in memory");
    assert.equal((m.totals() as { tokenRecordFailures?: number }).tokenRecordFailures, 2);
    assert.ok(warnings.some((w) => w.includes("could not append token record")));
    m.finish("success");
    assert.equal(readRunRecord(state, spec.runId)?.metadata?.tokenRecordFailures, 2);
  });

  it("no failure -> no tokenRecordFailures key", () => {
    const state = mkState();
    const spec = mkSpec(state);
    const m = createHostMeter(spec);
    m.begin({ pid: 1 });
    m.usage(sample({ costUsd: 0.5 }));
    m.finish("success");
    assert.equal(readRunRecord(state, spec.runId)?.metadata?.tokenRecordFailures, undefined);
  });
});
