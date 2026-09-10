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
  uncached), `costUSD` preferred, else `estimateCostUsd` from the prefix price table.
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

**→ canonical (two code paths, ⚠ they disagree):**
- `normalizeCodex` (raw-payload path): `inputTokens = max(0, input_tokens − cached_input_tokens)`,
  `cacheReadTokens = cached_input_tokens` — uncached-input convention applied.
- `adapters/codex.ts` (stream path): emits `inputTokens = input_tokens` **unadjusted** with
  `cacheReadTokens = cached_input_tokens` — cache stays double-billed inside input until the two
  paths merge. Flagged as a live instance of Trap 3; do not trust cross-tap input comparisons
  for codex until then.

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

### Kiro (MITM tap `[planned]` for collection, parser ready)

| Native field | Where | Meaning |
|---|---|---|
| `tokenUsage.{inputTokens,outputTokens,cacheReadTokens?,cacheWriteTokens?}` | observed API responses | per-request usage |
| `meteringEvent` | observed events | credits consumed |

**→ canonical:** `normalizeKiro` maps `tokenUsage` fields as-is (Kiro's taxonomy already treats
input as uncached); `meteringEvent` credits × published credit price is the authoritative cost
figure once the MITM lands.

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
subtract for codex overcounts fresh input. ⚠ Live instance: `adapters/codex.ts` currently emits
unadjusted input while `normalizeCodex` subtracts (§1). Also never compare raw `input` across
providers without normalizing first.

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
- Unknown model → `NaN` + warning surfaced in `RunResult.warnings` — cost is never silently 0.
- **Reported beats computed:** the transcript tap prefers `costUSD` when the row carries it;
  the driver accumulates computed cost otherwise. Provider-reported figures always win.
- The CLI transcript fallback (`cli/lib.ts estimateCostUsd`) uses a simpler model-prefix table —
  ⚠ a second, diverging price source; consolidate on `Pricer` at merge.
