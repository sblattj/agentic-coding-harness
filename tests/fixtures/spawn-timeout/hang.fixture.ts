// Run by tests/spawn-timeout.test.ts under the tests/support/spawn-timeout.mjs
// preload with a short ACH_TEST_SPAWN_TIMEOUT_MS. Not matched by the npm test glob.
import { spawnSync, execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { it } from "node:test";

it("FIXTURE hung spawnSync", () => {
  const r = spawnSync("sh", ["-c", "sleep 999"], { encoding: "utf8" });
  assert.equal(r.status, 0, `status=${r.status} signal=${r.signal} error=${(r.error as NodeJS.ErrnoException | undefined)?.code}`);
});

it("FIXTURE hung execFileSync", () => {
  execFileSync("sh", ["-c", "sleep 999"], { encoding: "utf8" });
});

it("FIXTURE explicit timeout is kept", () => {
  const t = Date.now();
  const r = spawnSync("sh", ["-c", "sleep 999"], { encoding: "utf8", timeout: 500 });
  assert.equal((r.error as NodeJS.ErrnoException | undefined)?.code, "ETIMEDOUT");
  assert.ok(Date.now() - t < 1500, `took ${Date.now() - t} ms`);
});

it("FIXTURE fast child is unaffected", () => {
  const r = spawnSync("sh", ["-c", "echo ok"], { encoding: "utf8" });
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), "ok");
});
