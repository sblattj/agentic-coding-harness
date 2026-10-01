// Bundled task suite (#51): the tasks/ bundle, its both-directions
// self-check (scripts/verify-tasks.sh), and `ach trial --suite`. Every run
// launches only the deterministic `null` adapter (no CLI, no network, $0)
// against a temp state dir. The null agent never edits the workspace, so on
// the bundled tasks every cell is `verify-failed`: a real verdict, exit 0.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { readLedger } from "../src/cli/trial-matrix.ts";
import {
  bundledTasksDir,
  listSuiteTasks,
  resolveTasksDir,
  selectAgents,
  suiteExperiment,
  suitePaths,
} from "../src/cli/trial-suite.ts";
import { scanRunRecords } from "../src/core/registry.ts";

const REPO = path.resolve(new URL("..", import.meta.url).pathname);
const TASKS = path.join(REPO, "tasks");
const SELF_CHECK = path.join(REPO, "scripts", "verify-tasks.sh");
const CLI = path.join(REPO, "src", "cli", "ach.ts");

let root: string;
let seq = 0;
before(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ach-suite-")));
});
after(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function scratch(name: string): { dir: string; state: string; home: string } {
  const dir = path.join(root, `${name}-${seq++}`);
  const state = path.join(dir, "state");
  const home = path.join(dir, "home");
  fs.mkdirSync(state, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  return { dir, state, home };
}

function runCli(args: string[], env: Record<string, string>): { code: number | null; stdout: string; stderr: string } {
  const isBun = (process.versions as { bun?: string }).bun !== undefined;
  const base: NodeJS.ProcessEnv = { ...process.env };
  // An empty value is an error for the null adapter, not "unset".
  delete base.AGENTIC_CODING_HARNESS_NULL_EXIT;
  const p = spawnSync(process.execPath, isBun ? [CLI, ...args] : ["--import", import.meta.resolve("tsx"), CLI, ...args], {
    env: { ...base, ...env },
    encoding: "utf8",
  });
  return { code: p.status, stdout: p.stdout ?? "", stderr: p.stderr ?? "" };
}

const bundled = listSuiteTasks(TASKS, "core");

describe("tasks/ bundle", () => {
  it("core ships >= 10 tasks, each with task.md, verify.sh, meta.json and a complete meta", () => {
    assert.ok(bundled.length >= 10, `core has ${bundled.length} tasks`);
    for (const { name, task } of bundled) {
      for (const f of ["task.md", "verify.sh", "meta.json", "setup.sh"]) {
        assert.ok(fs.existsSync(path.join(TASKS, name, f)), `${name}/${f}`);
      }
      for (const d of ["starter", "reference", "broken"]) {
        assert.ok(fs.statSync(path.join(TASKS, name, d)).isDirectory(), `${name}/${d}/`);
      }
      const meta = task.meta as Record<string, unknown>;
      assert.equal(task.id, name, "task id is the directory name");
      assert.ok(["shell", "javascript", "python"].includes(meta.language as string), `${name} language`);
      assert.ok(["easy", "medium", "hard"].includes(meta.difficulty as string), `${name} difficulty`);
      assert.equal(typeof meta.license, "string");
      assert.equal(typeof meta.description, "string");
      assert.equal(typeof meta.broken, "string", `${name} documents its broken variant`);
      assert.equal(task.workspace, "fresh");
      assert.ok(task.setup !== undefined && task.verify !== undefined);
    }
  });

  it("spans >= 3 languages, all three task kinds, and has a multi-file task", () => {
    const metas = bundled.map((t) => t.task.meta as Record<string, unknown>);
    assert.deepEqual([...new Set(metas.map((m) => m.language))].sort(), ["javascript", "python", "shell"]);
    assert.deepEqual([...new Set(metas.map((m) => m.kind))].sort(), ["bug-fix", "implement", "refactor"]);
    assert.ok(metas.some((m) => Array.isArray(m.tags) && m.tags.includes("multi-file")));
  });
});

describe("scripts/verify-tasks.sh (both directions)", () => {
  for (const { name } of bundled) {
    it(`${name}: starter fails, reference passes, broken fails`, () => {
      const r = spawnSync("sh", [SELF_CHECK, name], { encoding: "utf8" });
      assert.equal(r.status, 0, r.stdout + r.stderr);
      assert.match(r.stdout, new RegExp(`^ok   ${name}$`, "m"));
    });
  }

  it("control: the self-check FAILS a task whose checker cannot catch anything", () => {
    const { dir } = scratch("lax");
    const t = path.join(dir, "tasks", "lax");
    for (const d of ["starter", "reference", "broken"]) fs.mkdirSync(path.join(t, d), { recursive: true });
    fs.writeFileSync(path.join(t, "task.md"), "anything\n");
    fs.writeFileSync(path.join(t, "meta.json"), "{}\n");
    fs.writeFileSync(path.join(t, "setup.sh"), 'cp -R "$ACH_TASK_DIR/starter/." "$ACH_WORKSPACE/"\n');
    fs.writeFileSync(path.join(t, "verify.sh"), "exit 0\n");
    const r = spawnSync("sh", [SELF_CHECK, "--tasks-dir", path.join(dir, "tasks"), "lax"], { encoding: "utf8" });
    assert.equal(r.status, 1, r.stdout);
    assert.match(r.stdout, /verify\.sh passes on the untouched starter/);
    assert.match(r.stdout, /verify\.sh passes on broken\//);
  });
});

describe("suite resolution", () => {
  it("bundled tasks dir: <repo>/tasks from src/cli, <package>/tasks from dist/cli, none in a compiled binary", () => {
    assert.equal(bundledTasksDir(), TASKS);
    assert.equal(bundledTasksDir("file:///opt/pkg/dist/cli/ach.js"), "/opt/pkg/tasks");
    assert.equal(bundledTasksDir("file:///opt/pkg/dist/bun/ach.js"), "/opt/pkg/tasks");
    assert.equal(bundledTasksDir("file:///$bunfs/root/ach"), null);
    assert.equal(resolveTasksDir(), TASKS);
    assert.throws(() => resolveTasksDir(undefined, "file:///$bunfs/root/ach"), /compiled single-binary.*--tasks-dir/);
    assert.throws(() => resolveTasksDir(undefined, "file:///nonexistent/dist/cli/ach.js"), /--tasks-dir/);
    assert.throws(() => resolveTasksDir(path.join(root, "nope")), /no task directories/);
  });

  it("selectAgents: default is every installed built-in except null; missing CLIs are skipped with a reason", () => {
    const probe = (name: string): { command: string | null; available: boolean } =>
      name === "null" ? { command: null, available: true } : { command: `${name}-bin`, available: name === "claude" || name === "codex" };
    assert.deepEqual(selectAgents([], probe), {
      run: ["claude", "codex"],
      skipped: [
        { agent: "opencode", reason: "opencode-bin not found on PATH" },
        { agent: "kiro", reason: "kiro-bin not found on PATH" },
        { agent: "gemini", reason: "gemini-bin not found on PATH" },
        { agent: "prime", reason: "prime-bin not found on PATH" },
      ],
    });
    assert.deepEqual(selectAgents(["null", "gemini", "null"], probe), {
      run: ["null"],
      skipped: [{ agent: "gemini", reason: "gemini-bin not found on PATH" }],
    });
  });

  it("suite paths: state-dir ledger keyed by suite; --ledger moves runs/report with it", () => {
    assert.deepEqual(suitePaths("core", undefined, "/s"), {
      ledger: "/s/suites/core.ledger.jsonl",
      runs: "/s/suites/core.runs",
      report: "/s/suites/core.report.html",
    });
    assert.deepEqual(suitePaths("core", "/x/my.ledger.jsonl", "/s"), {
      ledger: "/x/my.ledger.jsonl",
      runs: "/x/my.runs",
      report: "/x/my.report.html",
    });
  });
});

describe("ach trial --suite (CLI, null agent)", () => {
  it("core: one registry record per agent x task with experiment/variant/verify, then the HTML report", () => {
    const { state, home } = scratch("full");
    const r = runCli(["trial", "--suite", "core", "--agent", "null", "--json"], { AGENTIC_CODING_HARNESS_STATE_DIR: state, HOME: home });
    assert.equal(r.code, 0, r.stderr);
    const out = JSON.parse(r.stdout) as {
      experiment: string;
      suite: string;
      report: string;
      reportRuns: number;
      summary: Record<string, number | boolean>;
    };
    assert.equal(out.experiment, "suite/core");
    assert.equal(out.summary.total, bundled.length);
    assert.equal(out.summary.verifyFailed, bundled.length, "the null agent solves nothing: a verdict, not an error");
    assert.equal(out.summary.error, 0);

    const records = scanRunRecords(state).records;
    assert.equal(records.length, bundled.length);
    assert.deepEqual(records.map((rec) => rec.cellId?.split(":")[1]).sort(), bundled.map((t) => t.task.id).sort());
    for (const rec of records) {
      assert.equal(rec.agent, "null");
      assert.equal(rec.experiment, suiteExperiment("core"));
      assert.equal(rec.variant, "null:default");
      assert.equal(rec.verify?.status, "fail");
    }
    assert.equal(out.report, path.join(state, "suites", "core.report.html"));
    assert.equal(out.reportRuns, bundled.length);
    const html = fs.readFileSync(out.report, "utf8");
    assert.match(html, /<html/i);
    for (const t of bundled) assert.ok(html.includes(t.task.id), `report mentions ${t.task.id}`);
  });

  it("a missing agent CLI is skipped with a printed reason and never counted as a failure", () => {
    const { state, home } = scratch("missing");
    const env = { AGENTIC_CODING_HARNESS_STATE_DIR: state, HOME: home, KIRO_CLI_BIN: "/nonexistent/kiro-cli-for-test" };
    const r = runCli(["trial", "--suite", "core", "--agent", "null", "--agent", "kiro", "--task", "py-slugify"], env);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stderr, /^skipped: kiro \(\/nonexistent\/kiro-cli-for-test not found on PATH\)$/m);
    assert.match(r.stdout, /summary {4}1 cells · passed=0 verify-failed=1 error=0 skipped=0/);
    assert.match(r.stdout, /^report {5}.*core\.report\.html \(1 runs · 1 task\)$/m);
    assert.ok(readLedger(path.join(state, "suites", "core.ledger.jsonl")).rows.every((row) => row.agent === "null"));

    const only = runCli(["trial", "--suite", "core", "--agent", "kiro"], env);
    assert.notEqual(only.code, 0);
    assert.match(only.stderr, /no agent to run.*--agent null/);
  });

  it("--task subset composes with --repeat (the matrix trials); a re-run resumes from the suite ledger", () => {
    const { state, home } = scratch("subset");
    const env = { AGENTIC_CODING_HARNESS_STATE_DIR: state, HOME: home };
    const args = ["trial", "--suite", "core", "--agent", "null", "--task", "js-lru-cache", "--task", "shell-wordfreq", "--repeat", "2"];
    const first = runCli(args, env);
    assert.equal(first.code, 0, first.stderr);
    const lines = first.stdout.split("\n").filter((l) => /^\[\d+\/4\] /.test(l));
    assert.deepEqual(
      lines.map((l) => l.split(/\s+/)[1]),
      ["null:js-lru-cache:default:trial1", "null:js-lru-cache:default:trial2", "null:shell-wordfreq:default:trial1", "null:shell-wordfreq:default:trial2"],
    );
    assert.match(first.stdout, /report {5}.*\(4 runs · 2 tasks\)/);
    const second = runCli([...args, "--retry-failed"], env);
    assert.equal(second.code, 0, second.stderr);
    assert.match(second.stdout, /summary {4}4 cells · passed=0 verify-failed=4 error=0 skipped=0 · ran=0 resumed=4/);
    assert.equal(scanRunRecords(state).records.length, 4, "verify-failed cells are never retried");
  });

  it("--tasks-dir, --ledger, and a suite that passes", () => {
    const { dir, state, home } = scratch("custom");
    const t = path.join(dir, "mytasks", "ok-task");
    fs.mkdirSync(t, { recursive: true });
    fs.writeFileSync(path.join(t, "task.md"), "Nothing to do.\n");
    fs.writeFileSync(path.join(t, "verify.sh"), 'test -d "$ACH_WORKSPACE"\n');
    fs.writeFileSync(path.join(t, "meta.json"), JSON.stringify({ suites: ["mini"] }));
    const ledger = path.join(dir, "out", "mini.ledger.jsonl");
    const r = runCli(["trial", "--suite", "mini", "--agent", "null", "--tasks-dir", path.join(dir, "mytasks"), "--ledger", ledger], {
      AGENTIC_CODING_HARNESS_STATE_DIR: state,
      HOME: home,
    });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /passed=1 verify-failed=0 error=0/);
    assert.ok(fs.existsSync(path.join(dir, "out", "mini.report.html")));
    assert.ok(fs.existsSync(path.join(dir, "out", "mini.runs", "ok-task", "null~default~trial1.json")));
  });

  it("usage errors", () => {
    const { state, home } = scratch("usage");
    const env = { AGENTIC_CODING_HARNESS_STATE_DIR: state, HOME: home };
    const cases: [string[], RegExp][] = [
      [["trial", "--suite", "core", "--agent", "null", "--task", "no-such-task", "--dry-run"], /--task no-such-task: not in suite 'core'/],
      [["trial", "--suite", "nosuch", "--agent", "null", "--dry-run"], /no tasks in suite 'nosuch'.*suites: core/],
      [["trial", "--suite", "core", "--matrix", "x.json"], /mutually exclusive/],
      [["trial", "--matrix", "x.json", "--task", "a"], /--task applies to --suite only/],
      [["trial", "--suite", "core", "--agent", "null", "--repeat", "0", "--dry-run"], /--repeat must be a positive integer/],
    ];
    for (const [args, re] of cases) {
      const r = runCli(args, env);
      assert.notEqual(r.code, 0, args.join(" "));
      assert.match(r.stderr, re, args.join(" "));
    }
    assert.deepEqual(scanRunRecords(state).records, []);
  });
});
