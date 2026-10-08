// `ach replay vet <pr>` — one read-only call that vets a merged PR as a replay
// case (agentic-coding-harness#115, part B). It runs the mechanical checks a
// human would otherwise do by hand (merged? approved? trunk? tests? ticket?
// commits present locally?) and prints a draft `{pr, workItem, merge, base}`
// case entry plus the next commands. Nothing is written, fetched or pushed.
// Framework- and repo-agnostic: every heuristic is a flag with a documented
// default. Docs: docs/REPLAY.md.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { parseArgs } from "node:util";
import { HarnessError } from "../core/types.ts";

export type VetStatus = "pass" | "warn" | "fail";

/** Process exit codes: usage / lookup / gh errors exit 1 (HarnessError). */
export const REPLAY_VET_EXIT: Record<VetStatus, number> = { pass: 0, warn: 0, fail: 40 };

export const DEFAULT_MIN_FILES = 3;
/** Matches common test-file paths in any language (directory or filename convention). */
export const DEFAULT_TEST_REGEX =
  "(^|/)(tests?|__tests__|specs?)/|[._-](test|spec)\\.[A-Za-z0-9]+$|(^|/)test_[^/]+\\.py$|_test\\.(go|py|rb)$|Tests?\\.(java|kt|cs|swift)$";
/** Jira-style `ABC-123` or a bare `#123` issue reference. */
export const DEFAULT_TICKET_REGEX = "\\b[A-Z][A-Z0-9]+-\\d+\\b|(?<![\\w&/])#\\d+\\b";

// ---- GitHub data (injectable) ---------------------------------------------

export interface PullData {
  number: number;
  title: string;
  body: string | null;
  htmlUrl?: string;
  merged: boolean;
  mergedAt: string | null;
  createdAt: string;
  baseRef: string;
  headRef: string;
  mergeCommitSha: string | null;
  /** PR head commit and number of commits in the PR (the pulls API's `commits`). */
  headSha?: string;
  commitCount?: number;
  changedFiles: number;
  additions: number;
  deletions: number;
}
export interface ReviewData {
  user: string;
  state: string; // APPROVED | CHANGES_REQUESTED | COMMENTED | DISMISSED | PENDING
  submittedAt?: string;
}

/** Everything vet needs from GitHub. Tests inject canned data; the CLI shells out to `gh`. */
export interface PrFetcher {
  pull(repo: string, number: number): Promise<PullData>;
  reviews(repo: string, number: number): Promise<ReviewData[]>;
  /** Changed file paths (all pages). */
  files(repo: string, number: number): Promise<string[]>;
  defaultBranch(repo: string): Promise<string>;
}

function gh(args: string[]): string {
  const r = spawnSync("gh", args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  if (r.error) throw new HarnessError(`replay vet: cannot run gh (${r.error.message}); install the GitHub CLI and run gh auth login`, "UNAVAILABLE");
  if (r.status !== 0) throw new HarnessError(`replay vet: gh ${args.slice(0, 2).join(" ")} failed: ${(r.stderr || r.stdout).trim().split("\n")[0]}`, "NOT_FOUND");
  return r.stdout;
}

function ndjson<T>(text: string): T[] {
  return text.split("\n").filter((l) => l.trim() !== "").map((l) => JSON.parse(l) as T);
}

/** Fetcher backed by the `gh` CLI (the user's own auth; GH_TOKEN passes through). */
export const ghFetcher: PrFetcher = {
  async pull(repo, number) {
    const p = JSON.parse(gh(["api", `repos/${repo}/pulls/${number}`])) as Record<string, any>;
    return {
      number: p.number,
      title: p.title ?? "",
      body: p.body ?? null,
      htmlUrl: p.html_url,
      merged: p.merged === true,
      mergedAt: p.merged_at ?? null,
      createdAt: p.created_at,
      baseRef: p.base?.ref ?? "",
      headRef: p.head?.ref ?? "",
      mergeCommitSha: p.merge_commit_sha ?? null,
      headSha: p.head?.sha,
      commitCount: p.commits,
      changedFiles: p.changed_files ?? 0,
      additions: p.additions ?? 0,
      deletions: p.deletions ?? 0,
    };
  },
  async reviews(repo, number) {
    const out = gh(["api", "--paginate", `repos/${repo}/pulls/${number}/reviews`, "--jq", ".[] | {user: .user.login, state: .state, submittedAt: .submitted_at}"]);
    return ndjson<ReviewData>(out);
  },
  async files(repo, number) {
    const out = gh(["api", "--paginate", `repos/${repo}/pulls/${number}/files`, "--jq", ".[] | {f: .filename}"]);
    return ndjson<{ f: string }>(out).map((x) => x.f);
  },
  async defaultBranch(repo) {
    return (JSON.parse(gh(["api", `repos/${repo}`])) as { default_branch: string }).default_branch;
  },
};

// ---- git helpers -----------------------------------------------------------

function git(clone: string, args: string[]): { ok: boolean; out: string } {
  const r = spawnSync("git", ["-C", clone, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return { ok: r.status === 0, out: (r.stdout ?? "").trim() };
}

function hasCommit(clone: string, sha: string): boolean {
  return git(clone, ["cat-file", "-e", `${sha}^{commit}`]).ok;
}

/** `[sha, ...parents]` of a commit, or null when it is absent. */
function commitParents(clone: string, sha: string): string[] | null {
  const r = git(clone, ["rev-list", "--parents", "-n", "1", sha]);
  return r.ok && r.out ? r.out.split(/\s+/) : null;
}

/** `owner/name` from a github.com remote URL (https or ssh), else null. */
export function parseGithubRemote(url: string): string | null {
  const m = /github\.com[:/]+([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(url.trim());
  return m ? `${m[1]}/${m[2]}` : null;
}

/** `{repo, number}` from a PR number or a `https://github.com/o/r/pull/N` URL. */
export function parsePrRef(ref: string): { repo?: string; number: number } {
  if (/^\d+$/.test(ref)) return { number: Number(ref) };
  const m = /github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/.exec(ref);
  if (!m) throw new HarnessError(`replay vet: '${ref}' is not a PR number or a github.com pull-request URL`, "USAGE");
  return { repo: m[1], number: Number(m[2]) };
}

// ---- the vet ---------------------------------------------------------------

export interface VetCheck {
  id: string;
  status: VetStatus;
  reason: string;
}

export interface VetOptions {
  repo: string;
  number: number;
  clone: string;
  fallbackClones?: string[];
  trunk?: string;
  minFiles?: number;
  testRegex?: string;
  ticketRegex?: string;
}

export interface VetResult {
  pr: { number: number; repo: string; url?: string; title: string; trunk: string; baseRef: string; headRef: string; createdAt: string; mergedAt: string | null };
  workItem: { id: string | null; source: "title" | "branch" | "body" | null; candidates: string[]; rebuildFromPr: boolean; prCreatedAt: string };
  merge: { sha: string | null; kind: "squash" | "rebase" | "merge-commit" | "unknown"; parents: number | null; clone: string | null };
  base: { sha: string | null; clone: string | null };
  diffStat: string | null;
  checks: VetCheck[];
  verdict: VetStatus;
  next: string[];
}

const RANK: Record<VetStatus, number> = { pass: 0, warn: 1, fail: 2 };
export const worst = (cs: readonly VetCheck[]): VetStatus =>
  cs.reduce<VetStatus>((w, c) => (RANK[c.status] > RANK[w] ? c.status : w), "pass");

/** Latest decisive review per user; approved when any user's last decisive state is APPROVED and none is CHANGES_REQUESTED. */
export function approvalState(reviews: readonly ReviewData[]): { approvers: string[]; blockers: string[] } {
  const last = new Map<string, string>();
  for (const r of reviews) {
    if (r.state === "COMMENTED" || r.state === "PENDING") continue;
    last.set(r.user, r.state);
  }
  const approvers = [...last].filter(([, s]) => s === "APPROVED").map(([u]) => u);
  const blockers = [...last].filter(([, s]) => s === "CHANGES_REQUESTED").map(([u]) => u);
  return { approvers, blockers };
}

export function findTickets(
  parts: { title: string; branch: string; body: string },
  re: RegExp,
): { id: string | null; source: "title" | "branch" | "body" | null; candidates: string[] } {
  const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
  const candidates: string[] = [];
  let first: { id: string; source: "title" | "branch" | "body" } | null = null;
  for (const source of ["title", "branch", "body"] as const) {
    for (const m of parts[source].matchAll(g)) {
      if (!candidates.includes(m[0])) candidates.push(m[0]);
      first ??= { id: m[0], source };
    }
  }
  return { id: first?.id ?? null, source: first?.source ?? null, candidates };
}

export async function vetPr(opts: VetOptions, fetcher: PrFetcher): Promise<VetResult> {
  const { repo, number, clone } = opts;
  const minFiles = opts.minFiles ?? DEFAULT_MIN_FILES;
  const testRe = new RegExp(opts.testRegex ?? DEFAULT_TEST_REGEX, "i");
  const ticketRe = new RegExp(opts.ticketRegex ?? DEFAULT_TICKET_REGEX);
  const pull = await fetcher.pull(repo, number);
  const [reviews, files, trunk] = await Promise.all([
    fetcher.reviews(repo, number),
    fetcher.files(repo, number),
    opts.trunk !== undefined ? Promise.resolve(opts.trunk) : fetcher.defaultBranch(repo),
  ]);
  const checks: VetCheck[] = [];
  const add = (id: string, status: VetStatus, reason: string) => checks.push({ id, status, reason });

  // merged
  if (pull.merged) add("merged", "pass", `merged at ${pull.mergedAt ?? "unknown time"}`);
  else add("merged", "fail", "PR is not merged; there is no merge commit to replay against");

  // approved
  const { approvers, blockers } = approvalState(reviews);
  if (blockers.length > 0) add("approved", "fail", `changes requested by ${blockers.join(", ")} and not re-reviewed`);
  else if (approvers.length > 0) add("approved", "pass", `approved by ${approvers.join(", ")}`);
  else add("approved", "fail", "no approving review");

  // trunk
  if (pull.baseRef === trunk) add("trunk", "pass", `merged into trunk '${trunk}'`);
  else add("trunk", "fail", `merged into '${pull.baseRef}', not trunk '${trunk}' (feature-branch merges make poor cases; pass --trunk if '${pull.baseRef}' is your trunk)`);

  // size
  const fileCount = files.length > 0 ? files.length : pull.changedFiles;
  if (fileCount >= minFiles) add("size", "pass", `${fileCount} files changed (threshold ${minFiles})`);
  else add("size", "warn", `${fileCount} files changed, below threshold ${minFiles}`);

  // tests
  const testFiles = files.filter((f) => testRe.test(f));
  if (testFiles.length > 0) add("tests", "pass", `${testFiles.length} test file(s), e.g. ${testFiles.slice(0, 3).join(", ")}`);
  else add("tests", "fail", `no changed file matches the test regex /${testRe.source}/: no answer key`);

  // ticket
  const tk = findTickets({ title: pull.title, branch: pull.headRef, body: pull.body ?? "" }, ticketRe);
  if (tk.id !== null) {
    add("ticket", "pass", `'${tk.id}' found in ${tk.source}${tk.candidates.length > 1 ? ` (also: ${tk.candidates.filter((c) => c !== tk.id).join(", ")})` : ""}`);
  } else {
    add("ticket", "warn", `no ticket id in title, body or branch '${pull.headRef}': rebuild the ticket from the PR as first opened (created ${pull.createdAt})`);
  }

  // commits in local clone(s)
  const clones = [clone, ...(opts.fallbackClones ?? [])];
  const mergeSha = pull.mergeCommitSha;
  let mergeClone: string | null = null;
  let baseClone: string | null = null;
  let parents: string[] | null = null;
  let baseSha: string | null = null;
  let kind: VetResult["merge"]["kind"] = "unknown";
  if (!mergeSha) {
    add("merge-commit", "fail", "GitHub reports no merge_commit_sha");
  } else {
    mergeClone = clones.find((c) => hasCommit(c, mergeSha)) ?? null;
    if (mergeClone === null) {
      add("merge-commit", "fail", `merge commit ${mergeSha.slice(0, 12)} is not in ${clones.length > 1 ? "any of the given clones" : "the clone"}: fetch the trunk branch (git -C ${clone} fetch origin ${trunk})`);
    } else {
      add("merge-commit", mergeClone === clone ? "pass" : "warn", mergeClone === clone ? `${mergeSha.slice(0, 12)} present in ${clone}` : `${mergeSha.slice(0, 12)} missing from ${clone}; use fallback clone ${mergeClone}`);
      parents = commitParents(mergeClone, mergeSha);
      const n = parents ? parents.length - 1 : 0;
      kind = n === 1 ? "squash" : n >= 2 ? "merge-commit" : "unknown";
      baseSha = parents && parents.length > 1 ? parents[1]! : null;
      if (n === 1) {
        // One parent: squash or rebase. A single-commit PR cannot be told apart (both give one
        // commit with the PR's content). With >1 commits and the PR head present locally, compare
        // the merge commit with the head (below).
        const commits = pull.commitCount ?? 0;
        const treeOf = (c: string, r: string) => git(c, ["rev-parse", `${r}^{tree}`]);
        const headTree = commits > 1 && pull.headSha && hasCommit(mergeClone, pull.headSha) ? treeOf(mergeClone, pull.headSha) : null;
        if (commits > 1 && headTree?.ok) {
          // A squash on an unchanged trunk also has the head's tree, so the tree alone proves
          // nothing: a rebase additionally keeps the commit's author date and subject; GitHub's
          // squash commit gets a fresh author date and the PR title as subject.
          const stamp = (r: string) => git(mergeClone!, ["log", "-1", "--format=%at%x00%s", r]).out;
          const same = headTree.out === treeOf(mergeClone, mergeSha).out && stamp(mergeSha) === stamp(pull.headSha!);
          kind = same ? "rebase" : "squash";
          if (same) {
            // N rebased commits sit on trunk: the real base is the commit before the first of them.
            const b = git(mergeClone, ["rev-parse", `${mergeSha}~${commits}`]);
            if (b.ok) baseSha = b.out;
          }
          add("merge-kind", "pass", same ? `single parent and ${commits} PR commits whose head tree, author date and subject equal the merge commit's: rebase merge; base is ${commits} commits before the merge commit` : `single parent and ${commits} PR commits collapsed into one: squash merge; base is that parent`);
        } else {
          add("merge-kind", "pass", `single parent: squash${commits > 1 ? " or rebase (PR head commit not in the clone, so they cannot be told apart)" : " (or a single-commit rebase)"}; base is that parent`);
        }
      }
      else if (n >= 2) add("merge-kind", "pass", `${n} parents: merge commit; base is the first parent (trunk before the merge)`);
      else add("merge-kind", "warn", "merge commit has no parent (root commit); cannot derive a base");
      if (baseSha !== null) {
        baseClone = clones.find((c) => hasCommit(c, baseSha!)) ?? null;
        if (baseClone === null) add("base-commit", "fail", `base ${baseSha.slice(0, 12)} (first parent) is in none of the clones: fetch the branch it was on (release-branch bases are missed by default-branch-only clones)`);
        else add("base-commit", baseClone === clone ? "pass" : "warn", baseClone === clone ? `${baseSha.slice(0, 12)} present in ${clone}` : `${baseSha.slice(0, 12)} missing from ${clone}; use fallback clone ${baseClone}`);
      }
    }
  }

  // diff stat
  let diffStat: string | null = null;
  if (mergeClone && baseSha && mergeSha) {
    // a clone holding the merge commit holds its parents too
    const d = git(mergeClone, ["diff", "--stat", baseSha, mergeSha]);
    diffStat = d.ok ? d.out : null;
    // The local merge commit must be the change GitHub reported; a rewritten or
    // re-pointed history shows up as a different file count.
    const names = git(mergeClone, ["diff", "--name-only", baseSha, mergeSha]);
    if (names.ok) {
      const local = names.out === "" ? 0 : names.out.split("\n").length;
      if (local === fileCount) add("diff-matches", "pass", `local base..merge diff touches ${local} files, same as the PR`);
      else add("diff-matches", "warn", `local base..merge diff touches ${local} files but the PR lists ${fileCount}: the clone's history may differ from what GitHub merged (rewritten history?)`);
    }
  }

  // next commands
  const next: string[] = [];
  const useClone = baseClone ?? mergeClone;
  if (useClone && baseSha) {
    const dir = path.resolve(useClone, "..", `replay-pr${number}-base`);
    next.push(`git -C ${useClone} worktree add --detach ${dir} ${baseSha}`);
    next.push(`cd ${dir} && ach run --agent <agent> "$(cat ticket-${number}.md)"   # write the ticket text to ticket-${number}.md first`);
    if (mergeSha) next.push(`git -C ${useClone} diff --stat ${baseSha} ${mergeSha}   # the human answer key`);
  } else if (mergeSha) {
    next.push(`git -C ${clone} fetch origin ${trunk}   # then re-run: ach replay vet ${number}`);
  }
  if (tk.id === null) next.push(`# no ticket id: write ticket-${number}.md from the PR as first opened (${pull.createdAt}); gh api repos/${repo}/issues/${number}/events lists later edits`);

  return {
    pr: { number, repo, url: pull.htmlUrl, title: pull.title, trunk, baseRef: pull.baseRef, headRef: pull.headRef, createdAt: pull.createdAt, mergedAt: pull.mergedAt },
    workItem: { id: tk.id, source: tk.source, candidates: tk.candidates, rebuildFromPr: tk.id === null, prCreatedAt: pull.createdAt },
    merge: { sha: mergeSha, kind, parents: parents ? parents.length - 1 : null, clone: mergeClone },
    base: { sha: baseSha, clone: baseClone },
    diffStat,
    checks,
    verdict: worst(checks),
    next,
  };
}

// ---- CLI -------------------------------------------------------------------

export const REPLAY_VET_USAGE = `usage:
  ach replay vet <pr-number|pr-url> [--repo owner/name] [--clone PATH=.] [--fallback-clone PATH]...
                 [--trunk BRANCH=repo default] [--min-files N=${DEFAULT_MIN_FILES}] [--test-regex RE] [--ticket-regex RE] [--json]
                (read-only replay-case vetting (#115): merged, approved, trunk, size, tests, ticket,
                 merge+base commits in the clone (or a fallback), squash vs merge, diff stat, then the
                 next commands; uses the gh CLI. exit 0 pass/warn, 40 fail, 1 usage/gh error; docs/REPLAY.md)`;

export function formatVetText(v: VetResult): string {
  const mark: Record<VetStatus, string> = { pass: "PASS", warn: "WARN", fail: "FAIL" };
  const L: string[] = [];
  L.push(`PR #${v.pr.number} ${v.pr.repo}: ${v.pr.title}`);
  L.push(`verdict: ${mark[v.verdict]}`);
  for (const c of v.checks) L.push(`  [${mark[c.status]}] ${c.id}: ${c.reason}`);
  if (v.diffStat) L.push("", "diff stat (base..merge):", ...v.diffStat.split("\n").map((l) => `  ${l}`));
  L.push("", "draft case entry:", JSON.stringify({ pr: v.pr.number, workItem: v.workItem.id ?? { rebuildFromPr: true, prCreatedAt: v.workItem.prCreatedAt }, merge: v.merge.sha, base: v.base.sha }, null, 2));
  if (v.next.length > 0) L.push("", "next:", ...v.next.map((n) => `  ${n}`));
  return L.join("\n") + "\n";
}

export async function cmdReplay(rest: string[], fetcher: PrFetcher = ghFetcher): Promise<number> {
  const [sub, ...args] = rest;
  if (sub === undefined || sub === "-h" || sub === "--help") {
    process.stdout.write(REPLAY_VET_USAGE + "\n");
    return sub === undefined ? 1 : 0;
  }
  if (sub !== "vet") throw new HarnessError(`replay: unknown subcommand '${sub}' (expected 'vet')`, "USAGE");
  const a = parseArgs({
    args,
    options: {
      repo: { type: "string" },
      clone: { type: "string" },
      "fallback-clone": { type: "string", multiple: true },
      trunk: { type: "string" },
      "min-files": { type: "string" },
      "test-regex": { type: "string" },
      "ticket-regex": { type: "string" },
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    allowPositionals: true,
  });
  if (a.values.help) {
    process.stdout.write(REPLAY_VET_USAGE + "\n");
    return 0;
  }
  if (a.positionals.length !== 1) throw new HarnessError("replay vet expects exactly one <pr-number|pr-url>", "USAGE");
  const ref = parsePrRef(a.positionals[0]!);
  const clone = path.resolve(a.values.clone ?? ".");
  let repo = a.values.repo ?? ref.repo;
  if (repo === undefined) {
    const url = git(clone, ["remote", "get-url", "origin"]);
    repo = url.ok ? (parseGithubRemote(url.out) ?? undefined) : undefined;
  }
  if (repo === undefined) throw new HarnessError("replay vet: cannot infer the repo; pass --repo owner/name (or run in a clone whose origin is on github.com)", "USAGE");
  let minFiles: number | undefined;
  if (a.values["min-files"] !== undefined) {
    minFiles = Number(a.values["min-files"]);
    if (!Number.isInteger(minFiles) || minFiles < 0) throw new HarnessError(`--min-files expects a non-negative integer, got '${a.values["min-files"]}'`, "USAGE");
  }
  for (const f of ["test-regex", "ticket-regex"] as const) {
    try {
      if (a.values[f] !== undefined) new RegExp(a.values[f]!);
    } catch (e) {
      throw new HarnessError(`--${f} is not a valid regular expression: ${(e as Error).message}`, "USAGE");
    }
  }
  const v = await vetPr(
    {
      repo,
      number: ref.number,
      clone,
      fallbackClones: (a.values["fallback-clone"] ?? []).map((p) => path.resolve(p)),
      trunk: a.values.trunk,
      minFiles,
      testRegex: a.values["test-regex"],
      ticketRegex: a.values["ticket-regex"],
    },
    fetcher,
  );
  process.stdout.write(a.values.json ? JSON.stringify(v, null, 2) + "\n" : formatVetText(v));
  return REPLAY_VET_EXIT[v.verdict];
}
