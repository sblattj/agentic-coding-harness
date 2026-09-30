// `ach trial --matrix` (#56): resumable agents x tasks x models x trials grid.
// Every test launches only the deterministic `null` adapter (no CLI binary,
// no network, $0) against a temp state dir. Interruptions are deterministic:
// an AbortSignal fired between or during cells in-process, and a real
// SIGKILL of the CLI from a task's setup step (gated by a marker file).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import {
  cellIdOf,
  createMatrixDriver,
  defaultLedgerPath,
  expandMatrix,
  loadMatrixPlan,
  loadTaskDir,
  parseMatrixPlan,
  planStatus,
  readLedger,
  runMatrix,
  type LedgerRow,
  type MatrixPlanInput,
} from "../src/cli/trial-matrix.ts";
import type { Driver } from "../src/core/driver.ts";
import { scanRunRecords } from "../src/core/registry.ts";
import type { RunResult, RunSpec } from "../src/core/types.ts";
import { computeCompareRows } from "../src/web/compare.ts";

const CLI = new URL("../src/cli/ach.ts", import.meta.url).pathname;

let root: string;
let seq = 0;

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "ach-matrix-"));
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

/** 3 tasks x 3 models x 1 agent = 9 cells. */
function plan3x3(extra: Partial<MatrixPlanInput> = {}): MatrixPlanInput {
  return {
    experiment: "exp-3x3",
    agents: ["null"],
    models: ["m1", "m2", "m3"],
    tasks: [
      { id: "t1", prompt: "task one" },
      { id: "t2", prompt: "task two" },
      { id: "t3", prompt: "task three" },
    ],
    ...extra,
  };
}

function runCli(args: string[], env: Record<string, string>): { code: number | null; signal: string | null; stdout: string; stderr: string } {
  const isBun = (process.versions as { bun?: string }).bun !== undefined;
  const base: NodeJS.ProcessEnv = { ...process.env };
  delete base.AGENTIC_CODING_HARNESS_NULL_EXIT;
  const p = spawnSync(process.execPath, isBun ? [CLI, ...args] : ["--import", import.meta.resolve("tsx"), CLI, ...args], {
    env: { ...base, ...env },
    encoding: "utf8",
  });
  return { code: p.status, signal: p.signal, stdout: p.stdout ?? "", stderr: p.stderr ?? "" };
}

function runFiles(state: string): string[] {
  try {
    return fs.readdirSync(path.join(state, "runs")).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
}

function writePlan(dir: string, plan: MatrixPlanInput): string {
  const file = path.join(dir, "plan.json");
  fs.writeFileSync(file, JSON.stringify(plan, null, 2));
  return file;
}

describe("expandMatrix", () => {
  it("a 3x3 plan yields 9 deterministic cellIds agent:task:model:trialN", () => {
    const cells = expandMatrix(parseMatrixPlan(plan3x3()), root);
    assert.equal(cells.length, 9);
    assert.deepEqual(
      cells.map((c) => c.cellId),
      ["t1", "t2", "t3"].flatMap((t) => ["m1", "m2", "m3"].map((m) => `null:${t}:${m}:trial1`)),
    );
    assert.deepEqual(expandMatrix(parseMatrixPlan(plan3x3()), root).map((c) => c.cellId), cells.map((c) => c.cellId));
    assert.equal(cells[0]!.variant, "null:m1");
    assert.equal(cells[0]!.experiment, "exp-3x3");
    assert.equal(cells[4]!.index, 4);
  });

  it("trials, per-agent models, the 'default' model token, and the variant template", () => {
    const cells = expandMatrix(
      parseMatrixPlan({
        experiment: "e",
        agents: ["null", { agent: "claude", models: ["sonnet"] }],
        tasks: [{ id: "a", prompt: "p" }],
        trials: 2,
        variant: "{agent}/{model}/{task}",
      }),
      root,
    );
    assert.deepEqual(
      cells.map((c) => c.cellId),
      ["null:a:default:trial1", "null:a:default:trial2", "claude:a:sonnet:trial1", "claude:a:sonnet:trial2"],
    );
    assert.equal(cells[0]!.model, undefined);
    assert.equal(cells[0]!.variant, "null/default/a");
    assert.equal(cells[2]!.model, "sonnet");
    assert.equal(cellIdOf("x", "y", undefined, 3), "x:y:default:trial3");
  });

  it("the shipped examples/trial-matrix.json is a valid 3x3 plan", () => {
    const file = new URL("../examples/trial-matrix.json", import.meta.url).pathname;
    const cells = expandMatrix(loadMatrixPlan(file), path.dirname(file));
    assert.equal(cells.length, 9);
    assert.equal(cells[0]!.cellId, "null:list-files:m1:trial1");
  });

  it("rejects bad plans: ':' in a task id, duplicate task ids, unknown keys", () => {
    assert.throws(() => parseMatrixPlan(plan3x3({ tasks: [{ id: "a:b", prompt: "p" }] })), /task id must match/);
    assert.throws(
      () => expandMatrix(parseMatrixPlan(plan3x3({ tasks: [{ id: "a", prompt: "p" }, { id: "a", prompt: "q" }] })), root),
      /duplicate task id 'a'/,
    );
    assert.throws(() => parseMatrixPlan({ ...plan3x3(), agent: "null" }), /invalid matrix plan/);
    assert.throws(() => parseMatrixPlan({ ...plan3x3(), experiment: undefined }), /experiment/);
  });
});

describe("ledger", () => {
  const row = (cellId: string, status: "completed" | "failed"): LedgerRow => ({
    v: 1,
    cellId,
    experiment: "e",
    variant: "v",
    agent: "null",
    task: "t",
    model: null,
    trial: 1,
    status,
    runId: null,
    startedAt: 0,
    endedAt: 0,
  });

  it("planStatus: last row per cell wins; failed is not re-run unless retryFailed", () => {
    const cells = expandMatrix(parseMatrixPlan(plan3x3()), root);
    const rows = [
      row(cells[0]!.cellId, "failed"),
      row(cells[0]!.cellId, "completed"),
      row(cells[1]!.cellId, "completed"),
      row(cells[1]!.cellId, "failed"),
      row("not:in:plan:trial1", "completed"),
    ];
    const plain = planStatus(cells, rows);
    assert.deepEqual(plain.slice(0, 3).map((e) => e.action), ["skip", "failed", "run"]);
    const retry = planStatus(cells, rows, { retryFailed: true });
    assert.deepEqual(retry.slice(0, 3).map((e) => e.action), ["skip", "run", "run"]);
  });

  it("readLedger: missing file is empty; a torn final line is skipped and counted", () => {
    const { dir } = scratch("torn");
    const file = path.join(dir, "x.ledger.jsonl");
    assert.deepEqual(readLedger(file), { rows: [], malformed: 0 });
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(row("a:b:c:trial1", "completed")) + "\n" + '{"v":1,"cellId":"a:b');
    const r = readLedger(file);
    assert.equal(r.rows.length, 1);
    assert.equal(r.malformed, 1);
  });

  it("defaultLedgerPath sits next to the plan", () => {
    assert.equal(defaultLedgerPath("/x/y/plan.json"), "/x/y/plan.ledger.jsonl");
  });
});

describe("runMatrix (null adapter, in-process)", () => {
  it("3x3: 9 child runs labelled experiment/variant/cellId, one ledger row each, compare groups by variant", async () => {
    const { dir, state } = scratch("grid");
    const ledgerPath = path.join(dir, "plan.ledger.jsonl");
    const cells = expandMatrix(parseMatrixPlan(plan3x3()), dir);
    const driver = await createMatrixDriver(["null"], state);
    const s = await runMatrix({ cells, ledgerPath, driver, stateDir: state });
    assert.deepEqual([s.completed, s.skipped, s.failed, s.pending, s.interrupted], [9, 0, 0, 0, false]);

    const { rows } = readLedger(ledgerPath);
    assert.equal(rows.length, 9);
    assert.deepEqual(rows.map((r) => r.cellId), cells.map((c) => c.cellId));
    assert.ok(rows.every((r) => r.status === "completed" && typeof r.runId === "string"));

    // Read through the schema-parsed registry view (what /api/compare sees).
    const records = scanRunRecords(state).records;
    assert.equal(records.length, 9);
    const byCell = new Map(records.map((r) => [r.cellId, r]));
    for (const row of rows) {
      const rec = byCell.get(row.cellId);
      assert.ok(rec, `record for ${row.cellId}`);
      assert.equal(rec.runId, row.runId);
      assert.equal(rec.experiment, "exp-3x3");
      assert.equal(rec.variant, row.variant);
      assert.equal(rec.exitStatus, "success");
    }
    const compare = computeCompareRows(records, ["experiment", "variant"]);
    assert.deepEqual(
      compare.map((r) => [r.experiment, r.variant, r.runs]).sort(),
      [
        ["exp-3x3", "null:m1", 3],
        ["exp-3x3", "null:m2", 3],
        ["exp-3x3", "null:m3", 3],
      ],
    );
  });

  it("abort between cells: re-invoking skips exactly the finalized cells and runs the rest", async () => {
    const { dir, state } = scratch("abort-between");
    const ledgerPath = path.join(dir, "plan.ledger.jsonl");
    const cells = expandMatrix(parseMatrixPlan(plan3x3()), dir);
    const driver = await createMatrixDriver(["null"], state);
    const ac = new AbortController();
    let settled = 0;
    const first = await runMatrix({
      cells,
      ledgerPath,
      driver,
      stateDir: state,
      signal: ac.signal,
      onCell: () => {
        if (++settled === 4) ac.abort();
      },
    });
    assert.deepEqual([first.completed, first.pending, first.interrupted], [4, 5, true]);
    assert.equal(readLedger(ledgerPath).rows.length, 4);

    const second = await runMatrix({ cells, ledgerPath, driver, stateDir: state });
    assert.deepEqual([second.completed, second.skipped, second.failed, second.pending], [5, 4, 0, 0]);
    assert.deepEqual(
      second.cells.map((c) => c.outcome),
      [...Array(4).fill("skipped"), ...Array(5).fill("completed")],
    );
    const rows = readLedger(ledgerPath).rows;
    assert.equal(rows.length, 9);
    assert.equal(new Set(rows.map((r) => r.cellId)).size, 9);
    assert.equal(scanRunRecords(state).records.length, 9);
  });

  it("abort DURING a cell writes no row for it: the cell stays pending and runs next time", async () => {
    const { dir, state } = scratch("abort-during");
    const ledgerPath = path.join(dir, "plan.ledger.jsonl");
    const cells = expandMatrix(parseMatrixPlan(plan3x3()), dir);
    const real = await createMatrixDriver(["null"], state);
    const ac = new AbortController();
    let calls = 0;
    const hanging: Pick<Driver, "run"> = {
      run: (agent: string, spec: RunSpec): Promise<RunResult> => {
        calls++;
        if (calls === 5) {
          setImmediate(() => ac.abort());
          return new Promise<RunResult>(() => {}); // never settles: a cell killed mid-flight
        }
        return real.run(agent, spec);
      },
    };
    const first = await runMatrix({ cells, ledgerPath, driver: hanging, stateDir: state, signal: ac.signal });
    assert.deepEqual([first.completed, first.pending, first.interrupted], [4, 5, true]);
    const rows = readLedger(ledgerPath).rows;
    assert.deepEqual(rows.map((r) => r.cellId), cells.slice(0, 4).map((c) => c.cellId));
    assert.equal(first.cells[4]!.cellId, cells[4]!.cellId);
    assert.equal(first.cells[4]!.outcome, "pending");

    const second = await runMatrix({ cells, ledgerPath, driver: real, stateDir: state });
    assert.deepEqual([second.completed, second.skipped, second.failed], [5, 4, 0]);
    assert.equal(second.cells[4]!.outcome, "completed");
    assert.equal(readLedger(ledgerPath).rows.length, 9);
  });

  it("a failed cell is reported, not re-run by default, and re-run with retryFailed", async () => {
    const { dir, state } = scratch("retry");
    const ledgerPath = path.join(dir, "plan.ledger.jsonl");
    const marker = path.join(dir, "pass-marker");
    const cells = expandMatrix(
      parseMatrixPlan(
        plan3x3({
          tasks: [
            { id: "t1", prompt: "task one" },
            { id: "t2", prompt: "task two", verify: `test -f '${marker}'` },
            { id: "t3", prompt: "task three" },
          ],
        }),
      ),
      dir,
    );
    const driver = await createMatrixDriver(["null"], state);
    const first = await runMatrix({ cells, ledgerPath, driver, stateDir: state });
    assert.deepEqual([first.completed, first.failed], [6, 3]);
    const failedRows = readLedger(ledgerPath).rows.filter((r) => r.status === "failed");
    assert.deepEqual(failedRows.map((r) => r.task), ["t2", "t2", "t2"]);
    assert.ok(failedRows.every((r) => r.verify === "fail" && r.exitStatus === "success" && r.runId !== null));

    fs.writeFileSync(marker, "");
    const second = await runMatrix({ cells, ledgerPath, driver, stateDir: state });
    assert.deepEqual([second.completed, second.skipped, second.failed], [0, 6, 3]);
    assert.deepEqual(
      second.cells.filter((c) => c.outcome === "failed-not-retried").map((c) => c.cellId),
      cells.filter((c) => c.task.id === "t2").map((c) => c.cellId),
    );
    assert.equal(readLedger(ledgerPath).rows.length, 9, "no new attempts without retryFailed");
    assert.equal(scanRunRecords(state).records.length, 9);

    const third = await runMatrix({ cells, ledgerPath, driver, stateDir: state, retryFailed: true });
    assert.deepEqual([third.completed, third.skipped, third.failed], [3, 6, 0]);
    assert.equal(readLedger(ledgerPath).rows.length, 12, "one row per attempt: 9 + 3 retries");
    assert.equal(planStatus(cells, readLedger(ledgerPath).rows).filter((e) => e.action === "skip").length, 9);
  });

  it("driver throw and setup failure fail the cell with runId null and an error", async () => {
    const { dir, state } = scratch("errors");
    const ledgerPath = path.join(dir, "plan.ledger.jsonl");
    const cells = expandMatrix(
      parseMatrixPlan({
        experiment: "e",
        agents: ["null"],
        tasks: [
          { id: "boom", prompt: "p" },
          { id: "nosetup", prompt: "p", setup: "echo setup-broke >&2; exit 3" },
        ],
      }),
      dir,
    );
    const real = await createMatrixDriver(["null"], state);
    let calls = 0;
    const driver: Pick<Driver, "run"> = {
      run: (agent, spec) => (calls++ === 0 ? Promise.reject(new Error("launch exploded")) : real.run(agent, spec)),
    };
    const s = await runMatrix({ cells, ledgerPath, driver, stateDir: state });
    assert.equal(s.failed, 2);
    const rows = readLedger(ledgerPath).rows;
    assert.equal(rows[0]!.runId, null);
    assert.match(rows[0]!.error ?? "", /launch exploded/);
    assert.equal(rows[1]!.runId, null);
    assert.match(rows[1]!.error ?? "", /setup failed \(exit 3\): setup-broke/);
    assert.equal(scanRunRecords(state).records.length, 0, "setup failure launches no agent");
  });

  it("task directory: task.md prompt, setup.sh + verify.sh in a fresh per-cell workspace, meta.json id", async () => {
    const { dir, state } = scratch("taskdir");
    const taskDir = path.join(dir, "tasks", "make-file");
    fs.mkdirSync(taskDir, { recursive: true });
    fs.writeFileSync(path.join(taskDir, "task.md"), "Create hello.txt\n");
    fs.writeFileSync(path.join(taskDir, "setup.sh"), 'echo "$ACH_CELL_ID" > hello.txt\ncp "$ACH_TASK_DIR/task.md" copied.md\n');
    fs.writeFileSync(path.join(taskDir, "verify.sh"), 'test "$(cat hello.txt)" = "$ACH_CELL_ID" && test -f copied.md && test -f "$ACH_WORKSPACE/hello.txt"\n');
    fs.writeFileSync(path.join(taskDir, "meta.json"), JSON.stringify({ id: "hello", suites: ["core"] }));

    const resolved = loadTaskDir(taskDir);
    assert.equal(resolved.id, "hello");
    assert.equal(resolved.prompt, "Create hello.txt");
    assert.equal(resolved.workspace, "fresh");
    assert.deepEqual(resolved.meta?.suites, ["core"]);
    assert.match(resolved.setup ?? "", /setup\.sh'$/);

    const cells = expandMatrix(parseMatrixPlan({ experiment: "e", agents: ["null"], tasks: [{ dir: "tasks/make-file" }], trials: 2 }), dir);
    assert.deepEqual(cells.map((c) => c.cellId), ["null:hello:default:trial1", "null:hello:default:trial2"]);
    const ledgerPath = path.join(dir, "plan.ledger.jsonl");
    const driver = await createMatrixDriver(["null"], state);
    const s = await runMatrix({ cells, ledgerPath, driver, stateDir: state });
    assert.deepEqual([s.completed, s.failed], [2, 0], JSON.stringify(s.cells));
    assert.ok(readLedger(ledgerPath).rows.every((r) => r.verify === "pass"));
    const work = fs.readdirSync(path.join(dir, "plan.work"));
    assert.equal(work.length, 2, "one fresh workspace per cell");
    const recs = scanRunRecords(state).records;
    assert.ok(recs.every((r) => r.cwd !== undefined && r.cwd.startsWith(path.join(dir, "plan.work"))));
  });

  it("a task directory without task.md is a usage error", () => {
    const { dir } = scratch("no-task-md");
    fs.mkdirSync(path.join(dir, "empty"), { recursive: true });
    assert.throws(() => loadTaskDir(path.join(dir, "empty")), /no readable task\.md/);
  });
});

describe("ach trial --matrix (CLI)", () => {
  it("--dry-run lists every cell with run/skip markers and launches nothing", () => {
    const { dir, state, home } = scratch("cli-dry");
    const planFile = writePlan(dir, plan3x3());
    const env = { AGENTIC_CODING_HARNESS_STATE_DIR: state, HOME: home };
    const r = runCli(["trial", "--matrix", planFile, "--dry-run"], env);
    assert.equal(r.code, 0, r.stderr);
    const cellLines = r.stdout.split("\n").filter((l) => /^(run |skip|FAIL) /.test(l));
    assert.equal(cellLines.length, 9);
    assert.ok(cellLines.every((l) => l.startsWith("run ")));
    assert.match(r.stdout, /dry-run {4}9 cells · would run=9 skip=0 failed\(not retried\)=0/);
    assert.equal(fs.existsSync(defaultLedgerPath(planFile)), false, "dry run creates no ledger");
    assert.deepEqual(runFiles(state), [], "dry run launches no agent");

    // After a partial ledger, dry-run marks the finalized cells as skip.
    const cells = expandMatrix(parseMatrixPlan(plan3x3()), dir);
    fs.writeFileSync(
      defaultLedgerPath(planFile),
      [cells[0]!, cells[1]!]
        .map((c, i) =>
          JSON.stringify({ v: 1, cellId: c.cellId, status: i === 0 ? "completed" : "failed", runId: null, startedAt: 0, endedAt: 0 }),
        )
        .join("\n") + "\n",
    );
    const j = runCli(["trial", "--matrix", planFile, "--dry-run", "--json"], env);
    assert.equal(j.code, 0, j.stderr);
    const out = JSON.parse(j.stdout) as { cells: { cellId: string; action: string }[]; summary: Record<string, number> };
    assert.deepEqual(out.cells.slice(0, 3).map((c) => c.action), ["skip", "failed", "run"]);
    assert.deepEqual(out.summary, { total: 9, run: 7, skip: 1, failed: 1 });
    const retry = JSON.parse(runCli(["trial", "--matrix", planFile, "--dry-run", "--json", "--retry-failed"], env).stdout) as typeof out;
    assert.deepEqual(retry.summary, { total: 9, run: 8, skip: 1, failed: 0 });
    assert.deepEqual(runFiles(state), []);
  });

  it("SIGKILL mid-matrix, then the same command resumes: skips the finalized cells, runs the rest", () => {
    const { dir, state, home } = scratch("cli-kill");
    const marker = path.join(dir, "killed-once");
    // t2's setup SIGKILLs the runner (its parent) the first time only: the
    // process dies inside cell 4 (null:t2:m1:trial1) before its run exists.
    const planFile = writePlan(
      dir,
      plan3x3({
        tasks: [
          { id: "t1", prompt: "task one" },
          { id: "t2", prompt: "task two", setup: `if [ ! -f '${marker}' ]; then touch '${marker}'; kill -9 $PPID; sleep 5; fi` },
          { id: "t3", prompt: "task three" },
        ],
      }),
    );
    const env = { AGENTIC_CODING_HARNESS_STATE_DIR: state, HOME: home };
    const first = runCli(["trial", "--matrix", planFile], env);
    assert.equal(first.signal, "SIGKILL", `expected the runner to be killed: ${first.stderr}`);
    const ledger = defaultLedgerPath(planFile);
    const afterKill = readLedger(ledger).rows;
    assert.deepEqual(afterKill.map((r) => r.cellId), ["null:t1:m1:trial1", "null:t1:m2:trial1", "null:t1:m3:trial1"]);
    assert.equal(runFiles(state).length, 3);

    const second = runCli(["trial", "--matrix", planFile], env);
    assert.equal(second.code, 0, second.stderr);
    assert.match(second.stdout, /summary {4}9 cells · completed=6 skipped=3 failed=0/);
    const rows = readLedger(ledger).rows;
    assert.equal(rows.length, 9);
    assert.equal(new Set(rows.map((r) => r.cellId)).size, 9);
    assert.equal(runFiles(state).length, 9);

    const third = runCli(["trial", "--matrix", planFile, "--json"], env);
    assert.equal(third.code, 0, third.stderr);
    const out = JSON.parse(third.stdout) as { summary: Record<string, unknown> };
    assert.deepEqual(out.summary, { total: 9, completed: 0, skipped: 9, failed: 0, pending: 0, interrupted: false });
    assert.equal(runFiles(state).length, 9, "a fully completed matrix launches nothing");
  });

  it("failed cells: exit 1 and reported; not re-run without --retry-failed; re-run with it", () => {
    const { dir, state, home } = scratch("cli-retry");
    const planFile = writePlan(dir, plan3x3());
    const env = { AGENTIC_CODING_HARNESS_STATE_DIR: state, HOME: home };
    const first = runCli(["trial", "--matrix", planFile], { ...env, AGENTIC_CODING_HARNESS_NULL_EXIT: "error" });
    assert.equal(first.code, 1, first.stderr);
    assert.match(first.stdout, /completed=0 skipped=0 failed=9/);
    assert.equal(runFiles(state).length, 9);

    const second = runCli(["trial", "--matrix", planFile], env);
    assert.equal(second.code, 1);
    assert.match(second.stdout, /completed=0 skipped=0 failed=9/);
    assert.match(second.stdout, /FAILED earlier \(not retried; --retry-failed\)/);
    assert.equal(runFiles(state).length, 9, "failed cells are not silently retried");
    assert.equal(readLedger(defaultLedgerPath(planFile)).rows.length, 9);

    const third = runCli(["trial", "--matrix", planFile, "--retry-failed"], env);
    assert.equal(third.code, 0, third.stderr);
    assert.match(third.stdout, /completed=9 skipped=0 failed=0/);
    assert.equal(runFiles(state).length, 18);
    assert.equal(readLedger(defaultLedgerPath(planFile)).rows.length, 18);
  });

  it("usage errors: missing --matrix, bad plan, --help", () => {
    const { dir, state, home } = scratch("cli-usage");
    const env = { AGENTIC_CODING_HARNESS_STATE_DIR: state, HOME: home };
    const none = runCli(["trial"], env);
    assert.notEqual(none.code, 0);
    assert.match(none.stderr, /trial requires --matrix/);
    const bad = path.join(dir, "bad.json");
    fs.writeFileSync(bad, JSON.stringify({ experiment: "e", agents: [], tasks: [] }));
    const b = runCli(["trial", "--matrix", bad], env);
    assert.notEqual(b.code, 0);
    assert.match(b.stderr, /invalid matrix plan/);
    const h = runCli(["trial", "--help"], env);
    assert.equal(h.code, 0);
    assert.match(h.stdout, /ach trial --matrix/);
  });
});
