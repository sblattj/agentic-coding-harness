# Exit statuses and exit codes

Two related contracts:

1. **`exitStatus`**: the verdict recorded on every `RunResult`, in `result.json` / `status.json`
   (run-to-directory mode) and on the run-registry record (`<stateDir>/runs/<runId>.json`).
2. **Process exit codes**: what `ach` returns to the shell. The default is still 0/1. The
   `--exit-codes ladder` flag opts into a richer ladder that cron jobs and CI gates can act on
   without parsing JSON.

Implementation: `ExitStatus` in `src/core/types.ts`, `classifyUnavailable` /
`classifyLaunchError` in `src/core/availability.ts`, and `runExitCode` / `noDataExitCode` in
`src/cli/exit-codes.ts`.

## `exitStatus` values

| exitStatus | When it applies | status.json `status` | registry `status` | Counts toward success rate? |
|---|---|---|---|---|
| `success` | The adapter reported a clean exit and the driver did not stop the run. | `success` | `success` | yes (as a success) |
| `error` | The agent ran and failed: it produced at least one activity event (message, tool call/result, usage, step) and then exited non-zero, or the event stream threw. | `error` | `error` | yes (as a failure) |
| `timeout` | `budget.wallMs` / `budget.idleMs` (or `timeoutMs` / `idleTimeoutMs`) tripped, or the adapter reported its own timeout. | `timeout` / `idle-timeout` | `aborted` | yes (as a failure) |
| `aborted` | The run was aborted, for example with `driver.abort(runId)` or a signal. | `aborted` | `aborted` | yes (as a failure) |
| `cancelled` | The adapter reported a cancellation. | `aborted` | `aborted` | yes (as a failure) |
| `budget_exceeded` | Cumulative priced cost passed `budget.usd` (checked on each usage event). | `aborted` | `aborted` | yes (as a failure) |
| `turn_limit` | The step count passed `budget.maxTurns` (the driver enforces this only for adapters that don't enforce it themselves). | `aborted` | `aborted` | yes (as a failure) |
| `unavailable` | The agent CLI or its service was not there, so the run says **nothing about the task**. See below. | `unavailable` | `unavailable` | **no**: excluded by default |

### When a run is `unavailable`

The classification is deliberately narrow. It only looks at signals that the harness or adapter
produced itself. It never looks at tool output or the agent's own messages, so a task that curls
a dead endpoint still records `error`.

- **Missing or non-executable binary.** The adapter's own `failed to spawn <cmd>: … ENOENT`
  error event (also `EACCES` / `ENOEXEC`). It also covers an `adapter.launch()` that throws the
  same errno before a handle exists, as on the kiro ACP and opencode server transports. In the
  launch case, `driver.run()` rejects with `HarnessError` code `UNAVAILABLE`, and `status.json`
  still settles as `unavailable`. A spawn `cwd` that does not exist gives the same Node error
  text, so it is treated as a caller error (`error`), not as `unavailable`.
- **Crash before the first event.** The adapter exited `error` without a single agent-activity
  event (`message`, `tool_call`, `tool_result`, `usage`, `usage_raw`, `step`). A `session`
  announcement and stderr `progress` lines don't count as activity. This is the common shape of
  an unauthenticated CLI or a vendor outage: a banner on stderr, then a non-zero exit before the
  model produced anything.
  *Caveat:* this rule also catches a CLI that rejects its own arguments before it starts (for
  example an unknown `--model`). That run produced no verdict about the task either, so "no
  data" is the honest bucket for it.

Only an adapter `error` is ever reclassified. Driver verdicts (`budget_exceeded`, `turn_limit`,
`timeout`) and `success` / `aborted` / `cancelled` keep their meaning. A reclassified run also
carries a `warnings` line that starts with `unavailable: ` and gives the reason.

Downstream consumers should read `unavailable` as **no data**, not as a failure:

- `ach stats` adds a `runs` rollup (text lines `runs <agent> runs=… success=… unavailable=…
  successRate=…`, and a `runs` key in `--json`) whenever the run registry has records. The
  success rate leaves `unavailable` runs out of the denominator. `--include-unavailable` puts
  them back in. A rate whose denominator is empty prints `n/a`, never `0%`.
- `ach report` shows an **availability** table: runs, unavailable runs, and the success rate
  excluding unavailable runs, per adapter.
- `/api/compare` (`ach web`) leaves `unavailable` out of `successRate` and adds an `unavailable`
  count to a row only when that count is greater than 0. An all-unavailable group has
  `successRate: null`.

## Process exit codes

### Default (`--exit-codes binary`, or no flag)

Unchanged from earlier releases: `ach run` exits **0** when `exitStatus` is `success` and
**1** otherwise, including `unavailable`. Every other command exits 0 on success and 1 on any
error.

### The ladder (`--exit-codes ladder`)

Accepted by `run`, `stats` and `watch`. The same helpers (`noDataExitCode`) are exported for any
future reporting command.

| Code | Name | Trigger condition |
|---:|---|---|
| **0** | ok | `run`: `exitStatus` is `success` and no measured budget dimension reached 80%. `stats`: there was at least one usage record or run record to report. |
| **10** | near-limit | `run`: `exitStatus` is `success`, and at least one **configured and measurable** budget dimension reached **≥ 80%** (`NEAR_LIMIT_FRACTION`): `totalCost / budget.usd`, turns (step events counted like the driver counts them) `/ budget.maxTurns`, or `durationMs / budget.wallMs`. The USD ratio is skipped when the run says USD is unavailable (kiro: credits only), so it is never estimated. |
| **11** | limit hit | `run`: `exitStatus` is `budget_exceeded` or `turn_limit`. |
| **20** | indeterminate | `run`: `exitStatus` is `unavailable` (see above), or the launch itself failed with `UNAVAILABLE`. |
| **30** | no data | `stats`: zero usage records **and** zero run records after the `--agent` / `--days` / `--state-only` filters. |
| **1** | error | `run`: `exitStatus` is `error`, `timeout`, `aborted` or `cancelled`. Every command: bad arguments, an unknown agent, an unknown `--exit-codes` value, any other harness error. |

`watch` accepts the flag so scripts can pass it uniformly. It runs until SIGINT/SIGTERM and exits
0; it never reaches a verdict, so the ladder has nothing to add there.

### CI recipe: budget-gated cron

```sh
#!/bin/sh
# Nightly agent run: alert when near budget, page when the budget is hit,
# retry later when the vendor was down.
ach run --agent claude --budget-usd 2 --max-turns 40 --exit-codes ladder --json \
  "run the nightly maintenance task" > result.json
case $? in
  0)  ;;                                     # ok
  10) notify-slack "nightly run used >=80% of its budget" ;;
  11) page-oncall "nightly run hit its budget/turn limit" ;;
  20) echo "agent CLI/service unavailable; retrying next tick" ;;
  *)  page-oncall "nightly run failed (see result.json)" ;;
esac

# Usage report that only posts when there is something to post:
ach stats --days 1 --json --exit-codes ladder > usage.json
[ $? -eq 30 ] && exit 0                      # nothing ran today
```
