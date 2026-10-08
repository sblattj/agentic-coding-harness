// ach replay vet (#115 part B): canned-JSON fetcher + temp git fixtures; no network.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  approvalState, cmdReplay, findTickets, parseGithubRemote, parsePrRef, vetPr, REPLAY_VET_EXIT,
  DEFAULT_TICKET_REGEX, type PrFetcher, type PullData, type ReviewData,
} from "../src/cli/replay-vet.ts";

function sh(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8" }).trim();
}

/** main: A -> B(base, "trunk") ; feature branch merged with --no-ff (M2); squash commit S on a second line. */
function partial_dir(root: string): string {
  const d = path.join(root, "partial");
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ach-vet-"));
  const full = path.join(root, "full");
  fs.mkdirSync(full);
  sh(full, "init", "-q", "-b", "main");
  const w = (f: string, t: string) => { fs.mkdirSync(path.dirname(path.join(full, f)), { recursive: true }); fs.writeFileSync(path.join(full, f), t); };
  w("a.txt", "a\n"); sh(full, "add", "."); sh(full, "commit", "-qm", "A");
  w("b.txt", "b\n"); sh(full, "add", "."); sh(full, "commit", "-qm", "B");
  const base = sh(full, "rev-parse", "HEAD");
  sh(full, "checkout", "-qb", "feat");
  w("src/x.ts", "x\n"); w("tests/x.test.ts", "t\n"); sh(full, "add", "."); sh(full, "commit", "-qm", "feat work");
  sh(full, "checkout", "-q", "main");
  sh(full, "merge", "--no-ff", "-qm", "Merge PR 7", "feat");
  const mergeCommit = sh(full, "rev-parse", "HEAD");
  w("c.txt", "c\n"); sh(full, "add", "."); sh(full, "commit", "-qm", "C squash-like");
  const squash = sh(full, "rev-parse", "HEAD");
  const squashBase = sh(full, "rev-parse", "HEAD^");
  // a clone that only fetched the base (merge commit missing)
  sh(partial_dir(root), "init", "-q", "-b", "main");
  sh(partial_dir(root), "fetch", "-q", full, base);
  return { root, full, partial: partial_dir(root), base, mergeCommit, squash, squashBase };
}

const pull = (over: Partial<PullData> = {}): PullData => ({
  number: 7, title: "PROJ-42 add x", body: "details", merged: true, mergedAt: "2026-01-02T00:00:00Z",
  createdAt: "2026-01-01T00:00:00Z", baseRef: "main", headRef: "feat/x", mergeCommitSha: null,
  changedFiles: 4, additions: 10, deletions: 1, ...over,
});
const fetcher = (p: PullData, reviews: ReviewData[], files: string[], dflt = "main"): PrFetcher => ({
  pull: async () => p, reviews: async () => reviews, files: async () => files, defaultBranch: async () => dflt,
});
const OK_REVIEW: ReviewData[] = [{ user: "bob", state: "APPROVED" }];
const MERGE_FILES = ["src/x.ts", "tests/x.test.ts"]; // what the fixture merge commit really touches
const FILES = ["src/a.ts", "src/b.ts", "src/c.ts", "tests/a.test.ts"];
const status = (r: Awaited<ReturnType<typeof vetPr>>, id: string) => r.checks.find((c) => c.id === id)?.status;

describe("replay vet: pure helpers", () => {
  test("parseGithubRemote / parsePrRef", () => {
    assert.equal(parseGithubRemote("git@github.com:o/r.git"), "o/r");
    assert.equal(parseGithubRemote("https://github.com/o/r"), "o/r");
    assert.equal(parseGithubRemote("https://gitlab.com/o/r"), null);
    assert.deepEqual(parsePrRef("12"), { number: 12 });
    assert.deepEqual(parsePrRef("https://github.com/o/r/pull/9"), { repo: "o/r", number: 9 });
    assert.throws(() => parsePrRef("nope"), /not a PR number/);
  });
  test("findTickets looks in title, branch and body (title wins)", () => {
    const re = new RegExp(DEFAULT_TICKET_REGEX);
    assert.deepEqual(findTickets({ title: "fix bug", branch: "feature/ABC-12-fix", body: "" }, re), { id: "ABC-12", source: "branch", candidates: ["ABC-12"] });
    assert.equal(findTickets({ title: "fix", branch: "x", body: "closes #33" }, re).id, "#33");
    assert.equal(findTickets({ title: "TT-1 and UU-2", branch: "", body: "" }, re).id, "TT-1");
    assert.equal(findTickets({ title: "fix", branch: "x", body: "none" }, re).id, null);
  });
  test("approvalState: latest decisive review per user", () => {
    assert.deepEqual(approvalState([{ user: "a", state: "APPROVED" }, { user: "a", state: "COMMENTED" }]).approvers, ["a"]);
    assert.deepEqual(approvalState([{ user: "a", state: "APPROVED" }, { user: "a", state: "CHANGES_REQUESTED" }]), { approvers: [], blockers: ["a"] });
    assert.deepEqual(approvalState([{ user: "a", state: "APPROVED" }, { user: "a", state: "DISMISSED" }]), { approvers: [], blockers: [] });
  });
});

describe("replay vet: git fixtures", () => {
  const fx = fixture();

  test("merge commit: pass, base = first parent, diff stat, next commands", async () => {
    const r = await vetPr({ repo: "o/r", number: 7, clone: fx.full, minFiles: 2 }, fetcher(pull({ mergeCommitSha: fx.mergeCommit }), OK_REVIEW, MERGE_FILES));
    assert.equal(r.verdict, "pass");
    assert.equal(status(r, "diff-matches"), "pass");
    assert.equal(r.merge.kind, "merge-commit");
    assert.equal(r.merge.parents, 2);
    assert.equal(r.base.sha, fx.base);
    assert.match(r.diffStat ?? "", /x\.ts/);
    assert.equal(r.workItem.id, "PROJ-42");
    assert.match(r.next[0]!, new RegExp(`worktree add --detach .*replay-pr7-base ${fx.base}`));
    assert.ok(r.next.some((n) => n.includes("ach run --agent")));
  });

  test("squash commit: single parent is the base", async () => {
    const r = await vetPr({ repo: "o/r", number: 8, clone: fx.full }, fetcher(pull({ number: 8, mergeCommitSha: fx.squash }), OK_REVIEW, FILES));
    assert.equal(r.merge.kind, "squash");
    assert.equal(r.base.sha, fx.squashBase);
    // the squash commit touches 1 file but the canned PR lists 4: the mismatch must be flagged
    assert.equal(status(r, "diff-matches"), "warn");
    assert.equal(r.verdict, "warn");
  });

  test("merge commit missing from the clone and every fallback: fail with fetch hint", async () => {
    const r = await vetPr({ repo: "o/r", number: 7, clone: fx.partial }, fetcher(pull({ mergeCommitSha: fx.mergeCommit }), OK_REVIEW, FILES));
    assert.equal(status(r, "merge-commit"), "fail");
    assert.equal(r.verdict, "fail");
    assert.equal(r.merge.clone, null);
    assert.match(r.next[0]!, /fetch origin main/);
  });

  test("fallback clone has it: warn names the fallback to use", async () => {
    const r = await vetPr({ repo: "o/r", number: 7, clone: fx.partial, fallbackClones: [fx.full], minFiles: 2 }, fetcher(pull({ mergeCommitSha: fx.mergeCommit }), OK_REVIEW, MERGE_FILES));
    assert.equal(status(r, "merge-commit"), "warn");
    assert.equal(r.merge.clone, fx.full);
    assert.equal(r.base.clone, fx.partial); // the base itself is in the primary clone
    assert.match(r.diffStat ?? "", /x\.ts/);
    assert.match(r.checks.find((c) => c.id === "merge-commit")!.reason, new RegExp(`use fallback clone ${fx.full.replace(/[/.]/g, "\\$&")}`));
    assert.equal(r.verdict, "warn");
  });

  test("PR-level fails: unmerged, unapproved, feature-branch base, no tests; ticket warn with creation time", async () => {
    const r = await vetPr(
      { repo: "o/r", number: 7, clone: fx.full },
      fetcher(pull({ merged: false, mergedAt: null, baseRef: "release/1", title: "plain", headRef: "x", mergeCommitSha: fx.mergeCommit }), [], ["src/a.ts"]),
    );
    for (const id of ["merged", "approved", "trunk", "tests"]) assert.equal(status(r, id), "fail", id);
    assert.equal(status(r, "size"), "warn");
    assert.equal(status(r, "ticket"), "warn");
    assert.match(r.checks.find((c) => c.id === "ticket")!.reason, /2026-01-01T00:00:00Z/);
    assert.equal(r.workItem.rebuildFromPr, true);
    assert.equal(r.verdict, "fail");
  });

  test("--trunk and --test-regex are honoured", async () => {
    const r = await vetPr(
      { repo: "o/r", number: 7, clone: fx.full, trunk: "release/1", testRegex: "\\.check$", minFiles: 1 },
      fetcher(pull({ baseRef: "release/1", mergeCommitSha: fx.mergeCommit }), OK_REVIEW, ["a.check", "b.ts"]),
    );
    assert.equal(status(r, "trunk"), "pass");
    assert.equal(status(r, "tests"), "pass");
  });

  test("cmdReplay: --json output + exit codes (fail=40, pass=0), no network", async () => {
    const run = async (f: PrFetcher, ...args: string[]) => {
      let out = "";
      const orig = process.stdout.write.bind(process.stdout);
      (process.stdout as any).write = (s: string) => { out += s; return true; };
      try { return { code: await cmdReplay(["vet", "7", "--repo", "o/r", "--clone", fx.full, "--json", ...args], f), out }; }
      finally { process.stdout.write = orig; }
    };
    const ok = await run(fetcher(pull({ mergeCommitSha: fx.mergeCommit }), OK_REVIEW, MERGE_FILES), "--min-files", "2");
    assert.equal(ok.code, REPLAY_VET_EXIT.pass);
    const j = JSON.parse(ok.out);
    assert.deepEqual(Object.keys(j).filter((k) => ["pr", "workItem", "merge", "base", "checks", "verdict", "next"].includes(k)).sort(), ["base", "checks", "merge", "next", "pr", "verdict", "workItem"]);
    const bad = await run(fetcher(pull({ merged: false, mergeCommitSha: null }), OK_REVIEW, FILES));
    assert.equal(bad.code, 40);
    await assert.rejects(() => run(fetcher(pull(), [], []), "--min-files", "x"), /non-negative integer/);
  });

  test("repo is inferred from the clone's origin", async () => {
    sh(fx.full, "remote", "add", "origin", "git@github.com:acme/widgets.git");
    let seen = "";
    const f = fetcher(pull({ mergeCommitSha: fx.mergeCommit }), OK_REVIEW, FILES);
    const spy: PrFetcher = { ...f, pull: async (repo, n) => { seen = repo; return f.pull(repo, n); } };
    const orig = process.stdout.write.bind(process.stdout);
    (process.stdout as any).write = () => true;
    try { await cmdReplay(["vet", "7", "--clone", fx.full], spy); } finally { process.stdout.write = orig; }
    assert.equal(seen, "acme/widgets");
  });

  test("CLI wiring: ach replay vet --help prints the block from the shared USAGE", () => {
    const r = spawnSync("./node_modules/.bin/tsx", ["src/cli/ach.ts", "replay", "vet", "--help"], { encoding: "utf8" });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /ach replay vet <pr-number\|pr-url>/);
  });
});
