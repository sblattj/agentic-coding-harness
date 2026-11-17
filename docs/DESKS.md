# Desks and lanes

A small team of agents that message each other, with ach metering every one of them (issues #204 and #205).

- A **desk** is a long-lived, named agent session with a role prompt and a fixed set of MCP servers. A desk never runs a goal.
- A **lane** is a short-lived session that starts inside a goal, does one unit of work, and reports to the desk that launched it.
- A **message** is text delivered into another session as a user turn, prefixed `[desk-msg from <NAME>]`. A turn with no header was typed by the human, who outranks every peer.
- The **roster** is one JSON file and the only source of truth for who is alive and where.

The default layout has three desks:

```
+------------------+-----------------+
|                  | DECISIONS       |   tmux window "desks"
| ORCHESTRATOR     +-----------------+   each lane = one more window
|                  | LISTENER        |
+------------------+-----------------+
```

| Desk | Port | Tools (plus the `ach` desk tools) | Job |
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
| `GET /goal`, `POST /goal {objective}` | goal status; set a goal (returns once active, up to 40 s) |
| `GET /mcp` | engine-reported MCP status by name |
| `GET /events?since=<seq>` | events; SSE with `Accept: text/event-stream` |
| `GET /attach` | the argv a terminal pane runs to show the session |
| `POST /stop` | stop feed and engine, then exit |

Identity comes from the environment (`ACH_DESK_NAME`, `ACH_DESK_STACK`), never from tool arguments, so a session cannot send as someone else. Self-send is refused. Every message is a `message_in` event in the target's run and a `message_out` event in the sender's, so replay shows the conversation.

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
| `lanes` | LanesSpec | required | Lane defaults. |

### DeskSpec

| Field | Type | Default | Meaning |
|---|---|---|---|
| `name` | string | required | Unique, `/^[A-Z][A-Z0-9_-]{0,31}$/`. |
| `role` | string | required | Role prompt: `<rolesDir>/<role>.md`, then built-in `roles/`. |
| `agent` | string | `layout.agent` | Agent CLI for this desk. |
| `model` | string | `layout.model` | Model for this desk. |
| `mcps` | string[] | required | MCP server names this desk gets. The `ach` desk tools are always added. Anything else is forced off. |
| `pane` | `left` \| `right-top` \| `right-bottom` \| `none` | none | Where its pane goes in the desks window. |
| `feed` | FeedSpec | none | Event source for this desk. |
| `cwd` | string | `layout.cwd` | Working directory. |

### FeedSpec

| Field | Type | Default | Meaning |
|---|---|---|---|
| `command` | string[] | required | argv; stdout is JSONL, one object per line, each with a string `type`. |
| `fullContext` | string[] | none | argv printing the full context so far; sent as ONE message on the first heartbeat when active. |
| `activeCheck` | string[] | none | argv printing JSON with a boolean `active`, checked on the first heartbeat. |
| `batchSeconds` | number | `10` | Batch window for non-immediate events. |
| `immediate` | string[] | none | Event types that flush the batch and are delivered at once. |
| `heartbeatType` | string | `alive` | Event type meaning the backlog is over. Everything before the first one is backlog. |
| `endType` | string | `call_ended` | Event type that ends a session of the source; triggers the closing message. |

If `activeCheck` says nothing is active, the desk gets one "waiting for the next call" note instead of context. Other feeds (CI events, review events, a chat watcher) use the same shape.

### LanesSpec

| Field | Type | Default | Meaning |
|---|---|---|---|
| `defaultMcps` | string[] | required | MCP names a lane gets when `lane_new` passes none. |
| `ports` | `[lo, hi]` | `[10, 99]` | Port offsets from `portBase`, inclusive. |
| `approval` | `decisions` \| `none` | `none` | With `decisions`, `lane_new` from a desk other than DECISIONS (or the human) returns a pending request until `lane approve`. |
| `defaultGoalFlags` | string | none | Prefixed to every lane objective, e.g. `--max-minutes 45`. |
| `agent`, `model` | string | layout values | Defaults for lanes. |
| `budgetUsd` | number | none | Default per-lane budget; feeds the existing [budget alerts](BUDGET-ALERTS.md). |

## State files

Under `<stateDir>/desks/<stack>/`:

| File | Content |
|---|---|
| `roster.json` | the roster (atomic rewrite under a lock) |
| `roster.lock/` | the lock directory |
| `messages.jsonl` | one `DeskMessage` per line |
| `decisions.jsonl` | `open`, `answer` and `close` events, folded into the current decision list |
| `pending-lanes.jsonl` | lane approval requests: request, approve, reject |
| `specs/<name>.json` | the host spec handed to `ach desk host` |
| `events/<runId>.jsonl` | the run's desk transcript |
| `logs/<name>.log` | host stdout and stderr |
| `layout.json` | the resolved layout `desk up` used |

The stack name is `--stack`, else `$ACH_DESK_STACK`, else `<stateDir>/desks/active-stack`, else `default`.

## CLI

```
ach desk up [--layout F] [--port-base N] [--term tmux|ghostty|none] [--tmux-session S] [--stack S]
ach desk down
ach desk attach [--term tmux|ghostty|none] [--tmux-session S]
ach desk send <to> <text>
ach desk roster [--json]
ach desk inbox [name] [--json]
ach desk answer <Dn> <text>
ach desk decisions [--json]
ach desk engine <name> <agent> [--model M]
ach desk host --spec <file>              internal: the per-desk host process
ach desk chat <name>                     attach REPL for engines without a native TUI

ach lane new <name> --goal "<objective>" [--agent A] [--model M] [--mcps a,b] [--cwd D] [--budget-usd N]
ach lane status [name] [--json]
ach lane stop <name>
ach lane approve <Ln>
ach lane reject <Ln> [--reason R]
```

- `desk up` refuses when any desk of the stack is alive. `--port-base` overrides the layout (a test stack beside the live one). `--tmux-session` picks the tmux session that gets the `desks` window and the lane windows.
- `desk down` stops every lane, then every desk (feed, pane, host), and leaves an empty roster with no processes.
- `desk send` and `desk answer` send as `human`.
- `desk engine` restarts one desk on another agent, keeping its roster slot, message history and decisions.
- `lane stop` refuses desk names. It closes the pane, stops the host and removes the roster entry.
- `--json` prints the `RosterView` (stack, `portBase`, rows with state, queue depth, goal status and cost, pending lanes, open decisions). Without it, a table.

## MCP tools

Registered on `ach mcp` for every desk and lane session (identity from `ACH_DESK_NAME`):

| Tool | Args | Behavior |
|---|---|---|
| `desk_roster` | none | `me` plus peers with role, busy/idle/dead, tools, goal |
| `desk_send` | `to, text` | refuses self and unknown names; returns at once; do not wait or poll |
| `desk_inbox` | `limit` | recent messages to or from the caller |
| `lane_new` | `name, goal, mcps?, cwd?, agent?, model?, budgetUsd?` | start a lane, or `{pending}` when approval applies |
| `lane_status` | `name?` | goal state, verified plan actions, evidence |
| `lane_stop` | `name` | refuses desk names |
| `lane_approve` | `id` | approve a pending lane |
| `decision_open` | `question, options, askedBy` | add a question for the human |
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

Switch a running desk with `ach desk engine <name> <agent>`. A missing engine fails at start with a clear error (see [Troubleshooting](#troubleshooting)).

## Terminals

| Driver | Notes |
|---|---|
| `tmux` (default) | One `desks` window with three panes, one window per lane, all opened without taking focus. Works over SSH. Closing is immediate. |
| `ghostty` | Optional, macOS. Panes are addressed by terminal id. |
| `none` | No panes; use the web view, the app or `ach desk chat`. |

`--term` picks the driver; the default is tmux. The pane ids are stored in the roster as `{kind, id}`.

**Moving a running stack.** Hosts, sessions, the roster and feeds do not depend on panes. `ach desk attach --term tmux` closes the old panes and reopens them on the same sessions; history is intact and feeds never stop. `ach desk down` closes every pane it opened and touches no other window.

## Web

`ach web` serves a Desks view at `/desks`: the desk layout, a lane strip (goal, status, plan progress, cost), a message timeline, decision cards you answer with one click, and cost per desk and lane tree. It uses the Web API below.

### Web API

JSON; SSE where noted. Versioned as `desks-api/1`.

```
GET  /api/desks                         -> RosterView
GET  /api/desks/messages?since=<ms>     -> {messages: DeskMessage[]}
GET  /api/desks/stream                  -> SSE: message | roster | event | decision
GET  /api/desks/decisions               -> {decisions: Decision[]}
POST /api/desks/decisions/:id/answer {text} -> Decision   (delivers the answer to askedBy and to DECISIONS)
POST /api/desks/send {to, text}         -> DeskMessage   (from "human")
POST /api/desks/up {layoutFile?}        -> RosterView
POST /api/desks/down                    -> {stopped: string[]}
POST /api/desks/lanes {name, goal, mcps?, cwd?, agent?, model?, budgetUsd?} -> RosterEntry | {pending: PendingLane}
POST /api/desks/lanes/:name/stop        -> {}
POST /api/desks/pending/:id/approve     -> RosterEntry ; /reject {reason?} -> PendingLane
POST /api/desks/:name/engine {agent, model?} -> RosterEntry
GET  /api/desks/:name/events?since=<seq> -> {events: HostEvent[]}
GET  /api/desks/costs                   -> {rows: DeskCostRow[]}
GET  /api/desks/engines                 -> {engines: {agent, found, path?, auth?}[]}
GET  /api/desks/mcps                    -> {names: string[]}
```

## macOS app

`apps/ach-desk` is a native SwiftUI app (macOS 14+) over the same Web API. It starts the default layout without a terminal, shows pending decisions in the menu bar, answers decisions from notification banners, and starts lanes from a sheet. Engines are a setting; the app never talks to an agent CLI. See the README in that directory.

## Cost

Every desk and lane is an ach run, so everything is metered.

```bash
ach stats --by desk         # per desk and per lane, keyed <stack>/<name>; other records land in (none)
ach desk roster --json      # costUsd and treeCostUsd per row
```

Lane cost rolls up under the launching desk. A per-lane budget (`--budget-usd`, `lanes.budgetUsd`) uses the existing [budget alerts](BUDGET-ALERTS.md).

## Troubleshooting

- **Port busy.** Another stack (or a stray process) holds a port. Pick another `portBase` (`ach desk up --port-base 4900`) to run beside it, or find and stop the owner. Lanes pick the next free port in their range.
- **`desk up` refuses.** A desk of that stack is still alive. Run `ach desk roster`, then `ach desk down`.
- **Stale roster entries.** `ach desk roster` prunes entries whose host is dead. After a crash, `ach desk down` clears the rest.
- **Engine not found.** The agent CLI is not on PATH. Check `GET /api/desks/engines` or `ach doctor`, then fix the install or set `agent` to another engine.
- **A desk has the wrong tools.** Compare the host's `GET /mcp` with its `mcps` in the layout; only those plus the `ach` desk tools should be enabled.
- **Messages not arriving.** Read `messages.jsonl` and `events/<runId>.jsonl`, and `logs/<name>.log` for the host.
- **Panes missing.** `ach desk attach` reopens them on the running sessions.
