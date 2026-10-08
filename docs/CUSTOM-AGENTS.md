# Custom agents: command templates and `agents.d` descriptors

ach ships adapters for seven CLIs (claude, opencode, kiro, codex, gemini, prime, copilot) and a desktop-app adapter (kiro-ide). You
can run any other CLI in two ways, and neither needs a code change:

1. **Per invocation** (#37): `ach run --agent custom --template '<cmd>' "<prompt>"`.
2. **Persisted** (#38): drop a JSON descriptor into an `agents.d/` directory.
   After that, `ach run --agent <name>` and `ach stats --agent <name>` accept
   it, and its runs appear under their own name in the run registry that
   `ach dash` reads (tested). `ach web` reads the same registry, but custom
   names there are untested.

## 1. `--agent custom --template`

```sh
ach run --agent custom --model m1 \
  --template 'mycli --model {model} --cwd {workspace} {prompt}' \
  "refactor the parser"
```

| Placeholder   | Value                                                                  |
|---------------|------------------------------------------------------------------------|
| `{prompt}`    | the prompt (after any attachments are composed in)                     |
| `{model}`     | `--model`. If the template uses `{model}`, a model is **required** and the run fails fast without one. |
| `{workspace}` | the run's working directory (the current cwd). The child also runs there. |

### Prompt delivery and quoting

- **Default (argv) mode.** ach splits the template into words the way a POSIX
  shell does, and does nothing else: `'…'` is literal, `"…"` honours `\"` and
  `\\`, and a bare `\` escapes the next character. There is no globbing, no
  `$VAR` expansion and no command substitution. Placeholders are substituted
  **inside each argv element after the split**, so `--prompt={prompt}` works
  too. The child is spawned with `shell: false`. A prompt full of spaces,
  quotes, `$(...)` or backticks arrives as exactly one literal argument.
  Argv mode requires a `{prompt}` placeholder.
- **`--prompt-stdin`.** ach writes the prompt to the CLI's stdin and then
  closes it. The template needs no `{prompt}`. Use this for long prompts or
  for CLIs that read stdin. If the template still contains `{prompt}`, the
  prompt is delivered **twice**, once in argv and once on stdin.
- `--extra-args` values are appended after the resolved template in argv
  and stdin modes. With `--template-shell` they are refused, because
  `sh -c` would silently turn them into `$0`/`$1`. Put them in the template
  instead.
- **`--template-shell`.** The template runs under `/bin/sh -c`.
  **Risk:** the template itself is shell code, so pipes, globs and `$vars` in
  it expand. Placeholder *values* are still never pasted into the shell text.
  `{prompt}` becomes `"$ACH_PROMPT"` (and likewise `"$ACH_MODEL"` and
  `"$ACH_WORKSPACE"`), and the values travel in the child's environment.
  Don't quote placeholders yourself: `'{prompt}'` would turn into the literal
  string `"$ACH_PROMPT"`.

### What gets recorded

Every run writes a RunRecord (`<stateDir>/runs/<runId>.json`) with two
optional fields that built-in runs don't carry:

- `command` is the resolved argv, with the prompt redacted as
  `<prompt:N chars>`. In shell mode it is `["/bin/sh","-c","<template with $ACH_* refs>"]`.
- `metering` is `"none"` when no usage source exists (the default text output),
  or `"tap"` when a JSONL usage tap matched at least one line.

Status mapping. A nonzero exit code gives `exitStatus: "error"` and
`status: "error"`, which is what #37 calls "failed". The error event reads
`<cmd> exited with code N`. Every stderr line is kept as a `progress` event,
and every stdout line becomes an assistant `message` event.

### Honest metering

A `metering: "none"` run has **no** token records. The run summary prints
`input=n/a … cost n/a`, never zeros. `ach stats` counts these runs in a
separate **unmetered** group:

```
totals    records=… input=… cost=$…
unmetered runs=2 tokens=n/a cost=n/a
  custom    runs=2 tokens=n/a cost=n/a (unmetered)
```

`ach stats --json` adds `"unmetered": {"runs": N, "byAgent": {...}}` next to
`total`, `byAgent` and `byDay`. The key is present only when at least one
such run exists, so the output shape is unchanged for anyone who has never
run one. The metered totals never include unmetered runs.

## 2. `agents.d/` descriptors

ach searches two directories. The first definition of a name wins, and any
later one is ignored with a warning:

1. `<cwd>/.ach/agents.d/*.json` (project)
2. `<stateDir>/agents.d/*.json` (user; `stateDir` is
   `AGENTIC_CODING_HARNESS_STATE_DIR`, default `~/.agentic-coding-harness`)

`ach agents [--json]` lists the built-ins, the loaded descriptors and every
descriptor problem.

### Schema

The machine-readable form is [`agent-descriptor.schema.json`](agent-descriptor.schema.json).
A test keeps it identical to the zod schema the loader uses. Unknown fields
are rejected at every level.

```jsonc
{
  "name": "mycli",                 // the --agent handle: [a-z0-9][a-z0-9._-]{0,63}
  "description": "optional",
  "launch": {                      // or null for a meter-only agent
    "template": "mycli -p {prompt}",   // same rules as --template
    "promptVia": "argv",           // "argv" (default) | "stdin"
    "shell": false,                // true = --template-shell semantics
    "output": {                    // default {"format":"text"}
      "format": "jsonl",           // "text" | "jsonl"
      "text": ".message",          // path to assistant text (else the raw line)
      "sessionId": ".session_id",  // path to the CLI's session id
      "usage": {                   // jq-like paths; a line counts as usage if any token path resolves
        "input": ".usage.input_tokens",
        "output": ".usage.output_tokens",
        "cacheRead": ".usage.cache_read",
        "cacheWrite": ".usage.cache_write",
        "reasoning": ".usage.reasoning",
        "model": ".model",
        "costUsd": ".cost_usd"     // provider-REPORTED USD only
      },
      "inputIncludesCache": false  // true: input includes cache reads (subtracted)
    }
  },
  "usageTap": {                    // or null. Transcripts the CLI writes itself
    "type": "transcript",
    "path": "~/.mycli/logs",       // absolute or ~/; a .jsonl file or a dir scanned recursively
    "format": "jsonl",
    "fields": { "input": ".u.in", "output": ".u.out", "model": ".model",
                "timestamp": ".ts", "sessionId": ".session" },
    "inputIncludesCache": false
  },
  "pricingHints": {                // optional, USD per 1M tokens
    "mycli-large": { "input": 3, "output": 15, "cacheRead": 0.3, "cacheWrite": 3.75 }
  }
}
```

Field paths: `.a.b[0].c` and `a.b.0.c` are equivalent. Each JSONL line that
matches is one usage record, and records are **summed**. If your CLI prints
cumulative totals on every line, point the paths at the per-turn delta
instead. Canonical `input` means *uncached* input (see
[TOKEN-COUNTING.md](TOKEN-COUNTING.md)); set `inputIncludesCache` when the
CLI's input figure includes cache reads.

### Loader rules (all tested)

| Situation | Result |
|---|---|
| Unknown field (e.g. `launch.tempalte`) | error `agents.d: <file>: launch.tempalte: unknown field`; that descriptor is skipped and the others keep working |
| Not JSON | error with field `(file)` |
| `usageTap.path` relative, or missing on disk | error on field `usageTap.path` ("must be absolute or start with ~/" or "does not exist") |
| `launch` and `usageTap` both null | error |
| Name collides with a built-in (`claude`, …) or with `custom` | warning `… the built-in wins`; descriptor ignored |
| Same name in both directories | project wins, with a warning |

Errors and warnings print as `[warn]` lines on `ach run`, `ach stats` and
`ach agents`. They are never fatal.

### Meter-only descriptors

`"launch": null` with a `usageTap` makes `ach stats` read the CLI's own
transcripts under the descriptor name, priced with `pricingHints`. `ach run
--agent <name>` then refuses with a "meter-only" error. Like the machine
claude/codex/gemini transcript scan, taps are skipped by `ach stats --state-only`.

### Pricing hints

`pricingHints` sit on top of the bundled price map, for this agent only:

- If a record carries a **provider-reported** `costUsd` (a tap `costUsd`
  path), that number wins. The record is stamped
  `extra.pricing = {"provenance":"reported"}`, and the hint is never applied
  over a vendor number.
- A hinted model is priced from the hint and stamped
  `extra.pricing = {"provenance":"computed","source":"<descriptor file>#pricingHints"}`.
  One warning per model names the hint source.
- Any other model falls through to the bundled pricer unchanged. An unknown
  model stays unpriced (`n/a`), never `$0`.

### Worked examples

[`examples/agents.d/goose.json`](../examples/agents.d/goose.json) and
[`examples/agents.d/aider.json`](../examples/agents.d/aider.json) are both run
through the loader by the test suite. Both are **unmetered** (`usageTap: null`,
text output). Neither CLI's stdout carries a machine-readable usage record,
and ach does not guess transcript formats it has no sample of.

## Add a read-only CLI in 5 steps

1. Find the non-interactive invocation (`mycli run -p "…"`, `mycli --message "…"`).
2. Write `.ach/agents.d/mycli.json` with `name` and `launch.template`, putting
   `{prompt}` where the prompt goes (or setting `promptVia: "stdin"`).
3. Run `ach agents` and fix anything it reports: it names the file and the field.
4. Try it: `ach run --agent mycli "say hi"`. The RunRecord shows the resolved
   `command` and `metering: "none"`.
5. For metering, find a JSON line with token counts, either on stdout
   (`launch.output.format: "jsonl"` + `usage` paths) or in the CLI's log files
   (`usageTap`). Add `pricingHints` if the bundled price map doesn't know the
   model. Once one line matches, runs are recorded `metering: "tap"`.

## Not covered (yet)

- The MCP `harness_run` tools still accept only the built-in agents; descriptors
  are a CLI and library feature.
- There is no generated docs agent matrix in this repo for descriptors to
  appear in.
- A descriptor `usageTap` reads JSONL only. There is no parser plug-in
  interface (#09) for other transcript formats yet.
