// `harness report` — render a self-contained single-file HTML comparison of
// agent trial runs (per-agent RunResult JSON + .secs + .stderr artifacts).
import fs from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { HarnessError } from "../core/types.ts";
import { loadTrials } from "../report/model.ts";
import { readRunRecord } from "../core/registry.ts";
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
    options: { out: { type: "string" }, json: { type: "boolean" }, ...MASK_OPTIONS, ...PRIVACY_OPTIONS },
    allowPositionals: true,
  });
  const roots = args.positionals;
  if (roots.length === 0) {
    throw new HarnessError("report requires a trials directory (e.g. trials/20260910-091011)", "USAGE");
  }
  const json = args.values.json === true;
  const r = await writeComparisonReport(roots, args.values.out, maskPolicyFor("report", args.values), { json });
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
}

export interface ReportWriteOptions {
  /** #46: write (or return) the report model as JSON instead of HTML. */
  json?: boolean;
}

/** The `ach report --json` document: the privacy stamp first, then the report model. */
export function reportJson(privacy: PrivacyMode, model: { rootDir: string; labels: string[]; runs: unknown[] }): string {
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
  if (roots.length === 0) throw new HarnessError("report requires at least one trials directory", "USAGE");
  // One positional may expand to many trials (a `trials/` root scans its
  // subdirectories); several positionals are reported side by side.
  let runs: Awaited<ReturnType<typeof loadTrials>>["runs"] = [];
  const labels = new Set<string>();
  let rootDir: string | null = null;
  for (const root of roots) {
    const trialSet = await loadTrials(root);
    if (rootDir === null) rootDir = trialSet.rootDir;
    runs = runs.concat(trialSet.runs);
    for (const l of trialSet.labels) labels.add(l);
  }
  // Join only by the immutable run id; session ids can contain multiple runs.
  // Registry verdicts are read-only annotations, never changes to trial JSON.
  for (const run of runs) {
    if (!run.result.runId) continue;
    const record = readRunRecord(stateDir(), run.result.runId);
    if (run.verify === undefined && record?.verify !== undefined) run.verify = record.verify;
    if (record?.regrades !== undefined) run.regrades = record.regrades;
    const branch = record === null ? undefined : branchLabel(record);
    if (branch !== undefined) run.branch = branch;
    // #59: per-run seal verdict, so readers know the numbers are intact.
    if (record !== null) {
      const v = verifyRunRecord(stateDir(), record);
      run.seal = { status: v.status, detail: `${verdictLabel(v)}${v.sealHash ? ` · seal ${v.sealHash}` : ""}` };
    }
  }
  const root = rootDir ?? path.resolve(roots[0] ?? ".");

  const out =
    outPath ?? (opts.json === true ? "-" : roots.length === 1 ? path.join(root, "report.html") : path.resolve("report.html"));
  // #71: the export chokepoint, on the report model before it is rendered
  // (#46: it applies the privacy mode first).
  const gate = maskForExport({ rootDir: root, labels: [...labels].sort(), runs }, mask);
  const base = { out, runs: runs.length, trials: labels.size, maskFindings: gate.findings, maskMode: gate.mode, privacy: gate.privacy };
  if (gate.mode === "preview") return base;
  const body =
    opts.json === true
      ? reportJson(gate.privacy, gate.value)
      : renderReport(gate.value, {
          version: await readVersion(),
          generatedAt: new Date(),
          ...(gate.privacy !== "off" ? { privacy: gate.privacy } : {}),
        });
  if (opts.json === true && outPath === undefined) return { ...base, json: body };
  await fs.mkdir(path.dirname(path.resolve(out)), { recursive: true });
  await fs.writeFile(out, body);
  return base;
}
