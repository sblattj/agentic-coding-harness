// `ach scrub` (#71): share-time secret and PII scrubbing over exported
// artifacts (HTML reports, ATIF/OTel/Langfuse JSON, SFT JSONL, logs).
//
//   --mask preview  list every finding (file, location, detector, star
//                   sample -> replacement); touches no file.
//   --mask all      write scrubbed COPIES to distinct paths (`<name>.masked.<ext>`
//                   next to each file, or the same tree under --out-dir) with
//                   per-detector counts; originals are never edited.
//
// JSON files are parsed and masked leaf by leaf (location = JSON path), so a
// copy stays valid JSON; JSONL is masked per line; anything else is text
// (location = line:col). The detectors are src/core/masking.ts.
import fs from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { HarnessError } from "../core/types.ts";
import {
  countByDetector,
  detectorsFor,
  formatCounts,
  formatFindings,
  MASK_OPTIONS,
  maskText,
  maskValue,
  type Finding,
  type MaskOptions,
} from "../core/masking.ts";
import { maskPolicyFor } from "./mask-cli.ts";

/** Marker in the copies' names; files carrying it are not scanned again. */
export const MASKED_INFIX = ".masked";

export interface ScrubFileResult {
  file: string;
  /** Where the scrubbed copy went (mode all only). */
  out?: string;
  findings: Finding[];
  counts: Record<string, number>;
  skipped?: string;
}

/** The copy path for `file`: `--out-dir` keeps the tree under the scanned root, else `<name>.masked<ext>` beside it. */
export function maskedCopyPath(file: string, root: string, outDir: string | undefined): string {
  if (outDir !== undefined) return path.join(path.resolve(outDir), path.relative(root, file) || path.basename(file));
  const ext = path.extname(file);
  return path.join(path.dirname(file), `${path.basename(file, ext)}${MASKED_INFIX}${ext}`);
}

async function walk(p: string, outDirAbs: string | undefined): Promise<string[]> {
  const st = await fs.stat(p);
  if (!st.isDirectory()) return [p];
  const out: string[] = [];
  for (const e of (await fs.readdir(p, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(p, e.name);
    if (outDirAbs !== undefined && path.resolve(full) === outDirAbs) continue;
    if (e.isDirectory()) out.push(...(await walk(full, outDirAbs)));
    else if (e.isFile() && !e.name.includes(`${MASKED_INFIX}.`) && !e.name.endsWith(MASKED_INFIX)) out.push(full);
  }
  return out;
}

/** Mask one artifact's text by its kind; returns the masked text and findings. */
export function scrubText(file: string, text: string, opts: MaskOptions): { text: string; findings: Finding[] } {
  const ext = path.extname(file).toLowerCase();
  const detectors = detectorsFor(opts);
  if (ext === ".json") {
    let doc: unknown;
    try {
      doc = JSON.parse(text);
    } catch {
      doc = undefined;
    }
    if (doc !== undefined) {
      const r = maskValue(doc, opts);
      const indent = /^[[{]\s*?\n([ \t]+)/.exec(text)?.[1];
      const body = indent !== undefined ? JSON.stringify(r.value, null, indent) : JSON.stringify(r.value);
      return { text: body + (text.endsWith("\n") ? "\n" : ""), findings: r.findings };
    }
  }
  if (ext === ".jsonl" || ext === ".ndjson") {
    const findings: Finding[] = [];
    const lines = text.split("\n").map((line, i) => {
      if (line.trim() === "") return line;
      try {
        const r = maskValue(JSON.parse(line) as unknown, opts, `line ${i + 1} $`);
        findings.push(...r.findings);
        return JSON.stringify(r.value);
      } catch {
        const r = maskText(line, opts, undefined, detectors);
        findings.push(...r.findings.map((f) => ({ ...f, location: `${i + 1}:${f.location.split(":")[1]}` })));
        return r.text;
      }
    });
    return { text: lines.join("\n"), findings };
  }
  return maskText(text, opts, undefined, detectors);
}

export async function cmdScrub(rest: string[]): Promise<number> {
  const args = parseArgs({
    args: rest,
    options: { "out-dir": { type: "string" }, json: { type: "boolean" }, ...MASK_OPTIONS },
    allowPositionals: true,
  });
  const inputs = args.positionals;
  if (inputs.length === 0) throw new HarnessError("scrub requires one or more artifact files or directories", "USAGE");
  const policy = maskPolicyFor("scrub", args.values);
  if (policy.mode === "none") {
    throw new HarnessError("scrub: the mask mode is 'none' (the default); pass --mask preview (list findings) or --mask all (write scrubbed copies)", "USAGE");
  }
  const outDir = args.values["out-dir"];
  if (outDir !== undefined && policy.mode !== "all") throw new HarnessError("scrub: --out-dir only applies to --mask all", "USAGE");
  const outDirAbs = outDir !== undefined ? path.resolve(outDir) : undefined;

  const jobs: Array<{ file: string; root: string }> = [];
  for (const input of inputs) {
    let files: string[];
    try {
      files = await walk(input, outDirAbs);
    } catch (e) {
      throw new HarnessError(`scrub: cannot read '${input}': ${e instanceof Error ? e.message : e}`, "IO");
    }
    const st = await fs.stat(input);
    const root = st.isDirectory() ? input : path.dirname(input);
    for (const f of files) jobs.push({ file: f, root });
  }
  const inputSet = new Set(jobs.map((j) => path.resolve(j.file)));

  const results: ScrubFileResult[] = [];
  for (const { file, root } of jobs) {
    const buf = await fs.readFile(file);
    if (buf.subarray(0, 8192).includes(0)) {
      results.push({ file, findings: [], counts: {}, skipped: "binary" });
      continue;
    }
    const text = buf.toString("utf8");
    const r = scrubText(file, text, policy.options);
    const res: ScrubFileResult = { file, findings: r.findings, counts: countByDetector(r.findings) };
    if (policy.mode === "all") {
      const out = maskedCopyPath(file, root, outDir);
      if (inputSet.has(path.resolve(out))) {
        throw new HarnessError(`scrub: refusing to overwrite an input: '${out}' (originals are never edited; pick another --out-dir)`, "USAGE");
      }
      await fs.mkdir(path.dirname(out), { recursive: true });
      await fs.writeFile(out, r.text);
      res.out = out;
    }
    results.push(res);
  }

  const all = results.flatMap((r) => r.findings);
  if (args.values.json) {
    process.stdout.write(
      JSON.stringify({ mode: policy.mode, files: results, totals: { findings: all.length, counts: countByDetector(all) } }, null, 2) + "\n",
    );
    return 0;
  }
  for (const r of results) {
    if (r.skipped !== undefined) {
      process.stdout.write(`${r.file}: skipped (${r.skipped})\n`);
      continue;
    }
    if (policy.mode === "preview") process.stdout.write(formatFindings(r.file, r.findings));
    const n = r.findings.length;
    process.stdout.write(
      `${r.file}: ${n} finding${n === 1 ? "" : "s"} (${formatCounts(r.findings)})${r.out !== undefined ? ` -> wrote ${r.out}` : ""}\n`,
    );
  }
  const scanned = results.filter((r) => r.skipped === undefined).length;
  process.stdout.write(
    `scrub ${policy.mode}: ${scanned} file${scanned === 1 ? "" : "s"}, ${all.length} finding${all.length === 1 ? "" : "s"} (${formatCounts(all)})` +
      (policy.mode === "preview" ? "; nothing written" : "; originals unchanged") +
      "\n",
  );
  return 0;
}
