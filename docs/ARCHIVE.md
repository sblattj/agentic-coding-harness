# Transcript warehouse (`ach archive`)

The agent CLIs own their transcript directories and prune them: Claude Code removes sessions
after about 30 days. Once a transcript is gone, `ach stats` can no longer count it, and
`ach audit`, the `ach web` transcript pane and MCP `harness_run_events` lose their source.
`ach archive` copies those files into a warehouse under the state dir, where the CLIs never look.

```
ach archive [--agent A] [--days N] [--out DIR] [--state-dir <stateDir>] [--json]
ach archive --restore <batch|latest|all> [--to DIR] [--out DIR] [--json]
```

## What gets archived

| kind     | source                                                                  | stored at                                   |
|----------|-------------------------------------------------------------------------|---------------------------------------------|
| `native` | machine transcripts `ach stats` reads: `~/.claude/projects/**/*.jsonl` (subagent files included), `~/.codex/sessions/**/*.jsonl`, `~/.gemini/tmp/*/chats/*.json`, plus every read-only source (amp, goose, qwen, cursor; roots in [transcript-adapters.md](transcript-adapters.md), SQLite stores snapshotted) | `<batch>/native/<agent>/<path under the source dir>` |
| `raw`    | harness raw transcripts referenced by `RunRecord.rawTranscript` (`<stateDir>/raw/<agent>-<session>.jsonl`) | `<batch>/raw/<basename>` |
| `record` | registry records `<stateDir>/runs/<runId>.json`                          | `<batch>/runs/<runId>.json`                 |

The warehouse root is `<stateDir>/warehouse/` by default (`--out DIR` overrides it). Each run that
copies at least one file creates one batch, `<warehouse>/<batch>/`. The batch id is a date-led UTC
timestamp such as `2026-09-28T04-55-15.924Z`, and each batch has its own `manifest.jsonl`, with
one line per copied file:

```json
{"v":1,"batch":"2026-09-28T04-55-15.924Z","kind":"native","agent":"claude",
 "sourcePath":"<home>/.claude/projects/<project>/<uuid>.jsonl",
 "relPath":"<project>/<uuid>.jsonl",
 "archivePath":"2026-09-28T04-55-15.924Z/native/claude/<project>/<uuid>.jsonl",
 "sha256":"03e31be7…","size":230,"mtimeMs":1790571315922.2114,
 "sessionId":"<uuid>","runId":null,"archivedAt":"2026-09-28T04:55:15.924Z"}
```

- `sha256`, `size` and `mtimeMs` describe the source file at copy time. The copy keeps the
  source's mtime.
- `sessionId` is taken from the file name: the Claude session file or its `<session>/subagents/`
  parent, the trailing UUID of a Codex rollout, or the Gemini chat stem. It is `null` when the
  name does not contain one; ach never guesses.
- `runId` links the file to a registry record: through `rawTranscript` for `raw` files, and
  through a matching `(agent, sessionId)` for `native` files. It is `null` when no harness run
  produced the file. That is the usual case for native files, because `ach run --agent claude`
  uses a per-run `CLAUDE_CONFIG_DIR`, so its transcript lands in the harness's `raw` file rather
  than under `~/.claude/projects`. When several records share one resumed-session raw file, all
  of them are listed in `runIds`.

## Idempotence and safety

- **Unchanged files are never copied again.** If a file's size and mtime match its newest
  archived copy, it is skipped without being hashed. Otherwise it is hashed, and it is skipped if
  the same sha256 is already archived for that source path. A second `ach archive` with nothing
  new writes no batch and no manifest lines (`"batch": null, "archived": 0`).
- **A file that grew gets a new copy in a new batch.** Claude sessions are appended to, so this
  happens as sessions continue. Older copies are kept.
- **Nothing is ever deleted.** This covers both the warehouse and the live directories. Each
  copy is written to `*.tmp-<pid>` and then renamed into place. The manifest is written last, so
  an interrupted run leaves no half-indexed batch, and readers ignore a batch that has no
  manifest.
- `--agent A` archives only that agent's files. `--days N` keeps `native` and `raw` files whose
  mtime falls within the last N days, and records whose `endedAt`, `updatedAt` or `startedAt`
  (the first one set) falls within the window.

## Reading from the warehouse

- **`ach audit`, `ach web` transcript panes, MCP run events.** All three resolve a run's
  transcript through `resolveRawTranscript`. If the stored path and the relocated
  `<stateDir>/raw/<basename>` are both missing, it now returns the newest archived copy from
  `<stateDir>/warehouse`. This happens automatically and needs no flag. A live file always wins.
- **`ach stats --with-warehouse`.** Adds the newest archived copy of every `native` and `raw`
  transcript whose live file is gone. The records go through the same `--agent`, `--days` and
  dedupe path as live records, so running it while the live files still exist gives the same
  totals as plain `ach stats`. `--state-only` still skips machine transcripts, including the
  archived ones.
- The fallback only looks in the default `<stateDir>/warehouse`. A warehouse written with
  `--out DIR` elsewhere is read only through `--restore` (with `--out DIR` as well).
- The fallback covers transcripts, not registry records. If `<stateDir>/runs/*.json` itself is
  deleted, `ach archive --restore` it back.

## Restore

```
ach archive --restore 2026-09-28T04-55-15.924Z --to /tmp/restored
ach archive --restore all --to /tmp/restored     # newest copy of every file, all batches
ach archive --restore latest --to /tmp/restored  # the newest batch only
```

A restore writes a home-shaped tree:

```
<to>/.claude/projects/…   <to>/.codex/sessions/…   <to>/.gemini/tmp/…
<to>/.local/share/amp/threads/…   <to>/.qwen/projects/…   (each read-only source under its home-relative root)
<to>/.agentic-coding-harness/raw/…   <to>/.agentic-coding-harness/runs/…
```

`ach stats --transcript-dir <to>` (alias `--dir`) reads the machine transcripts from that tree. Setting
`AGENTIC_CODING_HARNESS_STATE_DIR=<to>/.agentic-coding-harness` gives `ach audit`, `ach dash` and
`ach web` the restored records. Relocated raw transcripts are found by basename, so the absolute
paths stored in the records do not need rewriting. A single batch contains only the files that
were new or changed in that run. Use `all` to rebuild everything.

## Scheduling

ach has no built-in scheduler. It stays a CLI, and the warehouse is a command you run on a
schedule. Run it at least weekly, well inside Claude Code's roughly 30-day retention. Use
absolute paths: launchd and cron do not load your shell profile. Find the binary with
`command -v ach`.

**cron** (`crontab -e`). This runs daily at 03:15 and appends the JSON result to a log:

```cron
15 3 * * * /usr/local/bin/ach archive --json >> "$HOME/.agentic-coding-harness/archive.log" 2>&1
```

**launchd** (macOS). Save the following as `~/Library/LaunchAgents/com.agentic-coding-harness.archive.plist`,
replacing `/Users/me` and the `ach` path:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.agentic-coding-harness.archive</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/ach</string>
    <string>archive</string>
    <string>--json</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <!-- only needed for a non-default state dir -->
    <key>AGENTIC_CODING_HARNESS_STATE_DIR</key><string>/Users/me/.agentic-coding-harness</string>
  </dict>
  <key>StartCalendarInterval</key>
  <dict><key>Hour</key><integer>3</integer><key>Minute</key><integer>15</integer></dict>
  <key>StandardOutPath</key><string>/Users/me/.agentic-coding-harness/archive.log</string>
  <key>StandardErrorPath</key><string>/Users/me/.agentic-coding-harness/archive.log</string>
</dict>
</plist>
```

Load it with `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.agentic-coding-harness.archive.plist`.
If `ach` was installed through a Node version manager (fnm, nvm), its path moves when Node
changes. In that case, point `ProgramArguments` at a stable `node` binary and the package's
`dist/cli/ach.js`.

## `--json` output

This output is from a real run against a one-file fixture home. The first call copies the file:

```json
{
  "warehouseDir": "<stateDir>/warehouse",
  "batch": "2026-09-28T04-55-15.924Z",
  "archived": 1,
  "unchanged": 0,
  "bytes": 230,
  "byKind": { "native": 1, "raw": 0, "record": 0 },
  "entries": [ { "v": 1, "kind": "native", "agent": "claude", "sha256": "03e31be7…", "runId": null, "…": "…" } ]
}
```

The second call finds nothing new:

```json
{ "warehouseDir": "…/warehouse", "batch": null, "archived": 0, "unchanged": 1, "bytes": 0,
  "byKind": { "native": 0, "raw": 0, "record": 0 }, "entries": [] }
```

`--restore --json` prints `{batch, to, restored, stateDir, files}`.
