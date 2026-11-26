# Full data export (`ach export`)

`ach export --out <dir>` writes everything the harness recorded about your runs into one
directory: for a backup, a move to another machine, feeding another tool, or knowing exactly what
exists before you erase it. Code: [`src/cli/export.ts`](../src/cli/export.ts).

```sh
ach export --out ./dump                          # runs, events, transcripts, stats, manifest
ach export --out ./dump --no-transcripts         # leave the archive warehouse out
ach export --out ./dump --include-machine-dirs   # also copy ~/.claude, ~/.codex, ... transcripts
ach export --out ./dump --json                   # {"out","written","skipped","removed","counts"}
ach export --out ./dump --mask all               # masked copies (docs/MASKING.md)
```

The state dir is the usual one: `AGENTIC_CODING_HARNESS_STATE_DIR`, the config file's
`stateDir`, else `~/.agentic-coding-harness`. `--out` must be outside it.

## What lands where

| In the dump | From | Notes |
|---|---|---|
| `runs/<runId>.json` | `<stateDir>/runs/*.json`, the run registry | Copied byte for byte, never re-serialized. A file that does not parse as a RunRecord is copied too and listed under `unreadableRunRecords`. In-flight `*.tmp-<pid>` files are skipped. |
| `events/...` | everything under `<stateDir>/raw/`, relative paths kept | The driver's per-run event logs (`raw/<agent>-<session>.jsonl`, the file `RunRecord.rawTranscript` names) and the watch and desk usage records (`raw/<agent>/<session>.jsonl`). This is the data the state side of `ach stats` reads. |
| `events/external/<name>` | a `RunRecord.rawTranscript` that resolves outside the state dir (an old, moved state dir) | Always listed in the manifest's `externalEventFiles`; copied only with `--include-machine-dirs`. |
| `transcripts/warehouse/...` | `<stateDir>/warehouse/`, the `ach archive` warehouse ([ARCHIVE.md](ARCHIVE.md)) | Copied whole, so each batch's `manifest.jsonl` still matches its files; archived `raw` and `record` copies ride along with the `native` transcripts. `--no-transcripts` omits it. |
| `transcripts/machine/<agent>/...` | the machine transcript dirs `ach stats` scans (`~/.claude/projects`, `~/.codex/sessions`, ...) | Always listed in the manifest's `machineDirs` (dir, exists, file count, bytes); copied only with `--include-machine-dirs`, which cannot be combined with `--no-transcripts`. |
| `stats.json` | the exact stdout of `ach stats --json` | Same state dir, same config-file `stats.*` defaults. It includes the machine transcripts `ach stats` reads, whether or not they are copied; `sources.state` and `sources.transcript` split the two. |
| `stats.csv` | the buckets of `stats.json` | See below. |
| `manifest.json` | | See below. |

`events/` holds the full conversation content of every run (prompts, replies, tool calls), so
`--no-transcripts` alone does not make a dump safe to share. Use `--mask all`, or run
`ach scrub ./dump --mask preview` before it leaves the machine.

## `stats.csv`

RFC 4180: a header row, CRLF line ends, and a field quoted when it holds a comma, a quote, CR or
LF (quotes doubled). Columns:

```
section,key,subkey,records,inputTokens,outputTokens,cacheReadTokens,cacheWriteTokens,reasoningTokens,costUsd,costSource,unpricedRecords
```

One row per aggregation bucket in `stats.json`: `total` (empty key), then one row per entry of
`byAgent`, `byDay` / `byWeek` / `byMonth`, `byModel`, `sources`, `origins`, `byProject`,
`byBranch`, `byPr`, `byDesk`, whichever are present, and one row per (model, day) of
`byModelDay` (`subkey` = the day). An unpriced cost (`null` in JSON) is an empty field. The rows
are read from the `stats.json` object, never aggregated a second time. Non-token rollups
(`runOutcomes`, `runs`, `pace`) stay in `stats.json`.

## `manifest.json`

```json
{
  "format": "ach-export", "v": 1, "achVersion": "0.33.0",
  "exportedAt": "2026-11-26T22:08:43.018Z", "stateDir": "...",
  "options": { "transcripts": true, "includeMachineDirs": false, "mask": "none" },
  "stats": { "argv": ["stats", "--json"] },
  "counts": { "files": 9, "runFiles": 2, "runRecords": 2, "unreadableRunRecords": 0,
              "eventFiles": 3, "eventLines": 5, "transcriptFiles": 2, "machineTranscriptFiles": 0,
              "statsRecords": 3, "statsCsvRows": 8 },
  "unreadableRunRecords": [], "machineDirs": [ ... ], "externalEventFiles": [],
  "files": [ { "path": "runs/run-1.json", "kind": "run", "sha256": "...", "bytes": 312, "source": "..." } ]
}
```

`files` lists every file in the dump except the manifest itself, sorted by path, with the sha256
and size of the bytes written. Re-hashing the dump verifies it.

## Re-runs and interruptions

- A file whose destination already has the same sha256 is not rewritten (same inode, same mtime).
  The `written` / `skipped` counts say what happened. `stats.json` carries `pace.asOf`, the clock
  at print time, so it is rewritten on every run.
- Files an earlier export listed in its manifest that this export does not hold (a run `ach gc`
  removed, `transcripts/` on a `--no-transcripts` re-run) are deleted and counted as `removed`.
  Files the manifest never listed (your own notes) are left alone.
- `exportedAt` is the time of the latest export; the manifest is rewritten on every run so it
  always describes the directory as it is now.
- Every file is written to `<name>.tmp-<pid>` and renamed into place, and the manifest is written
  last. A killed export never leaves a half-written file under its final name; the next export
  removes the leftover temp files.
- A source file that cannot be read (permissions, I/O error) fails the export before anything is
  pruned or the manifest is rewritten, so an earlier dump stays whole. A file that vanished between
  listing and reading (an `ach gc` race) is skipped.
- An empty state dir exports fine: empty `runs/` and `events/`, the two stats files, and a
  manifest whose counts are zero.
