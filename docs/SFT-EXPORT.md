# SFT export (`ach emit --format sft`)

Turn recorded runs into OpenAI chat-format JSONL for supervised fine-tuning
(#78). One line per sample, each `{"messages": [...]}` and nothing else.

```bash
ach emit --input run.json --format sft --out run.sft.jsonl
ach emit --input trials/ --format sft --min-score 4 --exit success --agent claude --out good.sft.jsonl
ach emit --input run.json --format sft --full-conversation --out full.sft.jsonl
```

Without `--out` the JSONL goes to stdout and a one-line tally to stderr.

## Turn mapping

| Run event | Message |
|---|---|
| `message` from `system` | `{role: "system", content}` |
| `message` from `user` | `{role: "user", content}` |
| `message` from `agent` / `assistant` | `{role: "assistant", content}` |
| `tool_call` | added to the preceding assistant message's `tool_calls: [{id, type: "function", function: {name, arguments}}]` (`arguments` is a JSON string). A call with no text before it gets an assistant message with `content: ""` |
| `tool_result` | `{role: "tool", tool_call_id, content}` right after the assistant message that made the call (object content is JSON-stringified) |

System prompts appear only when the transcript recorded them. Output is kept
valid for OpenAI fine-tuning: a tool call that never got a result, and a
result with no matching call, are dropped. Usage, model-call and other events
are ignored.

## Two sampling modes

- **Turn-level (default):** one sample per assistant message. Each sample holds
  the whole conversation up to and including that message, so an assistant
  message that issues a tool call is a sample (the target is the call), and so
  is the answer after the tool result.
- **`--full-conversation`:** one sample per run, ending at the last assistant
  message. Use it for setups that train on every assistant turn of a single
  sample.

Pick by training setup: turn-level when the trainer scores only the final
assistant message of each sample, full-conversation when it scores all of
them. A run with no assistant message produces no sample.

## Inputs, scores and filters

`--input` is one of:

- an event array or `{events: [...]}`: a single run with **no** score, exit
  or agent data;
- a `RunResult` JSON (`ach run --json`, one file per run) or a `--repeat`
  envelope (each child run is its own run);
- a directory of `RunResult` JSON files, or a root whose subdirectories are
  such directories: the same layout `ach report` reads, including
  `<ledger>.runs/<task>/<agent>~<model>~trialN.json` from `ach trial`
  ([TRIALS.md](TRIALS.md)). For files with no `agent` field, the part of the
  file name before the first `~` is the agent.

Filters apply per run:

| Flag | Keeps a run when | Data comes from |
|---|---|---|
| `--min-score N` | score >= N | top-level numeric `score` on the run JSON (for external graders), else the `verify` verdict of `ach run --verify`: `pass` = 1, `fail`/`error` = 0 |
| `--exit X` (e.g. `success`) | `exitStatus` equals X | `exitStatus` on the RunResult |
| `--agent A` | agent equals A | `agent` on the RunResult, else the token records' agent, else the file-name prefix |

Events themselves carry no scores. A run lacking the needed field is excluded
by that filter. If **no** run in the input carries the field, the command
fails with a `USAGE` error instead of passing everything (for example,
`--min-score` on a bare event array). Regrades (`ach regrade`) do not change
the score used here; the run-time `verify` verdict does. The tally line reports
`samples from kept/read runs`.

## Minimal example

[`examples/sft-run.result.json`](examples/sft-run.result.json) is a recorded
run (system prompt, a user question, a tool call and result, a final answer).
`ach emit --input docs/examples/sft-run.result.json --format sft --full-conversation`
produces [`examples/run.sft.jsonl`](examples/run.sft.jsonl), one line (pretty-printed here):

```json
{"messages": [
  {"role": "system", "content": "You are a careful coding agent."},
  {"role": "user", "content": "What is in notes.txt?"},
  {"role": "assistant", "content": "Let me read it.",
   "tool_calls": [{"id": "call_1", "type": "function",
                   "function": {"name": "read_file", "arguments": "{\"path\":\"notes.txt\"}"}}]},
  {"role": "tool", "tool_call_id": "call_1", "content": "buy milk"},
  {"role": "assistant", "content": "notes.txt says: buy milk."}
]}
```

A test (`tests/emitters-sft.test.ts`) regenerates this file from the fixture and
validates it against a schema of the OpenAI chat format.
