// #75: `--isolate`. Run an agent inside its own git worktree + branch so
// concurrent runs in one repo never see each other's edits.
//
//   1. refuse a dirty tree unless allowDirty; record the base commit SHA
//   2. `git worktree add <stateDir>/worktrees/<runId> -b ach/<runId> <baseSha>`
//   3. the caller runs the agent in `agentCwd` (the worktree, or the subdir
//      mirroring the original cwd)
//   4. finishIsolation: keep worktree + branch for review (default), or with
//      `cleanup` commit any leftover edits to the branch and remove the
//      worktree (the branch is always kept)
//
// Unlike --hermetic (a temp copy synced back into the workspace) nothing is
// ever written back: the result lives on the branch.
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { HarnessError, type WorktreeRunInfo } from "./types.ts";

export interface IsolateOptions {
  /** Proceed on a dirty tree (the worktree still starts from HEAD, without the dirty edits). */
  allowDirty?: boolean;
  /** After the run: commit leftover edits to the branch, then remove the worktree (branch kept). */
  cleanup?: boolean;
  /** Symlink every entry of the primary node_modules (dot entries such as `.bin` included, `.cache` excluded) into the worktree. */
  nodeModules?: boolean;
  /**
   * Paths (absolute, or relative to the repo top) the harness itself writes
   * (matrix ledger, work root, ...): changes under them never count as a dirty
   * tree. `.ach/` (project config) and `stateDir` are always ignored.
   */
  ignorePaths?: string[];
  /**
   * A task `setup` command: run via `/bin/sh -c` inside the worktree (agentCwd)
   * after it is created (node_modules linked) and before the agent starts, so
   * its output reaches the agent and the verifier and never touches the main
   * tree. A failure removes the worktree and throws HarnessError SETUP_FAILED.
   */
  setup?: { command: string; env?: NodeJS.ProcessEnv; timeoutMs?: number };
  /** Where `worktrees/<runId>` lives. */
  stateDir: string;
  /** Called once the worktree exists (the CLI prints where the agent runs). */
  onPrepared?: (ws: IsolatedWorkspace) => void;
}

export interface IsolatedWorkspace {
  runId: string;
  /** Top of the new worktree. */
  path: string;
  /** Directory to run the agent in (worktree root, or the mirrored subdir). */
  agentCwd: string;
  branch: string;
  baseSha: string;
  /** Primary checkout top-level the worktree was cut from. */
  source: string;
  nodeModules?: number;
  cleanup: boolean;
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function gitFailure(err: unknown): string {
  const e = err as { stderr?: Buffer | string; message?: string };
  const stderr = e.stderr === undefined ? "" : String(e.stderr).trim();
  return stderr !== "" ? stderr : (e.message ?? String(err));
}

/** `ach/<runId>` with anything outside [a-z0-9-] folded to `-`. */
export function isolateBranchName(runId: string): string {
  const slug = runId.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  return `ach/${slug === "" ? "run" : slug}`;
}

/** Entries that are caches, not packages: never linked. `.bin` is NOT one (npm scripts resolve tools through it). */
const NODE_MODULES_SKIP = new Set([".cache", ".vite", ".vite-temp", ".turbo"]);

/** Per-entry symlinks node_modules/<entry> -> primary, skipping cache dirs (`.cache`, ...). `.bin` is linked. Returns the count. */
export function materializeNodeModules(from: string, to: string): number {
  const src = path.join(from, "node_modules");
  if (!fs.existsSync(src)) return 0;
  const dest = path.join(to, "node_modules");
  fs.mkdirSync(dest, { recursive: true });
  let n = 0;
  for (const entry of fs.readdirSync(src)) {
    if (NODE_MODULES_SKIP.has(entry)) continue;
    const link = path.join(dest, entry);
    if (fs.existsSync(link) || isLink(link)) continue;
    fs.symlinkSync(path.join(src, entry), link);
    n += 1;
  }
  return n;
}

function isLink(p: string): boolean {
  try {
    return fs.lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

/** realpath of the nearest existing ancestor + the not-yet-existing tail. */
function realish(p: string): string {
  const abs = path.resolve(p);
  const tail: string[] = [];
  let cur = abs;
  for (;;) {
    try {
      return path.join(fs.realpathSync(cur), ...tail);
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return abs;
      tail.unshift(path.basename(cur));
      cur = parent;
    }
  }
}

/** Dirty paths (repo-relative) from `git status`, minus anything under an ignored path. */
function dirtyPaths(top: string, ignore: string[]): string[] {
  const out = execFileSync("git", ["status", "--porcelain", "-z", "--untracked-files=all"], { cwd: top, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const tokens = out.split("\0");
  const ignored = ignore.map(realish);
  const dirty: string[] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i]!;
    if (t.length < 4) continue;
    const entry = t.slice(3);
    const paths = [entry];
    if (t[0] === "R" || t[0] === "C" || t[1] === "R" || t[1] === "C") {
      i += 1;
      if (tokens[i] !== undefined) paths.push(tokens[i]!);
    }
    const inside = (rel: string): boolean => {
      const abs = path.join(top, rel);
      return ignored.some((ig) => abs === ig || abs.startsWith(ig + path.sep));
    };
    if (paths.every(inside)) continue;
    dirty.push(`${t.slice(0, 2)} ${entry}`);
  }
  return dirty;
}

function removeWorktree(top: string, wtPath: string, branch: string): void {
  try {
    git(top, ["worktree", "remove", "--force", wtPath]);
  } catch {
    fs.rmSync(wtPath, { recursive: true, force: true });
    try {
      git(top, ["worktree", "prune"]);
    } catch {
      /* best effort */
    }
  }
  try {
    git(top, ["branch", "-D", branch]);
  } catch {
    /* best effort */
  }
}

/** Create the worktree + branch for one run. Throws HarnessError (USAGE) on a non-repo or dirty tree. */
export function prepareIsolation(runId: string, cwd: string, opts: IsolateOptions): IsolatedWorkspace {
  let top: string;
  try {
    top = fs.realpathSync(git(cwd, ["rev-parse", "--show-toplevel"]));
  } catch {
    throw new HarnessError(`--isolate needs a git repository; ${cwd} is not inside one`, "USAGE");
  }
  let baseSha: string;
  try {
    baseSha = git(top, ["rev-parse", "HEAD"]);
  } catch {
    throw new HarnessError("--isolate needs at least one commit in the repository (HEAD is unborn)", "USAGE");
  }
  if (opts.allowDirty !== true) {
    const ignore = [path.join(top, ".ach"), opts.stateDir, ...(opts.ignorePaths ?? []).map((p) => path.resolve(top, p))];
    const dirty = dirtyPaths(top, ignore);
    if (dirty.length > 0) {
      const files = dirty.slice(0, 5).join(", ");
      throw new HarnessError(
        `--isolate refuses a dirty working tree (the worktree starts from HEAD ${baseSha.slice(0, 7)}, so uncommitted edits would not reach the agent): ${files}${dirty.length > 5 ? ", ..." : ""}. Commit or stash them, or pass --allow-dirty`,
        "DIRTY_TREE",
      );
    }
  }
  const wtPath = path.join(opts.stateDir, "worktrees", runId);
  const branch = isolateBranchName(runId);
  fs.mkdirSync(path.dirname(wtPath), { recursive: true });
  try {
    git(top, ["worktree", "add", wtPath, "-b", branch, baseSha]);
  } catch (err) {
    throw new HarnessError(`--isolate: git worktree add failed: ${gitFailure(err)}`, "ISOLATE_FAILED");
  }
  let ws: IsolatedWorkspace;
  try {
    const realWt = fs.realpathSync(wtPath);
    const rel = path.relative(top, fs.realpathSync(cwd));
    const agentCwd = rel === "" ? realWt : path.join(realWt, rel);
    // The run's own subdir may be untracked or gitignored, so absent from the checkout.
    fs.mkdirSync(agentCwd, { recursive: true });
    ws = { runId, path: realWt, agentCwd, branch, baseSha, source: top, cleanup: opts.cleanup === true };
    if (opts.nodeModules === true) {
      ws.nodeModules = materializeNodeModules(fs.realpathSync(cwd), agentCwd);
      if (ws.nodeModules === 0) delete ws.nodeModules;
    }
    if (opts.setup !== undefined) runSetup(opts.setup, agentCwd);
    opts.onPrepared?.(ws);
  } catch (err) {
    removeWorktree(top, wtPath, branch);
    if (err instanceof HarnessError) throw err;
    throw new HarnessError(`--isolate: preparing the worktree failed: ${err instanceof Error ? err.message : String(err)}`, "ISOLATE_FAILED");
  }
  if (ws.cleanup) trackForSignals(ws);
  return ws;
}

function runSetup(setup: NonNullable<IsolateOptions["setup"]>, agentCwd: string): void {
  const r = spawnSync("/bin/sh", ["-c", setup.command], {
    cwd: agentCwd,
    env: { ...(setup.env ?? process.env), ACH_WORKSPACE: agentCwd },
    encoding: "utf8",
    timeout: setup.timeoutMs ?? 300_000,
    killSignal: "SIGKILL",
    maxBuffer: 16 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (r.status === 0) return;
  const detail =
    r.error !== undefined && (r.error as NodeJS.ErrnoException).code === "ETIMEDOUT"
      ? "timed out"
      : r.status !== null
        ? `exit ${r.status}`
        : (r.error?.message ?? (r.signal ? `signal ${r.signal}` : "did not run"));
  const tail = `${r.stdout ?? ""}${r.stderr ?? ""}`.trim();
  throw new HarnessError(`setup failed (${detail})${tail ? `: ${tail.slice(-500)}` : ""}`, "SETUP_FAILED");
}

// Best-effort SIGINT/SIGTERM cleanup for `--cleanup` runs: finishIsolation
// otherwise never runs when the process is killed mid-run.
const live = new Set<IsolatedWorkspace>();
const SIGNALS = { SIGINT: 130, SIGTERM: 143 } as const;
const handlers = new Map<NodeJS.Signals, () => void>();

function trackForSignals(ws: IsolatedWorkspace): void {
  live.add(ws);
  if (handlers.size > 0) return;
  for (const [sig, code] of Object.entries(SIGNALS) as [keyof typeof SIGNALS, number][]) {
    const h = (): void => {
      for (const w of [...live]) finishIsolation(w);
      uninstallSignalHandlers();
      // Others (an abort controller, ...) own the shutdown when they listen too; else exit as usual.
      if (process.listenerCount(sig) === 0) process.exit(code);
    };
    handlers.set(sig, h);
    process.on(sig, h);
  }
}

function uninstallSignalHandlers(): void {
  for (const [sig, h] of handlers) process.off(sig, h);
  handlers.clear();
}

/** Post-run: keep (default) or remove the worktree, never the branch. Never throws. */
export function finishIsolation(ws: IsolatedWorkspace): WorktreeRunInfo {
  const info: WorktreeRunInfo = {
    path: ws.path,
    branch: ws.branch,
    baseSha: ws.baseSha,
    cleanup: { status: "kept" },
    ...(ws.nodeModules !== undefined ? { nodeModules: ws.nodeModules } : {}),
  };
  if (!ws.cleanup) return info;
  live.delete(ws);
  if (live.size === 0) uninstallSignalHandlers();
  try {
    // Preserve the agent's edits on the branch before the checkout goes away.
    const pathspec = ws.nodeModules !== undefined ? ["--", ".", ":(exclude,glob)**/node_modules"] : [];
    git(ws.path, ["add", "-A", ...pathspec]);
    if (git(ws.path, ["status", "--porcelain", "--untracked-files=no"]) !== "") {
      git(ws.path, [
        "-c", "user.name=ach", "-c", "user.email=ach@localhost", "-c", "commit.gpgsign=false",
        "commit", "--no-verify", "-m", `ach run ${ws.runId}: uncommitted edits left in the worktree`,
      ]);
      info.cleanup.commit = git(ws.path, ["rev-parse", "HEAD"]);
    }
    if (ws.nodeModules !== undefined) fs.rmSync(path.join(ws.agentCwd, "node_modules"), { recursive: true, force: true });
    git(ws.source, ["worktree", "remove", "--force", ws.path]);
    info.cleanup.status = "removed";
  } catch (err) {
    info.cleanup = { status: "failed", error: gitFailure(err) };
  }
  return info;
}

/** parseArgs option table shared by `ach run` and `ach trial`. */
export const ISOLATE_FLAG_OPTIONS = {
  isolate: { type: "boolean", default: false },
  "allow-dirty": { type: "boolean", default: false },
  cleanup: { type: "boolean", default: false },
  "isolate-node-modules": { type: "boolean", default: false },
} as const;

/**
 * Parse the isolate flags (undefined = not isolating). The modifiers without
 * --isolate, and combinations that cannot work, are refused loudly:
 * --hermetic (both are isolation strategies; hermetic syncs back, isolate never
 * does) and --resume (agents find sessions by project dir, and the worktree is
 * a different one). --parallel > 1 is fine: each child gets its own worktree.
 */
export function isolateOptionsFromFlags(
  values: { isolate?: boolean; "allow-dirty"?: boolean; cleanup?: boolean; "isolate-node-modules"?: boolean },
  ctx: { hermetic: boolean; resume: boolean },
): Omit<IsolateOptions, "stateDir"> | undefined {
  if (values.isolate !== true) {
    for (const f of ["allow-dirty", "cleanup", "isolate-node-modules"] as const) {
      if (values[f] === true) throw new HarnessError(`--${f} only applies together with --isolate`, "USAGE");
    }
    return undefined;
  }
  if (ctx.hermetic) throw new HarnessError("--isolate and --hermetic are two different isolation modes (a git worktree vs a temp copy synced back); pick one", "USAGE");
  if (ctx.resume) throw new HarnessError("--isolate runs in a fresh git worktree; it cannot be combined with --resume (the session lives under the original directory)", "USAGE");
  return {
    ...(values["allow-dirty"] === true ? { allowDirty: true } : {}),
    ...(values.cleanup === true ? { cleanup: true } : {}),
    ...(values["isolate-node-modules"] === true ? { nodeModules: true } : {}),
  };
}

/** One summary line for an isolated run. */
export function formatIsolateLine(w: WorktreeRunInfo): string {
  const where = w.cleanup.status === "removed" ? "worktree removed" : w.cleanup.status === "failed" ? `worktree kept (cleanup failed: ${w.cleanup.error})` : `worktree ${w.path}`;
  const commit = w.cleanup.commit !== undefined ? ` · leftover edits committed ${w.cleanup.commit.slice(0, 7)}` : "";
  return `isolate    ${where} · branch ${w.branch} · base ${w.baseSha.slice(0, 7)}${commit}`;
}
