# Config file

`ach` reads flag defaults from a JSON config file, so a budget cap or a dashboard port does not
have to be retyped on every command (#41).

```json
{
  "$schema": "https://raw.githubusercontent.com/sblattj/agentic-coding-harness/main/docs/config.schema.json",
  "stateDir": "~/.agentic-coding-harness",
  "run": { "budgetUsd": 5, "maxTurns": 40, "onBudget": "abort" },
  "stats": { "days": 7, "tz": "Europe/Berlin", "by": ["model"] },
  "web": { "port": 8399, "noOpen": true },
  "serve": { "port": 8398 }
}
```

Implementation: `src/cli/config.ts`. Published schema: [`config.schema.json`](config.schema.json).

## Where the file is read from

| Source | Path |
|---|---|
| `ach --config <path> <command> ...` (global, before the command) | that file only |
| env `AGENTIC_CODING_HARNESS_CONFIG=<path>` | that file only (the flag wins over the env var) |
| default search, user file | `~/.config/agentic-coding-harness/config.json` |
| default search, project file | `./.ach/config.json` (the same `.ach/` dir as `.ach/agents.d`) |

With the default search both files are read and merged per key: a key in the project file overrides
the same key in the user file, and keys only the user file sets still apply. A missing default file
is not an error. A missing `--config` / `AGENTIC_CODING_HARNESS_CONFIG` file is.

`--config` must come before the command name (`ach --config ci.json run ...`); after it,
`--config` is parsed as one of that command's own flags.

## Schema

- `stateDir`: the state root for every command (same as `AGENTIC_CODING_HARNESS_STATE_DIR`). A
  leading `~` expands to your home dir; a relative path is relative to the config file's dir.
- `run`, `stats`, `web`, `serve`: one section per command. Each key is a long flag name of that
  command in camelCase: `--budget-usd` is `run.budgetUsd`, `--no-open` is `web.noOpen`,
  `--source-poll-ms` is `web.sourcePollMs`. Every long flag of the command is a valid key.
  - flags that take a value accept a string or a number (`"budgetUsd": 5` or `"5"`);
  - on/off flags take `true` / `false`;
  - repeatable flags (`run.extraArg`, `run.allowedTools`, `stats.by`, ...) take one value or an
    array.
- `$schema`: optional, ignored by `ach`; point it at the published schema for editor validation
  and autocomplete.

The keys come from each command's own flag table, so a flag added to `ach run` later is
configurable with no config-specific change. `ach config --schema` prints the schema for the
installed version; [`config.schema.json`](config.schema.json) is that output, kept in sync by a
test (regenerate with `ach config --schema > docs/config.schema.json`).

## Precedence

**flag > `AGENTIC_CODING_HARNESS_*` env > config file > built-in default**, per key.

| Example | Wins |
|---|---|
| `ach run --budget-usd 0.2 ...` with `AGENTIC_CODING_HARNESS_BUDGET_USD=0.15` and `run.budgetUsd: 0.1` | the flag, 0.2 |
| `AGENTIC_CODING_HARNESS_BUDGET_USD=0.15` and `run.budgetUsd: 0.1` | the env var, 0.15 |
| `run.budgetUsd: 0.1` only | the file, 0.1 |
| nothing set | the built-in default (no USD cap) |

The env layer applies to the flags that already have an env default: `--budget-usd`, `--max-turns`,
`--wall-ms`, `--idle-ms`, `--budget-alerts`, `--warn-at` (`_WARN_THRESHOLDS`), `--tz`, `--plan` and
`--plan-window-*`, `--cost-mode`, `--project-aliases`, `--token` (`_HTTP_TOKEN`), `--source*`,
`--gateway`, `--root`, `--max-jobs`, `--max-output-bytes`, `--allow-extra-args`,
`--claude-default-config` and `--claude-no-background-tasks`; the full map is `ENV_MIRRORS` in
`src/cli/config.ts`. Any other key goes straight from the file to the flag. `stateDir` follows the
same rule against `AGENTIC_CODING_HARNESS_STATE_DIR`, and so do `web.stateDir` / `web.dir` (the
`web` command reads the same env var); a command's own `--state-dir` flag still wins. `stats.dir`
is a transcript root, has no env var, and so always comes from the file.

Relative paths in a file resolve against that file's directory, never the process cwd, and a
leading `~` expands to your home dir. This covers `stateDir` and every path-typed key:
`run.evidenceDir`, `run.kiroIdeUserDataDir`, `stats.dir`, `stats.transcriptDir`, `web.dir`,
`web.stateDir` and `serve.root` (`PATH_FLAGS` in `src/cli/config.ts`).

Two limits of flag parsing to know:

- an on/off flag set to `true` in the file cannot be switched off from the command line (there is
  no `--no-<flag>` form); remove the key or pass `--config` with another file;
- for a repeatable flag, any occurrence on the command line replaces the file's whole list.

`--dir` and its long forms (`--state-dir`, `--transcript-dir`) count as one flag here: `--dir` on the
command line beats `web.stateDir` from the file instead of tripping the "disagree" check.

Value checks (a negative `maxTurns`, an unknown `onBudget`) run in the command, exactly as for the
flag, so their message names the flag (`--max-turns expects ...`), not the file.

## `ach config`

```text
ach config --show [<section>] [--json] [-- <section flags>]
ach config --set <key> <value> [--dry-run] [--json]
ach config --unset <key> [--dry-run] [--json]
ach config --schema
```

- `--show` prints every key with its resolved value and where it came from: `flag`, `env:<NAME>`,
  `file:<path>` or `default`. `<section>` limits the list to one command. Flags after `--` are
  parsed as that command's command line, to preview what would win:
  `ach config --show run -- --budget-usd 2` reports `run.budgetUsd 2 [flag]`.
- `--set <key> <value>`: `<key>` is `stateDir` or `<section>.<key>` (`run.budgetUsd`). The value is
  coerced by the key's type: a number for numeric keys (`run.budgetUsd`, `run.maxTurns`,
  `serve.port`, ... and anything else listed in `NUMERIC_FLAGS`; a non-number is rejected),
  `true`/`false` for on/off flags, a JSON array when a repeatable flag's value starts with `[`,
  else the text verbatim (`--set serve.token 007` stores `"007"`, not `7`). Writes `./.ach/config.json`
  (created with a `$schema` line if absent), or the `--config` / `AGENTIC_CODING_HARNESS_CONFIG`
  file when one is given, then prints the resolved config.
- `--dry-run` prints the resolved config as it would be after the change and writes nothing.
- `--unset <key>` removes a key (and its section once empty). It accepts any key path the target
  file holds, known or not, so a misspelled key can be removed (`--unset run.bugdetUsd`).
- `--json` prints `{ files: [{path, kind, loaded}], values: { "<key>": {value, source, flag} } }`.

`--set` validates only the key and value it writes (an unknown key or a bad value is rejected and
nothing is written). Other problems already in the file are printed as `config: warning: ...`
lines instead of blocking the edit, so a file with a typo can still be repaired; `ach run` and
the other commands still reject such a file until it is fixed.

## Errors

A config problem fails the command before it does anything, exit `1`, with a message that names the
file, the section and the key:

```text
harness: config /repo/.ach/config.json: section 'run' has unknown key 'bugdetUsd' (run.bugdetUsd) (did you mean 'budgetUsd'?); keys mirror `ach run` long flags in camelCase
```

Rejected: an unknown section, an unknown key, a kebab-case key (`budget-usd`), a value of the wrong
type, invalid JSON, a top level that is not an object, and a missing `--config` file. Every section
is checked on every command, so a typo in `run` also stops `ach stats`: a misspelled cap never
silently turns into no cap.
