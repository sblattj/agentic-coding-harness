# SFT export (`ach emit --format sft`)

Turn recorded runs into OpenAI chat-format JSONL for supervised fine-tuning
(#78). One line per sample, each `{"messages": [...]}` and nothing else.

```bash
ach emit --input run.json --format sft --out run.sft.jsonl
ach emit --input trials/ --format sft --min-score 1 --exit success --agent claude --out good.sft.jsonl
ach emit --input run.json --format sft --full-conversation --out full.sft.jsonl
```

Without `--out` the JSONL goes to stdout and a one-line tally to stderr.

## Turn mapping

| Run event | Message |
|---|---|
| `message` from `system` | `{role: "system", content}` |
| `message` from `user` | `{role: "user", content}` |
| `message` from `agent` / `assistant` | `{role: "assistant", content}` |
| `message` with `reasoning: true` | dropped (see below) |
| `tool_call` | added to the preceding assistant message's `tool_calls: [{id, type: "function", function: {name, arguments}}]`. A call with no text before it gets an assistant message with `content: ""` |
| `tool_result` | `{role: "tool", tool_call_id, content}` right after the assistant message that made the call (object content is JSON-stringified) |
| `prompt` on the RunResult | `{role: "user", content}` as the first turn after any system messages, unless the events already start with a user message |

`ach run --json` (and each run file `ach trial` writes) carries the prompt
you passed as a top-level `prompt` field, because adapters do not record the
prompt as an event. It is the prompt as given, before any `RunSpec.attachments`
(library API) are inlined. The run registry still stores only its SHA-256.

**Reasoning is dropped.** Adapters that surface hidden chain-of-thought mark
those message events `reasoning: true`. Training on them is rarely what you
want, so they never become assistant turns.

**Tool call ids and arguments.** Some adapters record a tool call with an
empty `toolCallId`. Such a call gets a synthetic id `call_sft_N` (never
equal to a real id in the run), and a result with an empty id answers the
most recent still-unanswered empty-id call. `arguments` is always a JSON
string that decodes to an object: an object is JSON-encoded, a string that
already holds a JSON object is kept, an empty or missing value becomes
`"{}"`, and anything else (plain text such as a shell command, an array, a
number) is wrapped as `{"input": value}`, so `ls -la` becomes
`"{\"input\":\"ls -la\"}"`.

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
| `--min-score N` | score >= N | top-level numeric `score` on the run JSON, else the `verify` verdict of `ach run --verify` / `ach trial`: `pass` = 1, `fail`/`error` = 0 |
| `--exit X` | `exitStatus` equals X | `exitStatus` on the RunResult; X must be one of `success`, `error`, `timeout`, `aborted`, `cancelled`, `budget_exceeded`, `turn_limit`, `unavailable` (anything else is a `USAGE` error) |
| `--agent A` | agent equals A | `agent` on the RunResult, else the token records' agent, else the file-name prefix |

Built-in scores are only 0 or 1, so with them use `--min-score 1` (keep
runs whose verify passed). A larger threshold such as `--min-score 4` only
makes sense when an external grader wrote its own numeric `score` field into
each run JSON (for example a 1-5 rubric); `ach` never writes `score`
itself. Events themselves carry no scores. A run lacking the needed field is excluded
by that filter. If **no** run in the input carries the field, the command
fails with a `USAGE` error instead of passing everything (for example,
`--min-score` on a bare event array). Regrades (`ach regrade`) do not change
the score used here; the run-time `verify` verdict does. The tally line reports
`samples from kept/read runs`. Flags for the other formats (`--model`,
`--session-id`, `--langfuse-*`) are rejected with `--format sft`.

## Minimal example

[`examples/sft-run.result.json`](examples/sft-run.result.json) is the
unedited output of `ach run --agent null --json "What is in notes.txt?"`.
`ach emit --input docs/examples/sft-run.result.json --format sft --full-conversation`
produces [`examples/run.sft.jsonl`](examples/run.sft.jsonl), one line (pretty-printed here):

```json
{"messages": [
  {"role": "user", "content": "What is in notes.txt?"},
  {"role": "assistant", "content": "null adapter: deterministic reply 1/1 to: What is in notes.txt?"}
]}
```

The user turn comes from the result's `prompt` field; the session, usage and
step events are ignored. A run with tool use adds assistant `tool_calls` and
`tool` messages per the table above, for example:

```json
{"role": "assistant", "content": "Let me read it.",
 "tool_calls": [{"id": "call_1", "type": "function",
                 "function": {"name": "read_file", "arguments": "{\"path\":\"notes.txt\"}"}}]},
{"role": "tool", "tool_call_id": "call_1", "content": "buy milk"}
```

A test (`tests/emitters-sft.test.ts`) regenerates the example file from the
recorded run and validates it against a schema of the OpenAI chat format.
