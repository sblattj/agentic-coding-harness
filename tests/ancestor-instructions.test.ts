// #106: ancestor instruction-file detection (src/core/ancestor-instructions.ts).
// Real temp trees, with the walk capped at the tree's own root so files
// elsewhere on the machine can never change the result.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

import {
  ANCESTOR_INSTRUCTION_SPECS,
  findAncestorInstructions,
  formatAncestorWarning,
  type AncestorProbe,
} from "../src/core/ancestor-instructions.ts";

const roots: string[] = [];
after(() => {
  for (const r of roots) fs.rmSync(r, { recursive: true, force: true });
});

/** Build `files` (relative paths; a trailing '/' makes a dir) under a fresh root. */
function tree(files: string[]): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ach-ancestors-")));
  roots.push(root);
  for (const f of files) {
    const abs = path.join(root, f);
    if (f.endsWith("/")) fs.mkdirSync(abs, { recursive: true });
    else {
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, "rule\n");
    }
  }
  return root;
}

describe("findAncestorInstructions (#106)", () => {
  it("claude: finds CLAUDE.md and CLAUDE.local.md in every ancestor, nearest first", () => {
    const root = tree(["CLAUDE.md", "a/CLAUDE.local.md", "a/b/CLAUDE.md", "a/b/ws/"]);
    const found = findAncestorInstructions("claude", path.join(root, "a/b/ws"), { root });
    assert.deepEqual(found, [path.join(root, "a/b/CLAUDE.md"), path.join(root, "a/CLAUDE.local.md"), path.join(root, "CLAUDE.md")]);
  });

  it("excludes the cwd's own files (the workspace's own project memory)", () => {
    const root = tree(["ws/CLAUDE.md", "ws/CLAUDE.local.md", "ws/AGENTS.md", "ws/GEMINI.md"]);
    const ws = path.join(root, "ws");
    for (const agent of ["claude", "codex", "gemini", "prime"]) {
      assert.deepEqual(findAncestorInstructions(agent, ws, { root }), [], agent);
    }
  });

  it("prime: AGENTS.md and CLAUDE.md in every ancestor, past a git root", () => {
    const root = tree(["AGENTS.md", "repo/.git/", "repo/CLAUDE.md", "repo/ws/AGENTS.md", "repo/ws/"]);
    assert.deepEqual(findAncestorInstructions("prime", path.join(root, "repo/ws"), { root }), [
      path.join(root, "repo/CLAUDE.md"),
      path.join(root, "AGENTS.md"),
    ]);
    // No git root anywhere: still walks every ancestor.
    const bare = tree(["CLAUDE.md", "a/AGENTS.md", "a/ws/"]);
    assert.deepEqual(findAncestorInstructions("prime", path.join(bare, "a/ws"), { root: bare }), [
      path.join(bare, "a/AGENTS.md"),
      path.join(bare, "CLAUDE.md"),
    ]);
  });

  it("returns [] when nothing is found", () => {
    const root = tree(["x/y/ws/", "x/README.md"]);
    assert.deepEqual(findAncestorInstructions("claude", path.join(root, "x/y/ws"), { root }), []);
  });

  it("claude walks past a git root (parent-dir CLAUDE.md is project memory)", () => {
    const root = tree(["CLAUDE.md", "repo/.git/", "repo/ws/"]);
    assert.deepEqual(findAncestorInstructions("claude", path.join(root, "repo/ws"), { root }), [path.join(root, "CLAUDE.md")]);
  });

  it("codex: AGENTS.override.md + AGENTS.md, only up to the git root", () => {
    const root = tree(["AGENTS.md", "repo/.git/", "repo/AGENTS.override.md", "repo/AGENTS.md", "repo/pkg/ws/"]);
    assert.deepEqual(findAncestorInstructions("codex", path.join(root, "repo/pkg/ws"), { root }), [
      path.join(root, "repo/AGENTS.override.md"),
      path.join(root, "repo/AGENTS.md"),
    ]);
  });

  it("codex/gemini: no git root → no ancestors at all", () => {
    const root = tree(["AGENTS.md", "GEMINI.md", "a/ws/"]);
    assert.deepEqual(findAncestorInstructions("codex", path.join(root, "a/ws"), { root }), []);
    assert.deepEqual(findAncestorInstructions("gemini", path.join(root, "a/ws"), { root }), []);
  });

  it("codex/gemini: a git root AT the cwd means no ancestors", () => {
    const root = tree(["repo/.git/", "AGENTS.md", "GEMINI.md", "repo/"]);
    assert.deepEqual(findAncestorInstructions("codex", path.join(root, "repo"), { root }), []);
    assert.deepEqual(findAncestorInstructions("gemini", path.join(root, "repo"), { root }), []);
  });

  it("gemini: GEMINI.md up to a git root marked by a .git FILE (worktree)", () => {
    const root = tree(["GEMINI.md", "wt/.git", "wt/GEMINI.md", "wt/sub/ws/"]);
    assert.deepEqual(findAncestorInstructions("gemini", path.join(root, "wt/sub/ws"), { root }), [path.join(root, "wt/GEMINI.md")]);
  });

  it("per-agent file sets: each agent sees only its own files", () => {
    const root = tree(["CLAUDE.md", "AGENTS.md", "GEMINI.md", ".git/", "ws/"]);
    const ws = path.join(root, "ws");
    assert.deepEqual(findAncestorInstructions("claude", ws, { root }), [path.join(root, "CLAUDE.md")]);
    assert.deepEqual(findAncestorInstructions("codex", ws, { root }), [path.join(root, "AGENTS.md")]);
    assert.deepEqual(findAncestorInstructions("gemini", ws, { root }), [path.join(root, "GEMINI.md")]);
    for (const agent of ["opencode", "kiro", "null", "custom", "my-descriptor"]) {
      assert.deepEqual(findAncestorInstructions(agent, ws, { root }), [], agent);
    }
    assert.deepEqual(findAncestorInstructions("prime", ws, { root }), [path.join(root, "AGENTS.md"), path.join(root, "CLAUDE.md")]);
    assert.deepEqual(Object.keys(ANCESTOR_INSTRUCTION_SPECS).sort(), ["claude", "codex", "gemini", "prime"]);
  });

  it("a directory named CLAUDE.md is not an instruction file", () => {
    const root = tree(["CLAUDE.md/", "ws/"]);
    assert.deepEqual(findAncestorInstructions("claude", path.join(root, "ws"), { root }), []);
  });

  it("without a ceiling the walk reaches the filesystem root (injected probe)", () => {
    const seen: string[] = [];
    const probe: AncestorProbe = {
      exists: () => false,
      isFile: (p) => {
        seen.push(p);
        return p === path.join(path.parse(process.cwd()).root, "CLAUDE.md") || p === "/home/u/CLAUDE.md";
      },
    };
    const found = findAncestorInstructions("claude", "/home/u/proj/ws", { probe });
    assert.deepEqual(found, ["/home/u/CLAUDE.md", "/CLAUDE.md"]);
    assert.ok(!seen.includes("/home/u/proj/ws/CLAUDE.md"), "the cwd itself is never probed");
  });

  it("formatAncestorWarning names every file and the remedy", () => {
    const text = formatAncestorWarning("claude", "/home/u/ws", ["/home/u/CLAUDE.md"]);
    assert.match(text, /ANCESTOR directories/);
    assert.match(text, /\/home\/u\/CLAUDE\.md/);
    assert.match(text, /--hermetic/);
  });
});
