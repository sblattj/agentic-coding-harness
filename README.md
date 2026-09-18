# agentic-coding-harness — cost tracking and observability for Claude Code, Codex CLI, Gemini CLI, OpenCode, and Kiro

<p>
  <a href="https://www.npmjs.com/package/agentic-coding-harness"><img alt="npm version" src="https://img.shields.io/npm/v/agentic-coding-harness"></a>
  <a href="https://pypi.org/project/agentic-coding-harness/"><img alt="PyPI version" src="https://img.shields.io/pypi/v/agentic-coding-harness"></a>
  <a href="LICENSE"><img alt="MIT license" src="https://img.shields.io/badge/license-MIT-blue"></a>
  <img alt="Node.js 18.19 or newer" src="https://img.shields.io/badge/node-%3E%3D18.19-brightgreen">
</p>

**Agents hide the burn. This is the receipt — tokens, credits, and dollars, verified against each CLI's own records.**

`agentic-coding-harness` (`ach`) runs, watches, and meters AI coding agents from one CLI.
Launch headless runs on **Claude Code, Codex CLI, Gemini CLI, OpenCode, or Kiro** and get
token usage — input, output, cache read, cache write, reasoning — plus per-model cost,
Kiro metering credits, and duration for every run. Costs are not estimated guesses: the
cache-aware accounting is verified against each CLI's own ground-truth records (Claude
session JSONL, Kiro session files, provider-reported `costUSD`). Every run persists as a
replayable artifact — an ATIF trajectory, OpenTelemetry `gen_ai` spans, a Langfuse trace,
or a single-file HTML report — and a live terminal dashboard, web dashboard, and MCP
server put usage, cost, and credits for all five agents on one screen.

![Live web dashboard grid showing token usage and cost across concurrent Claude Code and Kiro agent runs, with interactive terminal panes](docs/assets/dashboard.gif)

```sh
npm install -g agentic-coding-harness    # or: pip install agentic-coding-harness
ach run --agent claude "add a --dry-run flag to scripts/lint.sh"
ach web                                  # live dashboard on :8399
```

## Demo: one task, five agents, one cost table

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

![Per-run summary showing token usage broken into input, output, cache read, cache write, and reasoning, with cost and duration, for a Claude Code run](docs/assets/cli-run-summary.png)

## The problem: coding agents hide token usage and cost

- **Agents hide burn.** Kiro exposes metering credits, not tokens; Claude mixes models inside one
  session, so any single blended price is wrong. Each adapter taps usage at its source and prices
  per (model, cache tier). Kiro credits stay on their own summary line — never merged into USD.
- **Every CLI speaks a different format.** JSONL transcripts, NDJSON stdout, ACP, SQLite — five
  adapters normalize all of it into one event model and one `CanonicalTokenRecord` (with
  cache-read/write/reasoning split), so dash, stats, emitters, and the MCP server are written once.
- **Nothing correlated runs across agents — until now.** Runs land in a registry keyed by trial
  dir; `examples/trial-all.sh` side-by-sides, HTML comparison reports, and cross-agent stats are
  first-class, not shell archaeology.
- **Numbers you can defend.** Token/cost columns are checked against ground truth: cache columns
  exact vs each CLI's own session JSONL; Kiro MITM credits bit-for-bit vs Kiro's session files.

## What it does: token metering, verified cost tracking, and run artifacts for five agents

- **Five adapters** — `claude`, `opencode`, `kiro`, `codex`, `gemini` (headless / ACP lanes).
- **Unified events, cache-aware tokens** — one `AgentEvent` stream, one canonical token record;
  per-agent double-counting traps handled ([docs/TOKEN-COUNTING.md](docs/TOKEN-COUNTING.md)).
- **LiteLLM multi-model pricing** — bundled LiteLLM extract, external cost-map override;
  unpriced models warn and contribute 0, never silently.
- **Kiro MITM credit tap** — auto-starts on `ach run --agent kiro` when `mitmdump` is on
  PATH; captures metering credits (`extra.credits`) and the native `kiroSession` id for grep
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
- **MCP server** — stdio JSON-RPC, 10 tools (`harness_run{,_async,_status,_events,_cancel}`, `harness_kiro_preflight`, `report/emit/stats/agents`) so any MCP
  client launches runs and reads usage; see [docs/MCP.md](docs/MCP.md).
- **Emitters** — ATIF v1.7 trajectories (self-validating), OTel `gen_ai` spans, Langfuse via OTLP.
- **Single-file HTML reports** — charts + timelines comparing every agent in a trial dir.
- **`watch` / `stats`** — live per-session token deltas across claude/codex/gemini transcript
  dirs plus the opencode SQLite store; `stats` aggregates totals/byAgent/byDay over machine
  transcripts and harness state (`--state-only` to skip transcript scans).

## Compare coding agents side by side — tokens, cost, credits, duration

Run the same task on every installed agent and get a single comparison: tokens in/out/cache,
cost, wall-clock duration, and status per agent. No manual log diffing.

![Cross-agent comparison table showing token usage, cost, duration, and status for Claude Code, Codex CLI, Gemini CLI, OpenCode, and Kiro run on the same task](docs/assets/cli-compare.png)

## Live dashboards: terminal (`ach dash`) and web (`ach web`)

**Web** — a tmux-like grid of every run, plus an observability view per run. A **LIVE** button
spawns an interactive PTY for the run's agent and expands the tile to a full xterm.js terminal
you can type into.

![Web dashboard terminal grid showing live agent run tiles with token and cost readouts and interactive terminal panes](docs/assets/web-grid.png)

**Observability trio** — traces, metrics, and logs for a single run, with a live terminal
drawer: the span waterfall, cumulative token/cost charts, and the leveled event log.

![Observability view showing the traces waterfall, token and cost metric cards with charts, and the event log stream for a single coding agent run](docs/assets/web-trio.png)

**Terminal** — `ach dash` is a live TUI over the run registry (redraws 2×/s, ANSI status
glyphs, totals footer); `--json` dumps RunRecords for tools.

## CLI

```sh
ach run --agent <claude|opencode|kiro|codex|gemini> [--model M] [--resume SID]
            [--budget-usd N] [--max-turns N] [--wall-ms N] [--idle-ms N] [--json] "prompt"
            kiro only: [--kiro-transport headless|acp] [--kiro-agent A] [--kiro-engine v1|v2|v3]
                       [--kiro-effort E] [--kiro-tools all|none|a,b] [--kiro-require-mcp-startup]
                       [--kiro-startup-ms N] [--kiro-require-model-ack] [--kiro-mcp-server '<json>']...
            claude only: [--claude-default-config]   # default CLAUDE_CONFIG_DIR (keychain OAuth)
ach preflight --agent kiro [--model M] [--kiro-agent A] [--json]   # verify config, no prompt
ach watch [--dir <transcriptDir>]              # live per-session token deltas
ach stats [--agent A] [--days N] [--json] [--state-only]
ach emit --input events.json --format atif|otel|langfuse [--out path]
            [--agent A] [--model M] [--session-id SID]
            (langfuse auth: --langfuse-url/--langfuse-public-key/--langfuse-secret-key or env)
ach report <trials-dir> [--out path]           # single-file HTML comparison
ach dash [--json] [--all] [--dir <stateDir>]   # live run dashboard; q quits
ach web [trials-dir] [--port N=8399] [--host H] [--token T] [--dir D] [--no-open]
          [--source URL] [--source-token T] [--source-mode poll|sse|ws]
          [--source-poll-ms N=3000] [--source-merge state|only]
```

The binary is `ach` (the npm/PyPI package name is `agentic-coding-harness`). Budget flags (`--budget-usd`, `--max-turns`,
`--wall-ms`, `--idle-ms`) take per-run values; `AGENTIC_CODING_HARNESS_BUDGET_USD`, `AGENTIC_CODING_HARNESS_MAX_TURNS`,
`AGENTIC_CODING_HARNESS_WALL_MS`, `AGENTIC_CODING_HARNESS_IDLE_MS` supply env defaults. State lives under
`~/.agentic-coding-harness` (`AGENTIC_CODING_HARNESS_STATE_DIR`).

Claude runs get a fresh per-run `CLAUDE_CONFIG_DIR` under the state dir so transcripts are captured
by construction. On a Mac whose Claude Code login is keychain-bound OAuth (no
`~/.claude/.credentials.json`) that dir cannot see the token and every run ends `Not logged in`;
pass `--claude-default-config` (or set `AGENTIC_CODING_HARNESS_DEFAULT_CLAUDE_CONFIG=1`) to run against the
default config instead. Transcripts then land under `~/.claude/projects` and concurrent claude runs
share one config, so pair it with sequential runs when isolation matters.

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
`CodexAdapter`, `GeminiAdapter`, `OpenCodeAdapter`, `VERSION`, plus the run-record API —
`RunRecordSchema`, `CanonicalTokenRecordSchema`, `ExternalRunFeedSchema`, `writeRunRecord`,
`readRunRecord`, `listRunIds`, `listRunRecords`, `registryDir`, and the `RunRecord` /
`CanonicalTokenRecord` / `ExternalRunFeed` / `RunSource` types. `DriverOptions.onOutput` / `RunSpec.onOutput` give a
raw stdout tap (each chunk exactly as received) alongside the parsed canonical events. Importing the
`ach` bin bundle (`dist/cli/ach.js`) as a module yields the same exports with no side effects.

### Run-to-directory mode (durable status.json)

Give a run an `outputDir` (or call the `runToDirectory()` helper) and the whole run is mirrored into
that directory: `invocation.json` (resolved command/args/cwd/startedAt), `events.jsonl` (one event
per line), `stdout.txt` / `stderr.txt`, `result.json`, and `status.json` — written atomically and
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
- **`/grid`** — every run as a tile, each tile body carrying that same feed. A green **LIVE** button
  on a tile spawns an interactive PTY for the run's agent (`claude`, `opencode`, `kiro-cli`,
  `codex`, `gemini`, else `bash -i`) and expands the tile to a full-width xterm.js pane you can type
  into; the feed stays visible as a strip above it. Closing the pane kills the PTY.
- **`/trio?run=<runId>`** — traces | metrics | logs for one run, plus a **FEED | LIVE TERMINAL**
  drawer: FEED is the default and shows the same structured feed, LIVE TERMINAL mounts the PTY pane.
- **`/compare`** — sortable rollup table over all runs, grouped by experiment×variant or
  workflow×agent (`GET /api/compare?by=…` returns the rows as JSON: `runs`, `avgTotalTokens`,
  `avgCostUsd`, `avgDurationMs`, `successRate` per group).
- **`/health`** — liveness plus the configured run source and whether it is healthy
  (`source`, `sourceHealthy`).

The PTY relay is `POST /api/pty` (spawn) / `GET /api/pty` (list) / `POST /api/pty/<id>/kill` and the
`/ws/pty/<id>` websocket (server→client raw PTY bytes, client→server keystrokes and `resize` frames).
Agents are spawned with their non-interactive flags so a live pane does not die on a trust prompt.
`--token` gates every websocket and PTY route. All assets are vendored under `/vendor/` — no CDN.
PTY attach is local-only by construction: runs arriving from an external feed (`--source`) are
refused with `409` and their tiles show no LIVE button, since there is no local process to attach to.

### Watching external run feeds: `--source`

`ach web` normally serves runs from its local state dir. Pass `--source <url>` and it instead
watches a remote feed of run records — one dashboard in front of many machines:

| flag | env | meaning |
|---|---|---|
| `--source <url>` | `AGENTIC_CODING_HARNESS_SOURCE` | base URL of the external run feed |
| `--source-token <t>` | `AGENTIC_CODING_HARNESS_SOURCE_TOKEN` | bearer token sent on every feed request |
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

## Budgets and spend caps: stop a runaway agent mid-run

Every limit aborts the run mid-flight and records why in `exitStatus`.

| limit      | flag           | env default                 | enforcement                          | default                  |
|------------|----------------|-----------------------------|--------------------------------------|--------------------------|
| spend      | `--budget-usd` | `AGENTIC_CODING_HARNESS_BUDGET_USD`  | abort, `exitStatus: budget_exceeded` | unlimited                |
| turns      | `--max-turns`  | `AGENTIC_CODING_HARNESS_MAX_TURNS`   | abort, `exitStatus: turn_limit`      | claude 250, others unset |
| wall clock | `--wall-ms`    | `AGENTIC_CODING_HARNESS_WALL_MS`     | abort, `exitStatus: timeout`         | unlimited                |
| idle gap   | `--idle-ms`    | `AGENTIC_CODING_HARNESS_IDLE_MS`     | abort, `exitStatus: timeout`         | unlimited                |

Precedence: per-run flag > env default > built-in default. Claude enforces its turn cap natively
(`--max-turns`); the driver enforces the rest against the live event stream.

## Docs

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — adapter pattern (headless / ACP / tmux lanes),
  token taps, canonical token record, ATIF, OTel transport, state manifests, data-flow diagram.
- [`docs/TOKEN-COUNTING.md`](docs/TOKEN-COUNTING.md) — per-agent usage field reference,
  double-counting traps, cost formula.
- [`docs/MCP.md`](docs/MCP.md) — MCP server: client configs (opencode, Claude Code), tool
  reference, worked example, troubleshooting.
- [`docs/TOOLHIVE.md`](docs/TOOLHIVE.md) — host deployment behind a ToolHive gateway: HTTP
  serve lane, async job lifecycle, gateway profile, secret forwarding, client configs.

## Examples

| Script | What it shows |
|---|---|
| [`examples/trial-all.sh`](examples/trial-all.sh) | trials every agent with both CLI and adapter installed; prints agent / tokens / cost / duration / status; skips the rest |
| [`examples/monitor-live.sh`](examples/monitor-live.sh) | `watch` in background + sample `run` + the delta lines appearing + `stats` |
| [`examples/emit-atif.ts`](examples/emit-atif.ts) | run → `AtifWriter.fromEvents` → `trajectory.json` → validate |

## Develop

```sh
npm run typecheck   # tsc --noEmit
npm test            # tsx --test (canonical runner)
bun test            # same suite under bun
```

Both runners execute the identical suite. `tests/` re-export shims are not
allowed: `node:test` counts an imported suite again while `bun test`
deduplicates it by qualified name, silently skewing the counts.
