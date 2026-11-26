# Alert rules (`alerts` in the config file)

ach can tell you, or a downstream system, when runs keep failing or a live run
has gone quiet. Rules live in the config file under a top-level `alerts` key;
`ach watch` evaluates them on every poll and `ach alerts` validates them,
replays them over history (`--dry-run`) or evaluates them once (`--once`).

Two rule classes:

| `type` | Fires when | Thresholds |
|---|---|---|
| `error_rate` | N of the last M runs with a verdict failed, or K runs in a row failed | `failures` + `window` (N of M), `consecutive` (K); one pair or both |
| `idle` | a run that is still in flight records no agent event for X seconds | `idleSec` (X) |

Each rule sends its hits to one or more destinations: `webhook` (a JSON POST)
and `desktop` (a macOS or Linux notification).

These are separate from the per-run budget alerts of `--warn-at` (see
[BUDGET-ALERTS.md](BUDGET-ALERTS.md)), which watch one run's own spend.

## Example

In `~/.config/agentic-coding-harness/config.json` (or `.ach/config.json`, or the
file `--config` names; see [CONFIG.md](CONFIG.md)):

```json
{
  "alerts": {
    "rules": [
      {
        "name": "fail-streak",
        "type": "error_rate",
        "consecutive": 3,
        "destinations": [
          { "type": "webhook", "url": "https://hooks.example.com/ach" },
          { "type": "desktop", "sound": true }
        ]
      },
      {
        "name": "flaky-claude",
        "type": "error_rate",
        "agent": "claude",
        "failures": 3,
        "window": 10,
        "cooldownSec": 3600,
        "destinations": [{ "type": "webhook", "url": "https://hooks.example.com/ach" }]
      },
      {
        "name": "hung",
        "type": "idle",
        "idleSec": 900,
        "destinations": [{ "type": "desktop" }]
      }
    ]
  }
}
```

Then:

```sh
ach alerts               # validate and list the rules
ach alerts --dry-run     # which rules would have fired on the run history, and when
ach watch                # evaluate the rules live, every 5s poll
ach alerts --once        # evaluate now and send new hits (for cron)
```

## Rule keys

Every rule:

| Key | Required | Meaning |
|---|---|---|
| `name` | yes | unique; letters, digits, `_`, `-`. Shown in every hit and used as the state key |
| `type` | yes | `error_rate` or `idle` |
| `destinations` | yes | one or more of `{ "type": "webhook", "url": "<http(s) URL>" }` and `{ "type": "desktop", "sound"?: true }` |
| `agent` | no | only count runs of this agent |
| `cooldownSec` | no | minimum seconds between two delivered hits of this rule (default 600; 0 = no rate limit) |

`error_rate` adds `failures` + `window` (whole numbers, `failures <= window`)
and/or `consecutive` (a whole number). `idle` adds `idleSec` (a number > 0).

The schema is strict: an unknown key, a wrong type, a threshold of 0, a
`failures` without a `window`, `failures` above `window`, an `error_rate` rule
with no condition, or a repeated `name` is a config error that names the path,
for example:

```text
harness: config /home/me/.config/agentic-coding-harness/config.json: 'alerts.rules.0.idleSec' must be > 0
```

Every command reading the file refuses it (exit 1), so a broken rule never
silently turns alerting off. The schema is also published in
[`config.schema.json`](config.schema.json) for editor validation.

## What counts

**Failures** (`error_rate`) use the same verdict as the success rate in
`ach stats` and `ach web` (`runVerdict` in
[`src/core/registry.ts`](../src/core/registry.ts)): a run that ended `error` or
`aborted` is a failure, `success` is a success. Runs with no verdict (still
running, interrupted, `unavailable` outages) are skipped: they neither break a
streak nor fill a window. Runs are ordered by when they ended. An `N of M` rule
needs M verdict runs before it can fire.

**In flight** (`idle`) means a local registry record with status `running`
whose harness process is still alive. The 15s heartbeat check the dashboard
uses is deliberately not applied: a hung run writes no heartbeat, which is
exactly the case this rule exists for. Quiet time is measured from the run's
`lastEventAt` (the time of its latest agent event, written by the driver), or
from its start when it has had no event yet. A registry keepalive write does
not count as an event.

## Debounce and cooldown

A rule fires once per **episode**, not on every poll:

- an `error_rate` episode starts at the run that tipped the condition and lasts
  until the condition clears (a success ends a streak; a window drops below N).
  More failures inside the episode do not fire again.
- an `idle` episode is one quiet spell of one run. When the run records an
  event, the spell ends; going quiet again is a new episode.

On top of that, `cooldownSec` rate-limits each rule: a new episode within
`cooldownSec` of the rule's last delivered hit is **suppressed**. It is logged
and counted, never delayed, and the next delivered hit carries
`suppressedSinceLastFire`. Episodes and the cooldown clock persist in
`<stateDir>/alert-rules-state.json`, so restarting `ach watch` or running
`ach alerts --once` from cron does not re-announce an episode already sent.
Deleting the file re-arms every rule.

## Destinations

### `webhook`

POSTs through the same delivery as the run event tap (queue, 4 attempts with
backoff, 2s per attempt, HMAC signing with
`AGENTIC_CODING_HARNESS_EVENT_WEBHOOK_SECRET`, masking via `mask.webhook`). The
body is the [event envelope](EVENT-WEBHOOK.md#envelope) with `type: "alert"`:

```json
{
  "schemaVersion": 1,
  "runId": "3f0c...",
  "type": "alert",
  "timestamp": "2026-06-01T00:02:00.000Z",
  "payload": {
    "rule": "fail-streak",
    "ruleType": "error_rate",
    "metric": "consecutive_failures",
    "threshold": 3,
    "value": 3,
    "agent": "claude",
    "runs": [{ "runId": "...", "agent": "claude", "status": "error", "endedAt": 1780272000000 }],
    "suppressedSinceLastFire": 0,
    "message": "3 consecutive failed runs (limit 3)"
  }
}
```

| Field | Meaning |
|---|---|
| envelope `runId` | the run that tipped the `error_rate` rule, or the idle run |
| envelope `timestamp` | when the condition became true |
| `metric` | `consecutive_failures`, `failures_in_window` or `idle_seconds` |
| `threshold` | the configured value that was breached (`consecutive`, `failures` or `idleSec`) |
| `value` | what was observed (failures counted, or seconds idle) |
| `window` | `failures_in_window` only: the rule's `window` |
| `runs` | `error_rate` only: the failed runs counted, oldest first |
| `lastEventAt` | `idle` only: ISO time of the run's last event |
| `suppressedSinceLastFire` | hits of this rule the cooldown held back since the last delivered one |
| `message` | one human line |

The header `X-Ach-Event: alert` lets a receiver route before parsing. Payloads
hold run metadata only, never prompt or agent output.

### `desktop`

Uses the same platform dispatch as run notifications (`sendNotification` in
[`src/core/notify.ts`](../src/core/notify.ts)): `osascript` on macOS,
`notify-send` on Linux, a silent no-op elsewhere or when the tool is missing.
The title is `ach alert: <rule>`, the body is the hit's `message`. `sound: true`
plays the platform alert sound. It does not need
`AGENTIC_CODING_HARNESS_NOTIFY`: the rule itself is the opt-in.

## Fail open

A destination that fails (receiver down, notification tool missing) logs a
`[warn]` line on stderr and changes nothing else: `ach watch` keeps running
and exits 0 on Ctrl-C after a bounded flush (at most 5s per webhook), and
`ach alerts --once` exits 0. A rule evaluation error is logged and retried on
the next poll. `--offline` refuses a non-loopback webhook destination up front
(a usage error), the same as `--event-webhook`.

## `ach alerts --dry-run`

Replays the run registry oldest first and prints every hit the rules would
have produced, with the time it would have fired, without contacting any
destination or writing any state:

```text
alerts: dry run over 214 runs (no destination is contacted, no state is written)
2026-06-01T00:02:00.000Z  fail-streak  error_rate  run 3f0c1a2b  3 consecutive failed runs (limit 3)  -> webhook https://hooks.example.com, desktop
2026-06-01T00:16:00.000Z  hung  idle  run 9e8d7c6b  run 9e8d7c6b (codex) recorded no event for 1080s (limit 900s)  -> desktop
rule fail-streak (error_rate): 1 would fire
rule flaky-claude (error_rate): 0 would fire
rule hung (idle): 1 would fire
```

- `error_rate` is re-evaluated after each run with a verdict, in end order.
- `idle` measures every quiet gap of every run (start, each recorded event,
  end) from the run's raw transcript. A hit fires at the gap's start plus
  `idleSec`; its value is the whole gap. Runs recorded below capture tier
  `full` keep fewer events (see [CAPTURE.md](CAPTURE.md)), so their gaps can
  look longer; the dry run prints a note when any such run is present.
- The cooldown runs on history's clock, so suppressed hits show as
  `(suppressed: 600s cooldown)`.

`--json` prints `{dryRun, runs, hits[], rules[]}` instead (each hit with
`suppressed`).

## Where the rules live

The issue proposed a standalone `~/.ach/alerts.json`. ach already keeps its
settings in one config file with per-feature top-level keys (`mask`,
`contentCapture`, `profiles`), and `<stateDir>/alerts.json` already holds the
budget-alert cooldown state. So the rules are the config file's `alerts` key
(merged like the other keys: a project file's `alerts.rules` replaces the user
file's), and the rule engine's own state is `<stateDir>/alert-rules-state.json`.

Source: [`src/core/alert-rules.ts`](../src/core/alert-rules.ts) (schema,
evaluation, replay, dispatch) and [`src/cli/alerts-cli.ts`](../src/cli/alerts-cli.ts)
(`ach alerts`, the watch runner).
