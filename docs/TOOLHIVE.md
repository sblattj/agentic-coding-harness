# Running agentic-coding-harness behind ToolHive

Team deployment: agent execution runs on a host with the agent CLIs (claude,
codex, opencode, gemini, kiro) installed and authenticated. ToolHive supplies
the gateway/front door; `harness serve --http` runs on the host behind it, and
clients (Claude Code, OpenCode, Kiro, Codex) connect through it to the full
MCP toolset with no agent CLI of their own. For a single local client,
`ach mcp` (stdio) avoids the gateway entirely; this doc covers the shared-host
HTTP lane.

## Topology

```text
  Claude Code   OpenCode   Kiro   Codex              (client machines)
       \             |        |     /
        `------------+--------+----'
                     |  HTTPS, Bearer token
           ToolHive gateway (auth, TLS, routing)
                     |  loopback, Authorization: Bearer <token>
        harness serve --http --port 8398          (execution host)
                     |  host PATH + host auth
        agent CLIs (claude, codex, opencode, gemini, kiro)
```

Why host execution: the CLIs and their auth live on the host, not in the
clients. The server inherits the host environment wholesale — PATH resolves
the installed binaries and each CLI reads its own config dir — so a gateway
run behaves like one typed at the host's shell.

## Running the service

```sh
harness serve --http --port 8398 --token "$TOKEN"
```

- Binds loopback (`--host 127.0.0.1` default); Streamable HTTP MCP on
  `POST /mcp`, JSON responses, protocol version `2025-06-18`.
- `harness serve` defaults to port 8398 and `harness web` defaults to 8399,
  so both can run on one host without an explicit `--port`.
- Token: set `AGENTIC_CODING_HARNESS_HTTP_TOKEN` in the service env, or have ToolHive
  forward it as a secret into that env — never on argv (`ps` leaks argv).
  Flag wins over env; env over unset. No token anywhere means loopback-only
  binding plus a stderr warning that auth is off.
- Readiness: unauthenticated `GET /health` →
  `{"status":"ok","version":"0.6.1"}`; probe it before routing.
- Shutdown: SIGINT/SIGTERM stop accepting, drain 5s, then exit; in-flight
  async jobs are left as registry records (see Persistence).
- Registers every tool — sync run, kiro preflight, agents, report, emit,
  stats, four async job tools — ten under `tools/list`.

Shared deployments should add the gateway profile:

```sh
harness serve --http --gateway --root /srv/work --max-jobs 4
```

- `--gateway` requires `--root`; every `cwd` must resolve under root,
  rejected with an error naming the offending `cwd`; artifact paths
  (report `out`, emit `out`) stay under the state dir.
- `--max-jobs` (default 4) caps live async jobs; at the cap
  `harness_run_async` rejects with `-32603 max concurrent jobs reached`.
- `extraArgs` are stripped unless every entry matches the
  `--allow-extra-args` allowlist (exact match); stripped entries become a
  warning in the result. `--max-output-bytes` caps output size.
- Langfuse emit is disabled (no outbound publishing): `harness_emit` with
  `format: "langfuse"` errors `disabled in gateway mode`.
- Env mirrors: `AGENTIC_CODING_HARNESS_GATEWAY=1`, `AGENTIC_CODING_HARNESS_ROOT`,
  `AGENTIC_CODING_HARNESS_MAX_JOBS`.

## Async job flow

Long tasks should not hold a client connection. `harness_run_async` takes the
same arguments as `harness_run` (agent, prompt, model, cwd, budgetUsd,
maxTurns, wallMs, idleMs, extraArgs). Submit, then poll:

```json
{"jsonrpc":"2.0","id":1,"method":"tools/call",
 "params":{"name":"harness_run_async",
           "arguments":{"agent":"claude","prompt":"build a snake game"}}}

{"jsonrpc":"2.0","id":1,"result":{"runId":"3f9c8a52-...","sessionId":null,
  "started":true,"transcriptPath":".../transcript.jsonl"}}
```

The tool returns promptly, without waiting for the run. Poll with
`harness_run_status` `{"runId":"3f9c8a52-..."}` → `found` (false for unknown
ids), `status`, `sessionId`, `totals`, `lastEvent`, `startedAt`, `updatedAt`,
`elapsedMs`, `exitStatus` once finished. Statuses: `running`, `success`,
`error`, `aborted`, `interrupted` — the record said `running` but the process
is no longer live: pid dead or heartbeat stale beyond 15s. No automatic
resumption; recovering an interrupted run is an explicit opt-in parameter on
adapters that support it.

Page the transcript with `harness_run_events`
`{"runId":"3f9c8a52-...","cursor":0,"limit":100}` — `cursor` is a line
offset, `limit` defaults to 100 and caps at 1000 — yielding
`{ events, nextCursor, total, truncated }`. Cancel with `harness_run_cancel`
`{"runId":"3f9c8a52-..."}` → `{ cancelled, status }`; a finished run, or one
whose pid is dead after a restart, reports `cancelled: false` (reason:
`interrupted`). The sync `harness_run` remains for short tasks blocked on in
a single call.

## Persistence across restarts

Jobs are run-registry records at `<stateDir>/runs/<runId>.json` (default
`~/.agentic-coding-harness`; move with `AGENTIC_CODING_HARNESS_STATE_DIR`). A restart loses
nothing: finished runs stay terminal (`success`/`error`/`aborted`), in-flight
runs report `interrupted` — the registry re-evaluates liveness instead of
trusting the stale `running` — and transcripts/reports stay addressable via
status and events.

## Client config through ToolHive

Point each client at the gateway URL with the bearer token.

Claude Code (`.mcp.json`):
```json
{"mcpServers": {"agentic-coding-harness": {"type": "http", "url": "https://<gateway-host>:4443/mcp",
  "headers": {"Authorization": "Bearer <token>"}}}}
```

OpenCode (`opencode.json`):
```json
{"mcp": {"agentic-coding-harness": {"type": "remote", "url": "https://<gateway-host>:4443/mcp",
  "headers": {"Authorization": "Bearer <token>"}, "enabled": true}}}
```

Kiro (`.kiro/settings/mcp.json`):
```json
{"mcpServers": {"agentic-coding-harness": {"url": "https://<gateway-host>:4443/mcp",
  "headers": {"Authorization": "Bearer <token>"}, "disabled": false}}}
```

Codex (`~/.codex/config.toml`):
```toml
[mcp_servers.agentic-coding-harness]
url = "https://<gateway-host>:4443/mcp"
http_headers = { "Authorization" = "Bearer <token>" }
```

## Host auth inheritance

The server executes CLIs with the host's own credentials. Per agent:

- **claude** — reads its config dir (`~/.claude`); host login is enough.
- **kiro** — needs `KIRO_API_KEY` in the service env, plus `mitmdump` on
  PATH for credit accounting.
- **codex** / **gemini** / **opencode** — read their host config; nothing
  to inject.

Env defaults (per-run tool args beat these; these beat the built-ins):

| env var | purpose |
|---|---|
| `AGENTIC_CODING_HARNESS_STATE_DIR` | state dir (default `~/.agentic-coding-harness`) |
| `AGENTIC_CODING_HARNESS_DEFAULT_CLAUDE_CONFIG` | `1` = claude runs use the default `CLAUDE_CONFIG_DIR` instead of a per-run one. Required on a Mac whose Claude Code login is keychain-bound OAuth (no `~/.claude/.credentials.json`): a custom config dir cannot see that token and every run ends `Not logged in`. Trade-off: transcripts land under `~/.claude/projects`, and concurrent claude runs share one config. |
| `AGENTIC_CODING_HARNESS_HTTP_TOKEN` | bearer token for `serve --http` |
| `AGENTIC_CODING_HARNESS_GATEWAY` | `1` enables the gateway profile |
| `AGENTIC_CODING_HARNESS_ROOT` | gateway cwd root (mirrors `--root`) |
| `AGENTIC_CODING_HARNESS_MAX_JOBS` | gateway concurrency cap (mirrors `--max-jobs`) |
| `AGENTIC_CODING_HARNESS_BUDGET_USD` / `AGENTIC_CODING_HARNESS_MAX_TURNS` / `AGENTIC_CODING_HARNESS_WALL_MS` / `AGENTIC_CODING_HARNESS_IDLE_MS` | default spend / turn / wall-clock / idle-gap caps |

## Verification without paid tasks

Smoke the deployment before spending anything (bearer header when a token is
set):

```sh
curl -s http://127.0.0.1:8398/health          # {"status":"ok",...}
curl -s -X POST http://127.0.0.1:8398/mcp -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}'
```

Then over any configured client, or plain POSTs: `initialize`, `tools/list`
(all ten tools), `harness_agents` (one row per installed CLI + adapter),
`harness_stats` (empty rows on a fresh state dir are fine). Finally
`harness_run` with a bad agent name — `"agent": "nope"` — must error
cleanly naming the field, not hang. None of these start an agent process:
nothing is billed.
