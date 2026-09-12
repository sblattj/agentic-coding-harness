# agent-harness

Headless orchestration and observability over coding-agent CLIs — Claude Code, OpenCode, Kiro,
Codex CLI, Gemini CLI. One normalized event model regardless of vendor; per-token, per-credit,
per-cost accounting verified against each CLI's own ground-truth records; every run persisted as
a replayable artifact (ATIF v1.7 trajectory, OTel `gen_ai` spans, Langfuse trace, single-file
HTML report). One binary, two names: `harness` and `agh`.

## Demo

Representative session — output shapes are the real ones (`formatSummary` in `src/cli/lib.ts`,
the table in `src/cli/dash.ts`); values illustrative:

```console
$ harness run --agent claude --max-turns 40 "add a --dry-run flag to scripts/lint.sh"
[14:03:11] step
[14:03:13] tool    Read
[14:03:19] tool    Edit
[14:03:24] step
sessionId  7c1f0a2e-4b9d-4e1a-9c33-8f2a1d5b6e70
tokens     input=4,812 output=933 cacheRead=38,204 cacheWrite=1,120 reasoning=640
cost       $0.0612
duration   31.4s
exit       success

$ agh dash
harness dash — /Users/me/.agent-harness
STATUS AGENT    RUNID    SESSION  ELAPSED       IN      OUT     CACHE     COST  CREDITS LAST EVENT
+      claude   7c1f0a2e 7c1f0a2e     31s     4.8k     933    39.3k  $0.0612          step
●      kiro     91b3ce11 91b3ce11     12s       0       0        0  $0.0000   0.05cr tool    Bash

2 runs  in 4.8k  out 933  cost $0.0612  credits 0.05cr  q quit

$ agh dash --json | jq -c '.[0] | {agent, runId, status, cost: .totals.costUsd}'
{"agent":"claude","runId":"7c1f0a2e-4b9d-4e1a-9c33-8f2a1d5b6e70","status":"success","cost":0.0612}

$ harness report trials/20260911-141210
wrote trials/20260911-141210/report.html

$ harness emit --input trials/20260911-141210/claude.json --format langfuse
langfuse: posted 27 spans to http://localhost:3000 — trace 3f2a91c0-8e47-4b1d-9a55-2c6f8d901b3e (HTTP 200)

$ examples/trial-all.sh            # same task on every installed agent, then the comparison
skip: codex (CLI not installed)
task: List the files in the current directory and summarize the project in 3 bullet points
out:  /Users/me/src/agent-harness/trials/20260911-142401
run:  claude
run:  kiro

AGENT      INPUT     OUTPUT      CACHE       COST     DUR_S STATUS
---------- ---------- ---------- ---------- ---------- ------
claude         4812        933      39324     0.0612       31 success
kiro              0          0          0        n/a       44 success
```

## Why it exists

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

## Features

- **Five adapters** — `claude`, `opencode`, `kiro`, `codex`, `gemini` (headless / ACP lanes).
- **Unified events, cache-aware tokens** — one `AgentEvent` stream, one canonical token record;
  per-agent double-counting traps handled ([docs/TOKEN-COUNTING.md](docs/TOKEN-COUNTING.md)).
- **LiteLLM multi-model pricing** — bundled LiteLLM extract, external cost-map override;
  unpriced models warn and contribute 0, never silently.
- **Kiro MITM credit tap** — auto-starts on `harness run --agent kiro` when `mitmdump` is on
  PATH; captures metering credits (`extra.credits`) and the native `kiroSession` id for grep
  correlation; degrades to a warning when absent.
- **Kiro ACP transport + preflight** — `--kiro-transport acp` drives `kiro-cli acp` over JSON-RPC
  and records the *proven* mode/model (`result.kiro.modelAck`); the default headless lane forwards
  the same `--model`/`--kiro-*` config and records what it passed, with no implicit
  `--trust-all-tools`; `harness preflight --agent kiro`
  and `harness_kiro_preflight` verify binary, auth, agent, model and MCP state without sending a
  prompt. Token counts are reported `n/a` when no source carries them (kiro-cli 2.21.x) — never
  fabricated zeros; credits and derived context tokens are shown instead. See
  [docs/KIRO.md](docs/KIRO.md).
- **Run registry + `agh dash`** — live TUI over `<stateDir>/runs` (redraws 2×/s, ANSI status
  glyphs, totals footer); `--json` dumps RunRecords for tools, `--all` widens past the last hour.
- **MCP server** — stdio JSON-RPC, 10 tools (`harness_run{,_async,_status,_events,_cancel}`, `harness_kiro_preflight`, `report/emit/stats/agents`) so any MCP
  client launches runs and reads usage; see [docs/MCP.md](docs/MCP.md).
- **Emitters** — ATIF v1.7 trajectories (self-validating), OTel `gen_ai` spans, Langfuse via OTLP.
- **Single-file HTML reports** — charts + timelines comparing every agent in a trial dir.
- **`watch` / `stats`** — live per-session token deltas across claude/codex/gemini transcript
  dirs plus the opencode SQLite store; `stats` aggregates totals/byAgent/byDay over machine
  transcripts and harness state (`--state-only` to skip transcript scans).

## CLI

```sh
harness run --agent <claude|opencode|kiro|codex|gemini> [--model M] [--resume SID]
            [--budget-usd N] [--max-turns N] [--wall-ms N] [--idle-ms N] [--json] "prompt"
            kiro only: [--kiro-transport headless|acp] [--kiro-agent A] [--kiro-engine v1|v2|v3]
                       [--kiro-effort E] [--kiro-tools all|none|a,b] [--kiro-require-mcp-startup]
                       [--kiro-startup-ms N] [--kiro-require-model-ack] [--kiro-mcp-server '<json>']...
harness preflight --agent kiro [--model M] [--kiro-agent A] [--json]   # verify config, no prompt
harness watch [--dir <transcriptDir>]              # live per-session token deltas
harness stats [--agent A] [--days N] [--json] [--state-only]
harness emit --input events.json --format atif|otel|langfuse [--out path]
            [--agent A] [--model M] [--session-id SID]
            (langfuse auth: --langfuse-url/--langfuse-public-key/--langfuse-secret-key or env)
harness report <trials-dir> [--out path]           # single-file HTML comparison
harness dash [--json] [--all] [--dir <stateDir>]   # live run dashboard; q quits
```

`agh` is the same binary (`package.json` `bin`). Budget flags (`--budget-usd`, `--max-turns`,
`--wall-ms`, `--idle-ms`) take per-run values; `AGENT_HARNESS_BUDGET_USD`, `AGENT_HARNESS_MAX_TURNS`,
`AGENT_HARNESS_WALL_MS`, `AGENT_HARNESS_IDLE_MS` supply env defaults. State lives under
`~/.agent-harness` (`AGENT_HARNESS_STATE_DIR`).

## Limits & budgets

Every limit aborts the run mid-flight and records why in `exitStatus`.

| limit      | flag           | env default                 | enforcement                          | default                  |
|------------|----------------|-----------------------------|--------------------------------------|--------------------------|
| spend      | `--budget-usd` | `AGENT_HARNESS_BUDGET_USD`  | abort, `exitStatus: budget_exceeded` | unlimited                |
| turns      | `--max-turns`  | `AGENT_HARNESS_MAX_TURNS`   | abort, `exitStatus: turn_limit`      | claude 250, others unset |
| wall clock | `--wall-ms`    | `AGENT_HARNESS_WALL_MS`     | abort, `exitStatus: timeout`         | unlimited                |
| idle gap   | `--idle-ms`    | `AGENT_HARNESS_IDLE_MS`     | abort, `exitStatus: timeout`         | unlimited                |

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
