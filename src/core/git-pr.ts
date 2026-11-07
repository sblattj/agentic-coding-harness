import { execFileSync } from 'node:child_process';
import path from 'node:path';

import { gitBranchInfo } from './git-branch.ts';
import { isolateBranchName } from './isolate.ts';

/** Where a run's recorded PR number came from (#48). */
export type PrSource = 'flag' | 'env' | 'branch' | 'gh';

export interface PrInfo {
  pr?: number;
  prSource?: PrSource;
}

/** Env var that supplies the PR per shell (the `--pr` flag wins over it). */
export const PR_ENV = 'AGENTIC_CODING_HARNESS_PR';

const GH_TIMEOUT_MS = 4000;
const MAX_PR = 9_999_999;

/** `--pr` / env value -> a PR number, `auto`, or a usage error message. */
export function parsePrValue(raw: string): number | 'auto' {
  const v = raw.trim();
  if (v.toLowerCase() === 'auto') return 'auto';
  const m = /^#?(\d{1,7})$/.exec(v);
  const n = m ? Number(m[1]) : 0;
  if (!Number.isInteger(n) || n < 1 || n > MAX_PR) {
    throw new Error(`invalid PR '${raw}' (expected a positive integer or 'auto')`);
  }
  return n;
}

/**
 * Map a branch name to a PR/issue number from its NAME ONLY (no network).
 * Each `/`-separated segment is tried left to right; the first match wins:
 *   - `pr-<n>`, `pull-<n>`, `issue-<n>`, `issues-<n>` (optionally followed by `-slug`)
 *   - `<n>-slug` where the slug starts with a letter (`482-fix-auth`)
 * Rejected on purpose (stay unlinked): `main`, `develop`, a bare number
 * (`482`), a date (`2026-11-07`: no letter after the dash), a version
 * (`release-1.2`, `v2-beta`), `pr-` / `issue-` without digits.
 */
export function prFromBranch(branch: string | undefined): number | undefined {
  if (!branch) return undefined;
  for (const seg of branch.split('/')) {
    const m = /^(?:(?:pr|pull|issues?)-(\d{1,7})(?:-.*)?|(\d{1,7})-[A-Za-z].*)$/i.exec(seg);
    const raw = m?.[1] ?? m?.[2];
    if (raw === undefined) continue;
    const n = Number(raw);
    if (n >= 1 && n <= MAX_PR) return n;
  }
  return undefined;
}

/** Per-process memo of gh lookups, keyed by repo toplevel + branch. Negative results and timeouts are cached too. */
const ghCache = new Map<string, number | undefined>();

/** Test seam: forget memoized gh lookups. */
export function clearPrGhCache(): void {
  ghCache.clear();
}

function repoTop(cwd: string | undefined): string {
  if (!cwd) return '';
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd,
      encoding: 'utf8',
      timeout: 1500,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return cwd;
  }
}

/**
 * `gh pr view <branch> --json number`; undefined when gh is missing, fails, or has no PR.
 * Opt-in only (`--pr auto`). Memoized per (repo toplevel, branch) for the life of the
 * process, so `--repeat` / `--parallel` pay for the sync call (4 s cap) at most once.
 */
export function prFromGh(branch: string | undefined, cwd: string | undefined): number | undefined {
  if (!branch) return undefined;
  const key = `${repoTop(cwd)}\0${branch}`;
  if (ghCache.has(key)) return ghCache.get(key);
  let result: number | undefined;
  try {
    const out = execFileSync('gh', ['pr', 'view', branch, '--json', 'number', '--jq', '.number'], {
      ...(cwd ? { cwd } : {}),
      encoding: 'utf8',
      timeout: GH_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const n = Number(out.trim());
    result = Number.isInteger(n) && n >= 1 ? n : undefined;
  } catch {
    result = undefined;
  }
  ghCache.set(key, result);
  return result;
}

/**
 * `--isolate` runs the agent in a worktree on `ach/<runId>`. The PR belongs to the
 * user's checkout, so map that worktree back to the primary checkout (the dir that
 * owns the shared git dir) and its current branch. Isolation refuses a dirty tree,
 * so the primary is still on the branch the worktree was cut from. Anything else
 * (not an isolated run, lookup failure) returns the inputs unchanged.
 */
export function prContextFor(
  runId: string | undefined,
  cwd: string,
  branch: string | undefined,
): { branch: string | undefined; cwd: string } {
  if (!runId || branch !== isolateBranchName(runId)) return { branch, cwd };
  try {
    const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
      cwd,
      encoding: 'utf8',
      timeout: 1500,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (path.basename(common) !== '.git') return { branch, cwd };
    const primary = path.dirname(common);
    const info = gitBranchInfo(primary);
    return info.branch ? { branch: info.branch, cwd: primary } : { branch, cwd };
  } catch {
    return { branch, cwd };
  }
}

export interface ResolvePrInput {
  /** `RunSpec.pr`: a number (explicit flag) or 'auto' (flag asks for the gh lookup). */
  flag?: number | 'auto';
  env?: NodeJS.ProcessEnv;
  branch?: string;
  cwd?: string;
  /** Test seam for the gh lookup. */
  gh?: (branch: string | undefined, cwd: string | undefined) => number | undefined;
}

/**
 * Precedence: explicit number flag > env number > branch pattern > gh (only
 * when `auto` came from the flag or env). Never throws; a bad env value is
 * ignored. Stats never calls this: grouping reads only what was recorded.
 */
export function resolvePr(input: ResolvePrInput): PrInfo {
  let auto = false;
  let fromFlag: number | undefined;
  if (typeof input.flag === 'number') fromFlag = input.flag;
  else if (input.flag === 'auto') auto = true;
  if (fromFlag !== undefined) return { pr: fromFlag, prSource: 'flag' };
  const rawEnv = input.env?.[PR_ENV];
  if (rawEnv !== undefined && rawEnv.trim() !== '' && !auto) {
    try {
      const v = parsePrValue(rawEnv);
      if (typeof v === 'number') return { pr: v, prSource: 'env' };
      auto = true;
    } catch {
      /* ignore a malformed env value */
    }
  }
  const fromName = prFromBranch(input.branch);
  if (fromName !== undefined) return { pr: fromName, prSource: 'branch' };
  if (auto) {
    const n = (input.gh ?? prFromGh)(input.branch, input.cwd);
    if (n !== undefined) return { pr: n, prSource: 'gh' };
  }
  return {};
}
