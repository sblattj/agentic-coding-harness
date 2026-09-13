# Kiro: native ACP transport, verified configuration, truthful usage (issue #2)

Base: `d0e4290` (main, v0.3.0). Branch `feat/kiro-acp`. Line numbers below are
valid at `d0e4290`; re-derive by symbol (`rg`), never trust the number.

## Ground truth (measured 2026-09-12, kiro-cli 2.21.2, engine v2, API-key auth)

Fixtures (real, sanitized, one Haiku call each): `tests/fixtures/kiro/`.

| Fact | Evidence |
|---|---|
| `buildKiroArgs` drops `spec.model`, has no agent/effort/trust/extraArgs path, hardcodes `--trust-all-tools` | `src/adapters/kiro.ts:52 (buildKiroArgs)` |
| both launch paths omit `model` and `extraArgs` | `kiro.ts:451 (#launchWithMitmTap)`, `kiro.ts:501 (#launchPlain)` |
| parser knows only legacy top-level names; current envelopes fall to `step` | `kiro.ts:84-89 (SESSION_TYPES…)`, `kiro.ts:183 (else → step)` |
| tap path fabricates zero tokens | `kiro.ts:217 (mitmRecordToUsageEvent)`, `kiro.ts:239 (kiroEventToCore)` |
| driver counts every `step` as a turn for `maxTurns` | `src/core/driver.ts:344` |
| registry already sums `extra.credits` | `driver.ts:273 (bumpRegistryTotals)`; `src/core/registry.ts:28` |
| report sums credits, cost from `costUsd` | `src/report/model.ts:106-125 (toLoadedRun)` |
| headless `--model X` prints `[warn] failed to set model 'X': Method not found` on 2.21.2 and still runs | `tests/fixtures/kiro/headless-stream-json-2.21.2.stderr` |
| headless stream-json envelopes: `runStarted{payloadSchema:"acp",engine}` → `metadata{sessionId,contextUsagePercentage,meteringUsage?[],turnDurationMs?}` → `sessionUpdate{sessionId,update:{sessionUpdate:…}}` → `runFinished{status,stopReason,finalText}` | `tests/fixtures/kiro/headless-stream-json-2.21.2.jsonl` |
| ACP is newline-delimited JSON-RPC 2.0 on stdio; **initialize returns only when `params.clientInfo` and `clientCapabilities.terminal` are present** (without them: silence forever); initialize took ~15 s locally (profile lookup retries) | `tests/fixtures/kiro/acp-handshake-2.21.2.jsonl`; log `$TMPDIR/kiro-log/kiro-chat.log` |
| `session/new` result carries `modes{currentModeId,availableModes[]}` (= native agents) and `models{currentModelId,availableModels[]}`; `session/set_model {sessionId,modelId}` → `{}` | same fixture |
| ACP notifications: `session/update` (`agent_message_chunk`, `tool_call`, `tool_call_update`), plus vendor `_kiro.dev/session/update` (`tool_call_chunk`), `_kiro.dev/metadata`, `_kiro.dev/commands/available`, `_kiro.dev/mcp/governance_disabled`, `_kiro.dev/webTools/governance_disabled`, `_kiro.dev/subagent/list_update` | `tests/fixtures/kiro/acp-prompt-2.21.2.jsonl` |
| tool shapes: `tool_call.rawInput.operations[]` (batched read), `_meta.kiro.toolName`, `tool_call_update.rawOutput.items[{Text}]`, `status:"completed"` | same |
| `meteringUsage` is an array with one entry per model call **within the turn**, emitted on the final `metadata` of the turn; reporter observed it as cumulative across turns — treat as cumulative: credits = sum of the LATEST array, never re-sum snapshots | fixture + issue text |
| `--trust-tools=` (none) did NOT block `read`; no `session/request_permission` arrived | `acp-prompt-2.21.2.jsonl` (tool completed) |
| `session/prompt` result: `{stopReason:"end_turn"}`; no token counts anywhere; USD unknowable from credits | same |
| CLI flags: `chat --agent/--model/--effort/--trust-tools=<csv>/--require-mcp-startup(exit 3)/--agent-engine`; `acp --agent/--model/--effort/--trust-all-tools/--trust-tools/--agent-engine` | `kiro-cli chat --help`, `kiro-cli acp --help` |
| `-v` on `kiro-cli acp` writes log lines to **stdout** — never pass it in the transport | probe |
| `npm test` = 295/295 green in ~3 s (`tsx --test`); `npm run typecheck` | `package.json` |

## Design

### Config surface (requested vs effective)
`RunSpec.kiro?: KiroConfig` (core), `RunArgsSchema.kiro` (MCP sync + async), CLI `--kiro-*`.
```ts
interface KiroConfig {
  transport?: 'headless' | 'acp';          // default 'headless' (compat); 'acp' when model/agent must be acknowledged
  agent?: string;                           // native agent / ACP mode id
  engine?: 'v1' | 'v2' | 'v3';              // default v2
  effort?: 'low'|'medium'|'high'|'xhigh'|'max';
  tools?: 'all' | 'none' | string[];        // trust policy. DEFAULT: undefined → NO trust flag (native agent config decides). Never implicit --trust-all-tools.
  requireMcpStartup?: boolean;              // headless: --require-mcp-startup; acp: bounded wait on governance/mcp notifications
  mcpServers?: AcpMcpServer[];              // acp only; forwarded to session/new
  startupMs?: number;                       // default 60_000 (initialize measured ~15 s)
  requireModelAck?: boolean;                // acp: fail before prompt if set_model not acknowledged (default true when model given)
}
```
`RunResult.kiro?: KiroEffective` = `{ cliVersion, transport, requested: KiroConfig, effective: {...}, nativeSessionId, modelAck: 'acknowledged'|'rejected'|'unsupported'|'not-requested', configHash }` (hash over sanitized effective config, no env). Also mirrored into `RunRecord.kiro` (registry) for the dashboard.

### Usage availability
```ts
interface UsageAvailability {
  tokens:  { available: boolean; source?: 'native'|'tap'; scope?: 'run'|'turn'|'call'; cumulative?: boolean; complete?: boolean };
  credits: { available: boolean; source?: 'native'|'tap'|'reconciled'; ... ; value?: number };
  usd:     { available: boolean; source?: 'pricer'; value?: number };
}
```
On `RunResult.usage` and `RunRecord.usage`. Rules: never emit a `CanonicalTokenRecord` with fabricated zeros — a credits-only record carries `extra.credits`, `extra.tokensAvailable:false`; the driver/report/dash render `unavailable`, not `0`/`$0.0000`. Native and tap credits reconcile to ONE authoritative charge (native wins; tap kept in `extra.audit`). Missing usage → `warnings.push('kiro: no usage records; tokens/credits/usd unavailable')`. Budget honesty: `budget.usd` with credits-only → warning `usd budget unenforceable (credits only)`; `budget.maxTurns` → counted on `runFinished`/`session/prompt` completions (native turns), not on `step` chunks.

### Events (`src/adapters/kiro-events.ts`, pure)
One normalizer for both transports. Input = a headless line (`{type,data}`) or an ACP message (`{method,params}`). Output = `CanonicalEvent[]` + `KiroMeter` updates. Dedupe `tool_call`/`tool_call_chunk` by `toolCallId` (start once, result on `status ∈ {completed,failed}`), keep unknown `_kiro.dev/*` as `step` **with `payload.kind='vendor'` and never counted as turns**, message chunks coalesce per turn, `runFinished`/prompt result → `done` with native `stopReason`.

### ACP client (`src/adapters/kiro-acp.ts`)
ndjson JSON-RPC over `kiro-cli acp [--agent] [--model] [--effort] [--trust-tools] [--agent-engine]`. Handshake: `initialize` (MUST send `clientInfo` + `terminal:false` + `fs:{false,false}`) → `session/new{cwd,mcpServers}` (or `session/load` on resume) → verify `modes.currentModeId === agent` and `models.currentModelId`/`availableModels` contains model → `session/set_model` when model requested → only then `session/prompt`. Any agent→client request (`session/request_permission`, `fs/*`, `terminal/*`) is answered per policy: permission → `cancelled`/deny outcome unless `tools` allows; recorded as an event; never broadens. `session/cancel` on abort, then SIGTERM, SIGKILL after grace. Startup deadline `startupMs`; stall → terminal artifact with `exitStatus:'timeout'` and phase (`initialize|session/new|set_model|mcp`). Never pass `-v`.

### Preflight (`harness_kiro_preflight` MCP tool + `harness preflight --agent kiro`)
No prompt is sent. Checks, each `{name, status:'verified'|'failed'|'unproven', detail}`: executable+version, auth (`kiro-cli whoami`), native agent exists (ACP `modes`), model exists + `set_model` ack, MCP/governance notifications, extraArgs allowlist (gateway). Returns a receipt with `unproven: ['task success', 'downstream tool deps', …]`. Reuses the ACP client with a session that is created then closed.

## Waves

**Wave 1 (parallel, disjoint files, base = feat/kiro-acp):**
- A `kiro-types` — `src/core/types.ts` (KiroConfig, KiroEffective, UsageAvailability, RunSpec.kiro, RunResult.kiro/usage, schemas), `src/core/registry.ts` (RunRecord.kiro/usage optional), `src/mcp/tools-run.ts` + `tools-jobs.ts` (`kiro` param + JSON schema; gateway allowlist untouched), tests.
- C `kiro-events` — new `src/adapters/kiro-events.ts` + `tests/kiro-events.test.ts` driven by the fixtures. No edits to `kiro.ts`.
- D `kiro-acp-client` — new `src/adapters/kiro-acp.ts` + `tests/kiro-acp.test.ts` with a scripted fake ACP server (`tests/fixtures/kiro/fake-acp-server.ts`) replaying the fixtures, covering silent-initialize timeout, model rejection, permission request, cancel, child cleanup. No edits to `kiro.ts`.

**Wave 2 (after A merges; parallel):**
- B `kiro-headless` — `buildKiroArgs`/`spawn`/launch paths forward model, agent, effort, tools, requireMcpStartup, engine, extraArgs; drop implicit trust-all; parse the `[warn] failed to set model` stderr line into `modelAck:'unsupported'`; switch parser to `kiro-events`; effective config into RunResult.
- G `kiro-acp-wire` — `KiroAdapter.launch` selects transport; ACP path via D; preflight tool + CLI subcommand; timeouts + owned-process cleanup.
- F `usage-truth` — driver (`fromPreNormalized`/`bumpRegistryTotals`/turn counting on native turns/usd-budget warning), tap reconciliation (`mitmRecordToUsageEvent` no zeros), report + dash + `harness ls` render `unavailable`.

**Wave 3:** H docs (`docs/KIRO.md` with A/B/C example, README, MCP.md tool list), opt-in paid calibration test (`KIRO_CALIBRATION=1`), integration verify (suite, typecheck, live preflight, one Haiku run per transport through `harness run` and through the MCP tools), issue comment, release.

## Acceptance map (issue checkboxes → proof)
1. packaged API, no caller-written client → wave 3 live run via `harness_run{agent:'kiro',kiro:{transport:'acp',…}}`.
2. settings reach the process; no prompt before acks → B/D unit tests (argv assertions; fake server asserts `set_model` before `prompt`).
3. rejection/MCP failure/permission/cancel → terminal artifacts, no broadening → D tests + G.
4. real 2.21.4-class fixtures normalize; no double counts → C tests (fixtures are 2.21.2; same envelope family as reporter's 2.21.4 sample — note the version in docs).
5. credits-only shows unavailable in JSON/dash/report; native+tap counted once; missing usage warns → F tests.
6. wall/idle/startup timeouts + child cleanup; unsupported USD/turn controls reported → D/G/F tests.
7. opt-in paid calibration retains failures → wave 3.
8. docs A/B/C example → H.

## Amendment 2026-09-12: token counts (owner request "expose token counts as well as credits")

Measured on 2.21.2 with one tapped Haiku headless run (`AGENTIC_CODING_HARNESS_STATE_DIR=/tmp/... harness run --agent kiro --json`):

| Source | Token fields | Value observed |
|---|---|---|
| MITM tap, `metadataEvent`/`meteringEvent` frames | `tokenUsage.{uncachedInputTokens,cacheReadInputTokens,cacheWriteInputTokens,outputTokens,totalTokens}` | all `0`; `credits` on `meteringEvent` = 0.04248789137645108 |
| Kiro session store `~/.kiro/sessions/cli/<nativeSessionId>.json` → `session_state.conversation_metadata.user_turn_metadatas[i]` | `input_token_count, output_token_count, cache_read_input_token_count, cache_write_input_token_count` | all `0`; also `model` (= `"auto"` — proves headless `--model` was ignored), `context_usage_percentage`, `final_context_usage_percentage`, `metering_usage[]` |
| same file → `session_state.rts_model_state.model_info` | `context_window_tokens` | `200000`; `model_id` |
| stream / ACP `metadata` | `contextUsagePercentage` | per turn |

So on this version NO source carries non-zero input/output tokens. Rule for wave-2 seat F (usage-truth):
1. **Never fabricate.** `usage.tokens.available` is `true` only when some source yields a non-zero token count. Then expose them with `source: 'tap' | 'session-store'` and `scope: 'call' | 'turn'`. When both exist and disagree, prefer session-store per turn, keep the other in `extra.audit`. Zero-valued token records from the tap are NOT token records: they carry `extra.tokensAvailable:false` and do not set `available`.
2. **Expose `contextTokens` always** (new field on `UsageAvailability`: `context: { available, source:'derived', percentage, windowTokens, tokens: round(percentage/100 * windowTokens), model? }`), derived from the latest `contextUsagePercentage` and `context_window_tokens` from the session store (fallback: model-window table with `windowSource:'assumed'`, never silent). Render as "ctx ≈ N tok (p%)" in `harness ls`, dash, report — visually distinct from billed tokens.
3. **Add a session-store reader** `src/adapters/kiro-session-store.ts` (pure parse + a locator by native session id; path override `KIRO_SESSIONS_DIR`), read once after exit. It also yields the per-turn `model` → fixes `model:"unknown"` in token records and feeds `KiroEffective.effective.model` (this is the *only* place the effective model is recorded on 2.21.2).
4. Credits reconcile across three sources (stream metadata, tap `meteringEvent`, session-store `metering_usage`): equal on the probe; authoritative order native stream > session store > tap; any disagreement → warning with all three values.
5. Registry `totals` gets `contextTokens?` (latest), and `credits` stays; the four token counters remain 0 and the dash prints `n/a` for them when `usage.tokens.available === false`.
