import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { readQueueState, listQueueStates } from "../src/core/queue-state.ts";
import { scanRunRecords } from "../src/core/registry.ts";
import { absoluteExecArgv } from "../src/cli/queue.ts";

// Real processes: `ach queue run` against a temp state dir, with the
// `custom` agent running `sleep` (a long-lived detached child) and the null
// agent. Proves SIGKILL of the queue leaves the in-flight run alive, and that
// --resume finishes the plan.

const CLI = new URL("../src/cli/ach.ts", import.meta.url).pathname;
const isBun = spawnSync("bun", ["--version"], { encoding: "utf8" }).status === 0;
const exe = isBun ? "bun" : process.execPath;
const pre = isBun ? [CLI] : ["--import", "tsx", CLI];

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
async function until<T>(f: () => T | undefined | false, ms = 30_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = f();
    if (v) return v as T;
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe("ach queue (real processes)", () => {
  it("dry-run launches nothing and prints the live count", () => {
    const root = mkdtempSync(join(tmpdir(), "ach-q-dry-"));
    dirs.push(root);
    writeFileSync(join(root, "p.txt"), "hello");
    writeFileSync(join(root, "plan.txt"), `a ${root} null - p.txt --repeat 2\n`);
    const r = spawnSync(exe, [...pre, "queue", "run", join(root, "plan.txt"), "--dry-run", "--state-dir", join(root, "st")], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /live ach runs now: 0/);
    assert.match(r.stdout, /a {2}\[launch now\]/);
    assert.equal(existsSync(join(root, "st", "queues")), false);
    assert.equal(existsSync(join(root, "st", "runs")), false);
  });

  it("killing the queue does not kill the run; --resume drains and runs post", async () => {
    const root = mkdtempSync(join(tmpdir(), "ach-q-live-"));
    dirs.push(root);
    const st = join(root, "st");
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "p.txt"), "hello");
    writeFileSync(
      join(root, "plan.txt"),
      [
        `slow ${root} custom - p.txt --template "sleep 5" --prompt-stdin`,
        `fast ${root} null - p.txt --post "echo post-$ACH_SLICE_LABEL-$ACH_SLICE_STATUS > ${root}/post.out"`,
      ].join("\n") + "\n",
    );
    const q = spawn(exe, [...pre, "queue", "run", join(root, "plan.txt"), "--max-concurrent", "1", "--poll-s", "0.2", "--state-dir", st, "--quiet"], {
      stdio: "ignore",
      env: { ...process.env, AGENTIC_CODING_HARNESS_STATE_DIR: "" },
    });
    const state = await until(() => {
      const l = listQueueStates(st)[0];
      return l?.slices[0]?.pid && l.slices[0].runIds.length > 0 ? l : undefined;
    });
    const slowPid = state.slices[0]!.pid!;
    assert.equal(state.slices[1]!.status, "queued", "cap of 1 must hold fast back");
    assert.ok(alive(slowPid));

    q.kill("SIGKILL");
    await new Promise((r) => q.once("exit", r));
    assert.ok(alive(slowPid), "the detached run must survive the queue being killed");
    assert.equal(readQueueState(st, state.id)!.slices[1]!.status, "queued");

    await until(() => !alive(slowPid));
    const recs = scanRunRecords(st).records.filter((r) => r.pid === slowPid);
    assert.equal(recs.length, 1);
    assert.equal(recs[0]!.status, "success");

    const r = spawnSync(exe, [...pre, "queue", "run", "--resume", state.id, "--poll-s", "0.2", "--state-dir", st, "--quiet"], { encoding: "utf8", timeout: 60_000 });
    assert.equal(r.status, 0, r.stderr + r.stdout);
    const done = readQueueState(st, state.id)!;
    assert.equal(done.phase, "drained");
    assert.deepEqual(done.slices.map((s) => s.status), ["done", "done"]);
    assert.equal(done.slices[0]!.runIds.length, 1);
    assert.equal(readFileSync(join(root, "post.out"), "utf8").trim(), "post-fast-done");
    assert.equal(done.slices[1]!.postExit, 0);
    assert.ok(existsSync(done.slices[0]!.log) && existsSync(done.log));

    const s = spawnSync(exe, [...pre, "queue", "status", state.id, "--state-dir", st], { encoding: "utf8" });
    assert.equal(s.status, 0);
    assert.match(s.stdout, /slow\s+done/);
    assert.match(s.stdout, /fast\s+done/);
  });
});

describe("absoluteExecArgv", () => {
  it("makes bare --import/--require specifiers absolute so a slice cwd cannot break them", () => {
    const out = absoluteExecArgv(["--import", "tsx", "--require=tsx/cjs", "--import", "./local.mjs", "--no-warnings"], process.cwd());
    assert.match(out[1]!, /^file:\/\/.*\/tsx\//);
    assert.match(out[2]!, /^--require=\/.*tsx/);
    assert.deepEqual(out.slice(3), ["--import", "./local.mjs", "--no-warnings"]);
  });
  it("leaves an unresolvable specifier unchanged", () => {
    assert.deepEqual(absoluteExecArgv(["--import", "no-such-pkg-ach-test"]), ["--import", "no-such-pkg-ach-test"]);
  });
});
