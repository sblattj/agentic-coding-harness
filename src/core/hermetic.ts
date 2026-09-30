// Hermetic runs (agentic-coding-harness#106).
//
// `ach run --hermetic` copies the workspace into a fresh temp directory whose
// ancestors hold none of the agent's instruction files (CLAUDE.md, AGENTS.md,
// GEMINI.md — src/core/ancestor-instructions.ts), runs the agent THERE, then
// syncs the resulting tree back into the original workspace so `--verify`
// and the user's checkout see the agent's edits.
//
// Decisions (each is tested in tests/hermetic.test.ts):
//   * Temp root: fs.mkdtemp under os.tmpdir() (on macOS /var/folders/...,
//     outside $HOME), overridable with AGENTIC_CODING_HARNESS_HERMETIC_ROOT.
//     The root is NOT trusted: after the copy, the detector runs on the copy
//     itself, and any ancestor instruction file fails the run loudly
//     (HERMETIC_UNSAFE, exit 2) before the agent launches. The copy path is
//     realpath'd (/var -> /private/var) so the agent's cwd, the detector's
//     walk and the recorded path all agree.
//   * The copy keeps the workspace's basename (<tmp>/ach-hermetic-XXXX/<name>)
//     so agents that derive a project name from the directory see the same one.
//   * Sync-back is manifest-based: every entry of the copy is stat'ed right
//     after the copy; afterwards an entry is written back when it is new or
//     its type/size/mode/mtime/ctime/link target changed.
//   * Deletions PROPAGATE, but only for paths that existed in the copy's
//     manifest: a file the agent deleted is deleted from the original; a file
//     someone created in the original during the run is left alone.
//   * Cleanup: the temp dir is removed after a successful sync-back, whether
//     the agent succeeded, failed or threw. It is KEPT only when sync-back
//     itself fails, because it then holds the only copy of the agent's edits;
//     the error names its path.
//   * Workspace confinement (driver `confineToWorkspace`): the copy lives
//     outside the original workspace by construction, so a driver confined to
//     that workspace refuses it (WORKSPACE_ESCAPE) before launch — a loud
//     failure, never a silent non-hermetic run. The ach CLI and MCP tools
//     never enable confinement.
//   * Limits: symlinks are copied verbatim, so an ABSOLUTE link still points
//     at its original target; a git worktree's `.git` FILE still points at
//     the original gitdir, so git commands the agent runs in the copy act on
//     the original repository's index/refs. Sockets/FIFOs/devices are skipped.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { Driver } from './driver.ts';
import { findAncestorInstructions, type FindAncestorOptions } from './ancestor-instructions.ts';
import { patchRunRecord } from './registry.ts';
import { HarnessError, type HermeticRunInfo, type RunResult, type RunSpec } from './types.ts';

/** Env override for the hermetic temp root (tests, or a TMPDIR under $HOME). */
export const HERMETIC_ROOT_ENV = 'AGENTIC_CODING_HARNESS_HERMETIC_ROOT';

/** Default temp root: $AGENTIC_CODING_HARNESS_HERMETIC_ROOT, else os.tmpdir(). */
export function defaultHermeticRoot(env: NodeJS.ProcessEnv = process.env): string {
  const v = env[HERMETIC_ROOT_ENV];
  return v !== undefined && v !== '' ? v : os.tmpdir();
}

type EntryKind = 'file' | 'dir' | 'symlink';

interface ManifestEntry {
  kind: EntryKind;
  size: number;
  mode: number;
  mtimeMs: number;
  ctimeMs: number;
  link?: string;
}

type Manifest = Map<string, ManifestEntry>;

function kindOf(st: fs.Stats): EntryKind | null {
  if (st.isSymbolicLink()) return 'symlink';
  if (st.isDirectory()) return 'dir';
  if (st.isFile()) return 'file';
  return null; // socket / FIFO / device: never copied, never synced
}

/** Stat every copyable entry under `dir`, keyed by relative path. */
function scanTree(dir: string): Manifest {
  const out: Manifest = new Map();
  const walk = (rel: string): void => {
    const abs = rel === '' ? dir : path.join(dir, rel);
    for (const name of fs.readdirSync(abs)) {
      const childRel = rel === '' ? name : path.join(rel, name);
      const childAbs = path.join(dir, childRel);
      const st = fs.lstatSync(childAbs);
      const kind = kindOf(st);
      if (kind === null) continue;
      out.set(childRel, {
        kind,
        size: st.size,
        mode: st.mode & 0o7777,
        mtimeMs: st.mtimeMs,
        ctimeMs: st.ctimeMs,
        ...(kind === 'symlink' ? { link: fs.readlinkSync(childAbs) } : {}),
      });
      if (kind === 'dir') walk(childRel);
    }
  };
  walk('');
  return out;
}

function sameEntry(a: ManifestEntry, b: ManifestEntry): boolean {
  return (
    a.kind === b.kind &&
    a.size === b.size &&
    a.mode === b.mode &&
    a.mtimeMs === b.mtimeMs &&
    a.ctimeMs === b.ctimeMs &&
    a.link === b.link
  );
}

export interface HermeticWorkspace {
  /** Original workspace (realpath). */
  source: string;
  /** The mkdtemp directory holding the copy (removed on dispose). */
  base: string;
  /** The copy itself: `<base>/<basename(source)>` (realpath). */
  dir: string;
  /** Ancestor instruction files of `source` that the copy avoids. */
  avoided: string[];
  manifest: Manifest;
}

export interface PrepareHermeticOptions {
  /** Temp root (default: defaultHermeticRoot()). */
  tempRoot?: string;
  /** Detector options (tests inject a probe / walk ceiling). */
  detect?: FindAncestorOptions;
}

/**
 * Copy `source` into a fresh temp dir and prove the copy is hermetic for
 * `agent`. Throws HERMETIC_UNSAFE (and removes the temp dir) when the copy
 * still has ancestor instruction files.
 */
export function prepareHermeticWorkspace(agent: string, source: string, opts: PrepareHermeticOptions = {}): HermeticWorkspace {
  let src: string;
  try {
    src = fs.realpathSync(source);
  } catch (err) {
    throw new HarnessError(`hermetic: workspace '${source}' is not accessible: ${err instanceof Error ? err.message : String(err)}`, 'HERMETIC_UNSAFE', 2);
  }
  if (!fs.statSync(src).isDirectory()) {
    throw new HarnessError(`hermetic: workspace '${source}' is not a directory`, 'HERMETIC_UNSAFE', 2);
  }
  const root = fs.realpathSync(opts.tempRoot ?? defaultHermeticRoot());
  const base = fs.realpathSync(fs.mkdtempSync(path.join(root, 'ach-hermetic-')));
  const dir = path.join(base, path.basename(src) || 'workspace');
  try {
    // The copy must never sit inside the source (a temp root under the
    // workspace would recurse into itself and would inherit its files).
    if (dir === src || dir.startsWith(src.endsWith(path.sep) ? src : src + path.sep)) {
      throw new HarnessError(`hermetic: temp root '${root}' is inside the workspace '${src}'`, 'HERMETIC_UNSAFE', 2);
    }
    fs.cpSync(src, dir, {
      recursive: true,
      verbatimSymlinks: true,
      preserveTimestamps: true,
      filter: (from) => {
        try {
          return kindOf(fs.lstatSync(from)) !== null;
        } catch {
          return false;
        }
      },
    });
    const leaks = findAncestorInstructions(agent, dir, opts.detect);
    if (leaks.length > 0) {
      throw new HarnessError(
        `hermetic: the temp copy ${dir} still has ${agent} instruction files in its ancestor directories: ${leaks.join(', ')} — refusing to run non-hermetically; point ${HERMETIC_ROOT_ENV} (or TMPDIR) at a directory without them`,
        'HERMETIC_UNSAFE',
        2,
      );
    }
    return { source: src, base, dir, avoided: findAncestorInstructions(agent, src, opts.detect), manifest: scanTree(dir) };
  } catch (err) {
    fs.rmSync(base, { recursive: true, force: true });
    throw err;
  }
}

/**
 * Write the copy's changes back into the original workspace (see header for
 * the rules). Returns the tally; throws on any I/O failure.
 */
export function syncBackHermeticWorkspace(ws: HermeticWorkspace): { copied: number; deleted: number } {
  const after = scanTree(ws.dir);
  let copied = 0;
  let deleted = 0;
  // Deletions (and type changes) first, deepest path first.
  const gone = [...ws.manifest.keys()]
    .filter((rel) => {
      const now = after.get(rel);
      return now === undefined || now.kind !== ws.manifest.get(rel)!.kind;
    })
    .sort((a, b) => b.length - a.length);
  for (const rel of gone) {
    const target = path.join(ws.source, rel);
    let present = true;
    try {
      fs.lstatSync(target);
    } catch {
      present = false;
    }
    if (!present) continue;
    fs.rmSync(target, { recursive: true, force: true });
    if (!after.has(rel)) deleted++;
  }
  // Additions and changes, parents before children.
  const entries = [...after.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  for (const [rel, entry] of entries) {
    const prev = ws.manifest.get(rel);
    if (prev !== undefined && sameEntry(prev, entry)) continue;
    const from = path.join(ws.dir, rel);
    const to = path.join(ws.source, rel);
    let existing: fs.Stats | null = null;
    try {
      existing = fs.lstatSync(to);
    } catch {
      existing = null;
    }
    if (entry.kind === 'dir') {
      if (existing !== null && !existing.isDirectory()) fs.rmSync(to, { recursive: true, force: true });
      fs.mkdirSync(to, { recursive: true });
      fs.chmodSync(to, entry.mode);
      continue;
    }
    if (existing !== null && (existing.isDirectory() || existing.isSymbolicLink() || entry.kind === 'symlink')) {
      fs.rmSync(to, { recursive: true, force: true });
    }
    if (entry.kind === 'symlink') {
      fs.symlinkSync(entry.link!, to);
    } else {
      fs.copyFileSync(from, to);
      fs.chmodSync(to, entry.mode);
    }
    copied++;
  }
  return { copied, deleted };
}

export function disposeHermeticWorkspace(ws: HermeticWorkspace): void {
  fs.rmSync(ws.base, { recursive: true, force: true });
}

export interface RunHermeticOptions extends PrepareHermeticOptions {
  /** Registry state dir: the RunRecord gets `cwd` = original + `hermetic`. */
  stateDir?: string;
  /** Called once the copy is ready, before the agent launches. */
  onPrepared?: (ws: HermeticWorkspace) => void;
  /** An already-prepared copy (callers that must fail fast, synchronously,
   *  before handing the run off, e.g. harness_run_async). */
  workspace?: HermeticWorkspace;
}

/**
 * Run `agent` in a hermetic copy of `spec.cwd` (default process.cwd()),
 * sync the result back, clean up, and return the RunResult with a
 * `hermetic` block. Throws HERMETIC_UNSAFE before launch when the copy is
 * not hermetic, and HERMETIC_SYNC_FAILED (temp dir kept) when sync-back fails.
 */
export async function runHermetic(
  driver: Pick<Driver, 'run'>,
  agent: string,
  spec: RunSpec,
  opts: RunHermeticOptions = {},
): Promise<RunResult> {
  const ws = opts.workspace ?? prepareHermeticWorkspace(agent, spec.cwd ?? process.cwd(), opts);
  opts.onPrepared?.(ws);
  let result: RunResult | undefined;
  let runError: unknown;
  try {
    result = await driver.run(agent, { ...spec, cwd: ws.dir });
  } catch (err) {
    runError = err;
  }
  let synced: { copied: number; deleted: number };
  try {
    synced = syncBackHermeticWorkspace(ws);
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    const agentNote = runError !== undefined ? ` (the run itself also failed: ${runError instanceof Error ? runError.message : String(runError)})` : '';
    throw new HarnessError(
      `hermetic: syncing ${ws.dir} back to ${ws.source} failed: ${why}${agentNote}; the temp copy is KEPT at ${ws.base} because it holds the agent's edits`,
      'HERMETIC_SYNC_FAILED',
    );
  }
  const warnings: string[] = [];
  try {
    disposeHermeticWorkspace(ws);
  } catch (err) {
    warnings.push(`hermetic: could not remove ${ws.base}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (runError !== undefined) throw runError;
  const info: HermeticRunInfo = {
    tempDir: ws.dir,
    source: ws.source,
    ...(ws.avoided.length > 0 ? { avoided: ws.avoided } : {}),
    synced,
  };
  if (opts.stateDir !== undefined && !patchRunRecord(opts.stateDir, result!.runId, { cwd: ws.source, hermetic: info })) {
    warnings.push(`registry: could not record the hermetic run on ${result!.runId}`);
  }
  return { ...result!, warnings: [...result!.warnings, ...warnings], hermetic: info };
}

/** One summary line for a hermetic run. */
export function formatHermeticLine(h: HermeticRunInfo): string {
  const avoided = h.avoided !== undefined && h.avoided.length > 0 ? ` · avoided ${h.avoided.length} ancestor instruction file${h.avoided.length === 1 ? '' : 's'}` : '';
  return `hermetic   ${h.tempDir} · synced back ${h.synced.copied} written, ${h.synced.deleted} deleted${avoided}`;
}
