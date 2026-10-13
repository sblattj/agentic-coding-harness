// `ach gc` (#70): retention for the harness state dir.
//
// Two artifact classes, each with its own TTL:
//   - transcripts: <stateDir>/raw/**/*.jsonl (driver NDJSON + watch records)
//   - runs:        <stateDir>/runs/<runId>.json (RunRecord summaries)
// Nothing else under the state dir (warehouse/, state/, queues/, quota/,
// offsets.json, alerts.json, ...) is ever a candidate.
//
// planGc() only reads; applyGc() deletes exactly the plan's victims, so a
// `--dry-run` and a real pass can never disagree about what goes.
//
// SAFETY (every rule is covered by tests/gc.test.ts):
//   1. Containment: the state dir is realpath'd once; every candidate must
//      sit inside <realStateDir>/raw or <realStateDir>/runs. A symlink (file
//      or directory) is never followed and never deleted: it is REFUSED and
//      reported. A raw/ or runs/ dir that is itself a symlink refuses the
//      whole class.
//   2. Live runs: a record whose stored status is "running" is protected
//      (record AND transcript) unless its pid is provably gone (ESRCH).
//      This is stricter than registry.ts isLive(), which also drops a run
//      whose heartbeat went stale while the process still answers.
//   3. Fresh files: anything modified in the last FRESH_GUARD_MS is kept, so
//      a transcript the driver opened before its run record was written
//      (driver.ts creates the file, then writes the record) is never hit.
//   4. Only regular files are unlinked (fs.unlinkSync), never directories,
//      never recursively; the lstat is repeated right before each unlink.
import fs from "node:fs";
import path from "node:path";
import { registryDir, scanRunRecords, type RunRecord } from "./registry.ts";

export type GcClass = "transcript" | "run";

/** Files modified within this window are never deleted, whatever the TTL. */
export const FRESH_GUARD_MS = 60_000;

/** Default TTLs (issue #70): transcripts 30 days, run summaries forever. */
export const DEFAULT_TRANSCRIPTS_TTL_MS = 30 * 86_400_000;

export interface GcPolicy {
  /** Delete transcripts last touched before this epoch ms; null = keep all. */
  transcriptsBefore: number | null;
  /** Delete run records that ended before this epoch ms; null = keep all. */
  runsBefore: number | null;
}

export interface GcVictim {
  file: string;
  class: GcClass;
  bytes: number;
  /** Age anchor (ms epoch) the cutoff was compared against. */
  at: number;
  runId?: string;
}

export interface GcRefused {
  file: string;
  reason: string;
}

export interface GcProtected {
  file: string;
  class: GcClass;
  reason: "live-run" | "fresh";
  runId?: string;
}

export interface GcPlan {
  stateDir: string;
  realStateDir: string | null;
  policy: GcPolicy;
  victims: GcVictim[];
  refused: GcRefused[];
  protected: GcProtected[];
  bytes: number;
  counts: Record<GcClass, number>;
}

export interface GcResult {
  deleted: GcVictim[];
  failed: GcRefused[];
  bytes: number;
}

/** True when `child` is `root` itself or strictly inside it (both absolute). */
export function isInside(root: string, child: string): boolean {
  const rel = path.relative(root, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** Pid probe: false only when the OS says the process is gone. */
function pidGone(pid: number | undefined): boolean {
  if (pid === undefined) return true;
  try {
    process.kill(pid, 0);
    return false;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ESRCH";
  }
}

/** A record gc must not touch: stored status running and the pid not provably gone. */
export function isProtectedRun(rec: RunRecord): boolean {
  if (rec.status !== "running") return false;
  if (rec.source === "external" || rec.source === "imported") return false;
  return !pidGone(rec.pid);
}

/** The run's age anchor: explicit end, else last heartbeat, else start. */
export function runAgeAnchor(rec: RunRecord): number {
  return rec.endedAt ?? rec.updatedAt ?? rec.startedAt;
}

/**
 * Resolve a class dir under the real state root. Returns null (and records a
 * refusal) when it is a symlink or resolves outside the state dir.
 */
function classDir(realRoot: string, name: "raw" | "runs", refused: GcRefused[]): string | null {
  const dir = path.join(realRoot, name);
  let st: fs.Stats;
  try {
    st = fs.lstatSync(dir);
  } catch {
    return null; // absent: nothing to collect
  }
  if (st.isSymbolicLink()) {
    refused.push({ file: dir, reason: "symlink (not followed)" });
    return null;
  }
  if (!st.isDirectory()) return null;
  return dir;
}

/** Regular files under `dir` matching `keep`; symlinks are refused, never followed. */
function walk(dir: string, realRoot: string, keep: (name: string) => boolean, recurse: boolean, refused: GcRefused[]): Array<{ file: string; st: fs.Stats }> {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: Array<{ file: string; st: fs.Stats }> = [];
  for (const e of entries) {
    const p = path.join(dir, e.name);
    let st: fs.Stats;
    try {
      st = fs.lstatSync(p);
    } catch {
      continue; // vanished between readdir and lstat
    }
    if (st.isSymbolicLink()) {
      if (e.name.endsWith(".jsonl") || e.name.endsWith(".json") || recurse) {
        refused.push({ file: p, reason: "symlink (not followed)" });
      }
      continue;
    }
    if (!isInside(realRoot, p)) {
      refused.push({ file: p, reason: "outside the state dir" });
      continue;
    }
    if (st.isDirectory()) {
      if (recurse) out.push(...walk(p, realRoot, keep, recurse, refused));
      continue;
    }
    if (st.isFile() && keep(e.name)) out.push({ file: p, st });
  }
  return out;
}

export interface PlanGcOptions {
  stateDir: string;
  policy: GcPolicy;
  now?: number;
}

/** Read-only: decide what gc would delete, refuse, and protect. */
export function planGc(opts: PlanGcOptions): GcPlan {
  const now = opts.now ?? Date.now();
  const refused: GcRefused[] = [];
  const victims: GcVictim[] = [];
  const prot: GcProtected[] = [];
  const plan = (realStateDir: string | null): GcPlan => ({
    stateDir: opts.stateDir,
    realStateDir,
    policy: opts.policy,
    victims,
    refused,
    protected: prot,
    bytes: victims.reduce((s, v) => s + v.bytes, 0),
    counts: {
      transcript: victims.filter((v) => v.class === "transcript").length,
      run: victims.filter((v) => v.class === "run").length,
    },
  });

  let realRoot: string;
  try {
    realRoot = fs.realpathSync(opts.stateDir);
  } catch {
    return plan(null); // no state dir: nothing to collect
  }

  // ---- runs: read through the registry so the age anchor and liveness are
  // the record's own, and map each record to its transcript.
  const { records } = scanRunRecords(realRoot);
  const byFile = new Map<string, RunRecord>(); // runs/<id>.json -> record
  const liveTranscripts = new Set<string>(); // basenames of live runs' transcripts
  const transcriptAnchor = new Map<string, number>(); // basename -> run age anchor
  for (const rec of records) {
    byFile.set(path.join(registryDir(realRoot), `${rec.runId}.json`), rec);
    const base = rec.rawTranscript ? path.basename(rec.rawTranscript) : undefined;
    if (isProtectedRun(rec)) {
      if (base) liveTranscripts.add(base);
    } else if (base) {
      transcriptAnchor.set(base, Math.max(transcriptAnchor.get(base) ?? 0, runAgeAnchor(rec)));
    }
  }

  const runsDir = classDir(realRoot, "runs", refused);
  if (runsDir) {
    // Only <id>.json; `.json.tmp-<pid>` belongs to an in-flight atomic write.
    for (const { file, st } of walk(runsDir, realRoot, (n) => n.endsWith(".json"), false, refused)) {
      const rec = byFile.get(file);
      if (!rec) continue; // unparseable record: left for `ach audit`, never guessed at
      if (isProtectedRun(rec)) {
        prot.push({ file, class: "run", reason: "live-run", runId: rec.runId });
        continue;
      }
      if (now - st.mtimeMs < FRESH_GUARD_MS) {
        prot.push({ file, class: "run", reason: "fresh", runId: rec.runId });
        continue;
      }
      const at = runAgeAnchor(rec);
      if (opts.policy.runsBefore !== null && at < opts.policy.runsBefore) {
        victims.push({ file, class: "run", bytes: st.size, at, runId: rec.runId });
      }
    }
  }

  const rawDir = classDir(realRoot, "raw", refused);
  if (rawDir) {
    for (const { file, st } of walk(rawDir, realRoot, (n) => n.endsWith(".jsonl"), true, refused)) {
      const base = path.basename(file);
      if (liveTranscripts.has(base)) {
        prot.push({ file, class: "transcript", reason: "live-run" });
        continue;
      }
      if (now - st.mtimeMs < FRESH_GUARD_MS) {
        prot.push({ file, class: "transcript", reason: "fresh" });
        continue;
      }
      // Linked transcripts age with their run; orphan files (the watch
      // layout raw/<agent>/<session>.jsonl) age by mtime. The later of the
      // two wins so a still-growing file is never judged by an old record.
      const at = Math.max(transcriptAnchor.get(base) ?? 0, st.mtimeMs);
      if (opts.policy.transcriptsBefore !== null && at < opts.policy.transcriptsBefore) {
        victims.push({ file, class: "transcript", bytes: st.size, at });
      }
    }
  }

  victims.sort((a, b) => a.at - b.at);
  return plan(realRoot);
}

/**
 * Delete the plan's victims. Every file is re-checked right before unlink:
 * still a regular file (not a symlink), still inside the real state dir.
 */
export function applyGc(plan: GcPlan): GcResult {
  const deleted: GcVictim[] = [];
  const failed: GcRefused[] = [];
  const root = plan.realStateDir;
  if (root === null) return { deleted, failed, bytes: 0 };
  for (const v of plan.victims) {
    if (!isInside(path.join(root, "raw"), v.file) && !isInside(path.join(root, "runs"), v.file)) {
      failed.push({ file: v.file, reason: "outside the state dir" });
      continue;
    }
    let st: fs.Stats;
    try {
      st = fs.lstatSync(v.file);
    } catch {
      continue; // already gone
    }
    if (!st.isFile()) {
      failed.push({ file: v.file, reason: st.isSymbolicLink() ? "symlink (not followed)" : "not a regular file" });
      continue;
    }
    try {
      fs.unlinkSync(v.file);
      deleted.push(v);
    } catch (e) {
      failed.push({ file: v.file, reason: (e as Error).message });
    }
  }
  return { deleted, failed, bytes: deleted.reduce((s, v) => s + v.bytes, 0) };
}

/** Append one line per real gc pass to <stateDir>/gc-log.jsonl (best effort). */
export function logGc(plan: GcPlan, result: GcResult, now: number = Date.now()): void {
  if (plan.realStateDir === null || result.deleted.length === 0) return;
  const line = {
    at: new Date(now).toISOString(),
    policy: plan.policy,
    deleted: result.deleted.map((v) => ({ file: path.relative(plan.realStateDir!, v.file), class: v.class, bytes: v.bytes })),
    bytes: result.bytes,
    failed: result.failed,
  };
  try {
    fs.appendFileSync(path.join(plan.realStateDir, "gc-log.jsonl"), JSON.stringify(line) + "\n");
  } catch {
    /* logging never fails the pass */
  }
}
