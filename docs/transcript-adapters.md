# Read-only transcript adapters

ach meters coding agents it did not launch by reading the session files they
leave on disk. Claude Code, Codex CLI and Gemini CLI are read by
`src/monitors/transcripts.ts`. Cursor, Amp, Goose and Qwen Code are **read-only
sources**, registered in `src/monitors/transcript-sources.ts`
(`TRANSCRIPT_SOURCES`). ach reads their stores but cannot launch them.

Read-only sources feed `ach stats` (`scanAll`), `ach watch`, `ach dash`, and `ach web`. Dashboard projections are read-only, labeled `source: transcript`, and omit sessions already represented by harness registry records. `dash --state-only` and `web --state-only` exclude these projections. Dash and web refresh transcript projections every 30 seconds. They never
write to the run registry, and `ach run --agent cursor|amp|goose|qwen` fails with a
`READ_ONLY_SOURCE` error that points at `ach stats --agent <x>`.

## Contract

```ts
interface TranscriptSource {
  agent: CanonicalTokenRecord["agent"];          // label + --agent filter value
  defaultRoots(home: string): string[];          // dirs walked recursively
  keep(filePath: string): boolean;               // which files are transcripts
  parse(filePath: string): Promise<CanonicalTokenRecord[]>;
}
```

- **Output.** Every parser returns `CanonicalTokenRecord` from
  `src/monitors/transcripts.ts`. `input` counts **uncached** prompt tokens
  only. `cacheRead` and `cacheWrite` are separate. `reasoning` is a subset of
  `output`. A value the source does not record is `null` for
  `sessionId`/`timestamp`/`model`, never a guess. A record with no model gets
  no cost.
- **Errors.** A parser never throws. An unreadable file, a malformed line, or
  a record whose split cannot be known is skipped. The parser pushes one line
  to `warnTranscript()` (`src/monitors/transcript-warnings.ts`). `ach stats`
  and `ach watch` drain those warnings to stderr as `[warn] <agent>: ...`, and
  the run continues. All-zero records are dropped without a warning.
- **Honesty.** If a total arrives without an input/output split, the record
  is skipped with a warning. It is never attributed to one side, because that
  would be an estimate.
- **Fixtures.** Each source ships at least one happy-path fixture, which the
  tests match exactly with `deepStrictEqual`, and at least one malformed
  fixture, which must yield the good records plus a warning. Fixtures are
  synthetic, trimmed to the fields the parser reads, and contain no real
  paths, prompts or outputs (text is `(redacted)`, cwd is `/work/demo...`).
  Their provenance is recorded below.
- **Adding a CLI** needs one parser module, one `TRANSCRIPT_SOURCES` entry,
  fixtures, tests in `tests/transcript-adapters.test.ts` and a row in the
  matrix below. `src/core` does not change. Read-only agents are deliberately
  kept out of core `AGENTS`, so the driver can never try to launch them.

## Matrix (last verified 2026-09-27)

| CLI | Status | Store (per OS) | Format seen | Accounting and caveats | Provenance |
|---|---|---|---|---|---|
| **Amp** | implemented (`src/monitors/amp.ts`) | `~/.local/share/amp/threads/**/*.json` (all OSes, as read by ccusage) | One JSON object per thread: `id`, `messages[]`, optional `usageLedger.events[]` | Ledger events are used when present (one record per event), and cache tokens come from the assistant message with `messageId == toMessageId`. Otherwise each assistant `usage` gives one record. `inputTokens` is uncached-only (10 + 986 + 11372 = `totalInputTokens` 12368 in ccusage's fixture). `totalTokens`-only usage is skipped with a warning. `credits` is not read. | Amp is closed source, so no vendor schema exists. Shape taken from ccusage `rust/adapters/amp/src/parser.rs` and its tests @ `a0a1fc53`. No local sample on the verifying machine. |
| **Goose** | implemented (`src/monitors/goose.ts`) | `sessions.db` under `~/.local/share/goose/sessions/` (Linux), `~/Library/Application Support/goose/sessions/` (macOS), `~/.local/share/Block/goose/sessions/` | SQLite. The current schema has a `usage_ledger` table. Older DBs have only `sessions.accumulated_*` | Uses `usage_ledger` when it exists (one record per model call, `created_timestamp` in unix seconds). `carried_forward` back-fill rows have no model, so `model: null` and no cost. Goose input is **cache-inclusive** (`Usage::from_cache_exclusive_input`), so canonical input = input - cache_read - cache_write. A legacy DB gives **one record per session** from `accumulated_*`, timestamped at `created_at` (UTC). A legacy session with no `accumulated_*` is skipped with a warning, because the per-call columns hold only the last call. Reads go through the `sqlite3 -readonly -json` CLI, like opencode. If `sqlite3` is missing, the source warns and yields nothing. `ach watch` detects growth in the `-wal` sidecar. On a legacy DB, `watch` differences per-session snapshots and emits only the growth. | Vendor: block/goose `crates/goose/src/session/session_manager.rs` (DDL, ledger insert, back-fill) and `crates/goose-provider-types/src/conversation/token_usage.rs` @ `98c626d7`. Default paths from ccusage `rust/adapters/goose/src/paths.rs` @ `a0a1fc53`. No local sample. |
| **Qwen Code** | implemented (`src/monitors/qwen.ts`) | `~/.qwen/projects/<sanitized-cwd>/chats/<sessionId>.jsonl` (all OSes; `QWEN_RUNTIME_DIR` relocates it and is not followed yet) | JSONL `ChatRecord`s. Only `type: "assistant"` records carry `usageMetadata`. This is **not** Gemini CLI's chat JSON, despite the fork | input = `promptTokenCount - cachedContentTokenCount`. `thoughtsTokenCount` is added to output only when `totalTokenCount >= prompt + candidates + thoughts`: the OpenAI-converted path already counts reasoning inside `candidatesTokenCount`, and the Gemini-native path does not. When `totalTokenCount` is absent, output = candidates. Cache writes are not recorded (0). `totalTokenCount`-only lines are skipped with a warning. A line with no `sessionId` falls back to the file stem. A missing model stays `null`. | Vendor: QwenLM/qwen-code @ `3124af5b`. `packages/core/src/config/storage.ts` `getProjectDir()`, `services/chatRecordingService.ts` (`ChatRecord`, `ensureConversationFile`, `recordAssistantTurn`; the class JSDoc's `~/.qwen/tmp/...` is stale), `core/openaiContentGenerator/converter.ts` (usage mapping). Cross-checked with ccusage `rust/adapters/qwen` @ `a0a1fc53`. No local sample. |
| **Cursor** (IDE) | implemented, explicit reported counts only (`src/monitors/cursor.ts`) | `state.vscdb` under `~/Library/Application Support/Cursor/User/globalStorage/` (macOS), `~/.config/Cursor/User/globalStorage/` (Linux), `~/AppData/Roaming/Cursor/User/globalStorage/` (Windows) | SQLite `cursorDiskKV`; `bubbleId:<composer>:<bubble>` JSON values with `tokenCount.inputTokens` / `outputTokens`, `createdAt`, optional `modelInfo.modelName` | Reads only finite nonnegative integer counters with a positive reported count. Missing/all-zero usage warns as unavailable; malformed JSON/counts warn and skip. No character estimates, context snapshot counts, cache guesses, or default model. SQLite CLI required; absent/unreadable stores warn and skip. Cursor-agent text transcripts are not metered. | [codeburn reported-counter fixtures](https://github.com/getagentseal/codeburn/blob/main/tests/providers/cursor-real-tokens.test.ts), checked 2026-09-27. Synthetic fixtures under `tests/fixtures/cursor/`; no live Cursor store was present locally. |
| **Kimi CLI** | not implemented (follow-up) | `~/.kimi/sessions/<group>/<session>/wire.jsonl`; Kimi Code: `~/.kimi-code/sessions/<ws>/<session>/agents/<agent>/wire.jsonl` | JSONL wire log (`StatusUpdate.token_usage`; Kimi Code `usage.record`, where session-scoped records are cumulative) | Documented well enough to implement: `input_other`, `output`, `input_cache_read`, `input_cache_creation`. Not done in this pass, so it can be checked against MoonshotAI/kimi-cli. | ccusage `rust/adapters/kimi` @ `a0a1fc53` |
| **Droid** (Factory) | not implemented (follow-up) | `~/.factory/sessions/**/*.settings.json` | Per-session settings JSON with token counters | ccusage reads input/output/cache/thinking counters per session. Factory is closed source, so no vendor cross-check was possible. | ccusage `rust/adapters/droid` @ `a0a1fc53` |
| **Copilot CLI** | not implemented (follow-up) | `${COPILOT_HOME:-~/.copilot}/session-state/*/events.jsonl` and `.../otel/**/*.jsonl` | Session-state shutdown events and OpenTelemetry JSONL | Two input formats. ccusage's loader is about 1.1k lines and too large for this pass. | ccusage `rust/adapters/copilot` @ `a0a1fc53` (including test fixtures) |
| **Z Code** | not implemented (follow-up) | `${ZCODE_HOME:-~/.zcode}/cli/db/db.sqlite` (`model_usage`, `session` tables) | SQLite | Needs schema diagnostics across versions (see the ccusage guide). No vendor source was checked. | ccusage `rust/adapters/zcode` @ `a0a1fc53` |

None of these CLIs is installed on the machine where this matrix was verified
(`ls -d` of every default path came back empty). Every "implemented" row is
therefore fixture-tested against formats documented in the sources above.
None has been checked against a live store yet. Re-verify each row whenever
that CLI ships a storage change, because these files move between versions.

## Fixtures

| Fixture | What it exercises | Derived from |
|---|---|---|
| `tests/fixtures/amp/threads/T-demo-ledger.json` | Ledger event + cache join via `toMessageId` | Field names from ccusage amp parser; values invented |
| `tests/fixtures/amp/threads/T-demo-messages.json` | Messages fallback | ccusage test `reads_usage_from_messages_when_ledger_is_missing` |
| `tests/fixtures/amp-malformed/threads/T-malformed.json` | Non-object message, `totalTokens`-only, all-zero, non-object ledger | ccusage tests `malformed_message_element_does_not_drop_the_thread`, `falls_back_to_total_tokens_in_messages_path` |
| `tests/fixtures/amp-malformed/threads/T-truncated.json` | Unparseable file | Synthetic |
| `tests/fixtures/goose/sessions-ledger.sql` | Current schema, `usage_ledger` incl. a `carried_forward` row | DDL trimmed from block/goose `session_manager.rs` @ `98c626d7` |
| `tests/fixtures/goose/sessions-legacy.sql` | Pre-ledger schema: accumulated totals, missing totals, bad `model_config_json`, all-zero | Same DDL, pre-migration column set |
| (built in test) garbage `sessions.db` | Not a SQLite file | Synthetic |
| `tests/fixtures/qwen/projects/demo-project/chats/sess-qwen-1.jsonl` | Gemini-native and OpenAI-converted usage shapes, non-assistant records | `ChatRecord` fields from qwen-code `chatRecordingService.ts` @ `3124af5b` |
| `tests/fixtures/qwen-malformed/.../sess-qwen-bad.jsonl` | Invalid JSON line, total-only, all-zero, no sessionId/model | Synthetic, same record shape |

## Discovery and archive behavior

`watch --dir ROOT` and `stats --dir ROOT` resolve every native source under a
home-shaped root. `archive` includes all registered native sources; SQLite
stores use `sqlite3 -readonly` backups rather than copying an incomplete WAL
base file. Multiple platform roots for one agent use distinct archive paths,
and restore maps each back to its corresponding home-shaped root.

## Not yet done (tracked on #22)

- The read-only sources do not yet honour env-var relocations
  (`QWEN_RUNTIME_DIR`, `COPILOT_HOME`, ...).

Stats includes `sources.state` and `sources.transcript` buckets when transcript data is present.
The text view labels both sources; time, agent, and project filters apply before these buckets
are computed. `--state-only` excludes transcript sources and omits this extra JSON field.
