// #48: attribute spend to a PR. Pattern parser, resolution precedence, `ach run
// --pr` / env on a scripted fake agent (same shape as custom-agent.test.ts), and
// `ach stats --by pr` on a fixture registry with the network blocked.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { aggregateDims, NO_PR, parseByDims, prIndex, renderDimsText, type DimRecord } from "../src/cli/stats-dims.ts";
import { parsePrValue, prFromBranch, resolvePr } from "../src/core/git-pr.ts";
import { listRunRecords, RunRecordSchema, writeRunRecord } from "../src/core/registry.ts";
import { computeCompareRows } from "../src/web/compare.ts";

const CLI = new URL("../src/cli/ach.ts", import.meta.url).pathname;
const NODE = process.execPath;

describe("prFromBranch (#48)", () => {
  it("maps the acceptance fixtures and the other documented patterns", () => {
    assert.equal(prFromBranch("482-fix-auth"), 482);
    assert.equal(prFromBranch("pr-482"), 482);
    assert.equal(prFromBranch("issue-482"), 482);
    assert.equal(prFromBranch("issue-482-fix-auth"), 482);
    assert.equal(prFromBranch("feat/482-x"), 482);
    assert.equal(prFromBranch("someone/pr-77"), 77);
    assert.equal(prFromBranch("PR-9"), 9);
  });

  it("leaves trunk names, versions, dates and number-less branches unlinked", () => {
    for (const b of ["main", "develop", "master", "release-1.2", "v2-beta", "2026-11-07", "482", "feat/spend", "pr-", "issue-x", "0-zero", "", undefined]) {
      assert.equal(prFromBranch(b), undefined, String(b));
    }
  });
});

describe("resolvePr precedence (#48)", () => {
  it("flag > env > branch pattern; gh only for auto", () => {
    const gh = () => 999;
    assert.deepEqual(resolvePr({ flag: 1, env: { AGENTIC_CODING_HARNESS_PR: "2" }, branch: "3-x" }), { pr: 1, prSource: "flag" });
    assert.deepEqual(resolvePr({ env: { AGENTIC_CODING_HARNESS_PR: "2" }, branch: "3-x" }), { pr: 2, prSource: "env" });
    assert.deepEqual(resolvePr({ env: {}, branch: "3-x" }), { pr: 3, prSource: "branch" });
    assert.deepEqual(resolvePr({ env: {}, branch: "main", gh }), {}, "gh is never consulted without auto");
    assert.deepEqual(resolvePr({ flag: "auto", env: {}, branch: "main", gh }), { pr: 999, prSource: "gh" });
    assert.deepEqual(resolvePr({ flag: "auto", env: { AGENTIC_CODING_HARNESS_PR: "5" }, branch: "main", gh }), { pr: 999, prSource: "gh" }, "explicit auto beats an env number");
    assert.deepEqual(resolvePr({ env: { AGENTIC_CODING_HARNESS_PR: "auto" }, branch: "main", gh: () => undefined }), {});
  });

  it("ignores a malformed env value and rejects a malformed flag", () => {
    assert.deepEqual(resolvePr({ env: { AGENTIC_CODING_HARNESS_PR: "abc" }, branch: "pr-4" }), { pr: 4, prSource: "branch" });
    assert.equal(parsePrValue("#482"), 482);
    assert.equal(parsePrValue("auto"), "auto");
    for (const bad of ["0", "-1", "x", "1.5", ""]) assert.throws(() => parsePrValue(bad), /invalid PR/);
  });
});

describe("RunRecord pr/prSource (#48)", () => {
  it("validates, and older records without them still parse", () => {
    assert.ok(RunRecordSchema.safeParse({ runId: "a", agent: "x", startedAt: 1, pr: 482, prSource: "flag" }).success);
    assert.ok(RunRecordSchema.safeParse({ runId: "a", agent: "x", startedAt: 1 }).success);
    assert.ok(!RunRecordSchema.safeParse({ runId: "a", agent: "x", startedAt: 1, prSource: "magic" }).success);
  });
});

describe("ach run --pr (CLI, scripted agent)", () => {
  let tmp: string;
  let fake: string;
  let plain: string;
  let prBranchRepo: string;
  let mainRepo: string;

  const git = (cwd: string, ...args: string[]) => {
    const p = spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" });
    assert.equal(p.status, 0, p.stderr);
  };
  const mkRepo = (name: string, branch: string) => {
    const dir = path.join(tmp, name);
    fs.mkdirSync(dir);
    git(dir, "init", "-q", "-b", branch);
    fs.writeFileSync(path.join(dir, "f"), "1");
    git(dir, "add", "f");
    git(dir, "commit", "-q", "-m", "c");
    return dir;
  };

  /** Runs one scripted agent invocation; returns the single new run record. */
  const runOnce = (cwd: string, extra: string[], env: Record<string, string>) => {
    const stateDir = fs.mkdtempSync(path.join(tmp, "state-"));
    const p = spawnSync(NODE, ["--import", import.meta.resolve("tsx"), CLI, "run", "--agent", "custom", "--template", `'${NODE}' '${fake}' {prompt}`, ...extra, "hello"], {
      cwd,
      env: { ...process.env, AGENTIC_CODING_HARNESS_STATE_DIR: stateDir, AGENTIC_CODING_HARNESS_PR: "", ...env },
      encoding: "utf8",
    });
    return { code: p.status ?? -1, stderr: p.stderr ?? "", rec: listRunRecords(stateDir)[0] };
  };

  before(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ach-pr-")));
    fake = path.join(tmp, "fake-cli.mjs");
    fs.writeFileSync(fake, "process.stdout.write(JSON.stringify({type:'result',model:'m',usage:{in:10,out:2,cached:0}})+'\\n');\n");
    plain = path.join(tmp, "plain");
    fs.mkdirSync(plain);
    prBranchRepo = mkRepo("pr-branch", "482-fix-auth");
    mainRepo = mkRepo("main-repo", "main");
  });
  after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it("--pr 482 records pr 482 with prSource flag", { timeout: 60_000 }, () => {
    const r = runOnce(plain, ["--pr", "482"], {});
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.rec?.pr, 482);
    assert.equal(r.rec?.prSource, "flag");
  });

  it("env supplies the PR when the flag is absent; the flag wins over the env", { timeout: 60_000 }, () => {
    const viaEnv = runOnce(plain, [], { AGENTIC_CODING_HARNESS_PR: "300" });
    assert.equal(viaEnv.rec?.pr, 300);
    assert.equal(viaEnv.rec?.prSource, "env");
    const both = runOnce(plain, ["--pr", "482"], { AGENTIC_CODING_HARNESS_PR: "300" });
    assert.equal(both.rec?.pr, 482);
    assert.equal(both.rec?.prSource, "flag");
  });

  it("branch pattern links 482-fix-auth; main stays unlinked; a plain dir stays unlinked", { timeout: 60_000 }, () => {
    const linked = runOnce(prBranchRepo, [], {});
    assert.equal(linked.rec?.branch, "482-fix-auth");
    assert.equal(linked.rec?.pr, 482);
    assert.equal(linked.rec?.prSource, "branch");
    const trunk = runOnce(mainRepo, [], {});
    assert.equal(trunk.rec?.branch, "main");
    assert.equal(trunk.rec?.pr, undefined);
    assert.equal(trunk.rec?.prSource, undefined);
    assert.equal(runOnce(plain, [], {}).rec?.pr, undefined);
  });

  it("rejects a bad --pr as a usage error", { timeout: 60_000 }, () => {
    const r = runOnce(plain, ["--pr", "banana"], {});
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /--pr: invalid PR 'banana'/);
  });
});

describe("stats --by pr", () => {
  const rec = (over: Partial<DimRecord>): DimRecord => ({ ts: "2026-09-01T10:00:00.000Z", agent: "claude", inputTokens: 10, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, costUsd: 0.5, ...over });

  it("aggregateDims groups per PR with a none bucket; off by default; composes with --by", () => {
    const recs = [rec({ pr: 482 }), rec({ pr: 482 }), rec({ pr: 9 }), rec({})];
    assert.equal(aggregateDims(recs, {}).byPr, undefined);
    const dims = aggregateDims(recs, { byPr: true });
    assert.deepEqual(Object.keys(dims.byPr!).sort(), ["482", "9", NO_PR]);
    assert.equal(dims.byPr!["482"]!.records, 2);
    assert.equal(dims.byPr!["482"]!.costUsd, 1);
    assert.equal(dims.byPr![NO_PR]!.records, 1);
    const text = renderDimsText(dims, { model: false, project: false, pr: true });
    assert.equal(text[0], "-- by pr");
    assert.deepEqual(text.slice(1).map((l) => l.split(" ")[0]), ["#9", "#482", "none"], "numeric order, none last");
    assert.deepEqual([...parseByDims(["model,pr"])].sort(), ["model", "pr"]);
    const idx = prIndex([{ agent: "claude", sessionId: "s1", pr: 7 }, { agent: "claude", sessionId: "s2" }]);
    assert.equal(idx("claude", "s1"), 7);
    assert.equal(idx("claude", "s2"), undefined);
  });

  it("web compare groups by pr with the same labels", () => {
    const rows = computeCompareRows(
      [
        { runId: "a", agent: "x", startedAt: 1, pr: 482 },
        { runId: "b", agent: "x", startedAt: 2 },
      ],
      ["pr"],
    );
    assert.deepEqual(rows.map((r) => r.pr).sort(), ["482", "none"]);
  });

  describe("CLI on a fixture registry, network blocked", () => {
    let stateDir: string;
    let home: string;
    const recent = new Date(Date.now() - 86_400_000).toISOString();
    const raw = (sessionId: string, input: number) =>
      JSON.stringify({ ts: recent, agent: "codex", sessionId, model: "gpt-5", inputTokens: input, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, costUsd: 0.01 }) + "\n";

    before(() => {
      stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "ach-pr-state-"));
      home = fs.mkdtempSync(path.join(os.tmpdir(), "ach-pr-home-"));
      fs.mkdirSync(path.join(stateDir, "raw", "codex"), { recursive: true });
      for (const [s, n] of [["s-a", 100], ["s-b", 200], ["s-c", 400]] as const) fs.writeFileSync(path.join(stateDir, "raw", "codex", `${s}.jsonl`), raw(s, n));
      writeRunRecord(stateDir, { runId: "r-a", agent: "codex", sessionId: "s-a", startedAt: Date.now(), pr: 482, prSource: "flag" });
      writeRunRecord(stateDir, { runId: "r-b", agent: "codex", sessionId: "s-b", startedAt: Date.now(), pr: 482, prSource: "branch" });
      writeRunRecord(stateDir, { runId: "r-c", agent: "codex", sessionId: "s-c", startedAt: Date.now() });
    });
    after(() => {
      for (const d of [stateDir, home]) fs.rmSync(d, { recursive: true, force: true });
    });

    // Preload that makes any fetch throw: a network attempt would surface as a non-zero exit.
    const blockNet = path.join(os.tmpdir(), "ach-pr-block-net.mjs");
    before(() => fs.writeFileSync(blockNet, "globalThis.fetch = () => { throw new Error('NETWORK BLOCKED'); };\n"));
    after(() => fs.rmSync(blockNet, { force: true }));

    it("--json byPr groups spend per PR; no PR lands in none; fetch throws", () => {
      const res = spawnSync(NODE, ["--import", import.meta.resolve("tsx"), "--import", blockNet, CLI, "stats", "--json", "--state-only", "--by", "pr"], {
        env: { ...process.env, AGENTIC_CODING_HARNESS_STATE_DIR: stateDir, HOME: home, AGENTIC_CODING_HARNESS_PROJECT_ALIASES: "", AGENTIC_CODING_HARNESS_TZ: "UTC" },
        encoding: "utf8",
      });
      assert.equal(res.status, 0, res.stderr);
      const out = JSON.parse(res.stdout);
      assert.deepEqual(Object.keys(out.byPr).sort(), ["482", "none"]);
      assert.equal(out.byPr["482"].records, 2);
      assert.equal(out.byPr["482"].inputTokens, 300);
      assert.equal(out.byPr.none.inputTokens, 400);
      const plain = JSON.parse(
        spawnSync(NODE, ["--import", import.meta.resolve("tsx"), CLI, "stats", "--json", "--state-only"], {
          env: { ...process.env, AGENTIC_CODING_HARNESS_STATE_DIR: stateDir, HOME: home, AGENTIC_CODING_HARNESS_TZ: "UTC" },
          encoding: "utf8",
        }).stdout,
      );
      assert.equal(plain.byPr, undefined, "absent without --by pr");
    });

    it("text output prints a per-PR table", () => {
      const p = spawnSync(NODE, ["--import", import.meta.resolve("tsx"), "--import", blockNet, CLI, "stats", "--state-only", "--by", "pr"], {
        env: { ...process.env, AGENTIC_CODING_HARNESS_STATE_DIR: stateDir, HOME: home, AGENTIC_CODING_HARNESS_TZ: "UTC" },
        encoding: "utf8",
      });
      assert.equal(p.status, 0, p.stderr);
      assert.match(p.stdout ?? "", /-- by pr/);
      assert.match(p.stdout ?? "", /^#482 +records=2 /m);
      assert.match(p.stdout ?? "", /^none +records=1 /m);
    });
  });
});
