// `ach run --repeat N` group exit codes (docs/EXIT-CODES.md, "Repeat
// groups"): each child is scored with the single-run rule, and the group
// exits with the most severe child code: 1 > 20 > 11 > 10 > 0. A child whose
// launch threw UNAVAILABLE scores 20 under the ladder, exactly as a single
// `ach run` does, not 1.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { repeatExitCode } from "../src/cli/exit-codes.ts";
import { runRepeatGroup, type TrialOutcome } from "../src/cli/trials.ts";
import { HarnessError, type ExitStatus, type RunResult } from "../src/core/types.ts";

function result(exitStatus: ExitStatus, over: Partial<RunResult> = {}): RunResult {
  return { runId: "r", sessionId: "s", events: [], tokens: [], warnings: [], durationMs: 1, exitStatus, totalCost: 0, ...over };
}
const ok = (r: RunResult, verify?: "pass" | "fail"): TrialOutcome => ({
  index: 0,
  result: r,
  ...(verify !== undefined ? { verify: { status: verify } as TrialOutcome["verify"] } : {}),
});
const ladder = { mode: "ladder" as const, budget: { usd: 1 } };
const binary = { mode: "binary" as const, budget: { usd: 1 } };

describe("repeatExitCode", () => {
  it("all children ok -> 0 in both modes", () => {
    const os = [ok(result("success")), ok(result("success"))];
    assert.equal(repeatExitCode(os, ladder), 0);
    assert.equal(repeatExitCode(os, binary), 0);
  });

  it("most severe child wins: 1 > 20 > 11 > 10", () => {
    const near = ok(result("success", { totalCost: 0.9 }));
    const hit = ok(result("success", { totalCost: 1.1 }));
    const unavailable = ok(result("unavailable"));
    const failed = ok(result("error"));
    assert.equal(repeatExitCode([ok(result("success")), near], ladder), 10);
    assert.equal(repeatExitCode([near, hit], ladder), 11);
    assert.equal(repeatExitCode([hit, unavailable], ladder), 20);
    assert.equal(repeatExitCode([unavailable, failed, hit], ladder), 1);
  });

  it("a failed verifier is a task failure (1) and beats near-limit / limit-hit codes", () => {
    const hitButFailedCheck = ok(result("success", { totalCost: 1.1 }), "fail");
    assert.equal(repeatExitCode([hitButFailedCheck], ladder), 1);
    assert.equal(repeatExitCode([ok(result("unavailable")), hitButFailedCheck], ladder), 1);
    assert.equal(repeatExitCode([ok(result("success"), "pass")], ladder), 0);
  });

  it("a child whose launch threw UNAVAILABLE scores 20 under the ladder, 1 in binary", () => {
    const threw: TrialOutcome = { index: 0, error: "agent unavailable", errorCode: "UNAVAILABLE" };
    assert.equal(repeatExitCode([ok(result("success")), threw], ladder), 20);
    assert.equal(repeatExitCode([threw], binary), 1);
  });

  it("any other thrown child scores 1", () => {
    const threw: TrialOutcome = { index: 0, error: "boom", errorCode: "RUN_FAILED" };
    assert.equal(repeatExitCode([ok(result("unavailable")), threw], ladder), 1);
    assert.equal(repeatExitCode([{ index: 0, error: "boom" }], ladder), 1);
  });

  it("binary mode stays 0/1", () => {
    assert.equal(repeatExitCode([ok(result("success", { totalCost: 1.1 }))], binary), 0);
    assert.equal(repeatExitCode([ok(result("unavailable"))], binary), 1);
  });
});

describe("runRepeatGroup keeps the launch error code", () => {
  it("records errorCode UNAVAILABLE when driver.run throws an UNAVAILABLE HarnessError", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "ach-repeat-exit-"));
    try {
      const driver = {
        run: async (): Promise<RunResult> => {
          throw new HarnessError('agent "x" unavailable: spawn ENOENT', "UNAVAILABLE");
        },
      };
      const { outcomes } = await runRepeatGroup({ driver, agent: "x", spec: { prompt: "hi" }, stateDir, count: 2 });
      assert.equal(outcomes.length, 2);
      for (const o of outcomes) {
        assert.equal(o.errorCode, "UNAVAILABLE");
        assert.match(o.error ?? "", /unavailable/);
      }
      assert.equal(repeatExitCode(outcomes, { mode: "ladder" }), 20);
      assert.equal(repeatExitCode(outcomes, { mode: "binary" }), 1);
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });
});
