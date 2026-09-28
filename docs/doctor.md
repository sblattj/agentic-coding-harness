# `ach doctor`

`ach doctor` checks every adapter's environment and the harness's own config.
It sends no prompt and spends no tokens. Run it before a benchmark so a missing
binary or a broken credential turns up at diagnosis time and not twenty minutes
into a run.

```
ach doctor [--agent A] [--model M] [--cwd DIR] [--claude-default-config] [--json]
```

With no `--agent` it checks all five adapters (claude, opencode, kiro, codex,
gemini). `--model` needs `--agent` because a model belongs to one adapter.
The exit code is 0 when no check failed and 1 when any check failed. An
`unproven` check does not fail the run.

Implementation: `src/cli/doctor.ts` (`runDoctor`, `formatDoctorTable`, `cmdDoctor`).

## Statuses and depth

Every check is `verified`, `failed`, or `unproven`, the same vocabulary as
`ach preflight --agent kiro`. Every `failed` check carries a `hint`.

| depth | meaning |
|---|---|
| `deep` | Observed over a real protocol exchange. Only kiro has one: doctor runs the same ACP handshake as `ach preflight --agent kiro` (initialize, then session/new, then session/set_model when `--model` is given, and never session/prompt). |
| `shallow` | Local evidence only: the binary ran `--version`, credential material is present and well-formed, config files parse, MCP stdio commands resolve on PATH. A shallow `verified` never claims that the vendor accepted the credential or that an MCP server starts. |

## Checks

| agent | check | what is proven |
|---|---|---|
| all | `binary`, `version` | The command resolves on `PATH` (kiro: `KIRO_CLI_BIN` or `kiro-cli`) and `--version` exits 0. The version is parsed from its output. |
| claude | `auth` | `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` / `CLAUDE_CODE_OAUTH_TOKEN` is present and well-formed. Without one, runs use a fresh per-run `CLAUDE_CONFIG_DIR` that cannot see a `/login` session, so the check **fails**. With `--claude-default-config` it looks for `~/.claude/.credentials.json`. A keychain-only login is `unproven` because it cannot be checked offline. |
| codex | `auth` | `OPENAI_API_KEY`, or `$CODEX_HOME/auth.json` (default `~/.codex`) parses. |
| gemini | `auth` | `GEMINI_API_KEY` / `GOOGLE_API_KEY`, or a `GOOGLE_APPLICATION_CREDENTIALS` file that exists, or `~/.gemini/oauth_creds.json`, or gcloud ADC. |
| opencode | `auth` | A provider key in env, or `$XDG_DATA_HOME/opencode/auth.json` (provider names are listed, keys are not). With neither, the check is `unproven` because opencode can run keyless or local providers. |
| kiro | `auth` | `kiro-cli whoami` succeeds (deep). Identities are masked. |
| any | `auth` (broken env) | A credential variable that is set but empty, contains whitespace, or is wrapped in quotes fails, even when other credential material exists. The other checks still report. |
| all | `model` | Without `--model`: `unproven`. claude/codex/gemini: the model must belong to the adapter's family (`claude-*` or a Claude Code alias such as `sonnet`; `gpt-*`/`o*`/`codex-*`; `gemini-*`), otherwise it **fails**. opencode needs `provider/model`. A model that is missing from the pricing table is `unproven`, because run cost would show as n/a. kiro: checked against the handshake's `availableModels` (deep). |
| all | `mcp` | claude reads `<cwd>/.mcp.json`, plus `~/.claude.json` in default-config mode. gemini reads `~/.gemini/settings.json` and `<cwd>/.gemini/settings.json`. opencode reads `opencode.json[c]` in `$XDG_CONFIG_HOME/opencode` and `<cwd>`. codex does a line scan of `[mcp_servers.*]` in `config.toml`, which is not a full TOML parse. An unparseable file, or a stdio server whose command is not on PATH, **fails**. Remote URLs are not contacted. kiro: the handshake's MCP notices. |
| harness | `stateDir` | The state dir (`AGENTIC_CODING_HARNESS_STATE_DIR`) can be created, and a probe file can be written and removed. |
| harness | `pricing` | The price table loads and prices the flagships. The detail says whether the bundled LiteLLM extract is present. |
| harness | `env` | `AGENTIC_CODING_HARNESS_*` numeric and enum variables parse. An unknown name is flagged `unproven` as a possible typo. Token values are never printed. |

## agents.d descriptors (#38)

`ach doctor` also diagnoses every loaded [agents.d descriptor](CUSTOM-AGENTS.md),
not just the five built-in AGENTS. Its checks are additive to the ones above;
in `--json` output each descriptor-sourced check carries `"source": "agents.d"`
so scripts can tell it apart from a built-in check with the same `name`.

| check | what is proven |
|---|---|
| `descriptor` | The file parsed as JSON and validated against the descriptor schema (zod). An invalid descriptor (bad JSON, an unknown field, a missing tap path, …) never aborts doctor: it becomes a `failed` check under `agent: "harness"` with the zod issue in `detail`, and every other descriptor is still checked. |
| `binary` | For a descriptor with a `launch` block: the first argv element of `launch.template` (or `/bin/sh` when `launch.shell` is set) resolves on `PATH`. Skipped for a meter-only descriptor (`launch: null`). |
| `auth` | Always `unproven`: a descriptor supplies no offline authentication probe. |
| `usageTap` | For a descriptor with a `usageTap` block: whether the configured transcript path (file or directory) exists. |

## Not proven, by design

- Whether a vendor accepts a credential. For claude, codex, gemini, and
  opencode that takes a network call. Their CLIs have no prompt-free auth
  handshake the harness can drive.
- Whether an MCP server starts, except where kiro reports startup failures
  over ACP.
- Whether a task will succeed.
