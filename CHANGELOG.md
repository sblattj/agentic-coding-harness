# Changelog

Note: releases before 0.8.1 predate this changelog.

## Unreleased

### Added

- Tamper-evident metering (#59). Every event line the driver writes to a run's raw transcript (`<stateDir>/raw/<agent>-<session>.jsonl`) and to run-to-directory `events.jsonl` now carries a per-run sha256 hash chain (`{"ach_chain":{v,run,seq,prev,hash}, ...event}`). Each run ends with an `ach.seal` record over the event count, the last hash, and the sealed metering totals. The seal is mirrored into the new optional `RunRecord.seal` and into `status.json`. The new `ach verify-run <runId|runDir> [--json] [--records]` recomputes the chain and exits 0 when intact, 2 when tampered (naming the first bad line), 3 for an unsealed legacy log, and 4 for an open, never-sealed chain. `ach audit` rows gain a `chain` verdict, and `ach report` gains a per-run `seal` column. `ach audit --fix` corrections are undone and disclosed, not reported as tampering. The README documents the chain format and threat model: tamper-evident, not tamper-proof. `stripChain`, `parseFramedLine`, and `verifyChainText` are exported from the library.

### Changed

- Readers of `events.jsonl` and raw transcripts: lines now start with an `ach_chain` key, and the file ends in an `ach.seal` record. Every other event field is unchanged, and `stripChain(line)` returns the exact pre-chain line.

## [0.11.2] - 2026-09-28

### Fixed

- `ach <subcommand> --help` / `-h` prints that subcommand's usage block and exits 0 for every subcommand, instead of crashing with `ERR_PARSE_ARGS_UNKNOWN_OPTION`. After `--`, a `--help` token stays a literal positional. Unknown options still error, but as a one-line usage error instead of a stack trace (#101).
- `--extra-args "--flag value"` (space-separated) now works, not just `--extra-args="..."`; the flag may be repeated, accumulating one argv token per occurrence, and a valueless trailing `--extra-args` is a one-line usage error (#104).
- The claude adapter forwards `--model <m>` to the Claude Code CLI; previously `ach run --agent claude --model <m>` silently ran on the account default model (#102).
- `claude-opus-5-5` and `claude-sonnet-5-5` are priced (mirrored from the `-5` family, provenance `estimated`), and a missing exact entry now falls back to the nearest family entry as an estimate instead of `cost n/a`; models with no family match still warn and stay unpriced (#103).

### Added

- `AGENTIC_CODING_HARNESS_PRICING_OVERRIDE` env var: path to a JSON pricing-override file that extends/overrides bundled prices at lookup time, so new models can be priced without waiting for a release. Missing file is a no-op; a malformed file warns once and never crashes (#103).

## [0.11.1] - 2026-09-28

### Fixed

- `ach status` / `ach statusline` "today" spend now prices harness state records exactly as `ach stats` does (reported cost first, an explicit $0 kept, otherwise tokens × bundled price). Previously a state record with no stored cost counted as $0, so `cost_today` can rise for affected users.
- Records with no obtainable price (unknown model, nothing reported) are counted instead of silently omitted: `unpricedRecords` on every `ach stats --json` bucket and on `ach status` `today` / `today.byAgent`, with `unpriced=N` / `(+N unpriced)` in text output and the statusline, so a total that excludes them reads as a lower bound.
- Run records whose `usage` lacks `credits` are no longer silently dropped (`credits` reads as unknown, rendered n/a). Run-record files that still fail to parse are counted and reported: `skippedRunRecords` in `ach stats --json`, a `skipped` line in text stats and the live `ach dash`, and a `[warn] registry:` stderr line naming each file.
- `ach run --repeat N --exit-codes ladder`: a child whose agent launch was unavailable now scores 20 like a single run (was 1); the group exits with the most severe child code (1 > 20 > 11 > 10 > 0). `docs/EXIT-CODES.md` documents `--verify` and `--repeat` in both modes.
- `ach archive --agent` lists the read-only transcript sources (cursor, amp, goose, qwen) in its unknown-agent error. Scanning, `watch --dir`, `archive`, and `stats`/`archive --agent` validation now derive from one transcript-source registry, with a test pinning every entry against every consumer.
- `ach doctor --json` marks checks produced from agents.d descriptors with `"source": "agents.d"`.
- The PyPI package now tracks the npm release: the vendored bundle is rebuilt from source (`npm run build:python`) and a test pins its version, `pyproject.toml`, and `__version__` to `package.json`.

### Added

- Unambiguous directory flags: `--transcript-dir` for `stats`/`watch`, `--state-dir` for `archive`/`audit`/`dash`/`web`. `--dir` keeps working; help says which it means per command, and passing both with different directories is a usage error.
- Regression tests that every `ach stats` section honors `--project`/`--until`/`--agent`, and that the adapter list in the driver test derives from `AGENTS`.

### Docs

- The `ach stats` window is `[--since, --until)`: `--until` is exclusive.

## [0.11.0] - 2026-09-27

### Added

- `ach audit` replays raw transcripts to check recorded tokens and costs, with JSON output and an explicit correction history for `--fix` (#34).
- Cost modes (`auto`, `calculate`, `display`) and reported/computed/unavailable provenance labels (#28, #33).
- Time windows (`--since`, `--until`, `--last`), timezone-aware day/week/month buckets, model/project breakdowns, and cache-hit ratios (#26, #84, #44, #27, #43, #69).
- `ach status`, compact output, atomic status snapshots, and `ach statusline` with current-block cost (#45, #62, #61).
- Provider-reported quota, Claude five-hour blocks, burn rates, budget projections, and explicitly estimated plan presets (#17–#19, #36).
- Persisted threshold alerts with cooldown, context-window pressure across adapters, and explicit opt-in budget aborts (#20, #21).
- `ach archive` snapshots transcripts and run records into a reusable warehouse (#79).
- Custom command templates and `agents.d` descriptors, including meter-only sources and explicit unmetered runs (#37, #38).
- `ach doctor` checks agent/runtime configuration without sending a prompt; `null` provides an offline negative-control adapter (#35, #55).
- Verifier commands, fresh-session repeat groups, pass@k/Wilson statistics, and regrading with preserved score history (#29, #57, #30, #89).
- Read-only Cursor, Amp, Goose, and Qwen transcript adapters. Cursor consumes explicit stored token counts where available; token counts are never estimated from text length (#22).
- Optional exit-code ladder and a separate unavailable status (#31, #60).
- Linux/macOS CI, standalone binaries for arm64/x64, and a Homebrew tap with release-driven formula updates (#39, #81, #82).

### Fixed

- Identical repeated Claude final result records count once; final accounting is distinguished from mid-run budget enforcement (#14).
- Integrated stats filters, cost selection, report history, transcript dashboards, and archive coverage across the new features.
- Flush queued CLI output before exit so older Node runtimes preserve complete help and large JSON responses in pipes.
- Reconcile missed filesystem notifications so dashboards observe newly created and updated run records on macOS.

### Changed

- Spending thresholds now warn and continue by default. Add `--on-budget abort` to enforce a hard spending cap. Wall-clock, idle, and turn limits retain enforcement.
- `--exit-codes ladder` is opt-in; binary exit codes remain the default.
- npm, Homebrew, and GitHub binaries carry this release. The separately published PyPI wrapper remains at 0.7.4.

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
