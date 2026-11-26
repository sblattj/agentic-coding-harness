# Effort: one `--effort` across every agent

`ach run --effort <level>`, `ach trial --effort <level>`, a matrix plan's `effort`
key and the `effort` parameter of the `harness_run` / `harness_run_async` MCP tools
all take one portable reasoning-effort level:

```
low | medium | high | xhigh | max
```

The harness maps the level onto each agent's own mechanism through ONE table,
`EFFORT_TABLE` in `src/core/effort.ts`. The driver resolves it for every entry
point (run, repeat, trial cells, MCP sync and async), so they all record the
same provenance.

```sh
ach run --agent codex --effort high "refactor the parser"
ach run --agent cursor --model gpt-5 --effort max "..."
ach trial --suite core --agent claude --agent codex --effort low
```

## The mapping table

Every row was read from the installed CLI's own `--help`. A level the CLI does not
accept would be sent as the nearest supported level (ties go higher) with a run
warning. claude, codex, agy, copilot and kiro list all five levels in their help, so
no level is changed for them. opencode and cursor get the level verbatim: whether a
given model or provider accepts it is up to that model (opencode calls `--variant`
provider-specific; cursor documents the bracket override for parameterized models).

| Agent | What the harness passes | `mechanism` recorded | Help line it relies on |
|---|---|---|---|
| `claude` | `--effort <level>` | `--effort` | claude 2.1.x: `--effort <level>  Effort level for the current session (low, medium, high, xhigh, max)` |
| `codex` | `-c model_reasoning_effort=<level>` | `-c model_reasoning_effort=<level>` | `codex exec --help`: `-c, --config <key=value>  Override a configuration value that would otherwise be loaded from ~/.codex/config.toml`; `codex debug models` lists the supported reasoning levels low..max |
| `agy` | `--effort <level>` | `--effort` | agy 1.5.x: `--effort  Reasoning effort for the current CLI session (low\|medium\|high\|xhigh\|max)` |
| `copilot` | `--reasoning-effort <level>` | `--reasoning-effort` | copilot 1.0.x: `--reasoning-effort <level>  Set the reasoning effort level [possible values: none, minimal, low, medium, high, xhigh, max]` |
| `opencode` | `--variant <level>` | `--variant` | `opencode run --help`: `--variant  model variant (provider-specific reasoning effort, e.g., high, max, minimal)` |
| `cursor` | `--model <model>[effort=<level>]` | `model-suffix` | cursor-agent: `--model <model> ... Parameterized models accept quoted bracket overrides, e.g. 'claude-opus-4-8[context=1m,effort=high,fast=false]'` |
| `kiro` (headless) | `--effort <level>` (sets `kiro.effort`, the field `--kiro-effort` fills) | `--effort` | `kiro-cli chat --help`: `--effort <EFFORT>  Initial effort level (e.g. low, medium, high, xhigh, max)` |
| `kiro` (ACP, engine v1/v2) | `--effort <level>` on `kiro-cli acp` | `--effort` | same flag |
| `kiro` (ACP, engine v3) | the `effortLevel` session config option over ACP (v3 rejects `--effort` on argv, see [KIRO.md](KIRO.md)) | `acp:effortLevel` | |
| `gemini` | nothing | `none` | `gemini --help` has no effort, reasoning or thinking flag |
| `prime`, `kiro-ide`, `null`, `custom`, agents.d descriptors | nothing | `none` | no native control |

Notes:

- **Cursor** changes only the `--model` argv value. The spec's model (pricing,
  `usage.model.requested`) stays the plain name you asked for. An existing bracket
  gets `effort=` merged in (`m[context=1m]` becomes `m[context=1m,effort=high]`).
  Without `--model` there is no slug to carry it, so the run records `applied: false`
  with a warning. A slug that already names `effort=` is left alone (also `applied: false`).
- **opencode** on the serve path (`preferServer`) takes no extra argv, so it records
  `applied: false`.
- **Kiro**: `--kiro-effort` keeps working and produces the same argv as
  `--effort`. Passing both with different values is a usage error; equal values are fine.
  Without `--effort`, kiro's argv is byte-for-byte what it was before.
- **An explicit native flag wins.** If `--extra-args` already sets the agent's own flag
  (`--effort`, `-c model_reasoning_effort=...`, `--reasoning-effort`, `--variant`), the
  harness does not add its own, records `applied: false` and warns.

## Agents without a mechanism

The run still happens. It records `applied: false, mechanism: "none"` and carries a
run warning naming the agent, for example:

```
[warn] effort: gemini has no native effort control; --effort high was not applied (recorded applied:false, mechanism none)
```

## What is recorded

Every run with `--effort` gets, on the RunResult and the persisted RunRecord:

```json
"effort": { "requested": "high", "applied": true, "mechanism": "--effort" }
```

plus `level` when a clamp changed what was sent. It also fills
`usage.model.requestedEffort` (when the agent reports no model block, the block is
`{ "source": "unknown", "requestedEffort": "high" }`). `applied` means the harness
handed the level to the CLI natively; whether the model actually ran at it is what
`usage.model.observedEffort` and `effortMismatch` report where the agent records it
(codex rollouts today). Runs without `--effort` carry no `effort` key.

## Trials

A matrix plan may set `"effort": "<level>"` for every cell; `ach trial --effort`
overrides it, for `--matrix` and `--suite`. Effort is **not** part of the cellId, so
re-running the same plan at another level skips cells the ledger already finalized:
use a new `--ledger` path (or a new `experiment`) to compare levels.

## MCP

`harness_run` and `harness_run_async` take a top-level `effort` (same enum) that goes
through the same table. The nested `kiro.effort` keeps working for kiro.
