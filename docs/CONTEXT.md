# Context composition (`ach context`)

`ach` already records how full a run's context window was at its latest model call
(`totals.contextTokens`, rendered `ctx ~= N tok (p%)`). `ach context <runId>` answers the next
question: **what filled it**. It reads the run's stored events (the raw transcript under
`<stateDir>/raw/`) and its RunRecord, so it works entirely offline: no agent re-run, no network
call, no cost.

```
ach context <runId> [--json] [--state-dir <stateDir>]
```

```
run run-ctx-1  (claude)
context    2,500 tok (latest model call, recorded)
component           tokens      % of context
prompt / user          100              4.0%
assistant text         200              8.0%
reasoning              n/a               n/a  (this adapter records no reasoning text)
tool calls               5              0.2%
tool results         1,100             44.0%
unattributed         1,095             43.8%
sum        2,500 of 2,500 tok (parts sum to the total)

tools (top 2 of 2 by context share)
tool  calls      tokens     results      % of context
Read      1       1,004       1,000             40.2%
Bash      1         101         100              4.0%

compactions n/a (this adapter records no compaction marker)
events     8 of 11 counted (before the latest model call)
method     components estimated as characters / 4 ...
```

The `/trio?run=<runId>` page shows the same breakdown as a **context composition** card in the
metrics pane: one stacked bar (a segment per known component), the per-component shares, the top
5 tools, and the compaction count. It is computed by the same function over the same events,
served as `composition` on `GET /api/runs/:runId/observability`; nothing new is recorded.

## Components

| Component | What counts | Source |
|---|---|---|
| prompt / user | text of `message` events with role `user` | estimated |
| assistant text | text of assistant `message` events that are not reasoning | estimated |
| reasoning | `message` events with `reasoning: true`, and `reasoningContent` | estimated |
| tool calls | the arguments of every tool call | estimated |
| tool results | the output of every tool result, also split per tool | estimated |
| unattributed | the measured total minus every estimate above | measured remainder |

`unattributed` is everything the event log does not carry as text: the system prompt, tool
schemas, instructions files, and any component marked n/a (the prompt itself on adapters that
never write it to the event log, hidden reasoning on adapters that drop it).

## How the numbers are made

- **Total (measured).** The latest model call's prompt tokens (input + cache read + cache write),
  the same reading as `totals.contextTokens`. When the RunRecord has no such reading, the context
  meter (`src/core/context-meter.ts`) is re-run over the stored events. A run with only cumulative
  turn-total usage (#141) or no usage at all has no total: the residual is n/a and shares are
  fractions of the attributed estimate (`denominator: "attributed"`, labelled `% of attributed`).
- **Components (estimated).** Characters / 4, the same rule as `usage.context.toolOutputTokens`, so
  the tool-results row agrees with the occupancy meter's own tool-output estimate.
- **Window.** Only events before the event that carried the latest-call reading are counted: that
  call's own output (its reply, the tool calls it emitted) is not part of its prompt. After an
  explicit compaction marker, only events after the last marker count.
- **Sum rule and tolerance.** When the estimates fit inside the total, `unattributed` is the
  remainder and the parts sum to the total exactly. When the estimates exceed the total,
  `unattributed` is n/a (never negative; nothing is clamped or rescaled) and the overshoot is
  judged against the **10% tolerance** (`CONTEXT_COMPOSITION_TOLERANCE`): within it, the gap is
  ordinary chars-per-token estimate error; beyond it, content left the window (for example an
  unrecorded compaction) or the text tokenizes very differently from 4 characters per token, and
  the output says `OUTSIDE the 10% tolerance`.
- **Sub-agents are not separated.** The stored events carry no sub-agent lane (claude's stream
  parser keeps the lane only in its per-line metadata, beside the event rather than on it), so a
  sub-agent's messages and tool traffic count as main-window content, although the main model only
  ever sees the sub-agent's final answer. A run that spawns sub-agents can therefore overshoot the
  total; the overshoot reason names this beside compaction.
- **Resumed sessions.** When several RunRecords share one raw transcript (a resumed session), a run
  counts only the events before the next record's start, the same ownership rule as `ach audit`.
  Earlier runs' events stay in, because a resumed window really holds them.

## n/a, never a made-up share

A component is n/a (JSON `null`, with a `reason`) when no event carrying it was seen:

- **reasoning** on adapters without a reasoning split (claude's stream drops thinking blocks;
  codex, cursor and kiro record reasoning text).
- **prompt / user** when the adapter never writes the user turn to the event log.
- **tool calls / tool results** when the run has no tool events.
- **every text component** when the run was recorded below `full` content capture (`--capture-mode
  metadata|off`, see [CAPTURE.md](CAPTURE.md)) or the text is the `[STRIPPED]` marker: a stripped
  string has no size worth counting. Tool names and call counts still show.
- **compactions** unless an event is an explicit marker (`type: "compaction"` /
  `"compact_boundary"`, or `subtype: "compact_boundary"` on the event or its `data`). No built-in
  adapter records one today, so the count is n/a rather than an inferred 0.

When the RunRecord carries the agent's own category split (kiro's `context_usage` breakdown), it
is printed verbatim as `reported` beside the estimate.

## `--json`

`--json` prints `{ runId, agent, total, denominator, components[], tools[], attributedTokens,
sumTokens, overshoot, withinTolerance, tolerance, compactions, eventsCounted, eventsTotal,
reported?, method }`. `components` is always in the order above; `tools` lists every tool, largest
context share first (the text table prints the top 5 and a `+K more` line). Each component has
`tokens`, `share`, `estimated` and, when n/a, `reason`.

The output carries numbers and tool names only, never prompt, message or tool text.

Exit codes: 0 on success; `NOT_FOUND` when the run is unknown, its RunRecord does not parse, or its
event log is missing.
