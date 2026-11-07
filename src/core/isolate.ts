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
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { HarnessError, type WorktreeRunInfo } from "./types.ts";

export interface IsolateOptions {
  /** Proceed on a dirty tree (the worktree still starts from HEAD, without the dirty edits). */
  allowDirty?: boolean;
  /** After the run: commit leftover edits to the branch, then remove the worktree (branch kept). */
  cleanup?: boolean;
  /** Symlink each non-dot entry of the primary node_modules into the worktree. */
  nodeModules?: boolean;
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

/** Per-entry symlinks node_modules/<entry> -> primary, skipping dot entries (caches). Returns the count. */
export function materializeNodeModules(from: string, to: string): number {
  const src = path.join(from, "node_modules");
  if (!fs.existsSync(src)) return 0;
  const dest = path.join(to, "node_modules");
  fs.mkdirSync(dest, { recursive: true });
  let n = 0;
  for (const entry of fs.readdirSync(src)) {
    if (entry.startsWith(".")) continue;
    const link = path.join(dest, entry);
    if (fs.existsSync(link)) continue;
    fs.symlinkSync(path.join(src, entry), link);
    n += 1;
  }
  return n;
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
    const dirty = git(top, ["status", "--porcelain"]);
    if (dirty !== "") {
      const files = dirty.split("\n").slice(0, 5).join(", ");
      throw new HarnessError(
        `--isolate refuses a dirty working tree (the worktree starts from HEAD ${baseSha.slice(0, 7)}, so uncommitted edits would not reach the agent): ${files}${dirty.split("\n").length > 5 ? ", ..." : ""}. Commit or stash them, or pass --allow-dirty`,
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
  const realWt = fs.realpathSync(wtPath);
  const rel = path.relative(top, fs.realpathSync(cwd));
  const agentCwd = rel === "" ? realWt : path.join(realWt, rel);
  const ws: IsolatedWorkspace = { runId, path: realWt, agentCwd, branch, baseSha, source: top, cleanup: opts.cleanup === true };
  if (opts.nodeModules === true) {
    ws.nodeModules = materializeNodeModules(fs.realpathSync(cwd), agentCwd);
    if (ws.nodeModules === 0) delete ws.nodeModules;
  }
  opts.onPrepared?.(ws);
  return ws;
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
