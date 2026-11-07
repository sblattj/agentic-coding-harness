// #75: `--isolate` runs the agent in its own git worktree + branch. Everything
// here drives the real `ach run` / `ach trial` entry points with a scripted
// custom agent (a node script that writes a file in its cwd) against a temp git
// repo; no real agent CLI, no network.
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { createMatrixDriver, expandMatrix, parseMatrixPlan, runMatrix } from "../src/cli/trial-matrix.ts";
import { isolateBranchName, isolateOptionsFromFlags, materializeNodeModules, prepareIsolation } from "../src/core/isolate.ts";
import { RunRecordSchema, listRunRecords } from "../src/core/registry.ts";

const CLI = new URL("../src/cli/ach.ts", import.meta.url).pathname;
const NODE = process.execPath;
const LOADER = ["--import", import.meta.resolve("tsx")];

/** Fake agent: writes <marker>.txt into its cwd, optionally waits, then prints what other markers it can see. */
const FAKE_AGENT = `
import fs from 'node:fs';
const marker = process.env.MARKER ?? 'agent';
fs.writeFileSync(marker + '.txt', 'written by ' + marker + '\\n');
const wait = Number(process.env.WAIT_MS ?? 0);
await new Promise((r) => setTimeout(r, wait));
const seen = fs.readdirSync('.').filter((f) => f.endsWith('.txt'));
process.stdout.write(JSON.stringify({ type: 'result', cwd: process.cwd(), seen }) + '\\n');
`;

let root: string;
let fake = "";
let seq = 0;
before(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ach-isolate-test-")));
  fake = path.join(root, "fake-agent.mjs");
  fs.writeFileSync(fake, FAKE_AGENT);
});
after(() => fs.rmSync(root, { recursive: true, force: true }));

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

/** A committed temp repo (plus its own state dir). */
function fixture(): { repo: string; state: string } {
  const dir = path.join(root, `case-${++seq}`);
  const repo = path.join(dir, "repo");
  const state = path.join(dir, "state");
  fs.mkdirSync(repo, { recursive: true });
  fs.mkdirSync(state, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "t@example.com");
  git(repo, "config", "user.name", "t");
  git(repo, "config", "commit.gpgsign", "false");
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  fs.writeFileSync(path.join(repo, ".gitignore"), "node_modules\n");
  git(repo, "add", "README.md", ".gitignore");
  git(repo, "commit", "-q", "-m", "init");
  return { repo, state };
}

const TEMPLATE = `'${NODE}' '${fake}' {prompt}`;

function cliArgs(args: string[]): string[] {
  return [...LOADER, CLI, ...args];
}

function runArgs(extra: string[]): string[] {
  return ["run", "--agent", "custom", "--template", TEMPLATE, "--json", ...extra, "go"];
}

function runCli(args: string[], state: string, cwd: string, env: Record<string, string> = {}) {
  const p = spawnSync(NODE, cliArgs(args), {
    cwd,
    env: { ...process.env, AGENTIC_CODING_HARNESS_STATE_DIR: state, ...env },
    encoding: "utf8",
  });
  return { code: p.status ?? -1, stdout: p.stdout ?? "", stderr: p.stderr ?? "" };
}

function runCliAsync(args: string[], state: string, cwd: string, env: Record<string, string>): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(NODE, cliArgs(args), { cwd, env: { ...process.env, AGENTIC_CODING_HARNESS_STATE_DIR: state, ...env } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += String(d)));
    child.stderr.on("data", (d) => (stderr += String(d)));
    child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

describe("ach run --isolate", () => {
  it("runs the agent in a worktree on ach/<runId>, leaves the main tree untouched, records worktree.*", () => {
    const { repo, state } = fixture();
    const base = git(repo, "rev-parse", "HEAD");
    const r = runCli(runArgs(["--isolate"]), state, repo, { MARKER: "alpha" });
    assert.equal(r.code, 0, r.stderr);
    const out = JSON.parse(r.stdout) as { runId: string; worktree: { path: string; branch: string; baseSha: string; cleanup: { status: string } } };
    const wt = out.worktree;
    assert.equal(wt.baseSha, base, "worktree.baseSha is the full HEAD sha");
    assert.equal(wt.branch, `ach/${out.runId}`);
    assert.equal(wt.cleanup.status, "kept");
    assert.equal(wt.path, fs.realpathSync(path.join(state, "worktrees", out.runId)));
    assert.match(r.stderr, /\[isolate\] running in .* on branch ach\//);
    // The edit landed in the worktree, not the primary checkout.
    assert.equal(fs.existsSync(path.join(wt.path, "alpha.txt")), true, "file in worktree");
    assert.equal(fs.existsSync(path.join(repo, "alpha.txt")), false, "file NOT in main tree");
    assert.equal(git(repo, "status", "--porcelain"), "");
    assert.ok(git(repo, "branch", "--list", wt.branch).includes(wt.branch));
    // RunRecord on disk carries the same info and still validates.
    const [rec] = listRunRecords(state);
    assert.deepEqual(rec?.worktree, wt);
    assert.equal(rec?.cwd, wt.path);
    assert.equal(RunRecordSchema.safeParse(rec).success, true);
  });

  it("non-isolated runs are unaffected: edits land in the main tree, no worktree field", () => {
    const { repo, state } = fixture();
    const r = runCli(runArgs([]), state, repo, { MARKER: "plain" });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(fs.existsSync(path.join(repo, "plain.txt")), true);
    assert.equal(fs.existsSync(path.join(state, "worktrees")), false);
    const [rec] = listRunRecords(state);
    assert.equal(rec?.worktree, undefined);
    assert.equal(JSON.parse(r.stdout).worktree, undefined);
  });

  it("old records without worktree still validate", () => {
    const { repo, state } = fixture();
    runCli(runArgs([]), state, repo);
    const [rec] = listRunRecords(state);
    assert.equal(RunRecordSchema.safeParse({ ...rec, worktree: undefined }).success, true);
  });

  it("refuses a dirty tree with a clear error; --allow-dirty overrides", () => {
    const { repo, state } = fixture();
    fs.writeFileSync(path.join(repo, "scratch.txt"), "uncommitted\n");
    const refused = runCli(runArgs(["--isolate"]), state, repo);
    assert.notEqual(refused.code, 0);
    assert.match(refused.stderr, /refuses a dirty working tree/);
    assert.match(refused.stderr, /--allow-dirty/);
    assert.equal(listRunRecords(state).length, 0, "no run was launched");
    const ok = runCli(runArgs(["--isolate", "--allow-dirty"]), state, repo, { MARKER: "beta" });
    assert.equal(ok.code, 0, ok.stderr);
    // The worktree starts from HEAD: the dirty file did not follow.
    const wt = (JSON.parse(ok.stdout) as { worktree: { path: string } }).worktree.path;
    assert.equal(fs.existsSync(path.join(wt, "scratch.txt")), false);
    assert.equal(fs.existsSync(path.join(wt, "beta.txt")), true);
  });

  it("outside a git repo it fails clearly", () => {
    const { state } = fixture();
    const plain = path.join(root, `plain-${++seq}`);
    fs.mkdirSync(plain);
    const r = runCli(runArgs(["--isolate"]), state, plain);
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /needs a git repository/);
  });

  it("--cleanup removes the worktree, keeps the branch, and commits leftover edits to it", () => {
    const { repo, state } = fixture();
    const r = runCli(runArgs(["--isolate", "--cleanup"]), state, repo, { MARKER: "gamma" });
    assert.equal(r.code, 0, r.stderr);
    const wt = (JSON.parse(r.stdout) as { worktree: { path: string; branch: string; cleanup: { status: string; commit?: string } } }).worktree;
    assert.equal(wt.cleanup.status, "removed");
    assert.equal(fs.existsSync(wt.path), false, "worktree dir gone");
    assert.ok(git(repo, "branch", "--list", wt.branch).includes(wt.branch), "branch kept");
    assert.equal(git(repo, "worktree", "list", "--porcelain").includes(wt.branch), false);
    assert.equal(git(repo, "show", `${wt.branch}:gamma.txt`), "written by gamma");
    assert.ok(wt.cleanup.commit);
    const [rec] = listRunRecords(state);
    assert.equal(rec?.worktree?.cleanup.status, "removed");
    assert.match(r.stderr, /\[isolate\]/);
  });

  it("two concurrent isolated runs in one repo do not see each other's edits", async () => {
    const { repo, state } = fixture();
    const slow = { WAIT_MS: "1500" };
    const [a, b] = await Promise.all([
      runCliAsync(runArgs(["--isolate"]), state, repo, { ...slow, MARKER: "one" }),
      runCliAsync(runArgs(["--isolate"]), state, repo, { ...slow, MARKER: "two" }),
    ]);
    assert.equal(a.code, 0, a.stderr);
    assert.equal(b.code, 0, b.stderr);
    const seen = (r: { stdout: string }) => {
      const res = JSON.parse(r.stdout) as { events: Array<{ type: string; content?: string; text?: string }>; worktree: { path: string } };
      const msg = res.events.filter((e) => e.type === "message").map((e) => String(e.content ?? e.text));
      const line = msg.map((m) => { try { return JSON.parse(m) as { seen?: string[] }; } catch { return {}; } }).find((o) => o.seen);
      return { wt: res.worktree.path, seen: line?.seen ?? [] };
    };
    const ra = seen(a);
    const rb = seen(b);
    assert.notEqual(ra.wt, rb.wt);
    assert.deepEqual(ra.seen, ["one.txt"]);
    assert.deepEqual(rb.seen, ["two.txt"]);
    assert.equal(fs.existsSync(path.join(repo, "one.txt")) || fs.existsSync(path.join(repo, "two.txt")), false);
    assert.equal(git(repo, "branch", "--list", "ach/*").split("\n").length, 2);
  });

  it("--repeat with --parallel 2 gives every child its own worktree", () => {
    const { repo, state } = fixture();
    const r = runCli(["run", "--agent", "custom", "--template", TEMPLATE, "--isolate", "--repeat", "2", "--parallel", "2", "go"], state, repo, { MARKER: "rep" });
    assert.equal(r.code, 0, r.stderr);
    const recs = listRunRecords(state);
    assert.equal(recs.length, 2);
    assert.equal(new Set(recs.map((x) => x.worktree?.path)).size, 2);
  });

  it("--isolate-node-modules symlinks node_modules entries incl. .bin, skipping caches", () => {
    const { repo, state } = fixture();
    fs.mkdirSync(path.join(repo, "node_modules", "left-pad"), { recursive: true });
    fs.mkdirSync(path.join(repo, "node_modules", ".cache"), { recursive: true });
    fs.mkdirSync(path.join(repo, "node_modules", ".bin"), { recursive: true });
    fs.writeFileSync(path.join(repo, "node_modules", ".bin", "tool"), "#!/bin/sh\n");
    fs.writeFileSync(path.join(repo, "node_modules", "left-pad", "index.js"), "x");
    const r = runCli(runArgs(["--isolate", "--isolate-node-modules"]), state, repo, { MARKER: "nm" });
    assert.equal(r.code, 0, r.stderr);
    const wt = (JSON.parse(r.stdout) as { worktree: { path: string; nodeModules?: number } }).worktree;
    assert.equal(wt.nodeModules, 2);
    assert.equal(fs.existsSync(path.join(wt.path, "node_modules", ".bin", "tool")), true, ".bin must be linked");
    const link = path.join(wt.path, "node_modules", "left-pad");
    assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
    assert.equal(fs.existsSync(path.join(link, "index.js")), true);
    assert.equal(fs.existsSync(path.join(wt.path, "node_modules", ".cache")), false);
    const cleaned = runCli(runArgs(["--isolate", "--isolate-node-modules", "--cleanup"]), state, repo, { MARKER: "nm2" });
    assert.equal(cleaned.code, 0, cleaned.stderr);
    // The primary node_modules is never touched by removal of the links.
    assert.equal(fs.existsSync(path.join(repo, "node_modules", "left-pad", "index.js")), true);
  });

  it("refuses unsound or dangling flag combinations", () => {
    const { repo, state } = fixture();
    const hermetic = runCli(runArgs(["--isolate", "--hermetic"]), state, repo);
    assert.notEqual(hermetic.code, 0);
    assert.match(hermetic.stderr, /--isolate and --hermetic/);
    const resume = runCli(runArgs(["--isolate", "--resume", "abc"]), state, repo);
    assert.notEqual(resume.code, 0);
    assert.match(resume.stderr, /--isolate.*--resume/);
    const dangling = runCli(runArgs(["--cleanup"]), state, repo);
    assert.notEqual(dangling.code, 0);
    assert.match(dangling.stderr, /--cleanup only applies together with --isolate/);
  });

  it("--help documents the flags for run and trial", () => {
    const { repo, state } = fixture();
    const help = runCli(["--help"], state, repo);
    assert.match(help.stdout, /--isolate \[--allow-dirty\] \[--cleanup\] \[--isolate-node-modules\]/);
    assert.match(help.stdout, /ach trial --matrix[^\n]*\n\s+\[--isolate/);
  });
});

describe("isolate helpers", () => {
  it("isolateBranchName slugs the run id", () => {
    assert.equal(isolateBranchName("AB12-cd"), "ach/ab12-cd");
    assert.equal(isolateBranchName("a b/c"), "ach/a-b-c");
  });

  it("isolateOptionsFromFlags maps flags and refuses conflicts", () => {
    assert.equal(isolateOptionsFromFlags({}, { hermetic: false, resume: false }), undefined);
    assert.deepEqual(isolateOptionsFromFlags({ isolate: true, cleanup: true, "allow-dirty": true }, { hermetic: false, resume: false }), { allowDirty: true, cleanup: true });
    assert.throws(() => isolateOptionsFromFlags({ isolate: true }, { hermetic: true, resume: false }), /--hermetic/);
    assert.throws(() => isolateOptionsFromFlags({ "isolate-node-modules": true }, { hermetic: false, resume: false }), /only applies together/);
  });

  it("materializeNodeModules is a no-op without a node_modules dir", () => {
    const d = fs.mkdtempSync(path.join(root, "nm-"));
    assert.equal(materializeNodeModules(d, d), 0);
  });
});

describe("ach trial --isolate (runMatrix)", () => {
  it("shared-workspace cells run in a worktree and --verify runs there; fresh cells are left alone", async () => {
    const { repo, state } = fixture();
    const ledgerPath = path.join(root, `ledger-${++seq}.jsonl`);
    const plan = parseMatrixPlan({
      experiment: "iso",
      agents: ["null"],
      tasks: [
        { id: "shared", prompt: "p", workspace: "shared", cwd: repo, verify: "git rev-parse --abbrev-ref HEAD | grep -q '^ach/'" },
        { id: "fresh", prompt: "p", workspace: "fresh" },
      ],
    });
    const cells = expandMatrix(plan, repo);
    const driver = await createMatrixDriver(["null"], state);
    const s = await runMatrix({ cells, ledgerPath, driver, stateDir: state, isolate: {} });
    assert.equal(s.passed, 2, JSON.stringify(s));
    const recs = listRunRecords(state);
    const withWt = recs.filter((r) => r.worktree !== undefined);
    assert.equal(withWt.length, 1, "only the shared cell was isolated");
    assert.equal(withWt[0]?.worktree?.cleanup.status, "kept");
    assert.ok(git(repo, "branch", "--list", withWt[0]!.worktree!.branch).length > 0);
  });

  it("trial rejects --isolate with --hermetic", () => {
    const { repo, state } = fixture();
    const r = runCli(["trial", "--suite", "core", "--isolate", "--hermetic", "--dry-run"], state, repo);
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /--isolate and --hermetic/);
  });
});

describe("#75 review fixes", () => {
  const status = (repo: string): string => git(repo, "status", "--porcelain");

  it("matrix --isolate with the default ledger next to a committed plan completes every cell", () => {
    const { repo, state } = fixture();
    const plan = {
      experiment: "iso2",
      agents: ["null"],
      trials: 2,
      tasks: [{ id: "t", prompt: "p", workspace: "shared" }],
    };
    fs.writeFileSync(path.join(repo, "plan.json"), JSON.stringify(plan));
    git(repo, "add", "plan.json");
    git(repo, "commit", "-q", "-m", "plan");
    const r = runCli(["trial", "--matrix", "plan.json", "--isolate", "--json"], state, repo);
    assert.equal(r.code, 0, r.stderr + r.stdout);
    const rows = fs
      .readFileSync(path.join(repo, "plan.ledger.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { status: string });
    assert.deepEqual(rows.map((x) => x.status), ["passed", "passed"]);
  });

  it("a real user change still blocks; .ach/ config alone does not", () => {
    const { repo, state } = fixture();
    fs.mkdirSync(path.join(repo, ".ach"));
    fs.writeFileSync(path.join(repo, ".ach", "config.json"), "{}");
    const ok = prepareIsolation("cfg-ok", repo, { stateDir: state });
    assert.ok(fs.existsSync(ok.path));
    fs.writeFileSync(path.join(repo, "mine.txt"), "wip");
    assert.throws(() => prepareIsolation("cfg-bad", repo, { stateDir: state }), /dirty working tree.*mine\.txt/);
    assert.equal(status(repo).includes("mine.txt"), true);
  });

  it("task setup runs inside the worktree: verify sees it and the main tree stays clean", async () => {
    const { repo, state } = fixture();
    const ledgerPath = path.join(root, `ledger-${++seq}.jsonl`);
    const plan = parseMatrixPlan({
      experiment: "iso3",
      agents: ["null"],
      tasks: [{ id: "s", prompt: "p", workspace: "shared", cwd: repo, setup: "echo fixture > seed.txt", verify: "test -f seed.txt" }],
    });
    const driver = await createMatrixDriver(["null"], state);
    const s = await runMatrix({ cells: expandMatrix(plan, repo), ledgerPath, driver, stateDir: state, isolate: {} });
    assert.equal(s.passed, 1, JSON.stringify(s));
    assert.equal(status(repo), "");
    assert.equal(fs.existsSync(path.join(repo, "seed.txt")), false);
  });

  it("a failing setup is an error cell and leaves no worktree or branch behind", async () => {
    const { repo, state } = fixture();
    const ledgerPath = path.join(root, `ledger-${++seq}.jsonl`);
    const plan = parseMatrixPlan({
      experiment: "iso4",
      agents: ["null"],
      tasks: [{ id: "s", prompt: "p", workspace: "shared", cwd: repo, setup: "echo boom >&2; exit 3" }],
    });
    const driver = await createMatrixDriver(["null"], state);
    const s = await runMatrix({ cells: expandMatrix(plan, repo), ledgerPath, driver, stateDir: state, isolate: {} });
    assert.equal(s.passed, 0);
    const row = JSON.parse(fs.readFileSync(ledgerPath, "utf8").trim().split("\n")[0]!) as { status: string; error?: string };
    assert.equal(row.status, "error");
    assert.match(row.error ?? "", /setup failed \(exit 3\).*boom/);
    assert.equal(git(repo, "branch", "--list", "ach/*"), "");
    assert.equal(git(repo, "worktree", "list").split("\n").length, 1);
  });

  it("running from a gitignored subdirectory creates it in the worktree", () => {
    const { repo, state } = fixture();
    fs.appendFileSync(path.join(repo, ".gitignore"), "scratch/\n");
    git(repo, "commit", "-q", "-am", "ignore");
    const sub = path.join(repo, "scratch");
    fs.mkdirSync(sub);
    const r = runCli(runArgs(["--isolate"]), state, sub, { MARKER: "sub" });
    assert.equal(r.code, 0, r.stderr);
    const wt = (JSON.parse(r.stdout) as { worktree: { path: string } }).worktree;
    assert.equal(fs.existsSync(path.join(wt.path, "scratch", "sub.txt")), true);
  });

  it("a prepare failure after worktree add removes the worktree and branch", () => {
    const { repo, state } = fixture();
    assert.throws(() => prepareIsolation("prep-fail", repo, { stateDir: state, setup: { command: "exit 1" } }), /setup failed/);
    assert.equal(fs.existsSync(path.join(state, "worktrees", "prep-fail")), false);
    assert.equal(git(repo, "branch", "--list", "ach/prep-fail"), "");
  });

  it("SIGTERM during an isolated --cleanup run removes the worktree", async () => {
    const { repo, state } = fixture();
    const script = path.join(root, `sig-${++seq}.ts`);
    const mod = new URL("../src/core/isolate.ts", import.meta.url).pathname;
    fs.writeFileSync(
      script,
      `import { prepareIsolation } from ${JSON.stringify(mod)};
const ws = prepareIsolation("sig-run", ${JSON.stringify(repo)}, { stateDir: ${JSON.stringify(state)}, cleanup: true });
process.stdout.write("ready " + ws.path + "\\n");
setInterval(() => {}, 1000);
`,
    );
    const child = spawn(NODE, [...LOADER, script], { cwd: repo });
    let out = "";
    child.stdout.on("data", (d) => (out += String(d)));
    const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) => child.on("close", (code, signal) => resolve({ code, signal })));
    const t0 = Date.now();
    while (!out.includes("ready ") && Date.now() - t0 < 30_000) await new Promise((r) => setTimeout(r, 50));
    const wtPath = out.trim().split(" ")[1]!;
    assert.equal(fs.existsSync(wtPath), true);
    child.kill("SIGTERM");
    const e = await exited;
    assert.equal(e.code, 143, JSON.stringify(e));
    assert.equal(fs.existsSync(wtPath), false);
    assert.ok(git(repo, "branch", "--list", "ach/sig-run").length > 0, "branch is kept");
  });
});
