# Our edge — sblattj/agentic-coding-harness ("ach")

*Competitive gap sweep, 2026-09-26/27. 15 rival teardowns, a gap matrix, and 83 improvement issues filed as [#17 through #99](https://github.com/sblattj/agentic-coding-harness/issues?q=is%3Aissue+label%3Acompetitive-gap). Every claim below is backed by a rival teardown or a code citation.*

## The one-sentence position

**ach is the only local-first tool that both LAUNCHES and METERS coding-agent CLIs** — five adapters (claude, opencode, kiro, codex, gemini) with one normalized event stream, defensible cost math, budgets that abort runs mid-flight, and artifacts (registry, replay, OTel/ATIF/Langfuse, HTML compare) — with no account, no server, and no container required.

Every surveyed rival is exactly one of the things ach combines, and admits it:
- **Reporters** (ccusage 18.7k★, codeburn 11.3k★): read transcripts after the fact; cannot launch, abort, or cap anything. ccusage's own docs note its live monitor was deleted.
- **Observers** (token-meter, loongsuite-pilot, heron, Axon): watch and warn; budgets there "alert but never abort". heron needs TLS-plaintext placement; loongsuite has no pricing engine.
- **Launchers** (claude-squad 8.5k★, parallel-code, vibe-kanban 28.2k★ sunsetting): run agents in worktrees/panes with **zero cost metering** — no token records, no pricing, no budgets (verified per card).
- **Benchmarks** (sample-agent-cost-bench, openbench, harbor): score outcomes but treat cost as a report column, not a control; harbor has no budget abort at all (grep-verified).
- **Platforms** (langfuse 35k★, openlit): want our data and a server to put it in; ach is the local plane that feeds them.

## Durable differentiators (no surveyed rival has them)

1. **Budgets that abort mid-run** — `--budget-usd`, `--max-turns`, `--wall-ms`, `--idle-ms` enforced against the live event stream with per-cause `exitStatus` (README.md:324-332). Rivals warn (token-meter, claude-monitor exit codes) or nothing (claude-squad, vibe-kanban, harbor). Verified absent in 14/15 rival cards.
2. **Programmable control plane** — `driver.abort(runId)`, `installSignalAbort`, `runToDirectory` durable status.json, and a 10-tool MCP server over stdio AND streamable HTTP with async jobs and an untrusted-client gateway mode (`src/mcp/tools-jobs.ts:115`, `src/serve/gateway.ts`). No rival exposes an MCP control plane for launching and cancelling metered runs.
3. **Interactive browser terminal per run** — PTY relay + vendored xterm.js in the web grid (`src/web/vendor/xterm/`), with 409-refusal for non-local feed runs. Rival dashboards are read-only streams (harbor) or screenshots (token-meter).
4. **Verified cost math as identity** — cache-aware per-(model, tier) accounting checked against each CLI's own ground truth, unpriced models warn and contribute 0 (never silently), and now `ach audit` queued as P1 to re-derive totals from raw transcripts. Axon's silent DEFAULT-price fallback and openbench's missing USD column are the counter-examples.
5. **Kiro depth nobody else has** — MITM credit tap, ACP transport with proven model ack, kiro preflight. loongsuite-pilot's own matrix marks Kiro "Token Usage: No".
6. **Run registry + external feeds** — atomic per-run records, public `writeRunRecord` API, and `--source` poll/SSE/WS so one dashboard fronts many machines. Axon ingests OTLP but has no run model; ccusage has no live model at all.
7. **Artifacts out** — self-validating ATIF v1.7 trajectories (harbor authored ATIF but doesn't emit per-run cost), OTel gen_ai spans, Langfuse OTLP, single-file HTML compares, asciinema `.cast` replay per run.
8. **Distribution** — npm AND PyPI, Node ≥18.19, library-grade API; zero ClickHouse/Postgres/Redis (langfuse self-host = 5+ services), zero Docker requirement (harbor), zero Xcode toolchain (token-meter/codeburn companions).

## Structural advantages

- **MIT license** vs claude-squad AGPL-3.0, phoenix Elastic-2.0.
- **Local-first flat files** — no ingest step, no retention service; survives CLI log cleanup via `ach archive` (#79, [ARCHIVE.md](ARCHIVE.md)).
- **Air-gap friendly** — vendored assets, bundled LiteLLM extract, offline pricing.
- **Plays well with rivals** — `hintCcusage` (`src/cli/ach.ts:733-741`) points users at ccusage for batch reports instead of fighting it.

## Where we lose today (be honest)

Coverage (5 CLIs vs ccusage 18 / codeburn 40 / loongsuite 30), quota & plan intelligence (herdr, claude-monitor, codeburn all show subscription headroom; we show none), statusline presence (ccusage/claude-monitor/herdr own the Claude status bar), outcome scoring (three benchmarks grade; we don't), and adoption (1★ vs 18.7k★). All 83 filed issues (#17–#99) attack exactly these; P1s are quota/blocks/pace, more CLIs, date+model stats, cost modes, scoring+Wilson CI, exit-code ladder, latency metrics, provenance labels, `ach audit`, `ach doctor`.

## Market timing

**vibe-kanban (28.2k★) is sunsetting** (README banner; company closed 2026-04-10) and its multi-agent task-runner audience is homeless; parallel-code is Electron-only with no cost story. The workflow tools dying/omitting metering + the metering tools omitting control is exactly the seam ach sits in.

## Quotable lines

- "ccusage tells you what you spent. claude-squad spends it. ach is the only tool that spends it *and* stops it at $2."
- "One registry, five agents, two dashboards, ten MCP tools, zero servers."
- "Every number carries its proof: provider-reported, or computed and auditable — never silent."
