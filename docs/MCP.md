# MCP server

`ach mcp` runs a stdio MCP server that exposes the harness to any MCP
client (opencode, Claude Code, ...): launch coding-agent runs, emit ATIF/OTel/
Langfuse trajectories, render comparison reports, and read stats over JSON-RPC
2.0 instead of shelling out to the CLI. Install the package and run
`ach mcp` (or `npx -y agentic-coding-harness mcp`); from a repo checkout,
`bun src/mcp/index.ts` still works. Protocol contract lives in
[`src/mcp/contract.ts`](../src/mcp/contract.ts) (MCP `2025-06-18`, newline-
delimited stdio).

## Client config

Installed `ach` (or npx) — run `ach mcp` as a child process:

opencode (`opencode.json`) — local server, `command` array:

```json
{
  "mcp": {
    "agentic-coding-harness": {
      "type": "local",
      "command": ["npx", "-y", "agentic-coding-harness", "mcp"],
      "enabled": true
    }
  }
}
```

Claude Code (`.mcp.json`):

```json
{
  "mcpServers": {
    "agentic-coding-harness": {
      "command": "npx",
      "args": ["-y", "agentic-coding-harness", "mcp"]
    }
  }
}
```

From a checkout, point the same shapes at the source instead: opencode
`"command": ["bun", "/absolute/path/to/agentic-coding-harness/src/mcp/index.ts"]`,
Claude Code `"command": "bun", "args": ["/absolute/path/to/.../src/mcp/index.ts"]`.

Both shapes accept a per-server `env` key; set `AGENTIC_CODING_HARNESS_STATE_DIR` there
to move state off the default `~/.agentic-coding-harness`.

## Transports

`ach mcp` serves stdio: newline-delimited JSON-RPC (Content-Length framing
tolerated) on stdin/stdout, spawned locally by the client — no port, host, or
token. stdout carries protocol messages only, diagnostics go to stderr, and
JSON-RPC batch arrays are supported.

- stdio — `ach mcp`; locally spawned, protocol-only stdout, batch arrays supported.
- streamable HTTP — `ach serve`; `POST /mcp`, `GET /health` probe, optional
  bearer token (`--token` or `AGENTIC_CODING_HARNESS_HTTP_TOKEN`).
- Shared-host / gateway deployment behind ToolHive: [docs/TOOLHIVE.md](TOOLHIVE.md).

## Tools

`tools/list` exposes ten tools: `harness_run`, `harness_run_async`,
`harness_run_status`, `harness_run_events`, `harness_run_cancel`,
`harness_kiro_preflight`, `harness_report`, `harness_emit`, `harness_stats`,
`harness_agents`. Sections below cover the main ones; the async job tools
(`harness_run_async` / `_status` / `_events` / `_cancel`) submit a long run and
poll, page, or cancel it — see [docs/TOOLHIVE.md](TOOLHIVE.md).

### harness_run

Run one task on one agent.

| name | type | required | description |
|---|---|---|---|
| agent | string | yes | claude / codex / opencode / gemini / kiro |
| prompt | string | yes | task prompt |
| model | string | no | model override |
| cwd | string | no | working directory |
| budgetUsd | number | no | spend cap |
| maxTurns | number | no | turn cap |
| extraArgs | string[] | no | passthrough CLI flags |
| kiro | object | no | Kiro-only config (see below); ignored by other agents |

`kiro` accepts: `transport` (`headless` \| `acp`), `agent` (native agent / ACP
mode id), `engine` (`v1` \| `v2` \| `v3`), `effort` (`low` \| `medium` \|
`high` \| `xhigh` \| `max`), `tools` (`"all"` \| `"none"` \| `string[]`;
omit to leave the native agent config in charge), `requireMcpStartup`
(boolean), `mcpServers` (ACP only: `{name, command, args?, env?}[]` forwarded
to `session/new`), `startupMs` (number, default 60000) and `requireModelAck`
(boolean). Unknown keys are rejected by name.

The same `kiro` object is accepted by `harness_run_async` (docs/TOOLHIVE.md).

Returns the run summary: agent, status, tokens, cost, duration, run/trial dir.

### harness_kiro_preflight

Prove a Kiro run's configuration **without spending a token**: it runs
`kiro-cli --version` and `kiro-cli whoami`, then a real ACP handshake
(`initialize` → `session/new` → `session/set_model`) and closes the session.
It never sends `session/prompt`.

| name | type | required | description |
|---|---|---|---|
| cwd | string | no | working directory for the kiro-cli subprocess |
| model | string | no | model whose availability and `set_model` ack to verify |
| kiro | object | no | same Kiro config object as `harness_run` |
| extraArgs | string[] | no | passthrough CLI flags (gateway-filtered) |

Returns `{ ok, checks[], unproven[], receipt }`. Each check is
`{ name, status, detail, ms }` with `name` one of `executable`, `version`,
`auth`, `agent`, `model`, `modelAck`, `mcp`, `extraArgs` and `status` one of
`verified` / `failed` / `unproven`; `ok` is true only when nothing failed.
`unproven` always lists `task success` and `downstream tool dependencies` — a
green preflight is a statement about configuration, never about outcome.

Note on `mcp`: kiro-cli 2.21.2 emits `_kiro.dev/mcp/governance_disabled` on
every session, including healthy ones with no MCP servers, so the notice alone
reports `unproven`. It only fails the check when the caller asked for MCP to
matter (`kiro.requireMcpStartup`, or `kiro.mcpServers` actually forwarded).

CLI equivalent: `harness preflight --agent kiro [--model M] [--kiro-agent A] [--json]`.

### harness_report

Render a finished trial as the single-file HTML comparison report.

| name | type | required | description |
|---|---|---|---|
| dir | string | yes | trials dir, e.g. `trials/20260910-091011` |
| out | string | no | output path (default `<dir>/report.html`) |
| open | boolean | no | open in browser after render |

Returns `{ path }`.

### harness_emit

Emit a recorded run as an artifact.

| name | type | required | description |
|---|---|---|---|
| runFile | string | yes | recorded events file |
| format | string | yes | `atif` \| `otel` \| `langfuse` |
| out | string | no | write to path |
| endpoint | string | no | POST target (langfuse) |

Returns `{ path }`, or the artifact body when no `out`.

### harness_stats

Usage stats across recorded runs.

| name | type | required | description |
|---|---|---|---|
| sinceDays | number | no | time window |
| agent | string | no | filter to one agent |

Returns per-agent rows: runs, tokens, cost.

### harness_agents

List installed agents (CLI + adapter both present). No args. Returns one row
per agent with its name and adapter kind.

## Worked example

Prompt to your MCP client:

> Run a snake-game build on claude and on kiro, then render the comparison report.

The client resolves it into three `tools/call` invocations:

```json
{"tool": "harness_run", "args": {"agent": "claude", "prompt": "build a snake game"}}
{"tool": "harness_run", "args": {"agent": "kiro", "prompt": "build a snake game"}}
{"tool": "harness_report", "args": {"dir": "trials/<newest-dir-containing-both>", "open": true}}
```

## Troubleshooting

- Protocol on **stdout only**, diagnostics on **stderr**. If the client parses
  garbage, something is printing to stdout.
- Client hangs at startup: check `bun --version` >= 1.3 (NDJSON stdio framing).
- `ach mcp` needs Node >= 18.19 only — the `bun --version` note applies to the
  `bun src/mcp/index.ts` checkout form.
