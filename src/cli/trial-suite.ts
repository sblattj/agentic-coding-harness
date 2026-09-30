// Bundled task suites (#51): `ach trial --suite core`.
//
// A suite is every task directory under `tasks/` whose meta.json lists the
// suite name in `suites`. `--suite` builds a MatrixPlan of `{dir}` tasks in
// code and runs it through the same executeMatrixCli path as
// `ach trial --matrix` (src/cli/trial-matrix.ts), so ledger, resume, outcome
// classification and exit code are identical. On top of that it:
//   - picks agents: every built-in agent whose CLI is installed (the null
//     negative control excluded unless named), or the `--agent` list; a
//     missing CLI prints `skipped: <agent> (<reason>)` and gets no cells;
//   - keeps its ledger in the state dir, keyed by suite name;
//   - writes one RunResult artifact per launched cell, grouped by task, and
//     renders the `ach report` HTML comparison over them after the grid.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { stateDir as defaultStateDir } from "../core/store.ts";
import { AGENTS, HarnessError, isKnownAgent } from "../core/types.ts";
import { agentCliAvailability } from "../mcp/tools-run.ts";
import { writeComparisonReport } from "./report.ts";
import {
  DEFAULT_MODEL_TOKEN,
  executeMatrixCli,
  loadTaskDir,
  parseMatrixPlan,
  type MatrixCell,
  type MatrixPlan,
  type ResolvedTask,
} from "./trial-matrix.ts";
import type { TrialOutcome } from "./trials.ts";

/** The negative-control agent: always available, so never implied by "every installed agent". */
const NULL_AGENT = "null";

// ------------------------------------------------------------ tasks dir

/**
 * Where the bundled `tasks/` directory would be relative to this module:
 * `<repo>/tasks` from `src/cli/trial-suite.ts` (checkout, tsx), and
 * `<package>/tasks` from `dist/cli/ach.js` / `dist/bun/ach.js` (npm install,
 * Homebrew — both ship the npm tarball, whose `files` includes `tasks`).
 * null inside a `bun build --compile` binary, whose modules live on the
 * virtual `/$bunfs/` filesystem and carry no task files.
 */
export function bundledTasksDir(moduleUrl: string = import.meta.url): string | null {
  if (moduleUrl.includes("$bunfs") || moduleUrl.includes("~BUN")) return null;
  let file: string;
  try {
    file = fileURLToPath(moduleUrl);
  } catch {
    return null;
  }
  return path.resolve(path.dirname(file), "..", "..", "tasks");
}

function hasTaskDirs(dir: string): boolean {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).some((e) => e.isDirectory() && fs.existsSync(path.join(dir, e.name, "task.md")));
  } catch {
    return false;
  }
}

/** `--tasks-dir` when given (must exist), else the bundled directory; USAGE error pointing at `--tasks-dir` otherwise. */
export function resolveTasksDir(override?: string, moduleUrl?: string): string {
  if (override !== undefined) {
    const abs = path.resolve(override);
    if (!hasTaskDirs(abs)) throw new HarnessError(`--tasks-dir ${abs}: no task directories (<name>/task.md) found`, "USAGE");
    return abs;
  }
  const bundled = bundledTasksDir(moduleUrl);
  if (bundled !== null && hasTaskDirs(bundled)) return bundled;
  throw new HarnessError(
    "bundled tasks/ directory not found" +
      (bundled === null ? " (a compiled single-binary build does not carry it)" : ` (looked in ${bundled})`) +
      "; pass --tasks-dir <path to a checkout's or npm package's tasks/>",
    "USAGE",
  );
}

export interface SuiteTask {
  /** Directory name (also the task id unless meta.json sets one). */
  name: string;
  task: ResolvedTask;
}

/** Every task directory in `tasksDir` whose meta.json `suites` contains `suite`, sorted by name. */
export function listSuiteTasks(tasksDir: string, suite: string): SuiteTask[] {
  const out: SuiteTask[] = [];
  for (const e of fs.readdirSync(tasksDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!e.isDirectory() || !fs.existsSync(path.join(tasksDir, e.name, "task.md"))) continue;
    const task = loadTaskDir(path.join(tasksDir, e.name));
    const suites = task.meta?.suites;
    if (Array.isArray(suites) && suites.includes(suite)) out.push({ name: e.name, task });
  }
  return out;
}

/** Every suite name any task in `tasksDir` declares. */
export function knownSuites(tasksDir: string): string[] {
  const names = new Set<string>();
  for (const e of fs.readdirSync(tasksDir, { withFileTypes: true })) {
    if (!e.isDirectory() || !fs.existsSync(path.join(tasksDir, e.name, "task.md"))) continue;
    const suites = loadTaskDir(path.join(tasksDir, e.name)).meta?.suites;
    if (Array.isArray(suites)) for (const s of suites) if (typeof s === "string") names.add(s);
  }
  return [...names].sort();
}

// ------------------------------------------------------------ agents

export interface AgentSelection {
  run: string[];
  skipped: { agent: string; reason: string }[];
}

/**
 * No `requested` → every built-in agent except `null` whose CLI is on PATH.
 * With `requested` → those agents, minus built-ins whose CLI is absent.
 * Uses the `harness_agents` probe (agentCliAvailability); agents.d names are
 * not probed here (a missing descriptor CLI surfaces at run time as
 * `skipped-unavailable`).
 */
export function selectAgents(
  requested: readonly string[],
  probe: (name: string) => { command: string | null; available: boolean } = agentCliAvailability,
): AgentSelection {
  const names = requested.length > 0 ? [...new Set(requested)] : AGENTS.filter((a) => a !== NULL_AGENT);
  const sel: AgentSelection = { run: [], skipped: [] };
  for (const agent of names) {
    if (!isKnownAgent(agent)) {
      sel.run.push(agent);
      continue;
    }
    const { command, available } = probe(agent);
    if (available) sel.run.push(agent);
    else sel.skipped.push({ agent, reason: `${command ?? agent} not found on PATH` });
  }
  return sel;
}

// ------------------------------------------------------------ paths + plan

export interface SuitePaths {
  ledger: string;
  /** Per-cell RunResult artifacts: `<runs>/<task>/<agent>~<model>~trialN.json`. */
  runs: string;
  report: string;
}

/**
 * Default ledger: `<stateDir>/suites/<suite>.ledger.jsonl`. Workspaces go to
 * `<suite>.work/` (runMatrix's defaultWorkRoot), artifacts to `<suite>.runs/`,
 * the HTML report to `<suite>.report.html` — all next to the ledger, also
 * when `--ledger` moves it.
 */
export function suitePaths(suite: string, ledgerOverride?: string, stateDir: string = defaultStateDir()): SuitePaths {
  const ledger = ledgerOverride !== undefined ? path.resolve(ledgerOverride) : path.join(stateDir, "suites", `${suite}.ledger.jsonl`);
  const base = ledger.replace(/(\.ledger)?\.jsonl$/i, "");
  return { ledger, runs: `${base}.runs`, report: `${base}.report.html` };
}

/** Experiment label for a suite: `suite/<name>`. */
export const suiteExperiment = (suite: string): string => `suite/${suite}`;

export function buildSuitePlan(o: {
  suite: string;
  tasks: readonly SuiteTask[];
  agents: readonly string[];
  models?: readonly string[];
  trials?: number;
}): MatrixPlan {
  return parseMatrixPlan(
    {
      experiment: suiteExperiment(o.suite),
      agents: [...o.agents],
      tasks: o.tasks.map((t) => ({ dir: t.task.dir! })),
      ...(o.models !== undefined && o.models.length > 0 ? { models: [...o.models] } : {}),
      ...(o.trials !== undefined ? { trials: o.trials } : {}),
    },
    `suite ${o.suite}`,
  );
}

function artifactPath(runsDir: string, cell: MatrixCell): string {
  const safe = (s: string): string => s.replace(/[^A-Za-z0-9._-]/g, "_");
  return path.join(runsDir, cell.task.id, `${safe(cell.agent)}~${safe(cell.model ?? DEFAULT_MODEL_TOKEN)}~trial${cell.trial}.json`);
}

/** One `ach report`-loadable RunResult per launched cell; a retry overwrites the earlier attempt. */
export function writeCellArtifact(runsDir: string, cell: MatrixCell, outcome: TrialOutcome): string {
  const file = artifactPath(runsDir, cell);
  const result = outcome.result!;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const artifact = {
    ...result,
    agent: cell.agent,
    variant: cell.variant,
    experiment: cell.experiment,
    cellId: cell.cellId,
    task: cell.task.id,
    ...(outcome.verify !== undefined ? { verify: outcome.verify } : {}),
  };
  fs.writeFileSync(file, JSON.stringify(artifact, null, 2) + "\n");
  fs.writeFileSync(file.replace(/\.json$/, ".secs"), `${(result.durationMs / 1000).toFixed(3)}\n`);
  return file;
}

// ------------------------------------------------------------ CLI

export interface SuiteCliOptions {
  suite: string;
  /** `--task` names (directory names or task ids); empty = the whole suite. */
  tasks: readonly string[];
  /** `--agent` names; empty = every installed built-in agent. */
  agents: readonly string[];
  models: readonly string[];
  /** `--repeat N` → the plan's `trials`. */
  repeat?: string;
  tasksDir?: string;
  ledger?: string;
  dryRun: boolean;
  retryFailed: boolean;
  json: boolean;
  /** Tests: the agent-availability probe. */
  probe?: (name: string) => { command: string | null; available: boolean };
}

function parseRepeat(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!/^\d+$/.test(raw.trim()) || !Number.isSafeInteger(n) || n < 1) {
    throw new HarnessError(`--repeat must be a positive integer (got '${raw}')`, "USAGE");
  }
  return n;
}

export async function runSuiteCli(o: SuiteCliOptions): Promise<number> {
  const suite = o.suite.trim();
  if (!/^[A-Za-z0-9._-]+$/.test(suite)) throw new HarnessError(`--suite must match [A-Za-z0-9._-]+ (got '${o.suite}')`, "USAGE");
  const trials = parseRepeat(o.repeat);
  const tasksDir = resolveTasksDir(o.tasksDir);
  let tasks = listSuiteTasks(tasksDir, suite);
  if (tasks.length === 0) {
    const known = knownSuites(tasksDir);
    throw new HarnessError(`no tasks in suite '${suite}' under ${tasksDir} (suites: ${known.join(", ") || "none"})`, "USAGE");
  }
  if (o.tasks.length > 0) {
    const wanted = new Set(o.tasks);
    const unknown = [...wanted].filter((w) => !tasks.some((t) => t.name === w || t.task.id === w));
    if (unknown.length > 0) {
      throw new HarnessError(
        `--task ${unknown.join(", ")}: not in suite '${suite}' (tasks: ${tasks.map((t) => t.task.id).join(", ")})`,
        "USAGE",
      );
    }
    tasks = tasks.filter((t) => wanted.has(t.name) || wanted.has(t.task.id));
  }

  const selection = selectAgents(o.agents, o.probe);
  if (!o.json) for (const s of selection.skipped) process.stderr.write(`skipped: ${s.agent} (${s.reason})\n`);
  const paths = suitePaths(suite, o.ledger);
  const jsonExtra = {
    suite,
    tasksDir,
    tasks: tasks.map((t) => t.task.id),
    skippedAgents: selection.skipped,
  };
  if (selection.run.length === 0) {
    if (o.json) process.stdout.write(JSON.stringify({ ...jsonExtra, experiment: suiteExperiment(suite), cells: [] }, null, 2) + "\n");
    throw new HarnessError(
      `suite ${suite}: no agent to run (every candidate was skipped: ${selection.skipped.map((s) => s.agent).join(", ")}). ` +
        "Install an agent CLI, or pass --agent null for an offline smoke run.",
      "UNAVAILABLE",
    );
  }

  const plan = buildSuitePlan({
    suite,
    tasks,
    agents: selection.run,
    models: o.models,
    ...(trials !== undefined ? { trials } : {}),
  });
  if (!o.json) {
    process.stderr.write(
      `suite      ${suite}: ${tasks.length} task(s) × ${selection.run.length} agent(s) [${selection.run.join(", ")}] from ${tasksDir}\n`,
    );
  }
  return executeMatrixCli({
    plan,
    baseDir: tasksDir,
    ledgerPath: paths.ledger,
    dryRun: o.dryRun,
    retryFailed: o.retryFailed,
    json: o.json,
    jsonExtra,
    onOutcome: (cell, outcome) => {
      if (outcome.result !== undefined) writeCellArtifact(paths.runs, cell, outcome);
    },
    after: async () => {
      // Report over this plan's tasks only; each task directory is one
      // "trial" in the report, with every agent × model × trial run in it.
      const roots = tasks.map((t) => path.join(paths.runs, t.task.id)).filter((d) => fs.existsSync(d));
      if (roots.length === 0) {
        return { json: { report: null }, lines: ["report     none (no run artifacts for these tasks)"] };
      }
      const r = await writeComparisonReport(roots, paths.report);
      return {
        json: { report: r.out, reportRuns: r.runs },
        lines: [`report     ${r.out} (${r.runs} runs · ${r.trials} task${r.trials === 1 ? "" : "s"})`],
      };
    },
  });
}
