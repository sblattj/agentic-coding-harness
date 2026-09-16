# Token counting — per-agent field reference

> **STATUS:** written against the actual code: extraction semantics = `src/core/normalize.ts`
> (the `normalizeUsage` dispatcher), stream shapes = `src/adapters/{codex,gemini}.ts`, transcript
> tap = `src/cli/lib.ts`, pricing = `src/core/pricing.ts`. Where two code paths disagree, both are
> documented and the divergence is flagged ⚠ for the orchestrator.

Canonical convention (`core/normalize.ts` records): **`inputTokens` is uncached-only**;
`cacheReadTokens`/`cacheWriteTokens` carry the prompt-cache traffic; `reasoningTokens` is
informational. No stored grand total — derive at render time.

---

## 1. Per-agent field reference

### Claude Code (transcript tap `claude`, stream tap ready)

| Native field | Where | Meaning |
|---|---|---|
| `message.usage.input_tokens` | each transcript/assistant line | uncached input (Claude convention: cache separate) |
| `message.usage.cache_read_input_tokens` | same | prompt-cache hits |
| `message.usage.cache_creation_input_tokens` | same | prompt-cache writes |
| `message.usage.output_tokens` | same | completions |
| `message.costUSD` / `obj.costUSD` | same | provider-computed cost, when present |
| `result.modelUsage["<model>"].{inputTokens,outputTokens,cacheCreationInputTokens,cacheReadInputTokens}` | final result payload | per-model turn totals (camelCase) |

**→ canonical:**
- Transcript tap (`cli/lib.ts extractClaudeRecordFromLine`): use fields as-is (input already
  uncached), `costUSD` preferred, else priced through the shared `Pricer` (`core/pricing.ts`).
- Stream tap (`normalizeClaude`): accepts three shapes — a flattened `ClaudeModelUsage` entry
  (`model` + camelCase fields), a snake_case assistant-usage block, or the whole `result.modelUsage`
  map (entries summed into one record; model degrades to `"a+b"` when multiple models ran).
⚠ `ClaudeModelUsage` requires a `model` key *inside* each entry, but `result.modelUsage` entries
are keyed *by* model and typically omit it — the flattened path may not match real result maps.

### OpenCode (stream tap `opencode`, SQLite tap stubbed)

Event: `message.part.updated` with `part.type === "step-finish"`.

| Native field | Where | Meaning |
|---|---|---|
| `part.tokens.input` | step-finish part | prompt tokens — **opencode already reports this as uncached input** (`normalizeOpencode` uses it as-is) |
| `part.tokens.output` | same | completions, excluding reasoning |
| `part.tokens.reasoning` | same | reasoning tokens |
| `part.tokens.cache.read` / `.write` | same | cache read / write |
| `part.cost` | same | provider-computed cost |

SQLite tap (`statsFromDb` in `adapters/opencode.ts`): readonly `bun:sqlite` over candidate paths
(`~/.local/share/opencode/storage.db`, `~/.opencode/storage.db`, macOS App Support path); stub
probes for a usage-ish table and returns `[]` until the real schema mapping lands — `harness watch`
degrades to Claude-only tailing.

**→ canonical:** `inputTokens = input` (no adjustment — do NOT subtract cache here) ·
`cacheReadTokens = cache.read` · `cacheWriteTokens = cache.write` ·
`outputTokens = output` (reasoning kept separate in `reasoningTokens`, *not* re-joined).

### Codex CLI (stream tap `codex`)

Event: `codex exec --json` → `turn.completed` with `usage`.

| Native field | Where | Meaning |
|---|---|---|
| `usage.input_tokens` | turn.completed | prompt tokens **including** cached (OpenAI accounting) |
| `usage.cached_input_tokens` | same | cache-read slice (subset of input) |
| `usage.cache_write_input_tokens` | same | rare explicit cache-write figure |
| `usage.output_tokens` | same | completions **including** reasoning |
| `usage.reasoning_output_tokens` | same | the reasoning slice |
| `usage.total_tokens` | same | CLI grand total |

**→ canonical (the former two-path split is closed — both paths now apply the same rule):**
`inputTokens = max(0, input_tokens − cached_input_tokens)`, `cacheReadTokens =
cached_input_tokens` — uncached-input convention applied in `normalizeCodex` and in the adapter
stream path alike.

The session-cumulative counterpart (`info.total_token_usage` / `info.last_token_usage` in the
protocol) is not yet handled — see Trap 2 for why it must stay delta-based when it lands.

### Gemini CLI (stream tap `gemini`)

Event: `--output-format stream-json` → `result` event with `stats`.

| Native field | Where | Meaning |
|---|---|---|
| `stats.input` | result.stats | explicit uncached prompt slice — **input = prompt − cached** pre-computed by the CLI |
| `stats.input_tokens` | result.stats | total prompt tokens **including** cached |
| `stats.cached` | result.stats | cached portion of the prompt |
| `stats.output_tokens` | same | completions |
| `stats.thoughts` | same | thinking tokens (billable output) |
| `stats.total_tokens`, `stats.duration_ms` | same | CLI total and wall-clock |

**→ canonical:** the adapter prefers `stats.input` and falls back to deriving it
(`max(0, input_tokens − cached)`); `cacheReadTokens = cached`; `cacheWriteTokens = 0` (Gemini
reports no write count); reasoning kept in `reasoningTokens` without re-joining output.
⚠ `normalizeGemini` (raw-payload path) parses a *different* shape —
`stats.models.<model>.tokens.{prompt, candidates, cached, thought}` (multi-model map, `thought`
re-joined into output) — while the adapter parses the flat `stats` above. Same CLI, two wire
shapes; reconcile on merge.

### Kiro (stream tap + auto-started MITM tap, both shipped)

| Native field | Where | Meaning |
|---|---|---|
| `tokenUsage.{inputTokens,outputTokens,cacheReadTokens?,cacheWriteTokens?}` | observed API responses | per-request usage |
| `meteringEvent` | observed events | credits consumed |

**→ canonical:** `normalizeKiro` maps `tokenUsage` fields as-is (Kiro's taxonomy already treats
input as uncached); the MITM tap's `meteringEvent` credits land in `extra.credits` — metering
units, **not USD**, never priced (see §3).

#### Kiro on 2.21.x — no source carries a token count

Measured 2026-09-12 against `kiro-cli 2.21.2` (engine v2, API-key auth) with one tapped Haiku
headless run plus kiro's own session store for two probe runs. Fixtures:
`tests/fixtures/kiro/session-store-auto.json`, `tests/fixtures/kiro/session-store-haiku.json`
(sanitized copies of `~/.kiro/sessions/cli/<nativeSessionId>.json`).

| Source | Token fields it exposes | Value observed |
|---|---|---|
| MITM tap — `metadataEvent` / `meteringEvent` frames | `tokenUsage.{uncachedInputTokens,cacheReadInputTokens,cacheWriteInputTokens,outputTokens,totalTokens}` | **all `0`** |
| Session store — `session_state.conversation_metadata.user_turn_metadatas[i]` | `input_token_count`, `output_token_count`, `cache_read_input_token_count`, `cache_write_input_token_count` | **all `0`** |
| Stream / ACP `metadata` frames | *(no token field at all)* | — |

So on this version **every token counter in every available source is zero**, and a zero there is
indistinguishable from "not reported". The harness therefore reports `usage.tokens.available =
false` and every renderer (`harness run` summary, `harness dash`, the HTML report) prints `n/a`
for input/output/cache — never `0`. USD follows: nothing maps credits to dollars, so
`usage.usd.available = false` and the cost cell is `n/a`, never `$0.0000`. Passing `--budget-usd`
to a kiro run emits
`budget: usd cap is not enforceable for kiro (credits only); wall/idle/maxTurns still apply`.

**What kiro *does* expose, and where it is read:**

| Signal | Source field | Surfaced as |
|---|---|---|
| credits (authoritative charge) | stream `metadata.meteringUsage[].value` (cumulative) > session store `metering_usage[].value` > tap `meteringEvent.credits` | `usage.credits.value`, `RunRecord.totals.credits`; every source kept in `usage.credits.sources` |
| effective model | session store `rts_model_state.model_info.model_id`, per-turn `model` | backfilled onto token records whose `model` was `"unknown"` (post-hoc: pricing is NOT re-run, USD stays unavailable) |
| context-window occupancy | `context_usage_percentage` / `final_context_usage_percentage` × `model_info.context_window_tokens` | `usage.context` (`source:'derived'`), rendered `ctx ≈ N tok (p%)`, `RunRecord.totals.contextTokens` |

The three credit sources are reconciled to **one** charge in `src/core/usage-availability.ts`
(authority order above, tolerance `1e-9`); they are never summed together, and any disagreement
becomes a run warning naming all three values. Context tokens are **derived, not billed** — the
`≈` and the separate column are deliberate, and a window taken from the fallback table is marked
`windowSource:'assumed'`.

Nothing here is fabricated: a field the store does not carry comes back `undefined`, not `0`.
Re-derive by symbol: `parseKiroSessionStore` (`src/adapters/kiro-session-store.ts`),
`computeUsageAvailability` (`src/core/usage-availability.ts`).

---

## 2. Double-counting traps

**Trap 1 — iterations[] / aggregate double-read.** Claude streams carry per-assistant-message
usage *and* the final `result.modelUsage` aggregate; `normalizeClaude`'s map path additionally
sums entries itself. A tap that sums transcript messages *and* consumes the final result (or lets
two taps write the same run) counts the turn twice. Rule: one tap layer per run; the transcript
tap writes per-line records, the stream tap writes per-usage-event records, never both.

**Trap 2 — cumulative vs delta.** Codex's protocol exposes `total_token_usage`
(session-cumulative) alongside `last_token_usage` (this turn). Writing cumulative numbers into
per-turn rows makes every turn repeat the whole session and inflates dashboards quadratically.
Use the per-turn delta, or delta consecutive cumulative records. The current code only consumes
`turn.completed` usage (per-turn), which is safe — keep it that way when cumulative lands.

**Trap 3 — cached-in-input asymmetry.** Three conventions:

| Provider | Cache inside reported input? | Canonical `inputTokens` |
|---|---|---|
| Claude | **No** (separate `cache_*_input_tokens`) | as-is |
| Codex/OpenAI | **Yes** (`cached_input_tokens ⊆ input_tokens`) | `input − cached` |
| Gemini | **Yes** (`cached ⊆ input_tokens`) | `input` field if present, else `input_tokens − cached` |

Adding cache reads on top of an input that already contains them double counts; forgetting to
subtract for codex overcounts fresh input. The former live instance (`adapters/codex.ts` emitting
unadjusted input) is closed — both codex paths subtract now (§1). Also never compare raw `input`
across providers without normalizing first.

**Trap 4 — reasoning-token placement.** Codex bills reasoning inside `output_tokens` (with the
slice repeated in `reasoning_output_tokens`); Gemini reports `thoughts` separately from
`output_tokens`; OpenCode keeps `reasoning` separate. `sumTokens` treats `reasoningTokens` as
informational — never add it to `outputTokens` for codex (already inside), and cost math uses
each provider's own billed categories.

**Trap 5 — per-step input re-sends context.** Every step re-sends the growing conversation, so a
multi-step run legitimately bills far more input than the final context size suggests. Not a bug;
a tap must not "correct" it by keeping only the last step.

## 3. Cost formula

`core/pricing.ts` (`Pricer.price`), per model record:

```
cost_usd = ( inputTokens        × price.input
           + cacheReadTokens    × price.cache_read
           + cacheWriteTokens   × price.cache_creation
           + outputTokens       × price.output ) / 1_000_000
```

- Embedded fallback table (LiteLLM-verified per-1M USD): `claude-sonnet-4` 3/15/0.3/3.75,
  `claude-opus-4` 15/75/1.5/18.75, `gpt-5` 1.25/10/0.125/0, `gemini-2.5-pro` 1.25/10/0.31/0
  (fields: input/output/cache_read/cache_creation). Claude cache-creation is the 5m-TTL blended
  1.25× base.
- External LiteLLM-style cost maps are accepted via `createPricer(costMapPath)`, in per-1M fields
  or per-token fields (auto-scaled ×1e6); `resolveAlias` strips provider prefixes, date stamps,
  and `-latest/-preview` so `anthropic/claude-sonnet-4-20250514` matches `claude-sonnet-4`.
- Unknown model → `NaN` + warning surfaced in `RunResult.warnings` — cost is never silently 0
  (exception: credit-metered kiro records, below).
- **Reported beats computed:** the transcript tap prefers `costUSD` when the row carries it;
  the driver accumulates computed cost otherwise. Provider-reported figures always win.
- The CLI transcript tap prices unpriced rows through this same `Pricer` (`cli/ach.ts`) — the
  old `cli/lib.ts estimateCostUsd` prefix table is gone (that merge is closed).

### Credit metering (kiro) and multi-model runs

- **Kiro: credits are the only signal.** Under the tap kiro-cli runs `--agent-engine v2` (v3's
  model-catalog fetch dies behind mitmproxy); the v2 wire exposes no model id and no usable token
  counts, so `meteringEvent` credits are the metering unit. They ride `extra.credits` — kiro
  units, **never USD** (the pricer returns 0 silently for credit-metered records instead of
  spamming an unknown-model warning). A/A-verified: the tap's records match kiro's own session
  file (`~/.kiro/sessions/cli/<uuid>.json`, `metering_usage`) bit-for-bit; credits surface in the `harness run`
  summary, the registry `totals.credits`, and dash's CREDITS column.
- **Multi-model records price per-slice.** Claude aggregates mix models (a haiku sub-agent probe
  inside an opus run), and pricing the aggregate at one rate underprices (observed $0.0214 vs the
  true $0.1028). The pricer sums per-model slices from `extra.raw.models` — each slice's
  CLI-reported `costUsd` when present, else its tokens at its own model's rates; one unpriceable
  slice voids the record (NaN + warning, never a partial sum). The record's model label is the
  dominant slice by cost (fallback `multi`), never first/last key order.

---

## 4. Normalized usage/cost on the run result (#7)

`RunResult.usage.cost` (type `ReportedUsageCost`, computed in
`src/core/usage-availability.ts`) is the one normalized shape consumers read
instead of re-parsing adapter stdout:

```ts
result.usage.cost = {
  costAvailability: 'reported' | 'unavailable',
  reportedCostUsd: number | null,   // null exactly when "unavailable"
  tokens?: {                        // run totals, canonical field names
    inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens,
    reasoningTokens?
  }
}
```

- **`reported` only when the provider itself stated a USD figure** — claude
  `result.total_cost_usd` (whole-run) and opencode `step-finish` `cost`
  (per-step, summed). Codex and Gemini emit token usage but no native cost;
  kiro is credits-only. In those cases: `'unavailable'` + `null` — never the
  pricer's estimate (`usage.usd`) and never kiro credits laundered into USD.
- `tokens` totals follow the same truth rules as the registry counters:
  placeholder records (`extra.tokensAvailable === false`, kiro 2.21.x) are
  skipped, and the key is omitted entirely when nothing usable remains. For
  kiro the session store's per-turn counts win when it carries real ones.
- Provider comparison/scoring is out of scope by design: the field surfaces
  the numbers, it never ranks them.
