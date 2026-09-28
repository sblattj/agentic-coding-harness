# Usage windows: 5h blocks, pace, plan presets

`ach stats` and `ach dash` can frame usage the way a subscription is actually
metered. The math lives in `src/core/usage-windows.ts` (blocks and pace) and
`src/core/plans.ts` (presets). The stats wiring is in `src/cli/usage-render.ts`
and the dash pace row is in `src/cli/dash.ts` (`PaceTracker`).

## Claude 5-hour billing blocks: `ach stats --blocks`

Claude subscription plans meter usage in rolling 5-hour windows. ach follows
ccusage's block semantics:

- A block starts at its first event's timestamp, **floored to the UTC hour**,
  and it spans exactly 5 hours (`end = start + 5h`).
- The first event at or after `end` opens a new block, so an event at exactly
  `start + 5h` belongs to the next block. A gap longer than 5 hours always
  opens a new block, because it necessarily crosses the previous block's end.
- A block is **active** while `start <= now < end`.
- Only `claude` records are grouped. Other vendors do not bill this way. When
  the scope has no claude records, the command prints an explanatory note and
  exits 0. The JSON then carries `blocks: []` and a `blocksNote` field.
- Records without a timestamp cannot be placed in any block, so they are skipped.
- `--days N` and `--agent` limit the records first, so blocks compose with them.

Projection for the active block:

```
elapsed          = now - firstEventAt
usdPerHour       = costUsd / elapsed_hours
projectedCostUsd = costUsd + usdPerHour * (end - now)_hours
tokensPerMinute  = tokens / elapsed_minutes
projectedTokens  = tokens + tokensPerMinute * (end - now)_minutes
```

`usdPerHour` and `projectedCostUsd` are `null` when no record in the block has
a price. They are never reported as 0.

### Seam for status and statusline

```ts
import { currentBlock } from "./src/core/usage-windows.ts";
const block = currentBlock(records, Date.now()); // UsageBlock | null
```

`records` is any iterable of `{ ts, agent, inputTokens, outputTokens,
cacheReadTokens, cacheWriteTokens, costUsd? }`. This shape is structurally the
same as `AggregatableRecord` in `src/cli/lib.ts`, which is what `cmdStats`
builds.

## Pace: always present in `ach stats`

The stats JSON gains a `pace` object. The field is **additive**: `total`,
`byAgent` and `byDay` are unchanged.

```jsonc
"pace": {
  "asOf": "2026-09-27T12:00:00.000Z",
  "budgetUsd": 5,            // --budget-usd or AGENTIC_CODING_HARNESS_BUDGET_USD; null when unset
  "spentUsd": 2.5,           // cost of the records in the stats scope (--days/--agent); null when there is no budget
  "budget": "ok",            // "ok" | "exhausted" | null (no budget)
  "windows": {
    "15m": { "windowMs": 900000,  "effectiveMs": 900000,  "records": 2,
             "usdPerHour": 2, "tokensPerMinute": 73.3, "etaBudgetHit": "2026-09-27T13:15:00.000Z" },
    "1h":  { "windowMs": 3600000, "effectiveMs": 3600000, "records": 2,
             "usdPerHour": 1, "tokensPerMinute": 36.7, "etaBudgetHit": "2026-09-27T14:30:00.000Z" }
  }
}
```

- A window counts the events whose timestamp falls in `(now - W, now]`.
  Tokens are input + output + cacheRead + cacheWrite.
- **An empty window yields `null` rates, never `0`**, because a zero would
  imply that something was measured.
- `etaBudgetHit = now + (budget - spent) / usdPerHour`. It is `null` when no
  budget is set, when the rate is null or 0, or when the budget is exhausted.
- Once `spent >= budget`, `budget` becomes `"exhausted"` and every ETA is
  `null`. The ETA is never a negative number.

## Pace row in `ach dash`

Each live run gets a `pace` row showing `$/h` and `tok/min` over the 15m and
1h windows, plus a budget ETA when `--budget-usd` or the env default is set.
The rate comes from cumulative samples taken at each redraw, seeded with the
run's `{startedAt, $0}`. Values are linearly interpolated at the window start,
so right after dash opens the rate equals the average since the run started.
The row appears only while `isLive(rec)` is true. When the run ends, the row
disappears instead of freezing at its last value. A run whose usage lane is
unavailable shows `n/a`.

## Plan presets: `--plan pro|max5|max20|custom`

| preset | window tokens (in+out) | window $ | window msgs |
|---|---|---|---|
| pro   | 19,000  | $18  | 250   |
| max5  | 88,000  | $35  | 1,000 |
| max20 | 220,000 | $140 | 2,000 |

- **These numbers are community estimates, not Anthropic figures.** Anthropic
  does not publish per-window allowances. The table is copied from
  Claude-Code-Usage-Monitor `src/claude_monitor/core/plans.py` `PLAN_LIMITS`
  at commit `3357236`, which labels them `confidence="local_estimate"`. Every
  row carries `source`, `asOf` and `estimate: true`, and the text output says
  "estimate". A pinned test makes every change to the table a deliberate diff.
- Token usage is counted as **input + output**, with cache tokens excluded.
  This is ach's stated basis. Upstream does not document which token basis its
  limit uses.
- `--plan custom` requires both `--plan-window-tokens N` and
  `--plan-window-usd N`. `--plan-window-messages N` is optional. If a required
  value is missing, the command fails with a usage error that names it.
- An unknown preset name fails loudly and lists the valid presets.
- Env defaults: `AGENTIC_CODING_HARNESS_PLAN`, `..._PLAN_WINDOW_TOKENS`,
  `..._PLAN_WINDOW_USD` and `..._PLAN_WINDOW_MESSAGES`. The CLI flag wins over
  the env.
- The text output adds a `% of plan window used` line under the `claude` row,
  covering the active block. It reads `n/a` when no window is open. With
  `--blocks`, every block row also shows its plan percentage. The JSON gains a
  `plan` object: the preset plus a `current` field, which is `null` when no
  window is active.
- A monthly allowance is **not** modeled, because no source gives an
  authoritative monthly quota.
