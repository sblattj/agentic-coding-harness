// Workspace confinement (agentic-coding-harness#9).
//
// The library must be able to guarantee that a caller-supplied path it acts
// on (agent subprocess cwd, per-run stateDir) stays inside a declared
// workspace root. Lexical checks alone are NOT enough: a symlink inside the
// workspace can point anywhere on disk. Every path is therefore resolved to
// its REAL path (symlinks followed) before the containment test, and `..`
// segments are collapsed by path.resolve before that — so both escape
// vectors are covered by one canonical comparison.
//
// A candidate that does not exist yet (e.g. a stateDir about to be created)
// is resolved through its deepest EXISTING ancestor: the realpath of that
// ancestor plus the not-yet-existing tail. A symlink must exist to be
// followed, so a missing tail cannot smuggle an escape.

import { realpathSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { HarnessError } from './types.js';

/** Thrown when a caller-supplied path escapes the workspace root (#9). */
export class WorkspaceEscapeError extends HarnessError {
  constructor(message: string) {
    super(message, 'WORKSPACE_ESCAPE', 2);
    this.name = 'WorkspaceEscapeError';
  }
}

/**
 * Resolve `abs` (an absolute lexical path) to its deepest existing ancestor's
 * realpath, keeping any non-existing tail lexical. ENOTDIR is treated like
 * ENOENT (a file segment mid-path makes the rest unreachable, not a threat).
 */
function realpathPrefix(abs: string): { ancestor: string; real: string } {
  let current = abs;
  for (;;) {
    try {
      return { ancestor: current, real: realpathSync(current) };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw err;
      const parent = dirname(current);
      if (parent === current) return { ancestor: current, real: current };
      current = parent;
    }
  }
}

/**
 * Canonical form of `candidate` (issue #9): absolute, `..` collapsed, and
 * symlinks resolved on every existing component. Relative candidates are
 * resolved against `base` (default: process.cwd()).
 */
export function canonicalPath(candidate: string, base: string = process.cwd()): string {
  const abs = resolve(base, candidate);
  const { ancestor, real } = realpathPrefix(abs);
  if (ancestor === abs) return real;
  // abs starts with ancestor by construction (dirname walk); join normalizes
  // the leading separator the slice carries.
  return join(real, abs.slice(ancestor.length));
}

/** True when `candidate`'s canonical path equals or sits under `root`'s. */
export function isInsideWorkspace(root: string, candidate: string, base?: string): boolean {
  const rootReal = canonicalPath(root, base);
  const candReal = canonicalPath(candidate, base);
  if (candReal === rootReal) return true;
  // sep-terminated prefix so '/ws' never admits '/ws-evil'; the fs root is
  // its own separator, so it needs no extra one.
  const boundary = rootReal.endsWith(sep) ? rootReal : rootReal + sep;
  return candReal.startsWith(boundary);
}

/**
 * Assert containment and return the candidate's canonical path. Throws
 * WorkspaceEscapeError naming the field, the candidate, and both resolved
 * paths when the candidate resolves outside the root.
 */
export function assertInsideWorkspace(
  root: string,
  candidate: string,
  opts: { base?: string; label?: string } = {},
): string {
  const rootReal = canonicalPath(root, opts.base);
  const candReal = canonicalPath(candidate, opts.base);
  if (!isInsideWorkspace(rootReal, candReal)) {
    const what = opts.label ? `${opts.label} ('${candidate}')` : `'${candidate}'`;
    throw new WorkspaceEscapeError(
      `workspace confinement: ${what} resolves to '${candReal}', outside the workspace root '${root}' (resolves to '${rootReal}')`,
    );
  }
  return candReal;
}
