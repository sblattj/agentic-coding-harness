# MCP server

`src/mcp/index.ts` is a stdio MCP server that exposes the harness to any MCP
client (opencode, Claude Code, ...): launch coding-agent runs, emit ATIF/OTel/
Langfuse trajectories, render comparison reports, and read stats over JSON-RPC
2.0 instead of shelling out to the CLI. Protocol contract lives in
[`src/mcp/contract.ts`](../src/mcp/contract.ts) (MCP `2025-06-18`, newline-
delimited stdio).

## Client config

opencode (`opencode.json`) — local server, `command` array:

```json
{
  "mcp": {
    "agent-harness": {
      "type": "local",
      "command": ["bun", "/absolute/path/to/agent-harness/src/mcp/index.ts"],
      "enabled": true
    }
  }
}
```

Claude Code (`.mcp.json`):

```json
{
  "mcpServers": {
    "agent-harness": {
      "command": "bun",
      "args": ["/absolute/path/to/agent-harness/src/mcp/index.ts"]
    }
  }
}
```

Both shapes accept a per-server `env` key; set `AGENT_HARNESS_STATE_DIR` there
to move state off the default `~/.agent-harness`.

## Tools

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

Returns the run summary: agent, status, tokens, cost, duration, run/trial dir.

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
