# agentic-coding-harness — cost tracking and observability for Claude Code, Codex CLI, Gemini CLI, OpenCode, Kiro, Prime Agent, and GitHub Copilot CLI

**Agents hide the burn. `ach` runs, watches, and meters Claude Code, Codex CLI, Gemini CLI, OpenCode, Kiro, Prime Agent, and GitHub Copilot CLI from one CLI — agent cost tracking whose numbers verify against each CLI's own records.**

<p>
  <a href="https://www.npmjs.com/package/agentic-coding-harness"><img alt="npm version" src="https://img.shields.io/npm/v/agentic-coding-harness"></a>
  <a href="https://pypi.org/project/agentic-coding-harness/"><img alt="PyPI version" src="https://img.shields.io/pypi/v/agentic-coding-harness"></a>
  <a href="LICENSE"><img alt="MIT license" src="https://img.shields.io/badge/license-MIT-blue"></a>
  <img alt="Node.js 18.19 or newer" src="https://img.shields.io/badge/node-%3E%3D18.19-brightgreen">
</p>

![Live web dashboard grid showing token usage and cost across concurrent Claude Code and Kiro agent runs, with interactive terminal panes](docs/assets/dashboard.gif)

## Highlights

- **One CLI, six agents (plus the Kiro IDE)** — `claude`, `opencode`, `kiro`, `codex`, `gemini`, `prime` adapters (plus `copilot` for GitHub Copilot CLI, `cursor` for the Cursor CLI agent, and `kiro-ide`, which drives the Kiro desktop app over CDP) normalize six different transcript formats into one `AgentEvent` stream and one canonical token record (input, output, cache read, cache write, reasoning).
- **Cost math you can defend** — cache-aware accounting verified against each CLI's own ground truth (Claude session JSONL, Kiro session files, provider-reported `costUSD`); LiteLLM pricing, and unpriced models are marked unavailable rather than silently assigned a price.
- **Live agent runs dashboard** — `ach dash` redraws 2×/s in the terminal; `ach web` (port 8399) grids every run with a browser terminal you can type into — PTY per run, vendored xterm.js, zero CDN.
- **Terminal replay** — every run renders to an asciinema-format `.cast`, so you can scrub what the agent did and when.
- **Run registry** — every run persists to `<stateDir>/runs/<runId>.json` with atomic writes; survives kills, dumps as `--json` for tools.
- **10 MCP tools** — launch runs and read usage from any MCP client over stdio, or streamable HTTP on port 8398 (`ach serve`).
- **Artifacts out** — ATIF v1.7 trajectories, OpenTelemetry `gen_ai` spans, Langfuse via OTLP, and single-file HTML comparison reports.
- **Usage you can act on** — timezone-aware stats, model/project breakdowns, cache efficiency, rolling billing blocks, quota headroom, context pressure, and persisted threshold alerts.
- **Verified trials** — `--verify`, fresh-session repeats, pass@k and Wilson intervals, and score history from `ach regrade`.
- **More ways to run** — custom command templates, `agents.d` descriptors, an offline `null` adapter, and standalone macOS/Linux executables.

## How it compares

| Compared with | Runs and budgets | Events and cost | Registry and output |
|---|---|---|---|
| **usage CLIs** (ccusage etc.) | `ach` launches, aborts, and budget-caps the runs it meters | normalized token events across 6 agent CLIs | per-run registry keyed by runId + live web grid |
| **observability platforms** (Langfuse etc.) | `ach` launches and meters the runs itself | local-first flat files — no account, no ingest step | exports to them via OTLP when you want their charts |
| **tmux + grep** | one launcher for all six agents | normalized event schema + cost math | run registry + single-file HTML report |

## Is this for you?

- **For you if** you run coding agents locally and want per-run tokens, cost, and credits from one place — including opt-in budget enforcement that aborts a runaway run mid-flight.
- **For you if** you A/B compare coding agents: same task, six agents, one comparison table, one local registry.
- **Not for you if** you need hosted team features (SSO, retention, org-wide dashboards). `ach` is local-first by design and exports to Langfuse and other OTLP backends when you outgrow it.

## Install

Homebrew installs the Node-based CLI; Bun is not required:

```sh
brew tap sblattj/agentic-coding-harness https://github.com/sblattj/agentic-coding-harness
brew install sblattj/agentic-coding-harness/ach
ach --version
```

| Install path | Command or download | Requirements |
|---|---|---|
| Homebrew | Commands above | Homebrew; Node is installed as a dependency |
| npm | `npm install -g agentic-coding-harness` | Node.js 18.19+ |
| Standalone | [GitHub release binaries and SHA256SUMS](https://github.com/sblattj/agentic-coding-harness/releases/latest) | macOS or Linux, arm64 or x64; no Node/Bun runtime |
| Python wrapper | `uv tool install agentic-coding-harness` or `pipx install agentic-coding-harness` | Python 3.9+ and Node.js 18.19+ or Bun; PyPI currently provides the older 0.7.4 release |

From a source checkout (fresh clone or worktree), `ach` is not on `PATH` until you build it:

```sh
bun install && bun run build:node && bun link
```

`package.json` declares `bin.ach = dist/cli/ach.js`, and `dist/` is a gitignored build
output that `build:node` writes. Without the build there is nothing for `bun link` to
point at. To skip the build, run the source entry directly: `bun run src/cli/ach.ts run ...`.

Standalone binaries embed the web dashboard. The interactive browser terminal requires
`bun-pty` and is unavailable in standalone builds; CLI runs, stats, terminal dashboard,
and the rest of the web dashboard remain available. See [packaging](docs/PACKAGING.md)
for checksum verification and release automation.

## Quickstart

```sh
# no install needed:
npx -y --package=agentic-coding-harness ach run --agent claude "add a --dry-run flag to scripts/lint.sh"

# or install globally:
npm install -g agentic-coding-harness
ach run --agent claude "add a --dry-run flag to scripts/lint.sh"
```

Dashboard in three lines:

```sh
ach web                                        # live dashboard on :8399
ach run --agent codex "fix the failing test"   # launch runs from any terminal
# open http://localhost:8399 — the grid shows every run; LIVE opens a terminal pane
```

## Demo: one task, six agents, one cost table

Real token and cost accounting across every installed agent — output shapes are the real
ones (`formatSummary` in `src/cli/lib.ts`, the table in `src/cli/dash.ts`); values from
actual runs:

![ach stats terminal output showing per-agent and per-day token usage, cache reads, and cost in USD across Claude Code, Codex CLI, Gemini CLI, OpenCode, and Kiro](docs/assets/cli-stats.png)

```console
$ ach run --agent claude --max-turns 40 "add a --dry-run flag to scripts/lint.sh"
[14:03:11] step
[14:03:13] tool    Read
[14:03:19] tool    Edit
[14:03:24] step
sessionId  7c1f0a2e-4b9d-4e1a-9c33-8f2a1d5b6e70
tokens     input=4,812 output=933 cacheRead=38,204 cacheWrite=1,120 reasoning=640
cost       $0.0612
duration   31.4s
exit       success

$ ach dash
STATUS AGENT    RUNID    SESSION  ELAPSED       IN      OUT     CACHE     COST  CREDITS LAST EVENT
+      claude   7c1f0a2e 7c1f0a2e     31s     4.8k     933    39.3k  $0.0612          step
●      kiro     91b3ce11 91b3ce11     12s       0       0        0  $0.0000   0.05cr tool    Bash

2 runs  in 4.8k  out 933  cost $0.0612  credits 0.05cr  q quit

$ ach report trials/20260911-141210          # single-file HTML comparison
$ ach emit --format langfuse --input …       # post spans to Langfuse / OTel / ATIF
```

## The problem: coding agents hide token usage and cost

- **Agents hide burn.** Kiro exposes metering credits, not tokens; Claude mixes models inside one
  session, so any single blended price is wrong — real Claude Code cost needs per-(model,
  cache-tier) math. Each adapter taps usage at its source and prices it that way. Kiro credits
  stay on their own summary line — never merged into USD.
- **Every CLI speaks a different format.** JSONL transcripts, NDJSON stdout, ACP, SQLite — six
  adapters normalize all of it into one event model and one `CanonicalTokenRecord` (with
  cache-read/write/reasoning split), so dash, stats, emitters, and the MCP server are written once.
- **Nothing correlated runs across agents — until now.** Runs land in a registry keyed by
  runId; `examples/trial-all.sh` side-by-sides, HTML comparison reports, and cross-agent stats are
  first-class, not shell archaeology.
- **Numbers you can defend.** Token/cost columns are checked against ground truth: cache columns
  exact vs each CLI's own session JSONL; Kiro MITM credits bit-for-bit vs Kiro's session files.

## What it does: token metering, verified cost tracking, and run artifacts for six agents

- **Eight CLI adapters** — `claude`, `opencode`, `kiro`, `codex`, `gemini`, `prime` (headless / ACP lanes) — plus `copilot` (GitHub Copilot CLI, below), `cursor` (Cursor CLI agent, below) and `kiro-ide`, which drives the Kiro IDE desktop app over CDP (see "Kiro IDE (desktop app)").
- **Prime Agent** — `ach run --agent prime` drives `prime-agent -p --mode json`; `--model`
  passes through verbatim (`<provider>/<model>`). Usage is counted per assistant message plus
  the subagent (`rlm.spawn`) sessions read from `~/.prime/agent/session-artifacts/`; a
  provider-reported cost of 0 is shown as `n/a`, not `$0`. `ach doctor --agent prime` checks the
  binary and auth (`PRIME_API_KEY`, `~/.prime/agent/auth.json`, or a provider key in
  `~/.prime/agent/models.json`). No vendor quota source.
- **GitHub Copilot CLI** — `ach run --agent copilot` drives `copilot --prompt=<text> --output-format json
  --allow-all-tools` (binary override: `COPILOT_CLI_BIN`). **Auth prerequisite:** a GitHub login that has
  Copilot access, by `copilot login`, a `COPILOT_GITHUB_TOKEN` / `GH_TOKEN` / `GITHUB_TOKEN` env var, or
  `gh auth login`; without one the run fails fast with a specific `copilot: not authenticated` (or
  `access denied by policy`) error and is recorded `unavailable`. Copilot bills in AI credits (AIU), not
  tokens: the cost is the CLI's own `totalNanoAiu` telemetry at 1 AIU = $0.01, shown in the normal cost
  column and as `credits`. If that telemetry is missing the cost is `n/a` with a warning and tokens
  still show: ach never estimates a Copilot cost from token math. `--resume SID` bills only the resumed
  run's share of the cumulative session. See [docs/transcript-adapters.md](docs/transcript-adapters.md)
  for where the telemetry lives and what is verified. No vendor quota source.
- **Cursor CLI agent** — `ach run --agent cursor` drives `cursor-agent --print --output-format stream-json
  --trust --force -- <prompt>` (binary override: `CURSOR_AGENT_BIN`; `--resume <chatId>` continues a chat).
  **Auth prerequisite:** `cursor-agent login` or `CURSOR_API_KEY`. Before launching, ach runs
  `cursor-agent status`; an unauthenticated CLI fails fast with a specific `cursor: not authenticated`
  error and the run is recorded `unavailable` (the CLI itself reports "Authentication required" on a run
  and "Not logged in" on `status`, both with no token spent). Cost follows the usual honesty rule: the
  CLI's own stated cost when its result carries one (`reported`), else computed from the tokens its
  result reports (`computed`, with a warning), else `n/a` with a warning: ach never estimates a Cursor
  cost from text length. `cursor` is also the name of the read-only Cursor IDE monitor, which
  `ach stats --agent cursor` keeps reading (separate store, no double count). Supports cursor-agent
  2026.10.x: its result reports tokens (net input, cache read, cache write, output) but no cost, so a
  Cursor run's cost is `computed` from `--model`. The default model, `Auto`, does not say which model
  served the run, so its tokens are recorded and its cost is unavailable (one warning). Recent Cursor IDE builds keep no per-message token counts on disk,
  so `ach stats --agent cursor` reports them unavailable (one warning) rather than estimating; use
  `ach run --agent cursor` or the Cursor dashboard export for exact usage.
  To keep a dashboard export, run `ach import --agent cursor --usage-export <file>` (CSV or JSON from the
  Cursor dashboard): the file is validated and a copy stored under `<stateDir>/cursor-dashboard/`;
  re-importing the same file is `unchanged`, and no run records are written. Stream shapes were read
  from the 2026.10.01 CLI bundle and verified on a live logged-in run; see
  [docs/transcript-adapters.md](docs/transcript-adapters.md).
  No vendor quota source.
- **Unified events, cache-aware tokens** — one `AgentEvent` stream, one canonical token record;
  per-agent double-counting traps handled ([docs/TOKEN-COUNTING.md](docs/TOKEN-COUNTING.md)).
- **LiteLLM multi-model pricing** — bundled LiteLLM extract, external cost-map override;
  unpriced models carry an explicit unavailable price, never a silent estimate.
- **Kiro MITM credit tap** — auto-starts on `ach run --agent kiro` when `mitmdump` is on
  the PATH; captures metering credits (`extra.credits`) and the native `kiroSession` id for grep
  correlation; degrades to a warning when absent.
- **Kiro ACP transport + preflight** — `--kiro-transport acp` drives `kiro-cli acp` over JSON-RPC
  and records the *proven* mode/model (`result.kiro.modelAck`); the default headless lane forwards
  the same `--model`/`--kiro-*` config and records what it passed, with no implicit
  `--trust-all-tools`; `ach preflight --agent kiro`
  and `harness_kiro_preflight` verify binary, auth, agent, model and MCP state without sending a
  prompt. Token counts are reported `n/a` when no source carries them (kiro-cli 2.21.x) — never
  fabricated zeros; credits and derived context tokens are shown instead. See
  [docs/KIRO.md](docs/KIRO.md).
- **Run registry + `ach dash`** — live TUI over `<stateDir>/runs` (redraws 2×/s, ANSI status
  glyphs, totals footer); `--json` dumps RunRecords for tools, `--all` widens past the last hour.
- **Run queue** — `ach queue run plan.txt --max-concurrent 4` launches plan-file slices as detached `ach run` processes, capped by the live runs on the whole machine, with `pre`/`post` hooks, per-slice logs and a state file; see [docs/QUEUE.md](docs/QUEUE.md).
- **MCP server** — `ach mcp` (stdio JSON-RPC; `ach serve` for streamable HTTP), 10 tools (`harness_run{,_async,_status,_events,_cancel}`, `harness_kiro_preflight`, `report/emit/stats/agents`) so any MCP
  client launches runs and reads usage; see [docs/MCP.md](docs/MCP.md).
- **Emitters** — ATIF v1.7 trajectories (self-validating), OpenTelemetry `gen_ai` spans, Langfuse via OTLP.
- **Single-file HTML reports** — charts + timelines comparing every agent in a trial dir.
- **`watch` / `stats`** — live per-session token deltas across claude/codex/gemini/prime transcript
  dirs plus the opencode SQLite store; `stats` aggregates totals/byAgent/byDay over machine
  transcripts and harness state (`--state-only` to skip transcript scans).

## A/B compare coding agents side by side — tokens, cost, credits, duration

Run the same task on every installed agent and get a single comparison: tokens in/out/cache,
cost, wall-clock duration, and status per agent. No manual log diffing. For lightweight
experiment tracking, the web dashboard's `/compare` view rolls runs up by experiment×variant
or workflow×agent straight from the local registry.

For a full sweep, declare the grid once and let `ach trial --matrix` run it:

```sh
ach trial --matrix examples/trial-matrix.json --dry-run   # list the 9 cells, launch nothing
ach trial --matrix examples/trial-matrix.json             # run them; Ctrl-C and re-run to resume
```

Each cell (`agent:task:model:trialN`) becomes one run labelled with the plan's
`experiment` and a `variant`, so `/compare` groups the results with no extra setup.
The runner appends one row to `examples/trial-matrix.ledger.jsonl` only after that
cell's run has finalized. A re-run skips cells that already have a verdict (`passed` or
`verify-failed`) and runs the rest. Infrastructure `error` cells are reported and re-run
only with `--retry-failed`; a verify failure is never retried. The plan schema, task
directories (`task.md`, `setup.sh`, `verify.sh`), and ledger format are in
[docs/TRIALS.md](docs/TRIALS.md#ach-trial---matrix-resumable-trial-grids).

To compare agents without writing tasks, run the bundled suite: 12 self-verifying
shell, JavaScript and Python tasks, with every installed agent by default.

```sh
ach trial --suite core --dry-run                      # agents x tasks, launch nothing
ach trial --suite core --agent claude --task py-slugify --repeat 3
```

Agents whose CLI is not installed are skipped with a printed reason. The suite writes an
HTML report next to its ledger in the state dir. See
[docs/TRIALS.md](docs/TRIALS.md#ach-trial---suite-core-the-bundled-task-suite).

![Cross-agent comparison table showing token usage, cost, duration, and status for Claude Code, Codex CLI, Gemini CLI, OpenCode, and Kiro run on the same task](docs/assets/cli-compare.png)

## Live dashboards: terminal (`ach dash`) and web (`ach web`)

One registry, two live agent runs dashboards.

**Web** — a tmux-like grid of every run, plus an observability view per run. A **LIVE** button
spawns an interactive PTY for the run's agent and expands the tile to a full xterm.js browser
terminal you can type into.

![Web dashboard terminal grid showing live agent run tiles with token and cost readouts and interactive terminal panes](docs/assets/web-grid.png)

**Observability trio** — traces, metrics, and logs for a single run, with a live terminal
drawer: the span waterfall, cumulative token/cost charts, and the leveled event log. The
metrics pane also shows latency — time to first token, output tokens/s, time per output token,
and a per-tool duration table (calls, avg, p95, total); a metric the event log cannot support
reads `n/a`. Time to first token is measured for claude, gemini, codex (first request of each
turn) and headless kiro (first request); output tokens/s and time per output token for claude
only; opencode's stream carries no request timing. See [ARCHITECTURE.md](docs/ARCHITECTURE.md)
("Latency metrics") for definitions, precision and which agents emit what.

![Observability view showing the traces waterfall, token and cost metric cards with charts, and the event log stream for a single coding agent run](docs/assets/web-trio.png)

**Terminal** — `ach dash` is a live TUI over the run registry (redraws 2×/s, ANSI status
glyphs, totals footer); `--json` dumps RunRecords for tools.

## Spend by git branch

`ach run` records the git branch (and short commit) of the run's working directory on
its run record at start. `ach stats --by branch` (composable with `--by model,project`)
prints a per-branch table and adds `byBranch` to `--json`. Runs with no recorded branch
(older records, non-git directories, transcript-only rows) show as `(no branch)`;
a detached HEAD shows as `(detached <sha>)`. Attribution is by start branch: a
mid-run `git checkout` is not re-attributed.

The same labels drive two more views. `/api/compare?by=branch` (alias `by=git.branch`,
composable with the other keys, e.g. `by=branch,agent`) groups the web rollup by branch.
`ach report` adds a "spend by git branch" table (branch, runs, cost, tokens) whenever a
trial's run records carry a branch; runs without one fall in `(no branch)`.

## New in 0.11.0

```sh
ach doctor --agent claude --json                 # configuration checks, no prompt
ach run --agent null --verify 'true' --repeat 3 "offline smoke"
ach stats --last 7d --tz America/Los_Angeles --by week,model,project
ach stats --cost-mode calculate --blocks         # computed cost and Claude 5-hour blocks
ach quota --json                                # vendor-reported headroom, n/a when absent
ach quota wait --max-used 90 -- ./batch.sh       # start a job once the quota window has room
ach status --compact
ach statusline                                  # statusline-compatible usage summary
ach archive                                     # preserve transcripts and run records
ach regrade <run-id> --verify 'npm test'          # append a score without another agent run
```

`--cost-mode auto|calculate|display` selects reported or computed cost, with
provenance labels on displayed values. Time filters, project/model dimensions,
cache-hit ratios, and `--exit-codes ladder` compose with the existing stats commands.
Custom agents can use `--agent custom --template 'mycli {prompt}'` or a JSON file in
`.ach/agents.d/`; runs without a usage source remain explicitly unmetered.

**Budget behavior changed:** spend thresholds warn by default. Use
`--budget-usd 5 --on-budget abort` to enforce a hard spending cap. Wall-clock,
idle, and turn limits continue to enforce their own limits. Context pressure and
budget crossings share persisted alert state. Plan presets are labeled community
estimates; quota output uses provider-reported values when available.

## CLI

```sh
ach run --agent <claude|opencode|kiro|codex|gemini|prime|kiro-ide|copilot|cursor|null|custom|descriptor> [--model M] [--resume SID]
            [--budget-usd N] [--on-budget warn|abort] [--max-turns N] [--wall-ms N] [--idle-ms N]
            [--verify CMD] [--repeat N] [--parallel K] [--exit-codes binary|ladder] [--json] "prompt"
            [--extra-args 'a b']... [--extra-arg TOKEN]...   # see "Passing extra CLI args"
            [--permission-mode MODE] [--allowed-tools LIST]... [--disallowed-tools LIST]...
            [--mcp-config PATH|JSON] [--evidence-dir DIR]   # see "Permission and sandbox flags"
            kiro only: [--kiro-transport headless|acp] [--kiro-agent A] [--kiro-engine v1|v2|v3]
                       [--kiro-effort E] [--kiro-tools all|none|a,b] [--kiro-require-mcp-startup]
                       [--kiro-startup-ms N] [--kiro-require-model-ack] [--kiro-mcp-server '<json>']...
            kiro-ide only: [--kiro-ide-cdp host:port] [--kiro-ide-port N] [--kiro-ide-bin PATH]
                           [--kiro-ide-user-data-dir DIR] [--kiro-ide-no-new-session]
            claude only: [--claude-default-config]   # default CLAUDE_CONFIG_DIR (keychain OAuth)
ach trial --matrix plan.json [--dry-run] [--retry-failed] [--ledger PATH] [--json]
            # resumable agents x tasks x models x trials grid; re-run the same command
            # after an interruption and finalized cells are skipped (docs/TRIALS.md)
ach trial --suite core [--agent A]... [--task T]... [--model M]... [--repeat N] [--tasks-dir DIR] [--ledger PATH]
            [--permission-mode M] [--allowed-tools L] [--disallowed-tools L] [--mcp-config PATH|JSON]
            # bundled task suite; missing agent CLIs skipped; HTML report next to the ledger
ach preflight --agent kiro [--model M] [--kiro-agent A] [--json]   # verify config, no prompt
ach preflight --agent kiro-ide [--kiro-ide-cdp host:port] [--json]  # read-only CDP rows, same as doctor
ach watch [--transcript-dir <root>]           # live per-session token deltas
ach stats [--agent A] [--days N | --since DATE [--until DATE] | --last D] [--json] [--state-only]
            [--transcript-dir <root>] [--origin all|native|imported|transcript]
            # window is [--since, --until): since inclusive, until EXCLUSIVE (a record
            # stamped exactly at --until is not counted); --until alone = everything before it
ach audit [--agent A] [--days N] [--json] [--tolerance-pct P] [--fix] [--state-dir <stateDir>]
            # re-derive RunRecord totals from raw transcripts; exit 1 on drift
ach import --agent claude [--days N=30] [--transcript-dir <root>] [--state-dir <stateDir>]
            [--dry-run] [--json]
            # record existing Claude Code sessions as imported RunRecords
ach verify-run <runId|runDir> [--json] [--records] [--state-dir <stateDir>]
            # prove the run's hash-chained event log + sealed totals are untouched
            # exit 0 intact, 2 tampered, 3 unsealed (legacy), 4 open (never sealed)
ach replay vet <pr-number|pr-url> [--repo owner/name] [--clone PATH] [--fallback-clone PATH]... [--json]
            # read-only vetting of a merged PR as a replay case: merged/approved/trunk/tests/ticket,
            # merge + base commits in the clone, squash vs merge; exit 0 pass/warn, 40 fail (docs/REPLAY.md)
ach emit --input events.json --format atif|otel|langfuse [--out path]
            [--agent A] [--model M] [--session-id SID]
            (langfuse auth: --langfuse-url/--langfuse-public-key/--langfuse-secret-key or env)
ach report <trials-dir> [--out path]           # single-file HTML comparison
ach dash [--json [--queues]] [--all] [--state-dir <stateDir>]   # live run dashboard (+ queues section); q quits
ach queue run <plan> [--max-concurrent N] [--max-hours H] [--dry-run]   # plan-file run queue, <= N live
            # `ach run` machine-wide, detached runs, pre/post hooks (docs/QUEUE.md); ach queue status [<id>]
ach mcp [--gateway --root R] [--max-jobs N] [--max-output-bytes N] [--allow-extra-args A]
            (MCP over stdio: newline-delimited JSON-RPC on stdin/stdout, Content-Length
             framing tolerated; same 10 tools and gateway flags as `ach serve`)
ach serve [--http] [--port N=8398] [--host 127.0.0.1] [--token T]
            (MCP over streamable HTTP on POST /mcp; GET /health probe;
             token via --token or env AGENTIC_CODING_HARNESS_HTTP_TOKEN)
ach web [trials-dir] [--port N=8399] [--host H] [--token T] [--state-dir <stateDir>] [--no-open]
          [--source URL] [--source-token T] [--source-mode poll|sse|ws]
          [--source-poll-ms N=3000] [--source-merge state|only]
```

`--dir` is kept as an alias with a per-command meaning: for `watch` and `stats` it is
`--transcript-dir` (a home-shaped root holding `.claude/projects` etc.); for `archive`, `audit`,
`import`, `dash` and `web` it is `--state-dir`. Passing both spellings with different values is a usage
error.

`ach import --agent claude` gives a new install its history on day one. It reads the existing
Claude Code transcripts (`~/.claude/projects`, or `<root>/.claude/projects` with
`--transcript-dir <root>`) and writes one RunRecord per session into the same registry native runs
use (`<stateDir>/runs/`), marked `source: "imported"` and carrying the native `sessionId`, the
session's token totals, a computed cost, its `cwd`, and the transcript paths in `metadata`. `ach dash`,
`ach web`, and the compare view then list those sessions next to native runs. The import is
idempotent: the run id is derived from the session id, so a second import rewrites nothing and
reports each session `unchanged` (a session that grew since is `updated`). A session a native
`ach run` already recorded is skipped and reported, never duplicated. Sessions whose last activity
is older than `--days` (default 30) are reported as `skipped-outside-window`. A corrupt transcript
file is an `error` line; the import continues and still exits 0. `--dry-run` reports without
writing; `--json` emits `{summary, sessions, errors, ...}`. Only claude is importable so far.

Import never changes an `ach stats` total. Stats already counts machine transcripts directly, and
it sums tokens only from those transcripts and from harness state under `<stateDir>/raw/`, never
from RunRecord totals, so an imported session is counted once, from its transcript, before and
after import. What import adds is provenance: once the registry holds imported sessions,
`ach stats` prints an `origin:` line per origin (`--json`: `origins`), and `--origin` counts only
one of them. `native` means ach runs, `imported` means sessions `ach import` recorded, and
`transcript` means machine transcripts that are not in the registry. The default is `all`. The flag
is `--origin` rather than `--source` because `ach web --source` names an external run feed. Imported
sessions carry no task verdict, so they are excluded from the stats run-outcome rollup and from
`ach status` run counts. To keep history after Claude Code prunes old transcripts, snapshot them
with `ach archive` and read them back with `ach stats --with-warehouse`.

`ach audit` is the self-check on the numbers themselves. For every RunRecord under
`<stateDir>/runs/` it replays the run's raw transcript (`<stateDir>/raw/<agent>-<session>.jsonl`),
re-parses each usage event's raw payload (not the adapter's pre-normalized record; per-model
breakdowns preferred), re-prices it with the current pricing tables, and prints
`field: recorded vs recomputed (Δ)` for `inputTokens`, `outputTokens`, `cacheReadTokens`,
`cacheWriteTokens`, and `costUsd`. It exits 0 when every delta is within `--tolerance-pct`
(default 0: exact tokens, 1e-9 USD rounding slack) and 1 otherwise, so it works as a CI gate on the
parsing and pricing pipeline. Runs with no totals or no transcript are reported `unverifiable`,
and a model the pricer does not know is reported as an `unpriceable` cost; neither counts as drift.
`--fix` rewrites the drifted totals (and the `usage.usd.value` mirror) and appends one
`corrections: [{at, field, from, to, by}]` entry per field to the RunRecord, so a patch is never
silent. `--json` emits `{rows, summary, total}`; each row carries `recorded`, `recomputed`, and
`delta` objects keyed by the same field names as `ach stats --json`. Each row also carries
`chain`, the run's `ach verify-run` verdict (below), taken before any `--fix`.

### Passing extra CLI args to the agent: `--extra-args` / `--extra-arg`

Both flags work on `ach run` and `ach preflight`, for every launchable agent, and are
repeatable. Tokens reach the agent in command-line order, even when the flags are mixed.

- `--extra-args '<a b>'` splits each value on spaces (`--extra-args "-c x=1"` passes `-c`, `x=1`).
- `--extra-arg <token>` passes exactly ONE verbatim argv token and never splits it, so a
  value containing spaces survives. A dash-leading value is fine in the space form.

```sh
# route codex to a custom provider and pass a config value with spaces as one token
ach run --agent codex \
  --extra-arg -c --extra-arg 'model_provider=ferry' \
  --extra-arg -c --extra-arg 'developer_instructions="FERRY ROUTING: use tier names heavy, medium, light"' \
  "prompt"
```

The MCP tools take `extraArgs` as an array, which is already verbatim.

### Permission and sandbox flags: `--permission-mode` / `--allowed-tools` / `--disallowed-tools` / `--mcp-config`

These four flags build the typed `SandboxPolicy` (see `src/core/types.ts`) that each adapter
translates into its own CLI flags, so a headless child that needs Bash, file writes or MCP
tools does not stall on an approval prompt, and you do not hand-assemble `--extra-args`.

- `--permission-mode <mode>`: `ask` and `dontAsk` are portable; any other value passes
  through as the agent's native mode (claude `bypassPermissions` / `acceptEdits`, codex
  `on-failure`, gemini `yolo`).
- `--allowed-tools <list>` / `--disallowed-tools <list>`: repeatable AND comma-separated;
  occurrences concatenate. Commas inside parentheses are kept, so `'Bash(git log:*)'` is one tool.
  Tool names are agent-native (copilot: `bash`, `view`, `create`, `edit`, `grep`, `glob`, ...; claude: `Bash`,
  `Read`, ...), not translated; copilot silently ignores a name it does not know, so `ach` prints a `[warn]`
  for a copilot tool name that is not a built-in (with a "did you mean" hint) while still passing it through.
  A deny list blocks only the tools it names: on copilot, excluding `view` and `bash` still leaves
  `read_bash`, `grep` and `glob`, which can read files, so prefer an `--allowed-tools` list to confine a run.
- `--mcp-config <path|json>`: given once. A value starting with `{` is parsed as inline JSON,
  anything else is a file path passed verbatim.

| Agent | `--permission-mode` | `--allowed-tools` | `--disallowed-tools` | `--mcp-config` |
|---|---|---|---|---|
| claude | yes | yes | yes | yes |
| gemini | yes | yes | yes | yes |
| codex | yes | no | no | no |
| kiro | no | yes (becomes `--kiro-tools`; `--kiro-tools` wins) | no | no (use `--kiro-mcp-server`) |
| prime | no | yes | no | no |
| copilot | `dontAsk`/`ask` (all tools pre-approved), `plan`, `interactive`, `autopilot` | yes (`--available-tools`) | yes (`--excluded-tools`) | yes (`--additional-mcp-config`) |
| cursor | `dontAsk` (`--force`), `plan`, `ask` (`--mode`) | no (permissions live in `~/.cursor/cli-config.json`) | no | no (use `.cursor/mcp.json`) |
| opencode, kiro-ide, null, `custom`, agents.d | no | no | no | no |

A flag the chosen agent cannot honor prints `[warn] --<flag> is not supported by agent
'<agent>' and was dropped` and the run continues (`--extra-arg` stays the escape hatch).
The resolved policy is printed to stderr as a `[sandbox] permissionMode=... allowedTools=...`
header line, and `--json` output gains a `sandbox` object; inline MCP JSON is shown as
`<inline JSON, N bytes>` because it can carry credentials.

```sh
ach run --agent claude --permission-mode bypassPermissions \
  --allowed-tools 'Bash,Read,Edit' --mcp-config ./mcp.json "prompt"
```

The same policy is available on the other surfaces. `ach trial --suite` takes the four flags
directly (they become the generated plan's `sandbox`); `ach trial --matrix` plans take an
optional `sandbox` object at plan level, per agent entry and per task (see
[docs/TRIALS.md](docs/TRIALS.md#sandbox-policy-in-a-plan)); the MCP `harness_run` and
`harness_run_async` tools take a `sandbox` input object (see [docs/MCP.md](docs/MCP.md)). Both
use the support table above and report a dropped field as a warning.

### Metrics-only evidence: `--evidence-dir`

`ach run --evidence-dir <dir>` writes `<dir>/metrics.json` (`metrics-<i>.json` per child with
`--repeat`) after the run: agent, model, exit status, wall seconds, turns, cost with
provenance, token totals, the sandbox policy, `ach` version and timestamps. It holds no
prompt, response, tool input or file content, so a trial can commit it while keeping the raw
stream private. See `docs/TRIALS.md`, "Evidence hygiene".

### Ancestor instruction files and `--hermetic`

Coding agents load "project memory" from the run's working directory **and from its
ancestor directories**. A workspace under `$HOME` therefore inherits files like
`~/CLAUDE.md` even when claude runs with `--setting-sources project,local
--strict-mcp-config`, because a parent-directory `CLAUDE.md` counts as project memory.
That leaks your own instructions into runs that are meant to be hermetic and skews
benchmark comparisons (#106).

Before `ach run` launches the agent, it walks from the cwd's **parent** up and lists the
instruction files that agent would load there. The cwd's own files are the workspace's
own project memory and are not listed.

| Agent | Files | How far up |
|---|---|---|
| claude | `CLAUDE.md`, `CLAUDE.local.md` | every ancestor, up to `/` |
| codex | `AGENTS.override.md`, `AGENTS.md` | up to the git root (the nearest dir with `.git`); none without one |
| gemini | `GEMINI.md` | up to the git root; none without one |
| prime | `AGENTS.md`, `CLAUDE.md` | every ancestor, up to `/` (it does not stop at the git root) |
| copilot | `AGENTS.md`, `CLAUDE.md` | up to the git root; none without one |
| opencode, kiro, cursor, null, custom | none checked | |

When the list is non-empty, `ach run` prints a `[warn]` block naming every file on
stderr. The run summary gains an `ancestors` line, and the RunRecord and the `--json`
RunResult carry `ancestorInstructions: string[]`. Records without ancestor files are
unchanged. MCP `harness_run` adds the same list to the result's `warnings`, and
`ach trial` warns per cell.

`--hermetic` removes the leak instead of reporting it:

```bash
ach run --agent claude --hermetic --verify 'npm test' "fix the failing test"
```

1. The workspace is copied into `mkdtemp(<tmp>/ach-hermetic-XXXX)/<workspace-name>`.
   `<tmp>` is `os.tmpdir()`, or `$AGENTIC_CODING_HARNESS_HERMETIC_ROOT` when set. On
   macOS that is `/var/folders/...`, outside `$HOME`.
2. The detector runs on the copy. If the copy still has ancestor instruction files, for
   example because `TMPDIR` points under `$HOME`, the run fails with a non-zero exit
   before the agent launches. It never runs silently non-hermetic.
3. The agent runs in the copy. Afterwards the changed tree is synced back into the
   original workspace, so `--verify` and your checkout see the agent's edits.
   **Deletions propagate**, but only for paths that existed when the copy was made, so a
   file you create in the original during the run is left alone.
4. The temp dir is removed. It is kept only if the sync-back itself fails, because it
   then holds the only copy of the agent's edits; the error prints its path. The settled
   run is not lost: `ach run --json`, `ach trial --matrix` cells, and the MCP
   `harness_run` / `harness_run_status` keep the run's usage and events and attach
   `error: {code: "HERMETIC_SYNC_FAILED", message, keptDir, source}`; the registry record is
   marked `error`, and `--verify`/`verify` is graded on `keptDir` (#113).

The RunRecord records `hermetic: {tempDir, source, avoided?, synced: {copied, deleted}}`,
and its `cwd` stays the original workspace, so `ach regrade` and `ach stats --project`
keep working. `--hermetic` also works on `ach trial --matrix` / `--suite` and on the MCP
`harness_run` / `harness_run_async` tools (`hermetic: true`). It cannot be combined with
`--resume`, because sessions are keyed by directory, or with `--parallel > 1`, because
the runs would sync into one tree concurrently.

Limits: symlinks are copied verbatim, so an absolute link still points at its original
target. In a git **worktree**, `.git` is a file that points at the original gitdir, so
git commands the agent runs in the copy act on the original repository. A driver created
with `confineToWorkspace` bound to the original workspace refuses the temp copy with
`WORKSPACE_ESCAPE`.

The zero-tooling workaround is to keep benchmark workspaces outside `$HOME` and outside
any directory that holds these files, for example under `/tmp`. The warning tells you
whether that worked.

### Tamper-evident metering (`ach verify-run`)

`ach audit` proves the totals follow from the event log; `ach verify-run <runId>` proves the log
itself, and the totals recorded from it, were not edited after the run. Every line the driver
writes to a run's raw transcript (`<stateDir>/raw/<agent>-<session>.jsonl`, the file `ach audit`
reads) and, in run-to-directory mode, to `events.jsonl` carries a sha256 hash chain, and the run
ends with an `ach.seal` record:

```text
{"ach_chain":{"v":1,"run":"<runId>","seq":N,"prev":"<hex>","hash":"<hex>"},<the event JSON as before>
{"ach_chain":{...,"seq":E},"type":"ach.seal","timestamp":..,"runId":..,"eventCount":E,"lastHash":..,"totals":{..},"totalsHash":..}
```

- **What is hashed.** Stripping the fixed `{"ach_chain":{...},` prefix gives back, byte for byte,
  the event line as it was written before chaining (`JSON.stringify(event)`, called BODY).
  `hash = sha256("ach-chain/v1\n" + runId + "\n" + seq + "\n" + prev + "\n" + BODY)`, and seq 0's
  `prev` is `sha256("ach-chain/v1\ngenesis\n" + runId)`. Verification recomputes over the exact bytes
  on disk. Nothing is re-serialized, so reordering a record's keys counts as an edit.
  `stripChain(line)` (exported) recovers the event.
- **Per run, not per file.** A resumed session appends several runs to one transcript. Each run's
  lines carry its own `run` id and chain, and older unchained lines are left alone.
- **Seal.** The seal record covers the event count, the last hash, and the sealed metering totals
  (`inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheWriteTokens`, `costUsd`, `credits`;
  derived fields such as `contextTokens` are not sealed). Its hash is mirrored into
  `RunRecord.seal` (`{v, algo, eventCount, lastHash, sealHash, totalsHash, at}`) and, in
  run-to-directory mode, into `status.json`. That anchor is what makes a truncated tail or a
  deleted seal detectable.
- **Verdicts.** `ok` (exit 0): the chain is intact, sealed, and the recorded totals match the seal.
  `tampered` (exit 2): names the first bad line, whether a record was edited, deleted, inserted
  (including an unchained line planted inside the run), or reordered, the tail was truncated, the
  seal disagrees with `RunRecord.seal`, or the RunRecord totals differ from the sealed totals.
  `unsealed` (exit 3): a legacy log from before chaining, never a failure. `open` (exit 4): the
  chain is intact, but the run has no seal and no anchor, and its record still says `running`,
  because it is still running or it crashed before sealing. The driver seals before it writes a
  terminal status, so an unsealed chain on a finished run counts as `tampered`. A damaged anchor
  (`status.json` or its seal failing to parse) is also `tampered`. Exit 1 is an unknown run id. `ach audit --fix` rewrites are undone through
  `RunRecord.corrections` and reported, not failed. `--records` lists every verified record, and
  `--json` emits the verdict object. A directory argument verifies a run-to-directory
  `events.jsonl` against `status.json`. `ach report` adds a per-run `seal` column.
- **Threat model.** This is tamper-evident, not tamper-proof. There are no keys and no signing. It
  detects accidental or after-the-fact edits to the files on disk. It does not detect someone who
  rewrites the whole chain, the seal, and `RunRecord.seal` consistently, because anyone can
  recompute sha256. It is also no defense against a compromised harness process during the run. To
  anchor a run outside the machine, copy the printed seal hash (`sha256 …` in the output) somewhere
  else and compare it later.

The binary is `ach` (the npm/PyPI package name is `agentic-coding-harness`). Budget flags (`--budget-usd`, `--max-turns`,
`--wall-ms`, `--idle-ms`) take per-run values; `AGENTIC_CODING_HARNESS_BUDGET_USD`, `AGENTIC_CODING_HARNESS_MAX_TURNS`,
`AGENTIC_CODING_HARNESS_WALL_MS`, `AGENTIC_CODING_HARNESS_IDLE_MS` supply env defaults. State lives under
`~/.agentic-coding-harness` (`AGENTIC_CODING_HARNESS_STATE_DIR`).

Claude runs get a fresh per-run `CLAUDE_CONFIG_DIR` under the state dir so transcripts are captured
by construction. On a Mac whose Claude Code login is keychain-bound OAuth (no
`~/.claude/.credentials.json`) that dir cannot see the token and every run ends `Not logged in`;
pass `--claude-default-config` (or set `AGENTIC_CODING_HARNESS_DEFAULT_CLAUDE_CONFIG=1`) to run against the
default config instead. Transcripts then land under `~/.claude/projects` and concurrent claude runs
share one config, so pair it with sequential runs when isolation matters. A run that hits this now ends
`unavailable` with the fix printed (`[warn] unavailable: claude: not logged in for this run ...`).

## Kiro IDE (desktop app)

`--agent kiro-ide` drives the Kiro IDE (the Electron desktop app) over Chrome DevTools Protocol.

**Why.** `kiro-cli` does not load `.kiro/hooks/*.json`; only the IDE does. Observed: kiro-cli 2.21.2
read the hook file without firing the hook. To measure a workspace hook you must run the IDE.

**Install.** macOS: `brew install --cask kiro`. Binary: `/Applications/Kiro.app/Contents/MacOS/Kiro`
(Windows and Linux paths are unverified).

**One-time sign-in per profile.** ach runs Kiro with its own profile, `~/.local/state/ach-kiro-ide/profile`
(`--kiro-ide-user-data-dir` overrides it). Open Kiro once with that profile and sign in, otherwise a run lands
on the sign-in screen. Set `{"security.workspace.trust.enabled": false}` in the profile's `User/settings.json`
so the workspace-trust dialog does not block the run.

```sh
cd <workspace>
ach run --agent kiro-ide "<prompt>"
ach doctor --agent kiro-ide    # binary, CDP reachable, signed in, chat input present
```

**How it works / gotchas.**
- One IDE instance per `--user-data-dir`. A second launch with the same profile hands off to the running
  instance and exits, so ach polls CDP for readiness instead of tracking the child process it spawned.
- `--reuse-window <folder>` makes that running instance switch to (or reopen) the workspace folder, which is
  how the directory you ran `ach` from becomes the IDE's workspace.
- Autopilot is the `#autopilot-toggle` switch in the chat panel and must be on, or the run fails fast (a
  supervised tool call would block waiting for approval).
- Each run starts a fresh chat through the "New session" button (`--kiro-ide-no-new-session` skips it), so
  one run never inherits the previous run's context.
- `--budget-usd` cannot fire (credits only); wall, idle and turn limits still apply, and the run carries a
  warning saying so.

`ach run` has no `--cwd`: the workspace is the directory you run it from (as for `--verify`).

**Attach mode.** `--kiro-ide-cdp host:port` drives an IDE that is already running elsewhere.
CDP is remote code execution on the IDE host: forward the port (`ssh -L 9222:127.0.0.1:9222 host`)
and never expose it more widely. `ach doctor` warns on a non-loopback endpoint.

| Flag | Meaning |
|---|---|
| `--kiro-ide-cdp host:port` | attach to a running IDE's CDP endpoint (default `127.0.0.1:9222`) |
| `--kiro-ide-port N` | CDP port to launch with / connect to |
| `--kiro-ide-bin PATH` | Kiro IDE executable |
| `--kiro-ide-user-data-dir DIR` | profile directory (default `~/.local/state/ach-kiro-ide/profile`) |
| `--kiro-ide-no-new-session` | send into the chat that is already open instead of starting a new session |

**Limits.**
- Metering is credits only (`Est. Credits Used` from the chat); tokens are unavailable.
- Autopilot mode is required so tool calls run without approval.
- Not headless: it needs a desktop session and a visible Kiro window.
- UI-fragile: ach reads the chat DOM. `ach doctor --agent kiro-ide` fails when the selectors no longer match
  the installed Kiro version, so drift fails loudly instead of producing an empty run.

**Hook A/B recipe.** Make two workspaces that differ only in `.kiro/hooks/` (one has a hook that writes
`.hook-fired`, the other has none). Use a file-read prompt, not a shell one: other PreToolUse hooks can
block the shell before your marker runs. Verify the marker after the run:

```sh
for ws in ws-a ws-b; do
  (cd "$ws" && ach run --agent kiro-ide --verify 'test -f .hook-fired' \
    "Read the file hello.txt with your file read tool and reply with its exact contents. Do not use the shell.")
done
```

The workspace with the hook passes the verifier; the one without fails it, and both runs record credits.

## Use as a library

The npm package exports its programmatic API directly — importing it never runs the CLI:

```js
import { createDriver, defaultAdapters } from 'agentic-coding-harness';

const driver = createDriver({ adapters: await defaultAdapters(), stateDir: './harness-state' });
const result = await driver.run('codex', {
  prompt: 'fix the failing test',
  runId: 'my-watchdog-1',      // echo + driver.abort(runId) addressable
  timeoutMs: 120_000,          // alias for budget.wallMs
  idleTimeoutMs: 30_000,       // alias for budget.idleMs
});
// result.exitStatus: 'success' | 'aborted' | 'timeout' | 'error' | ...
driver.abort('my-watchdog-1'); // out-of-band cancel while a run is in flight

// Opt-in (#11): wire SIGTERM/SIGINT to abort the run; dispose when done.
const stopSignalAbort = driver.installSignalAbort('my-watchdog-1');
stopSignalAbort(); // removes exactly those listeners
```

The signal helper is one-shot: the first SIGTERM/SIGINT aborts the run and
uninstalls the handlers, so later signals keep Node's default termination
semantics. An optional second argument overrides the wired signals
(`driver.installSignalAbort(runId, ['SIGHUP'])`).

Exported: `createDriver`, `defaultAdapters`, `runToDirectory`, `ClaudeCodeAdapter`, `KiroAdapter`,
`CodexAdapter`, `GeminiAdapter`, `OpenCodeAdapter`, `PrimeAdapter`, `CopilotAdapter`, `VERSION`, plus the run-record API —
`RunRecordSchema`, `CanonicalTokenRecordSchema`, `ExternalRunFeedSchema`, `writeRunRecord`,
`readRunRecord`, `listRunIds`, `listRunRecords`, `registryDir`, and the `RunRecord` /
`CanonicalTokenRecord` / `ExternalRunFeed` / `RunSource` types. `DriverOptions.onOutput` / `RunSpec.onOutput` give a
raw stdout tap (each chunk exactly as received) alongside the parsed canonical events. Importing the
`ach` bin bundle (`dist/cli/ach.js`) as a module yields the same exports with no side effects.

### Run-to-directory mode (durable status.json)

Give a run an `outputDir` (or call the `runToDirectory()` helper) and the whole run is mirrored into
that directory: `invocation.json` (resolved command/args/cwd/startedAt), `events.jsonl` (one
hash-chained event per line, closed by an `ach.seal` record; see `ach verify-run`), `stdout.txt` / `stderr.txt`, `result.json`, and `status.json` — written atomically and
guaranteed to reach a terminal state `success | error | timeout | idle-timeout | aborted` on every
exit path, including watchdog kills and crashes:

```js
import { runToDirectory } from 'agentic-coding-harness';

const { result } = await runToDirectory({
  agent: 'codex',
  spec: { prompt: 'fix the failing test', timeoutMs: 120_000 },
  outputDir: '/var/run/watchdog/job-42',
});
// /var/run/watchdog/job-42/status.json survives even a killed run:
// { "runId": "...", "status": "timeout", "updatedAt": ..., "eventCount": 7, ... }
```

## `ach web`: the browser dashboard in detail

`ach web` (default port 8399) serves a same-origin browser dashboard over the same state dir:

- **`/`** — one run in full: a structured live feed built from the persisted `AgentEvent` rows
  (text, expandable tool-call/result cards, warnings, usage, exit status), streamed over `/ws?runId=`.
  For claude, codex, gemini and opencode runs every row ends in a context-window gauge
  (`212.9k 21%`, teal / yellow ≥50% / red ≥80%, red tick at the 85% warn threshold). Tool rows show
  the last model call's value dimmed; a yellow `+Δ` marks the call that grew it; hover for the
  input · cache-read · cache-write breakdown. The server computes it with the same context meter as
  `usage.context` (see [TOKEN-COUNTING.md §5](docs/TOKEN-COUNTING.md)); an unknown window shows tokens only.
- **`/grid`** — every run as a tile, each tile body carrying that same feed. A green **LIVE** button
  on a tile spawns an interactive PTY for the run's agent (`claude`, `opencode`, `kiro-cli`,
  `codex`, `gemini`, else `bash -i`) and expands the tile to a full-width xterm.js pane you can type
  into; the feed stays visible as a strip above it. Closing the pane kills the PTY.
- **`/trio?run=<runId>`** — traces | metrics | logs for one run, plus a **FEED | LIVE TERMINAL**
  drawer: FEED is the default and shows the same structured feed, LIVE TERMINAL mounts the PTY pane.
- **`/compare`** — sortable rollup table over all runs, grouped by experiment×variant or
  workflow×agent (`GET /api/compare?by=…` returns the rows as JSON: `runs`, `avgTotalTokens`,
  `avgCostUsd`, `avgDurationMs`, `successRate` per group).
- **`/queues`** (+ `GET /api/queues`) — queued / running / done per slice for every `ach queue run`
  queue that is running or ended in the last 24 h ([docs/QUEUE.md](docs/QUEUE.md)). Token-gated when `--token` is set.
- **`/health`** — liveness plus the configured run source and whether it is healthy
  (`source`, `sourceHealthy`).

The PTY relay is `POST /api/pty` (spawn) / `GET /api/pty` (list) / `POST /api/pty/<id>/kill` and the
`/ws/pty/<id>` websocket (server→client raw PTY bytes, client→server keystrokes and `resize` frames).
Agents are spawned with their non-interactive flags so a live pane does not die on a trust prompt.
`--token` gates every websocket and PTY route. All assets are vendored under `/vendor/` — no CDN.
PTY attach is local-only by construction: runs arriving from an external feed (`--source`) are
refused with `409` and their tiles show no LIVE button, since there is no local process to attach to.

Every run also serves an asciinema-format terminal replay at
`/api/runs/<runId>/cast` — the same event stream rendered as a scrubbable `.cast`.

### Watching external run feeds: `--source`

`ach web` normally serves runs from its local state dir. Pass `--source <url>` and it instead
watches a remote feed of run records — one dashboard in front of many machines:

| flag | env | meaning |
|---|---|---|
| `--source <url>` | `AGENTIC_CODING_HARNESS_SOURCE` | base URL of the external run feed |
| `--source-token <t>` | `AGENTIC_CODING_HARNESS_SOURCE_TOKEN` | bearer token sent on every feed request (defaults to `--token`) |
| `--source-mode poll\|sse\|ws` | `AGENTIC_CODING_HARNESS_SOURCE_MODE` | snapshot polling, Server-Sent Events, or WebSocket (default `poll`) |
| `--source-poll-ms <n>` | `AGENTIC_CODING_HARNESS_SOURCE_POLL_MS` | poll interval in ms (default 3000; ignored for sse/ws) |
| `--source-merge state\|only` | `AGENTIC_CODING_HARNESS_SOURCE_MERGE` | `only` (default) serves the external feed alone; `state` unions it with the local state dir, external records winning on `runId` collision |

The feed contract mirrors this dashboard's own API: `GET {source}/runs` →
`200 {"records": [<RunRecord>...]}` (the same shape as `GET /api/runs`, and the only endpoint every
mode polls). For live updates the source may additionally expose SSE at `GET {source}/runs/stream`
(each event `event: runs` with `data: {"records":[...]}`) or a WebSocket at `GET {source}/runs/ws`
sending `{"type":"runs","records":[...]}` frames. Records that fail schema validation are dropped
with a counted warning — one malformed record never poisons the dashboard.

### External producers: writing runs into a dashboard's registry

The feed endpoint is the same shape the package itself serves (`GET /api/runs`), so a second
`ach web` (or any producer that holds the same state-dir layout) can be a source. Producers that
live in-process can push records directly through the public API: parse with `RunRecordSchema`,
persist with `writeRunRecord`, and the dashboard's fs watcher picks it up:

```ts
import { RunRecordSchema, writeRunRecord } from 'agentic-coding-harness';

const rec = RunRecordSchema.parse({
  runId: 'job-42', agent: 'claude', startedAt: Date.now(), status: 'success',
  totals: { inputTokens: 4812, outputTokens: 933, cacheReadTokens: 38204, cacheWriteTokens: 1120, costUsd: 0.0612 },
  source: 'external', producer: 'my-orchestrator',
});
writeRunRecord(stateDir, rec);   // lands in <stateDir>/runs/<runId>.json
```

## Budgets and spend caps: stop runaway LLM spend mid-run

Spend thresholds warn by default and continue the run. Add `--on-budget abort` for
mid-run spend enforcement. Time and turn limits still stop the run and record why in `exitStatus`.

| limit      | flag           | env default                 | enforcement                          | default                  |
|------------|----------------|-----------------------------|--------------------------------------|--------------------------|
| spend      | `--budget-usd` | `AGENTIC_CODING_HARNESS_BUDGET_USD`  | warn; `--on-budget abort` opts into `budget_exceeded` | unlimited                |
| turns      | `--max-turns`  | `AGENTIC_CODING_HARNESS_MAX_TURNS`   | abort, `exitStatus: turn_limit`      | claude 250, others unset |
| wall clock | `--wall-ms`    | `AGENTIC_CODING_HARNESS_WALL_MS`     | abort, `exitStatus: timeout`         | unlimited                |
| idle gap   | `--idle-ms`    | `AGENTIC_CODING_HARNESS_IDLE_MS`     | abort, `exitStatus: timeout`         | unlimited                |

Precedence: per-run flag > env default > built-in default. Claude enforces its turn cap natively
(`--max-turns`); the driver enforces the rest against the live event stream.

## Docs

- [Cost modes and provenance](docs/PROVENANCE.md), [billing blocks and plan estimates](docs/USAGE-WINDOWS.md), [quota headroom](docs/QUOTA.md).
- [Budget/context alerts](docs/BUDGET-ALERTS.md), [status and statusline](docs/STATUS.md), [exit-code ladder](docs/EXIT-CODES.md).
- [Replay-case vetting (`ach replay vet <pr>`)](docs/REPLAY.md), [verified trials and regrading](docs/TRIALS.md), [custom agents](docs/CUSTOM-AGENTS.md), [transcript adapters](docs/transcript-adapters.md).
- [Archive and retention](docs/ARCHIVE.md), [doctor](docs/doctor.md), [packaging and release](docs/PACKAGING.md).
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — adapter pattern (headless / ACP / tmux lanes),
  token taps, canonical token record, ATIF, OTel transport, state manifests, data-flow diagram.
- [`docs/TOKEN-COUNTING.md`](docs/TOKEN-COUNTING.md) — per-agent usage field reference,
  double-counting traps, cost formula.
- [`docs/MCP.md`](docs/MCP.md) — MCP server: client configs (opencode, Claude Code), tool
  reference, worked example, troubleshooting.
- [Context diet kit](docs/CONTEXT-DIET.md) — measure subagent startup tokens (`ablate.sh`), mine skill usage,
  lint skill descriptions, and a lean subagent template.
- [`docs/TOOLHIVE.md`](docs/TOOLHIVE.md) — host deployment behind a ToolHive gateway: HTTP
  serve lane, async job lifecycle, gateway profile, secret forwarding, client configs.

## Examples

| Script | What it shows |
|---|---|
| [`examples/trial-matrix.json`](examples/trial-matrix.json) | a 3×3 `ach trial --matrix` plan on the offline `null` agent: `ach trial --matrix examples/trial-matrix.json --dry-run`, then without `--dry-run`; kill it and re-run to watch it resume from the `.ledger.jsonl` |
| [`examples/trial-all.sh`](examples/trial-all.sh) | trials every agent with both CLI and adapter installed; prints agent / tokens / cost / duration / status; skips the rest. For repeatable, resumable sweeps use `ach trial --matrix` |
| [`examples/monitor-live.sh`](examples/monitor-live.sh) | `watch` in background + sample `run` + the delta lines appearing + `stats` |
| [`examples/emit-atif.ts`](examples/emit-atif.ts) | run → `AtifWriter.fromEvents` → `trajectory.json` → validate |

## Develop

```sh
bun install && bun run build:node && bun link   # put `ach` on PATH from a checkout (dist/ is built, not tracked)
npm run typecheck   # tsc --noEmit
npm test            # tsx --test (canonical runner)
bun test            # same suite under bun
```

Both runners execute the identical suite. `tests/` re-export shims are not
allowed: `node:test` counts an imported suite again while `bun test`
deduplicates it by qualified name, silently skewing the counts.
