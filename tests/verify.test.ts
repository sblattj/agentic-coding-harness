// Post-run verifier (#29): `ach run --verify 'cmd'` executes the checker in
// the run's cwd after the agent exits and records the outcome. These tests
// drive the pure runner directly with real /bin/sh commands (no agent CLI).
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { VerifyResultSchema, isVerifyPass, runVerifier } from "../src/core/verify.ts";

describe("runVerifier", () => {
  it("'true' records pass with exitCode 0", async () => {
    const v = await runVerifier({ command: "true", cwd: os.tmpdir() });
    assert.equal(v.status, "pass");
    assert.equal(v.exitCode, 0);
    assert.equal(v.timedOut, false);
    assert.equal(v.command, "true");
    assert.ok(v.durationMs >= 0);
    assert.equal(isVerifyPass(v), true);
    assert.ok(VerifyResultSchema.safeParse(v).success);
  });

  it("'false' records fail with exitCode 1", async () => {
    const v = await runVerifier({ command: "false", cwd: os.tmpdir() });
    assert.equal(v.status, "fail");
    assert.equal(v.exitCode, 1);
    assert.equal(v.timedOut, false);
    assert.equal(isVerifyPass(v), false);
  });

  it("runs in the given cwd and keeps the tail of combined output", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ach-verify-"));
    await fs.writeFile(path.join(dir, "marker.txt"), "here");
    const v = await runVerifier({
      command: "cat marker.txt; echo to-stderr 1>&2; exit 3",
      cwd: dir,
      tailBytes: 64,
    });
    assert.equal(v.status, "fail");
    assert.equal(v.exitCode, 3);
    assert.match(v.outputTail ?? "", /here/);
    assert.match(v.outputTail ?? "", /to-stderr/);
  });

  it("truncates the output tail to the last tailBytes", async () => {
    const v = await runVerifier({
      command: "i=0; while [ $i -lt 200 ]; do echo line-$i; i=$((i+1)); done",
      cwd: os.tmpdir(),
      tailBytes: 20,
    });
    assert.equal(v.status, "pass");
    assert.ok((v.outputTail ?? "").length <= 20, JSON.stringify(v.outputTail));
    assert.match(v.outputTail ?? "", /line-199\n$/);
  });

  it("kills a verifier past timeoutMs: status error, timedOut true", async () => {
    const t0 = Date.now();
    const v = await runVerifier({ command: "sleep 5; echo never", cwd: os.tmpdir(), timeoutMs: 200 });
    assert.equal(v.status, "error");
    assert.equal(v.timedOut, true);
    assert.equal(v.exitCode, null);
    assert.ok(Date.now() - t0 < 4000, "verifier was not killed promptly");
    assert.doesNotMatch(v.outputTail ?? "", /never/);
  });

  it("a missing cwd is an error, never a pass or a throw", async () => {
    const v = await runVerifier({ command: "true", cwd: "/nonexistent/ach-verify-cwd" });
    assert.equal(v.status, "error");
    assert.equal(v.timedOut, false);
    assert.match(v.error ?? "", /cwd/);
  });

  it("inherits the given env", async () => {
    const v = await runVerifier({
      command: 'test "$ACH_VERIFY_PROBE" = yes',
      cwd: os.tmpdir(),
      env: { ...process.env, ACH_VERIFY_PROBE: "yes" },
    });
    assert.equal(v.status, "pass");
  });
});
