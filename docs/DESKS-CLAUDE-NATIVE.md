# Desks and lanes on Claude Code's native plumbing (#204, alternative take)

Written before reading #206's diff, so the two designs can be compared on the same axes.

## Thesis

Claude Code already ships most of what a desk layer needs: named sessions (`-n`), a roster
(`claude agents --json`), background sessions (`--bg`, `stop`, `attach`, `logs`), a per-session
inbox socket that takes a JSON line, and per-session inbound controls (`crossSessionInbound`).
ach should not build a second bus for Claude. It should launch sessions correctly, verify they are
what they claim to be, deliver messages through the native inbox, and record each lane as an ach run.
Other engines get adapters behind the same three calls later.

## Axes

| Axis | This design |
|---|---|
| Transport | Claude's inbox socket (`messagingSocketPath` in `~/.claude/sessions/<pid>.json`): one optional auth line, then `{"type":"user","message":{"role":"user","content":...}}`. Claude-to-Claude keeps using native `SendMessage`; ach only sends when the sender is not a Claude session (a human, a script, another engine). |
| Busy-safe delivery | Claude queues an inbox message until the current turn ends, so no typing over a live prompt. |
| Bypass receivers | A bypass session holds messages from senders it can't classify. ach launches its desks and lanes with `--settings '{"crossSessionInbound":"accept"}'` so its own messages land; it reports `held` rather than guessing when they don't. |
| Roster and liveness | `claude agents --json` (supported, scriptable) joined with `~/.claude/sessions/<pid>.json` for the socket path and job id. A live process is not enough: a `bg` session in status `shell` with no transcript is an empty spare and does not hold a name, unless it is an exit handoff (below) still running a shell it adopted. |
| Duplicate names | Refuse to launch a name a live, non-spare session holds; stop an empty spare that holds it; never signal an exit handoff that carries live work. |
| Lane goal | The goal text (or a goal file path) becomes the first prompt. No goal plugin required; a `/goal`-style condition is just text the lane is told to meet and report on. |
| Terminal coupling | None by default: lanes start as Claude background sessions (`claude --bg`), which survive the launcher, need no window and can be attached later. An opener command (`--open-with`) is optional for people who want tabs. |
| Successor handoff | `ach lane new --after <pid|name>` waits in a detached process (`setsid`-style, its own process group, no terminal tab) for the predecessor to exit, then launches. Nothing a tab cleanup can close. |
| Metering | `claude --bg` ignores `--session-id`, so the id is read back from the roster once the session registers (matched by the job id `--bg` prints) and kept in `<stateDir>/lanes/<name>.json`. `ach lane status` reads tokens from that transcript with the existing claude normalizer. Lane records are not RunRecords yet. |
| Proof | After launch, ach waits (45 s max) for a live session with that name and job id and fails loudly if none registers. |

## Exit handoffs (found while building this)

When a Claude session exits with a background shell still running, Claude moves it into a bg
job that keeps the session's name (`~/.claude/jobs/<id>/state.json`, `nameSource: "user"`) and
adopts the shells (`adopt.json`, `origin: "exit"`). The daemon hands that job to a pre-warmed
process, so it shows up as a `bg` session in status `shell` with no transcript, holding the old
name. That is what held a desk's name in the incident below. It looks empty but may be running a
watch loop. So:

- a handoff whose adopted shells are all dead counts as an empty spare and may be stopped;
- a handoff with a live adopted shell counts as live and is never signalled;
- sessions that retire through handoff files (desks) should launch with
  `CLAUDE_CODE_DISABLE_BG_EXIT_HANDOFF=1`, so no handoff job is made; their bg loops then die
  on exit unless they are moved to a lane first.

## Verified live

`ach lane new ach-smoke-lane --goal ... --model haiku` registered as a bg session, `ach desk send`
posted `ping-42` to its inbox from a plain shell (no Claude sender), the lane answered
`PONG ping-42` in a second turn, `ach lane status` showed 2 turns from the transcript, and
`ach lane stop` removed it from the roster.

## Not in this slice

- desks.yaml layouts, feeds, LISTENER-style followers
- non-Claude receivers (opencode HTTP, codex, kiro)
- budgets and trials over lanes

## Incident checklist (from a real retirement that left no orchestrator)

1. An empty background spare took a desk's name the second the old desk exited and fooled the liveness check.
2. The script that was waiting to launch the successor lived in a terminal tab, and a tab cleanup closed it.
3. The old desk exited with nothing left to launch its successor.

This design answers them with: spare- and handoff-aware liveness (1), no tab for the waiter (2), and `--after`,
which is armed before the predecessor exits and survives it (3).
