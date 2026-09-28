# Budget alerts and near-limit warnings

`ach run` can tell you that a run is getting close to a limit **without
stopping it** (issue #20). There are two kinds of threshold, and one crossing
engine handles both (`src/core/budget-alerts.ts`):

| Family | Fraction of | Flag | Env | CLI default |
|---|---|---|---|---|
| budget alert | `--budget-usd` | `--budget-alerts 0.5,0.8,1.0` | `AGENTIC_CODING_HARNESS_BUDGET_ALERTS` | `0.5,0.8,1.0` when `--budget-usd` is set |
| near-limit warning | `--max-turns` and `--wall-ms` | `--warn-at 0.5,0.8,0.95` | `AGENTIC_CODING_HARNESS_WARN_THRESHOLDS` | `0.5,0.8,0.95` when either cap is set |

- Thresholds are **fractions in (0, 1]**. A percent-style value such as `85`
  is rejected: `--warn-at: threshold '85' is not a fraction in (0, 1] (write 0.85 for 85%)`.
- `off` or `none` disables a family.
- CLI flags win over env.
- In the library, alerts are opt-in. Set `RunSpec.budget.alerts` and/or
  `RunSpec.budget.warnAt`; the driver applies no default.

## What a crossing does

Each crossing emits one `budget.alert` event on the run's normal event stream:

```json
{"type":"budget.alert","timestamp":1790000000000,"runId":"…","family":"budget",
 "metric":"usd","threshold":0.8,"value":0.9,"limit":1,"data":"usd 80% ($0.9000 of $1.0000)"}
```

The same event reaches every consumer:

- `RunResult.events` and the raw transcript `<stateDir>/raw/<agent>-<session>.jsonl`
  (which is what MCP `harness_run_events` pages);
- `events.jsonl` in run-to-directory mode (`outputDir`);
- the `onEvent` tap, which `ach run` prints to stderr as
  `[hh:mm:ss] budget.alert usd 80% ($0.9000 of $1.0000)`;
- `RunRecord.alerts`, which shows as an `ALERT` banner row in `ach dash`, as
  an `alert` field in the `ach web` metadata strip, and in `ach dash --json`.

**Alerts never abort.** Enforcement is separate:

- `--on-budget abort` explicitly opts into enforcement. Going
  over `--budget-usd` aborts the run with `budget_exceeded`. The 100% alert is
  emitted before the abort, so it is still on the stream.
- `--on-budget warn` is the default (`RunSpec.budget.onExceed: "warn"`) and lets the run
  continue past the cap. The run gets one warning:
  `budget: usd cap $X exceeded ($Y); continuing (onExceed: warn)`.
- Claude final-result accounting never aborts the completed work, even with
  `--on-budget abort`. An over-cap final bill emits a final-accounting warning;
  the process exit determines success or error.
- `--max-turns` and `--wall-ms` still enforce as before. Near-limit warnings
  only fire *before* those caps trip.

## Edge-triggered and cooldown-gated

A threshold `t` fires when the observed fraction **crosses** it (previous
value `< t`, current value `>= t`). Staying above `t` does not fire it again,
and neither do 100 dashboard refreshes. After a threshold fires, it cannot
fire again for the same source until the cooldown has passed. Dropping below
`t` and crossing it again inside the cooldown stays quiet.

- Default cooldown: 24 h. Override it with `AGENTIC_CODING_HARNESS_WARN_COOLDOWN_H`
  (hours; fractional values are allowed, `0` disables the cooldown).
- Library: `RunSpec.budget.alertCooldownMs`.
- For `ach run`, the source is the run id (`run:<runId>:<metric>`). Within one
  run, cost and turns only increase, so each threshold fires at most once. The
  persisted cooldown covers a later process that reuses the run id, for
  example a retried MCP async job.
- Wall-clock warnings are evaluated when an event arrives, so a completely
  silent run reports its wall warning at the next event. The idle cap covers
  runs that go silent.

## State file

The last fire time for each `(source, threshold)` pair is stored in:

```
<stateDir>/alerts.json        # default ~/.agentic-coding-harness/alerts.json
                              # (AGENTIC_CODING_HARNESS_STATE_DIR overrides the root)
```

- **Reset:** deleting `alerts.json` re-arms every warning. The next crossing
  fires again.
- **Corrupt or unreadable file:** the run gets the warning
  `alerts: state file … unreadable (…); starting fresh` and continues with an
  empty state. The exit status is unaffected, and the file is rewritten on the
  next crossing.
- The file is written atomically (tmp + rename). A failed write becomes a run
  warning and never stops the run.

## Per-lane notes

| Lane | usd alerts | turns warnings | wall warnings |
|---|---|---|---|
| claude, codex, gemini, opencode | yes (where the model is priced) | yes | yes |
| kiro | **n/a**: kiro bills in credits and nothing maps credits to USD, so the harness cost stays 0 and a usd alert can never fire | yes | yes |

An unpriced model contributes nothing to the cost, so a usd alert cannot fire
for it. The harness does not estimate a price.

## Not covered yet

The issue also asks for near-limit warnings against a **plan or window
allowance** (for example, 80% of a 5-hour subscription window). ach has no
source for that allowance: no vendor exposes one to the harness, and ach has no
config for one. The engine takes arbitrary source keys and an arbitrary
fraction, so the family can be wired in once an allowance input exists.

Context pressure uses the same persisted crossing engine: a `near-limit` alert
with metric `context`, threshold `0.85`, value in percentage points and limit
`100`. It is enabled automatically for supported context meters. Only known
last-call occupancy can trigger it; unknown windows and turn-total upper bounds
do not. Context alerts appear in the same dash/web banners and event stream,
and honor the same cooldown and reset behavior.
