// Task scaffolding (#88): `ach trial new <name> [--with-tests]`.
//
// Stamps a task directory in the #51 layout that `ach trial --suite` and
// `ach trial --matrix {dir}` already run (src/cli/trial-matrix.ts
// loadTaskDir):
//
//   <tasks-dir>/<name>/task.md     the prompt, sent to the agent verbatim
//   <tasks-dir>/<name>/task.json   TaskMeta: id, description, suites, workspace, verifyTimeoutMs
//   <tasks-dir>/<name>/verify.sh   the checker; a stub that exits 1 ("not implemented")
//   <tasks-dir>/<name>/tests/      --with-tests: example.test.sh (also failing), run by verify.sh
//
// After writing, the directory is loaded back through loadTaskDir (the same
// validation every trial run uses) and its verifier runs once against an
// empty workspace in expect-fail mode: an unimplemented task must be visibly
// red. A pass or an error there is a scaffold failure (exit 1).
//
// The templates are string constants, not files on disk, so a compiled
// single binary (no bundled tasks/) scaffolds the same way.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

import { HarnessError } from "../core/types.ts";
import { DEFAULT_VERIFY_TIMEOUT_MS, runVerifier, type VerifyResult } from "../core/verify.ts";
import { loadTaskDir, type ResolvedTask } from "./trial-matrix.ts";
import { formatVerifyLine } from "./trials.ts";

/** Default `--tasks-dir`: `tasks/` under the current directory. */
export const DEFAULT_SCAFFOLD_TASKS_DIR = "tasks";
/** Default suite a scaffolded task joins, so `ach trial --suite local` finds it. */
export const DEFAULT_SCAFFOLD_SUITE = "local";

/** Same rule as a plan task id (trial-matrix.ts ID_RE), minus the `.` / `..` path names. */
const NAME_RE = /^[A-Za-z0-9._-]+$/;

export function validateTaskName(name: string, what = "task name"): string {
  if (!NAME_RE.test(name) || name === "." || name === "..") {
    throw new HarnessError(`${what} must match [A-Za-z0-9._-]+ and not be '.' or '..' (got '${name}')`, "USAGE");
  }
  return name;
}

export function taskMdTemplate(name: string): string {
  return `# ${name}

TODO: describe what the agent must do. This whole file is the prompt, sent to
the agent verbatim.

The agent starts in a fresh, empty directory. To give it starter files, add a
setup.sh next to this file that copies them into "$ACH_WORKSPACE".
`;
}

export function taskJsonTemplate(name: string, suite: string): string {
  const meta = {
    id: name,
    description: "TODO: one line on what the agent must do",
    suites: [suite],
    tags: [] as string[],
    workspace: "fresh",
    verifyTimeoutMs: DEFAULT_VERIFY_TIMEOUT_MS,
  };
  return JSON.stringify(meta, null, 2) + "\n";
}

const VERIFY_HEADER = `#!/bin/sh
# Checker: exit 0 = pass, anything else = fail. Runs after the agent, in the
# agent's workspace ($ACH_WORKSPACE); the task directory ($ACH_TASK_DIR) holds
# this script and anything the agent must not see.
set -eu
# Both made absolute (a relative ACH_WORKSPACE or ACH_TASK_DIR still works
# after the cd, and in what tests/*.sh inherit).
TASK_DIR="$(cd "\${ACH_TASK_DIR:-$(dirname "$0")}" && pwd)"
cd "\${ACH_WORKSPACE:-$PWD}"
WS="$PWD"
`;

export function verifyShTemplate(withTests: boolean): string {
  if (!withTests) {
    return `${VERIFY_HEADER}
# Replace the two lines below with the real check, e.g.:
#   [ "$(sh ./solution.sh 2 3)" = "5" ]
echo "FAIL not implemented: write the check in verify.sh"
exit 1
`;
  }
  return `${VERIFY_HEADER}
# Runs every tests/*.sh in the task directory, in the agent's workspace.
# All must exit 0; no tests at all is a failure.
export ACH_TASK_DIR="$TASK_DIR" ACH_WORKSPACE="$WS"
ran=0
for t in "$TASK_DIR"/tests/*.sh; do
  [ -f "$t" ] || continue
  ran=$((ran + 1))
  if sh "$t"; then
    echo "ok   \${t##*/}"
  else
    echo "FAIL \${t##*/}"
    exit 1
  fi
done
if [ "$ran" -eq 0 ]; then
  echo "FAIL no tests: add tests/*.sh to $TASK_DIR"
  exit 1
fi
`;
}

export const EXAMPLE_TEST_TEMPLATE = `#!/bin/sh
# Example test, run by verify.sh in the agent's workspace (the current
# directory). Exit 0 = pass. Replace the two lines below with a real check,
# e.g.:
#   [ "$(sh ./solution.sh 2 3)" = "5" ]
set -eu
echo "not implemented: write tests/example.test.sh"
exit 1
`;

export interface ScaffoldOptions {
  name: string;
  /** Parent directory of the new task directory (created when missing). */
  tasksDir: string;
  withTests: boolean;
  suite: string;
}

export interface ScaffoldResult {
  /** Absolute task directory. */
  dir: string;
  /** Files written, relative to `dir`, in write order. */
  files: string[];
}

/**
 * Write the task directory. The leaf is created with a non-recursive mkdir, so
 * an existing path (file or directory, empty or not) is refused atomically and
 * left untouched. A write failure after that removes the half-written leaf.
 */
export function scaffoldTask(o: ScaffoldOptions): ScaffoldResult {
  validateTaskName(o.name);
  validateTaskName(o.suite, "--suite");
  const parent = path.resolve(o.tasksDir);
  const dir = path.join(parent, o.name);
  fs.mkdirSync(parent, { recursive: true });
  try {
    fs.mkdirSync(dir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") {
      throw new HarnessError(`${dir} already exists; refusing to overwrite it (pick another name or remove it first)`, "USAGE");
    }
    throw e;
  }
  const files: string[] = [];
  const write = (rel: string, body: string, mode: number): void => {
    fs.writeFileSync(path.join(dir, rel), body, { mode, flag: "wx" });
    files.push(rel);
  };
  try {
    write("task.md", taskMdTemplate(o.name), 0o644);
    write("task.json", taskJsonTemplate(o.name, o.suite), 0o644);
    write("verify.sh", verifyShTemplate(o.withTests), 0o755);
    if (o.withTests) {
      fs.mkdirSync(path.join(dir, "tests"));
      write(path.join("tests", "example.test.sh"), EXAMPLE_TEST_TEMPLATE, 0o755);
    }
  } catch (e) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw e;
  }
  return { dir, files };
}

/**
 * Run the task's verifier once against an empty temp workspace, with the env
 * a trial cell gets (ACH_WORKSPACE, ACH_TASK_DIR; trial-matrix.ts runCell).
 */
export async function expectFailCheck(task: ResolvedTask): Promise<VerifyResult> {
  if (task.verify === undefined || task.dir === undefined) {
    throw new HarnessError(`task '${task.id}' has no verify.sh`, "USAGE");
  }
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "ach-trial-new-"));
  try {
    return await runVerifier({
      command: task.verify,
      cwd: ws,
      env: { ...process.env, ACH_WORKSPACE: ws, ACH_TASK_DIR: task.dir },
      timeoutMs: task.verifyTimeoutMs ?? DEFAULT_VERIFY_TIMEOUT_MS,
    });
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
}

const shArg = (s: string): string => (/^[A-Za-z0-9._\/=:@%+-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

/** The commands printed after a scaffold: real, runnable `ach` invocations. */
export function nextStepCommands(o: { name: string; tasksDir: string; suite: string }): string[] {
  const rel = path.join(o.tasksDir, o.name);
  const suiteRun = `ach trial --suite ${shArg(o.suite)} --tasks-dir ${shArg(o.tasksDir)} --task ${shArg(o.name)}`;
  return [
    `sh ${shArg(path.join(rel, "verify.sh"))}`,
    `${suiteRun} --agent null --dry-run`,
    `${suiteRun} --agent claude`,
  ];
}

export async function cmdTrialNew(rest: string[]): Promise<number> {
  const args = parseArgs({
    args: rest,
    options: {
      "with-tests": { type: "boolean", default: false },
      "tasks-dir": { type: "string" },
      suite: { type: "string" },
      json: { type: "boolean", default: false },
    },
    allowPositionals: true,
  });
  if (args.positionals.length !== 1) {
    throw new HarnessError("usage: ach trial new <name> [--with-tests] [--tasks-dir DIR] [--suite NAME] [--json]", "USAGE");
  }
  const name = validateTaskName(args.positionals[0]!);
  const tasksDir = args.values["tasks-dir"] ?? DEFAULT_SCAFFOLD_TASKS_DIR;
  const suite = validateTaskName(args.values.suite ?? DEFAULT_SCAFFOLD_SUITE, "--suite");
  const withTests = args.values["with-tests"];

  const result = scaffoldTask({ name, tasksDir, withTests, suite });
  // The same validation a trial run applies: a scaffold that does not load is a bug, not a task.
  const task = loadTaskDir(result.dir);
  const verify = await expectFailCheck(task);
  const red = verify.status === "fail";
  const next = nextStepCommands({ name, tasksDir, suite });

  if (args.values.json) {
    process.stdout.write(
      JSON.stringify(
        {
          dir: result.dir,
          files: result.files,
          task: { id: task.id, workspace: task.workspace, suites: task.meta?.suites ?? [], verifyTimeoutMs: task.verifyTimeoutMs ?? null },
          expectFail: { ok: red, verify },
          next,
        },
        null,
        2,
      ) + "\n",
    );
  } else {
    const shown = path.join(tasksDir, name);
    const lines = [
      `created    ${shown}/`,
      ...result.files.map((f) => `             ${f}`),
      `task       ${task.id} (suite ${suite}, workspace ${task.workspace}, verify timeout ${task.verifyTimeoutMs ?? DEFAULT_VERIFY_TIMEOUT_MS}ms)`,
      `${formatVerifyLine(verify)}  expect-fail: ${red ? "ok, an unimplemented task is red" : "NOT red"}`,
      ...(verify.outputTail !== undefined ? verify.outputTail.trimEnd().split("\n").map((l) => `             ${l}`) : []),
    ];
    if (red) {
      lines.push(
        `next       edit ${path.join(shown, "task.md")} and ${path.join(shown, "verify.sh")}${withTests ? ` (and ${path.join(shown, "tests")}/)` : ""}, then:`,
        ...next.map((c) => `             ${c}`),
      );
    }
    process.stdout.write(lines.join("\n") + "\n");
  }
  if (!red) {
    process.stderr.write(
      `trial new: the scaffolded verifier did not fail on an empty workspace (status ${verify.status}); ` +
        `the files are kept in ${result.dir}\n`,
    );
    return 1;
  }
  return 0;
}
