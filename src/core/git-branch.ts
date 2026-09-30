import { execFileSync } from 'node:child_process';

/** Git position of a directory at one instant. Fields are absent when unknown. */
export interface GitBranchInfo {
  /** Branch name; absent on a detached HEAD. */
  branch?: string;
  /** Short HEAD commit SHA (always present inside a repo with a commit). */
  commit?: string;
}

const GIT_TIMEOUT_MS = 1500;

/**
 * Best-effort git branch of `cwd`: ONE `git rev-parse` call with a short
 * timeout. Never throws: git missing, not a repo, unborn HEAD, or a timeout all
 * return `{}`. A detached HEAD returns `{ commit }` with no `branch`.
 * Reusable by other run-attribution features (PR, yield).
 */
export function gitBranchInfo(cwd: string | undefined): GitBranchInfo {
  if (!cwd) return {};
  try {
    const out = execFileSync('git', ['rev-parse', 'HEAD', '--abbrev-ref', 'HEAD'], {
      cwd,
      encoding: 'utf8',
      timeout: GIT_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return parseRevParse(out);
  } catch {
    return {};
  }
}

/** Parse `rev-parse HEAD --abbrev-ref HEAD` output (full sha line, then branch or `HEAD`). */
export function parseRevParse(out: string): GitBranchInfo {
  const [sha, name] = out.split('\n').map((s) => s.trim());
  const info: GitBranchInfo = {};
  if (name && name !== 'HEAD') info.branch = name;
  if (sha && /^[0-9a-f]{7,64}$/.test(sha)) info.commit = sha.slice(0, 7);
  return info;
}
