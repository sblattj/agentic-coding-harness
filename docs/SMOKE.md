# Smoke the instructions: `ach smoke`

Before you send someone setup or how-to steps, `ach smoke` runs those exact steps as a
brand-new user would. It records every place the reader would get stuck, fixes the message
where it can, reruns the fixed steps, and hands you the revised message and a friction table
(agentic-coding-harness#139).

```
ach smoke <message-file> [--account EMAIL] [--agent A=claude] [--cdp URL] [--no-browser]
          [--stub SPEC]... [--block-host HOST]... [--allow-path DIR]... [--timeout SECS=300]
          [--no-fix] [--fix-agent A] [--fix-tool REPO] [--out DIR] [--copy]
          [--format text|markdown] [--json] [--keep] [--no-keychain]
```

## The flow

| # | step | what happens | flags |
|---|---|---|---|
| 1 | input | The message (markdown) is parsed into literal steps (see [Message format](#message-format)). | `<message-file>` |
| 2 | fresh user | A sandbox gets its own `HOME`, config dirs, `TMPDIR`, a minimal `PATH` and its own empty keychain. It does not need a new OS account. | `--allow-path`, `--no-keychain`, `--keep` |
| 3 | literal run | Each step runs exactly as written, in one terminal session, so `cd`, `export` and `~/.zshrc` edits carry over to later steps. Anything the reader would trip on becomes a friction row. | `--timeout` |
| 4 | browser auth | OAuth, SSO and device-code steps are completed in your real browser over CDP, in a new background tab, under an account guard. | `--account`, `--cdp`, `--no-browser` |
| 5 | fake side effects | Ticketing and other write integrations point at local stubs, so nothing real is created. | `--stub`, `--block-host` |
| 6 | per-step record | Each step records status, time, tokens (prompt steps), prompts and denials, and friction. | |
| 7 | fix in place | Missing installs, policy-blocked logins and confirm prompts are patched in the message. A lying tool can be patched with an agent. The failing step is then rerun in the same sandbox. | `--no-fix`, `--fix-agent`, `--fix-tool` |
| 8 | output | The friction table, then details, then the revised message written to `<name>.smoked.md`. With `--copy` the revised message is also copied as rich text. | `--out`, `--copy`, `--format`, `--json` |

## Message format

A step comes from:

- **Shell fences**: ` ```sh `, `bash`, `zsh`, `shell`. Each logical command is one step. `\`
  continuations and heredocs are folded into the step they belong to. In `console` / `terminal`
  fences only `$ ` and `% ` lines are commands; the other lines are sample output.
- **`$ ` lines** and **single-backtick lines** (`` `npm test` `` alone on a line) outside fences.
- **` ```prompt `** (or `agent`) fences. The whole body is one prompt the reader types into an
  agent CLI. It runs as `ach run --agent <agent> --json <prompt>` inside the sandbox, so the agent
  CLI must be installed by the message or found through `--allow-path`.
- **` ```open `** fences, and lines like "Open https://…" with exactly one URL. If the URL is an
  auth page it is driven through browser auth; otherwise it is recorded as `skipped`.

json, yaml, text and bare fences are illustrations and do not produce steps.

Fence attributes override the matching flag for the steps in that fence:

```sh account=me@example.com timeout=120
az login --use-device-code
```

| attr | overrides | meaning |
|---|---|---|
| `account=` | `--account` | the account the auth step must use |
| `timeout=` | `--timeout` | seconds before the step is killed (friction `timeout`) |
| `agent=` | `--agent` | agent for a `prompt` fence |

## The sandbox

The root is `$TMPDIR/ach-smoke-XXXXXX/` and holds four directories:

- `home`: becomes `HOME`.
- `tmp`: becomes `TMPDIR`.
- `state`: harness files (`session.sh`, `opened-urls.jsonl`).
- `shims`: the `open` / `xdg-open` shims.

The environment is built from scratch, not by filtering yours. A variable nobody thought of
therefore cannot leak in. `PATH` is:

```
<shims>:~/.local/bin:~/.npm-global/bin:/usr/bin:/bin:/usr/sbin:/sbin[:--allow-path dirs]
```

`--allow-path DIR` (repeatable) appends a host directory, for example
`--allow-path "$(dirname "$(command -v node)")"` when the message assumes Node.js. Everything in
that directory becomes visible, including other global installs that live there.

Every config redirect lives in one table (`SANDBOX_CONFIG_VARS` in `src/core/smoke/sandbox.ts`).
A tool that ignores `HOME` but reads its own variable still lands in the sandbox:

| variable | value |
|---|---|
| `XDG_CONFIG_HOME` / `XDG_DATA_HOME` / `XDG_CACHE_HOME` / `XDG_STATE_HOME` | `~/.config`, `~/.local/share`, `~/.cache`, `~/.local/state` |
| `npm_config_prefix` / `npm_config_cache` / `npm_config_userconfig` | `~/.npm-global` (so `npm i -g` installs into the sandbox), `~/.npm`, `~/.npmrc` |
| `GIT_CONFIG_GLOBAL` / `GIT_CONFIG_NOSYSTEM` | `~/.gitconfig`, `1` |
| `CLAUDE_CONFIG_DIR` / `CODEX_HOME` / `GEMINI_CLI_HOME` | `~/.claude`, `~/.codex`, `~` |
| `GH_CONFIG_DIR` / `AZURE_CONFIG_DIR` / `CLOUDSDK_CONFIG` | `~/.config/gh`, `~/.azure`, `~/.config/gcloud` |
| `AWS_CONFIG_FILE` / `AWS_SHARED_CREDENTIALS_FILE` / `KUBECONFIG` / `DOCKER_CONFIG` | `~/.aws/config`, `~/.aws/credentials`, `~/.kube/config`, `~/.docker` |
| `CARGO_HOME` / `RUSTUP_HOME` / `GOPATH` / `BUN_INSTALL` / `PNPM_HOME` / `NVM_DIR` | under `~` |
| `PIP_CONFIG_FILE` / `HOMEBREW_NO_AUTO_UPDATE` | `~/.config/pip/pip.conf`, `1` |
| `BROWSER` | the `open` shim |

`--stub` adds the stub URLs and proxy variables (see [Stubs](#stubs)).

`open`, `xdg-open` and `BROWSER` are shims. They record the URL a CLI tries to open and exit 0,
so a CLI that launches "the browser" never reaches your default browser. The recorded URL is
handed to browser auth instead.

### Keychain (macOS)

Without its own keychain, every CLI that stores a token under a fresh `HOME` hangs on a host
popup ("A keychain cannot be found"). Each sandbox therefore gets its own keychain:

1. Before anything else, the host's user search list and default keychain are read with your
   real environment.
2. A fresh `~/Library/Keychains/login.keychain-db` is created under the sandbox `HOME`, with an
   empty password, unlocked, and without auto-lock. Under that `HOME` it is the default keychain
   and the whole search list. Every `security` call has a 15 s deadline, because a hang means a
   host popup.
3. At teardown the sandbox keychain is deleted. The host list and default are read again and
   restored from the snapshot only if they changed.

Measured on macOS: `security list-keychains -d user` printed the same bytes before and after a
run, and the host keychain never received the sandbox's items. The footer reports
`host keychain unchanged: yes|no`. `no` makes the exit code 1. `--no-keychain` skips steps 2 and 3.

### Reaping

Every process a step starts runs in its own process group. When a step's shell exits, its group
is killed. The exception is a step that deliberately backgrounds (`cmd &` at the end, or
`nohup`): that group stays until teardown, and the row notes it.

At teardown (normal exit, an error, Ctrl-C or SIGTERM) the harness:

- kills every tracked group with SIGTERM, then SIGKILL after 2 s;
- sweeps for escapees: processes whose environment contains `HOME=<sandbox home>` (`ps -E`),
  and processes whose current directory is under the sandbox root (`lsof`);
- deletes the root, unless `--keep`.

The footer lists the pids that were reaped.

`ps -E` prints the environment only for non-platform binaries (node, python, CLIs you
installed), not for Apple platform binaries such as `/bin/sleep`. The cwd sweep covers those.
The one gap: a platform binary that calls setsid **and** changes directory out of the sandbox
is not caught.

## Browser auth

When a step prints a device-code prompt (a device URL plus a code) or an OAuth / SSO URL, or
hands a URL to the `open` shim, the harness takes over while the CLI keeps running.

1. It connects to your real browser at `--cdp` (default `$CDP_BASE`, else
   `http://127.0.0.1:9333`). If the endpoint reports itself as Electron (an IDE such as Kiro on
   `:9222`), it refuses before creating any tab.
2. It opens a **new background tab** (`Target.createTarget`, `background: true`). It never
   reuses or navigates one of your tabs.
3. It reads only what the page **shows**: emails in the visible text and in `data-email`,
   `data-identifier`, `aria-label` and `title` attributes, plus GitHub's `user-login` meta tag.
   It never reads cookies, storage or tokens, and it never types a password.
4. **Account guard.** `--account` or the fence's `account=` names the account the step needs.
   - If the page shows other accounts and not that one, the result is `auth-wrong-account`
     and nothing is clicked.
   - If no account was given and the page shows any account, or shows a sign-in form, the
     result is `auth-needs-human`.
   - If the needed account is on an account chooser, its tile is clicked, then the consent
     button (Continue / Authorize / Allow / ...). Device codes are filled in.
5. **Policy blocks.** A page that says the flow is blocked (for example `AADSTS53003`,
   conditional access, "device code flow is blocked") gives `auth-policy-blocked`. The fix
   step rewrites the command without its device-code flag (`--use-device-code`,
   `--device-code`, `--device`, `--no-browser`, `--no-launch-browser`, `--use-device-flow`),
   which is the flow the reader will actually use, and reruns it.
6. Whatever the result, the tab is closed (`Target.closeTarget`). If the result is not
   `completed`, the step's process group is killed at once, so no login process is left
   prompting.

When the harness hands an auth step back to you (`auth-wrong-account` or `auth-needs-human`),
the output prints a one-line login script under "login scripts". For example:

```
login scripts (run these yourself):
  step 1: printf '%s\n' 'Sign in to c@example.com in your browser, then run:' 'livelogin'
```

`--no-browser` never touches the browser. Every auth step becomes `auth-needs-human` with a
login script.

## Stubs

`--stub` points outward write integrations at local servers, so the run creates nothing real.
Every request a stub receives becomes a `side-effect-stubbed` row on the step that made it,
matched by the step's time window. A request that arrives after its step has finished (from a
background process) goes on the last step that ended before it, and the row says so.

| spec | effect |
|---|---|
| `jira=JIRA_BASE_URL` | A local server on `127.0.0.1:<port>`, exported as `JIRA_BASE_URL`. It answers like Jira: `POST /rest/api/{2,3}/issue` returns `201 {key: "STUB-n"}`. |
| `github=GH_API` / `linear=…` / `slack=…` | Same for the GitHub, Linear and Slack presets. Any other name gets the generic preset (`201 {id}` for writes). |
| `slack` (bare preset) | Exported as `SLACK_BASE_URL`. |
| `host:*.atlassian.net` | A forward proxy (`HTTP(S)_PROXY`). A CONNECT to a matching host is refused with 403, so nothing leaves the machine. Other hosts are tunnelled untouched, so package installs keep working. TLS is never intercepted. |
| `--block-host HOST` | Same as `host:` without a preset. |

`side-effect-stubbed` rows are information, not failures: they do not change the exit code.

## Fix in place

When a step has friction, it is fixed and rerun right away, before the next step. Later steps
therefore see the fixed environment, the same one a reader of the revised message would have.

- **Deterministic rules** (`src/core/smoke/fix.ts`):
  - `missing-prereq` inserts the known install before the fence that first needs the tool.
    Dependency chains are inserted in order, for example node, then `npm i -g ...`.
  - `auth-policy-blocked` swaps in the browser-flow command.
  - A confirm prompt gets the tool's non-interactive flag (`npx --yes`, `npm init -y`,
    `apt -y`, `NONINTERACTIVE=1`).
  - **Tool lies** are checked on every step, passing ones included, because a lying health
    check exits 0. A line claiming a known binary is present ("✓ claude found") while
    `command -v` in the reader's next terminal cannot find it becomes a `tool-lied` row, and
    the missing install is inserted.
- **Agent fix**: `--fix-agent A`. For friction no rule covers (unknown failures, wrong flags,
  unstated assumptions), agent A runs on the host through `ach run`. It replies with the
  replacement step, which is applied and rerun.
- **Tool fix**: `--fix-tool REPO`. When a tool lied, an agent patches the tool's git checkout so
  it reports the truth, and adds a test. Passing `--fix-tool` is your consent for that agent to
  edit files: it runs with `--permission-mode dontAsk`. It never commits or pushes; the table
  shows its `git diff --stat`.
- **Host-level installs are never executed.** These are recorded as fixes in the revised message
  but not run:
  - sudo, brew, and the Homebrew installer (they write the shared `/opt/homebrew`);
  - xcode-select, softwareupdate, installer;
  - system package managers and launchctl;
  - any write under `/usr/local`, `/opt`, `/etc`, `/Library`, `/Applications` or `/System`.

  Such a fix shows `[host-level, not run]` and `rerunPassed: not rerun`. Installs that depend on
  it show `[not run: needs a host-level install]`. To exercise the step anyway, install the tool
  yourself and pass `--allow-path <its bin dir>`. An **original** step of that kind is not run
  either: it is recorded as `skipped` with a `denied` row, so the run does not come out green.
  Installs that stay inside the sandbox do run: `npm i -g` (sandbox prefix), and `curl … | sh`
  installers that write into `$HOME` (uv, bun).
- Rows labelled `N fix` are the installs that ran. `N rerun` is the step run again (attempt 2).
  The original row turns `fixed` when its rerun passes with no friction.

`--no-fix` records the friction only.

## Output

The text table (`--format markdown` prints a markdown table):

```
#        step                                              status  time  tokens  prompts/denials  friction             fix
-------  ------------------------------------------------  ------  ----  ------  ---------------  -------------------  ---
1        npm i -g cowsay                                   pass    1.2s  -       0
2        cowsay hello                                      pass    0.2s  -       0
3        jq --version                                      pass    0.0s  -       0
4        pnpm --version                                    fixed   0.0s  -       0                missing-prereq       instructions: pnpm is not installed and the instructions never install it… (message:L17)
4 fix    npm i -g pnpm                                     pass    1.2s  -       0
4 rerun  pnpm --version                                    pass    0.5s  -       0
5        gh auth status                                    fail    0.0s  -       0                missing-prereq       instructions: [host-level, not run] brew is needed to install gh and is n… (message:L17) (+1 more)
6        curl -s -X POST -H 'content-type: application/j…  pass    0.0s  -       0                side-effect-stubbed

steps: 6 (pass 4, fail 1, fixed 1, skipped 0)
total time: 3.1s, total tokens: 0
host keychain unchanged: yes
reaped pids: 0
stubbed requests: 1
```

| column | meaning |
|---|---|
| `#` | message step; `N fix` an install the fix ran, `N rerun` the rerun |
| `status` | `pass`, `fail`, `fixed` (failed, then its rerun passed), `skipped` (open URL not driven, or host-level) |
| `time`, `tokens` | wall time; tokens for prompt steps (`-` otherwise) |
| `prompts/denials` | interactive prompts and permission denials seen |
| `friction` | `missing-prereq`, `wrong-flag`, `unstated-assumption`, `interactive-prompt`, `denied`, `auth-policy-blocked`, `auth-wrong-account`, `auth-needs-human`, `keychain`, `side-effect-stubbed`, `tool-lied`, `timeout`, `failed` |
| `fix` | the first fix for the step (all fixes are listed under `details:`) |

After the table the output has these sections, in order:

- **details:** every friction row, with its evidence line, and every fix with `rerunPassed`.
- **notes:** what could not be fixed by rule, and why.
- **login scripts.**
- **revised message:** the path it was written to. The file is `<out>/<name>.smoked.md`, where
  `<out>` defaults to the current directory. The input file is never overwritten.

`--copy` converts the revised message to HTML, then to RTF (`textutil`), and copies it with
`pbcopy -Prefer rtf`, so Mail, Slack and Docs paste it as rich text. On Linux it uses
`xclip` / `wl-copy` with `text/html`.

`--json` prints the report alone. Its fields are the SmokeReport (`src/core/smoke/types.ts`)
plus these:

| field | contents |
|---|---|
| `exitCode` | the run's exit code |
| `notes` | the notes section |
| `loginScripts` | one entry per hand-over: `{stepIndex, script}` |
| `editsApplied` | number of edits applied to the message |
| `revisedMessagePath` | where the revised message was written |
| `copied` | only with `--copy` |

Progress lines go to stderr (`smoke: step 3/6: …`).

## Exit codes

| code | meaning |
|---|---|
| `0` | every step's final outcome is `pass`, `fixed` or a skipped `open`, and no friction is left other than `side-effect-stubbed` |
| `1` | friction left: a failed step, a host-level step that was not run, a tool lie with no `--fix-tool` patch, or a changed host keychain list |
| `2` | usage: missing or unreadable file, unknown flag, bad value, or a message with no runnable steps |
| `130` / killed by SIGINT | interrupted; the sandbox was still torn down |

## Limits

- **Not a VM.** The sandbox is the same OS user with a different `HOME` and environment.
  Shared system locations stay shared, which is why host-level installs are not run.
  `/opt/homebrew` is the main case.
- A tool that calls `/usr/bin/open` by absolute path bypasses the `open` shim and reaches your
  default browser. Its URL is then not seen by browser auth.
- Reaping cannot catch an Apple platform binary that both calls setsid and changes directory
  out of the sandbox (see [Reaping](#reaping)).
- Browser auth works with pages that show the signed-in account. A provider that hides it
  behind a menu gives `auth-needs-human`, never a guess.
- Steps run under `/bin/zsh`, which is how a macOS reader's terminal runs them.
