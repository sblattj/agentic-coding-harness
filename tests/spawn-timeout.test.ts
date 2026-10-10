// The npm test preload (tests/support/spawn-timeout.mjs) must turn a hung
// synchronous child into a failure of the test that spawned it, and leave
// explicit timeouts and fast children alone.
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { it } from "node:test";

const PRELOAD = fileURLToPath(new URL("./support/spawn-timeout.mjs", import.meta.url));
const FIXTURE = fileURLToPath(new URL("./fixtures/spawn-timeout/hang.fixture.ts", import.meta.url));
// The outer runner sets NODE_TEST_CONTEXT, which makes a nested `--test` run
// print nothing; drop it so the fixture reports with the spec reporter.
function childEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ACH_TEST_SPAWN_TIMEOUT_MS: "2000" };
  delete env.NODE_TEST_CONTEXT;
  return env;
}

const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";

it("a hung child fails the test that spawned it, by name", { skip: isBun ? "node:test runner only" : false, timeout: 60_000 }, () => {
  const r = spawnSync(
    process.execPath,
    ["--import", "tsx", "--import", PRELOAD, "--test", "--test-reporter=spec", FIXTURE],
    { encoding: "utf8", timeout: 50_000, env: childEnv() },
  );
  const out = `${r.stdout}\n${r.stderr}`;
  assert.equal(r.error, undefined, `runner itself did not finish: ${r.error?.message}`);
  assert.match(out, /✖ FIXTURE hung spawnSync/);
  assert.match(out, /✖ FIXTURE hung execFileSync/);
  assert.match(out, /✔ FIXTURE explicit timeout is kept/);
  assert.match(out, /✔ FIXTURE fast child is unaffected/);
  assert.match(out, /\[spawn-timeout\] hang\.fixture\.ts: child timed out after 2000 ms and was killed: sh -c sleep 999/);
  assert.match(out, /ℹ fail 2/);
});
