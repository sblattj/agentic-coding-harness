# Desks and lanes

A small team of agents that message each other, with ach metering every one of them (issues #204 and #205).

- A **desk** is a long-lived, named agent session with a role prompt and a fixed set of MCP servers. A desk never runs a goal.
- A **lane** is a short-lived session that starts inside a goal, does one unit of work, and reports to the desk that launched it.
- A **message** is text delivered into another session as a user turn, prefixed `[desk-msg from <NAME>]`. A turn with no header was typed by the human, who outranks every peer.
- The **roster** is one JSON file and the only source of truth for who is alive and where.

The shipped default layout (`desks.default.yaml`) has three desks (ORCHESTRATOR, DECISIONS, LISTENER) with no MCP servers, no feed and `lanes.approval: none`. The diagram and table below show an example layout with tools and a feed wired in; see [desks.yaml](#desksyaml) for how to get it:

```
+------------------+-----------------+
|                  | DECISIONS       |   tmux window "desks"
| ORCHESTRATOR     +-----------------+   each lane = one more window
|                  | LISTENER        |
+------------------+-----------------+
```

| Desk | Port | Example tools (plus the `ach` desk tools) | Job |
|---|---|---|---|
| ORCHESTRATOR | portBase+1 | tracker, browser | routes work, launches lanes and probes, checks lane evidence |
| DECISIONS | portBase+2 | none | ownership calls, the human's decision list, relays answers |
| LISTENER | portBase+3 | transcripts, browser | follows a live call, keeps talking points, sends decisions and actions on |
| lanes | portBase+10 to +99 | per lane | one goal each |

## Quick start

```bash
ach desk up                       # start the default layout, open tmux windows
ach desk roster                   # who is alive, busy or idle, cost
ach desk send ORCHESTRATOR "summarize open PRs that touch auth"
ach lane new audit-auth --goal "List every call site of verifyToken and write them to /tmp/auth.md"
ach desk decisions                # questions waiting for you
ach desk answer D1 "yes, option 2"
ach desk down                     # stop lanes, feeds, hosts; empty roster
```

## Architecture

Every desk and every lane is one detached **desk host** process, `ach desk host --spec <file>`, listening on `127.0.0.1:<port>`. The host owns:

- the agent **engine** (see [Engines](#engines)),
- the optional **feed** (an event source whose events become messages),
- the **message queue** (a message to a busy desk waits and is delivered when it goes idle; a sender never blocks),
- the run's registry record and token records, so each desk and lane is an ordinary ach run with a `runId` (lanes carry `parentRunId`, the launching desk),
- an append-only **event log** of the run's desk transcript.

Everything else talks to hosts only through the **Host HTTP API**, and to the stack through the service (`src/desks/service.ts`): the CLI, the `ach mcp` desk tools, `ach web` and the macOS app all call the same functions.

Host API (JSON, 127.0.0.1 only):

| Route | Purpose |
|---|---|
| `GET /health` | state, queue depth, goal status, pids |
| `POST /send {from, text}` | deliver or queue a message, returns at once |
| `POST /note {text}` | silent context, no turn |
| `POST /record {type, data}` | append an out-of-band event |
| `GET /goal`, `POST /goal {objective}` | goal status; set a goal (returns once active, up to 45 s) |
| `GET /mcp` | engine-reported MCP status by name |
| `GET /events?since=<seq>` | events; SSE with `Accept: text/event-stream` |
| `GET /attach` | the argv a terminal pane runs to show the session |
| `POST /stop` | stop feed and engine, then exit |
| `POST /stop-if-idle` | `desk reload` without force: 409 `{state, queueDepth}` unless idle with nothing queued; else closes intake (later messages get 503) and stops as `/stop` does |

Every route except `GET /health` needs `Authorization: Bearer <token>` (401 without it). The token is 32 random bytes generated each time the host starts, written only to `specs/<name>.json` (mode 0600); it is never in `roster.json`, the roster view or any API answer. The CLI, the MCP tools and `ach web` read it from the spec file. Every route also checks `Host` (only `127.0.0.1:<port>` or `localhost:<port>`, else 421) and `Origin` (absent or the same origin, else 403), and every non-GET route needs `Content-Type: application/json` (415), so a web page in your browser cannot reach a host by a simple cross-site POST or by DNS rebinding.

Identity comes from the environment (`ACH_DESK_NAME`, `ACH_DESK_STACK`), never from tool arguments, so a desk's MCP tools cannot send as someone else. The CLI takes its sender from `--from`, else `$ACH_DESK_NAME`, else `human`, and refuses a `--from` that differs from `$ACH_DESK_NAME` (inside a desk or lane session). That is not a hard boundary: the token stops HTTP callers that cannot read the spec file, but any process running as the same OS user can read `specs/<name>.json` and call a host with any `from`. Self-send is refused. Every message is a `message_in` event in the target's run and a `message_out` event in the sender's, so replay shows the conversation.

Event types in `events/<runId>.jsonl` (`HostEventType`): `message_in`, `message_out`, `turn_start`, `turn_end`, `text`, `tool` (`{tool, summary}`), `usage`, `status`, `goal`, `feed`, `error`, and `boundary` (`{rule, detail, tool}`, a role boundary warning; see Roles).

### Message rules

- Sends are fire and forget. Tool descriptions and the role prompts tell agents never to wait or poll for a reply.
- No acknowledgement-only replies, otherwise two desks ping-pong.
- `desk_inbox` returns recent messages to or from the caller, for catching up after compaction.

## Roles

Each host loads `roles/common.md` plus `roles/<role>.md` as instructions, with `$DESK_NAME` replaced by the desk's name. The built-in roles live in `roles/`: `common`, `orchestrator`, `decisions`, `listener`, `lane`. To override one, put a file of the same name in `rolesDir` (searched first). The standalone binary and the PyPI package carry no `roles/` or `desks.default.yaml` on disk, so on first use they write embedded copies to `<state dir>/desks/builtin/<version>/` and read them from there. After editing `roles/` or `desks.default.yaml`, run `npm run gen:desks-assets` (a test fails while the embedded copy is stale).

Every built-in role file opens with a `## Your role, and only this` block, and `roles/common.md` states the division of labor every desk enforces:

- **LISTENER hears.** The single inbound channel from the team (meeting transcripts, team chat, mail and calendar). Read-only, always. Routes asks and decisions to DECISIONS, action items to ORCHESTRATOR, pushback to both. Never posts, decides or works items.
- **DECISIONS steers.** Ownership, yes or no, which option, anything for the human. Runs, researches and drafts nothing: work goes to ORCHESTRATOR, "what did the team say" goes to LISTENER (or a short read-only lane when LISTENER is off).
- **ORCHESTRATOR orchestrates.** Launches, briefs, steers and stops lanes. Forwards every open call to DECISIONS as `open: <call> | context | asked by` and waits for the decision id. Never decides ownership, asks the human directly, or does lane work.
- **Lanes do the work.**

Each desk's reply is limited to its own output kinds (DECISIONS: a decision, a question for the human, or a relay; ORCHESTRATOR: a lane launched, steered or stopped, a call forwarded, a result relayed; LISTENER: what it heard and where it routed it; a lane: `DONE`, `BLOCKED`, or a question to DECISIONS).

**Boundary warnings.** The host checks every `tool` event of a desk against its role (`src/desks/boundaries.ts`, keyed on the layout `role`, never the desk name) and records one `boundary` event `{rule, detail, tool}` right after the tool event when the desk stepped outside it. Nothing is blocked. The rules:

| rule | fires when |
|---|---|
| `decisions-does-work` | a `decisions` desk calls a work tool or `lane_new` |
| `listener-does-work` | a `listener` desk calls a work tool or `lane_new` |
| `orchestrator-asks-human` | an `orchestrator` desk calls `decision_open`, or `desk_send` whose arguments say `"to": "human"` |

Work tools are the edit, write and shell tools of the supported engines, by name after any `mcp__<server>__` prefix: `bash`, `shell`, `local_shell`, `shell_command`, `exec_command`, `run_shell_command`, `edit`, `multiedit`, `write`, `patch`, `apply_patch`, `notebookedit`, `notebook_edit`, `str_replace_editor`, `str_replace_based_edit_tool`, `replace`, `write_file`, `edit_file`, `create_file`. Read-only tools (read, grep, web fetch, MCP search tools) never warn, so LISTENER can search transcripts. Desk tools match with or without the engine's MCP prefix (`desk_send`, `desks_desk_send`, `mcp__desks__desk_send`). The `desk_send` to the human check reads the call's `to` argument, which both engines copy from the tool input onto the `tool` event (`data.to`), so it fires even when opencode reports a title as the summary. Only when an event carries no `to` does it fall back to the top-level `to` of the JSON summary. Lanes and custom roles get no warnings. Warnings show in `ach desk events` (`boundary  <rule>  <detail>`), in `ach desk chat` (`[boundary] <detail>`), on the web desks page and in the macOS app.

Custom role files in `rolesDir` still override the built-ins, block and all; the warnings depend only on the role name.

- **orchestrator**: launches lanes with standalone goals that carry a no-posting clause. Sends every action item to DECISIONS before any lane. Turns `probe D<n>: <check>` requests into 10 minute read-only `probe-d<n>` lanes. Checks lane evidence before `lane_stop`.
- **decisions**: the ownership rule. Anything we can do that is not confirmed owned by someone else is ours. Confirmed means evidence (a tracker assignee, a named person saying "I'll do it" with time and speaker, an open PR by someone else). "Can" means a probe proved the specific permission. Outcomes are one line each: `OWNED by <human>`, `OWNED by <person>` (watch only) or `ASK <HUMAN>` (opened with `decision_open`). Posting externally stays an ASK item unless approved.
- **listener**: reads the full context first, then batches. Output is `ASKED:` first, 3 to 5 talking points with speaker and time, `no change` when nothing changed. Routes decisions to DECISIONS and actions with owners to ORCHESTRATOR, and sends the full lists when the call ends.
- **lane**: works its goal, reports `DONE` or `BLOCKED` to ORCHESTRATOR, sends questions for the human to DECISIONS, treats steering messages as the latest instruction.

**Live-call quiet rule.** While a feed says a call is active, nothing posts to that meeting's chat or its people, approved or not. It is queued as `POST AFTER CALL` and released when the call ends. Pushback from people relayed by a peer stops every posting lane at once.

## desks.yaml

`ach desk up` reads `--layout F`, else `./desks.yaml`, else `~/.config/ach/desks.yaml`, else the built-in default layout. The resolved layout is saved as `layout.json` in the stack's state directory.

An example layout (the shipped default sets `mcps: []` on every desk, has the feed commented out and uses `approval: none`):

```yaml
portBase: 4800
model: provider/model
rolesDir: ./roles            # optional
desks:
  - {name: ORCHESTRATOR, role: orchestrator, mcps: [tracker, browser], pane: left}
  - {name: DECISIONS,    role: decisions,    mcps: [],                 pane: right-top}
  - name: LISTENER
    role: listener
    mcps: [transcripts, browser]
    pane: right-bottom
    feed:                    # optional; whosaid is one example of a live-transcript follower
      command: [whosaid, live, follow, --agent, --format, jsonl, --heartbeat, "3"]
      fullContext: [whosaid, live, show]
      activeCheck: [whosaid, live, status, --json]
      batchSeconds: 10
      immediate: [for_me, decision, call_started, call_ended]
lanes:
  defaultMcps: [tracker, browser]
  ports: [10, 99]
  approval: decisions
  defaultGoalFlags: --max-minutes 45
```

### Layout

| Field | Type | Default | Meaning |
|---|---|---|---|
| `portBase` | number | `4800` | Desk i listens on `portBase + 1 + i`; lanes on `portBase + lanes.ports[0..1]`. A different base lets a test stack run beside the live one. |
| `stack` | string | `default` when `portBase` is 4800, else `p<portBase>` | Stack id; names the state subdirectory. |
| `agent` | string | `opencode` | Default agent CLI (an ach adapter id). |
| `model` | string | engine default | Default model id, e.g. `provider/model` or `claude-sonnet-5-5`. |
| `cwd` | string | dir `desk up` ran in | Default working directory. |
| `rolesDir` | string | none | Extra roles directory searched before the built-in `roles/`. A leading `~` or `~/` means your home directory; other relative paths are relative to the layout file. |
| `mcpServers` | map name to `{command, args?, env?}` | none | Definitions for MCP names, for engines that cannot read your own config by name (driver engine). The opencode engine resolves names from its own config. |
| `desks` | DeskSpec[] | required | The desks. |
| `lanes` | LanesSpec | `{defaultMcps: [], ports: [10, 99], approval: none}` | Lane defaults (optional). |

### DeskSpec

| Field | Type | Default | Meaning |
|---|---|---|---|
| `name` | string | required | Unique, `/^[A-Z][A-Z0-9_-]{0,31}$/`. `HUMAN` is reserved. |
| `role` | string | required | Role prompt: `<rolesDir>/<role>.md`, then built-in `roles/`. |
| `agent` | string | `layout.agent` | Agent CLI for this desk. |
| `model` | string | `layout.model` | Model for this desk. |
| `mcps` | string[] | `[]` | MCP server names this desk gets. The `ach` desk tools are always added. Anything else is forced off. |
| `pane` | `left` \| `right-top` \| `right-bottom` \| `none` | none | Where its pane goes in the desks window. |
| `feed` | FeedSpec | none | Event source for this desk. |
| `cwd` | string | `layout.cwd` | Working directory. |

### FeedSpec

| Field | Type | Default | Meaning |
|---|---|---|---|
| `command` | string[] | required | argv; stdout is JSONL, one object per line, each with a string `type`. |
| `fullContext` | string[] | none | argv printing the full context so far; sent as ONE message on the first heartbeat when active. Killed after 15 s. |
| `activeCheck` | string[] | none | argv printing JSON with a boolean `active`, checked on the first heartbeat. Killed after 15 s (counted as not active, with an error event). |
| `batchSeconds` | number | `10` | Batch window for non-immediate events. |
| `immediate` | string[] | none | Event types that flush the batch and are delivered at once. |
| `heartbeatType` | string | `alive` | Event type meaning the backlog is over. Everything before the first one is backlog. |
| `endType` | string | `call_ended` | Event type that ends a session of the source; triggers the closing message. |

If `activeCheck` says nothing is active, the desk gets one "waiting for the next call" note instead of context. Other feeds (CI events, review events, a chat watcher) use the same shape. The feed runs in its own process group, so stopping a desk also stops the children of a shell-wrapped feed, and stop kills any helper command still running. If a helper hangs, at most 1000 events wait behind it: the oldest are dropped, with a `feed` note.

### LanesSpec

| Field | Type | Default | Meaning |
|---|---|---|---|
| `defaultMcps` | string[] | `[]` | MCP names a lane gets when `lane_new` passes none. |
| `ports` | `[lo, hi]` | `[10, 99]` | Port offsets from `portBase`, inclusive. |
| `approval` | `decisions` \| `none` | `none` | With `decisions`, `lane_new` from a desk other than DECISIONS (or the human) returns a pending request until `lane approve`. |
| `defaultGoalFlags` | string | none | Prefixed to every lane objective, e.g. `--max-minutes 45`, except an objective that itself starts with `--` (it carries its own flags) is left as is. |
| `agent`, `model` | string | layout values | Defaults for lanes. |
| `budgetUsd` | number | none | Default per-lane budget; feeds the existing [budget alerts](BUDGET-ALERTS.md). A lane that crosses it is also stopped by its host and recorded with status `error` (a desk only alerts). |

## State files

Under `<stateDir>/desks/<stack>/`:

| File | Content |
|---|---|
| `roster.json` | the roster (atomic rewrite under a lock) |
| `roster.lock/` | the lock directory |
| `messages.jsonl` | one `DeskMessage` per line |
| `decisions.jsonl` | `open`, `answer` and `close` events, folded into the current decision list |
| `pending-lanes.jsonl` | lane approval requests: request, approve, reject |
| `specs/<name>.json` | the host spec handed to `ach desk host`, including the host's bearer token (mode 0600) |
| `events/<runId>.jsonl` | the run's desk transcript |
| `logs/<name>.log` | host stdout and stderr |
| `layout.json` | the resolved layout `desk up` used |
| `terminal.json` | the terminal the panes live on (`kind`, tmux session and socket), so later commands reach the same tmux server |
| `specs/<name>.pid` | the launcher pid; `desk down` waits on it and on the host pid |
| `specs/<name>.switching` | present while `desk engine`, `desk reload` or `desk on/off` switches that desk, so a roster prune skips it |
| `auto/<name>.json` | the desk's auto watcher: `{pid, token, pollMs, graceMs, startedAt}` (`desk auto`) |
| `logs/<name>-auto.log` | the auto watcher's log, one line per poll decision, each starting with an ISO time |
| `logs/<name>-power.log` | output of the detached `desk off` a desk runs when it turns itself off |
| `lanes.log` | one JSON line per lane start and stop |

The stack name is `--stack`, else `$ACH_DESK_STACK`, else `<stateDir>/desks/active-stack`, else `default`.

Names become file names, so they are checked before any path is built:

- A stack name, from any of those sources, `?stack=` or the layout's `stack`, must match `/^[A-Za-z0-9][A-Za-z0-9_.-]*$/` (one path segment); anything else is refused with `invalid stack name` (400 in the web API).
- A lane name must match `/^[a-z0-9][a-z0-9_-]{0,47}$/i`. `human` in any case is reserved (no desk or lane may use it): it is the user's sender and approver identity.
- A new lane name may not equal, ignoring case, a roster entry, a layout desk, a lane being started, or a pending or approving lane request (macOS disks are case-insensitive, so `orchestrator` and `ORCHESTRATOR` would share `specs/` and `logs/` files).
- Two concurrent starts of one lane name cannot both win: the name is reserved in `roster.json` under `starting` (with a timestamp and pid) while its host starts, and the roster entry replaces it in one write. A reservation older than the host start timeout plus 15 s, or whose pid is gone, is stale and ignored. `lane approve` marks the request `approving` first, so a second approve of the same id is refused (`lane request ... is already approving`); a failed start puts it back to `pending`.

## CLI

```
ach desk up [--layout F] [--port-base N] [--term tmux|ghostty|none] [--tmux-session S] [--tmux-socket S] [--json]
ach desk down
ach desk attach [--term tmux|ghostty|none] [--tmux-session S] [--tmux-socket S]
ach desk send <to> <text...> [--from NAME]      text "-" reads stdin
ach desk roster [--json] [--no-prune]
ach desk inbox [name] [--limit N] [--since <ms|10m|2h|1d>] [--json]
ach desk events <name> [--since SEQ] [--json] [--follow]
ach desk answer <Dn> <text...> [--from NAME]
ach desk decisions [--state open|answered|closed] [--json]
ach desk close <Dn> [--reason R] [--from NAME]
ach desk engine <name> <agent> [--model M]
ach desk reload <name>|--all [--force] [--json]
ach desk reload --stale [--json]
ach desk status <name> [--json]
ach desk on <name> [--resume] [--json]
ach desk off <name> [--force] [--from NAME] [--json]
ach desk toggle <name> [--force] [--resume] [--json]
ach desk auto <name> [--poll S] [--grace S] [--json]
ach desk auto <name> --stop
ach listener status|on|off|toggle|auto ...   same as ach desk <sub> LISTENER
ach desk costs [--json]
ach desk host --spec <file>              internal: the per-desk host process
ach desk chat <name> [--from NAME]       attach REPL for engines without a native TUI

ach lane new <name> --goal "<objective>" [--agent A] [--model M] [--mcps a,b] [--cwd D] [--budget-usd N] [--brief TEXT] [--from NAME]
ach lane status [name] [--json]
ach lane stop <name> [--now] [--from NAME]
ach lane approve <Ln> [--from NAME]
ach lane reject <Ln> [--reason R] [--from NAME]
```

Every subcommand takes `--stack S`. `--from` defaults to `$ACH_DESK_NAME`, else `human`.

- `desk up` refuses when any desk of the stack is alive. `--port-base` overrides the layout (a test stack beside the live one). `--tmux-session` picks the tmux session that gets the `desks` window and the lane windows. When the hosts start but the panes cannot be opened, `desk up` still succeeds and says so (`note` in the `RosterView`); `ach desk attach` opens them.
- `desk down` stops every lane, then every desk (feed, pane, host), and leaves an empty roster with no processes. A lane whose stop fails does not stop the rest: its host is stopped anyway, the desks go down, and `desk down` then reports the failed lanes as an error.
- Stops never touch what is no longer ours: `/stop` goes to a port only while its `/health` answers for the entry's run, and a recorded pid is signalled only while its command line still runs that desk's `desk host --spec <specs/name.json>`.
- `desk send`, `desk answer` and `desk chat` send as `--from`, else `$ACH_DESK_NAME`, else `human`. Inside a desk or lane session (`$ACH_DESK_NAME` set) a `--from` that differs is refused.
- `-h` or `--help` is help only as the first argument after the subcommand; inside message text it is sent like any other word.
- Only the human or the stack's decisions desk (the desk with role `decisions`) may `lane approve` or `lane reject`, from the CLI, MCP tools and web API alike (the web API answers 403 otherwise).
- `desk events --follow` and `desk chat` look the host up again on every reconnect, so they keep streaming across an engine switch (new host token and run; the new run's events start at seq 1).
- `desk engine` restarts one desk on another agent, keeping its roster slot, message history and decisions. An agent name ach does not know (the list `GET /api/desks/engines` shows) is refused before the running host is stopped. When the new engine fails to start, the desk is restarted on its previous agent on the same port (with a new run id) and the start error is returned.
- `desk reload` restarts a running desk's host so it picks up a new ach build (for example a tool added to the desks MCP server): same port, same engine and model, same roster slot, message history and decisions, and the same agent session, so the conversation continues where it was. The host gets a new run id and token. The roster's terminal, feed and goal fields are kept.
  - A busy desk (a turn running or messages queued) is refused, because the restart would cut its turn; `--force` reloads it anyway. A desk that is not running is refused too (use `desk up`). The host itself makes the last idle check (`POST /stop-if-idle`) and accepts no message after it, so a message that arrives while the reload starts is refused with an error (the sender sees it) rather than cut off; a host from before that route gets only the reload's own `/health` check.
  - `--all` reloads every desk of the stack, one by one, in port order; lanes are never reloaded (a lane by name is refused). One desk that fails does not stop the others, and the exit status is 1 when any desk was not reloaded.
  - A desk cannot reload itself (its own MCP server runs inside the host being restarted): `desk reload <own name>` from inside a desk is refused, and `--all` from inside a desk skips the caller and says so.
  - Each result says whether the session was kept (`resumed`). OpenCode adopts the old session on the new `opencode serve` (no new session, old parts are not counted again); driver engines resume it on the next turn when the agent supports resume. When the engine cannot continue it (an agent without resume, an OpenCode session that is gone), the desk starts a new session and the result carries a `note`.
  - Role prompts: the reloading ach resolves the desk's role files again (so an upgrade's new built-in roles count, not the paths the old install saved). The resumed session gets the current role prompt once, as a note marked as replacing the earlier one, only when it differs from the one the session last got (ach records a hash per desk in `<stateDir>/desks/<stack>/role-sent/<name>.json`; a session with no record gets it once). A role removed since (an empty prompt) gets a note, once, saying the earlier role prompt no longer applies, when the record shows this session got one. OpenCode sends it as a no-reply note; non-claude driver agents get it ahead of the next turn's prompt; claude needs nothing extra, because it gets the current role as its system prompt on every turn.
  - **tmux:** the pane stays. Before the host stops, the pane gets `remain-on-exit on`, so the attach command exiting does not close it; the pane is then respawned in place (`respawn-pane -k`, same `%N` id, new process) and the option is unset again. Only panes ach opened (tagged `@ach_run`) are respawned.
  - **Ghostty:** a Ghostty window cannot be respawned in place, so the old window is closed and a new one opened on the reloaded desk (a new terminal id).
  - **Automatic after an ach upgrade:** every desk host (never a lane) checks the installed ach version every 5 minutes, by running `ach --version` from the same path it was started from (the npm or Homebrew link, or the binary), so it sees an upgrade while still running the old code. When the installed version is newer than the one the host runs, the desk is reloaded once it is idle (no turn running, nothing queued, no active goal) and has stayed idle for a second after its last turn, whether the check found it idle or it went idle later; a busy desk is never cut off, it waits. The host spawns a detached `ach desk reload <name>` (the new ach does the reload, like a manual one), and logs it in the desk's host log (`<stateDir>/desks/<stack>/logs/<name>.log`, lines starting `auto-reload:`), with the reload's own output in `logs/<name>.auto-reload.log`. Each desk is reloaded once per installed version (`<stateDir>/desks/<stack>/auto-reload/<name>.json`): the new host never triggers again for the same version, and a host whose reload was refused or failed retries after a minute, up to 3 times. An older or equal installed version (another install, a downgrade) changes nothing. `ACH_DESK_VERSION_POLL_MS` sets the interval (`0` turns the check off). A manual `ach desk reload --all` still works at any time.
  - `--stale` reloads only the desks whose host runs an older ach than the installed one. Each host reports its version in `/health` (`achVersion`), and the roster records it at start. A busy desk is skipped (run it again later), an off desk is skipped (it starts on the current build when turned on), and a desk on a NEWER version is never touched. It runs only when asked: a reload from every roster read would make two installs of different versions restart each other's desks back and forth.
- **Desk power** (`desk status|on|off|toggle|auto`, MCP `desk_power`, `POST /api/desks/:name/power`). A desk that is not needed (LISTENER between calls) can be switched off and back on without `desk down`.
  - `off` keeps the desk in the roster with `off: {at, by}` (row state `off`), closes its pane (only panes ach opened), stops its host and with it the feed process. The engine session id is kept for `on --resume`. Off is refused while the desk feed's `activeCheck` reports a live call (`refused: a call is live, <NAME> stays on`); `--force` (CLI and web only, never from a desk) overrides it.
  - `on` starts a new host on the same port from the desk's last spec: fresh run id, token and engine session (`--resume` continues the session saved at off; when that fails it starts fresh and says so), a new feed (it starts with the full call context on its first heartbeat), and a new pane in the `desks` window placed by the desk's layout slot.
  - `toggle` is `off` for a desk that is on, else `on`. `on` of an on desk and `off` of an off desk change nothing and say so.
  - `status` prints `<NAME> on feed=<pid> pane=<id>` (or `off`, or `dead`), then `call: live|none|unknown` from the `activeCheck`, then `auto: on (pid N, ...)|off`.
  - While a desk is off, `desk_send` to it fails with an error starting `desk_off:` that says not to retry; `desk reload` and `desk engine` refuse it; `desk attach`, the roster prune and the web stream leave it alone; `desk down` removes it.
  - A desk may turn itself off (`desk_power {name: <own name>, action: "off"}`): the call answers at once with `pending: true`, and a detached `ach desk off` stops its host 3 s later, so the reply is never cut.
  - Every switch is a line in `messages.jsonl` (`<by> -> <NAME>: desk_power: off`, marked `power: true`); it is never delivered to a session.
  - `auto` starts a detached watcher (`ach desk watch`, one per desk) that polls the desk feed's `activeCheck` every `--poll` seconds (default 30). A live call while the desk is off turns it on. With the desk on and no call for `--grace` seconds (default 300, so the end-of-call handoff finishes), it turns the desk off; a call that comes back first cancels the countdown. A failed or timed-out check counts as unknown and changes nothing. `auto --stop` ends the watcher; `desk down` ends every watcher of the stack. A desk without a feed `activeCheck` is refused. The watcher log is `logs/<NAME>-auto.log`.
- `lane stop` refuses desk names. A busy lane gets up to 15 s to finish its turn, plus about 2 s for the goal verdict, so a lane that just sent DONE is judged before it dies; `--now` skips the wait (emergency stops; `desk down` always stops at once). It closes the pane, stops the host and removes the roster entry.
- `ach lane status <name>` also answers for a lane that already ended: the roster has forgotten it, so the row is rebuilt from `lanes.log` with `state: "stopped"` and `goalState` (the final goal state, taken from the lane's last `goal` event so a verdict reported while the host was stopping counts). A lane whose host crashed gets the same row: the roster prune writes its stop line (`by: "prune"`). Without a name only live lanes are listed.
- `--json` prints the `RosterView` (stack, `portBase`, rows with state, queue depth, goal status and cost, pending lanes, open decisions). Without it, a table.

## MCP tools

Registered on `ach mcp` for every desk and lane session (identity from `ACH_DESK_NAME`):

| Tool | Args | Behavior |
|---|---|---|
| `desk_roster` | none | `me` plus peers with role, busy/idle/dead/off, tools, goal |
| `desk_send` | `to, text` | refuses self and unknown names; an off desk fails with `desk_off: ...` (do not retry); returns at once; do not wait or poll |
| `desk_inbox` | `limit?, since_minutes?` | recent messages to or from the caller |
| `desk_reload` | `name?` or `all: true` or `stale: true`, `force?` | restart desks on a fresh host, keeping port, engine and session (see `desk reload`); refuses the caller and lanes; `all` and `stale` skip the caller; returns `{results}` |
| `desk_power` | `name, action` (`status`, `on`, `off`, `toggle`, `auto`, `auto_stop`), `resume?`, `pollSeconds?`, `graceSeconds?` | switch a desk on or off (see Desk power); never forces, so off is refused during a live call; a desk turning itself off gets `pending: true` |
| `lane_new` | `name, goal, mcps?, cwd?, agent?, model?, budget_usd?, brief?` | start a lane, or `{pending}` when approval applies |
| `lane_status` | `name?` | goal state, verified plan actions, evidence |
| `lane_stop` | `name, now?` | refuses desk names; waits up to 15 s for a busy lane to finish its turn and for its goal verdict, unless `now: true` |
| `lane_approve` | `id` | approve a pending lane (DECISIONS or human only) |
| `lane_reject` | `id, reason?` | reject a pending lane (DECISIONS or human only) |
| `decision_open` | `question, options, asked_by?` (alias `askedBy`; default the caller) | add a question for the human |
| `decision_list` | `state?` | open, answered or closed decisions |
| `decision_close` | `id, reason?` | close a decision |

See [MCP.md](MCP.md) for the rest of the `ach mcp` server.

## Goals

Lanes always run inside a goal; desks never do. Lane goals must stand alone (a lane inherits no desk context) and must include a no-posting clause: nothing posted, sent or pushed outside the team without a decision. `defaultGoalFlags` is prefixed to the objective. Goal state is read from the engine's own state, not from the agent's word: with opencode, the goal plugin; with the driver engine, ach's goal loop (objective, plan, verified actions).

## Engines

| Engine | Used for | How it works |
|---|---|---|
| `opencode` | agent `opencode` | The host starts `opencode serve` on `port + 500` with a per-desk config (every other MCP forced off, role files as instructions), creates a session, and delivers messages over HTTP. Goals use the goal plugin on 1.x and the built-in `opencode.goal` plugin on 2.x. Busy/idle is the engine's own status. Supported: opencode 1.x (tested 1.19.0) and 2.x (tested 2.2.5 and 2.3.2); see "opencode versions" below. |
| `driver` | `claude`, `codex`, `gemini`, and other ach adapters | The host runs one `ach run` per turn with the session resumed. Goals use ach's own loop. Busy/idle is the run's own state. |

If the `opencode serve` of a running desk or lane exits on its own, the engine records an `error` event with `fatal: true`, ends a running turn with a `turn_end` that carries the same `error`, and the host stops with status error (exit 1); it does not restart the serve. Stopping a host while its engine is still starting is safe: the engine checks for the stop before every serve spawn and kills any serve it already spawned, so no `opencode serve` outlives the host. Setting a goal is confirmed only by a "New active goal" message that is newer than the goal command, so an earlier goal's message in the session never confirms a new one.

**opencode versions.** Before it starts a serve, the engine runs `opencode --version` (bin: `$ACH_OPENCODE_BIN`, else `opencode` on PATH) and picks the HTTP API from the major version. Any other major, or output without a version, fails the desk with "opencode X is not supported". Attach commands name that same binary by absolute path, because a pane's login shell can find a different `opencode` on its PATH.

| opencode | API the engine drives | Notes |
|---|---|---|
| 1.x (tested 1.19.0) | `/session`, `/session/<id>/prompt_async`, `/event`, `/mcp`, no auth | Goals via the goal plugin. Attach: `opencode attach <url> --session <id>`. |
| 2.x (tested 2.2.5, 2.3.2) | `/api/info`, `/api/session`, `/api/session/<id>/prompt` and `/synthetic`, `/api/session/active`, `/api/event`, `/api/mcp`, HTTP Basic auth | A fresh random password per serve, passed as `OPENCODE_PASSWORD` and kept in a 0600 file under `<state>/desks/<stack>/secrets/` (removed on stop). Attach runs `opencode --server <url> --session <id>` with the password read from that file, never from argv. Disabled MCPs get complete `mcp.servers.<name>: {type, command, disabled: true}` stand-ins, because opencode 2 drops an `{enabled: false}`-only entry. Lane goals run `/goal <objective>` through `POST /api/session/<id>/command` and read the built-in `opencode.goal` plugin over `POST /api/rpc/opencode.goal/get` (active, complete as achieved, paused as stopped). opencode 2 cannot remove a command, and a `goal` command from the opencode config (`command.goal`, or a `goal.md` in a `command`/`commands` directory) replaces the built-in one. `setGoal` refuses before sending anything when the config defines one, naming the file. A plugin's `goal` command cannot be seen in config: then the goal is not confirmed, the engine interrupts the turn that command may have started, and the error quotes the listed command's description. Remove or rename that command to use lane goals. |

The engine fails closed on an API it does not speak: an HTML page (opencode 2 serves its web UI on every non-`/api` path) or any other non-JSON body is an "unsupported opencode API" error, readiness needs a JSON answer, and an event stream that is not `text/event-stream` fails the start. On opencode 2 the MCP check waits until the serve lists the `desks` MCP with no entry still pending (an empty list proves nothing, up to 30 s), then treats every other MCP that is not `disabled` as a leak: the engine re-boots once with stand-ins for the leaked names (logged as `[ach] boot 1: ...` in the serve log) and fails the desk if any still leak. The opencode 2 config discovery that ach mirrors also covers `$OPENCODE_CONFIG_DIR` and the managed directory (`/Library/Application Support/opencode` on macOS, `/etc/opencode` on Linux).


Switch a running desk with `ach desk engine <name> <agent>`. A missing engine fails at start with a clear error (see [Troubleshooting](#troubleshooting)).

## Terminals

| Driver | Notes |
|---|---|
| `tmux` (default) | One `desks` window with three panes, one window per lane, all opened without taking focus. Works over SSH. Closing is immediate. |
| `ghostty` | Optional, macOS. Panes are addressed by terminal id. |
| `none` | No panes; use the web view, the app or `ach desk chat`. |

`--term` picks the driver; the default is tmux. The pane ids are stored in the roster as `{kind, id, token}`.

**Moving a running stack.** Hosts, sessions, the roster and feeds do not depend on panes. `ach desk attach --term tmux` closes the old panes and reopens them on the same sessions; history is intact and feeds never stop. `ach desk down` closes every pane it opened and touches no other window. tmux pane ids (`%N`) restart with every tmux server, so each pane ach opens is tagged with the pane option `@ach_run` (the token is also kept under `<tmpdir>/ach-desks-tmux`), and the roster stores that token in the entry's `terminal.token`. `desk down`, `desk attach`, lane stop and desk restart close, check or respawn a pane only while it still carries that token, so a reused id is left alone. Roster entries written before the token was stored have none: their panes are left open (with a note on stderr), never closed by id. Ghostty closing signals the recorded pid only when its command line still matches what ach launched and its start time fits that open's pidfile (a reused pid starts after the pidfile was written, so the same executable and script is not enough).

**Ports.** A desk or lane on port P runs its opencode engine on P + 500. Layout validation reserves those ports for every desk and lane: lane ports may not overlap the desks' engine ports, the lane range must be under 500 ports wide, and portBase + lanes.ports[1] + 500 must be at most 65535 (also checked for a `--port-base` override).

## Web

`ach web` serves a Desks view at `/desks`: the desk layout, a lane strip (goal, status, plan progress, cost), a message timeline, decision cards you answer with one click, and cost per desk and lane tree. It uses the Web API below.

`ach web` refuses cross-site requests on every route and WebSocket upgrade: on a loopback bind the `Host` must be `127.0.0.1`, `localhost` or `[::1]` with the bound port, and on a non-loopback bind an IP literal, `localhost`, the `--host` name or this machine's hostname (421; add a reverse-proxy or LAN DNS name to the comma-separated env `AGENTIC_CODING_HARNESS_WEB_ALLOWED_HOSTS`), a present `Origin` must match the `Host` (403), and a non-GET `/api/*` request with a body must be `application/json` (415). A POST with no body (kill, continue) passes.

### Web API

JSON; SSE where noted. Versioned as `desks-api/1`.

```
GET  /api/desks                         -> RosterView   (desk rows carry `pane` when the layout sets one; lanes have none)
GET  /api/desks/messages?since=<ms>&limit=<n>&name=<desk> -> {messages: DeskMessage[]}   (name keeps messages from or to that desk)
GET  /api/desks/stream                  -> SSE: message | roster | event | decision
GET  /api/desks/decisions?state=<open|answered|closed> -> {decisions: Decision[]}
POST /api/desks/decisions/:id/answer {text} -> Decision   (delivers the answer to askedBy and to DECISIONS)
POST /api/desks/send {to, text}         -> DeskMessage   (from "human")
POST /api/desks/up {layoutFile?, term?} -> RosterView   (term defaults to "none": no terminal panes)
POST /api/desks/down                    -> {stopped: string[]}
POST /api/desks/lanes {name, goal, mcps?, cwd?, agent?, model?, budgetUsd?} -> RosterEntry | {pending: PendingLane}
POST /api/desks/lanes/:name/stop        {now?: true} -> {}   (body optional; now skips the busy-lane grace wait)
POST /api/desks/pending/:id/approve     -> RosterEntry ; /reject {reason?} -> PendingLane
POST /api/desks/:name/engine {agent, model?} -> RosterEntry
POST /api/desks/:name/reload {force?}  -> {results: DeskReloadResult[]}   (name `all` reloads every desk, never lanes; 409 busy or not running)
POST /api/desks/all/reload {stale: true} -> {results: DeskReloadResult[]}  (only idle desks on an older ach build)
POST /api/desks/:name/power {action: status|on|off|toggle, resume?, force?} -> DeskPowerResult   (409: a call is live, or the desk is a lane)
POST /api/desks/:name/auto {stop?, pollMs?, graceMs?} -> DeskPowerResult   (409: no feed activeCheck)
GET  /api/desks/:name/events?since=<seq> -> {events: HostEvent[]}
GET  /api/desks/:name/attach            -> {argv: string[]}   (the command that attaches a terminal to the desk or lane; 404 unknown, 409 dead or off)
GET  /api/desks/costs                   -> {rows: DeskCostRow[]}
GET  /api/desks/engines                 -> {engines: {agent, found, path?, auth?}[]}
GET  /api/desks/mcps                    -> {names: string[]}
```

Every route also takes `?stack=<name>` to pick a stack (default: the server's own). Every route needs the `ach web` token, as `?token=<token>`, `Authorization: Bearer <token>`, or the cookie a valid `?token=` sets (401 without it). `ach web` always has one: `--token`, else `AGENTIC_CODING_HARNESS_HTTP_TOKEN`, else a random token generated on first start into `<stateDir>/web/token` (0600; reused across restarts; an empty value counts as unset; loopback only). It prints and opens `http://127.0.0.1:<port>/?token=<token>`; that first visit sets an `HttpOnly`, `SameSite=Strict` cookie, so the desks page keeps working without the token in its URL. The macOS app sends its Settings token, or reads `<stateDir>/web/token` when that is empty. A server embedded without any token (`startWebServer` with no `token`) answers the GET routes and refuses every POST route with 403.

The page keeps its chats live across a stream reconnect: a new stream subscribes to hosts from "now", so on every (re)open, and again after the first roster snapshot, the page refetches `/api/desks/:name/events?since=<lastSeq>` for each loaded chat and drops duplicates by seq.

Errors are `{error: string}` with a status picked from the service message:

| Status | Message shapes (src/desks/*.ts) |
|---|---|
| 400 | `... must not be empty`, `must be an array` / `a non-empty string`, `every decision option needs a label`, `invalid lane name`, `invalid stack name`, `invalid desk or lane name`, `invalid run id`, `cannot send to yourself`; bad JSON or body fields, or a path segment holding `/`, `\` or a leading `.` (HttpError) |
| 401 | missing or wrong token |
| 403 | a write (any POST route) on a server embedded without any token (`ach web` always has one) |
| 404 | `unknown desk or lane`, `unknown desk`, `unknown lane`, `no pending lane <id>`, `no decision <id>` |
| 409 | `stack ... is already up`, `port(s) ... already in use`, `port ... still busy`, `name ... is already in use`, `lane ... is already pending approval`, `lane request ... is already <state>`, `decision ... is closed`, `<name> is not running (dead)`, wrong kind (`is a lane` / `is a desk`), `no free lane port` |
| 500 | config or server failure: `layout file not found`, `invalid layout`, `cannot parse layout`, `corrupt layout`, `corrupt roster`, `roles/common.md not found`, `role file ... not found`, `invalid role name`, `the layout has no desks`, `did not become idle`, `no spec or layout entry`, `timed out ... roster lock`, `desk host ...` upstream failure, `not implemented`; a non-Error throw |
| 405 | wrong HTTP method for a known route |
| 413 | request body over 1 MiB (the response carries `connection: close`) |
| 500 | any other message (default): an unknown error is a server bug, not a conflict |

Roster rows (`GET /api/desks`, `desk roster --json`) carry `pane` (`left` | `right-top` | `right-bottom` | `none`) on desks whose layout entry sets one. The web page places desk cards by it and falls back to port order when it is absent.

## macOS app

`apps/ach-desk` is a native SwiftUI app (macOS 14+) over the same Web API. It starts the default layout without a terminal, shows pending decisions in the menu bar, answers decisions from notification banners, and starts lanes from a sheet. Engines are a setting; the app never talks to an agent CLI. See the README in that directory.

## Cost

Every desk and lane is an ach run, so everything is metered.

```bash
ach stats --by desk         # per desk and per lane, keyed <stack>/<name>; other records land in (none)
ach desk roster --json      # costUsd and treeCostUsd per row
```

Lane cost rolls up under the launching desk. A desk's row covers every run of that desk name in the stack (an engine switch, or an earlier `desk up`, starts a new run): its own cost and tokens are the sum over those runs, and lanes launched by any of them stay nested under it. Unknown is not zero: when a desk's usage could not be priced (a model with no price, such as `ferry/super-flash`), `costUsd` is `null` in `ach desk costs` / `/api/desks/costs` and prints as `-`, and any tree total (`treeCostUsd`) that contains an unknown part is `null` too, never a partial sum. The host meter marks such runs with `totals.costUnpriced` in the run record (older desk-host records with tokens and a 0 cost and no `costSource` are read the same way). `ach desk costs` also lists lanes that already stopped, because their spend happened: a lane whose launcher is a live desk stays nested under it, and a lane launched by a human or whose launcher is gone is a top-level row. A per-lane budget (`--budget-usd`, `lanes.budgetUsd`) uses the existing [budget alerts](BUDGET-ALERTS.md). If the host cannot write a raw token record (a disk error), it keeps running but records an `error` event, counts the loss in the run record (`metadata.tokenRecordFailures`), and `ach desk costs` shows it in the `LOST` column (`tokenRecordFailures` in JSON) with a warning that the totals undercount.

## Troubleshooting

- **Port busy.** Another stack (or a stray process) holds a port. Pick another `portBase` (`ach desk up --port-base 4900`) to run beside it, or find and stop the owner. Lanes pick the next free port in their range.
- **`desk up` refuses.** A desk of that stack is still alive. Run `ach desk roster`, then `ach desk down`.
- **Stale roster entries.** `ach desk roster` prunes entries whose host is dead: no `/health` answer and no recorded pid still running that host. A pruned lane gets a stop line in `lanes.log` and loses `specs/<name>.pid`. A host that is alive but does not answer stays listed as `dead` (it may be slow); after a crash, `ach desk down` clears the rest.
- **Engine not found.** The agent CLI is not on PATH. Check `GET /api/desks/engines` or `ach doctor`, then fix the install or set `agent` to another engine.
- **A desk has the wrong tools.** Compare the host's `GET /mcp` with its `mcps` in the layout; only those plus the `ach` desk tools should be enabled.
- **Messages not arriving.** Read `messages.jsonl` and `events/<runId>.jsonl`, and `logs/<name>.log` for the host.
- **Panes missing.** `ach desk attach` reopens them on the running sessions.
