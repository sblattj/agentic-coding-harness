# `ach status` and `ach statusline`

Both commands read one **current usage snapshot** (`src/cli/status.ts`, `computeStatusSnapshot`). They exist for status bars, shell prompts, cron jobs, and companion apps that poll: they are cheap, one-shot, and never make a network call.

- `ach status`: a short human-readable block.
- `ach status --compact`: exactly one `key=value` line.
- `ach status --json`: one JSON object (the schema below).
- `ach status --write-state <path>`: writes that same JSON object to a file atomically (the companion protocol).
- `ach statusline`: a Claude Code `statusLine.command`.

Every form exits 0 when there is no data, including when the state dir does not exist yet. Polling a status bar should never break it. The exception is opt-in: `ach status --exit-codes ladder` exits **30** when the snapshot has zero runs and zero usage records (one-shot and `--write-state --once`; the snapshot is still printed or written), the same no-data rule as `ach stats`. See [EXIT-CODES.md](EXIT-CODES.md).

## What the numbers mean

| Number | Source | Notes |
|---|---|---|
| runs / running / success / error | run registry `<stateDir>/runs/*.json` | Counts runs started in the trailing 24 h. A run that is still live counts no matter how old it is. `running` is the **effective** status, so a dead pid or a stale heartbeat reads `interrupted`, the same as `ach dash`. |
| `cost_today` / `today.costUsd` | the records `ach stats --days 1` aggregates | Covers the **trailing 24 h** (`now - 86 400 000 ms`), not the calendar day. By default only the state dir (`<stateDir>/raw`) is read, so it equals `ach stats --days 1 --state-only`. With `--transcripts` it also scans the machine Claude/Codex/Gemini transcript dirs and equals `ach stats --days 1`. A test pins both equalities. Registry `totals` are **not** added in: the driver writes the same usage to `raw/`, so adding them would count it twice. |
| block cost | the open Claude 5-hour block over the same records as "today" (`currentBlockCost`, built on `currentBlock` from `src/core/usage-windows.ts`) | `ach status` and `ach statusline` pass it through the `BlockCostProvider` seam. Shows `null` / `n/a` when no block is open or none of its records is priced. Blocks are chained from the trailing-24h records only. A library caller of `computeStatusSnapshot` that passes no `blockCost` gets `null`. |
| budget | `--budget-usd N`, else `AGENTIC_CODING_HARNESS_BUDGET_USD` | `status` reads this value as a **trailing-24 h spend ceiling**, while `ach run` reads the same env var as a per-run cap. `remaining = budget - cost_today`, and it can go negative. State is `ok` below 80 % used (`BUDGET_NEAR_FRACTION = 0.8`), `near` from 80 % up to 100 %, and `exceeded` at 100 % or more. When no budget is set, the budget is omitted (`budget_left` absent, `budget.configured: false`) rather than shown as 0. An unparseable env value prints a `[warn]` and is ignored. |

## `ach status --compact` grammar

```
runs=<int> running=<int> success=<int> error=<int> cost_today=$<d>.<dddd>[ budget_left=$<-?d>.<dddd>]
```

The key order is fixed. `budget_left` appears only when a budget is configured. With no data at all the line is:

```
runs=0 running=0 success=0 error=0 cost_today=$0.0000
```

## Snapshot schema (`--json`, `--write-state`), `schemaVersion: 1`

This is the zod schema `StatusSnapshotSchema` in `src/cli/status.ts`. Top-level keys always appear in this order.

| Field | Type | Meaning |
|---|---|---|
| `schemaVersion` | `1` (literal) | Bumped only for a breaking change. |
| `generatedAt` | ISO-8601 string | When the snapshot was computed. |
| `window` | `{ kind: "trailing-24h", since: ISO, until: ISO }` | The spend and run window. |
| `sources` | `("state" \| "transcripts")[]` | `["state"]`, or `["state","transcripts"]` with `--transcripts`. |
| `runs` | `{ total, running, success, error, aborted, interrupted, unavailable }` (ints) | Registry counts, as described above. `unavailable` (#60) counts runs the vendor could not serve (see docs/EXIT-CODES.md). |
| `activeByAgent` | `Record<agent, int>` | Live runs per agent. Agents with no live run are omitted. |
| `newestRun` | `{ runId, agent, status, startedAt: ISO, durationMs: number \| null } \| null` | The newest counted run and its wall-clock duration (to now while running). `null` when the end time is unknown. |
| `today` | `{ costUsd: number, records: int, byAgent: Record<agent, { costUsd, records }> }` | Per-adapter spend in the window, rounded to 1e-6 USD. |
| `block` | `{ costUsd: number \| null, source: "unavailable" \| "provider" }` | 5-hour block cost of the open Claude block; `null` when no block is open, it is unpriced, or no provider was passed. |
| `budget` | `{ configured: false }` or `{ configured: true, usd, remainingUsd, usedFraction, state: "ok"\|"near"\|"exceeded", nearFraction }` | The budget level and its state. |

**Stability promise.** Within `schemaVersion: 1`, fields are never renamed, removed, or retyped. New fields may be **added**, both new top-level keys (appended after `budget`) and new keys inside objects, so readers must ignore keys they don't know. New enum members (for example a new `sources` entry or a new `block.source`) are also additive. Any rename, removal, or retype bumps `schemaVersion`.

## Companion protocol: `--write-state`

```sh
ach status --once --write-state ~/.agentic-coding-harness/latest.json   # one shot, exit 0
ach status --write-state /tmp/ach-state.json                             # refresh every 5 s until killed
ach status --write-state /tmp/ach-state.json --interval-ms 1000          # custom cadence
```

- **Atomic:** each write goes to `<path>.tmp-<pid>` and is then `rename`d over `<path>`. A reader therefore sees either the old document or the new one, never a partial one. A test polls the file while a writer loops every 5 ms and asserts that every read parses. Parent dirs are created as needed.
- stdout stays empty unless `--json` or `--compact` is also passed.
- Without `--once`, the command refreshes on the `ach watch` cadence (5 s) until SIGINT/SIGTERM.

This file is the one integration point for external companions: menu-bar apps, statusline chains, and cron alerters.

## `ach statusline` for Claude Code

Add it to `~/.claude/settings.json`:

```json
{
  "statusLine": {
    "type": "command",
    "command": "ach statusline"
  }
}
```

Output (one line):

```
Opus · session $0.0123 · today $0.7500 · block n/a · budget $9.2500 left
```

Budget markers: `[NEAR LIMIT]` from 80 % used, `[OVER BUDGET]` at 100 %. The budget segment appears only when a budget is set. To set one for the statusline, export `AGENTIC_CODING_HARNESS_BUDGET_USD` in the environment Claude Code runs in.

### Keep your existing statusline (`--chain`)

`--chain` runs your current statusline command first and appends ach's segment after it. The command gets **the same stdin JSON**, so it keeps working unchanged:

```json
{
  "statusLine": {
    "type": "command",
    "command": "ach statusline --chain '~/.claude/statusline.sh'"
  }
}
```

```
main ✓ my-repo | Opus · session $0.0123 · today $0.7500 · block n/a
```

- `--separator " | "` sets the text between the two parts. If your command prints several lines, ach's segment goes at the end of the last one.
- The chained command can fail: a non-zero exit, a missing binary, or a run longer than `--chain-timeout-ms` (default 1500). ach then prints only its own segment, writes one `ach statusline: chained statusline failed (…)` line to stderr, and still exits 0.

### Fields read from stdin

Claude Code's payload is documented at <https://code.claude.com/docs/en/statusline>, and a captured copy is in `tests/fixtures/claude-statusline/status-input.json`. ach reads `session_id`, `model.display_name` (falling back to `model.id`), `cost.total_cost_usd` (Claude Code's client-side session estimate), and `workspace.current_dir` (falling back to `cwd`). A missing field renders as `n/a`. Empty or malformed stdin produces a minimal line such as `n/a · session n/a · today $0.0000 · block n/a` and exit 0.

The payload's `rate_limits.five_hour.used_percentage` is a rate-limit percentage, not a dollar cost, so ach does **not** use it as the block cost.

### Refresh budget and cache

Claude Code debounces statusline refreshes at 300 ms and cancels a script that is still running when the next refresh fires. To keep refreshes inside that window, `ach statusline` caches the snapshot in `<stateDir>/status-snapshot.json`, which uses the same schema as `--write-state`. It reuses the cache while it is younger than `--max-age-ms` (default 30 000); otherwise it recomputes and rewrites the file atomically. On a warm cache a render reads one small file and never touches the network; a test holds it under 300 ms in-process.

The budget is re-derived on every refresh from the current env against the cached spend. `--cache <path>` moves the cache (for example to the file an `ach status --write-state` companion is already maintaining), and `--no-cache` always recomputes.

`--transcripts` adds the machine transcript dirs to `today`. Interactive Claude Code sessions that were not run through `ach run` or `ach watch` only show up this way. On a large `~/.claude/projects` the scan is slow, so pair it with the cache.

Process start-up is the part the cache can't hide. Run the built bin (`ach` from npm, or `node dist/cli/ach.js`) rather than `tsx src/cli/ach.ts`, because tsx's on-the-fly compile alone can take longer than the debounce. As a reference point, the bundled node bin rendered a full `ach statusline` in about 70 ms wall-clock (cold and warm) on an Apple Silicon laptop with a small state dir.
