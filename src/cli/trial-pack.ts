// `ach trial --pack <path|name>@<version>` (#91): run exactly the tasks of a
// versioned task pack (src/cli/task-pack.ts) through the matrix runner.
//
// Order matters: the pack is resolved (every prompt file and task directory
// read and hashed) and checked against its lockfile BEFORE agents are picked
// or a driver exists, so a missing task or a hash mismatch launches nothing.
// The plan is built in code like a suite's (src/cli/trial-suite.ts) and runs
// through executeMatrixCli; every cell's RunRecord gets the `pack` block.
//
// The ledger is keyed by name, version AND a short content hash, so two
// versions never share verdicts and a drifted run never resumes cells that
// ran against other content.
import path from "node:path";

import { stateDir as defaultStateDir } from "../core/store.ts";
import { formatSandboxHeader } from "../core/sandbox-policy.ts";
import { HarnessError, type EffortLevel, type SandboxPolicy } from "../core/types.ts";
import { checkPackLock, packRunInfo, resolvePackRef, type ResolvedPack } from "./task-pack.ts";
import { executeMatrixCli, parseMatrixPlan, type ExecuteMatrixCliOptions, type MatrixPlan } from "./trial-matrix.ts";
import { selectAgents, siblingPaths, writeCellArtifact, writeTaskSetReport, type SuitePaths } from "./trial-suite.ts";

/** Experiment label for a pack: `pack/<name>@<version>`. */
export const packExperiment = (pack: Pick<ResolvedPack, "ref">): string => `pack/${pack.ref}`;

/** Default ledger `<stateDir>/packs-runs/<name>@<version>-<hash12>.ledger.jsonl`; runs and report sit next to it. */
export function packPaths(pack: Pick<ResolvedPack, "ref" | "hash">, ledgerOverride?: string, stateDir: string = defaultStateDir()): SuitePaths {
  const key = `${pack.ref}-${pack.hash.slice("sha256:".length, "sha256:".length + 12)}`;
  return siblingPaths(ledgerOverride !== undefined ? path.resolve(ledgerOverride) : path.join(stateDir, "packs-runs", `${key}.ledger.jsonl`));
}

export function buildPackPlan(o: {
  pack: ResolvedPack;
  agents: readonly string[];
  models?: readonly string[];
  trials?: number;
  sandbox?: SandboxPolicy;
  effort?: EffortLevel;
}): MatrixPlan {
  return parseMatrixPlan(
    {
      experiment: packExperiment(o.pack),
      agents: [...o.agents],
      tasks: o.pack.tasks.map((t) => t.task),
      ...(o.models !== undefined && o.models.length > 0 ? { models: [...o.models] } : {}),
      ...(o.trials !== undefined ? { trials: o.trials } : {}),
      ...(o.sandbox !== undefined ? { sandbox: o.sandbox } : {}),
      ...(o.effort !== undefined ? { effort: o.effort } : {}),
    },
    `pack ${o.pack.ref}`,
  );
}

export interface PackCliOptions {
  pack: string;
  packsDir?: string;
  allowDrift: boolean;
  agents: readonly string[];
  models: readonly string[];
  repeat?: string;
  ledger?: string;
  dryRun: boolean;
  retryFailed: boolean;
  json: boolean;
  hermetic?: boolean;
  isolate?: ExecuteMatrixCliOptions["isolate"];
  sandbox?: SandboxPolicy;
  effort?: EffortLevel;
  capture?: ExecuteMatrixCliOptions["capture"];
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

export async function runPackCli(o: PackCliOptions): Promise<number> {
  const trials = parseRepeat(o.repeat);
  // 1. Resolve and hash every task, then 2. verify the lock: both before any agent is considered.
  const pack = resolvePackRef(o.pack, o.packsDir !== undefined ? { packsDir: o.packsDir } : {});
  const check = checkPackLock(pack, o.allowDrift);
  // Drift warnings go to stderr even under --json: they must be seen.
  for (const w of check.warnings) process.stderr.write(`[warn] ${w}\n`);
  const info = packRunInfo(pack, check);

  const selection = selectAgents(o.agents, o.probe);
  if (!o.json) for (const s of selection.skipped) process.stderr.write(`skipped: ${s.agent} (${s.reason})\n`);
  const paths = packPaths(pack, o.ledger);
  const jsonExtra = {
    pack: { ...info, ref: pack.ref, tasks: pack.tasks.map((t) => ({ id: t.id, hash: t.hash })) },
    tasks: pack.tasks.map((t) => t.id),
    skippedAgents: selection.skipped,
  };
  if (selection.run.length === 0) {
    if (o.json) process.stdout.write(JSON.stringify({ ...jsonExtra, experiment: packExperiment(pack), cells: [] }, null, 2) + "\n");
    throw new HarnessError(
      `pack ${pack.ref}: no agent to run (every candidate was skipped: ${selection.skipped.map((s) => s.agent).join(", ")}). ` +
        "Install an agent CLI, or pass --agent null for an offline smoke run.",
      "UNAVAILABLE",
    );
  }
  const plan = buildPackPlan({
    pack,
    agents: selection.run,
    models: o.models,
    ...(trials !== undefined ? { trials } : {}),
    ...(o.sandbox !== undefined ? { sandbox: o.sandbox } : {}),
    ...(o.effort !== undefined ? { effort: o.effort } : {}),
  });
  if (!o.json) {
    process.stderr.write(
      `pack       ${pack.ref} ${pack.hash} (${check.locked ? (check.drift.length > 0 ? "locked, DRIFTED" : "locked") : "unlocked"}): ` +
        `${pack.tasks.length} task(s) x ${selection.run.length} agent(s) [${selection.run.join(", ")}] from ${pack.manifestPath}\n`,
    );
    if (o.sandbox !== undefined) process.stderr.write(formatSandboxHeader(o.sandbox) + "\n");
  }
  return executeMatrixCli({
    plan,
    baseDir: pack.dir,
    ledgerPath: paths.ledger,
    dryRun: o.dryRun,
    retryFailed: o.retryFailed,
    json: o.json,
    ...(o.hermetic === true ? { hermetic: true } : {}),
    ...(o.isolate !== undefined ? { isolate: o.isolate } : {}),
    ...(o.capture !== undefined ? { capture: o.capture } : {}),
    pack: { info, taskHashes: Object.fromEntries(pack.tasks.map((t) => [t.id, t.hash])) },
    jsonExtra,
    onOutcome: (cell, outcome) => {
      if (outcome.result !== undefined) writeCellArtifact(paths.runs, cell, outcome);
    },
    after: () => writeTaskSetReport(paths, pack.tasks.map((t) => t.id)),
  });
}
