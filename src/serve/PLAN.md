# Issue #1 build plan — ToolHive host deployment + async MCP jobs

Binding contracts. All seats code against this file.

## A. Registry: interrupted state (seat W1)

`src/core/registry.ts` RunRecord.status gains `'interrupted'`.
Semantics: status was `running`, service/process no longer alive (pid dead OR
heartbeat stale > 15s) → consumers report `interrupted`. Decision: do NOT
mutate files lazily; add:

```ts
export function effectiveStatus(rec: RunRecord, now?: number):
  'running' | 'interrupted' | 'success' | 'error' | 'aborted';
```

- rec.status === 'running' && isLive(rec) → 'running'
- rec.status === 'running' && !isLive(rec) → 'interrupted'
- otherwise rec.status as-is.

## B. Async job tools (seat W2) — src/mcp/tools-jobs.ts

```ts
export function registerJobTools(server: McpServer, opts: { stateDir: string }): void;
```

Tools (zod-validated, errors name the field, same conventions as tools-run.ts):

1. `harness_run_async` — args: same as harness_run (agent*, prompt*, model,
   cwd, budgetUsd, maxTurns, wallMs, idleMs, extraArgs). Spawns the run via
   createDriver WITHOUT awaiting completion; returns promptly:
   `{ runId, sessionId: null, started: true, transcriptPath }`.
   The runId is the driver's registry runId — get it by having the driver
   expose it: add `runId` to RunResult (core/types.ts) and — for async — the
   driver gains `runDetached(spec): { runId, promise }` ... SIMPLER: the tool
   creates the driver with registry enabled, calls driver.run(), does NOT
   await the promise, and reads the runId from the registry dir by watching
   for the new file (deterministic alternative: pass a caller-chosen runId —
   driver RunSpec accepts optional `runId` passthrough; seat W2 adds
   `runId?: string` to RunSpec and driver uses it for the registry record id
   when present). Tool generates runId = randomUUID(), passes it in, returns
   it immediately. Keep the promise alive on a module-level Map so the process
   holds it; unhandled rejections captured into the registry record.
2. `harness_run_status` — `{ runId }` → `{ found, runId, status:
   effectiveStatus, sessionId, totals, lastEvent, startedAt, updatedAt,
   elapsedMs, exitStatus? }`. found:false for unknown ids.
3. `harness_run_events` — `{ runId, cursor?: number, limit?: number }` →
   reads the record's rawTranscript JSONL, returns
   `{ events: [...], nextCursor, total, truncated }`. cursor = line offset
   (default 0), limit default 100 max 1000. Missing transcript → found:false.
4. `harness_run_cancel` — `{ runId }` → aborts via the module-level job map
   (handle.abort()). If no in-process handle (e.g. after restart): if the
   registry says running and pid alive, SIGTERM that pid; if pid dead → mark
   record interrupted (write status:'error'? NO — write nothing; return
   `{ cancelled: false, reason: 'interrupted' }`). Return `{ cancelled: bool,
   status }`.

## C. HTTP transport (seat W3) — src/mcp/http.ts + serve command

`harness serve [--http] [--port N=8399] [--token T] [--host 127.0.0.1]`
- Streamable HTTP MCP on loopback: POST /mcp accepts single JSON-RPC messages
  AND batches; responds application/json (no SSE streams needed for v1 —
  declare 'Streamable' via the single-endpoint shape: POST-only, JSON
  responses; initialize advertises protocolVersion 2025-06-18).
- Auth: when --token set (or AGENT_HARNESS_HTTP_TOKEN env — env wins over
  nothing, flag wins over env), require `Authorization: Bearer <token>`;
  401 JSON-RPC error otherwise. When unset, bind 127.0.0.1 only and warn on
  stderr that auth is off.
- GET /health → 200 `{"status":"ok","version":"0.2.2"}` (no auth).
- Reuses createMcpServer's dispatch: refactor so server.ts exposes
  `dispatch(msg: JsonRpcRequest): Promise<JsonRpcResponse|null>` (null for
  notifications); the stdio lane and HTTP lane both call it. Seat W3 owns
  this refactor — keep stdio behavior identical (tests/mcp.test.ts must stay
  green untouched).
- Graceful shutdown: SIGINT/SIGTERM → stop accepting, drain 5s, exit.
  In-flight async jobs: leave registry heartbeats to go stale (interrupted
  semantics cover it); write a final `status` untouched.
- Registers ALL tools: run (sync), agents, report, emit, stats, jobs.

## D. Gateway profile (seat W4) — serve flags

`harness serve --gateway --root <dir> [--max-jobs N=4] [--max-output-bytes N]
[--allow-extra-args "pat1,pat2"]`
- --gateway requires --root; cwd args in run tools must resolve under root
  (path.resolve + prefix check; reject with error naming cwd).
- artifact paths (report out, emit out) constrained under stateDir.
- concurrency: harness_run_async rejects with -32603 `max concurrent jobs
  reached` when live jobs >= max-jobs (count via registry effectiveStatus).
- extraArgs stripped unless every arg matches the allowlist (exact string
  match); stripped args → warning in result, not silent.
- emit tool with format langfuse DISABLED under --gateway (no outbound
  publishing): error `disabled in gateway mode`.
- Env mirrors: AGENT_HARNESS_GATEWAY=1, AGENT_HARNESS_ROOT, AGENT_HARNESS_MAX_JOBS.

## E. ToolHive docs (seat W5) — docs/TOOLHIVE.md

Host-execution topology: ToolHive runs `harness serve --http --token` as a
remote workload on the host (where CLIs + auth live); gateway fronts it;
clients (Claude Code, OpenCode, Kiro, Codex) connect to the gateway. Cover:
PATH/auth inheritance (server inherits host env; kiro needs KIRO_API_KEY in
the service env, claude uses its config dir, mitmdump for kiro credits),
secret forwarding (token via env, never argv — `ps` leaks), readiness probe
against /health, the async job flow (submit → poll status → page events →
cancel), gateway profile flags, and a worked example per client.

## Tests (seat W6)

- registry: effectiveStatus transitions (running+live, running+dead pid →
  interrupted, terminal states unchanged).
- jobs: fake/stub agent adapter (follow tests/driver.test.ts stub patterns):
  run_async returns promptly with runId; status flows running→success;
  events paging with cursor/limit; cancel mid-run → aborted; cancel after
  finish → cancelled:false.
- http: spawn `harness serve --http --port 0`-ish (pick a free port) with a
  tmp state dir; initialize over HTTP POST, tools/list has all 9 tools,
  auth 401 without token when set, /health 200 without auth, batch request.
- gateway: cwd escape rejected, max-jobs rejection, extraArgs stripped +
  warning, langfuse emit disabled.
- All subprocess tests: AGENT_HARNESS_STATE_DIR tmp, 30s timeouts.
