# Changelog

Note: releases before 0.8.1 predate this changelog.

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
