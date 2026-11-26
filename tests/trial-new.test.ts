// Task scaffolding (#88): `ach trial new <name> [--with-tests]`. Every test
// scaffolds into its own temp directory (never the repo's tasks/) and runs
// only the deterministic `null` adapter, against a temp state dir.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { loadTaskDir } from "../src/cli/trial-matrix.ts";
import { expectFailCheck, nextStepCommands, scaffoldTask, validateTaskName } from "../src/cli/trial-new.ts";

const REPO = path.resolve(new URL("..", import.meta.url).pathname);
const CLI = path.join(REPO, "src", "cli", "ach.ts");

let root: string;
let seq = 0;
before(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ach-trial-new-test-")));
});
after(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function scratch(name: string): { cwd: string; state: string } {
  const cwd = path.join(root, `${name}-${seq++}`);
  const state = path.join(cwd, ".state");
  fs.mkdirSync(state, { recursive: true });
  return { cwd, state };
}

function runCli(args: string[], cwd: string, state: string): { code: number | null; stdout: string; stderr: string } {
  const isBun = (process.versions as { bun?: string }).bun !== undefined;
  const env: NodeJS.ProcessEnv = { ...process.env, AGENTIC_CODING_HARNESS_STATE_DIR: state };
  delete env.AGENTIC_CODING_HARNESS_NULL_EXIT;
  delete env.ACH_WORKSPACE;
  delete env.ACH_TASK_DIR;
  const p = spawnSync(process.execPath, isBun ? [CLI, ...args] : ["--import", import.meta.resolve("tsx"), CLI, ...args], {
    cwd,
    env,
    encoding: "utf8",
  });
  return { code: p.status, stdout: p.stdout ?? "", stderr: p.stderr ?? "" };
}

/** Run a scaffolded verify.sh the way a trial cell does: in a workspace, with the two ACH_ vars. */
function runVerify(taskDir: string, ws: string): { code: number | null; out: string } {
  fs.mkdirSync(ws, { recursive: true });
  const p = spawnSync("/bin/sh", [path.join(taskDir, "verify.sh")], {
    cwd: ws,
    env: { ...process.env, ACH_WORKSPACE: ws, ACH_TASK_DIR: taskDir },
    encoding: "utf8",
  });
  return { code: p.status, out: (p.stdout ?? "") + (p.stderr ?? "") };
}

const treeOf = (dir: string): string[] =>
  (fs.readdirSync(dir, { recursive: true }) as string[]).map((p) => p.split(path.sep).join("/")).sort();

describe("ach trial new <name> (#88)", () => {
  it("creates tasks/<name>/{task.md,verify.sh,task.json} under the cwd and exits 0", () => {
    const s = scratch("basic");
    const r = runCli(["trial", "new", "my-task"], s.cwd, s.state);
    assert.equal(r.code, 0, r.stderr);
    const dir = path.join(s.cwd, "tasks", "my-task");
    assert.deepEqual(treeOf(dir), ["task.json", "task.md", "verify.sh"]);
    assert.ok(fs.readFileSync(path.join(dir, "task.md"), "utf8").trim().length > 0);
    assert.equal(fs.statSync(path.join(dir, "verify.sh")).mode & 0o111, 0o111, "verify.sh is executable");
    const meta = JSON.parse(fs.readFileSync(path.join(dir, "task.json"), "utf8"));
    assert.equal(meta.id, "my-task");
    assert.deepEqual(meta.suites, ["local"]);
    assert.equal(meta.workspace, "fresh");
    assert.equal(meta.verifyTimeoutMs, 120000);
    assert.match(r.stdout, /^created {4}tasks\/my-task\/$/m);
  });

  it("prints the expect-fail receipt and next-step commands that exist", () => {
    const s = scratch("receipt");
    const r = runCli(["trial", "new", "my-task"], s.cwd, s.state);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /^verify {5}fail \(exit 1, [0-9.]+s\) {2}expect-fail: ok, an unimplemented task is red$/m);
    assert.match(r.stdout, /FAIL not implemented/);
    assert.match(r.stdout, /ach trial --suite local --tasks-dir tasks --task my-task --agent null --dry-run/);
    assert.doesNotMatch(r.stdout, /ach run --task/, "no command that does not exist");
  });

  it("--tasks-dir and --suite choose where it goes and which suite it joins", () => {
    const s = scratch("dirs");
    const r = runCli(["trial", "new", "alpha", "--tasks-dir", "bench/tasks", "--suite", "mine"], s.cwd, s.state);
    assert.equal(r.code, 0, r.stderr);
    const meta = JSON.parse(fs.readFileSync(path.join(s.cwd, "bench", "tasks", "alpha", "task.json"), "utf8"));
    assert.deepEqual(meta.suites, ["mine"]);
    assert.match(r.stdout, /ach trial --suite mine --tasks-dir bench\/tasks --task alpha/);
  });

  it("--json reports the directory, files, loaded task and the expect-fail verdict", () => {
    const s = scratch("json");
    const r = runCli(["trial", "new", "j-task", "--with-tests", "--json"], s.cwd, s.state);
    assert.equal(r.code, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.dir, path.join(s.cwd, "tasks", "j-task"));
    assert.deepEqual(out.files, ["task.md", "task.json", "verify.sh", "tests/example.test.sh"]);
    assert.equal(out.task.id, "j-task");
    assert.equal(out.expectFail.ok, true);
    assert.equal(out.expectFail.verify.status, "fail");
    assert.equal(out.next.length, 3);
  });
});

describe("--with-tests (#88)", () => {
  it("adds a tests/ directory and verify.sh runs every tests/*.sh in it", () => {
    const s = scratch("with-tests");
    const r = runCli(["trial", "new", "tested", "--with-tests"], s.cwd, s.state);
    assert.equal(r.code, 0, r.stderr);
    const dir = path.join(s.cwd, "tasks", "tested");
    assert.deepEqual(treeOf(dir), ["task.json", "task.md", "tests", "tests/example.test.sh", "verify.sh"]);

    // The stamped example test is itself red, and verify.sh reports it by name.
    const red = runVerify(dir, path.join(s.cwd, "ws1"));
    assert.notEqual(red.code, 0);
    assert.match(red.out, /FAIL example\.test\.sh/);

    // Wired, not decorative: make the test pass (it checks a file in the
    // workspace) and the verifier goes green; break the workspace and it is red.
    fs.writeFileSync(path.join(dir, "tests", "example.test.sh"), '#!/bin/sh\nset -eu\n[ "$(cat ./answer.txt)" = "42" ]\n');
    const ws = path.join(s.cwd, "ws2");
    fs.mkdirSync(ws);
    fs.writeFileSync(path.join(ws, "answer.txt"), "42\n");
    const green = runVerify(dir, ws);
    assert.equal(green.code, 0, green.out);
    assert.match(green.out, /ok {3}example\.test\.sh/);
    fs.writeFileSync(path.join(ws, "answer.txt"), "41\n");
    assert.notEqual(runVerify(dir, ws).code, 0);

    // A second test is picked up too.
    fs.writeFileSync(path.join(ws, "answer.txt"), "42\n");
    fs.writeFileSync(path.join(dir, "tests", "second.sh"), "#!/bin/sh\nexit 3\n");
    const second = runVerify(dir, ws);
    assert.notEqual(second.code, 0);
    assert.match(second.out, /FAIL second\.sh/);
  });

  it("a relative ACH_WORKSPACE / ACH_TASK_DIR reach tests/*.sh as absolute paths", () => {
    const s = scratch("relative");
    const res = scaffoldTask({ name: "rel", tasksDir: path.join(s.cwd, "tasks"), withTests: true, suite: "local" });
    fs.writeFileSync(
      path.join(res.dir, "tests", "example.test.sh"),
      '#!/bin/sh\nset -eu\n[ "$(cat "$ACH_WORKSPACE/answer.txt")" = "42" ]\n[ -f "$ACH_TASK_DIR/task.json" ]\n',
    );
    fs.mkdirSync(path.join(s.cwd, "ws"));
    fs.writeFileSync(path.join(s.cwd, "ws", "answer.txt"), "42\n");
    const p = spawnSync("/bin/sh", ["tasks/rel/verify.sh"], {
      cwd: s.cwd,
      env: { ...process.env, ACH_WORKSPACE: "ws", ACH_TASK_DIR: "tasks/rel" },
      encoding: "utf8",
    });
    assert.equal(p.status, 0, (p.stdout ?? "") + (p.stderr ?? ""));
    assert.match(p.stdout, /ok {3}example\.test\.sh/);
  });

  it("an empty tests/ directory is a failure, not a vacuous pass", () => {
    const s = scratch("empty-tests");
    const res = scaffoldTask({ name: "t", tasksDir: path.join(s.cwd, "tasks"), withTests: true, suite: "local" });
    fs.rmSync(path.join(res.dir, "tests", "example.test.sh"));
    const r = runVerify(res.dir, path.join(s.cwd, "ws"));
    assert.notEqual(r.code, 0);
    assert.match(r.out, /FAIL no tests/);
  });

  it("without --with-tests there is no tests/ directory", () => {
    const s = scratch("no-tests");
    const res = scaffoldTask({ name: "t", tasksDir: path.join(s.cwd, "tasks"), withTests: false, suite: "local" });
    assert.equal(fs.existsSync(path.join(res.dir, "tests")), false);
  });
});

describe("the generated verify.sh fails until implemented (#88)", () => {
  for (const withTests of [false, true]) {
    it(`exits non-zero on a fresh scaffold (withTests=${withTests}), and passes once a human writes the check`, () => {
      const s = scratch(`verify-${withTests}`);
      const res = scaffoldTask({ name: "v", tasksDir: path.join(s.cwd, "tasks"), withTests, suite: "local" });
      const r = runVerify(res.dir, path.join(s.cwd, "ws"));
      assert.notEqual(r.code, 0);
      assert.match(r.out, /not implemented/);
      // Implementing it: replace the stub with a real (passing) check.
      const target = withTests ? path.join(res.dir, "tests", "example.test.sh") : path.join(res.dir, "verify.sh");
      const body = fs.readFileSync(target, "utf8").replace(/echo "[^\n]*not implemented[^\n]*"\nexit 1\n/, "true\n");
      assert.ok(!body.includes("not implemented"), "the stub lines were found and replaced");
      fs.writeFileSync(target, body);
      assert.equal(runVerify(res.dir, path.join(s.cwd, "ws")).code, 0);
    });
  }

  it("expectFailCheck reports pass for a verifier that passes on an empty workspace, fail for one that fails", async () => {
    const s = scratch("unexpected-pass");
    const res = scaffoldTask({ name: "p", tasksDir: path.join(s.cwd, "tasks"), withTests: false, suite: "local" });
    fs.writeFileSync(path.join(res.dir, "verify.sh"), "#!/bin/sh\nexit 0\n");
    assert.equal((await expectFailCheck(loadTaskDir(res.dir))).status, "pass");
    fs.writeFileSync(path.join(res.dir, "verify.sh"), "#!/bin/sh\nexit 1\n");
    assert.equal((await expectFailCheck(loadTaskDir(res.dir))).status, "fail");
  });
});

describe("refuses to overwrite (#88)", () => {
  it("ach trial new <existing-name> exits non-zero and leaves the existing files byte-identical", () => {
    const s = scratch("exists");
    assert.equal(runCli(["trial", "new", "dup"], s.cwd, s.state).code, 0);
    const dir = path.join(s.cwd, "tasks", "dup");
    fs.writeFileSync(path.join(dir, "task.md"), "my edited prompt\n");
    fs.writeFileSync(path.join(dir, "verify.sh"), "#!/bin/sh\nexit 0\n");
    const before = treeOf(dir).map((f) => [f, fs.statSync(path.join(dir, f)).isFile() ? fs.readFileSync(path.join(dir, f), "utf8") : "<dir>"]);
    const r = runCli(["trial", "new", "dup", "--with-tests"], s.cwd, s.state);
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /already exists; refusing to overwrite/);
    const afterTree = treeOf(dir).map((f) => [f, fs.statSync(path.join(dir, f)).isFile() ? fs.readFileSync(path.join(dir, f), "utf8") : "<dir>"]);
    assert.deepEqual(afterTree, before);
  });

  it("an existing empty directory or plain file at that path is refused too", () => {
    const s = scratch("exists-empty");
    fs.mkdirSync(path.join(s.cwd, "tasks", "empty"), { recursive: true });
    fs.writeFileSync(path.join(s.cwd, "tasks", "afile"), "x");
    assert.notEqual(runCli(["trial", "new", "empty"], s.cwd, s.state).code, 0);
    assert.deepEqual(fs.readdirSync(path.join(s.cwd, "tasks", "empty")), []);
    assert.notEqual(runCli(["trial", "new", "afile"], s.cwd, s.state).code, 0);
    assert.equal(fs.readFileSync(path.join(s.cwd, "tasks", "afile"), "utf8"), "x");
  });

  it("rejects names that are not task ids or would escape the tasks dir", () => {
    for (const bad of ["..", ".", "a/b", "a:b", "", "with space"]) {
      assert.throws(() => validateTaskName(bad), /must match/, bad);
    }
    const s = scratch("bad-name");
    const r = runCli(["trial", "new", ".."], s.cwd, s.state);
    assert.notEqual(r.code, 0);
    assert.equal(fs.existsSync(path.join(s.cwd, "tasks")), false);
    assert.notEqual(runCli(["trial", "new"], s.cwd, s.state).code, 0, "a name is required");
  });
});

describe("task.json passes the validation trial runs use (#88)", () => {
  it("loadTaskDir reads task.json: id, workspace, verifyTimeoutMs and suites come from it", () => {
    const s = scratch("load");
    const res = scaffoldTask({ name: "loaded", tasksDir: path.join(s.cwd, "tasks"), withTests: false, suite: "local" });
    const meta = JSON.parse(fs.readFileSync(path.join(res.dir, "task.json"), "utf8"));
    fs.writeFileSync(path.join(res.dir, "task.json"), JSON.stringify({ ...meta, id: "renamed", verifyTimeoutMs: 4321 }));
    const t = loadTaskDir(res.dir);
    assert.equal(t.id, "renamed");
    assert.equal(t.verifyTimeoutMs, 4321);
    assert.equal(t.workspace, "fresh");
    assert.deepEqual(t.meta?.suites, ["local"]);
    assert.equal(t.verify, `sh '${path.join(res.dir, "verify.sh")}'`);
  });

  it("an invalid task.json is rejected by loadTaskDir, as meta.json is", () => {
    const s = scratch("invalid");
    const res = scaffoldTask({ name: "bad", tasksDir: path.join(s.cwd, "tasks"), withTests: false, suite: "local" });
    fs.writeFileSync(path.join(res.dir, "task.json"), JSON.stringify({ verifyTimeoutMs: -5 }));
    assert.throws(() => loadTaskDir(res.dir), /invalid .*task\.json: verifyTimeoutMs/);
    fs.writeFileSync(path.join(res.dir, "task.json"), "{ not json");
    assert.throws(() => loadTaskDir(res.dir), /task\.json is not JSON/);
  });

  it("task.json and meta.json together is a USAGE error; meta.json alone still loads", () => {
    const s = scratch("both");
    const res = scaffoldTask({ name: "both", tasksDir: path.join(s.cwd, "tasks"), withTests: false, suite: "local" });
    fs.writeFileSync(path.join(res.dir, "meta.json"), JSON.stringify({ verifyTimeoutMs: 999 }));
    assert.throws(() => loadTaskDir(res.dir), /both task\.json and meta\.json/);
    fs.rmSync(path.join(res.dir, "task.json"));
    assert.equal(loadTaskDir(res.dir).verifyTimeoutMs, 999);
  });

  it("the printed next-step command plans the scaffolded task as a runnable cell", () => {
    const s = scratch("runnable");
    assert.equal(runCli(["trial", "new", "fresh-one"], s.cwd, s.state).code, 0);
    const [, dryRun] = nextStepCommands({ name: "fresh-one", tasksDir: "tasks", suite: "local" });
    const argv = dryRun!.split(" ").slice(1);
    const r = runCli([...argv, "--json"], s.cwd, s.state);
    assert.equal(r.code, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.deepEqual(out.tasks, ["fresh-one"]);
    assert.equal(out.cells.length, 1);
    assert.equal(out.cells[0].cellId, "null:fresh-one:default:trial1");
    assert.equal(out.cells[0].action, "run");
  });

  it("a real run with the null agent finalizes the scaffolded task as verify-failed (red, not an error)", () => {
    const s = scratch("real-run");
    assert.equal(runCli(["trial", "new", "run-me", "--with-tests"], s.cwd, s.state).code, 0);
    const r = runCli(["trial", "--suite", "local", "--tasks-dir", "tasks", "--task", "run-me", "--agent", "null"], s.cwd, s.state);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /null:run-me:default:trial1 {2}verify-failed/);
    assert.match(r.stdout, /passed=0 verify-failed=1 error=0/);
  });
});

describe("docs show the scaffold, run, verify loop (#88)", () => {
  const trials = fs.readFileSync(path.join(REPO, "docs", "TRIALS.md"), "utf8");
  const readme = fs.readFileSync(path.join(REPO, "README.md"), "utf8");
  it("docs/TRIALS.md walks through trial new, a suite run and verify with example output", () => {
    assert.match(trials, /^## `ach trial new`/m);
    assert.match(trials, /ach trial new my-task --with-tests/);
    assert.match(trials, /expect-fail: ok, an unimplemented task is red/);
    assert.match(trials, /ach trial --suite local --tasks-dir tasks --task my-task --agent claude/);
    assert.match(trials, /verify-failed/);
    assert.match(trials, /\| `task\.json` \|/);
  });
  it("README and the usage text list the command", () => {
    assert.match(readme, /ach trial new/);
    const usage = fs.readFileSync(path.join(REPO, "src", "cli", "ach.ts"), "utf8");
    assert.match(usage, /ach trial new <name> \[--with-tests\]/);
  });
});
