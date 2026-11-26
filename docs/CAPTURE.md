# Content capture: `--capture-mode full|metadata|off`

ach records every run: the hash-chained raw transcript, the RunRecord, the
`--output-dir` artifacts, desk event logs. By default that record holds the
full text: your prompt, the agent's replies and reasoning, every tool call's
arguments and output. The content-capture tier decides how much of that text
ach writes, per run and per agent.

| tier | what ach writes |
| --- | --- |
| `full` (default) | everything, exactly as before this setting existed |
| `metadata` | every event, with its type, ids, timestamps, model and tool names, token counts, costs and durations; every other string becomes `[STRIPPED]` |
| `off` | the run lifecycle (session start/end, done, aborted, error type) and the token lines, stripped; no message, reasoning, tool, step or progress events |

The tier is applied at **record time**, in the driver, before any byte is
written. It is not an export filter: under `metadata` or `off`, the prompt and
tool text never reach the state dir in the first place, so there is nothing to
leak later from a backup, a sync, or `ach web`.

## Setting it

```sh
ach run --agent claude --capture-mode metadata "refactor the parser"
ACH_CAPTURE_MODE=off ach run --agent codex "..."
ach trial --matrix plan.json --capture-mode metadata     # every cell
```

In the config file (`.ach/config.json` or `~/.config/agentic-coding-harness/config.json`,
see [CONFIG.md](CONFIG.md)):

```json
{
  "run": { "captureMode": "metadata" },
  "contentCapture": {
    "default": "metadata",
    "agents": { "codex": "off", "claude": "full" }
  }
}
```

`"contentCapture": "metadata"` (a bare tier) is shorthand for `{ "default": "metadata" }`.
`ach config --set contentCapture.default metadata` and
`ach config --set contentCapture.agents.codex off` write the same keys; `--unset` removes them.
`ach config --show` lists them with the file they came from.

### Precedence

For one run of agent `A`, the first of these that is set wins:

1. `contentCapture.agents.A` in the config file. It beats every global tier
   in **both** directions: an agent pinned to `off` stays `off` even under
   `--capture-mode full`, and an agent pinned to `full` keeps its text even
   under `ACH_CAPTURE_MODE=off`. It is the administrator's statement about
   that one agent.
2. `--capture-mode` (or `run.captureMode` from a profile or the file's `run`
   section, through the usual flag layering).
3. `ACH_CAPTURE_MODE`. As with every env-mirrored flag, the env var beats the
   file's `run.captureMode`.
4. `contentCapture.default` in the config file.
5. `full`.

Library callers set `RunSpec.captureMode` (it beats `DriverOptions.capture.mode`)
or `DriverOptions.capture`; the env var applies to them too.

## What each sink records

| sink | `full` | `metadata` | `off` |
| --- | --- | --- | --- |
| raw transcript `<stateDir>/raw/*.jsonl` | every event | every event, stripped | lifecycle and token events, stripped |
| RunRecord `<stateDir>/runs/<id>.json` | as before | no `promptPreview`; `lastEvent` is the event type and tool name | no `promptPreview`; `lastEvent` is the event type |
| `--output-dir` `invocation.json` | prompt | prompt `[STRIPPED]` | prompt `[STRIPPED]` |
| `--output-dir` `events.jsonl`, `stderr.txt` | every event | stripped events | lifecycle and token events |
| `--output-dir` `stdout.txt` | raw agent stdout | empty (raw stdout cannot be stripped) | empty |
| `--output-dir` `result.json`, trial cell artifacts, `ach run --json`, the MCP run tools | RunResult | RunResult without `prompt`, stripped events and token extras | same, lifecycle and token events only |
| interactive `<stateDir>/casts/<id>.cast` | terminal recording | not written | not written |
| desk events `<stateDir>/desks/<stack>/events/*.jsonl` | every event | stripped events | status, error, turn and usage events |
| desk messages `<stateDir>/desks/<stack>/messages.jsonl` (by the recipient's agent) | message text | id, from, to, time; text `[STRIPPED]` | same |
| `ach run` live stderr feed | full lines | stripped lines | stripped lines |

Every RunRecord carries `captureMode` and `captureSource` (`agent:<name>`, `flag`,
`spec`, `env:ACH_CAPTURE_MODE`, `config` or `default`). A RunResult carries
`captureMode` only below `full`, and `ach emit --format otel|langfuse` stamps it
as the `ach.capture_mode` resource attribute, so a consumer can tell a
metadata-only trace from one that just had no text. At `full` the RunRecord
gains only those two fields; its RunResult, transcript, artifacts and exports
are unchanged.

"Stripped" means default deny: every string value is replaced with
`[STRIPPED]` unless its key is structural (`type`, ids, timestamps, `model`,
`toolName`, `stopReason`, `provenance`, and similar). Numbers and booleans are
kept, which is what keeps token counts, costs, durations and turn markers
intact.

Inside content (tool `args`/`input`, `output`/`result`, message `content`
blocks, ACP `rawInput`/`rawOutput`, and similar) the structural list does not
apply: an argument called `name` or a result field called `status` is tool
data. There every string, number and boolean becomes `[STRIPPED]`; a content
block keeps its `type` only when it is one of a fixed set (`text`,
`tool_use`, `tool_result`, `thinking`, ...); and object keys are kept only when
they look like an identifier (`file_path`, `command`), anything else (a path, a
sentence) becomes `[STRIPPED]#<n>`.

## What still works

- **Totals and cost**: metering reads the original events before anything is
  stripped, so budgets, alerts and the RunRecord totals are the same in every
  tier. `ach stats` and the archive read the transcript's token lines, which is
  why `off` keeps them (numbers, model and ids only): `ach stats` reports the
  same tokens and cost for a `full`, a `metadata` and an `off` run.
- **The seal (#59)**: the hash chain frames the bytes that were actually
  written, so `ach verify-run` passes on `metadata` and `off` runs.
- **`ach audit`**: `metadata` and `off` transcripts keep their token lines, so
  audit re-derives the totals and checks them as usual.
- **Provider limits in `ach trial`**: a cell that died on a rate or usage limit
  is still `skipped-provider-limit`. The limit wording is stripped from the
  events, so the driver checks the original text and sets
  `RunResult.providerLimit: true`; the ledger reason then reads "rate or usage
  limit (text not recorded: capture mode metadata)".
- **`ach web` and `ach dash`** show these runs with the prompt column empty and
  stripped event bodies. The `ach web` transcript view names the tier in a banner
  and renders each stripped prompt, reply, argument and result as "not captured
  (capture mode metadata)"; an `off` run shows the banner and no turns
  ([TRANSCRIPT-VIEW.md](TRANSCRIPT-VIEW.md)).
- **Desks**: the live desk conversation (its SSE feed and in-memory ring) keeps
  the text, since the conversation is the product; the events file, the
  heartbeat preview and the stack's `messages.jsonl` follow the tier.

## What it does not cover

- **Inputs you hand ach**: a queued prompt file, a desk spec, or a `--template`
  are stored because you wrote them there; they are not recordings.
- **The agent CLI's own files**: claude, codex and the rest keep their own
  session logs in their own directories. ach does not write or control those;
  use the agent's own settings for them.
- **Your terminal**: `ach run` prints its run summary to stdout as before. The
  live stderr feed is stripped below `full`, so a wrapper log that captures it
  (for example an `ach queue` job log) gets no text from it.
- **Library callers' own copies**: `onEvent` receives stripped events below
  `full` (unless the caller opts into raw live events, as desks do), but a
  caller that stores what it receives is its own sink.
- **Argument and field names**: inside content, identifier-like keys are kept
  as the tool's schema (`{"file_path": "[STRIPPED]"}`). A tool that puts data
  in identifier-shaped keys (`{"jane_doe": 3}`) shows those key names.
- **Desk decisions** (`decisions.jsonl`): approval state, written by you or a
  desk on purpose, not a recording.
