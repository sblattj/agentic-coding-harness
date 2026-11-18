# ach Desk (macOS)

A native SwiftUI app (macOS 14+) for the ach desks stack (issue #205). It talks only to the
ach Web API under `/api/desks` served by `ach web`; it never reads state files or tmux directly.

## Build, test, run, bundle

```sh
cd apps/ach-desk
swift build                 # debug build
swift test                  # unit + mock-server tests (no GUI, no real ach)
ACH_DESK_LIVE_PORT=8399 swift test --filter LiveServerTests  # opt-in: decode every endpoint from a real `ach web` with a stack up
swift run AchDesk           # runs unbundled: works, but notifications are disabled (see Limitations)
zsh scripts/bundle.sh       # -> build/ach Desk.app (release, ad-hoc signed)
zsh scripts/bundle.sh --with-ach /path/to/ach   # also copy an ach binary into Contents/Resources
open "build/ach Desk.app"
```

Requirements: Xcode or the Command Line Tools with Swift 6. On a CLT-only machine the built-in
`Testing` module is not visible to `swift test`, so the package pins
[swift-testing](https://github.com/swiftlang/swift-testing) by revision (tag
`swift-6.3.2-RELEASE`) and links `lib_TestingInterop` from the CLT. The first build needs network
access to resolve that dependency (it is a test-only dependency; the app does not link it).

`bundle.sh` writes `Info.plist` with bundle id `dev.ach.desk`, `LSMinimumSystemVersion` 14.0,
`LSUIElement` false and `NSUserNotificationAlertStyle` alert, then runs
`codesign -s - --force --deep` and `codesign -v`.

## How it finds and starts ach

1. Probe `GET /api/desks` on `127.0.0.1:<port>` (Settings, default 8399) with the token. `ach web`
   always has a token: with the Settings token empty, the app uses the one `ach web` generates and
   keeps in `<stateDir>/web/token` (state dir: Settings, else `AGENTIC_CODING_HARNESS_STATE_DIR`,
   else `~/.agentic-coding-harness`, the same rule as the CLI). So an `ach web` you started in a
   terminal with no `--token` is reused without copying anything into Settings.
   - 200 with a roster: reuse that server. The app will not stop a server it did not start.
   - Any other HTTP answer (401, 404, ...): the port is busy with something else, so the app
     shows a banner with a hint (wrong token, or an `ach` too old to have the desks API).
2. If nothing listens and "Start ach web when none is serving" is on, resolve `ach` in this order:
   - the path in Settings,
   - `/bin/zsh -lc 'command -v ach'` (your login shell PATH, so Homebrew/bun installs work from Finder),
   - `Contents/Resources/ach` inside the app (only present with `--with-ach`).
3. Start `ach web --port <port> --no-open` as a child process with no terminal. Output goes to
   `~/Library/Logs/ach Desk/ach-web.log` (Settings > Show log). A Settings token is passed as
   `AGENTIC_CODING_HARNESS_HTTP_TOKEN` (env, so it never shows in `ps`) and the state dir as
   `AGENTIC_CODING_HARNESS_STATE_DIR`. With no Settings token the child generates
   `<stateDir>/web/token` at startup and the app reads it while it waits for the server.
4. On quit the app sends SIGTERM (then SIGKILL after a grace period) only to a child it started.
   "Stop the stack on quit" (off by default) also calls `POST /api/desks/down` first, and only
   when the app started `ach web` itself.

The default is your installed `ach`, because standalone ach builds lack bun-pty.

## API used

Every request carries the token (Settings, else `<stateDir>/web/token`) both as
`Authorization: Bearer <token>` and `?token=<token>`; without it every route answers 401. Shapes mirror `src/desks/types.ts`; unknown fields are ignored, optional fields
are optional, and unknown stream kinds and event types are tolerated.

| Route | Used for |
|---|---|
| `GET /api/desks` | roster: desks, lanes, pending approvals, open decisions; also the probe |
| `GET /api/desks/stream` (SSE) | live `message` / `roster` / `event` / `decision` items |
| `GET /api/desks/messages?since=` | Messages tab, desk chat |
| `POST /api/desks/send {to, text}` | desk chat send box |
| `GET /api/desks/decisions` | Decisions tab |
| `POST /api/desks/decisions/:id/answer {text}` | answering (card or notification) |
| `GET /api/desks/:name/events?since=` | desk timeline, live-call rule, HUD |
| `POST /api/desks/lanes {name, goal, mcps?, cwd?, agent?, model?, budgetUsd?}` | New lane sheet |
| `POST /api/desks/lanes/:name/stop` | Stop button, lane notification action |
| `POST /api/desks/pending/:id/approve`, `/reject {reason?}` | pending approvals |
| `POST /api/desks/up {}`, `POST /api/desks/down` | Start/Stop stack |
| `POST /api/desks/:name/engine {agent, model?}` | per-desk engine in Settings |
| `GET /api/desks/costs`, `/engines`, `/mcps` | costs, engine picker, tool toggles |

Live updates: the SSE stream reconnects with exponential backoff (0.5 s doubling to 30 s,
honoring `retry:`), sends `Last-Event-ID`, and refetches everything on reconnect. After 2
failed connects in a row the app also polls every 2 s until the stream is back.

## Acceptance mapping (#205)

| Item | How it is covered | How to check |
|---|---|---|
| App finds or starts ach web | `BackendLauncher`, `BackendBoot` | tests `LauncherTests`; live: quit any `ach web`, open the app, see `ach web` in `ps` and the log |
| Default layout comes up | "Start the stack on launch" posts `/up` when the roster has no desks | live: open with no stack running |
| Desks: cards and chat | `DesksView`, `DeskChatView` (messages + events + send) | tests check the send body; live: send to a desk and see the reply |
| Raw terminal | Desk chat > "Raw terminal..." shows the attach argv with Copy, plus engine URL | live: paste the copied command in a terminal |
| Lanes: cards, Stop, New lane, approvals | `LanesView` (goal, state, plan n/m, elapsed, cost, budget bar) | tests check the lane, stop, approve and reject bodies; live: create a lane, watch it run, stop it |
| Decisions with recommended first | `DecisionsView`, `Decision.orderedOptions` | tests `DecodingTests`, `ViewModelTests`; live: a desk asks a question |
| Badge on sidebar and Dock | `Derived.decisionBadgeCount` | tests; live: Dock tile shows the count |
| Messages with desk filter | `MessagesView` | live |
| SSE with reconnect, polling fallback | `SSEParser`, `SSEStreamClient`, `Backoff` | tests `SSEParserTests`, `StreamClientTests`; live: restart `ach web`, footer goes Reconnecting then Live |
| Menu bar | `MenuBarView`: decisions, live call, running lanes, cost today, open window, start/stop | live |
| Notifications answer without opening the window | `Notifier` + `NotificationPlan` (non-foreground actions) | tests map actions to answers; live in the bundled app |
| Lane achieved/blocked notifications with Open/Stop | `Derived.laneTransitions`, `NotificationPlan.laneCategory` | tests; live |
| Talking-points HUD with hotkey | `HUDController` (non-activating floating panel, all spaces), Ctrl-Opt-Cmd-T | live |
| Settings incl. per-desk engine | `SettingsView` | tests check the engine body; live |

## Limitations

- **No embedded terminal.** The Web API has no attach route, so the app shows
  `ach desk chat <NAME>` (from the `ach desk` CLI) with a Copy button. Run it in your terminal.
- **Live-call indicator is a heuristic:** the desk has a `feedPid`, its newest `feed` event is under
  10 minutes old, and either `data.active` is true or the feed note contains none of: ended, exit,
  stopped, waiting, inactive, not active, idle, closed, error, failed. The feed note wording is not fixed by the contract yet.
- **"Cost today"** sums `costUsd` of lanes that started since local midnight; the contract has no
  dated cost series.
- **Notifications** need the bundled `.app` (UNUserNotificationCenter requires a bundle id). Under
  `swift run` they are skipped. First launch asks for permission. Notification buttons show up to 3
  options (recommended first, marked) plus a Reply text field; a decision with more options can be
  answered by typing or from the Decisions tab.
- **Hotkey:** Ctrl-Opt-Cmd-T toggles the HUD from any app. It uses Carbon `RegisterEventHotKey`,
  which needs no Accessibility or Input Monitoring permission. It is fixed (not yet configurable)
  and fails silently if another app already owns that combination; the Window menu item "Toggle Talking Points HUD" still works.
- The app is ad-hoc signed, so Gatekeeper may ask on first open of a copied build (right click > Open).
