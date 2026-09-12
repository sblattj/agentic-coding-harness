# Kiro adapter

How `agent-harness` drives `kiro-cli`, what it can *prove* about the configuration a run used,
and what it can and cannot tell you about usage. Everything below was measured against
**kiro-cli 2.21.2** (engine v2, API-key auth) on 2026-09-12; fixtures under `tests/fixtures/kiro/`
are sanitized captures from that binary, and the automated tests run only against those fixtures
and a fake ACP server (`tests/fixtures/kiro/fake-acp-server.ts`). No test spends credits.

## Two transports

| | `headless` (default) | `acp` |
|---|---|---|
| Command | `kiro-cli chat --no-interactive --output-format stream-json --agent-engine v2 [--model M] [--agent A] [--effort E] [--trust-tools …]` | `kiro-cli acp [--agent A] [--model M] [--effort E] [--trust-tools …] [--agent-engine …]` |
| Wire | stream-json envelopes on stdout | newline-delimited JSON-RPC on stdio |
| Model request | `--model` is forwarded; on 2.21.2 it is **accepted and ignored** (`[warn] failed to set model 'X': Method not found`, session store records `auto`) → `modelAck: unsupported`. A CLI that stays silent leaves it `unverified` | `initialize → session/new → session/set_model`; the ack (or its error) is recorded → `modelAck: acknowledged` / `rejected` |
| Agent / effort / tools forwarding | forwarded as flags (`--agent`, `--effort`, `--trust-tools=…`); **not verified** — the chat transport never echoes them | forwarded as flags; mode verified from `session/new.modes` |
| Native session id | sniffed from the first envelope carrying `data.sessionId` (`runStarted`) | `session/new` result |
| What `result.kiro` reports | `{ cliVersion, transport: 'headless', requested, effective: { argv, trustFlag, … }, nativeSessionId, modelAck, configHash }` | `{ cliVersion, transport: 'acp', requested, effective, nativeSessionId, modelAck, configHash }` |

Pick the ACP lane when you need the run to *prove* which agent and model it used. The headless
lane forwards the same configuration and records exactly what it passed (the argv, minus the
prompt, is part of `effective` and of `configHash`), but on 2.21.2 it can only prove a model
request was *refused*, never that one was honored. The MITM credit tap auto-starts on the headless
lane only.

### Verified configuration (`modelAck`)

`modelAck` is one of:

- `acknowledged` — `session/set_model` replied `{}` and `session/new` (or the ack) named the model.
- `rejected` — the agent answered the request with an error; the run fails before prompting when
  `kiro.requireModelAck` is set.
- `unsupported` — the CLI printed the *Method not found* warning (headless lane) or does not
  expose `set_model`.
- `unverified` — a model was requested on the headless lane and the CLI said nothing either way.
  The flag was passed; whether it took effect is unknown (check the session store's model).
- `not-requested` — no `--model` was given; `effective.model` is whatever `session/new` reported
  (`auto` on a fresh session).

`configHash` is a stable hash of the sanitized `effective` object so two runs can be compared for
"same configuration" without diffing artifacts. Credentials are never copied into `effective`.

## Running

CLI:

```sh
harness run --agent kiro --kiro-transport acp --kiro-agent dotai \
  --model claude-haiku-4.5 --json "list the files in this directory"

harness run --agent kiro --kiro-transport acp --kiro-agent dotai \
  --kiro-effort high --kiro-tools read,fs_read --kiro-require-mcp-startup "…"
```

| Flag | `kiro` config key | Values |
|---|---|---|
| `--kiro-transport` | `transport` | `headless` (default), `acp` |
| `--kiro-agent` | `agent` | native agent name (a *mode* over ACP) |
| `--kiro-engine` | `engine` | `v1`, `v2`, `v3` |
| `--kiro-effort` | `effort` | `low`, `medium`, `high`, `xhigh`, `max` |
| `--kiro-tools` | `tools` | `all`, `none`, or a comma list |
| `--kiro-require-mcp-startup` | `requireMcpStartup` | boolean; fail the run if MCP startup reports an error |
| `--kiro-startup-ms` | `startupMs` | positive integer ms; startup/handshake budget (default 60 000) |
| `--kiro-require-model-ack` | `requireModelAck` | boolean; ACP: fail before prompting if `set_model` is not acknowledged |
| `--kiro-mcp-server` | `mcpServers` (append) | ACP only: repeatable, one JSON object per server — `{name, command, args?, env?}` |

`tools` unset means **no trust flag is passed at all** on either lane; the native agent config
decides. There is no implicit `--trust-all-tools` anywhere (0.3.x passed it unconditionally on
the headless lane). Every `KiroConfig` key now has a CLI flag; for example:

```sh
harness run --agent kiro --kiro-transport acp --kiro-agent dotai \
  --kiro-mcp-server '{"name":"fs","command":"npx","args":["-y","@modelcontextprotocol/server-filesystem","."]}' \
  "…"
```

MCP (`harness_run` / `harness_run_async`):

```json
{ "agent": "kiro", "model": "claude-haiku-4.5", "prompt": "…",
  "kiro": { "transport": "acp", "agent": "dotai", "requireModelAck": true } }
```

Library: `RunSpec.kiro` takes the same object, validated by `KiroConfigSchema`
(`src/core/types.ts`).

### Preflight — prove the setup without spending a prompt

```sh
harness preflight --agent kiro --kiro-transport acp --kiro-agent dotai --model claude-haiku-4.5 --json
```

or the MCP tool `harness_kiro_preflight`. It runs a real ACP handshake and reports, per check,
`verified` / `failed` / `unproven`: binary + version, auth, native agent exists (mode listed by
`session/new`), model exists + `set_model` ack, MCP / governance state. It sends **no**
`session/prompt`. Exit code is 0 only when nothing failed. The
`_kiro.dev/mcp/governance_disabled` notification appears on healthy sessions and is not treated
as an MCP failure.

### ACP traps (recorded so you do not rediscover them)

- `initialize` returns **nothing** unless the request carries `clientInfo` and
  `clientCapabilities.terminal`. A silent initialize is a client bug, not a hung agent.
- Initialize took 15–23 s locally (profile lookup retries), so the startup deadline defaults to
  60 s (`kiro.startupMs`), and a timeout names the failing phase (`spawn`, `initialize`, `session/new`,
  `session/set_model`, `mcp`, `session/prompt`).
- Never pass `-v`; it logs to stdout and corrupts the JSON-RPC stream.
- `session/prompt` resolves with `{stopReason}`; the harness surfaces it as the native stop reason.
- Agent→client requests (permissions, fs, terminal) are answered by policy — permissions are
  denied — and recorded as events; the harness never broadens them.

## Usage: what is real on 2.21.2

| Signal | Available? | Where it comes from |
|---|---|---|
| credits | **yes** | stream `metadata.meteringUsage[].value` (cumulative) > session store `metering_usage` > MITM tap `meteringEvent.credits`; reconciled to one charge, disagreements become a warning |
| context tokens | **derived** | `contextUsagePercentage × context_window_tokens` (200 000 on 2.21.2); shown as `ctx ≈ N tok`, never billed |
| input / output / cache tokens | **no** | every token field in the tap, the stream and the session store is `0`; the harness reports `tokens.available = false` and renders `n/a` |
| USD | **no** | nothing maps credits to dollars; `--budget-usd` on a kiro run warns that the cap is unenforceable |

The rule is: a `0` that cannot be distinguished from "not reported" is never shown as `0`.
Details and the fixture-backed source table are in
[TOKEN-COUNTING.md](TOKEN-COUNTING.md#kiro-on-221x--no-source-carries-a-token-count).

`result.usage` carries `{ tokens, credits, usd, context }`, each with `available`, `source`,
`scope`, `cumulative`, `complete` (`UsageAvailability` in `src/core/types.ts`). The run registry,
`harness dash`, and the HTML report read the same object.

## Limitations in this release

- **The headless lane forwards configuration but cannot verify it.** `--agent`, `--effort` and
  `--trust-tools` are passed and recorded in `result.kiro.effective.argv`, and `modelAck` is
  `unsupported` on 2.21.2 or `unverified` when the CLI is silent; only the ACP lane returns
  `acknowledged`. Use `--kiro-transport acp` (or `harness preflight`) when the claim matters.
- When the MITM tap and the stream both observe a charge, the run reports both (`sources.stream`,
  `sources.tap`) and keeps the native figure as the total; a disagreement between them raises a
  warning instead of being silently summed.
- The `kiro-cli --version` probe is capped at 3 s (`KIRO_VERSION_PROBE_MS`); a binary that hangs
  on `--version` reports `cliVersion: 'unknown'` and the run proceeds.
- `--trust-tools` on 2.21.2 did **not** block a `read` and no `session/request_permission`
  arrived, so a tool restriction is recorded per tool from evidence, never asserted from the flag.
- Fixtures are 2.21.2. The 2.21.4 sample in issue #2 uses the same envelope family; the
  compatibility check is the `kiro-cli --version` line in `result.kiro.cliVersion`.
- No paid calibration test ships yet; `tests/` is fixture-only.
