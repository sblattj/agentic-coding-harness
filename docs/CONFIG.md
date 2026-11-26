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
  "serve": { "port": 8398 },
  "emit": { "attr": ["team=platform"], "attrEnv": ["ci.build_id=BUILD_NUMBER"] },
  "profiles": {
    "fast": { "agent": "claude", "model": "sonnet", "budgetUsd": 1, "maxTurns": 20 }
  }
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
- `run`, `stats`, `web`, `serve`, `emit`: one section per command. Each key is a long flag name of that
  command in camelCase: `--budget-usd` is `run.budgetUsd`, `--no-open` is `web.noOpen`,
  `--source-poll-ms` is `web.sourcePollMs`. Every long flag of the command is a valid key.
  - flags that take a value accept a string or a number (`"budgetUsd": 5` or `"5"`);
  - on/off flags take `true` / `false`;
  - repeatable flags (`run.extraArg`, `run.allowedTools`, `stats.by`, ...) take one value or an
    array.
- `profiles`: named sets of `run` flags, selected with `ach run --profile <name>`; see
  [Agent profiles](#agent-profiles).
- `mask`: secret masking before export (#71). `mode` (`none` | `preview` | `all`, the mode for
  every sink), `style` (`replace` | `partial`), `entropy` (`true` turns on the high-entropy
  detector), `patterns` (extra regexes), and one mode per sink to override `mode`: `atif`, `otel`,
  `langfuse`, `sft`, `report`, `scrub`, `export`, `webhook`. Precedence is `--mask` > env `AGENTIC_CODING_HARNESS_MASK` >
  `mask.<sink>` > `mask.mode` > the sink's built-in default (`all` for the outbound `otel`,
  `langfuse` and `webhook`, `none` for the rest). `ach config --set mask.otel none` writes one key (here, opting
  otel out of the outbound default). `mask.privacy` (`off` | `redact` | `anon`, #46) sets the privacy mode for every
  export and report; precedence is `--privacy` > env `AGENTIC_CODING_HARNESS_PRIVACY` >
  `mask.privacy` > the built-in default (`off`). See [MASKING.md](MASKING.md) and its
  [privacy modes](MASKING.md#privacy-modes) section.
- `contentCapture`: how much prompt and tool text ach records (#72). A bare tier
  (`"metadata"`) or `{ "default": "full|metadata|off", "agents": { "<agent>": "full|metadata|off" } }`.
  `default` sits below `--capture-mode` / `run.captureMode` and `ACH_CAPTURE_MODE`; an
  `agents` entry beats all of them for that agent, in both directions. See
  [CAPTURE.md](CAPTURE.md).
- `alerts`: alert rules (#74). `{ "rules": [...] }`, each rule an `error_rate` (N of the last M
  runs failed, or K in a row) or `idle` (an in-flight run recorded no event for X seconds) rule
  with `webhook` and/or `desktop` destinations and an optional `cooldownSec`. `ach watch`
  evaluates them live; `ach alerts --dry-run` replays them over history. A later file's
  `alerts.rules` replaces an earlier one's whole. See [ALERTS.md](ALERTS.md).
- `$schema`: optional, ignored by `ach`; point it at the published schema for editor validation
  and autocomplete.

The keys come from each command's own flag table, so a flag added to `ach run` later is
configurable with no config-specific change. `ach config --schema` prints the schema for the
installed version; [`config.schema.json`](config.schema.json) is that output, kept in sync by a
test (regenerate with `ach config --schema > docs/config.schema.json`).

## Precedence

**flag > `AGENTIC_CODING_HARNESS_*` env > config file > built-in default**, per key. For
`ach run --profile <name>` the profile is a layer of its own:
**flag > env > profile > the file's `run` section > built-in default** (see
[Agent profiles](#agent-profiles)).

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
`--claude-default-config`, `--claude-no-background-tasks`, `--event-webhook`
(`_EVENT_WEBHOOK`, docs/EVENT-WEBHOOK.md) and `--capture-mode`
(`ACH_CAPTURE_MODE`, the one mirror without the long prefix); the full map is `ENV_MIRRORS` in
`src/cli/config.ts`. Any other key goes straight from the file to the flag. `stateDir` follows the
same rule against `AGENTIC_CODING_HARNESS_STATE_DIR`, and so do `web.stateDir` / `web.dir` (the
`web` command reads the same env var); a command's own `--state-dir` flag still wins. `stats.dir`
is a transcript root, has no env var, and so always comes from the file. `stats.stateDir` (one path
or a list, #99) has no env mirror either; a command-line `--dir` on `stats` replaces only
`stats.dir` / `stats.transcriptDir`, never `stats.stateDir` (see [MULTI-DIR.md](MULTI-DIR.md)).

Relative paths in a file resolve against that file's directory, never the process cwd, and a
leading `~` expands to your home dir. This covers `stateDir` and every path-typed key:
`run.evidenceDir`, `run.kiroIdeUserDataDir`, `stats.dir`, `stats.transcriptDir`, `stats.stateDir`, `web.dir`,
`web.stateDir`, `serve.root` and `emit.enricher` (`PATH_FLAGS` in `src/cli/config.ts`).

Two limits of flag parsing to know:

- an on/off flag set to `true` in the file cannot be switched off from the command line (there is
  no `--no-<flag>` form); remove the key, pass `--config` with another file, or select a profile
  that sets it to `false`;
- for a repeatable flag, any occurrence on the command line replaces the file's whole list.

`--dir` and its long forms (`--state-dir`, `--transcript-dir`) count as one flag here: `--dir` on the
command line beats `web.stateDir` from the file instead of tripping the "disagree" check.

Value checks (a negative `maxTurns`, an unknown `onBudget`) run in the command, exactly as for the
flag, so their message names the flag (`--max-turns expects ...`), not the file.

## Export enrichers

`ach emit` stamps custom attributes on what it exports (#95), so a team tag or a CI build id does
not have to be patched in by a collector:

```sh
ach emit --input run.json --format otel --out spans.json \
  --attr team=platform --attr environment=staging \
  --attr-env ci.build_id=BUILD_NUMBER --attr-env vcs.sha=GIT_COMMIT
```

or once in the config file:

```json
{ "emit": { "attr": ["team=platform"], "attrEnv": ["ci.build_id=BUILD_NUMBER", "vcs.sha=GIT_COMMIT"] } }
```

- `--attr key=value` adds a static attribute (split on the first `=`, so the value may contain `=`).
- `--attr-env key=ENVVAR` reads `ENVVAR` from the environment at export time; it overrides an
  `--attr` with the same key. An unset or empty variable is skipped with one stderr warning, never
  exported as an empty attribute.
- Where they land: every OTel span and the OTLP resource (`--format otel`); every Langfuse span,
  including the per-model generation spans of a multi-model run (`--format langfuse`, the POSTed
  payload and the `--out` dump); the trajectory's top-level `extra.attributes` object for
  `--format atif` (ATIF has no per-step attribute field). `--format sft` has no attribute field and
  ignores them. Built-in keys (`gen_ai.*`, `langfuse.*`, `service.name`) win a clash.
- Fail open: a malformed entry (`--attr noequals`) or a missing env var prints a warning and is
  skipped; the export itself never fails because of an enricher.
- Precedence follows the repeatable-flag rule above: any `--attr` on the command line replaces the
  file's whole `emit.attr` list (and `--attr-env` the `emit.attrEnv` list); the other list still
  comes from the file.
- MCP: `harness_emit` takes a static `attributes` object (`{"team": "platform"}`). It has no env
  mapping and no enricher module on purpose: a client-chosen env var name plus a client-chosen
  output would let any MCP client read the server's environment, and a module path would let it
  run local code. An `enricher` argument is ignored with a warning. Non-string values are skipped
  and listed in the result's `warnings`.
- `--enricher <path>` (or `emit.enricher` in the file) loads a user JS module for dynamic
  attributes. Opt-in only, and never accepted over MCP. A relative flag value resolves against the
  cwd; a relative file value against the config file's directory, like the other path keys. The
  module's default export is called with span-like info and returns an attributes object, sync or
  async:

  ```js
  // enrich.mjs
  export default (info) => ({
    "skill.class": info.operation === "execute_tool" ? "tooling" : "reasoning",
    "ci.job": process.env.CI_JOB_ID ?? "local",
  });
  ```

  `info` is `{ kind, name, operation, attributes, startTimeMs, endTimeMs, run: { format, sessionId,
  agent, model } }`. For OTel and Langfuse it is called once per span (`kind: "span"`,
  `attributes` is a copy of the span's built-in attributes), and the result lands on that span.
  For ATIF it is called once (`kind: "trajectory"`), and the result is merged into
  `extra.attributes`. The module can only add attributes: built-in keys still win, and values
  that are not strings, numbers or booleans are dropped. Fail open: a load failure, a missing
  default export, a throw, a non-object return or an async call that runs over 5 s
  (`ENRICHER_TIMEOUT_MS`) prints one warning. The enricher then stops for the rest of that
  export, and the export continues without it. It runs with your own permissions, the same trust
  as a queue hook or a checker command; only point it at code you trust.

Every other `ach emit` flag is also a valid `emit.*` key. `emit.langfuseSecretKey` works but puts a
secret in a plain file; prefer the `LANGFUSE_SECRET_KEY` env var.

## `ach config`

```text
ach config --show [<section>] [--json] [-- <section flags>]
ach config --set <key> <value> [--dry-run] [--json]
ach config --unset <key> [--dry-run] [--json]
ach config --schema
ach config --set profiles.<name>.<key> <value>      # or profiles.<name>.<key>=<value>
ach config --set profiles.<name>.env.<NAME> <value>
ach config --unset profiles.<name>[.<key>|.env[.<NAME>]]
ach config --set contentCapture.default <full|metadata|off>
ach config --set contentCapture.agents.<agent> <full|metadata|off>
ach config --unset contentCapture[.default|.agents.<agent>]
ach profiles list [--json]
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

## Agent profiles

A profile is a named set of `ach run` flags (#77), so a whole setup is one word:

```json
{
  "profiles": {
    "fast": { "agent": "claude", "model": "sonnet", "budgetUsd": 1, "maxTurns": 20 },
    "kiro-dev": {
      "agent": "kiro",
      "kiroAgent": "dev",
      "kiroTools": "all",
      "extraArg": ["--trust-all-tools"],
      "env": { "MY_TOOL_MODE": "ci" }
    }
  }
}
```

```sh
ach run --profile fast "fix the failing test"
# same invocation as
ach run --agent claude --model sonnet --budget-usd 1 --max-turns 20 "fix the failing test"
```

- **Keys** are exactly the `run` section's keys (every long flag of `ach run` in camelCase, taken
  from its flag table, so a new run flag is a profile key with no profile-specific change), plus
  `env`. Values are checked exactly like the `run` section. `profile` is not a profile key: a
  profile cannot select another profile. Names match `[A-Za-z0-9_][A-Za-z0-9_-]*` (no dots, so
  `profiles.<name>.<key>` stays unambiguous).
- **Precedence**: flag > `AGENTIC_CODING_HARNESS_*` env > profile > the file's `run` section >
  built-in default, per key. `ach run --profile fast --budget-usd 7` runs with 7 whatever the
  profile says. A profile's on/off `false` means "not set", and it also hides a `true` for the
  same key in the file's `run` section.
- **Default profile**: `"run": { "profile": "fast" }` selects `fast` whenever `--profile` is not
  given; `--profile other` on the command line wins.
- **Merging**: the user and project files merge per profile key, like sections: the project
  file's `profiles.fast.model` overrides the user file's, and keys only the user file sets still
  apply. Relative paths (`evidenceDir`, `kiroIdeUserDataDir`) resolve against the file that set
  them.
- **Unknown name**: `ach run --profile nope` is a usage error, exit `1`, that lists the defined
  names: `unknown profile 'nope' (available: fast, kiro-dev)`.
- **`env`**: a map of `NAME: "value"` strings, set on the agent's child process only (not on `ach`
  itself, and not on `--verify` commands). Adapters that do not spawn a child CLI (`kiro-ide`,
  `null`) ignore it and `ach run` warns. The config file is plaintext and is often committed:
  **do not put secrets in a profile's `env`** (or in an inline `mcpConfig` /
  `kiroMcpServer` JSON). Export the secret in your shell or a secret manager instead; the agent
  inherits it from `ach`'s own environment.

### Saving: `ach config --set profiles.<name>.<key>`

`--set profiles.fast.budgetUsd 1` (or `--set profiles.fast.budgetUsd=1`) creates the profile and
the key; `--set profiles.fast.env.MY_TOOL_MODE ci` sets one env entry. `--unset` takes a key, an
env entry, a profile's whole `env`, a whole profile or `profiles`, and drops what it leaves empty.

The edited profile, merged across files, is checked as a whole before anything is written (also
under `--dry-run`): once it has an `agent`, the same adapter check `ach run` does before launch
runs on it, so an illegal flag combination is rejected at save time with the run-time message:

```text
harness: config --set profiles.k.kiroMcpServer: profile 'k' not saved: agent "kiro" profile validation failed: kiro.mcpServers.1.name: duplicate MCP server name 'a'
```

`ach config --show run -- --profile fast` previews a profiled run; keys from the profile show
source `profile:fast`.

### Listing: `ach profiles list`

Prints each profile with the `ach run` flags it expands to, plus the names (never the values) of
its env entries:

```text
fast      ach run --agent=claude --model=sonnet --budget-usd=1 --max-turns=20
kiro-dev  ach run --agent=kiro --extra-arg=--trust-all-tools --kiro-agent=dev --kiro-tools=all
          env (agent process only): MY_TOOL_MODE
```

`--json` prints `{ profiles: [{name, flags, argv, envKeys, files}] }`.

### What the RunRecord keeps

A run with a profile records `profile` on its RunRecord (`<stateDir>/runs/<runId>.json`):

| Field | Holds |
|---|---|
| `name` | the profile name |
| `expanded` | every effective `run` option, keyed by flag name, from any layer (flag, env, profile, file) |
| `sources` | where each `expanded` value came from: `flag`, `env:<NAME>`, `profile:<name>`, `file:<path>` |
| `argv` | `expanded` as `ach run` flags: `ach run <argv...> "<prompt>"` re-runs the same invocation with no profile and no config file |
| `overridden` | profile values an explicit flag or env var beat, e.g. `{"budget-usd": 5}` when `--budget-usd 7` won |
| `envKeys` | the profile's env names, never their values |
| `redacted` | flags whose inline JSON value was replaced by `<inline JSON, N bytes>` (`mcp-config`, `kiro-mcp-server`; a file path is kept) |

The prompt is not part of `profile` (the record keeps only a `promptPreview`), so pass it again.
To re-run byte for byte, set the `envKeys` in the environment and pass the original inline MCP JSON
if `redacted` lists one. Records written before profiles existed have no `profile` field and load
as before.

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

## `ach init` (first-run setup)

```text
ach init [--agent A] [--model M] [--budget-usd N] [--max-turns N] [--yes] [--dry-run] [--show] [--project]
```

`ach init` populates this config file (it does not invent a second format). It writes four keys of
the `run` section, through the same key machinery as `ach config --set`:

| Choice | Config key |
|---|---|
| default agent | `run.agent` |
| default model (blank = none) | `run.model` |
| budget cap in USD | `run.budgetUsd` |
| max turns | `run.maxTurns` |

Because those are ordinary `run` keys, a later `ach run "..."` with no flags uses them (flag > env >
file > default still applies).

- **Target file**: the user file (`~/.config/agentic-coding-harness/config.json`) by default;
  `--project` writes `./.ach/config.json`; `--config <file>` (or `AGENTIC_CODING_HARNESS_CONFIG`)
  writes that file. `--project` together with a pinned file is an error.
- **Detection**: the agent CLIs (claude, codex, gemini, agy, opencode, copilot, cursor, prime, kiro) are
  looked up on `PATH` and listed as found / missing with the install hint.
- **Doctor step**: the chosen agent goes through the same checks as `ach doctor --agent A`, printed to
  stderr. A failed `binary`, `version` or `cdp` row (the agent is not installed or will not start)
  prints the install hint, writes nothing and exits `1`. Other failures (no credential yet, an
  unverifiable model) are shown as a warning but do not block: you can sign in afterwards.
- **Interactive**: only when stdin AND stdout are terminals and `--yes` is absent. It lists what it
  found, then asks for the agent, model, budget, max turns and a final confirmation. A blank answer keeps
  the value shown in brackets (the existing config, or the first detected agent); `none` clears a
  model, budget or max turns.
- **Non-interactive** (piped stdin, CI, images): never prompts. `--yes` or `--agent` proceeds; with
  neither it prints what it would write and exits `1` with a hint to pass `--yes`. With no `--agent`
  the first detected agent is used; none installed is an error.
- **Idempotent**: re-running overwrites the same keys in place. Flags you leave out keep the existing
  value; other sections and keys are untouched; there are no duplicate keys or stale sections.
- `--dry-run` prints the config JSON on stdout and writes nothing (with a missing binary it still prints
  the JSON but exits `1`, like the real run would). `--show` prints the current config file(s) and exits `0`.
- After writing, it prints a quickstart: one `ach run`, one `ach dash`, one `ach web`.
