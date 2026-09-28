// `ach run --verify` (#29), `--repeat N` / `--parallel K` (#57), the
// per-repeat-group `ach stats` rollup, and `ach regrade` (#89), end to end
// through the real CLI entry point. The agent is a fake kiro-cli shell script
// (KIRO_CLI_BIN) with the MITM tap forced off — no network, no real agent.
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { frame } from "../src/cli/dash.ts";
import type { RunRecord } from "../src/core/registry.ts";
import { writeShStub } from "./helpers/stub-bin.ts";

const CLI = fileURLToPath(new URL("../src/cli/ach.ts", import.meta.url));

interface RunOut {
  code: number;
  stdout: string;
  stderr: string;
}

function runCli(args: string[], env: Record<string, string>, cwd?: string): RunOut {
  const isBun = (process.versions as { bun?: string }).bun !== undefined;
  // `--import tsx` resolves from the child's cwd; some tests run the CLI in a
  // scratch workspace, so hand node the loader's absolute URL instead.
  const p = spawnSync(process.execPath, isBun ? [CLI, ...args] : ["--import", import.meta.resolve("tsx"), CLI, ...args], {
    env: { ...process.env, ...env },
    encoding: "utf8",
    ...(cwd !== undefined ? { cwd } : {}),
  });
  return { code: p.status ?? -1, stdout: p.stdout ?? "", stderr: p.stderr ?? "" };
}

let root: string;
let home: string;

before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "ach-trials-"));
  home = await fs.mkdtemp(path.join(os.tmpdir(), "ach-trials-home-"));
});
after(async () => {
  await fs.rm(root, { recursive: true, force: true });
  await fs.rm(home, { recursive: true, force: true });
});

/** A fake kiro-cli. `probeDir` collects: args.log (one line per launch),
 *  concurrency.log (active launches seen at start), count (launch counter).
 *  `failOn` makes the Nth launch exit 1. */
async function fakeKiro(name: string, opts: { sleep?: number; failOn?: number } = {}): Promise<{ bin: string; probe: string }> {
  const probe = path.join(root, `${name}-probe`);
  await fs.mkdir(probe, { recursive: true });
  const bin = path.join(root, `${name}.sh`);
  const lines = [
    "#!/bin/sh",
    'if [ "$1" = "--version" ]; then echo "kiro-cli 2.21.2"; exit 0; fi',
    `probe="${probe}"`,
    'mkdir "$probe/lock" 2>/dev/null || sleep 0.05',
    'c=$(cat "$probe/count" 2>/dev/null || echo 0); c=$((c+1)); echo "$c" > "$probe/count"',
    'rmdir "$probe/lock" 2>/dev/null',
    'echo "$*" >> "$probe/args.log"',
    'touch "$probe/active.$$"',
    'ls "$probe" | grep -c "^active\\." >> "$probe/concurrency.log"',
    `sleep ${opts.sleep ?? 0}`,
    'rm -f "$probe/active.$$"',
    `echo '{"type":"session_start","sessionId":"sess-'$$'"}'`,
    `echo '{"type":"assistant","text":"done"}'`,
    opts.failOn !== undefined ? `if [ "$c" -eq ${opts.failOn} ]; then exit 1; fi` : "",
    "exit 0",
    "",
  ];
  writeShStub(bin, lines.join("\n"));
  return { bin, probe };
}

async function newState(name: string): Promise<string> {
  const dir = path.join(root, `${name}-state`);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

function env(stateDir: string, bin: string): Record<string, string> {
  return {
    AGENTIC_CODING_HARNESS_STATE_DIR: stateDir,
    HOME: home,
    KIRO_CLI_BIN: bin,
    MITMDUMP_BIN: "/nonexistent/mitmdump", // deterministic tap-off degrade
  };
}

async function records(stateDir: string): Promise<Array<Record<string, unknown>>> {
  const dir = path.join(stateDir, "runs");
  const names = (await fs.readdir(dir)).filter((n) => n.endsWith(".json"));
  return Promise.all(names.map(async (n) => JSON.parse(await fs.readFile(path.join(dir, n), "utf8"))));
}

describe("ach run --verify", () => {
  it("--verify 'true' records pass; the agent exitStatus is untouched", async () => {
    const { bin } = await fakeKiro("v-true");
    const state = await newState("v-true");
    const r = runCli(["run", "--agent", "kiro", "--verify", "true", "--json", "hi"], env(state, bin));
    assert.equal(r.code, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.exitStatus, "success");
    assert.equal(out.verify.status, "pass");
    assert.equal(out.verify.exitCode, 0);
    const [rec] = await records(state);
    assert.equal((rec!.verify as { status: string }).status, "pass");
    assert.equal(rec!.exitStatus, "success");
    assert.equal(rec!.status, "success");
  });

  it("--verify 'false' records fail with exitCode 1 and the CLI exits 1", async () => {
    const { bin } = await fakeKiro("v-false");
    const state = await newState("v-false");
    const r = runCli(["run", "--agent", "kiro", "--verify", "false", "hi"], env(state, bin));
    assert.equal(r.code, 1, r.stderr);
    assert.match(r.stdout, /^exit       success$/m);
    assert.match(r.stdout, /^verify     fail \(exit 1,/m);
    const [rec] = await records(state);
    const v = rec!.verify as { status: string; exitCode: number };
    assert.equal(v.status, "fail");
    assert.equal(v.exitCode, 1);
    assert.equal(rec!.exitStatus, "success");
  });

  it("a verifier past --verify-timeout-ms is killed: status error, timedOut true", async () => {
    const { bin } = await fakeKiro("v-timeout");
    const state = await newState("v-timeout");
    const r = runCli(
      ["run", "--agent", "kiro", "--verify", "sleep 5", "--verify-timeout-ms", "200", "hi"],
      env(state, bin),
    );
    assert.equal(r.code, 1, r.stderr);
    const [rec] = await records(state);
    const v = rec!.verify as { status: string; timedOut: boolean };
    assert.equal(v.status, "error");
    assert.equal(v.timedOut, true);
    assert.equal(rec!.exitStatus, "success");
  });

  it("the verifier runs in the run's cwd", async () => {
    const { bin } = await fakeKiro("v-cwd");
    const state = await newState("v-cwd");
    const work = path.join(root, "v-cwd-work");
    await fs.mkdir(work, { recursive: true });
    await fs.writeFile(path.join(work, "built.txt"), "ok");
    const r = runCli(["run", "--agent", "kiro", "--verify", "test -f built.txt", "hi"], env(state, bin), work);
    assert.equal(r.code, 0, r.stderr);
  });

  it("without --verify: no verify key on the record or the JSON, same exit code", async () => {
    const { bin } = await fakeKiro("v-none");
    const state = await newState("v-none");
    const r = runCli(["run", "--agent", "kiro", "--json", "hi"], env(state, bin));
    assert.equal(r.code, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal("verify" in out, false);
    assert.equal("repeat" in out, false);
    const [rec] = await records(state);
    assert.equal("verify" in rec!, false);
    assert.equal("repeat" in rec!, false);
    assert.equal("experiment" in rec!, false);
  });

  it("--verify-timeout-ms without --verify is a usage error", () => {
    const r = runCli(["run", "--agent", "kiro", "--verify-timeout-ms", "5", "hi"], { HOME: home });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /--verify-timeout-ms requires --verify/);
  });
});

describe("ach run --repeat", () => {
  it("--repeat 5 → 5 records sharing one group, indices 0..4, fresh sessions", async () => {
    const { bin, probe } = await fakeKiro("rep5");
    const state = await newState("rep5");
    const r = runCli(
      ["run", "--agent", "kiro", "--repeat", "5", "--experiment", "exp1", "--variant", "vA", "demo prompt"],
      env(state, bin),
    );
    assert.equal(r.code, 0, r.stderr);
    const recs = await records(state);
    assert.equal(recs.length, 5);
    const groups = new Set(recs.map((x) => (x.repeat as { group: string }).group));
    assert.equal(groups.size, 1);
    assert.deepEqual(
      recs.map((x) => (x.repeat as { index: number }).index).sort(),
      [0, 1, 2, 3, 4],
    );
    for (const x of recs) {
      assert.equal((x.repeat as { count: number }).count, 5);
      assert.equal(x.experiment, "exp1");
      assert.equal(x.variant, "vA");
    }
    // Fresh sessions: five distinct session ids, and no launch resumed one.
    assert.equal(new Set(recs.map((x) => x.sessionId)).size, 5);
    const args = readFileSync(path.join(probe, "args.log"), "utf8").trim().split("\n");
    assert.equal(args.length, 5);
    for (const a of args) assert.doesNotMatch(a, /resume/);
    assert.match(r.stdout, /^repeat     5 attempted · 5 succeeded$/m);
  });

  it("a failing child does not stop the rest; the group exit reflects the aggregate", async () => {
    const { bin } = await fakeKiro("repfail", { failOn: 2 });
    const state = await newState("repfail");
    const r = runCli(["run", "--agent", "kiro", "--repeat", "4", "--verify", "true", "hi"], env(state, bin));
    assert.equal(r.code, 1, r.stderr);
    const recs = await records(state);
    assert.equal(recs.length, 4);
    assert.equal(recs.filter((x) => x.exitStatus === "success").length, 3);
    assert.match(r.stdout, /^repeat     4 attempted · 3 succeeded · 4\/4 verified pass$/m);
  });

  it("--parallel 3 --repeat 6 never exceeds 3 concurrent agent processes", async () => {
    const { bin, probe } = await fakeKiro("par", { sleep: 0.4 });
    const state = await newState("par");
    const r = runCli(["run", "--agent", "kiro", "--repeat", "6", "--parallel", "3", "hi"], env(state, bin));
    assert.equal(r.code, 0, r.stderr);
    const seen = readFileSync(path.join(probe, "concurrency.log"), "utf8").trim().split("\n").map(Number);
    assert.equal(seen.length, 6);
    assert.ok(Math.max(...seen) <= 3, `max concurrency ${Math.max(...seen)}`);
    assert.ok(Math.max(...seen) >= 2, "parallel children never overlapped");
    assert.equal((await records(state)).length, 6);
  });

  it("--json --repeat emits one envelope with every child result", async () => {
    const { bin } = await fakeKiro("repjson");
    const state = await newState("repjson");
    const r = runCli(["run", "--agent", "kiro", "--repeat", "2", "--verify", "true", "--json", "hi"], env(state, bin));
    assert.equal(r.code, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.repeat.count, 2);
    assert.equal(out.repeat.attempted, 2);
    assert.equal(out.repeat.succeeded, 2);
    assert.equal(out.runs.length, 2);
    assert.equal(out.runs[1].repeat.index, 1);
    assert.equal(out.runs[0].verify.status, "pass");
    assert.equal(out.stats.k, 2);
    assert.equal(out.stats.passAt1, 1);
  });

  it("usage errors: --repeat 0, --parallel without --repeat, --repeat with --resume", () => {
    let r = runCli(["run", "--agent", "kiro", "--repeat", "0", "hi"], { HOME: home });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /--repeat expects a positive integer/);
    r = runCli(["run", "--agent", "kiro", "--parallel", "2", "hi"], { HOME: home });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /--parallel requires --repeat/);
    r = runCli(["run", "--agent", "kiro", "--repeat", "2", "--resume", "s1", "hi"], { HOME: home });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /--repeat starts fresh sessions/);
  });

  it("ach stats reports a per-repeat-group rollup", async () => {
    const { bin } = await fakeKiro("repstats", { failOn: 1 });
    const state = await newState("repstats");
    runCli(["run", "--agent", "kiro", "--repeat", "3", "--verify", "true", "hi"], env(state, bin));
    const r = runCli(["stats", "--json", "--state-only"], env(state, bin));
    assert.equal(r.code, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.byRepeatGroup.length, 1);
    const g = out.byRepeatGroup[0];
    assert.equal(g.agent, "kiro");
    assert.equal(g.count, 3);
    assert.equal(g.runs, 3);
    assert.equal(g.succeeded, 2);
    assert.equal(g.stats.k, 3);
    const text = runCli(["stats", "--state-only"], env(state, bin));
    assert.match(text.stdout, /^repeat {4}\S{8} agent=kiro runs=3\/3 succeeded=2 pass=3\/3/m);
  });
});

describe("ach regrade (#89)", () => {
  it("appends a regrade verdict without launching an agent; the run-time verdict and transcript are unchanged", async () => {
    const { bin, probe } = await fakeKiro("regrade");
    const state = await newState("regrade");
    const work = path.join(root, "regrade-work");
    await fs.mkdir(work, { recursive: true });
    let r = runCli(["run", "--agent", "kiro", "--verify", "false", "--json", "hi"], env(state, bin), work);
    assert.equal(r.code, 1);
    const [before0] = await records(state);
    const trialResult = r.stdout;
    const trialDir = path.join(root, "regrade-trials");
    await fs.mkdir(trialDir);
    await fs.writeFile(path.join(trialDir, "kiro.json"), trialResult);
    const runId = before0!.runId as string;
    const transcript = before0!.rawTranscript as string;
    const transcriptBefore = await fs.readFile(transcript);
    const launchesBefore = readFileSync(path.join(probe, "count"), "utf8");

    r = runCli(["regrade", runId, "--verify", "true"], env(state, bin));
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /^verify     pass \(exit 0,/m);
    r = runCli(["regrade", runId, "--verifier", "true", "--json"], env(state, bin));
    assert.equal(r.code, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).status, "pass");

    const [after0] = await records(state);
    assert.equal((after0!.verify as { status: string }).status, "fail"); // never rewritten
    const regrades = after0!.regrades as Array<{ status: string; command: string; exitCode: number }>;
    assert.equal(regrades.length, 2);
    assert.deepEqual(regrades.map((g) => [g.status, g.exitCode, g.command]), [["pass", 0, "true"], ["pass", 0, "true"]]);
    assert.deepEqual(await fs.readFile(transcript), transcriptBefore);
    assert.equal(readFileSync(path.join(probe, "count"), "utf8"), launchesBefore); // no agent launched
    assert.deepEqual(after0!.verify, before0!.verify);
    const reportFile = path.join(root, "regraded-report.html");
    const report = runCli(["report", trialDir, "--out", reportFile], env(state, bin));
    assert.equal(report.code, 0, report.stderr);
    const html = await fs.readFile(reportFile, "utf8");
    assert.match(html, /score history/);
    assert.match(html, /<td>original<\/td>/);
    assert.match(html, /<td>regrade 1<\/td>/);
    assert.match(html, /<td>regrade 2<\/td>/);
    assert.match(html, /<td>false<\/td>/);
    assert.equal(await fs.readFile(path.join(trialDir, "kiro.json"), "utf8"), trialResult);
    const dash = runCli(["dash", "--all"], env(state, bin));
    assert.equal(dash.code, 0, dash.stderr);
    assert.equal(JSON.parse(dash.stdout)[0].regrades.length, 2);
    assert.match(frame([after0 as unknown as RunRecord], state, true, 120, false), /original=fail latest=pass regrades=2/);
  });

  it("a run whose workspace is gone fails with a clear error, not a crash", async () => {
    const { bin } = await fakeKiro("regrade-gone");
    const state = await newState("regrade-gone");
    const work = path.join(root, "regrade-gone-work");
    await fs.mkdir(work, { recursive: true });
    runCli(["run", "--agent", "kiro", "hi"], env(state, bin), work);
    const [rec] = await records(state);
    await fs.rm(work, { recursive: true, force: true });
    const r = runCli(["regrade", rec!.runId as string, "--verify", "true"], env(state, bin));
    assert.equal(r.code, 1);
    assert.match(r.stderr, /workspace .* no longer exists/);
    assert.doesNotMatch(r.stderr, /\n\s+at /);
  });

  it("an unknown run id is a clear error", async () => {
    const state = await newState("regrade-unknown");
    const r = runCli(["regrade", "nope", "--verify", "true"], { AGENTIC_CODING_HARNESS_STATE_DIR: state, HOME: home });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /no run record 'nope'/);
  });
});
