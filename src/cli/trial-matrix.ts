// Resumable trial matrices (#56): `ach trial --matrix plan.json`.
//
// A plan declares agents × tasks × models × trials-per-cell. Every cell gets
// a deterministic id `agent:task:model:trialN` and becomes one child run
// through the SAME path `ach run --verify --experiment --variant` uses
// (src/cli/trials.ts runOnce): the driver writes the RunRecord, the verifier
// runs afterwards, and the labels (experiment, variant, cellId) are patched
// onto the record — so `/api/compare` groups matrix runs with no changes.
//
// Resume contract: one append-only JSONL ledger (default `<plan>.ledger.jsonl`
// next to the plan) holds one row per cell ATTEMPT. A row is appended only
// after runOnce has resolved — i.e. after driver.run()'s forced final registry
// write and the label/verify annotation — so a process killed mid-cell leaves
// that cell with no row, and re-invoking the same command runs it again. On
// re-invocation the LAST row per cellId decides: `completed` → skipped,
// `failed` → reported as failed and NOT re-run unless `--retry-failed`.
//
// The task model is shared with the bundled task suite (#51): a task is
// either inline ({id, prompt, setup?, verify?}) or a task directory
// ({dir}: prompt from task.md, setup.sh / verify.sh when present, meta.json
// passthrough). A suite is expanded in code with `loadTaskDir` + a
// MatrixPlan literal, then run through `runMatrix`.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";

import { createDriver, defaultAdapters, type Driver } from "../core/driver.ts";
import { createPricer, type Pricer } from "../core/pricing.ts";
import { stateDir as defaultStateDir } from "../core/store.ts";
import { HarnessError, isKnownAgent, type AgentAdapter, type RunSpec } from "../core/types.ts";
import { DEFAULT_VERIFY_TIMEOUT_MS, runVerifier, type VerifyStatus } from "../core/verify.ts";
import { isTranscriptOnlyAgent, readOnlySourceMessage } from "../monitors/transcript-sources.ts";
import { loadCatalog, reportCatalogIssues, resolveRunAgent } from "./custom-agents.ts";
import { outcomeOk, runOnce, type TrialOutcome } from "./trials.ts";

// ------------------------------------------------------------------ schema

/** Cellid token for "no --model" (the adapter's default model). */
export const DEFAULT_MODEL_TOKEN = "default";
/** Default setup-step timeout (the verify timeout default is DEFAULT_VERIFY_TIMEOUT_MS). */
export const DEFAULT_SETUP_TIMEOUT_MS = 300_000;
/** Default variant template: one compare row per agent × model. */
export const DEFAULT_VARIANT_TEMPLATE = "{agent}:{model}";

const ID_RE = /^[A-Za-z0-9._-]+$/;
const TaskIdSchema = z
  .string()
  .regex(ID_RE, { error: "task id must match [A-Za-z0-9._-]+ (no ':' — it separates cellId parts)" });
const PositiveInt = z.number().int().positive();
const WorkspaceSchema = z.enum(["fresh", "shared"]);

/** Inline task: the prompt is in the plan. */
export const InlineTaskSchema = z
  .object({
    id: TaskIdSchema,
    prompt: z.string().min(1),
    /** Agent cwd for `workspace: "shared"` (relative to the plan's directory). */
    cwd: z.string().min(1).optional(),
    /** Shell command run (via /bin/sh -c, in the cell workspace) before the agent; non-zero exit fails the cell. */
    setup: z.string().min(1).optional(),
    /** Checker run after the agent (same contract as `ach run --verify`). */
    verify: z.string().min(1).optional(),
    /** "shared" (default for inline tasks): run in `cwd`; "fresh": an empty per-cell directory. */
    workspace: WorkspaceSchema.optional(),
    setupTimeoutMs: PositiveInt.optional(),
    verifyTimeoutMs: PositiveInt.optional(),
  })
  .strict();

/** Task directory (#51 layout): task.md (required), setup.sh, verify.sh, meta.json (optional). */
export const DirTaskSchema = z
  .object({
    /** Task directory, relative to the plan's directory. */
    dir: z.string().min(1),
    /** Overrides meta.json `id`, then the directory basename. */
    id: TaskIdSchema.optional(),
    /** Default "fresh" for task directories. */
    workspace: WorkspaceSchema.optional(),
    setupTimeoutMs: PositiveInt.optional(),
    verifyTimeoutMs: PositiveInt.optional(),
  })
  .strict();

export const MatrixTaskSchema = z.union([InlineTaskSchema, DirTaskSchema]);

/** meta.json inside a task directory. Unknown keys are kept (suites, tags, ...). */
export const TaskMetaSchema = z
  .object({
    id: TaskIdSchema.optional(),
    description: z.string().optional(),
    workspace: WorkspaceSchema.optional(),
    setupTimeoutMs: PositiveInt.optional(),
    verifyTimeoutMs: PositiveInt.optional(),
  })
  .passthrough();

/** An agent entry: a name, or a name with its own model list (overrides plan `models`). */
export const MatrixAgentSchema = z.union([
  z.string().min(1),
  z.object({ agent: z.string().min(1), models: z.array(z.string().min(1)).min(1).optional() }).strict(),
]);

export const MatrixPlanSchema = z
  .object({
    $schema: z.string().optional(),
    /** Compare-view experiment label stamped on every child run. */
    experiment: z.string().min(1),
    agents: z.array(MatrixAgentSchema).min(1),
    tasks: z.array(MatrixTaskSchema).min(1),
    /** Models crossed with every agent that has no own `models`; omitted → the adapter default ("default" in the cellId). */
    models: z.array(z.string().min(1)).min(1).optional(),
    /** Trials per cell (fresh session each). */
    trials: PositiveInt.default(1),
    /** Variant label template; placeholders {agent} {model} {task}. */
    variant: z.string().min(1).default(DEFAULT_VARIANT_TEMPLATE),
    /** Per-run budget caps, as `ach run --budget-usd/--max-turns/--wall-ms/--idle-ms`. */
    budget: z
      .object({
        usd: z.number().positive().optional(),
        maxTurns: PositiveInt.optional(),
        wallMs: z.number().positive().optional(),
        idleMs: z.number().positive().optional(),
      })
      .strict()
      .optional(),
    /** Default agent cwd for shared-workspace tasks (relative to the plan's directory; default: that directory). */
    cwd: z.string().min(1).optional(),
    setupTimeoutMs: PositiveInt.optional(),
    verifyTimeoutMs: PositiveInt.optional(),
  })
  .strict();

export type MatrixPlan = z.output<typeof MatrixPlanSchema>;
export type MatrixPlanInput = z.input<typeof MatrixPlanSchema>;
export type MatrixTaskInput = z.input<typeof MatrixTaskSchema>;
export type TaskMeta = z.output<typeof TaskMetaSchema>;

/** A task after resolution: what a cell actually needs. */
export interface ResolvedTask {
  id: string;
  prompt: string;
  setup?: string;
  verify?: string;
  workspace: "fresh" | "shared";
  /** Absolute agent cwd for shared-workspace tasks. */
  cwd?: string;
  /** Absolute task directory (task-directory tasks only). */
  dir?: string;
  setupTimeoutMs?: number;
  verifyTimeoutMs?: number;
  meta?: TaskMeta;
}

export interface MatrixCell {
  /** `agent:task:model:trialN` (model = "default" when the plan gives none). */
  cellId: string;
  /** 0-based position in expansion order. */
  index: number;
  agent: string;
  /** undefined → no --model (adapter default). */
  model?: string;
  task: ResolvedTask;
  /** 1-based trial number. */
  trial: number;
  experiment: string;
  variant: string;
}

/** Parse + validate a plan object; USAGE HarnessError listing every issue. */
export function parseMatrixPlan(raw: unknown, source = "plan"): MatrixPlan {
  const parsed = MatrixPlanSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
    throw new HarnessError(`invalid matrix ${source}: ${issues}`, "USAGE");
  }
  return parsed.data;
}

/** Read + parse a plan file. */
export function loadMatrixPlan(file: string): MatrixPlan {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (e) {
    throw new HarnessError(`cannot read matrix plan ${file}: ${e instanceof Error ? e.message : String(e)}`, "USAGE");
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (e) {
    throw new HarnessError(`matrix plan ${file} is not JSON: ${e instanceof Error ? e.message : String(e)}`, "USAGE");
  }
  return parseMatrixPlan(json, `plan ${file}`);
}

const shQuote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * Resolve a task directory: task.md → prompt (required, non-empty),
 * setup.sh / verify.sh → `sh '<abs path>'` commands when present,
 * meta.json → TaskMeta (optional). Id: `overrides.id` ?? meta.id ?? basename.
 * Workspace defaults to "fresh" (setup.sh prepares an empty per-cell dir).
 */
export function loadTaskDir(
  dir: string,
  overrides: Partial<Pick<ResolvedTask, "id" | "workspace" | "setupTimeoutMs" | "verifyTimeoutMs">> = {},
): ResolvedTask {
  const abs = path.resolve(dir);
  let prompt: string;
  try {
    prompt = fs.readFileSync(path.join(abs, "task.md"), "utf8").trim();
  } catch (e) {
    throw new HarnessError(`task directory ${abs} has no readable task.md: ${e instanceof Error ? e.message : String(e)}`, "USAGE");
  }
  if (prompt === "") throw new HarnessError(`task directory ${abs}: task.md is empty`, "USAGE");
  let meta: TaskMeta | undefined;
  const metaFile = path.join(abs, "meta.json");
  if (fs.existsSync(metaFile)) {
    let json: unknown;
    try {
      json = JSON.parse(fs.readFileSync(metaFile, "utf8"));
    } catch (e) {
      throw new HarnessError(`${metaFile} is not JSON: ${e instanceof Error ? e.message : String(e)}`, "USAGE");
    }
    const parsed = TaskMetaSchema.safeParse(json);
    if (!parsed.success) {
      throw new HarnessError(
        `invalid ${metaFile}: ${parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")}`,
        "USAGE",
      );
    }
    meta = parsed.data;
  }
  const id = overrides.id ?? meta?.id ?? path.basename(abs);
  if (!ID_RE.test(id)) {
    throw new HarnessError(`task directory ${abs}: id '${id}' must match [A-Za-z0-9._-]+ (set meta.json "id")`, "USAGE");
  }
  const setupFile = path.join(abs, "setup.sh");
  const verifyFile = path.join(abs, "verify.sh");
  const setupTimeoutMs = overrides.setupTimeoutMs ?? meta?.setupTimeoutMs;
  const verifyTimeoutMs = overrides.verifyTimeoutMs ?? meta?.verifyTimeoutMs;
  return {
    id,
    prompt,
    workspace: overrides.workspace ?? meta?.workspace ?? "fresh",
    dir: abs,
    ...(fs.existsSync(setupFile) ? { setup: `sh ${shQuote(setupFile)}` } : {}),
    ...(fs.existsSync(verifyFile) ? { verify: `sh ${shQuote(verifyFile)}` } : {}),
    ...(setupTimeoutMs !== undefined ? { setupTimeoutMs } : {}),
    ...(verifyTimeoutMs !== undefined ? { verifyTimeoutMs } : {}),
    ...(meta !== undefined ? { meta } : {}),
  };
}

/** Resolve one plan task relative to `baseDir` (the plan file's directory). */
export function resolveTask(task: z.output<typeof MatrixTaskSchema>, baseDir: string, planCwd?: string): ResolvedTask {
  if ("dir" in task) {
    const resolved = loadTaskDir(path.resolve(baseDir, task.dir), {
      ...(task.id !== undefined ? { id: task.id } : {}),
      ...(task.workspace !== undefined ? { workspace: task.workspace } : {}),
      ...(task.setupTimeoutMs !== undefined ? { setupTimeoutMs: task.setupTimeoutMs } : {}),
      ...(task.verifyTimeoutMs !== undefined ? { verifyTimeoutMs: task.verifyTimeoutMs } : {}),
    });
    return resolved.workspace === "shared" ? { ...resolved, cwd: path.resolve(baseDir, planCwd ?? ".") } : resolved;
  }
  const workspace = task.workspace ?? "shared";
  return {
    id: task.id,
    prompt: task.prompt,
    workspace,
    ...(workspace === "shared" ? { cwd: path.resolve(baseDir, task.cwd ?? planCwd ?? ".") } : {}),
    ...(task.setup !== undefined ? { setup: task.setup } : {}),
    ...(task.verify !== undefined ? { verify: task.verify } : {}),
    ...(task.setupTimeoutMs !== undefined ? { setupTimeoutMs: task.setupTimeoutMs } : {}),
    ...(task.verifyTimeoutMs !== undefined ? { verifyTimeoutMs: task.verifyTimeoutMs } : {}),
  };
}

/** The deterministic cell identity. */
export function cellIdOf(agent: string, taskId: string, model: string | undefined, trial: number): string {
  return `${agent}:${taskId}:${model ?? DEFAULT_MODEL_TOKEN}:trial${trial}`;
}

function renderVariant(template: string, agent: string, model: string | undefined, taskId: string): string {
  return template
    .replaceAll("{agent}", agent)
    .replaceAll("{model}", model ?? DEFAULT_MODEL_TOKEN)
    .replaceAll("{task}", taskId);
}

/**
 * Expand a plan into its cells, in order agent → task → model → trial.
 * Relative task `dir`/`cwd` resolve against `baseDir`. Throws USAGE on a
 * duplicate task id or cellId.
 */
export function expandMatrix(plan: MatrixPlan, baseDir: string): MatrixCell[] {
  const tasks = plan.tasks.map((t) => resolveTask(t, baseDir, plan.cwd));
  const seenTasks = new Set<string>();
  for (const t of tasks) {
    if (seenTasks.has(t.id)) throw new HarnessError(`matrix plan: duplicate task id '${t.id}'`, "USAGE");
    seenTasks.add(t.id);
  }
  const cells: MatrixCell[] = [];
  const seen = new Set<string>();
  for (const entry of plan.agents) {
    const agent = typeof entry === "string" ? entry : entry.agent;
    const models: (string | undefined)[] =
      (typeof entry === "string" ? undefined : entry.models) ?? plan.models ?? [undefined];
    for (const task of tasks) {
      for (const rawModel of models) {
        // A literal "default" means the adapter default: no --model.
        const model = rawModel === DEFAULT_MODEL_TOKEN ? undefined : rawModel;
        for (let trial = 1; trial <= plan.trials; trial++) {
          const cellId = cellIdOf(agent, task.id, model, trial);
          if (seen.has(cellId)) throw new HarnessError(`matrix plan: duplicate cell '${cellId}'`, "USAGE");
          seen.add(cellId);
          cells.push({
            cellId,
            index: cells.length,
            agent,
            ...(model !== undefined ? { model } : {}),
            task,
            trial,
            experiment: plan.experiment,
            variant: renderVariant(plan.variant, agent, model, task.id),
          });
        }
      }
    }
  }
  return cells;
}

// ------------------------------------------------------------------ ledger

export type CellStatus = "completed" | "failed";

/** One cell attempt. Appended only once the attempt has finalized. */
export interface LedgerRow {
  v: 1;
  cellId: string;
  experiment: string;
  variant: string;
  agent: string;
  task: string;
  /** null = adapter default model. */
  model: string | null;
  trial: number;
  /** completed = agent exitStatus success AND (no checker, or checker pass) — `outcomeOk`. */
  status: CellStatus;
  /** Registry run id; null when no run was launched (setup failed) or launch threw. */
  runId: string | null;
  exitStatus?: string;
  verify?: VerifyStatus;
  error?: string;
  startedAt: number;
  endedAt: number;
}

const LedgerRowSchema = z
  .object({
    v: z.literal(1),
    cellId: z.string().min(1),
    status: z.enum(["completed", "failed"]),
    runId: z.string().nullable(),
  })
  .passthrough();

/** Default ledger path: `<plan without .json>.ledger.jsonl`, next to the plan. */
export function defaultLedgerPath(planFile: string): string {
  const abs = path.resolve(planFile);
  return abs.replace(/\.json$/i, "") + ".ledger.jsonl";
}

/** Default fresh-workspace root: `<ledger without .ledger.jsonl>.work/`. */
export function defaultWorkRoot(ledgerPath: string): string {
  return ledgerPath.replace(/(\.ledger)?\.jsonl$/i, "") + ".work";
}

export interface LedgerRead {
  rows: LedgerRow[];
  /** Lines that were not a valid row (e.g. a torn final line) — ignored. */
  malformed: number;
}

/** Read the ledger (missing file → empty). Malformed lines are skipped and counted. */
export function readLedger(file: string): LedgerRead {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { rows: [], malformed: 0 };
    throw e;
  }
  const rows: LedgerRow[] = [];
  let malformed = 0;
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const parsed = LedgerRowSchema.safeParse(JSON.parse(line));
      if (parsed.success) rows.push(parsed.data as unknown as LedgerRow);
      else malformed++;
    } catch {
      malformed++;
    }
  }
  return { rows, malformed };
}

/** Append one row as a single line, fsynced before returning. */
export function appendLedgerRow(file: string, row: LedgerRow): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const fd = fs.openSync(file, "a");
  try {
    fs.writeSync(fd, JSON.stringify(row) + "\n");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

export type CellAction = "run" | "skip" | "failed";

export interface CellPlanEntry {
  cell: MatrixCell;
  /** run = no finalized attempt yet (or a failed one under retryFailed); skip = completed; failed = failed, not retried. */
  action: CellAction;
  /** Latest ledger row for the cell, if any. */
  last?: LedgerRow;
}

/** Decide each cell's action from the ledger: the LAST row per cellId wins. */
export function planStatus(cells: readonly MatrixCell[], rows: readonly LedgerRow[], opts: { retryFailed?: boolean } = {}): CellPlanEntry[] {
  const last = new Map<string, LedgerRow>();
  for (const r of rows) last.set(r.cellId, r);
  return cells.map((cell) => {
    const row = last.get(cell.cellId);
    if (row === undefined) return { cell, action: "run" as const };
    if (row.status === "completed") return { cell, action: "skip" as const, last: row };
    return { cell, action: opts.retryFailed ? ("run" as const) : ("failed" as const), last: row };
  });
}

// ------------------------------------------------------------------ runner

export interface CellReport {
  cellId: string;
  /** What happened in THIS invocation. */
  outcome: "completed" | "failed" | "skipped" | "failed-not-retried" | "pending";
  runId?: string | null;
  exitStatus?: string;
  verify?: VerifyStatus;
  error?: string;
}

export interface MatrixSummary {
  total: number;
  /** Cells run to completion by this invocation. */
  completed: number;
  /** Cells skipped because the ledger already had them completed. */
  skipped: number;
  /** Cells that failed in this invocation plus earlier failures not retried. */
  failed: number;
  /** Cells not attempted because the run was interrupted. */
  pending: number;
  interrupted: boolean;
  cells: CellReport[];
}

export interface RunMatrixOptions {
  cells: readonly MatrixCell[];
  ledgerPath: string;
  driver: Pick<Driver, "run">;
  /** State dir whose registry the driver writes (annotations land here). */
  stateDir: string;
  budget?: MatrixPlan["budget"];
  retryFailed?: boolean;
  /** Fresh-workspace root (default: defaultWorkRoot(ledgerPath)). */
  workRoot?: string;
  /** Plan-level timeouts; task-level values win. */
  setupTimeoutMs?: number;
  verifyTimeoutMs?: number;
  /**
   * Interruption: checked before each cell, and raced against the in-flight
   * cell. An abort mid-cell writes NO ledger row for that cell (it stays
   * pending, exactly like a killed process).
   */
  signal?: AbortSignal;
  /** Called as each cell is decided / settles. */
  onCell?: (report: CellReport, cell: MatrixCell) => void;
  /** Called right before a cell launches (setup included). */
  onCellStart?: (cell: MatrixCell) => void;
}

class Interrupted extends Error {}

function raceAbort<T>(p: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return p;
  if (signal.aborted) return Promise.reject(new Interrupted("aborted"));
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(new Interrupted("aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(e);
      },
    );
  });
}

function workspaceName(cellId: string): string {
  const safe = cellId.replace(/[^A-Za-z0-9._-]/g, "_");
  return `${safe}-${createHash("sha256").update(cellId).digest("hex").slice(0, 8)}`;
}

function cellEnv(cell: MatrixCell, cwd: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ACH_CELL_ID: cell.cellId,
    ACH_EXPERIMENT: cell.experiment,
    ACH_VARIANT: cell.variant,
    ACH_AGENT: cell.agent,
    ACH_MODEL: cell.model ?? DEFAULT_MODEL_TOKEN,
    ACH_TASK_ID: cell.task.id,
    ACH_TRIAL: String(cell.trial),
    ACH_WORKSPACE: cwd,
    ...(cell.task.dir !== undefined ? { ACH_TASK_DIR: cell.task.dir } : {}),
  };
}

/** Run one cell attempt; returns the ledger row to append. Throws Interrupted on abort. */
async function runCell(cell: MatrixCell, opts: RunMatrixOptions): Promise<LedgerRow> {
  const startedAt = Date.now();
  const base = {
    v: 1 as const,
    cellId: cell.cellId,
    experiment: cell.experiment,
    variant: cell.variant,
    agent: cell.agent,
    task: cell.task.id,
    model: cell.model ?? null,
    trial: cell.trial,
    startedAt,
  };
  let cwd: string;
  if (cell.task.workspace === "fresh") {
    cwd = path.join(opts.workRoot ?? defaultWorkRoot(opts.ledgerPath), workspaceName(cell.cellId));
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.mkdirSync(cwd, { recursive: true });
  } else {
    cwd = cell.task.cwd ?? process.cwd();
  }
  const env = cellEnv(cell, cwd);
  if (cell.task.setup !== undefined) {
    const setup = await raceAbort(
      runVerifier({
        command: cell.task.setup,
        cwd,
        env,
        timeoutMs: cell.task.setupTimeoutMs ?? opts.setupTimeoutMs ?? DEFAULT_SETUP_TIMEOUT_MS,
      }),
      opts.signal,
    );
    if (setup.status !== "pass") {
      const detail = setup.timedOut
        ? "timed out"
        : setup.exitCode !== null
          ? `exit ${setup.exitCode}`
          : (setup.error ?? (setup.signal ? `signal ${setup.signal}` : "did not run"));
      const tail = setup.outputTail?.trim();
      return {
        ...base,
        status: "failed",
        runId: null,
        error: `setup failed (${detail})${tail ? `: ${tail.slice(-500)}` : ""}`,
        endedAt: Date.now(),
      };
    }
  }
  const spec: RunSpec = {
    prompt: cell.task.prompt,
    cwd,
    variant: cell.variant,
    ...(cell.model !== undefined ? { model: cell.model } : {}),
    ...(opts.budget !== undefined ? { budget: { ...opts.budget } } : {}),
  };
  let outcome: TrialOutcome;
  try {
    outcome = await raceAbort(
      runOnce({
        driver: opts.driver,
        agent: cell.agent,
        spec,
        stateDir: opts.stateDir,
        labels: { experiment: cell.experiment, variant: cell.variant, cellId: cell.cellId },
        ...(cell.task.verify !== undefined
          ? {
              verify: {
                command: cell.task.verify,
                cwd,
                env,
                timeoutMs: cell.task.verifyTimeoutMs ?? opts.verifyTimeoutMs ?? DEFAULT_VERIFY_TIMEOUT_MS,
              },
            }
          : {}),
      }),
      opts.signal,
    );
  } catch (err) {
    if (err instanceof Interrupted) throw err;
    return {
      ...base,
      status: "failed",
      runId: null,
      error: err instanceof Error ? err.message : String(err),
      endedAt: Date.now(),
    };
  }
  const result = outcome.result!;
  return {
    ...base,
    status: outcomeOk(outcome) ? "completed" : "failed",
    runId: result.runId,
    exitStatus: result.exitStatus,
    ...(outcome.verify !== undefined ? { verify: outcome.verify.status } : {}),
    ...(outcome.annotateFailed ? { error: "registry: could not record labels/verify on the run" } : {}),
    endedAt: Date.now(),
  };
}

/**
 * Run every cell the ledger does not already account for, sequentially,
 * appending one ledger row per finalized attempt. Never throws for a failing
 * cell; an abort (opts.signal) stops the sweep and leaves the in-flight cell
 * without a row.
 */
export async function runMatrix(opts: RunMatrixOptions): Promise<MatrixSummary> {
  const { rows } = readLedger(opts.ledgerPath);
  const entries = planStatus(opts.cells, rows, { retryFailed: opts.retryFailed ?? false });
  const summary: MatrixSummary = {
    total: entries.length,
    completed: 0,
    skipped: 0,
    failed: 0,
    pending: 0,
    interrupted: false,
    cells: [],
  };
  const report = (r: CellReport, cell: MatrixCell): void => {
    summary.cells.push(r);
    opts.onCell?.(r, cell);
  };
  for (const { cell, action, last } of entries) {
    if (action === "skip") {
      summary.skipped++;
      report({ cellId: cell.cellId, outcome: "skipped", runId: last?.runId ?? null }, cell);
      continue;
    }
    if (action === "failed") {
      summary.failed++;
      report(
        {
          cellId: cell.cellId,
          outcome: "failed-not-retried",
          runId: last?.runId ?? null,
          ...(last?.exitStatus !== undefined ? { exitStatus: last.exitStatus } : {}),
          ...(last?.verify !== undefined ? { verify: last.verify } : {}),
          ...(last?.error !== undefined ? { error: last.error } : {}),
        },
        cell,
      );
      continue;
    }
    if (summary.interrupted || opts.signal?.aborted) {
      summary.interrupted = true;
      summary.pending++;
      report({ cellId: cell.cellId, outcome: "pending" }, cell);
      continue;
    }
    opts.onCellStart?.(cell);
    let row: LedgerRow;
    try {
      row = await runCell(cell, opts);
    } catch (err) {
      if (!(err instanceof Interrupted)) throw err;
      summary.interrupted = true;
      summary.pending++;
      report({ cellId: cell.cellId, outcome: "pending" }, cell);
      continue;
    }
    // The run is finalized (registry record written + annotated): only now
    // does the cell count as attempted.
    appendLedgerRow(opts.ledgerPath, row);
    if (row.status === "completed") summary.completed++;
    else summary.failed++;
    report(
      {
        cellId: cell.cellId,
        outcome: row.status,
        runId: row.runId,
        ...(row.exitStatus !== undefined ? { exitStatus: row.exitStatus } : {}),
        ...(row.verify !== undefined ? { verify: row.verify } : {}),
        ...(row.error !== undefined ? { error: row.error } : {}),
      },
      cell,
    );
  }
  return summary;
}

// ------------------------------------------------------------------ driver

/**
 * One driver for every agent in the cells: built-ins plus agents.d
 * descriptors. `custom` (needs --template) and read-only transcript sources
 * are rejected up front, before anything launches.
 */
export async function createMatrixDriver(agents: readonly string[], stateDir: string): Promise<Driver> {
  const unique = [...new Set(agents)];
  const extra: Record<string, AgentAdapter> = {};
  let pricer: Pricer = createPricer();
  const needsCatalog = unique.some((a) => !isKnownAgent(a));
  const catalog = needsCatalog ? loadCatalog() : { descriptors: [], errors: [], warnings: [] };
  if (needsCatalog) reportCatalogIssues(catalog);
  for (const agent of unique) {
    if (isTranscriptOnlyAgent(agent)) throw new HarnessError(readOnlySourceMessage(agent), "READ_ONLY_SOURCE");
    if (agent === "custom") {
      throw new HarnessError("matrix plans cannot use --agent custom (it needs --template); add an agents.d descriptor instead", "USAGE");
    }
    const resolved = resolveRunAgent(agent, {}, catalog);
    if (resolved.adapter) extra[agent] = resolved.adapter;
    if (resolved.wrapPricer) pricer = resolved.wrapPricer(pricer);
  }
  return createDriver({
    adapters: { ...(await defaultAdapters()), ...extra },
    stateDir,
    pricer,
    registry: { stateDir },
  });
}

// ------------------------------------------------------------------ CLI

const OUTCOME_LABEL: Record<CellReport["outcome"], string> = {
  completed: "completed",
  failed: "FAILED",
  skipped: "skip (completed earlier)",
  "failed-not-retried": "FAILED earlier (not retried; --retry-failed)",
  pending: "pending (interrupted)",
};

function cellLine(r: CellReport, i: number, total: number): string {
  const parts = [`[${i + 1}/${total}]`, r.cellId, OUTCOME_LABEL[r.outcome]];
  if (r.runId) parts.push(`run=${r.runId.slice(0, 8)}`);
  if (r.exitStatus !== undefined && r.exitStatus !== "success") parts.push(`exit=${r.exitStatus}`);
  if (r.verify !== undefined) parts.push(`verify=${r.verify}`);
  if (r.error !== undefined) parts.push(`error=${r.error.split("\n")[0]}`);
  return parts.join("  ");
}

export function formatMatrixSummary(s: MatrixSummary): string {
  return (
    `summary    ${s.total} cells · completed=${s.completed} skipped=${s.skipped} failed=${s.failed}` +
    (s.pending > 0 ? ` pending=${s.pending}` : "") +
    (s.interrupted ? " (interrupted)" : "")
  );
}

/** `ach trial --matrix plan.json [--dry-run] [--retry-failed] [--ledger PATH] [--json]`. */
export async function cmdTrial(rest: string[]): Promise<number> {
  const args = parseArgs({
    args: rest,
    options: {
      matrix: { type: "string" },
      "dry-run": { type: "boolean", default: false },
      "retry-failed": { type: "boolean", default: false },
      ledger: { type: "string" },
      json: { type: "boolean", default: false },
    },
    allowPositionals: false,
  });
  const planFile = args.values.matrix;
  if (planFile === undefined || planFile.trim() === "") {
    throw new HarnessError("trial requires --matrix <plan.json>", "USAGE");
  }
  return executeMatrixCli({
    plan: loadMatrixPlan(planFile),
    baseDir: path.dirname(path.resolve(planFile)),
    ledgerPath: args.values.ledger !== undefined ? path.resolve(args.values.ledger) : defaultLedgerPath(planFile),
    dryRun: args.values["dry-run"],
    retryFailed: args.values["retry-failed"],
    json: args.values.json,
  });
}

export interface ExecuteMatrixCliOptions {
  /** A parsed plan (loadMatrixPlan / parseMatrixPlan, or built in code by a suite). */
  plan: MatrixPlan;
  /** Directory relative task `dir` / `cwd` entries resolve against. */
  baseDir: string;
  ledgerPath: string;
  dryRun: boolean;
  retryFailed: boolean;
  json: boolean;
}

/**
 * Everything `ach trial --matrix` does after the plan is in hand: dry-run
 * listing, or driver + runMatrix + per-cell lines + summary. Returns the
 * exit code (1 when any cell is failed after this invocation, else 0).
 * A plan built in code (e.g. a task suite) goes through here unchanged.
 */
export async function executeMatrixCli(o: ExecuteMatrixCliOptions): Promise<number> {
  const { plan, ledgerPath, retryFailed, json } = o;
  const cells = expandMatrix(plan, o.baseDir);

  if (o.dryRun) {
    const { rows, malformed } = readLedger(ledgerPath);
    const entries = planStatus(cells, rows, { retryFailed });
    const count = (a: CellAction): number => entries.filter((e) => e.action === a).length;
    const summary = { total: entries.length, run: count("run"), skip: count("skip"), failed: count("failed") };
    if (json) {
      process.stdout.write(
        JSON.stringify(
          {
            dryRun: true,
            experiment: plan.experiment,
            ledger: ledgerPath,
            cells: entries.map((e) => ({
              cellId: e.cell.cellId,
              action: e.action,
              agent: e.cell.agent,
              task: e.cell.task.id,
              model: e.cell.model ?? null,
              trial: e.cell.trial,
              variant: e.cell.variant,
              ...(e.last !== undefined ? { last: { status: e.last.status, runId: e.last.runId } } : {}),
            })),
            summary,
            ...(malformed > 0 ? { malformedLedgerLines: malformed } : {}),
          },
          null,
          2,
        ) + "\n",
      );
    } else {
      const mark: Record<CellAction, string> = { run: "run ", skip: "skip", failed: "FAIL" };
      for (const e of entries) {
        process.stdout.write(`${mark[e.action]}  ${e.cell.cellId}${e.action === "failed" ? "  (failed earlier; --retry-failed re-runs it)" : ""}\n`);
      }
      process.stdout.write(
        `dry-run    ${summary.total} cells · would run=${summary.run} skip=${summary.skip} failed(not retried)=${summary.failed} · ledger ${ledgerPath}\n`,
      );
      if (malformed > 0) process.stderr.write(`[warn] ledger: ${malformed} malformed line(s) ignored\n`);
    }
    return 0;
  }

  const state = defaultStateDir();
  const driver = await createMatrixDriver(cells.map((c) => c.agent), state);
  const { malformed } = readLedger(ledgerPath);
  if (malformed > 0) process.stderr.write(`[warn] ledger: ${malformed} malformed line(s) ignored\n`);
  let i = 0;
  const summary = await runMatrix({
    cells,
    ledgerPath,
    driver,
    stateDir: state,
    retryFailed,
    ...(plan.budget !== undefined ? { budget: plan.budget } : {}),
    ...(plan.setupTimeoutMs !== undefined ? { setupTimeoutMs: plan.setupTimeoutMs } : {}),
    ...(plan.verifyTimeoutMs !== undefined ? { verifyTimeoutMs: plan.verifyTimeoutMs } : {}),
    onCellStart: (cell) => {
      if (!json) process.stderr.write(`[${cell.index + 1}/${cells.length}] ${cell.cellId}  running\n`);
    },
    onCell: (r) => {
      if (!json) process.stdout.write(cellLine(r, i, cells.length) + "\n");
      i++;
    },
  });
  if (json) {
    const { cells: reports, ...counts } = summary;
    process.stdout.write(JSON.stringify({ experiment: plan.experiment, ledger: ledgerPath, cells: reports, summary: counts }, null, 2) + "\n");
  } else {
    process.stdout.write(formatMatrixSummary(summary) + `\nledger     ${ledgerPath}\n`);
  }
  return summary.failed > 0 || summary.interrupted ? 1 : 0;
}
