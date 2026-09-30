// Ancestor instruction-file detection (agentic-coding-harness#106).
//
// Coding-agent CLIs load "project memory" files not only from the run's cwd
// but from the cwd's ANCESTOR directories. A workspace under $HOME therefore
// silently inherits e.g. ~/CLAUDE.md, even with claude's
// `--setting-sources project,local --strict-mcp-config`, because a
// parent-directory CLAUDE.md counts as project memory. That leaks the user's
// own instructions into runs meant to be hermetic and skews benchmark
// comparisons.
//
// This module is PURE: it walks from the cwd's PARENT upward and reports the
// instruction files the given agent would pick up there. The cwd's own files
// are the workspace's own project memory, so they are never reported. The
// filesystem probe and the walk ceiling are injectable for tests.
//
// Per-agent rules, and where each comes from:
//   claude  CLAUDE.md, CLAUDE.local.md in EVERY ancestor up to the filesystem
//           root (Claude Code memory docs: memory is read recursively upward
//           from the cwd; owner repro in #106 shows ~/CLAUDE.md reaching a
//           workspace under $HOME). The walk includes `/` itself: over-
//           reporting an exotic /CLAUDE.md is safer than missing it.
//   codex   AGENTS.override.md, AGENTS.md, only in directories between the
//           project root (nearest dir, cwd included, holding a `.git` entry)
//           and the cwd; with no project root only the cwd is read, so no
//           ancestors. Source: codex 0.158.0 binary strings
//           ("AGENTS.override.md", "AGENTS.md", core/src/agents_md.rs,
//           "project_root_markers", ".git") — string evidence, not a traced
//           call path.
//   gemini  GEMINI.md, same git-root ceiling. Source: @google/gemini-cli
//           0.56.0 bundle, getEnvironmentMemoryPaths → findProjectRoot2
//           (boundary marker ".git", returns null when none is found, then
//           the ceiling is the start dir itself) → findUpwardGeminiFiles.
//   opencode, kiro, null, custom, agents.d descriptors: nothing verified,
//           so nothing is reported (empty list).

import fs from 'node:fs';
import path from 'node:path';

export type AncestorStopRule = 'filesystem-root' | 'git-root';

export interface AncestorInstructionSpec {
  /** File names checked in each ancestor directory, in report order. */
  files: readonly string[];
  /** 'filesystem-root': every ancestor; 'git-root': ancestors up to and
   *  including the nearest dir holding `.git` (none when there is no such dir). */
  stop: AncestorStopRule;
}

export const ANCESTOR_INSTRUCTION_SPECS: Readonly<Record<string, AncestorInstructionSpec>> = {
  claude: { files: ['CLAUDE.md', 'CLAUDE.local.md'], stop: 'filesystem-root' },
  codex: { files: ['AGENTS.override.md', 'AGENTS.md'], stop: 'git-root' },
  gemini: { files: ['GEMINI.md'], stop: 'git-root' },
};

export interface AncestorProbe {
  /** True when `p` exists (file, directory, or anything else). A worktree's
   *  `.git` is a FILE, so the git-root marker check must not require a dir. */
  exists(p: string): boolean;
  /** True when `p` is a regular file (symlinks followed). */
  isFile(p: string): boolean;
}

export const nodeAncestorProbe: AncestorProbe = {
  exists: (p) => {
    try {
      fs.lstatSync(p);
      return true;
    } catch {
      return false;
    }
  },
  isFile: (p) => {
    try {
      return fs.statSync(p).isFile();
    } catch {
      return false;
    }
  },
};

export interface FindAncestorOptions {
  probe?: AncestorProbe;
  /** Walk ceiling (inclusive) for tests; default: the filesystem root. The
   *  walk never goes above it even if the stop rule would. */
  root?: string;
}

/** Directories strictly above `cwd`, nearest first, ending at `root` (or the
 *  filesystem root). Empty when cwd is the ceiling itself. */
function ancestorsOf(cwd: string, root: string | undefined): string[] {
  const out: string[] = [];
  const ceiling = root !== undefined ? path.resolve(root) : undefined;
  let current = path.resolve(cwd);
  if (ceiling !== undefined && current === ceiling) return out;
  for (;;) {
    const parent = path.dirname(current);
    if (parent === current) break;
    out.push(parent);
    if (ceiling !== undefined && parent === ceiling) break;
    current = parent;
  }
  return out;
}

/**
 * The ancestor instruction files `agent` would load for a run in `cwd`,
 * nearest directory first. Returns absolute paths; the cwd's own files are
 * excluded. Unknown agents (and agents without a verified rule) return [].
 */
export function findAncestorInstructions(agent: string, cwd: string, opts: FindAncestorOptions = {}): string[] {
  const spec = ANCESTOR_INSTRUCTION_SPECS[agent];
  if (spec === undefined) return [];
  const probe = opts.probe ?? nodeAncestorProbe;
  const start = path.resolve(cwd);
  let dirs = ancestorsOf(start, opts.root);
  if (spec.stop === 'git-root') {
    // The project root may be the cwd itself: then nothing above it is read.
    if (probe.exists(path.join(start, '.git'))) return [];
    const idx = dirs.findIndex((d) => probe.exists(path.join(d, '.git')));
    // No project root at all: the agent reads only the cwd.
    if (idx === -1) return [];
    dirs = dirs.slice(0, idx + 1);
  }
  const found: string[] = [];
  for (const dir of dirs) {
    for (const name of spec.files) {
      const candidate = path.join(dir, name);
      if (probe.isFile(candidate)) found.push(candidate);
    }
  }
  return found;
}

/** One stderr-ready warning line block for a non-empty detection result. */
export function formatAncestorWarning(agent: string, cwd: string, files: readonly string[]): string {
  const lines = [
    `[warn] ${agent} will load ${files.length} instruction file${files.length === 1 ? '' : 's'} from ANCESTOR directories of the workspace ${cwd} (#106):`,
    ...files.map((f) => `[warn]   ${f}`),
    '[warn] these leak into the run as project memory; use --hermetic, or keep the workspace outside those directories (e.g. under /tmp)',
  ];
  return lines.join('\n');
}
