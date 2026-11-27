// `harness report` — render a self-contained single-file HTML comparison of
// agent trial runs (per-agent RunResult JSON + .secs + .stderr artifacts).
import fs from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { HarnessError } from "../core/types.ts";
import { loadedRunFromRecord, loadTrials, type LoadedRun } from "../report/model.ts";
import {
  readRunRecord,
  registryDir,
  scanRunRecords,
  skippedRunRecordsWarning,
  type RunRecord,
} from "../core/registry.ts";
import {
  computeLeaderboard,
  LEADERBOARD_FILE,
  leaderboardJson,
  recordFromLoadedRun,
  sortRecords,
  type LeaderboardDoc,
  type SealStatus,
} from "../report/leaderboard.ts";
import { verdictLabel, verifyRunRecord } from "./verify-run.ts";
import { stateDir } from "../core/store.ts";
import { branchLabel } from "./stats-dims.ts";
import { readVersion, renderReport } from "../report/html.ts";
import { MASK_OPTIONS, maskForExport, type Finding, type MaskMode, type MaskPolicy } from "../core/masking.ts";
import { maskPolicyFor, noteMasked, notePrivacy, writeMaskPreview } from "./mask-cli.ts";
import { PRIVACY_OPTIONS, type PrivacyMode } from "../core/privacy.ts";

export async function cmdReport(rest: string[]): Promise<number> {
  const args = parseArgs({
    args: rest,
    options: {
      out: { type: "string" },
      json: { type: "boolean" },
      registry: { type: "boolean" },
      limit: { type: "string" },
      ...MASK_OPTIONS,
      ...PRIVACY_OPTIONS,
    },
    allowPositionals: true,
  });
  const roots = args.positionals;
  const registry = args.values.registry === true;
  if (registry && roots.length > 0) {
    throw new HarnessError("report --registry reads the run registry; drop the trials directory arguments", "USAGE");
  }
  if (!registry && args.values.limit !== undefined) {
    throw new HarnessError("report --limit applies only with --registry", "USAGE");
  }
  if (!registry && roots.length === 0) {
    throw new HarnessError("report requires a trials directory (e.g. trials/20260910-091011), or --registry", "USAGE");
  }
  let limit: number | undefined;
  if (args.values.limit !== undefined) {
    limit = Number(args.values.limit);
    if (!Number.isInteger(limit) || limit < 1) throw new HarnessError(`--limit must be a positive integer, got '${args.values.limit}'`, "USAGE");
  }
  const json = args.values.json === true;
  const r = await writeComparisonReport(roots, args.values.out, maskPolicyFor("report", args.values), {
    json,
    ...(registry ? { registry: { ...(limit !== undefined ? { limit } : {}) } } : {}),
  });
  if (r.maskMode === "preview") {
    writeMaskPreview(r.out, r.maskFindings);
    return 0;
  }
  if (r.maskMode === "all") noteMasked(r.out, r.maskFindings);
  notePrivacy(r.out, r.privacy);
  // #46: `--json` with no --out prints the report model instead of writing HTML.
  if (r.json !== undefined) {
    process.stdout.write(r.json);
    return 0;
  }
  process.stdout.write(
    `wrote ${r.out} (${r.runs} runs · ${r.trials} trial${r.trials === 1 ? "" : "s"})\n`,
  );
  if (r.leaderboard !== undefined) process.stdout.write(`wrote ${r.leaderboard} (${r.leagueRows} league row${r.leagueRows === 1 ? "" : "s"})\n`);
  return 0;
}

export interface WrittenReport {
  out: string;
  runs: number;
  trials: number;
  /** #71: what masking found (empty in mode none); in mode preview nothing was written. */
  maskFindings: Finding[];
  maskMode: MaskMode;
  /** #46: the privacy mode applied (stamped into the HTML / JSON when not off). */
  privacy: PrivacyMode;
  /** #46: the JSON document, when `json` was asked for with no `outPath` (nothing was written). */
  json?: string;
  /** #90: path of the leaderboard.json written next to the HTML (HTML mode only). */
  leaderboard?: string;
  /** #90: league-table rows (experiment x variant groups). */
  leagueRows: number;
}

export interface ReportWriteOptions {
  /** #46: write (or return) the report model as JSON instead of HTML. */
  json?: boolean;
  /** #90: source the run set from `<stateDir>/runs/` instead of trial directories (newest `limit` runs when set). */
  registry?: { limit?: number };
}

/** The report model before the export gate: runs, plus the league table over their records. */
export interface ReportModel {
  rootDir: string;
  labels: string[];
  runs: LoadedRun[];
  leaderboard: LeaderboardDoc;
}

/** Label of the single pseudo-trial `--registry` reports. */
export const REGISTRY_TRIAL_LABEL = "registry";

/**
 * Load the run set and fold the league table (#90). Trial runs join their
 * RunRecord by run id (verdicts, branch, seal); the league rolls up the
 * RECORDS, the same input /api/compare reads, falling back to a stand-in
 * built from the trial artifact when a run has no record.
 */
export async function loadReportModel(roots: readonly string[], opts: ReportWriteOptions = {}): Promise<ReportModel> {
  const dir = stateDir();
  let runs: LoadedRun[] = [];
  const labels = new Set<string>();
  let rootDir: string | null = null;
  const records = new Map<LoadedRun, RunRecord>();
  if (opts.registry !== undefined) {
    const scan = scanRunRecords(dir);
    const warn = skippedRunRecordsWarning(dir, scan.skipped);
    if (warn !== null) process.stderr.write(warn + "\n");
    // scanRunRecords is newest first; --limit keeps the newest N, then the
    // set is ordered oldest first with run id breaking ties (stable output).
    const picked = sortRecords(opts.registry.limit === undefined ? scan.records : scan.records.slice(0, opts.registry.limit));
    if (picked.length === 0) throw new HarnessError(`no run records under '${registryDir(dir)}'`, "IO");
    rootDir = registryDir(dir);
    labels.add(REGISTRY_TRIAL_LABEL);
    for (const rec of picked) {
      const run = loadedRunFromRecord(rec, rootDir, REGISTRY_TRIAL_LABEL);
      runs.push(run);
      records.set(run, rec);
    }
  } else {
    if (roots.length === 0) throw new HarnessError("report requires at least one trials directory", "USAGE");
    // One positional may expand to many trials (a `trials/` root scans its
    // subdirectories); several positionals are reported side by side.
    for (const root of roots) {
      const trialSet = await loadTrials(root);
      if (rootDir === null) rootDir = trialSet.rootDir;
      runs = runs.concat(trialSet.runs);
      for (const l of trialSet.labels) labels.add(l);
    }
  }
  // Join only by the immutable run id; session ids can contain multiple runs.
  // Registry verdicts are read-only annotations, never changes to trial JSON.
  const seals = new Map<string, SealStatus>();
  for (const run of runs) {
    if (!run.result.runId) continue;
    const record = records.get(run) ?? readRunRecord(dir, run.result.runId);
    if (record !== null) records.set(run, record);
    if (run.verify === undefined && record?.verify !== undefined) run.verify = record.verify;
    if (record?.regrades !== undefined) run.regrades = record.regrades;
    const branch = record === null ? undefined : branchLabel(record);
    if (branch !== undefined) run.branch = branch;
    if (run.pack === undefined && record?.pack !== undefined) run.pack = record.pack;
    // #59: per-run seal verdict, so readers know the numbers are intact.
    if (record !== null) {
      const v = verifyRunRecord(dir, record);
      run.seal = { status: v.status, detail: `${verdictLabel(v)}${v.sealHash ? ` · seal ${v.sealHash}` : ""}` };
      seals.set(record.runId, v.status);
    }
  }
  const leaderboard = computeLeaderboard(
    runs.map((r) => records.get(r) ?? recordFromLoadedRun(r)),
    seals,
  );
  return { rootDir: rootDir ?? path.resolve(roots[0] ?? "."), labels: [...labels].sort(), runs, leaderboard };
}

/** The `ach report --json` document: the privacy stamp first, then the report model. */
export function reportJson(
  privacy: PrivacyMode,
  model: { rootDir: string; labels: string[]; runs: unknown[]; leaderboard?: unknown },
): string {
  return JSON.stringify({ privacy, ...model }, null, 2) + "\n";
}

/**
 * The whole of `ach report` minus argument parsing and printing: load every
 * root, join registry verdicts by run id, render, write. `out` defaults to
 * `<root>/report.html` for one root, else `./report.html`. Also used by
 * `ach trial --suite` (#51) for its end-of-grid report.
 */
export async function writeComparisonReport(
  roots: readonly string[],
  outPath?: string,
  mask?: MaskPolicy,
  opts: ReportWriteOptions = {},
): Promise<WrittenReport> {
  const model = await loadReportModel(roots, opts);
  const root = model.rootDir;
  const runs = model.runs;
  const fromRegistry = opts.registry !== undefined;

  const out =
    outPath ??
    (opts.json === true ? "-" : !fromRegistry && roots.length === 1 ? path.join(root, "report.html") : path.resolve("report.html"));
  // #71: the export chokepoint, on the report model before it is rendered
  // (#46: it applies the privacy mode first).
  // #90: the league table rides in the same gated value, so anon hashes its
  // run ids exactly as it hashes the per-run rows.
  const gate = maskForExport(model, mask);
  const base: WrittenReport = {
    out,
    runs: runs.length,
    trials: model.labels.length,
    maskFindings: gate.findings,
    maskMode: gate.mode,
    privacy: gate.privacy,
    leagueRows: model.leaderboard.rows.length,
  };
  if (gate.mode === "preview") return base;
  if (opts.json === true) {
    const body = reportJson(gate.privacy, gate.value);
    if (outPath === undefined) return { ...base, json: body };
    await fs.mkdir(path.dirname(path.resolve(out)), { recursive: true });
    await fs.writeFile(out, body);
    return base;
  }
  // #90: no wall-clock stamp; the footer shows the newest run time in the
  // set (when any run has one), so unchanged runs give byte-identical files.
  const asOf = gate.value.leaderboard.dataAsOf;
  const body = renderReport(gate.value, {
    version: await readVersion(),
    ...(asOf !== null ? { dataAsOf: new Date(asOf) } : {}),
    ...(gate.privacy !== "off" ? { privacy: gate.privacy } : {}),
  });
  await fs.mkdir(path.dirname(path.resolve(out)), { recursive: true });
  await fs.writeFile(out, body);
  const leaderboardPath = path.join(path.dirname(path.resolve(out)), LEADERBOARD_FILE);
  await fs.writeFile(leaderboardPath, leaderboardJson(gate.value.leaderboard));
  return { ...base, leaderboard: leaderboardPath };
}
