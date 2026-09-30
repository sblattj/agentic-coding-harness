import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { aggregateDims, branchIndex, branchLabel, NO_BRANCH, parseByDims, renderDimsText, type DimRecord } from "../src/cli/stats-dims.ts";
import { gitBranchInfo, parseRevParse } from "../src/core/git-branch.ts";
import { readRunRecord, RunRecordSchema, writeRunRecord } from "../src/core/registry.ts";

// #47: attribute spend by git branch.

function git(cwd: string, ...args: string[]): string {
  const p = spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" });
  assert.equal(p.status, 0, p.stderr);
  return p.stdout.trim();
}

function rec(over: Partial<DimRecord>): DimRecord {
  return { ts: "2026-09-01T10:00:00.000Z", agent: "claude", inputTokens: 10, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, costUsd: 0.5, ...over };
}

describe("gitBranchInfo (#47)", () => {
  let tmp: string;
  let repo: string;
  before(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ach-branch-")));
    repo = path.join(tmp, "repo");
    fs.mkdirSync(repo);
    git(repo, "init", "-q", "-b", "feature/x");
    fs.writeFileSync(path.join(repo, "f"), "1");
    git(repo, "add", "f");
    git(repo, "commit", "-q", "-m", "one");
  });
  after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it("records branch and short sha inside a repo", () => {
    const sha = git(repo, "rev-parse", "--short=7", "HEAD");
    assert.deepEqual(gitBranchInfo(repo), { branch: "feature/x", commit: sha });
  });

  it("detached HEAD records the short sha and no branch", () => {
    git(repo, "checkout", "-q", "--detach");
    const info = gitBranchInfo(repo);
    assert.equal(info.branch, undefined);
    assert.match(info.commit ?? "", /^[0-9a-f]{7}$/);
    assert.equal(branchLabel(info), `(detached ${info.commit})`);
    git(repo, "checkout", "-q", "feature/x");
  });

  it("non-repo, missing dir and empty cwd record nothing and never throw", () => {
    const plain = path.join(tmp, "plain");
    fs.mkdirSync(plain);
    assert.deepEqual(gitBranchInfo(plain), {});
    assert.deepEqual(gitBranchInfo(path.join(tmp, "gone")), {});
    assert.deepEqual(gitBranchInfo(undefined), {});
  });

  it("parseRevParse handles garbage", () => {
    assert.deepEqual(parseRevParse(""), {});
    assert.deepEqual(parseRevParse("HEAD\nHEAD\n"), {});
  });
});

describe("RunRecord branch/commit (#47)", () => {
  it("round-trips through the registry; older records without them still parse", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ach-branch-reg-"));
    try {
      writeRunRecord(dir, { runId: "r1", agent: "claude", startedAt: 1, branch: "main", commit: "abc1234" });
      const back = readRunRecord(dir, "r1");
      assert.equal(back?.branch, "main");
      assert.equal(back?.commit, "abc1234");
      assert.ok(RunRecordSchema.safeParse({ runId: "r2", agent: "claude", startedAt: 1 }).success);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("aggregateDims byBranch (#47)", () => {
  it("groups by branch with an explicit (no branch) bucket; off by default", () => {
    const recs = [rec({ branch: "main" }), rec({ branch: "main" }), rec({ branch: "feat" }), rec({}), rec({ branch: "(detached abc1234)" })];
    assert.equal(aggregateDims(recs, {}).byBranch, undefined);
    const dims = aggregateDims(recs, { byBranch: true });
    assert.deepEqual(Object.keys(dims.byBranch!).sort(), ["(detached abc1234)", NO_BRANCH, "feat", "main"]);
    assert.equal(dims.byBranch!.main!.records, 2);
    assert.equal(dims.byBranch!.main!.inputTokens, 20);
    assert.equal(dims.byBranch![NO_BRANCH]!.records, 1);
    const total = Object.values(dims.byBranch!).reduce((n, b) => n + b.records, 0);
    assert.equal(total, recs.length, "no record is dropped");
    const text = renderDimsText(dims, { model: false, project: false, branch: true });
    assert.equal(text[0], "-- by branch");
    assert.ok(text.some((l) => l.startsWith("main ")));
  });

  it("composes with byProject", () => {
    const dims = aggregateDims([rec({ branch: "main", cwd: "/x" })], { byBranch: true, byProject: true });
    assert.ok(dims.byBranch && dims.byProject);
  });

  it("parseByDims accepts branch; branchIndex matches by agent+session", () => {
    assert.deepEqual([...parseByDims(["model,branch"])].sort(), ["branch", "model"]);
    const idx = branchIndex([{ agent: "claude", sessionId: "s1", branch: "main" }, { agent: "codex", sessionId: "s2", commit: "abc1234" }, { agent: "claude", sessionId: "s3" }]);
    assert.equal(idx("claude", "s1"), "main");
    assert.equal(idx("codex", "s2"), "(detached abc1234)");
    assert.equal(idx("claude", "s3"), undefined);
    assert.equal(idx("claude", null), undefined);
  });
});

describe("ach stats --by branch (CLI)", () => {
  const CLI = new URL("../src/cli/ach.ts", import.meta.url).pathname;
  let stateDir: string;
  let home: string;
  const recent = new Date(Date.now() - 86_400_000).toISOString();

  const raw = (agent: string, sessionId: string, input: number) =>
    JSON.stringify({ ts: recent, agent, sessionId, model: "gpt-5", inputTokens: input, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, costUsd: 0.01 }) + "\n";

  before(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "ach-branch-state-"));
    home = fs.mkdtempSync(path.join(os.tmpdir(), "ach-branch-home-"));
    fs.mkdirSync(path.join(stateDir, "raw", "codex"), { recursive: true });
    fs.mkdirSync(path.join(stateDir, "runs"), { recursive: true });
    for (const [s, n] of [["s-main", 100], ["s-det", 200], ["s-none", 400]] as const) {
      fs.writeFileSync(path.join(stateDir, "raw", "codex", `${s}.jsonl`), raw("codex", s, n));
    }
    writeRunRecord(stateDir, { runId: "r-main", agent: "codex", sessionId: "s-main", startedAt: Date.now(), branch: "refactor", commit: "1111111" });
    writeRunRecord(stateDir, { runId: "r-det", agent: "codex", sessionId: "s-det", startedAt: Date.now(), commit: "2222222" });
    writeRunRecord(stateDir, { runId: "r-none", agent: "codex", sessionId: "s-none", startedAt: Date.now() });
  });
  after(() => {
    for (const d of [stateDir, home]) fs.rmSync(d, { recursive: true, force: true });
  });

  const run = (args: string[]) => {
    const p = spawnSync(process.execPath, ["--import", "tsx", CLI, ...args], {
      env: { ...process.env, AGENTIC_CODING_HARNESS_STATE_DIR: stateDir, HOME: home, AGENTIC_CODING_HARNESS_PROJECT_ALIASES: "", AGENTIC_CODING_HARNESS_TZ: "UTC" },
      encoding: "utf8",
    });
    return { code: p.status ?? -1, stdout: p.stdout ?? "", stderr: p.stderr ?? "" };
  };

  it("--json adds byBranch (additive) with detached and (no branch) buckets", () => {
    const res = run(["stats", "--json", "--state-only", "--by", "branch"]);
    assert.equal(res.code, 0, res.stderr);
    const out = JSON.parse(res.stdout);
    assert.deepEqual(Object.keys(out.byBranch).sort(), ["(detached 2222222)", "(no branch)", "refactor"]);
    assert.equal(out.byBranch.refactor.inputTokens, 100);
    assert.equal(out.byBranch["(detached 2222222)"].inputTokens, 200);
    assert.equal(out.byBranch["(no branch)"].inputTokens, 400);
    assert.equal(out.byProject, undefined);
    const plain = JSON.parse(run(["stats", "--json", "--state-only"]).stdout);
    assert.equal(plain.byBranch, undefined, "absent without --by branch");
  });

  it("text output prints a per-branch table and composes with --by model,project", () => {
    const res = run(["stats", "--state-only", "--by", "branch"]);
    assert.equal(res.code, 0, res.stderr);
    assert.match(res.stdout, /-- by branch/);
    assert.match(res.stdout, /^refactor +records=1 /m);
    assert.match(res.stdout, /^\(no branch\) +records=1 /m);
    const both = JSON.parse(run(["stats", "--json", "--state-only", "--by", "model,project,branch"]).stdout);
    assert.ok(both.byModel && both.byProject && both.byBranch);
  });
});
