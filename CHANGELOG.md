# Changelog

Note: releases before 0.8.1 predate this changelog.

## [Unreleased]

### Fixed

- The nonzero-exit reason no longer picks routine log lines (#TBD). A headless kiro-cli run that exited 1 read `kiro-cli exited with code 1: [INFO] [KRS] <-- GenerateAssistantResponseCommand done totalEvents=9`, because the fallback took the last stderr line. `pickStderrReason` (`src/adapters/shared.ts`) now never picks INFO/DEBUG/TRACE-tagged lines (`[INFO]`, ` DEBUG `, `level=trace`). It prefers the last line that looks like a failure (`error`, `failed`, `not offered`, `denied`, `exceeded`, `unauthorized`, `forbidden`), then the last WARN line, then the last other non-empty line. When only routine lines remain, the message stays bare. The stderr tail grew from 5 to 20 lines (still 4 KB per line), so trailing INFO lines no longer push the real error out.
- A CLI child that exits nonzero now reports why (#133). The exit error used to say only `kiro-cli exited with code 1`, so a kiro-cli headless run that stopped on `The monthly usage limit has been reached` looked like a crash. The shared run loop (`src/adapters/shared.ts`) keeps the last few stderr lines and appends the most relevant one, ANSI codes stripped: the last line matching `error`, else the last non-empty line, as in `kiro-cli exited with code 1: Error: Internal error (code -32603): ... The monthly usage limit has been reached`. The message prefix is unchanged, so existing matchers still work. When an adapter's own stderr hook already raised a specific error (cursor), the exit message stays bare, so the reason is not reported twice. Exit 0 is unchanged.
- kiro: the MITM credit tap no longer breaks HTTPS from the agent's shell tools. kiro-cli hands the tap env (`HTTPS_PROXY`, `SSL_CERT_FILE`, `NODE_EXTRA_CA_CERTS`) to every command the agent runs, and mitmdump intercepted every host. A host whose certificate chain mitmdump could not verify (for example behind a TLS-inspecting network proxy) came back as HTTP 502, so another vendor's CLI run from the agent's shell failed on every call. mitmdump now gets `--allow-hosts` for the metered hosts only (`codewhisperer.*.amazonaws.com`, `runtime.*.kiro.dev`, extendable with `ACH_KIRO_TAP_HOSTS`), and other hosts are tunneled raw to their origin. `SSL_CERT_FILE` now points at the system roots plus the tap CA instead of the bare tap CA, so OpenSSL clients can still verify tunneled hosts. See docs/KIRO.md.
- Piped stdout is no longer truncated under Bun (#128). `ach dash --json --all | wc -c` stopped at 64 KiB in the compiled binaries and 128 KiB from source, because the CLI called `process.exit` before the pipe drained: under Bun the empty `write("", cb)` guard fires its callback while earlier output is still queued. The CLI now records stdout/stderr backpressure (a `write()` that returns false) and waits for `drain` before every forced exit (`src/cli/stdio-flush.ts`), including `watch`, `serve` and the live `dash` shutdown paths.
- kiro: `--kiro-transport acp --kiro-engine v3` no longer dies in `initialize` (#127). kiro-cli rejects `--agent`, `--model`, `--effort`, `--trust-all-tools` and `--trust-tools` with `--agent-engine v3` on `acp`, so for v3 only `--agent-engine v3` is passed. After `session/new` (or `session/load`) the agent (a mode), model and effort are set with `session/set_config_option`, because v3 does not implement `session/set_model`. Each value is checked against the options v3 sends back, since v3 accepts unknown values without an error. An agent the session does not offer fails before any prompt, and the error suggests `--kiro-transport headless`. A fresh workspace can load its model catalog after `session/new`, so the handshake waits up to 15 s for it. `kiro.tools` is applied by answering `session/request_permission` (`all` allows, a list allows the listed tool ids or ACP kinds, `none` or unset denies). The run evidence records `engine`, `effortAck`, `currentEffort` and `toolTrust`. Verified live on kiro-cli 2.29.0.

## [0.19.0] - 2026-10-09

### Changed

- **BREAKING:** Node.js 22 or newer is now required (`engines.node` is `>=22`; Node 18 and 20 are end of life). The Python wrapper rejects Node older than 22.0.
- CI now runs on Node 22, 24 and 26.
- Tests: `npm test` preloads `tests/support/spawn-timeout.mjs`, which gives every `spawnSync`, `execFileSync` and `execSync` call in a test a 90 s time limit when the call sets none (override with `ACH_TEST_SPAWN_TIMEOUT_MS`). A hung child now fails the test that spawned it and prints `[spawn-timeout] <test file>: child timed out …`, instead of blocking the file until the CI job is cancelled. Each test also has a 300 s limit (`--test-timeout`).
- The context-diet kit now lives in its own repo, [sblattj/context-diet](https://github.com/sblattj/context-diet), which also installs as a Claude Code plugin. The copy in `context-diet/` stays for now but is frozen, and new fixes land in the new repo. See docs/CONTEXT-DIET.md.

## [0.18.0] - 2026-10-09

### Added

- cursor: support cursor-agent 2026.10.x stream-json. Usage is read from the nested camelCase `result.usage` (input is already net of cache), with top-level and snake_case (`cached_input_tokens`) fallbacks that are never summed. `thinking` events become one reasoning message per block. The CLI-internal `interaction_query`, `retry`, `connection` and `system/task_notification` events are ignored without warnings.
- cursor: specific errors for stderr-only failures (workspace trust, a `--resume` id with no chat, and, when the run produced no `result`, any other `Error: <msg>` or `<Name>Error: <msg>` such as the free plan's `ActionRequiredError: Named models unavailable`), one per run, instead of only `exited with code 1`.
- cursor IDE: recent `state.vscdb` stores parse. Epoch-ms timestamps are accepted. The model falls back to the composer's `modelConfig.modelName`, and `default` (auto-routing) means unknown. A store whose conversations carry no token counts (`{0,0}` bubbles, `agentKv` rows) now warns once, pointing at `ach run --agent cursor` or the Cursor dashboard export, instead of returning nothing silently.
- cursor: a run on the default model `Auto` records its tokens with cost unavailable and one warning, instead of pricing as `unknown model` next to a contradictory "cost computed" warning. Verified live on cursor-agent 2026.10.01: ach's tokens equal the CLI's `result.usage` exactly.
- cursor: `ach import --agent cursor --usage-export <file>` validates a Cursor dashboard usage export (CSV or JSON, live captures of 2026-10-09) and stores a verbatim copy under `<stateDir>/cursor-dashboard/<sha256>.<ext>`. Re-importing is `unchanged`; `--dry-run` and `--json` are supported; no RunRecords and nothing under `raw/` are written. The parser (`src/monitors/cursor-dashboard.ts`) checks the CSV `Total Tokens` against its four counters, reports `chargedCents/100` as the JSON cost, and de-duplicates a request that appears in several exports.
- cursor: `ach stats` now counts imported dashboard exports (also with `--state-only`), at the billed cost. A JSON row replaces every `ach run` cursor record of its session; a CSV row replaces one `ach run` cursor record with identical input, cache-read and output tokens within 10 minutes (each record used once) and takes over its session and project; Cursor IDE-store rows inside the export's time span are replaced, rows outside it are kept. The rules are pure functions in `src/cli/cursor-dashboard-merge.ts`.

### Fixed

- cursor IDE: large stores were skipped as unreadable (`stdout maxBuffer length exceeded`) because whole message values were piped out of SQLite. Only the counted fields are extracted now.
- cursor: a tool counts as failed only when a failure member (`error`, `failure`, `rejected`, `timeout`, `spawnError`, `permissionDenied`) is present and non-empty, so an empty default-valued field never marks a tool failed.

## [0.17.2] - 2026-10-09

### Fixed

- kiro (#121): kiro-cli 2.28.0 stopped sending `tokenUsage` and moved `contextUsagePercentage` to a new `contextUsageEvent`, so every tapped run read 0 tokens. The MITM tap now captures `contextUsageEvent`. Tap frames with no `tokenUsage` object are marked `tokensAvailable: false` instead of producing zero-token records. `frameToMitmLine` also reads `meteringEvent.usage` credits.
- kiro (#121): ach now reads the v3 engine session store (`~/.kiro/sessions/<hex>/sess_<id>/`) for credits and context %. Tokens are reported unavailable there, because kiro 2.28 exposes no real token counts on any surface. Context tokens are derived from the percentage and an assumed window.

## [0.17.1] - 2026-10-08

### Fixed

- `ach run --agent claude` on a keychain-login Mac with no `CLAUDE_CODE_OAUTH_TOKEN` / `ANTHROPIC_API_KEY` ended `error` with no reason. The adapter now recognises the CLI's "Not logged in" stream, emits one error event naming the fix (set a token or API key, or pass `--claude-default-config`), and the run settles `unavailable` like an unauthenticated Cursor run.
- `ach run --agent copilot --disallowed-tools shell` blocked nothing: copilot ignores tool names it does not know (its shell is `bash`). A sandbox tool name that is not a copilot built-in now prints a `[warn]` with a "did you mean" hint; the name is still passed through.
- kiro: the v3 engine now trusts the MITM tap's CA via `NODE_EXTRA_CA_CERTS` (#119).
- `ach queue` under node + tsx: a queued run in a directory without tsx installed failed with `ERR_MODULE_NOT_FOUND`; bare `--import`/`--require` specifiers are now resolved before spawning.
- Tests: node 18 compatibility (`import.meta.dirname`), a longer stats spawn timeout, a hermetic transcript scan that ignores real `~/.copilot` sessions, and a 30 s per-fetch limit in the binary smoke.

## [0.17.0] - 2026-10-08

### Added

- `copilot` agent (#23): `ach run --agent copilot` drives the GitHub Copilot CLI headlessly (`COPILOT_CLI_BIN` overrides the binary). The four sandbox fields map to Copilot flags (`--available-tools`, `--excluded-tools`, `--additional-mcp-config` and the permission modes). Copilot session logs are also a native transcript source, so `ach stats`, `ach watch` and `ach dash` meter Copilot sessions that ach did not launch.
- `cursor` agent (#24): `ach run --agent cursor` drives the Cursor CLI (`cursor-agent --print --output-format stream-json`; `CURSOR_AGENT_BIN`, `--resume <chatId>`). A `cursor-agent status` preflight fails an unauthenticated CLI with a specific error ("Run `cursor-agent login`, or set CURSOR_API_KEY") and records the run `unavailable`. Cost is the CLI's stated figure when it gives one (provenance `reported`), otherwise it is computed from the CLI's reported tokens with a warning (`computed`), otherwise n/a. `--permission-mode dontAsk|plan|ask` is honoured; the other sandbox fields are reported as not applied. The stream shapes come from Cursor's docs and have not yet been checked against an authenticated CLI.
- Sandbox flags on `ach run` (#13): `--permission-mode`, `--allowed-tools`, `--disallowed-tools` (repeatable, comma-separated) and `--mcp-config` (a file path, or inline JSON starting with `{`, which is redacted in output). The resolved policy prints as a `[sandbox]` header line and is added to `--json`. Each field an agent cannot honour prints a `[warn]` naming it (see the README table). `--evidence-dir` writes a metrics-only `metrics.json` sidecar (`metrics-<i>.json` with `--repeat`) with the sandbox, totals and provenance, and no prompt text.
- The same sandbox policy on every other surface (#13): matrix plans accept `sandbox` at plan, agent-entry and task level, merged per field; `ach trial --suite` takes the four flags; the MCP `harness_run` and `harness_run_async` tools take a `sandbox` object. A sandbox is recorded on ledger rows but is not part of cell identity, so use a new `--ledger` to compare policies.
- `ach queue` (#115): `ach queue run <plan>` launches a plan's slices as detached `ach run` processes, keeping the live `ach run` count on the machine at or below `--max-concurrent`, with `--max-hours`, per-slice `--pre`/`--post` hooks, `--resume <queueId>`, `--dry-run` and `--notify`. `ach queue status` reports progress. Exit codes: 0 drained, 1 a slice failed, 40 `--max-hours` reached, 130 interrupted. See docs/QUEUE.md.
- Queues on the dashboard (#115): `ach dash --json --queues` prints `{records, queues}` (plain `--json` is still a bare array), and the web dashboard serves `GET /api/queues` and a `/queues` page, both behind the dashboard token.
- `ach replay vet <pr>` (#115): read-only checks for whether a merged PR makes a usable replay case. It checks merged/approved state, whether the diff matches, rebase-vs-squash merges, test and ticket heuristics, and whether a fallback clone (for example a release branch) holds the commits. It prints a draft case entry and exits 40 on a failing verdict. `--json` is supported. See docs/REPLAY.md.
- Context-diet kit (#118): `context-diet/ablate.sh` measures how many startup tokens each component (skills, MCP, instructions, tool set) adds to a Claude Code session. `skill-usage.py` reports which skills are actually used, `skill-lint.py` flags descriptions over the 600-character cap, and `agents/lean.md` is a 6-tool subagent. `context-diet/ab/` is a skill-trigger A/B pipeline (mine, filter, make arms, run, report) over prompts mined from your own transcripts. It bills the subscription, not `ANTHROPIC_API_KEY`. See docs/CONTEXT-DIET.md.

### Changed

- `cursor` is now both a launch agent and the read-only Cursor IDE transcript source; `ach run --agent cursor` no longer fails with `READ_ONLY_SOURCE` (`amp`, `goose` and `qwen` still do).
- Kiro credits and Copilot AI credits are different units and are no longer summed: once a Copilot figure is present, totals name each vendor (`credits (kiro) 12.30cr · AI credits (copilot) 4.00cr`).
- docs/EXIT-CODES.md has a new section for commands outside the run ladder. Exit code 40 means `--max-hours` reached for `ach queue run`, and a failing verdict for `ach replay vet`.

## [0.16.1] - 2026-10-07

### Fixed

- `ach run --agent kiro --kiro-transport acp --resume <id>` no longer fails with `child already exited (code 0)` in phase `session/prompt`. The `session/load` request was sent without `cwd`, and kiro-cli (2.21.2 and 2.28.0) exits silently on that. Resume now does `initialize` → `session/load` (no `session/new`), always sends `cwd`, and drops the history kiro replays during the load. A load that fails stops the run with a `session/load` error carrying kiro's reason, instead of quietly starting a new session. Fixes #117.
- A resumed kiro run (headless and ACP) no longer warns `credit sources disagree` and no longer over-reports tokens: the kiro session store, which holds every earlier run's turns, is now scoped to the turns the current run produced.
- `ach dash` (and `stats`, `watch`, `import`) no longer warns about Claude Code's `<synthetic>` pseudo-model, used for locally generated messages such as "Not logged in". Those messages are non-billable: priced at $0, dropped by the Claude transcript reader, and never in a per-model breakdown. Repeated unknown-model pricing warnings now collapse into one line with a count (`pricing: unknown model "x" (alias "x") in 11 sessions; cost not computed`), so a genuinely unknown model still shows once. Fixes #116.

## [0.16.0] - 2026-10-06

### Added

- `ach quota wait` blocks until an agent's vendor-reported quota windows have headroom, then optionally runs a command: `ach quota wait [--agent A=claude] [--max-used PCT=95] [--window 5h,7d] [--poll-s S=60] [--grace-s S=60] [--timeout-s S] [--allow-unknown] [-- <cmd> ...]`. A window counts as clear when it is under `--max-used` or has reset since it was observed; otherwise it waits until the latest blocking `resets_at` plus `--grace-s`, re-reading the snapshot every `--poll-s`. Every check uses the wall clock, so a laptop that sleeps through the reset starts the job on wake. It exits with the command's code, `0` with no command, and `1` on `--timeout-s` or when the agent has no vendor number (unless `--allow-unknown`). The decision is the exported `quotaWaitDecision(rows, opts)`.

## [0.15.2] - 2026-10-06

### Fixed

- A hermetic sync-back failure no longer drops the run in `ach trial --matrix` or the MCP run tools (#113, completing the 0.15.1 fix for `ach run`). A matrix cell whose sync-back fails becomes an `error` row that keeps its `runId`, `exitStatus`, `verify` (graded on the kept temp copy) and `errorInfo: {code, message, keptDir, source}`, and the other cells still run. `harness_run` returns the full run with `error` attached instead of throwing. `harness_run_async` records the failure on the job, so `harness_run_status` reports it with usage and totals intact. The registry record of a run whose sync-back failed now has `status: "error"`.
- Kiro runs in separate `ach` processes no longer race for a MITM tap port (#114). mitmdump now picks a free port itself (`--listen-port 0`), and ach reads the bound port from its startup line before injecting `HTTPS_PROXY`. Concurrent runs, in one process or many, each get their own working tap. The port probe is gone. If mitmdump does not report a port, the run still goes untapped with a warning.
- The npm `bin` path is normalized to `dist/cli/ach.js` (the `npm pkg fix` form), which silences a publish warning.

## [0.15.1] - 2026-10-06

### Fixed

- `--hermetic` sync-back no longer fails with `EACCES` when the run touched a read-only file (#113), such as a git loose object under `.git/objects` (mode 0444). A non-writable destination is removed and re-copied, and its mode is restored. A file whose size and sha256 match the destination is not copied at all, so git object freshening (an mtime-only change) is skipped. If sync-back still fails, `ach run --json` writes the run record (usage, events, `verify`) with `error: {code, message, keptDir, source}` attached and exits 1. `--verify` grades the kept temp copy, which holds the agent's edits.
- Parallel `ach run --agent kiro` runs no longer share one MITM tap port (#114). The port probe now detects a wildcard (`*:port`) listener, mitmdump is pinned to `--listen-host 127.0.0.1`, and concurrent launches in one process claim distinct ports. `HTTPS_PROXY` is injected only after this run's own mitmdump reports that it is listening. If mitmdump exits, fails to bind, or stays silent for 8 s, the run goes untapped with a `[warn] kiro: MITM tap skipped …` line instead of pointing at another run's proxy.
- `ach run` prints `progress` and `error` event lines in full (#111), with continuation lines aligned under the first. `text` and tool previews are still clipped.

## [0.15.0] - 2026-10-01

### Added

- `kiro-ide` agent (#110): `ach run --agent kiro-ide` drives the Kiro IDE desktop app over Chrome DevTools Protocol, so workspace `.kiro/hooks/*.json` hooks, which `kiro-cli` does not load, actually fire and can be A/B tested. Flags: `--kiro-ide-cdp host:port` (attach to a running IDE), `--kiro-ide-port`, `--kiro-ide-bin`, `--kiro-ide-user-data-dir` (default profile `~/.local/state/ach-kiro-ide/profile`, signed in once) and `--kiro-ide-no-new-session`. Metering is credits only (`Est. Credits Used`); tokens are unavailable. `ach doctor --agent kiro-ide` checks the binary, CDP reachability, sign-in state and the chat input, and fails when the UI selectors no longer match the installed Kiro version. See the README section "Kiro IDE (desktop app)".
- `kiro-ide` is wired everywhere an agent is named: `AGENTS`, `defaultAdapters()`, the package exports (`KiroIdeAdapter`), the MCP run tools (`agent` enum, a `kiroIde` argument), `ach run`/`ach preflight`/`ach doctor` flags, and the dashboard pane maps. `ach preflight --agent kiro-ide` runs the same read-only CDP rows as doctor. A `--budget-usd` cap on `kiro-ide` warns that it cannot fire (credits only), as for `kiro`.
- `kiro-ide` runs in the folder `ach run` was started from: ach points the IDE window at it with `--reuse-window` and waits for the chat to settle after the switch. A prompt counts as submitted only when the chat pane (not a session tab label) echoes it in full, a turn is bounded at 15 minutes, a second concurrent run against the same IDE is refused (one lock per CDP endpoint), and `ACH_KIRO_IDE_DEBUG=1` emits the adapter's readiness and submit checkpoints as `progress` events. Verified live on Kiro IDE 1.2.4 (macOS) with a two-workspace hook A/B: the `PreToolUse` marker hook fired only in the workspace that has it, in both switch directions.

## [0.14.0] - 2026-10-01

### Added

- `prime` agent: Prime Intellect's Prime Agent CLI (`prime-agent`). `ach run --agent prime` and the MCP run tools (`harness_run`, the jobs tool) launch `prime-agent -p --mode json`; `--model` passes through verbatim (`<provider>/<model>`) and `--resume` uses `-r`. Each model call carries start and end events, so per-call latency is measured. Usage is counted once per assistant message, a provider-reported cost of 0 is shown as `n/a` rather than $0, and subagent (`rlm.spawn`) usage, which is not in the JSON stream, is added at the end of the run from the child session files under `~/.prime/agent/session-artifacts/`. `ach doctor --agent prime` checks the `prime-agent` binary (with an install hint), auth (`PRIME_API_KEY`, `~/.prime/agent/auth.json`, or a provider `apiKey` in `~/.prime/agent/models.json`) and the MCP servers in `~/.prime/agent/settings.json`. Ancestor instruction detection and `--hermetic` cover `AGENTS.md` and `CLAUDE.md` all the way up to `/`, because prime does not stop at the git root. `ach stats`, `ach watch` and `ach archive` meter `~/.prime/agent/sessions/*.jsonl` and its subagent sessions without double counting (the parent's `child_usage_attributed` summary is ignored). `--agent` filters on `ach stats` and `ach archive` now validate against the transcript registry. There is no vendor quota source, so quota is `n/a`.

## [0.13.0] - 2026-09-30

### Added

- `ach run` and `ach preflight` take a new repeatable `--extra-arg <token>`, which passes ONE verbatim argv token to the launched agent and never splits it. A value with spaces now works, for example a codex config override `--extra-arg -c --extra-arg 'developer_instructions="a b"'`. Tokens from `--extra-arg` and `--extra-args` reach the agent in command-line order. Both flags are now listed in `ach run --help`, `ach preflight --help` and the README ("Passing extra CLI args to the agent"); `--extra-args` was previously undocumented in the usage text.

### Fixed

- `npm run typecheck` is green again: three `AtifWriter.fromEvents` calls added in `tests/kiro-events.test.ts` for #107 passed only `agent`.

## [0.12.1] - 2026-09-30

### Fixed

- Kiro ACP tool calls are no longer recorded with empty arguments (#107). kiro-cli announces each tool call twice for one `toolCallId`: first with the id only, then with `title`, `kind`, `locations[]`, `rawInput` and `_meta.kiro.toolName`. The normalizer now holds back the tool start until `rawInput` arrives and emits ONE `tool_call` per id whose `arguments` are the richest `rawInput` seen, with `title` and `locations` as optional display fields. If the input never arrives, the start is emitted on the first `tool_call_update` for that id (merging its input), on the next streamed chunk, at the end of the turn, or at end of stream. This fallback is driven by events, not timers. Metadata frames between the two announcements do not trigger it. Both raw announcements stay in the transcript as `toolCallPending` / `toolCallDuplicate` steps. The dashboard feed shows the kiro title (for example `Reading notes.md:1`) on the tool card, with the full input in the detail. Tool counts and durations are unchanged: there is still one `tool_call` per id.
- Kiro streamed chunks now become canonical message events, and Kiro ACP runs get a per-request structure (#108). The normalizer joins each contiguous run of same-kind chunks into one `message`. Assistant text becomes a normal agent message. Thought chunks become a message flagged `reasoning: true`, the same form codex uses. A run is ended by a change of chunk kind, a tool announcement, the metering frame, the end of the turn, or end of stream. So text → tool → text → tool → text gives 3 assistant messages, not 1. The raw `chunk` steps are kept. The final message now holds only the last text segment, never the whole response, so no text is emitted twice; the whole text is still `state().messageText`. On ACP only, each request that streams text gets a derived `model_call_start` / `model_call_end` span, from its first chunk to the next tool announcement, metering frame or end of turn. Both events are marked with the new optional `provenance: 'estimated'` and never carry `usage` or `outputTokens`, so web metrics, otel, langfuse and ATIF totals are unchanged. `deriveLatency` leaves them out of TTFT, model-call latency and throughput. The web span view labels them `llm call (estimated)`, and the `ach run` live stream labels them `estimated`. Headless kiro keeps its existing first-request boundary and gets no derived spans. In the dashboard feed, a coalesced message (or reasoning message) whose text matches the streamed row confirms that row in place instead of adding a duplicate row. A message flagged `reasoning` (kiro or codex) now renders as a dim reasoning row, never as the answer.

## [0.12.0] - 2026-09-29

### Added

- Ancestor instruction files and `ach run --hermetic` (#106). Before launch, `ach run` lists the instruction files the agent would load from ANCESTOR directories of its cwd: claude `CLAUDE.md`/`CLAUDE.local.md` up to `/`, codex `AGENTS.override.md`/`AGENTS.md` and gemini `GEMINI.md` up to the git root. For example, a workspace under `$HOME` loads `~/CLAUDE.md` despite `--setting-sources project,local`. `ach run` warns about them on stderr, shows an `ancestors` summary line, and records them as the optional `ancestorInstructions` on the RunRecord and RunResult. MCP `harness_run` also adds them to its `warnings`. `--hermetic` copies the workspace to a fresh `mkdtemp` under `os.tmpdir()` (or `$AGENTIC_CODING_HARNESS_HERMETIC_ROOT`) and fails with a non-zero exit before launch if that copy still has ancestor instruction files. Otherwise the agent runs there, and the edits and deletions sync back before `--verify`; deletions apply only to paths that existed in the copy. The temp dir is then removed, and kept only if the sync-back fails. The run records `hermetic: {tempDir, source, avoided?, synced}` while keeping the original `cwd`. `--hermetic` is also available on `ach trial --matrix`/`--suite` and MCP `harness_run`/`harness_run_async` (`hermetic: true`); it cannot be combined with `--resume` or `--parallel > 1`.
- Spend by git branch (#47): the driver records the git `branch` and short `commit` of the run's working directory on the RunRecord at run start (one `git rev-parse`, 1.5 s timeout, errors swallowed; a non-repo records nothing, a detached HEAD records `commit` only). `ach stats --by branch` adds a per-branch table and an additive `byBranch` key in `--json`; runs and transcript rows with no recorded branch fall into an explicit `(no branch)` bucket, detached runs into `(detached <sha>)`. Transcript rows are attributed only through their matching run record's session id; no git call per row.
- Latency metrics (#32): `deriveLatency` in `src/core/latency.ts` (re-exported from `src/web/derive.ts`) derives time to first token (TTFT), end-to-end model-call latency, generation throughput (output tokens/s) and time per output token (TPOT), and a per-tool duration breakdown (count, avg, p50, p95, max, total, errors) from event timestamps. Shown as `ttft` / `tok/s` / `tpot` cards and a tool table in the `/trio` metrics pane (`latency` on `/api/runs/:runId/observability`), as `ttft` / `throughput` / `tools` lines in the `ach run` summary, recorded as an optional `latency` field on the RunRecord at finalize, and copied onto each `ach stats --json` `runs[]` row. Unmeasurable metrics are `null` / `n/a`, never 0 or NaN. TTFT and throughput need `model_call_start`/`model_call_end` events, which no built-in adapter emits yet; built-in runs with tool events get the per-tool breakdown.
- `ach import --agent claude [--days N=30] [--transcript-dir <root>] [--state-dir <stateDir>] [--dry-run] [--json]` records existing Claude Code sessions as RunRecords with the new `source: "imported"` value, so dash/web/compare show history from day one. Re-imports are idempotent (deterministic run id, no wall-clock fields), a session already owned by a native run is skipped and reported, sessions older than the window are reported as `skipped-outside-window`, and a corrupt transcript is an error line while the import continues with exit 0. `ach stats` totals are unchanged by import. Stats never sums RunRecord totals, so each session is still counted once from its transcript (#25).
- `ach stats --origin all|native|imported|transcript` filters rows by provenance. Once imported sessions exist, text output shows `origin:` lines and `--json` shows `origin` and `origins` (#25).
- Tamper-evident metering (#59). Every event line the driver writes to a run's raw transcript (`<stateDir>/raw/<agent>-<session>.jsonl`) and to run-to-directory `events.jsonl` now carries a per-run sha256 hash chain (`{"ach_chain":{v,run,seq,prev,hash}, ...event}`). Each run ends with an `ach.seal` record over the event count, the last hash, and the sealed metering totals. The seal is mirrored into the new optional `RunRecord.seal` and into `status.json`. The new `ach verify-run <runId|runDir> [--json] [--records]` recomputes the chain and exits 0 when intact, 2 when tampered (naming the first bad line), 3 for an unsealed legacy log, and 4 for an open, never-sealed chain. `ach audit` rows gain a `chain` verdict, and `ach report` gains a per-run `seal` column. `ach audit --fix` corrections are undone and disclosed, not reported as tampering. The README documents the chain format and threat model: tamper-evident, not tamper-proof. `stripChain`, `parseFramedLine`, and `verifyChainText` are exported from the library.
- `/api/compare?by=branch` (alias `by=git.branch`) groups the rollup by git branch, and the `ach report` HTML gains a "spend by git branch" table (branch, runs, cost, tokens). Runs with no branch fall in `(no branch)` and detached HEADs in `(detached <sha>)`, matching `ach stats --by branch` (#47).
- `ach web` feed rows now end in a context-window gauge. It shows tokens and % of the model's window, with a tick at the 85% warn threshold and teal/yellow/red at 50%/80%. Tool rows carry the last model call's value dimmed. A yellow `+Δ` marks the call that grew the context. Hovering shows the input · cache-read · cache-write breakdown. The value comes from the same server-side context meter as `usage.context` and travels as an optional per-event `ctx` field. Unmetered agents show no gauge, and an unknown window shows tokens only.
- `ach trial --matrix plan.json [--dry-run] [--retry-failed] [--json]` runs a declared grid of agents × tasks × models × trials. Each child run is labelled with `experiment`, `variant` (default `{agent}:{model}`), and a deterministic `cellId = agent:task:model:trialN` (new optional RunRecord field). An append-only `<plan>.ledger.jsonl` gets one row per finalized cell, so a killed run resumes where it stopped. Cells end as `passed`, `verify-failed`, `error`, or `skipped-unavailable`. A verify failure, including a budget or turn-limit stop, is a verdict: it is resumed and never retried. `--retry-failed` re-runs only infrastructure errors. The exit code is 1 only on errors or an interrupted run. Tasks are inline prompts or task directories (`task.md`, `setup.sh`, `verify.sh`, `meta.json`). The plan schema is in `docs/TRIALS.md`, with an example at `examples/trial-matrix.json` (#56).
- `ach trial --suite core` runs 12 bundled self-checking tasks from `tasks/`: shell, JavaScript and Python; implement, bug-fix and refactor, two of them multi-file. They run as a resumable matrix with `--agent`, `--task`, `--model`, `--repeat`, `--tasks-dir`, and `--ledger`. By default every installed agent runs. Missing CLIs are skipped with a printed reason and never counted as failures. Records carry experiment `suite/core` and variant `{agent}:{model}`. The ledger, per-cell results, and an HTML report go to `<stateDir>/suites/`. In CI, `scripts/verify-tasks.sh` checks every task both ways: its check must fail on the starter and the `broken/` variant and pass on the reference solution (#51).
- Latency (#32): built-in adapters now emit `model_call_start`/`model_call_end`, so TTFT is measured for claude (every call, main loop and sub-agents, first completed content block), gemini (every call, first streamed chunk), codex (first request of each turn) and headless kiro (first request, first streamed chunk). Output tokens/s and TPOT are measured for claude only, from per-message `output_tokens`; the figure is an upper bound because it counts at content-block granularity. opencode and kiro ACP streams carry no request timing and get no boundaries. Boundary events carry a new non-summed `model_call_end.outputTokens` rather than `usage`, so run totals, web token series and otel/langfuse/atif spans are unchanged. `deriveLatency` reads `outputTokens` and counts kiro chunk steps as output. The `ach run` live stream folds each boundary pair into one `model` row (model · output tokens · duration).

### Changed

- The ccusage hint after `ach stats` now suggests `ach import` first and keeps ccusage as the alternative (#25).
- Imported sessions have no task verdict. They show `?` in `ach dash` (`effectiveStatus: null` in `--json`), are left out of the `ach stats` run-outcome, repeat-group, and unmetered rollups and the `ach status` run counts, are never live, and have no PTY in `ach web` (#25).
- Readers of `events.jsonl` and raw transcripts: lines now start with an `ach_chain` key, and the file ends in an `ach.seal` record. Every other event field is unchanged, and `stripChain(line)` returns the exact pre-chain line.
- Removed the unused `safePrice` helper. Added a regression test confirming `ach watch` bills 1h cache writes at the 1h rate (#105).

### Fixed

- `claude-opus-5-5` is priced at Anthropic's list rates (input $4, output $20, cache read $0.20, 5m cache write $5, 1h cache write $8 per MTok) instead of the `estimated` copy of `claude-opus-5`, which overstated real runs by about 47% (#105).
- Cache writes are billed per TTL. Claude usage records split writes in `usage.cache_creation` (`ephemeral_5m_input_tokens` / `ephemeral_1h_input_tokens`), and Claude Code writes with the 1h TTL, which costs 2x input rather than the 1.25x 5m rate. The stream adapter, transcript monitor, normalizer, `ach stats` / `status` / `watch`, and `ach audit` now carry the 1h count as the new optional `CanonicalTokenRecord.cacheWrite1hTokens` (`cacheWriteTokens` stays the 5m + 1h total). The pricer bills each bucket at its own rate. Every Claude model has a 1h rate (`cache_creation_1h`, or the LiteLLM field `cache_creation_input_token_cost_above_1hr` in override files). When a record has no split, writes are billed at the 5m rate. Two real opus-5-5 runs now reproduce the CLI-reported cost to the micro-dollar (#105).
- When a CLI-reported slice cost is not used, per-model slices of a multi-model claude run apportion the run-level 1h share by each slice's writes, because `result.modelUsage` carries no TTL split (#105).
- The context meter no longer treats claude `<synthetic>` messages (CLI-written, zero usage) as model calls. Previously they reset occupancy to 0 and reported the run's context as n/a.
- Web run replay (`RunEventHub.readTranscript`) and MCP `harness_run_events` no longer expose the `ach_chain` framing or the `ach.seal` record, so their output matches the pre-#59 view (#59). New export `unchainedLines`.

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
