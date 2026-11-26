# Several data directories, WSL and remote mounts (`ach stats`, `ach watch`)

Usage data rarely lives in one folder. Transcripts get split across machines, a state dir sits on a
mounted volume, or a Windows box keeps its files under WSL's `/mnt/c`. `ach stats` and `ach watch`
read several directories at once and can map stored paths to the spelling you want to see. You do
not need to copy everything into one folder first.

## The flags

| Flag | Commands | Repeatable | Meaning |
|---|---|---|---|
| `--transcript-dir <root>` (alias `--dir`) | `stats`, `watch` | yes | A home-shaped root: machine transcripts are read from `<root>/.claude/projects`, `<root>/.codex/sessions` and every other source ach knows, as on a real home dir. |
| `--state-dir <stateDir>` | `stats` | yes | A harness state dir (`runs/`, `raw/`, `cursor-dashboard/`, `warehouse/`). Default: `AGENTIC_CODING_HARNESS_STATE_DIR`, else `~/.agentic-coding-harness`. |
| `--rewrite <from>=<to>` | `stats`, `watch` | yes | A path mapping applied to path fields in the output. |

On `stats`, `--dir` keeps the meaning it always had: a transcript root, not a state dir. A custom
state dir is `--state-dir`. Passing `--dir A --transcript-dir B` is still a usage error, because both
spellings name the same flag; repeat one spelling instead (`--dir A --dir B`).

`--state-only` is unchanged: it reads only the state dirs and skips every transcript root, given or
default.

In a config file, `stats.dir`, `stats.transcriptDir` and `stats.stateDir` take one path or a list.
A `--dir` on the command line replaces `stats.dir` / `stats.transcriptDir` from the file but leaves
`stats.stateDir` alone, since the two are different directories. `stats.stateDir` has no env-var
mirror: when the file sets it, it wins over `AGENTIC_CODING_HARNESS_STATE_DIR`, and a `--state-dir`
flag wins over both.

## How several directories merge

Records from every directory are added up as one dataset. The same item seen in two directories
counts once:

- **Run records** (`<stateDir>/runs/<runId>.json`) are matched by `runId`.
- **Harness usage files** (`<stateDir>/raw/**.jsonl`; there is one file per run or session) are
  matched by their path under `raw/`, so a run copied into two state dirs keeps one usage file.
- **Machine transcript sessions** are matched by agent and session id across transcript roots.
- **Cursor dashboard imports** and **`--with-warehouse` archived rows** found in several state dirs
  are matched row by row. A row one dir holds N times is kept as many times as the dir holding it
  most often, so exact copies in other dirs are dropped.

When two copies match:

- If the copies are identical (same bytes for usage files; the same parsed record for run records
  and transcript sessions), they collapse with no message.
- If they conflict (same id, different content), `ach` writes one warning to stderr that names
  every file path, then keeps the copy with the newest modification time. If the times are equal,
  it keeps the path that sorts first as a string. The winner never depends on the order of the flags.
- A run and its usage file move together. When a run record conflicts, the usage file from the
  same dir as the winning record is kept, and the one warning says so (`keeping ... and its usage
  file`). A run never mixes one dir's record with another dir's tokens. A usage file that conflicts
  while its run records are identical gets its own warning.

```
[warn] multi-dir: conflicting duplicate run run-123: /mnt/a/state/runs/run-123.json vs /mnt/b/state/runs/run-123.json; keeping /mnt/b/state/runs/run-123.json (newest mtime)
```

Transcript records with no session id cannot be matched by id. They still go through the usual
`ach stats` dedupe, which collapses exact copies (same agent, session, model, time and token
counts).

With `--with-warehouse` and several transcript roots, an archived transcript copy is read only if
its live file is missing under every root.

## `--rewrite`

`--rewrite <from>=<to>` maps a stored path for display. It changes nothing on disk and nothing in
the numbers.

- The first `=` splits the rule. A trailing `/` on `<from>` is ignored.
- A rule matches only on a path-segment boundary: `/mnt/c` matches `/mnt/c/Users/x`, never
  `/mnt/cache`.
- If several rules match, the longest `<from>` wins. Rules of equal length go to the one given
  first.
- A drive-letter target (`C:` or `C:\`) also turns the rest of the path's `/` into `\`. With
  `/mnt/c=C:`, `/mnt/c/Users/x/proj` becomes `C:\Users\x\proj`. Any other target keeps the
  separators: with `/srv/data=/Volumes/data`, `/srv/data/p` becomes `/Volumes/data/p`.

Fields it changes:

| Command | Field |
|---|---|
| `stats` | `byProject` keys (`--json`) and the `-- by project` rows (text), when the key is a repo-root path. An alias name from `--project-alias` is not a path and is never rewritten. |
| `stats` | `--project` also accepts the rewritten spelling (`--project 'C:\Users\x\proj'`). |
| `watch` | The `dir: <root>` tag on each event line, shown when several roots are tailed. |

The repo root behind a `byProject` key is still found on the original path, since that is where
`.git` lives. Only the printed key is rewritten.

The applied rules are always shown, so remapped data never looks like stored data. `stats --json`
adds a top-level `"rewrites": [{"from": "/mnt/c", "to": "C:"}]`. Text output (`stats`, and `watch`
on stdout at startup) prints one line:

```
rewrite   /mnt/c=C: (applied to: byProject keys)
```

With no `--rewrite` flag, nothing is mapped and the output is byte for byte what it was before
these flags existed: no `rewrites` key and no `rewrite` line.

## `ach watch` over several roots

`ach watch --dir A --dir B` tails both roots in one stream. When more than one root is given, every
event line ends with the root it came from:

```
claude   7d1c2e9a-41b +1,200 input +300 output +0 cacheR +0 cacheW $0.0120 source: transcript dir: /mnt/a/home
claude   0b9f3a11-c2d +800 input +150 output +0 cacheR +0 cacheW $0.0071 source: transcript dir: /mnt/b/home
```

A session present under both roots prints one line per root, because each line reports growth of
the files in that root. With one root, or none, the lines have no `dir:` tag, as before. `watch`
reads the opencode database only when no root is given, as before.

## Recipe: WSL (Windows data, Linux shell)

Two cases come up. Agents run inside WSL write to the Linux home (`~/.claude/projects`), and when
you open a Windows project from WSL its stored path is `/mnt/c/...`. Agents run natively on Windows
write to `C:\Users\<you>\.claude\projects`, which WSL shows as `/mnt/c/Users/<you>/.claude/projects`.
Read both homes, and map the WSL spelling of Windows projects back to the Windows one:

```sh
ach stats --dir ~ --by project --rewrite /mnt/c=C:                    # WSL-side sessions on /mnt/c projects
ach stats --dir ~ --dir /mnt/c/Users/x --by project --rewrite /mnt/c=C: --json   # + Windows-side sessions
ach watch --dir ~ --dir /mnt/c/Users/x --rewrite /mnt/c=C:
```

WSL-side projects under `/mnt/c/...` show up as `C:\...`. Projects inside the Linux filesystem keep
their Linux paths, because no rule matches them. The rule matches stored paths only, so it leaves
a path that was already stored in Windows spelling unchanged.

## Recipe: several machines over mounted volumes

Mount each machine's home (or a synced copy of it) and its harness state dir, then read them
together:

```sh
# laptop + build box, both mounted under /Volumes
ach stats --dir /Volumes/laptop-home --dir /Volumes/buildbox-home \
          --state-dir /Volumes/laptop-home/.agentic-coding-harness \
          --state-dir /Volumes/buildbox-home/.agentic-coding-harness \
          --last 30d --by project --json

# show the build box's project paths the way they look on the laptop
ach stats --dir /Volumes/laptop-home --dir /Volumes/buildbox-home \
          --rewrite /home/ci/src=/Users/x/src --by project
```

A run or session that was synced to both volumes counts once. If one copy was synced while it was
still being written, the newer file wins and stderr names both paths.
