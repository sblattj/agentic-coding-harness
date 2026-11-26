// `ach export --out <dir>` (#96): one-command dump of everything the harness
// recorded, in a portable, self-describing shape.
//
// Where each kind of data lives (the dump mirrors these sources):
//   runs/         <stateDir>/runs/*.json, the run registry (src/core/registry.ts registryDir,
//                 writeRunRecord). Copied as bytes, unparseable files included.
//   events/       everything under <stateDir>/raw/: the driver's per-run event logs
//                 raw/<agent>-<session>.jsonl (src/core/driver.ts transcriptPath) and the
//                 watch / desk usage records raw/<agent>/<session>.jsonl (src/core/store.ts
//                 recordPath, src/desks/host-metering.ts rawFile). These are what the state
//                 side of `ach stats` reads (src/core/store.ts readStateDirRecords).
//   transcripts/  agent transcripts held inside the state dir: the `ach archive` warehouse
//                 <stateDir>/warehouse/ (src/core/warehouse-index.ts), copied whole. With
//                 --include-machine-dirs also the machine transcript dirs `ach stats` scans
//                 (src/monitors/transcripts.ts transcriptSources), under transcripts/machine/.
//   stats.json    the exact stdout of `ach stats --json` for the same state dir.
//   stats.csv     one row per aggregation bucket of stats.json.
//   manifest.json file list with per-file sha256, record counts, timestamp, ach version.
//
// Idempotent: a file whose sha256 already matches its destination is not
// rewritten. Interruptible: every file goes through <dest>.tmp-<pid> + rename,
// and the manifest is written last.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "./config.ts";
import { HarnessError } from "../core/types.ts";
import { stateDir } from "../core/store.ts";
import { parseRunRecordDetailed, registryDir, resolveRawTranscript } from "../core/registry.ts";
import { warehouseDir } from "../core/warehouse-index.ts";
import { transcriptSources, walkFiles, type ScanOptions } from "../monitors/transcripts.ts";
import { MASK_OPTIONS, maskForExport, type Finding, type MaskPolicy } from "../core/masking.ts";
import { maskPolicyFor, noteMasked, writeMaskPreview } from "./mask-cli.ts";
import { scrubText } from "./scrub.ts";

export const EXPORT_FORMAT = "ach-export";
export const EXPORT_FORMAT_VERSION = 1;
export const MANIFEST_FILE = "manifest.json";
/** The argv stats.json is the output of (recorded in the manifest). */
export const STATS_ARGV = ["stats", "--json"] as const;

export type ExportKind = "run" | "event" | "transcript" | "machine-transcript" | "stats";

export interface ManifestFile {
  /** Path inside the dump, `/`-separated. */
  path: string;
  kind: ExportKind;
  sha256: string;
  bytes: number;
  /** Absolute path the file was copied from (stats files: absent). */
  source?: string;
}

export interface MachineDirReport {
  agent: string;
  dir: string;
  exists: boolean;
  files: number;
  bytes: number;
  copied: boolean;
}

export interface ExportManifest {
  format: typeof EXPORT_FORMAT;
  v: typeof EXPORT_FORMAT_VERSION;
  achVersion: string;
  /** When THIS export ran; refreshed on every re-run (the manifest is always rewritten). */
  exportedAt: string;
  stateDir: string;
  options: { transcripts: boolean; includeMachineDirs: boolean; mask: MaskPolicy["mode"] };
  stats: { argv: string[] };
  counts: {
    files: number;
    runFiles: number;
    runRecords: number;
    unreadableRunRecords: number;
    eventFiles: number;
    eventLines: number;
    transcriptFiles: number;
    machineTranscriptFiles: number;
    statsRecords: number;
    statsCsvRows: number;
  };
  unreadableRunRecords: Array<{ file: string; reason: string }>;
  /** Machine transcript dirs outside the state dir: always reported, copied only with --include-machine-dirs. */
  machineDirs: MachineDirReport[];
  /** RunRecord.rawTranscript files that resolve OUTSIDE the state dir (a moved state dir): reported, copied only with --include-machine-dirs. */
  externalEventFiles: Array<{ runId: string; path: string; copied: boolean }>;
  files: ManifestFile[];
}

export interface ExportResult {
  out: string;
  written: number;
  skipped: number;
  removed: number;
  manifest: ExportManifest;
}

export interface ExportOptions {
  stateDir: string;
  out: string;
  transcripts: boolean;
  includeMachineDirs: boolean;
  version: string;
  /** Produces the exact stdout of `ach stats --json` (STATS_ARGV) for `stateDir`. */
  statsJson: () => Promise<string>;
  mask?: MaskPolicy;
  now?: () => Date;
  /** Machine transcript roots (default: the home dir, as `ach stats`); tests re-root them. */
  scan?: ScanOptions;
}

// ---------------------------------------------------------------- helpers

/** An in-flight atomic write (ours, registry.ts, warehouse.ts): never exported, swept from the dump. */
const TMP_RE = /\.tmp-\d+$/;

function sha256(buf: Buffer | string): string {
  return createHash("sha256").update(buf).digest("hex");
}

function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** Regular files under `dir` (symlinks are not followed), sorted, in-flight temp files skipped. */
function listFiles(dir: string): string[] {
  const out: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listFiles(full));
    else if (e.isFile() && !TMP_RE.test(e.name)) out.push(full);
  }
  return out;
}

const posix = (p: string): string => p.split(path.sep).join("/");

/** RFC 4180 field: quoted when it holds a comma, quote, CR or LF; quotes doubled. */
export function csvField(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = typeof v === "string" ? v : typeof v === "number" || typeof v === "boolean" ? String(v) : JSON.stringify(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export const STATS_CSV_COLUMNS = [
  "section",
  "key",
  "subkey",
  "records",
  "inputTokens",
  "outputTokens",
  "cacheReadTokens",
  "cacheWriteTokens",
  "reasoningTokens",
  "costUsd",
  "costSource",
  "unpricedRecords",
] as const;

function isBucket(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v) &&
    typeof (v as Record<string, unknown>).records === "number" && typeof (v as Record<string, unknown>).inputTokens === "number";
}

/**
 * Every token/cost aggregation bucket in a `ach stats --json` object, as
 * [section, key, subkey, bucket]: `total` itself, each entry of a bucket map
 * (byAgent, byDay, byWeek, byMonth, byModel, sources, origins, byProject,
 * byBranch, byPr, byDesk) and each entry of a two-level map (byModelDay).
 * Read from the stats object, never re-aggregated.
 */
export function statsBuckets(stats: Record<string, unknown>): Array<[string, string, string, Record<string, unknown>]> {
  const out: Array<[string, string, string, Record<string, unknown>]> = [];
  for (const [section, v] of Object.entries(stats)) {
    if (section === "compare") continue; // period totals, not buckets of this window
    if (isBucket(v)) {
      out.push([section, "", "", v]);
      continue;
    }
    if (typeof v !== "object" || v === null || Array.isArray(v)) continue;
    for (const [key, inner] of Object.entries(v as Record<string, unknown>)) {
      if (isBucket(inner)) out.push([section, key, "", inner]);
      else if (typeof inner === "object" && inner !== null && !Array.isArray(inner)) {
        for (const [sub, b] of Object.entries(inner as Record<string, unknown>)) if (isBucket(b)) out.push([section, key, sub, b]);
      }
    }
  }
  return out;
}

/** stats.csv text: a header, then one row per statsBuckets entry. CRLF line ends (RFC 4180). */
export function statsCsv(stats: Record<string, unknown>): { text: string; rows: number } {
  const lines = [STATS_CSV_COLUMNS.join(",")];
  const buckets = statsBuckets(stats);
  for (const [section, key, subkey, b] of buckets) {
    lines.push(
      [section, key, subkey, ...STATS_CSV_COLUMNS.slice(3).map((c) => b[c])].map(csvField).join(","),
    );
  }
  return { text: lines.join("\r\n") + "\r\n", rows: buckets.length };
}

// ---------------------------------------------------------------- core

interface PlannedFile {
  rel: string; // posix path inside the dump
  kind: ExportKind;
  source?: string;
  bytes: () => Buffer;
}

/**
 * Write one file into the dump: skipped when the destination already holds
 * the same sha256, else <dest>.tmp-<pid> then rename. The hash is of the
 * bytes written (a live event log may grow between reads).
 */
function place(out: string, rel: string, data: Buffer, counters: { written: number; skipped: number }): { sha256: string; bytes: number } {
  const dest = path.join(out, ...rel.split("/"));
  const hash = sha256(data);
  let same = false;
  try {
    const st = fs.lstatSync(dest);
    same = st.isFile() && st.size === data.length && sha256(fs.readFileSync(dest)) === hash;
  } catch {
    same = false;
  }
  if (same) {
    counters.skipped++;
  } else {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const tmp = `${dest}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, dest);
    counters.written++;
  }
  return { sha256: hash, bytes: data.length };
}

function maskBytes(rel: string, data: Buffer, policy: MaskPolicy): { data: Buffer; findings: Finding[] } {
  if (policy.mode === "none") return { data, findings: [] };
  const r = scrubText(rel, data.toString("utf8"), policy.options);
  return { data: policy.mode === "all" ? Buffer.from(r.text, "utf8") : data, findings: r.findings };
}

/** Remove every empty directory under `dir` (not `dir` itself). */
function pruneEmptyDirs(dir: string): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const full = path.join(dir, e.name);
    pruneEmptyDirs(full);
    try {
      if (fs.readdirSync(full).length === 0) fs.rmdirSync(full);
    } catch {
      /* raced or not empty */
    }
  }
}

function previousManifestPaths(out: string): string[] {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(out, MANIFEST_FILE), "utf8")) as { format?: unknown; files?: unknown };
    if (m.format !== EXPORT_FORMAT || !Array.isArray(m.files)) return [];
    return m.files.flatMap((f) => (typeof f === "object" && f !== null && typeof (f as { path?: unknown }).path === "string" ? [(f as { path: string }).path] : []));
  } catch {
    return [];
  }
}

const MANAGED_ROOTS = ["runs", "events", "transcripts"] as const;

export async function exportData(opts: ExportOptions): Promise<ExportResult & { findings: Array<{ source: string; findings: Finding[] }> }> {
  const sd = path.resolve(opts.stateDir);
  const out = path.resolve(opts.out);
  if (isInside(out, sd)) {
    throw new HarnessError(`export: --out must be outside the state dir (${sd}); got ${out}`, "USAGE");
  }
  const policy = opts.mask ?? { mode: "none", options: {} };
  const now = opts.now ?? (() => new Date());

  // ---- plan: what exists and where it lands
  const planned: PlannedFile[] = [];
  const readFrom = (file: string) => () => fs.readFileSync(file);

  const runsDir = registryDir(sd);
  const runFiles = listFiles(runsDir).filter((f) => path.dirname(f) === runsDir && f.endsWith(".json"));
  let runRecords = 0;
  const unreadable: Array<{ file: string; reason: string }> = [];
  const records: Array<{ runId: string; rec: ReturnType<typeof parseRunRecordDetailed> }> = [];
  for (const f of runFiles) {
    let text: string;
    try {
      text = fs.readFileSync(f, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") continue; // pruned since readdir
      throw new HarnessError(`export: cannot read ${f}: ${e instanceof Error ? e.message : String(e)}`, "EXPORT");
    }
    const r = parseRunRecordDetailed(text);
    if (r.ok) {
      runRecords++;
      records.push({ runId: r.record.runId, rec: r });
    } else unreadable.push({ file: path.basename(f), reason: r.reason });
    planned.push({ rel: `runs/${path.basename(f)}`, kind: "run", source: f, bytes: readFrom(f) });
  }

  const rawDir = path.join(sd, "raw");
  for (const f of listFiles(rawDir)) {
    planned.push({ rel: `events/${posix(path.relative(rawDir, f))}`, kind: "event", source: f, bytes: readFrom(f) });
  }

  if (opts.transcripts) {
    const wh = warehouseDir(sd);
    for (const f of listFiles(wh)) {
      planned.push({ rel: `transcripts/warehouse/${posix(path.relative(wh, f))}`, kind: "transcript", source: f, bytes: readFrom(f) });
    }
  }

  // Machine transcript dirs (outside the state dir): reported always, copied on request.
  const machineDirs: MachineDirReport[] = [];
  const sources = transcriptSources(opts.scan);
  for (const src of sources) {
    const exists = fs.existsSync(src.dir);
    const files = exists ? await walkFiles(src.dir, src.keep) : [];
    let bytes = 0;
    for (const f of files) {
      try {
        bytes += fs.statSync(f).size;
      } catch {
        /* vanished */
      }
    }
    machineDirs.push({ agent: src.agent, dir: src.dir, exists, files: files.length, bytes, copied: opts.includeMachineDirs && files.length > 0 });
    if (!opts.includeMachineDirs) continue;
    const siblings = sources.filter((s) => s.agent === src.agent);
    const prefix = siblings.length > 1 ? `__root${siblings.indexOf(src)}/` : "";
    for (const f of files) {
      if (isInside(f, sd)) continue;
      planned.push({ rel: `transcripts/machine/${src.agent}/${prefix}${posix(path.relative(src.dir, f))}`, kind: "machine-transcript", source: f, bytes: readFrom(f) });
    }
  }

  // Event logs a RunRecord points at outside the state dir (a moved state dir).
  const externalEventFiles: ExportManifest["externalEventFiles"] = [];
  for (const { rec } of records) {
    if (!rec.ok) continue;
    const t = resolveRawTranscript(sd, rec.record);
    if (!t || isInside(path.resolve(t), sd) || !fs.existsSync(t)) continue;
    const rel = `events/external/${path.basename(t)}`;
    let copied = false;
    if (opts.includeMachineDirs) {
      // Resumed sessions share one file (same source: copied once); a different file with the
      // same basename would collide on `rel` and is reported, not copied.
      if (planned.some((p) => p.source === t)) copied = true;
      else if (!planned.some((p) => p.rel === rel)) {
        planned.push({ rel, kind: "event", source: t, bytes: readFrom(t) });
        copied = true;
      }
    }
    externalEventFiles.push({ runId: rec.record.runId, path: t, copied });
  }

  // ---- stats (reused verbatim from `ach stats --json`)
  const statsText = await opts.statsJson();
  let statsObj: Record<string, unknown>;
  try {
    statsObj = JSON.parse(statsText) as Record<string, unknown>;
  } catch (e) {
    throw new HarnessError(`export: \`ach ${STATS_ARGV.join(" ")}\` did not print JSON: ${e instanceof Error ? e.message : String(e)}`, "EXPORT");
  }

  // ---- masking preview: scan everything, write nothing
  const allFindings: Array<{ source: string; findings: Finding[] }> = [];
  if (policy.mode === "preview") {
    for (const p of planned) {
      const r = maskBytes(p.rel, p.bytes(), policy);
      if (r.findings.length > 0) allFindings.push({ source: p.rel, findings: r.findings });
    }
    const s = maskForExport(statsObj, policy);
    if (s.findings.length > 0) allFindings.push({ source: "stats.json", findings: s.findings });
    return {
      out,
      written: 0,
      skipped: 0,
      removed: 0,
      findings: allFindings,
      manifest: emptyManifest(),
    };
  }

  // ---- write
  fs.mkdirSync(out, { recursive: true });
  const counters = { written: 0, skipped: 0 };
  const files: ManifestFile[] = [];
  let eventLines = 0;
  for (const p of planned) {
    let data: Buffer;
    try {
      data = p.bytes();
    } catch (e) {
      // Vanished between listing and reading (a prune race): skip. Anything else
      // (EACCES, EIO) fails the export before the prune and the manifest, so an
      // earlier dump is never trimmed to match a partial one.
      if ((e as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw new HarnessError(`export: cannot read ${p.source ?? p.rel}: ${e instanceof Error ? e.message : String(e)}`, "EXPORT");
    }
    if (policy.mode === "all" && data.includes(0)) {
      // Binary (a SQLite snapshot in the warehouse): text masking would corrupt it and cannot vouch for it.
      process.stderr.write(`[warn] export: ${p.rel} is binary; --mask all cannot scrub it, so it is not exported\n`);
      continue;
    }
    const m = maskBytes(p.rel, data, policy);
    if (m.findings.length > 0) allFindings.push({ source: p.rel, findings: m.findings });
    if (p.kind === "event") eventLines += m.data.toString("utf8").split("\n").filter((l) => l.trim() !== "").length;
    const w = place(out, p.rel, m.data, counters);
    files.push({ path: p.rel, kind: p.kind, sha256: w.sha256, bytes: w.bytes, ...(p.source !== undefined ? { source: p.source } : {}) });
  }
  for (const root of ["runs", "events"]) fs.mkdirSync(path.join(out, root), { recursive: true });

  const maskedStats = maskForExport(statsObj, policy);
  if (maskedStats.findings.length > 0) allFindings.push({ source: "stats.json", findings: maskedStats.findings });
  const statsOut = policy.mode === "all" ? JSON.stringify(maskedStats.value, null, 2) + "\n" : statsText;
  const sj = place(out, "stats.json", Buffer.from(statsOut, "utf8"), counters);
  files.push({ path: "stats.json", kind: "stats", sha256: sj.sha256, bytes: sj.bytes });
  const csv = statsCsv(maskedStats.value);
  const sc = place(out, "stats.csv", Buffer.from(csv.text, "utf8"), counters);
  files.push({ path: "stats.csv", kind: "stats", sha256: sc.sha256, bytes: sc.bytes });

  // ---- re-run hygiene: drop what an earlier export wrote that this one does not
  // (a gc'd run, transcripts/ on a --no-transcripts re-run), plus stray temp files.
  // Only paths the previous manifest listed are ever removed; unknown files stay.
  const now_ = new Set(files.map((f) => f.path));
  let removed = 0;
  for (const rel of previousManifestPaths(out)) {
    if (now_.has(rel) || rel === MANIFEST_FILE) continue;
    const dest = path.resolve(out, ...rel.split("/"));
    if (!isInside(dest, out) || dest === out) continue;
    try {
      fs.unlinkSync(dest);
      removed++;
    } catch {
      /* already gone */
    }
  }
  for (const root of MANAGED_ROOTS) {
    for (const f of listFilesWithTmp(path.join(out, root))) {
      try {
        fs.unlinkSync(f);
      } catch {
        /* raced */
      }
    }
    pruneEmptyDirs(path.join(out, root));
  }
  if (!opts.transcripts) {
    try {
      if (fs.readdirSync(path.join(out, "transcripts")).length === 0) fs.rmdirSync(path.join(out, "transcripts"));
    } catch {
      /* absent */
    }
  }

  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const count = (k: ExportKind) => files.filter((f) => f.kind === k).length;
  const statsTotal = statsObj.total as { records?: unknown } | undefined;
  const manifest: ExportManifest = {
    format: EXPORT_FORMAT,
    v: EXPORT_FORMAT_VERSION,
    achVersion: opts.version,
    exportedAt: now().toISOString(),
    stateDir: sd,
    options: { transcripts: opts.transcripts, includeMachineDirs: opts.includeMachineDirs, mask: policy.mode },
    stats: { argv: [...STATS_ARGV] },
    counts: {
      files: files.length,
      runFiles: count("run"),
      runRecords,
      unreadableRunRecords: unreadable.length,
      eventFiles: count("event"),
      eventLines,
      transcriptFiles: count("transcript"),
      machineTranscriptFiles: count("machine-transcript"),
      statsRecords: typeof statsTotal?.records === "number" ? statsTotal.records : 0,
      statsCsvRows: csv.rows,
    },
    unreadableRunRecords: unreadable,
    machineDirs,
    externalEventFiles,
    files,
  };
  if (policy.mode === "all") {
    // The home-path detector covers the manifest's absolute paths too; sha256 and dump paths stay as written.
    const m = (v: string) => maskForExport(v, policy).value;
    manifest.stateDir = m(manifest.stateDir);
    for (const d of manifest.machineDirs) d.dir = m(d.dir);
    for (const e of manifest.externalEventFiles) e.path = m(e.path);
    for (const f of manifest.files) if (f.source !== undefined) f.source = m(f.source);
  }
  // Last: a killed export leaves the previous manifest (or none), never a half-written one.
  const mf = path.join(out, MANIFEST_FILE);
  const tmp = `${mf}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(manifest, null, 2) + "\n");
  fs.renameSync(tmp, mf);
  return { out, written: counters.written, skipped: counters.skipped, removed, manifest, findings: allFindings };

  function emptyManifest(): ExportManifest {
    return {
      format: EXPORT_FORMAT, v: EXPORT_FORMAT_VERSION, achVersion: opts.version, exportedAt: now().toISOString(), stateDir: sd,
      options: { transcripts: opts.transcripts, includeMachineDirs: opts.includeMachineDirs, mask: policy.mode },
      stats: { argv: [...STATS_ARGV] },
      counts: { files: 0, runFiles: 0, runRecords, unreadableRunRecords: unreadable.length, eventFiles: 0, eventLines: 0, transcriptFiles: 0, machineTranscriptFiles: 0, statsRecords: 0, statsCsvRows: 0 },
      unreadableRunRecords: unreadable, machineDirs, externalEventFiles, files: [],
    };
  }
}

/** Leftover `*.tmp-<pid>` files (a killed export) under `dir`. */
function listFilesWithTmp(dir: string): string[] {
  const out: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listFilesWithTmp(full));
    else if (e.isFile() && TMP_RE.test(e.name)) out.push(full);
  }
  return out;
}

// ---------------------------------------------------------------- CLI

export const EXPORT_USAGE_LINES = `  ach export --out <dir> [--no-transcripts] [--include-machine-dirs] [--json]
               [--mask none|preview|all] [--mask-style replace|partial] [--mask-entropy] [--mask-pattern <regex>]...
                 (full data dump (#96): runs/ (registry RunRecords, byte-identical),
                  events/ (<stateDir>/raw event logs), transcripts/ (the ach archive
                  warehouse; --no-transcripts omits it), stats.json (= ach stats --json),
                  stats.csv (one row per bucket), manifest.json (sha256 per file, record
                  counts, ach version). Machine transcript dirs are listed in the manifest
                  and copied only with --include-machine-dirs. Re-runs skip identical
                  files. events/ holds full conversation content: --mask all or ach scrub
                  before sharing; docs/EXPORT.md)`;

export async function cmdExport(rest: string[], deps: { version: string; statsJson: () => Promise<string> }): Promise<number> {
  const args = parseArgs({
    args: rest,
    options: {
      out: { type: "string" },
      "no-transcripts": { type: "boolean", default: false },
      "include-machine-dirs": { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      ...MASK_OPTIONS,
    },
    allowPositionals: false,
  });
  const outDir = args.values.out;
  if (outDir === undefined || outDir.trim() === "") throw new HarnessError("export requires --out <dir>", "USAGE");
  if (args.values["no-transcripts"] && args.values["include-machine-dirs"]) {
    throw new HarnessError("export: --include-machine-dirs copies machine transcripts into transcripts/; it cannot be combined with --no-transcripts", "USAGE");
  }
  const policy = maskPolicyFor("export", args.values);
  const r = await exportData({
    stateDir: stateDir(),
    out: outDir,
    transcripts: !args.values["no-transcripts"],
    includeMachineDirs: args.values["include-machine-dirs"],
    version: deps.version,
    statsJson: deps.statsJson,
    mask: policy,
  });
  if (policy.mode === "preview") {
    const flat = r.findings.flatMap((f) => f.findings.map((x) => ({ ...x, location: `${f.source} ${x.location}` })));
    writeMaskPreview(`export ${r.out}`, flat);
    return 0;
  }
  if (policy.mode === "all") noteMasked(`export ${r.out}`, r.findings.flatMap((f) => f.findings));
  const c = r.manifest.counts;
  if (args.values.json) {
    process.stdout.write(JSON.stringify({ out: r.out, written: r.written, skipped: r.skipped, removed: r.removed, counts: c }) + "\n");
  } else {
    process.stdout.write(
      `export: ${c.files} file(s) in ${r.out} (written ${r.written}, skipped ${r.skipped} unchanged, removed ${r.removed})\n` +
        `  runs=${c.runRecords}${c.unreadableRunRecords > 0 ? ` (+${c.unreadableRunRecords} unreadable, copied as-is)` : ""} event-files=${c.eventFiles} event-lines=${c.eventLines} transcripts=${c.transcriptFiles} machine-transcripts=${c.machineTranscriptFiles} stats-records=${c.statsRecords}\n` +
        `  manifest: ${path.join(r.out, MANIFEST_FILE)}\n`,
    );
    const notCopied = r.manifest.machineDirs.filter((d) => !d.copied && d.files > 0);
    if (notCopied.length > 0) {
      process.stdout.write(`  machine transcript dirs not copied (pass --include-machine-dirs): ${notCopied.map((d) => `${d.agent} ${d.dir} (${d.files} files)`).join("; ")}\n`);
    }
  }
  return 0;
}
