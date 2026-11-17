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

Every route except `GET /health` needs `Authorization: Bearer <token>` (401 without it). The token is 32 random bytes generated each time the host starts, written only to `specs/<name>.json` (mode 0600); it is never in `roster.json`, the roster view or any API answer. The CLI, the MCP tools and `ach web` read it from the spec file. Every route also checks `Host` (only `127.0.0.1:<port>` or `localhost:<port>`, else 421) and `Origin` (absent or the same origin, else 403), and every non-GET route needs `Content-Type: application/json` (415), so a web page in your browser cannot reach a host by a simple cross-site POST or by DNS rebinding.

Identity comes from the environment (`ACH_DESK_NAME`, `ACH_DESK_STACK`), never from tool arguments, so a desk's MCP tools cannot send as someone else. The CLI takes its sender from `--from`, else `$ACH_DESK_NAME`, else `human`, and refuses a `--from` that differs from `$ACH_DESK_NAME` (inside a desk or lane session). That is not a hard boundary: the token stops HTTP callers that cannot read the spec file, but any process running as the same OS user can read `specs/<name>.json` and call a host with any `from`. Self-send is refused. Every message is a `message_in` event in the target's run and a `message_out` event in the sender's, so replay shows the conversation.

### Message rules

- Sends are fire and forget. Tool descriptions and the role prompts tell agents never to wait or poll for a reply.
- No acknowledgement-only replies, otherwise two desks ping-pong.
- `desk_inbox` returns recent messages to or from the caller, for catching up after compaction.

## Roles

Each host loads `roles/common.md` plus `roles/<role>.md` as instructions, with `$DESK_NAME` replaced by the desk's name. The built-in roles live in `roles/`: `common`, `orchestrator`, `decisions`, `listener`, `lane`. To override one, put a file of the same name in `rolesDir` (searched first).

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
| `rolesDir` | string | none | Extra roles directory searched before the built-in `roles/`. |
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
| `specs/<name>.switching` | present while `desk engine` restarts that desk, so a roster prune skips it |
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
- `lane stop` refuses desk names. A busy lane gets up to 15 s to finish its turn, plus about 2 s for the goal verdict, so a lane that just sent DONE is judged before it dies; `--now` skips the wait (emergency stops; `desk down` always stops at once). It closes the pane, stops the host and removes the roster entry.
- `ach lane status <name>` also answers for a lane that already ended: the roster has forgotten it, so the row is rebuilt from `lanes.log` with `state: "stopped"` and `goalState` (the final goal state, taken from the lane's last `goal` event so a verdict reported while the host was stopping counts). A lane whose host crashed gets the same row: the roster prune writes its stop line (`by: "prune"`). Without a name only live lanes are listed.
- `--json` prints the `RosterView` (stack, `portBase`, rows with state, queue depth, goal status and cost, pending lanes, open decisions). Without it, a table.

## MCP tools

Registered on `ach mcp` for every desk and lane session (identity from `ACH_DESK_NAME`):

| Tool | Args | Behavior |
|---|---|---|
| `desk_roster` | none | `me` plus peers with role, busy/idle/dead, tools, goal |
| `desk_send` | `to, text` | refuses self and unknown names; returns at once; do not wait or poll |
| `desk_inbox` | `limit?, since_minutes?` | recent messages to or from the caller |
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
| `opencode` | agent `opencode` | The host starts `opencode serve` on `port + 500` with a per-desk config (every other MCP forced off, role files as instructions), creates a session, and delivers messages over HTTP. Goals use the goal plugin. Busy/idle is the engine's own status. |
| `driver` | `claude`, `codex`, `gemini`, and other ach adapters | The host runs one `ach run` per turn with the session resumed. Goals use ach's own loop. Busy/idle is the run's own state. |

If the `opencode serve` of a running desk or lane exits on its own, the engine records an `error` event with `fatal: true`, ends a running turn with a `turn_end` that carries the same `error`, and the host stops with status error (exit 1); it does not restart the serve. Stopping a host while its engine is still starting is safe: the engine checks for the stop before every serve spawn and kills any serve it already spawned, so no `opencode serve` outlives the host. Setting a goal is confirmed only by a "New active goal" message that is newer than the goal command, so an earlier goal's message in the session never confirms a new one.

Switch a running desk with `ach desk engine <name> <agent>`. A missing engine fails at start with a clear error (see [Troubleshooting](#troubleshooting)).

## Terminals

| Driver | Notes |
|---|---|
| `tmux` (default) | One `desks` window with three panes, one window per lane, all opened without taking focus. Works over SSH. Closing is immediate. |
| `ghostty` | Optional, macOS. Panes are addressed by terminal id. |
| `none` | No panes; use the web view, the app or `ach desk chat`. |

`--term` picks the driver; the default is tmux. The pane ids are stored in the roster as `{kind, id}`.

**Moving a running stack.** Hosts, sessions, the roster and feeds do not depend on panes. `ach desk attach --term tmux` closes the old panes and reopens them on the same sessions; history is intact and feeds never stop. `ach desk down` closes every pane it opened and touches no other window. tmux pane ids (`%N`) restart with every tmux server, so each pane ach opens is tagged with the pane option `@ach_run` (the token is also kept under `<tmpdir>/ach-desks-tmux`), and closing kills a pane only when its tag still matches; a reused id, or a pane from before tagging, is left alone. Ghostty closing signals the recorded pid only when its command line still matches what ach launched and its start time fits that open's pidfile (a reused pid starts after the pidfile was written, so the same executable and script is not enough).

## Web

`ach web` serves a Desks view at `/desks`: the desk layout, a lane strip (goal, status, plan progress, cost), a message timeline, decision cards you answer with one click, and cost per desk and lane tree. It uses the Web API below.

`ach web` refuses cross-site requests on every route and WebSocket upgrade: on a loopback bind the `Host` must be `127.0.0.1`, `localhost` or `[::1]` with the bound port (421), a present `Origin` must match the `Host` (403), and a non-GET `/api/*` request with a body must be `application/json` (415). A POST with no body (kill, continue) passes.

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
GET  /api/desks/:name/events?since=<seq> -> {events: HostEvent[]}
GET  /api/desks/:name/attach            -> {argv: string[]}   (the command that attaches a terminal to the desk or lane; 404 unknown, 409 dead)
GET  /api/desks/costs                   -> {rows: DeskCostRow[]}
GET  /api/desks/engines                 -> {engines: {agent, found, path?, auth?}[]}
GET  /api/desks/mcps                    -> {names: string[]}
```

Every route also takes `?stack=<name>` to pick a stack (default: the server's own). When the server runs with a token, pass it as `?token=<token>` or `Authorization: Bearer <token>`.

The page keeps its chats live across a stream reconnect: a new stream subscribes to hosts from "now", so on every (re)open, and again after the first roster snapshot, the page refetches `/api/desks/:name/events?since=<lastSeq>` for each loaded chat and drops duplicates by seq.

Errors are `{error: string}` with a status picked from the service message:

| Status | Message shapes (src/desks/*.ts) |
|---|---|
| 400 | `... must not be empty`, `must be an array` / `a non-empty string`, `every decision option needs a label`, `invalid lane name`, `invalid stack name`, `invalid desk or lane name`, `invalid run id`, `cannot send to yourself`; bad JSON or body fields, or a path segment holding `/`, `\` or a leading `.` (HttpError) |
| 401 | missing or wrong token |
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
