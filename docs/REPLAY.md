# Replay case vetting: `ach replay vet`

Picking a merged PR as a replay case ("run the agent on the ticket, compare with what the
humans merged") is mostly mechanical checking. `ach replay vet <pr>` does those checks in one
read-only call and prints a draft case entry plus the next commands (agentic-coding-harness#115).
It is repo- and framework-agnostic: every heuristic is a flag with a documented default.

```
ach replay vet <pr-number|pr-url> [--repo owner/name] [--clone PATH=.] [--fallback-clone PATH]...
               [--trunk BRANCH] [--min-files N=3] [--test-regex RE] [--ticket-regex RE] [--json]
```

GitHub data comes from the `gh` CLI (`gh api repos/{o}/{r}/pulls/{n}`, `/reviews`, `/files`,
paginated), so your own `gh auth` (or `GH_TOKEN`) applies. Git checks run read-only against
`--clone` (default: the current directory). `--repo` defaults to the PR URL's repo, else the
clone's `origin` remote. Nothing is fetched, written or pushed.

## Checks

Each check is `pass`, `warn` or `fail`; the verdict is the worst of them.

| check | pass | warn | fail |
|---|---|---|---|
| `merged` | PR merged | | not merged |
| `approved` | an approving review, latest per reviewer, none blocking | | no approval, or changes requested and not re-reviewed |
| `trunk` | base branch equals `--trunk` (default: the repo's default branch) | | merged into any other branch |
| `size` | changed files >= `--min-files` | fewer files | |
| `tests` | a changed path matches `--test-regex` | | none: there is no answer key |
| `ticket` | an id matched in the title, branch name or body (that order) | none found: rebuild the ticket from the PR as first opened; the PR creation time is printed | |
| `merge-commit` | `merge_commit_sha` is in `--clone` | only in a `--fallback-clone`: the message says which one to use | in no clone: fetch the trunk branch |
| `merge-kind` | two or more parents: **merge commit**, base = first parent. One parent: **squash**, base = that parent; or **rebase** (multi-commit PR whose head commit is in the clone and has the same tree, author date and subject as the merge commit), base = the merge commit minus N commits. A single-commit PR, or a head commit missing from the clone, cannot be told squash from rebase and is reported as `squash` with that caveat | root commit, no base | |
| `base-commit` | the first parent is in `--clone` | only in a fallback clone | in no clone (clones that only fetched the default branch miss release-branch bases) |
| `diff-matches` | `git diff base merge` touches as many files as the PR lists | counts differ: the clone's history may not be what GitHub merged | |

Defaults (documented, overridable):

- `--test-regex` (case-insensitive): `(^|/)(tests?|__tests__|specs?)/|[._-](test|spec)\.[A-Za-z0-9]+$|(^|/)test_[^/]+\.py$|_test\.(go|py|rb)$|Tests?\.(java|kt|cs|swift)$`
- `--ticket-regex`: `\b[A-Z][A-Z0-9]+-\d+\b|(?<![\w&/])#\d+\b` (Jira-style `ABC-123` or `#123`). It is
  deliberately generic, so a body can match noise such as `UTF-8`; the JSON `workItem.candidates`
  lists every match so you can pick, or pass a stricter regex such as `--ticket-regex 'PROJ-\d+'`.
- `--min-files`: 3.

## Exit codes

| code | meaning |
|---|---|
| 0 | pass or warn |
| 40 | at least one check failed |
| 1 | usage error, `gh` missing or failing, PR not found |

(The `10/11/20/30` ladder in [EXIT-CODES.md](EXIT-CODES.md) is for `run`/reporting commands; 40 is
used here so a fail never collides with it.)

## `--json` schema

```json
{
  "pr": { "number": 7, "repo": "o/r", "url": "...", "title": "...", "trunk": "main", "baseRef": "main",
          "headRef": "feat/x", "createdAt": "ISO", "mergedAt": "ISO|null" },
  "workItem": { "id": "PROJ-42|null", "source": "title|branch|body|null", "candidates": ["PROJ-42"],
                "rebuildFromPr": false, "prCreatedAt": "ISO" },
  "merge": { "sha": "...", "kind": "squash|rebase|merge-commit|unknown", "parents": 1, "clone": "path|null" },
  "base": { "sha": "first parent|null", "clone": "path|null" },
  "diffStat": "git diff --stat output|null",
  "checks": [ { "id": "tests", "status": "pass|warn|fail", "reason": "..." } ],
  "verdict": "pass|warn|fail",
  "next": ["git -C <clone> worktree add --detach <dir> <base>", "..."]
}
```

`{pr, workItem, merge, base}` is the draft case entry. `merge.clone` / `base.clone` say which clone
holds each commit; use that clone for the worktree.

## Example

```
$ ach replay vet 42 --clone ~/src/app --fallback-clone ~/src/app-all-branches
PR #42 acme/app: PROJ-17 retry failed webhooks
verdict: WARN
  [PASS] merged: merged at 2026-03-02T10:00:00Z
  [PASS] approved: approved by bob
  [PASS] trunk: merged into trunk 'main'
  [PASS] size: 6 files changed (threshold 3)
  [PASS] tests: 2 test file(s), e.g. tests/webhook.test.ts
  [PASS] ticket: 'PROJ-17' found in title
  [WARN] merge-commit: 3f2a9c1d0e4b missing from ~/src/app; use fallback clone ~/src/app-all-branches
  ...
next:
  git -C ~/src/app-all-branches worktree add --detach ~/src/replay-pr42-base <base-sha>
  cd ~/src/replay-pr42-base && ach run --agent <agent> "$(cat ticket-42.md)"
```

Implementation: `src/cli/replay-vet.ts` (the GitHub fetcher is an injectable interface; tests use
canned JSON and temporary git repositories, no network).
