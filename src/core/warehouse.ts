// Transcript warehouse (#79): `ach archive` snapshots raw transcripts and
// registry records into <stateDir>/warehouse so they outlive the agent CLIs'
// own cleanup (Claude Code prunes sessions after ~30 days).
//
// Three kinds of file are archived:
//   native  machine CLI transcripts — exactly the files `ach stats` reads via
//           scanAll (src/monitors/transcripts.ts transcriptSources)
//   raw     harness raw transcripts (<stateDir>/raw/<agent>-<session>.jsonl)
//           referenced by RunRecord.rawTranscript (audit, web, MCP read these)
//   record  registry RunRecords (<stateDir>/runs/<runId>.json)
//
// Rules: never delete, never re-copy an unchanged file. A file whose size and
// mtime match its newest archived copy is skipped without hashing; otherwise
// it is hashed and skipped when that sha256 is already archived for the same
// (kind, agent, relPath). A run that copies nothing creates no batch.
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { warnTranscript } from "../monitors/transcript-warnings.ts";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { listRunRecords, resolveRawTranscript, registryDir } from "./registry.ts";
import {
  entryKey,
  latestEntries,
  listBatches,
  MANIFEST_NAME,
  readBatchManifest,
  readManifest,
  warehouseDir as defaultWarehouseDir,
  type ManifestLine,
} from "./warehouse-index.ts";
import {
  scanOptionsForRoot,
  transcriptSources,
  walkFiles,
  type CanonicalTokenRecord,
  type ScanOptions,
} from "../monitors/transcripts.ts";

export type ArchiveKind = ManifestLine["kind"];

export interface ArchiveOptions {
  stateDir: string;
  /** Warehouse root (default <stateDir>/warehouse). */
  warehouseDir?: string;
  /** Machine transcript dir overrides (default: the CLIs' home dirs). */
  scan?: ScanOptions;
  /** Only this agent's files. */
  agent?: string;
  /** Only files modified (native/raw: file mtime; record: endedAt|updatedAt|startedAt) at/after this epoch ms. */
  sinceMs?: number;
  now?: () => number;
}

export interface ArchiveResult {
  warehouseDir: string;
  /** Batch id written this run, or null when nothing new was archived. */
  batch: string | null;
  archived: number;
  unchanged: number;
  bytes: number;
  byKind: Record<ArchiveKind, number>;
  /** Manifest lines written this run. */
  entries: ManifestLine[];
}

interface Candidate {
  kind: ArchiveKind;
  agent: string;
  sourcePath: string;
  relPath: string;
  sessionId: string | null;
  runIds: string[];
}

const CODEX_UUID_RE = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

/** Session id as the file NAME exposes it; null when it does not (never parsed/guessed). */
function nativeSessionId(agent: string, relPath: string): string | null {
  const parts = relPath.split(path.sep);
  const base = parts[parts.length - 1] ?? "";
  if (agent === "claude") {
    // <project>/<session>.jsonl or <project>/<session>/subagents/agent-*.jsonl
    const i = parts.indexOf("subagents");
    if (i >= 1) return parts[i - 1] ?? null;
    return base.endsWith(".jsonl") ? base.slice(0, -".jsonl".length) : null;
  }
  if (agent === "codex") return CODEX_UUID_RE.exec(base)?.[1] ?? null;
  if (agent === "gemini") return base.endsWith(".json") ? base.slice(0, -".json".length) : null;
  return null;
}

function sha256File(file: string): string {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function batchId(ms: number, whDir: string): string {
  const base = new Date(ms).toISOString().replace(/:/g, "-");
  let id = base;
  for (let n = 1; fs.existsSync(path.join(whDir, id)); n++) id = `${base}-${n}`;
  return id;
}

function archiveSubdir(c: Candidate): string {
  if (c.kind === "native") return path.join("native", c.agent, c.relPath);
  if (c.kind === "raw") return path.join("raw", c.relPath);
  return path.join("runs", c.relPath);
}

/** Copy preserving mtime, via tmp + rename so a half-written copy never exists under its final name. */
function copyPreserving(src: string, dest: string, st: fs.Stats): void {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.tmp-${process.pid}`;
  fs.copyFileSync(src, tmp);
  fs.utimesSync(tmp, st.atimeMs / 1000, st.mtimeMs / 1000);
  fs.renameSync(tmp, dest);
}

async function candidates(opts: ArchiveOptions): Promise<Candidate[]> {
  const records = listRunRecords(opts.stateDir);
  const runsBySession = new Map<string, string[]>();
  for (const r of records) {
    if (!r.sessionId) continue;
    const k = `${r.agent}\u0000${r.sessionId}`;
    runsBySession.set(k, [...(runsBySession.get(k) ?? []), r.runId]);
  }
  const out: Candidate[] = [];
  const roots = transcriptSources(opts.scan);
  for (const src of roots) {
    for (const file of await walkFiles(src.dir, src.keep)) {
      const siblings = roots.filter((r) => r.agent === src.agent);
      const relPath = path.join(...(siblings.length > 1 ? [`__root${siblings.indexOf(src)}`] : []), path.relative(src.dir, file));
      const sessionId = nativeSessionId(src.agent, relPath);
      out.push({
        kind: "native",
        agent: src.agent,
        sourcePath: file,
        relPath,
        sessionId,
        runIds: sessionId ? (runsBySession.get(`${src.agent}\u0000${sessionId}`) ?? []) : [],
      });
    }
  }
  const rawByPath = new Map<string, Candidate>();
  for (const r of records) {
    const t = resolveRawTranscript(opts.stateDir, r);
    // Only a LIVE file is archived; the warehouse fallback must not re-archive itself.
    if (!t || !fs.existsSync(t) || t.startsWith(path.resolve(opts.warehouseDir ?? defaultWarehouseDir(opts.stateDir)) + path.sep)) continue;
    const c = rawByPath.get(t);
    if (c) c.runIds.push(r.runId);
    else
      rawByPath.set(t, {
        kind: "raw",
        agent: r.agent,
        sourcePath: t,
        relPath: path.basename(t),
        sessionId: r.sessionId ?? null,
        runIds: [r.runId],
      });
  }
  out.push(...rawByPath.values());
  for (const r of records) {
    const file = path.join(registryDir(opts.stateDir), `${r.runId}.json`);
    if (!fs.existsSync(file)) continue;
    out.push({
      kind: "record",
      agent: r.agent,
      sourcePath: file,
      relPath: `${r.runId}.json`,
      sessionId: r.sessionId ?? null,
      runIds: [r.runId],
    });
  }
  return out;
}

function recordTime(file: string): number | null {
  try {
    const j = JSON.parse(fs.readFileSync(file, "utf8")) as { endedAt?: number; updatedAt?: number; startedAt?: number };
    return j.endedAt ?? j.updatedAt ?? j.startedAt ?? null;
  } catch {
    return null;
  }
}

/** Snapshot every live transcript + registry record not already archived. */
export async function archiveTranscripts(opts: ArchiveOptions): Promise<ArchiveResult> {
  const whDir = path.resolve(opts.warehouseDir ?? defaultWarehouseDir(opts.stateDir));
  const now = opts.now ?? Date.now;
  const existing = readManifest(whDir);
  const latest = latestEntries(existing);
  const known = new Set(existing.map((l) => `${entryKey(l)}\u0000${l.sha256}`));

  const result: ArchiveResult = {
    warehouseDir: whDir,
    batch: null,
    archived: 0,
    unchanged: 0,
    bytes: 0,
    byKind: { native: 0, raw: 0, record: 0 },
    entries: [],
  };

  let batch: string | null = null;
  const t0 = now();
  const archivedAt = new Date(t0).toISOString();
  for (const c of await candidates({ ...opts, warehouseDir: whDir })) {
    if (opts.agent && c.agent !== opts.agent) continue;
    let st: fs.Stats;
    try {
      st = fs.statSync(c.sourcePath);
    } catch {
      continue; // vanished between walk and stat
    }
    if (opts.sinceMs !== undefined) {
      const t = c.kind === "record" ? (recordTime(c.sourcePath) ?? st.mtimeMs) : st.mtimeMs;
      if (t < opts.sinceMs) continue;
    }
    const key = entryKey(c);
    const prev = latest.get(key);
    const sqlite = c.kind === "native" && /\.(db|vscdb)$/.test(c.sourcePath);
    if (!sqlite && prev && prev.size === st.size && prev.mtimeMs === st.mtimeMs) {
      result.unchanged++;
      continue;
    }
    let snapshotDir: string | undefined;
    let copySource = c.sourcePath;
    if (sqlite) {
      snapshotDir = fs.mkdtempSync(path.join(tmpdir(), "ach-archive-sqlite-"));
      copySource = path.join(snapshotDir, "snapshot.db");
      try {
        // sqlite3 parses backslash escapes inside a double-quoted dot-command
        // argument, so hand it forward slashes (Windows accepts both).
        execFileSync("sqlite3", ["-readonly", c.sourcePath, `.backup "${copySource.split(path.sep).join("/")}"`], { stdio: "pipe" });
      } catch (error) {
        fs.rmSync(snapshotDir, { recursive: true, force: true });
        warnTranscript(`archive: skipped SQLite store ${c.sourcePath}: ${(error as Error).message}`);
        continue;
      }
    }
    const sha = sha256File(copySource);
    if (known.has(`${key}\u0000${sha}`)) {
      if (snapshotDir) fs.rmSync(snapshotDir, { recursive: true, force: true });
      result.unchanged++;
      continue;
    }
    batch ??= batchId(t0, whDir);
    const archivePath = path.join(batch, archiveSubdir(c));
    copyPreserving(copySource, path.join(whDir, archivePath), st);
    const copiedSize = fs.statSync(copySource).size;
    if (snapshotDir) fs.rmSync(snapshotDir, { recursive: true, force: true });
    const line: ManifestLine = {
      v: 1,
      batch,
      kind: c.kind,
      agent: c.agent,
      sourcePath: c.sourcePath,
      relPath: c.relPath,
      archivePath,
      sha256: sha,
      size: copiedSize,
      mtimeMs: st.mtimeMs,
      sessionId: c.sessionId,
      runId: c.runIds[0] ?? null,
      ...(c.runIds.length > 1 ? { runIds: c.runIds } : {}),
      archivedAt,
    };
    known.add(`${key}\u0000${sha}`);
    result.entries.push(line);
    result.archived++;
    result.bytes += copiedSize;
    result.byKind[c.kind]++;
  }
  if (batch) {
    // Manifest last: a batch dir without a manifest is invisible to readers,
    // so an interrupted run leaves nothing half-indexed.
    const file = path.join(whDir, batch, MANIFEST_NAME);
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, result.entries.map((l) => JSON.stringify(l)).join("\n") + "\n");
    fs.renameSync(tmp, file);
    result.batch = batch;
  }
  return result;
}

// ---------------------------------------------------------------- restore

export interface RestoreOptions {
  warehouseDir: string;
  /** A batch id, "latest" (newest batch), or "all" (newest copy of every file). */
  batch: string;
  /** Destination root; laid out like a home dir (see RestoreResult). */
  to: string;
}

export interface RestoreResult {
  batch: string;
  to: string;
  restored: number;
  /** <to>/.agentic-coding-harness — point AGENTIC_CODING_HARNESS_STATE_DIR here. */
  stateDir: string;
  files: string[];
}

/**
 * Write archived files back into a directory tree the existing readers accept:
 *   native → <to>/.claude/projects|.codex/sessions|.gemini/tmp/<relPath>
 *   raw    → <to>/.agentic-coding-harness/raw/<basename>
 *   record → <to>/.agentic-coding-harness/runs/<runId>.json
 * so `ach stats --dir <to>` reads the transcripts and a state dir of
 * <to>/.agentic-coding-harness serves audit/dash/web. Never touches the warehouse.
 */
export async function restoreBatch(opts: RestoreOptions): Promise<RestoreResult> {
  const whDir = path.resolve(opts.warehouseDir);
  const batches = listBatches(whDir);
  let lines: ManifestLine[];
  let label = opts.batch;
  if (opts.batch === "all") {
    lines = [...latestEntries(readManifest(whDir)).values()];
  } else {
    if (opts.batch === "latest") label = batches[batches.length - 1] ?? "latest";
    if (!batches.includes(label)) {
      throw new Error(`unknown batch '${opts.batch}' (have: ${batches.join(", ") || "none"})`);
    }
    lines = readBatchManifest(whDir, label);
  }
  const to = path.resolve(opts.to);
  const home = scanOptionsForRoot(to);
  const stateDir = path.join(to, ".agentic-coding-harness");
  const nativeSources = transcriptSources(home);
  const files: string[] = [];
  for (const l of lines) {
    let dest: string;
    if (l.kind === "native") {
      const roots = nativeSources.filter((s) => s.agent === l.agent);
      const match = /^__root(\d+)[/\\](.*)$/.exec(l.relPath);
      const root = roots[match ? Number(match[1]) : 0];
      if (!root) continue;
      dest = path.join(root.dir, match ? match[2]! : l.relPath);
    } else if (l.kind === "raw") {
      dest = path.join(stateDir, "raw", l.relPath);
    } else {
      dest = path.join(registryDir(stateDir), l.relPath);
    }
    const src = path.join(whDir, l.archivePath);
    copyPreserving(src, dest, fs.statSync(src));
    files.push(dest);
  }
  return { batch: label, to, restored: files.length, stateDir, files };
}

// ---------------------------------------------------------------- stats read side

/**
 * Canonical token records from the newest archived copy of every native
 * transcript whose live counterpart (same agent + relPath under `live`) is
 * gone. Live files are read by scanAll and always win.
 */
export async function* scanWarehouse(opts: {
  warehouseDir: string;
  live: ScanOptions;
}): AsyncGenerator<CanonicalTokenRecord> {
  const whDir = path.resolve(opts.warehouseDir);
  const sources = transcriptSources(opts.live);
  const latest = [...latestEntries(readManifest(whDir)).values()]
    .filter((l) => l.kind === "native")
    .sort((a, b) => a.archivePath.localeCompare(b.archivePath));
  for (const l of latest) {
    const roots = sources.filter((s) => s.agent === l.agent);
    const match = /^__root(\d+)[/\\](.*)$/.exec(l.relPath);
    const src = roots[match ? Number(match[1]) : 0];
    if (!src) continue;
    if (fs.existsSync(path.join(src.dir, match ? match[2]! : l.relPath))) continue;
    for (const rec of await src.parse(path.join(whDir, l.archivePath))) yield { ...rec, source: "transcript", sourcePath: path.join(whDir, l.archivePath) };
  }
}

/** Newest archived harness raw transcripts whose live <stateDir>/raw copy is gone. */
export function warehouseRawFiles(opts: { warehouseDir: string; stateDir: string }): string[] {
  const whDir = path.resolve(opts.warehouseDir);
  return [...latestEntries(readManifest(whDir)).values()]
    .filter((l) => l.kind === "raw" && !fs.existsSync(path.join(opts.stateDir, "raw", l.relPath)))
    .map((l) => path.join(whDir, l.archivePath))
    .filter((f) => fs.existsSync(f))
    .sort();
}
