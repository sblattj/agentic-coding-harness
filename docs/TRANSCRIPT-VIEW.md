# Transcript view (`ach web`)

The run page (`/`) of `ach web` has two layouts for the selected run, picked with
the **feed | transcript** toggle above the pane:

- **feed** (default): the structured event feed, unchanged. Every row the run
  wrote (text, tool cards, progress, usage, warnings, exit status).
- **transcript**: the run as a conversation. `/?view=transcript` opens it
  directly; the toggle keeps the choice in the URL.

## What the transcript shows

The transcript is rendered in the browser (`HarnessFeed.createTranscript` in
`src/web/feed.js`) from the same persisted `AgentEvent` rows the feed reads,
delivered over the same `/ws?runId=` socket. Nothing new is captured and no event
field was added.

- **Turns.** A `message` event with `source: "user"` opens a turn. The agent's
  replies, reasoning, tool calls and errors that follow land in that turn, in
  the order they were written.
- **Turn 1 without a prompt event.** Headless runs pass the prompt on the command
  line, so most agents never write it as an event. Turn 1 then shows the run
  record's `promptPreview` (its first 120 characters), labelled "prompt preview
  from the run record". Without one it says "prompt not in the transcript".
- **Tool calls** are collapsed rows: tool name, a one-line summary of the
  arguments (or the producer's title), a status chip (pending, ok, error) and the
  call's duration. Click or press Enter to expand the arguments and the result.
  A call still open when the run ends shows a `·` chip ("no result recorded").
- **Timestamps.** Every turn header carries the ISO time of its first event;
  every bubble and tool row shows its own event time (offset from the first
  event plus UTC clock time, the full ISO value on hover).
- **Streamed text** (kiro chunk steps) builds one reply bubble per contiguous
  stream; the confirming `message` that follows folds into it, never drawn twice.
- **Left out on purpose:** progress heartbeats, usage lines and model-call
  bounds. They stay in the feed and in `/trio`.
- **Live runs** update as the server tails new events (every 500 ms, the feed's
  cadence). The view follows the tail while you are at the bottom; scroll up and
  it stops, with a **latest** button to jump back.
- **Raw JSON.** Hover a bubble or tool row and click `{}` for the original events.

## Content capture tiers

Runs recorded under a capture tier below `full` ([CAPTURE.md](CAPTURE.md)) hold
less text, and the transcript says so rather than drawing it as conversation:

| Tier | Transcript |
|---|---|
| `full` | everything as written |
| `metadata` | a banner names the tier; the turn structure, tool names, status and timings remain; each stripped prompt, reply, reasoning block, argument summary and result reads "... not captured (capture mode metadata)". The expanded arguments still show the recorded shape (argument names, values stripped). |
| `off` | a banner says the run kept only lifecycle and token events; no turns are drawn, only the exit status line |

The tier comes from the run record's `captureMode`. A record written before #72
has none; stripped strings are still recognised and read "not captured
(stripped at record time)".

## Privacy

The transcript shows the same local data the feed already shows, from the same
socket, so it follows the feed's access rules (the `/ws` token). It is a view,
not an export: it does not pass through `maskForExport`. To share a run, use
`ach export` with `--mask` / `--privacy` ([EXPORT.md](EXPORT.md)).
