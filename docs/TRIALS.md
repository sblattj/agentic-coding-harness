# Trials: verified outcomes, repeats, and pass@k

`ach` records whether a run *finished* (`exitStatus`). Three features add
whether it *worked*, and how confident you should be about that:

| Flag / command | Issue | What it records |
|---|---|---|
| `ach run --verify '<cmd>'` | #29 | runs a checker in the run's cwd after the agent exits; the verdict lands on the RunRecord as `verify` |
| `ach run --repeat N [--parallel K]` | #57 | N fresh sessions of the same prompt, tagged with one shared `repeat.group` |
| `/compare`, `ach report`, `ach stats` | #30 | pass@1 with a Wilson 95% interval, pass^k, and any-pass@k per group |
| `ach regrade <run-id> --verify '<cmd>'` | #89 | re-runs a checker against a saved run without launching the agent |
| `ach trial --matrix plan.json` | #56 | a resumable agents × tasks × models × trials grid; one run per cell, tagged `experiment`, `variant`, `cellId` |

## `--verify`: outcome scoring

```sh
ach run --agent claude --verify 'npm test' "fix the failing test"
```

After the agent exits, the harness runs `/bin/sh -c '<cmd>'` in the run's
cwd. The checker inherits the harness environment. The result is recorded as:

```json
"verify": {
  "command": "npm test",
  "exitCode": 1,
  "status": "fail",
  "durationMs": 5321,
  "timedOut": false,
  "outputTail": "…last 4000 characters of stdout+stderr…",
  "at": 1790571498067
}
```

- `status` is `pass` for exit 0, `fail` for a non-zero exit, and `error` when
  the checker never finished. That covers a timeout, a kill signal, and a
  missing cwd. A checker that runs longer than `--verify-timeout-ms`
  (default 120000) has its whole process group killed and is recorded as
  `status: "error", timedOut: true`.
- The agent's own `exitStatus`/`status` is **never** changed by the checker.
- The CLI exit code is 0 only when the agent succeeded **and** the checker
  passed. A run without `--verify` behaves exactly as before: the record has
  no `verify` key and the exit code rules are unchanged.
- `--json` adds the same `verify` object next to the RunResult fields.
- `ach dash` shows the verdict as the second STATUS character. With color it
  is ✓ / ✗ / ?. Without color it is `p` / `f` / `e`.

## `--repeat N`: repeat groups

```sh
ach run --agent claude --repeat 5 --experiment fix-auth --variant baseline \
        --verify 'npm test' "fix the failing test"
```

- Every child is a brand-new agent session with a new run id. There is no
  conversation carry-over, and `--repeat` with `--resume` is a usage error.
- Each child record carries `repeat: {group, index, count}` (0-based index).
  `--experiment`/`--variant` set the compare-view labels on every child.
- Children run one at a time by default. `--parallel K` caps how many agent
  processes run at once.
- A child that fails or cannot launch does not stop the rest. The group exits
  0 only when every child passed the gate described above.
- Each child's record is written when that child settles. If you interrupt
  the group, the children that already finished stay on disk with their
  `repeat` labels, and `ach stats` and `/compare` still read them.

Sample output: three repeats against a checker that fails once. The fake
agent reports no token counts, so the token and cost fields show `n/a`.

```text
--- repeat 1/3 (da4a807c)
sessionId  sess-51678
tokens     input=n/a output=n/a cacheRead=n/a cacheWrite=n/a reasoning=n/a
cost       n/a
duration   0.2s
exit       success
verify     pass (exit 0, 0.2s)
--- repeat 2/3 (da4a807c)
…
verify     fail (exit 1, 0.0s)
--- repeat 3/3 (da4a807c)
…
verify     pass (exit 0, 0.0s)
--- group da4a807c-b033-430d-bd3e-9eea7e5dcdf1
repeat     3 attempted · 3 succeeded · 2/3 verified pass
stats      pass@1=66.7% [20.8%–93.9%] pass^3=0.0% any-pass@3=100.0%
```

### `ach stats`: per-group rollup

```text
$ ach stats --state-only
totals    records=0 input=0 output=0 cacheRead=0 cacheWrite=0 reasoning=0 cost=$0.0000
repeat    da4a807c agent=kiro experiment=demo variant=baseline runs=3/3 succeeded=3 pass=2/3 pass@1=66.7% [20.8%–93.9%] pass^3=0.0% any-pass@3=100.0% cost=n/a mean=n/a
```

`--json` adds a `byRepeatGroup` array, but only when a repeat group exists:

```json
{
  "group": "da4a807c-b033-430d-bd3e-9eea7e5dcdf1",
  "agent": "kiro", "experiment": "demo", "variant": "baseline",
  "count": 3, "runs": 3, "succeeded": 3, "verified": 3, "passed": 2,
  "stats": { "k": 3, "passes": 2, "passAt1": 0.6667, "passHatK": 0, "anyPassAtK": 1,
             "wilsonLo": 0.2077, "wilsonHi": 0.9385 },
  "startedAt": 1790571498067
}
```

`totalCostUsd` and `meanCostUsd` are left out when any member's USD cost is
unknowable (for example kiro, which reports credits only). The text line
shows them as `n/a`.

### `ach report`

`ach run --repeat N --json > trials/<ts>/<agent>.json` writes one envelope,
`{repeat, stats?, runs: [...]}`. `ach report` loads every child in it as a
separate run. When any run carries a verdict, the comparison table gains a
`verify` column, and a **repeat statistics** table is added. It is grouped
by variant, or by agent when no run has a variant:

| variant | k | passes | pass@1 | Wilson 95% CI | pass^k | any-pass@k |
|---|---|---|---|---|---|---|
| baseline | 3 | 2 | 66.7% | 20.8% – 93.9% | 0.0% | 100.0% |

## The statistics (`src/core/repeat-stats.ts`)

For a cell with n verified runs and c passes (k = n):

- **pass@1** = c / n.
- **Wilson 95% interval** on pass@1, from Wilson (1927) and Newcombe (1998),
  "method 3". Unlike the Wald interval it stays inside [0, 1] and is honest
  at small n. Two reference values: 8/10 gives [0.4902, 0.9433], and 81/263
  gives [0.2553, 0.3662].
- **pass^k** = C(c, k) / C(n, k), the τ-bench consistency metric. With k = n
  it is 1 only if every repeat passed.
- **any-pass@k** = 1 − C(n − c, k) / C(n, k). This is the unbiased HumanEval
  pass@k estimator from Chen et al. (2021). With k = n it is 1 if any repeat
  passed.

Honesty rules:

- A cell with k = 1 shows pass@1 only. It never shows a degenerate interval,
  and the other columns read `n/a`.
- A cell with no verdicts has no `passRate` or `repeats` keys at all. It is
  shown as `n/a`, never as 0%.
- A verifier `error` counts as not passed.
- Regrades never change these numbers. They always use the run-time verdict.

`/api/compare` rows gain `passRate` and
`repeats: {k, passes, passAt1, passHatK?, anyPassAtK?, wilsonLo?, wilsonHi?}`.
Issue #30 sketched this field as `passAtK`. It is named `passHatK` here
because it means *all k passed* (pass^k), and that is easy to confuse with
the HumanEval pass@k, which is `anyPassAtK`.

## `ach regrade`: re-score without rerunning

```sh
ach regrade <run-id> --verify './check-v2.sh' [--verify-timeout-ms MS] [--json]
```

This runs the new checker in the run's recorded cwd. It adds the verdict to
the record's `regrades` array. The run-time `verify`, the event transcript,
and the agent are all left alone, and no tokens are spent.

**Limitation:** the harness does not snapshot workspaces, so a regrade
grades the workspace as it is *now*. If the cwd has been deleted, the
command fails with a clear error. If the cwd has changed since the run, the
regrade measures the new state.

### Evolving a verifier while retaining the original score

For example, save a run with a first checker, then tighten its requirements:

```sh
ach run --agent claude --verify './check-v1.sh' --json 'implement the feature' > trials/demo/claude.json
ach regrade <run-id> --verifier './check-v2.sh'
ach regrade <run-id> --verifier './check-v2.sh'
ach report trials/demo --out report.html
```

Create `trials/demo` before redirecting output. `--verifier` is an alias for
`--verify`; both accept a shell command. The report joins trial results to the
local registry by run ID and displays the original verdict followed by every
regrade, including the checker command and timestamp. Use the same
`AGENTIC_CODING_HARNESS_STATE_DIR` for the run, regrades, and report. Original
trial JSON stays unchanged; keep the registry to retain later scores. Web run
metadata shows the same history; dash summarizes the latest regrade.

A v1 pass and a v2 fail coexist. Running a deterministic v2 checker twice on
an unchanged workspace yields the same verdict and exit code; timestamps and
execution durations naturally differ. Regrades launch only your checker, not
an agent. Harness regrading itself consumes no model tokens, but a checker
that calls a paid API can incur its own costs. JSON/LLM rubric execution is
not built in: encode your evolved rubric in the verifier script. The checker
reads the current workspace, not a restored historical snapshot.

## `ach trial --matrix`: resumable trial grids

```sh
ach trial --matrix plan.json [--dry-run] [--retry-failed] [--ledger PATH] [--json]
```

A plan declares agents × tasks × models × trials per cell. Every cell becomes
one child run through the same path as `ach run --verify --experiment
--variant`, and is labelled on its RunRecord with:

- `experiment`: the plan's `experiment`
- `variant`: the plan's `variant` template (default `{agent}:{model}`)
- `cellId`: `agent:task:model:trialN`. The model is `default` when the plan
  gives none, and `N` starts at 1.

`/api/compare?by=experiment,variant` and `ach report` group matrix runs with
no extra configuration.

```json
{
  "experiment": "fix-bug-sweep",
  "agents": ["claude", { "agent": "codex", "models": ["gpt-5-codex"] }],
  "models": ["claude-sonnet-5-5", "claude-opus-5-5"],
  "trials": 3,
  "tasks": [
    { "id": "fix-bug", "prompt": "Fix the failing test in src/math.ts", "cwd": "./repo", "verify": "npm test" },
    { "dir": "tasks/add-endpoint" }
  ],
  "budget": { "usd": 2, "wallMs": 900000 }
}
```

### The ledger and resume

One append-only JSONL ledger sits next to the plan (`plan.json` →
`plan.ledger.jsonl`; `--ledger` overrides it). It holds one row per cell
attempt:

```json
{"v":1,"cellId":"claude:fix-bug:claude-sonnet-5-5:trial1","experiment":"fix-bug-sweep","variant":"claude:claude-sonnet-5-5","agent":"claude","task":"fix-bug","model":"claude-sonnet-5-5","trial":1,"status":"passed","runId":"0dbcb142-0c07-478f-b5b2-24cd851ca0b6","exitStatus":"success","verify":"pass","startedAt":1790000000000,"endedAt":1790000042000}
```

A row is appended only after the cell's run is finalized, meaning the
driver's final registry write and the label and verify annotation are done.
If the runner is killed mid-cell, that cell has no row and stays pending.

#### Cell outcomes

Each finalized attempt gets one of four statuses (`classifyCell` in
`src/cli/trial-matrix.ts`). A verify failure is a *result*; only an
infrastructure failure is an *error*:

| Status | When | On re-run | `--retry-failed` |
|---|---|---|---|
| `passed` | `exitStatus` is `success` and the checker passed (or the task has no checker) | skipped | skipped |
| `verify-failed` | `exitStatus` is `success` and the checker failed, **or** the harness stopped the agent at a plan budget cap (`budget_exceeded`, `turn_limit`) | skipped | **skipped — never retried** |
| `error` | setup failed; the agent exited `error`, `timeout`, `aborted` or `cancelled`; the checker could not finish (verify `error`, e.g. it timed out); or the launch threw | reported, not re-run | re-run |
| `skipped-unavailable` | the agent CLI is missing or could not start (`exitStatus: "unavailable"`, see `src/core/availability.ts`) | run again | run again |

- A `verify-failed` cell is never retried. Retrying it would give an agent that
  failed the task more tries until it passes, which inflates the pass rate.
  Budget stops count here too, since the harness stopped the agent on purpose.
  It did not crash.
- `skipped-unavailable` carries no verdict about the task and is never counted
  as a failure. Once the CLI is installed, the next invocation runs the cell.
- A retry appends a new row, so the ledger keeps every attempt. The last row
  for each `cellId` decides.
- A torn final line from a crash mid-append is ignored with a warning.

**Older ledgers.** Ledgers written before this split used `completed` and
`failed`. They are still read, and mapped when read (the file is not
rewritten):

| Old row | Read as |
|---|---|
| `completed` | `passed` |
| `failed`, `exitStatus: "success"`, `verify: "fail"` | `verify-failed` |
| `failed`, `exitStatus: "budget_exceeded"` or `"turn_limit"` | `verify-failed` |
| `failed`, `exitStatus: "unavailable"` | `skipped-unavailable` |
| any other `failed` (including `runId: null`, a setup failure or a throw) | `error` |

A legacy `failed` row is never read as `passed`.

#### Output and exit code

`--dry-run` prints every cell with `run`, `skip`, or `ERR ` (an error
earlier, not retried). It reads the ledger but launches nothing and writes
nothing.

Each run prints a line for every cell of the plan. Cells whose status comes
from an earlier invocation say `… earlier`. The run ends with:

```text
summary    9 cells · passed=5 verify-failed=3 error=1 skipped=0 · ran=6 resumed=3
```

The counts cover the whole plan, whether a cell ran now or was resumed from
the ledger. `skipped` means `skipped-unavailable`. `ran` counts the cells this
invocation attempted, and `resumed` counts the cells taken from the ledger.
`--json` prints the same counts as `summary: {total, passed, verifyFailed, error,
skipped, pending, ran, resumed, interrupted}`.

**Exit code:** 1 when any cell is `error` after the run, or the run was
interrupted. Otherwise it is 0, even when cells are `verify-failed` or
`skipped-unavailable`. Verify failures are data, not harness errors. Read
them from the summary, the ledger or the report.

Cells run one at a time, in agent → task → model → trial order.

### Plan schema

The zod source of truth is `MatrixPlanSchema` in `src/cli/trial-matrix.ts`.
Unknown keys are rejected.

| Key | Type | Meaning |
|---|---|---|
| `experiment` | string, required | compare-view experiment label on every run |
| `agents` | `(string \| {agent, models?})[]`, ≥1 | built-in or agents.d names. A per-agent `models` list replaces the plan-level list for that agent. `custom` is rejected because it needs `--template`. |
| `tasks` | task[], ≥1 | inline task or task directory (below) |
| `models` | string[]? | crossed with every agent that has no own list. Omitted means the adapter default (`default` in the cellId). A literal `"default"` also means no `--model`. |
| `trials` | int ≥1, default 1 | fresh sessions per cell |
| `variant` | string, default `{agent}:{model}` | template; placeholders `{agent}` `{model}` `{task}` |
| `budget` | `{usd?, maxTurns?, wallMs?, idleMs?}` | per-run caps, as the `ach run` flags |
| `cwd` | string? | default agent cwd for shared-workspace tasks, relative to the plan's directory (default: that directory) |
| `setupTimeoutMs` / `verifyTimeoutMs` | int? | plan-level defaults (300000 / 120000) |

**Inline task:** `{id, prompt, cwd?, setup?, verify?, workspace?, setupTimeoutMs?, verifyTimeoutMs?}`.
- `id` must match `[A-Za-z0-9._-]+`, with no `:` because `:` separates the
  parts of a cellId.
- `setup` and `verify` are shell commands (`/bin/sh -c`).
- `workspace` defaults to `"shared"`: the agent runs in `cwd`.

**Task directory:** `{dir, id?, workspace?, setupTimeoutMs?, verifyTimeoutMs?}`,
with `dir` relative to the plan's directory:

| File | Required | Use |
|---|---|---|
| `task.md` | yes | the prompt |
| `setup.sh` | no | run as `sh <abs path>` before the agent |
| `verify.sh` | no | the checker, run after the agent |
| `meta.json` | no | `{id?, description?, workspace?, setupTimeoutMs?, verifyTimeoutMs?, ...}`; unknown keys such as `suites` or `tags` are kept |

- The task id is the first one set among the plan's `id`, meta.json `id`, and
  the directory name.
- `workspace` defaults to `"fresh"`: each cell gets an emptied directory at
  `<ledger name>.work/<cellId>-<hash>/`, which is `<plan>.work/…` with the
  default ledger path.

`setup` and `verify` run in the cell's workspace with the environment
variables `ACH_CELL_ID`, `ACH_EXPERIMENT`, `ACH_VARIANT`, `ACH_AGENT`,
`ACH_MODEL`, `ACH_TASK_ID`, `ACH_TRIAL`, `ACH_WORKSPACE`, and `ACH_TASK_DIR`
(task directories only). If setup exits non-zero, the cell is an `error` with
`runId: null`, and no agent is launched.

### Building on it in code (task suites)

`src/cli/trial-matrix.ts` exports the pieces a suite runner composes:

| Export | Use |
|---|---|
| `loadTaskDir(dir)` | resolve one task directory into a `ResolvedTask` |
| `parseMatrixPlan(obj)` | validate a plan built in code |
| `expandMatrix(plan, baseDir)` | expand a plan into its `MatrixCell` list |
| `executeMatrixCli({plan, baseDir, ledgerPath, dryRun, retryFailed, json})` | the whole CLI behaviour: dry-run, driver, per-cell lines, summary, exit code |
| `runMatrix` | the programmatic runner; takes an injectable driver and an `AbortSignal` |
| `readLedger` | read the ledger |
| `planStatus` | decide each cell's action from the ledger |
| `createMatrixDriver` | build the driver for the plan's agents |

For example, a suite is a plan whose `tasks` are `{dir}` entries.
`ach trial --suite` (below) is exactly that.

## Hermetic trials: ancestor instruction files (#106)

A benchmark cell whose workspace sits under `$HOME` can silently load `~/CLAUDE.md`, or
any `CLAUDE.md` / `CLAUDE.local.md` in an ancestor directory, as project memory. For
codex and gemini the same applies to `AGENTS.md` / `GEMINI.md` up to the git root. The
cell then measures your instructions, not the agent. This matters for trials because
**fresh workspaces default to `<ledger>.work/`, next to the ledger**, and for
`ach trial --suite` that is under `<stateDir>/suites/`, normally inside `$HOME`.

- Each cell whose agent loaded such files prints a `[warn] <cellId>: ...` line on stderr,
  and its RunRecord carries `ancestorInstructions`.
- `ach trial --matrix plan.json --hermetic` (and `--suite core --hermetic`) runs each
  cell's agent in a temp copy of its workspace whose ancestors are clean. The copy lives
  under `os.tmpdir()`, or `$AGENTIC_CODING_HARNESS_HERMETIC_ROOT`. The task's `setup`
  runs in the real workspace first. The agent's edits and deletions are synced back
  before `verify` runs there, so the verdict is unchanged in meaning. A temp root that is
  not clean fails the cell as an `error`; it never runs non-hermetically. The RunRecord
  carries `hermetic: {tempDir, source, avoided?, synced}`. If one cell's sync-back
  fails (`HERMETIC_SYNC_FAILED`), that cell is an `error` row that still carries its
  `runId`, `exitStatus`, and a `verify` verdict graded on the kept copy, plus
  `errorInfo: {code, message, keptDir, source}`; the other cells run on and keep their
  results (#113).
- Without `--hermetic`, put the ledger (`--ledger`) and shared `cwd`s outside `$HOME`,
  for example under `/tmp`.

See the README section "Ancestor instruction files and `--hermetic`" for the copy,
sync and cleanup rules.

## `ach trial --suite core`: the bundled task suite

```sh
ach trial --suite core --dry-run                      # every installed agent x 12 tasks, launch nothing
ach trial --suite core                                # run it; Ctrl-C and re-run to resume
ach trial --suite core --agent claude --agent codex --task py-slugify --task js-lru-cache --repeat 3
ach trial --suite core --agent null                   # offline plumbing check, $0
```

The package ships `tasks/`: twelve small, self-verifying tasks in shell,
JavaScript and Python. The kinds are implement, bug-fix and refactor, and two of
the tasks are multi-file. `--suite <name>` builds a
[matrix plan](#ach-trial---matrix-resumable-trial-grids) from every task whose
`meta.json` `suites` array contains `<name>`, then runs it with the same runner.
Resume, the ledger, cell outcomes, `--retry-failed`, `--dry-run`, `--json`
and the exit code all behave as described above.

| Flag | Meaning |
|---|---|
| `--suite NAME` | the suite to run (`core`); cannot be combined with `--matrix` |
| `--agent A` (repeatable) | agents to run. The default is every built-in agent whose CLI is installed, excluding `null` |
| `--task T` (repeatable) | only these tasks. An unknown name is an error that lists the suite's tasks |
| `--model M` (repeatable) | model axis; the default is the agent's own default model |
| `--repeat N` | the plan's `trials`: N fresh cells per agent x task x model |
| `--tasks-dir DIR` | use another task tree with the same layout instead of the bundled one |
| `--ledger PATH` | ledger path; the default is `<stateDir>/suites/<suite>.ledger.jsonl` |

`--task`, `--repeat` and `--tasks-dir` apply to `--suite` only; with `--matrix`
the plan carries them. There is no run-level `--effort` flag; the kiro-only
`--kiro-effort` is not a suite axis.

**Agents that are not installed are skipped, not failed.** The suite checks for
each requested built-in agent's CLI on `PATH` (the same probe as the
`harness_agents` MCP tool, which honours `KIRO_CLI_BIN`). It prints
`skipped: <agent> (<command> not found on PATH)` to stderr and leaves the agent
out of the plan. A skipped agent therefore has no cells, adds nothing to
`error`, and does not affect the exit code. `--json` lists it under
`skippedAgents`. If no requested agent is installed, the run is a usage error
that suggests `--agent null`.

**Labels.** Each cell is one registry record with experiment `suite/<name>`,
variant `{agent}:{model}` (`default` when no `--model` is given) and cellId
`agent:task:model:trialN`, and it carries the task's `verify` outcome. The
variant deliberately leaves the task out. `/compare` and `ach stats` then roll one
agent/model pairing up across the whole suite, which is the comparison a
suite exists for, while the per-task split is still available from the cellId
and from the report, which groups by task.

**Where the output goes.** Next to the ledger:

| Path | Contents |
|---|---|
| `<stateDir>/suites/core.ledger.jsonl` | the resume ledger |
| `<stateDir>/suites/core.work/<cellId>-<hash>/` | each cell's fresh workspace |
| `<stateDir>/suites/core.runs/<task>/<agent>~<model>~trialN.json` | one `ach report`-loadable result per launched cell (a retry overwrites it) |
| `<stateDir>/suites/core.report.html` | the HTML comparison, rendered after the grid, over this run's tasks, one trial per task |

The last line of output is `report     <path> (N runs · M tasks)`. `--ledger
PATH` moves all four: `foo.ledger.jsonl` gives `foo.work/`, `foo.runs/` and
`foo.report.html`.

### Task layout

```
tasks/<name>/
  task.md      the prompt given to the agent
  meta.json    {language, kind, difficulty, license, provenance, suites, tags,
                description, broken, verifyTimeoutMs}
  setup.sh     copies starter/ into $ACH_WORKSPACE
  verify.sh    runs hidden/ tests against $ACH_WORKSPACE; exit 0 = pass
  starter/     what the agent starts from
  hidden/      the tests verify.sh runs (never copied into the workspace)
  reference/   a known-good solution
  broken/      a plausible wrong solution, described by meta.json "broken"
```

`scripts/verify-tasks.sh [--tasks-dir DIR] [task...]` checks every task in both
directions: `verify.sh` must fail on the untouched starter, pass on `reference/`
and fail on `broken/`, and setup must not leak `reference/`, `broken/` or
`hidden/` into the workspace. CI runs it on Linux and macOS. Set
`VERIFY_TASKS_VERBOSE=1` to see why each broken variant fails. The tasks need
`sh`, `node` and `python3`.

`reference/` and `hidden/` ship in the npm package. An agent run through the
harness only sees its workspace. However, an agent that searches the
filesystem can find the installed package, so do not treat these tasks as a
held-out benchmark.

### How `tasks/` is found

The suite resolves the task tree relative to the running module at
`<module dir>/../../tasks`:

- **Checkout:** `src/cli/` gives `<repo>/tasks`.
- **npm install or Homebrew:** `dist/cli/` or `dist/bun/` gives
  `<package>/tasks`. `tasks` is in the package `files`, and the Homebrew formula
  installs the npm tarball.
- **Compiled single binary and pip wheel:** neither carries the tree. The
  compiled binary's module URL is inside bun's virtual filesystem, and the
  wheel vendors only the JS bundle. Both fail with a usage error that asks for
  `--tasks-dir <checkout>/tasks`.
