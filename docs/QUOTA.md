# Subscription quota headroom (`ach quota`)

`ach quota` answers "how much of this window is left?" with the number the vendor
itself reported. ach never estimates headroom from its own token or cost math. If
a vendor reports nothing, the row says `n/a` and gives the reason.

```
$ ach quota
AGENT     WINDOW  USED  REMAINING  % LEFT  AS OF     SOURCE
claude    5h      23.5% 2h13m      76.5%   0m ago    statusline
claude    7d      41.2% 4d6h       58.8%   0m ago    statusline
opencode  n/a     n/a   n/a        n/a     n/a       no vendor quota source wired
kiro      n/a     n/a   n/a        n/a     n/a       no vendor quota source wired
codex     7d      6.0%  14h50m     94.0%   4d9h ago  ~/.codex/sessions/.../rollout-….jsonl
gemini    n/a     n/a   n/a        n/a     n/a       no vendor quota source wired
prime     n/a     n/a   n/a        n/a     n/a       no vendor quota source wired
```

- **WINDOW**: `5h`, `7d`, `spend` (a gateway spend limit), or the vendor's stated length.
- **USED**: the percent of the window consumed, as the vendor reported it. Vendors
  report percentages, not absolute allowances, so ach shows no token counts here.
- **REMAINING**: the time left until the window resets (`resets_at − now`).
- **% LEFT**: `100 − USED`, floored at 0. A spend limit can report more than 100% used.
- **AS OF**: how long ago the vendor reported the numbers. They are a snapshot, not a live reading.
- A window whose `resets_at` passed after it was observed shows as `n/a` with the
  reason "window reset". The old percentage belonged to a window that has ended.

`ach quota --json` prints the same rows as JSON (`available`, `usedPercent`,
`leftPercent`, `resetsAt` in epoch seconds, `resetsInMs`, `observedAt` in epoch ms,
`source`, `reason`). `--agent A` filters the rows. `ach dash` shows a **QUOTA**
column built from the same rows. It holds the tightest live window's % left, such
as `98%/5h`, and is re-read at most every 30 s.

## Sources and field paths

| Agent | Source | Field path | Status |
|---|---|---|---|
| codex | Codex CLI rollouts `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` | `payload.rate_limits.{primary,secondary}.{used_percent, window_minutes, resets_at}` on `payload.type == "token_count"` lines; `resets_at` is in epoch seconds | **Real.** Observed on disk in both the 7d-only and the 5h+7d shapes. ach reads the last observation in the newest rollout that has one. |
| claude | Claude Code statusline stdin JSON | `rate_limits.{five_hour,seven_day,spend_limit}.{used_percentage, resets_at}`; `resets_at` is in epoch seconds | **Real, opt-in.** Documented at <https://code.claude.com/docs/en/statusline>. Claude Code sends it only to claude.ai Pro/Max subscribers (or behind a gateway spend limit), and only after the first API response. |
| gemini | none | none | `n/a`: no vendor quota source is wired |
| prime | none | none | `n/a`: no vendor quota source is wired |
| opencode | none | none | `n/a`: no vendor quota source is wired |
| kiro | none | none | `n/a`: Kiro reports per-run credits, not plan headroom |

### Claude: wire the statusline

Claude Code does **not** put `rate_limits` in `claude -p --output-format stream-json`.
The only place it appears is the JSON the status line receives on stdin, so ach
cannot read it from a run. Add one line to your status line script. It snapshots
the `rate_limits` block to `<stateDir>/quota/claude.json` and prints nothing:

```bash
#!/usr/bin/env bash
input=$(cat)
printf '%s' "$input" | ach quota ingest claude >/dev/null 2>&1 &
# ... your existing status line rendering of "$input" ...
```

Ingest ignores input that has no `rate_limits`, such as an API-key session or the
time before the first response. It also ignores input that is not JSON. In both
cases it exits 0 and keeps the previous snapshot, so it can never break your
status line.

## Environment overrides (testing)

| Variable | Default |
|---|---|
| `AGENTIC_CODING_HARNESS_QUOTA_CODEX_DIR` | `~/.codex/sessions` |
| `AGENTIC_CODING_HARNESS_QUOTA_CLAUDE_FILE` | `<stateDir>/quota/claude.json` |

## Extending

To add a vendor, give it a parser in `src/core/quota.ts` that returns a
`QuotaSnapshot` (windows of `usedPercent` / `windowMinutes` / `resetsAt`). Then
save a trimmed, anonymized real payload under `tests/fixtures/quota/` and cover it
in `tests/quota.test.ts`. Implement only shapes you have actually observed.
