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
| `message.usage.cache_creation_input_tokens` | same | prompt-cache writes (both TTLs) |
| `message.usage.cache_creation.{ephemeral_5m_input_tokens,ephemeral_1h_input_tokens}` | same, and `result.usage` | cache writes split by TTL (#105); Claude Code writes with the **1h** TTL |
| `message.usage.output_tokens` | same | completions |
| `message.costUSD` / `obj.costUSD` | same | provider-computed cost, when present |
| `result.modelUsage["<model>"].{inputTokens,outputTokens,cacheCreationInputTokens,cacheReadInputTokens}` | final result payload | per-model turn totals (camelCase) |

**→ canonical:**
- Transcript tap (`monitors/transcripts.ts parseClaudeTranscript`): use fields as-is (input already
  uncached), `costUSD` preferred, else priced through the shared `Pricer` (`core/pricing.ts`).
  `usage.cache_creation.ephemeral_1h_input_tokens` becomes `cacheWrite1hTokens` (#105).
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

### Prime Agent (stream tap `prime`)

Event: `prime-agent -p --mode json` → one `usage` block `{input, output, cacheRead, cacheWrite, cost}` per assistant message, taken from `message_end` or, when prime-agent skips that event, from the `turn_end` that repeats the message; counted once per message (keyed by `responseId`). `input` is taken as the uncached prompt slice (pi convention; unverified, because the observed sessions had `cacheRead` 0). A provider-reported `cost` of 0 is treated as unpriced (`n/a`), not $0. Subagent (`rlm.spawn`) usage is not in the stream, so at `agent_end` the adapter adds the child session files under `~/.prime/agent/session-artifacts/`.

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
| Prime Agent | **No** (assumed; separate `cacheRead`/`cacheWrite`) | as-is |

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
write1h  = clamp(cacheWrite1hTokens ?? 0, 0, cacheWriteTokens)
cost_usd = ( inputTokens                   × price.input
           + cacheReadTokens               × price.cache_read
           + (cacheWriteTokens − write1h)  × price.cache_creation
           + write1h                       × (price.cache_creation_1h ?? price.cache_creation)
           + outputTokens                  × price.output ) / 1_000_000
```

- Embedded fallback table (LiteLLM-verified per-1M USD): `claude-sonnet-4` 3/15/0.3/3.75/6,
  `claude-opus-4` 15/75/1.5/18.75/30, `claude-opus-5-5` 4/20/0.2/5/8, `gpt-5` 1.25/10/0.125/0,
  `gemini-2.5-pro` 1.25/10/0.31/0 (fields: input/output/cache_read/cache_creation/cache_creation_1h).
- **Cache writes are billed per TTL (#105).** Anthropic bills a 5-minute cache write at 1.25×
  input (`cache_creation`) and a 1-hour write at 2× input (`cache_creation_1h`; LiteLLM field
  `cache_creation_input_token_cost_above_1hr`). Claude Code writes its prompt cache with the 1h
  TTL, and its usage records split writes in `usage.cache_creation`. Every Claude parser (stream
  adapter, transcript monitor, normalizer, `ach audit`) carries the 1h count as
  `CanonicalTokenRecord.cacheWrite1hTokens`. `cacheWriteTokens` stays the total (5m + 1h), so
  every token counter is unchanged. When a record has no split (older CLIs, other agents), every
  write bills at the 5m rate. That fallback under-prices real Claude Code runs by 0.75× input per
  written token. A model with no 1h rate bills a 1h split at `cache_creation`. An override-file
  entry replaces the whole bundled entry, so an override without `cache_creation_1h` bills every
  write at its `cache_creation`.
- **Multi-model records and the TTL split.** `result.modelUsage` slices carry no TTL split. Only
  the aggregate `result.usage` does. The pricer applies the record-level 1h share
  (`cacheWrite1hTokens / Σ slice cacheWrite`, clamped to [0, 1]) to each slice's writes, unless a
  slice carries its own `cacheWrite1h`. This apportionment is an estimate. It only affects
  computed costs (`--cost-mode calculate`, `ach audit`), because `auto` prefers each slice's
  CLI-reported `costUsd`.
- **Old runs under `ach audit`.** Driver transcripts written before #105 kept no split in their raw
  usage payload, so audit reprices them with every write at 5m, the same rule their recorded cost
  used. Both sit below the CLI-reported cost. A `claude-opus-5-5` run recorded before #105 still
  shows cost drift, because audit reprices it with the corrected rates (any pricing-table change
  surfaces that way).
- External LiteLLM-style cost maps are accepted via `createPricer(costMapPath)`, in per-1M fields
  or per-token fields (auto-scaled ×1e6); `resolveAlias` strips provider prefixes, date stamps,
  and `-latest/-preview` so `anthropic/claude-sonnet-4-20250514` matches `claude-sonnet-4`.
- Unknown model → `NaN` + warning surfaced in `RunResult.warnings` — cost is never silently 0
  (exception: credit-metered kiro records, below).
- **Reported beats computed (by default):** the transcript tap prefers `costUSD` when the row
  carries it; the driver accumulates computed cost otherwise. `ach stats` makes this a choice
  (below) instead of a silent blend.
- The CLI transcript tap prices unpriced rows through this same `Pricer` (`cli/ach.ts`) — the
  old `cli/lib.ts estimateCostUsd` prefix table is gone (that merge is closed).

### `ach stats --cost-mode` and cost provenance

Why the modes exist: a CLI-reported cost and our token × bundled-price math disagree in
practice. The bundled LiteLLM extract drifts from the vendor's live price list, cache tiers and
TTLs are billed differently from how they are logged, and enterprise or negotiated rates never
appear in any public table. Blending the two into one number hides which one is wrong. So
`ach stats --cost-mode <mode>` (env `AGENTIC_CODING_HARNESS_COST_MODE`; the flag wins; a bad
name errors with the valid list) lets you pick:

| mode | per-record cost | use it when |
|---|---|---|
| `auto` (default) | CLI-reported when present, else computed | historical behavior; best single number |
| `calculate` | always tokens × bundled price, even when a reported number exists; multi-model slices are priced from their own tokens, never from their reported `costUsd` | one consistent methodology across agents |
| `display` | CLI-reported verbatim; `null` when absent, never computed | reconciling with a vendor dashboard or invoice |

Every JSON bucket (`total`, `byAgent.*`, `byDay.*`) carries `costSource`: `"reported"` or
`"computed"` when all of its cost-bearing records share that source, `null` when none carried a
cost or when both contributed, plus `costBySource: {reported, computed}` (USD, `null` for a
source nothing used). In `display`/`calculate`, a bucket with no cost of the accepted source has
`costUsd: null`; `auto` keeps `0` for a bucket with no priceable record. Every bucket also carries
`unpricedRecords` (0.11.1): how many of its records got no cost under the active mode (in `auto`,
an unknown model with nothing reported). They count in `records` and the token sums but not in
`costUsd`, which is then a lower bound; text rows append `unpriced=N`, and `ach status` reports the
same count as `today.unpricedRecords`. One deliberate change
from pre-0.11.0 `auto`: a harness-state line that carried NO `costUsd` used to contribute `$0`
(the store defaulted it); it is now priced from its tokens like any other unreported record, and
labelled `computed`. Machine
transcripts (`scanAll`) carry no reported cost, so they are computed-only; harness-state records
are reported when their line carried `costUsd`.

**Disagreements:** whenever a record has both values and they differ by more than 1%
(`|reported − computed| / max(|reported|, |computed|)`), stats prints a `[warn] cost
disagreement:` line on stderr with both values and the delta (first 10, then a count), adds a
`disagree` row to the table, and reports the count as `total.costDisagreements`, in every mode.

Driver runs: `RunRecord.totals.costSource` is `"computed"` when `cumulativeCost` came only from
token math, `"reported"` when it came only from CLI-reported multi-model slice costs, and absent
when both (or neither) fed it. The number itself is unchanged.

Every bucket and every RunRecord also carries a sibling `provenance` map
(`reported | computed | estimated` per field). There, a blended cost is labelled `computed`, and
the dash, web UI, stats table and report mark computed numbers with `*` and estimated ones with
`≈`. See [PROVENANCE.md](PROVENANCE.md) for the per-number table.

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

---

## 5. Context-window pressure for every agent (#21)

Kiro's occupancy comes from its session store (§1). For **claude, codex,
gemini and opencode** the driver runs a context meter
(`createContextMeter`, `src/core/context-meter.ts`) over the event stream and
fills `usage.context` when the kiro path left it unavailable.

**Occupancy** = `inputTokens + cacheReadTokens + cacheWriteTokens` of the
latest usage record (canonical `inputTokens` is uncached-only, so this is the
full prompt the model saw). **Window** = `max_input_tokens` for the model in
the bundled LiteLLM extract (`src/core/pricing-data.json`, extract of
2026-09-10; alias-resolved with the pricer's `resolveAlias`). An explicit
window tag on the model id (`claude-sonnet-4-5[1m]`) wins over the table.
Model resolution order: the usage record's model → a model named by a
step/message event → the RunSpec `model`.

| Field | Meaning |
|---|---|
| `estimated: true` | Computed by the meter (usage ÷ bundled table), not reported by the provider. |
| `windowSource: 'assumed'` | Window from the bundled table. |
| `basis: 'last-call'` | Latest single model call: claude assistant-message usage, opencode step-finish. A real occupancy reading. |
| `basis: 'turn-total'` | A usage record summed over a turn's model calls: codex `turn.completed`, gemini `result.stats`, a claude `result` with no per-message usage. An **upper bound** (exact only for a one-call turn); rendered `≤` / `<=`. |
| `toolOutputTokens` / `toolOutputShare` | Estimated (chars ÷ 4) size of every tool result seen in the stream, and its share of `tokens` (capped at 1). **Omitted, not 0**, when the run had no tool events. |

- **Unknown model → `available: false`** (dash/report render `n/a`); the
  meter never guesses a window. Codex's stream names no model, so a codex run
  without `--model` is `n/a`; the same holds for gemini (its `init` model is
  not bridged today).
- **Overflow warning:** a `budget.alert` event at 85% with metric `context`,
  persisted in `RunRecord.alerts` for dash/web. It uses the shared cooldown
  state in `alerts.json` (see [Budget alerts](BUDGET-ALERTS.md)). It fires only
  on a known `last-call` basis; an upper bound is not evidence of pressure.
- **`ach stats --json`** gains an additive `runs` array, one row per registry
  run (`<stateDir>/runs`), filtered by `--agent` / `--days`:

  ```ts
  {
    runId, agent, startedAt, status: string | null, model: string | null,
    contextPercentage: number | null,   // null = unknowable, never 0
    contextTokens: number | null, windowTokens: number | null,
    windowSource: 'session-store' | 'assumed' | null,
    basis: 'last-call' | 'turn-total' | null,
    estimated: boolean,
    toolOutputShare?: number            // omitted when no tool events
  }
  ```
- **Claude `<synthetic>` messages** (text the CLI writes itself, e.g. "Credit
  balance is too low", with all-zero usage) are not model calls: the meter
  skips their usage and never adopts `<synthetic>` as the model.
- **Per-frame readings in `ach web`:** the server runs one meter per run
  socket over the transcript in order and stamps each event it sends with an
  additive `ctx` field (`src/web/context-frames.ts`): `tokens`, `basis`,
  `fresh` (this event fed the reading; tool rows carry it forward with
  `fresh:false`), `seq` (ordinal of the distinct reading), `delta` of that
  reading against the previous distinct one (on every frame of the reading;
  the feed draws `+Δ` once per `seq`, on the first drawn row), the
  `input`/`cacheRead`/`cacheWrite` breakdown on fresh frames, and
  `window`/`pct`/`warnAt` when the window is known. No meter (kiro, custom
  agents), no usage yet, or the #59 `ach.seal` record → no field. The feed
  only renders it. Compaction is not marked: no adapter bridges a compaction
  event (claude's `system` lines other than `init` are dropped in
  `adapters/claude.ts`), and the feed does not guess one from a drop.

---

## 6. `ach stats` dimensions: model, project, cache-hit ratio (#27, #43, #69)

Implemented in `src/cli/stats-dims.ts` (`aggregateDims`) and
`src/core/cache-ratio.ts` (`cacheHitRatio`); the base `aggregate()` in
`src/cli/lib.ts` and its `total`/`byAgent`/`byDay` shapes are unchanged.

**Cache-hit ratio.** `cacheRead / (input + cacheRead + cacheWrite)` on
canonical records, where `input` is uncached-only for every provider (§2). A
cache write is prompt the provider processed uncached, so it counts as a miss.
For OpenAI/Gemini `cacheWrite` is 0 and the ratio equals the provider's own
`cached / prompt`. No prompt tokens → `null` (`n/a`), never `NaN`; a provider
without caching reports a real `0%`. Shown as `cacheHit=` on every `ach stats`
line, as `cacheHitRatio` in `--json` (top-level `{total, byAgent, byDay}` plus
a field on every `byModel`/`byProject` row), in the dashboard run header, and
in `/trio` metrics (run card plus one card per model from
`/api/runs/:runId/observability` `byModel`).

**`byModel` (always in `--json`; printed with `--by model`).** Keys are
runtime-scoped `agent/model`, so `claude/gpt-5` and `opencode/gpt-5` stay two
rows. A record carrying per-model slices (`extra.raw.models`, the claude
`result.modelUsage` split) contributes one row per slice: the CLI-reported
slice `costUsd` when present, else the slice priced at its own model's rates.
Rows therefore sum to the run's token and cost totals. A record without
slices belongs to its `model` when that names one model; an absent,
`multi`, `unknown`, or joined (`a+b`, the `usage_raw` lane) label goes to the
explicit `agent/unattributed` row, never to a guessed dominant model.
An unpriceable model keeps its tokens, gets `costUsd: null`, and is listed in
`unpricedModels` plus a stderr warning; its cost is excluded from `total`.
`--by model` adds `byModelDay` (`{day: {key: row}}`) and the model × day
table; compose with `--days N`. `--merge-models` (with
`--model-alias FROM=TO`, repeatable) is the only way scoped rows combine into
bare model rows; `--json` then echoes `mergedModels: true` and
`modelAliases`.

**`byProject` (`--by project` or `--project NAME`).** The key is the
repository root of the run's `cwd`: the outermost enclosing directory holding
`.git` (so a nested worktree groups with its repo), never the home directory
or `/`; a non-git or vanished directory keys on the cwd itself; no cwd →
`unknown`. The cwd comes from the run registry (`runs/*.json`, joined by
agent + session id) for harness-state records, and from the transcript itself
for machine records (claude line `cwd`, codex `session_meta.cwd`). Aliases
rename a root (or any directory containing it) to a friendly name; sources
layer env `AGENTIC_CODING_HARNESS_PROJECT_ALIASES` (JSON object) →
`--project-aliases FILE.json` → `--project-alias PATH=NAME` (later wins, `~`
expands). `--project NAME` filters by alias name or root path before
aggregating and composes with `--agent`/`--days`.
