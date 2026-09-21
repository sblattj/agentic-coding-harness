# Changelog

Note: releases before 0.8.1 predate this changelog.

## [0.10.1] - 2026-09-21

### Fixed

- The sync `harness_run` MCP tool now persists its per-run RunRecord to `<stateDir>/runs/<runId>.json`, restoring parity with `ach run` and `harness_run_async` (the file was never written on the sync MCP path; downstream clients reading it back got ENOENT). Closes #16.

## [0.10.0] - 2026-09-20

### Added

- `ach mcp` — MCP over stdio (newline-delimited JSON-RPC on stdin/stdout, Content-Length framing tolerated): the same 10-tool surface, handshake, and `--gateway` profile flags as `ach serve --http`, for MCP clients that spawn the CLI as a child process (no port, token, or health probe).
- Stdio transport now answers JSON-RPC batch arrays (all-notification batches reply `[]`), mirroring the HTTP batch semantics.

### Fixed

- A JSON-RPC object missing (or with an empty) `method` now answers `-32600 Invalid request` on both transports; previously the HTTP lane crashed with a 500 and the stdio lane was the only one to answer.
- `ach mcp` no longer drops in-flight responses when a client half-closes stdin (request, then stdin end): async tool replies (e.g. `harness_stats`) raced the CLI's exit and were lost entirely.

## [0.9.0] - 2026-09-18

### Added

- `ach web --source <url>` points the dashboard at an external run feed instead of (or alongside) the local state dir, with `--source-token`, `--source-mode poll|sse|ws`, `--source-poll-ms`, and `--source-merge state|only` flags (env: `AGENTIC_CODING_HARNESS_SOURCE`, `_SOURCE_TOKEN`, `_SOURCE_MODE`, `_SOURCE_POLL_MS`, `_SOURCE_MERGE`).
- External feed contract: `GET {source}/runs` returns `{"records": [...]}`; optional live pushes via SSE (`GET {source}/runs/stream`, `event: runs`) or WebSocket (`GET {source}/runs/ws`, `{"type":"runs","records":[...]}`); malformed records are dropped with a counted warning.
- `--source-merge state` unions the external feed with the local state dir (external wins on `runId` collision); the default `only` serves the external feed alone.
- External producers can push runs locally: parse a record with the exported `RunRecordSchema` and persist it with `writeRunRecord` from the public API.
- Public API additions: `RunRecordSchema`, `CanonicalTokenRecordSchema`, `ExternalRunFeedSchema`, `writeRunRecord`, `readRunRecord`, `listRunIds`, `listRunRecords`, `registryDir`, and the `RunRecord`/`CanonicalTokenRecord`/`ExternalRunFeed`/`RunSource` types.
- `GET /api/compare` groups runs by `by=experiment,variant` (also `by=workflow,agent`), returning per-group `runs`, `avgTotalTokens`, `avgCostUsd`, `avgDurationMs`, and `successRate`; `GET /compare` renders the same rollups as a sortable table.
- `GET /health` reports the configured run source and its health (`source`, `sourceHealthy`).
- `RunRecord` gained additive provenance fields: `experiment`, `variant`, `workflow`, `source` (`"local"` default, or `"external"`), `producer`, `endedAt`, and `metadata`.
- PTY attach (`POST /api/pty`, `/ws/pty/*`) is refused with `409` for external runs — there is no local process to attach to — and the LIVE button is hidden on external run tiles.
- Report variant grouping: runs recorded with a `variant` on their RunSpec group the comparison table by variant (same experiment/agent); legacy runs without a variant keep the by-agent grouping.

## [0.8.1] - 2026-09-16

### Added

- mcpName registry marker for MCP publication (`io.github.sblattj/agentic-coding-harness`).
