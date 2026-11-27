# Task packs: versioned, pinned task sets (`name@version`)

A task pack is a named, versioned set of trial tasks. `ach trial --pack
mypack@1.0.0` runs exactly the tasks the pack lists, and every run it records
cites the pack's name, version and content hash. "Rerun the benchmark from
September" then has a stable referent: the same `name@version`, and a hash
that proves the task content is the same.

```sh
ach pack lock ./mypack                     # pin every task's content hash
ach pack add ./mypack                      # publish it to the local registry as mypack/1.0.0/
ach trial --pack mypack@1.0.0 --agent claude --agent codex --repeat 3
ach trial --pack ./mypack --agent null     # run straight from a path, offline
ach pack show mypack@1.0.0                 # hashes, lock state, drift
ach pack list                              # every name@version in the registry
```

Packs run through the same matrix runner as `ach trial --matrix` and
`ach trial --suite` ([TRIALS.md](TRIALS.md)), so the ledger, resume, cell
outcomes, `--retry-failed`, `--dry-run`, `--json`, the exit code and the HTML
report behave as described there.

## Authoring a pack

A pack is a directory with an `ach-pack.json` manifest:

```json
{
  "name": "mypack",
  "version": "1.0.0",
  "description": "three small tasks",
  "tasks": [
    { "id": "fizzbuzz", "prompt": "Write fizzbuzz.py printing 1..15 as FizzBuzz", "verify": "python3 fizzbuzz.py | grep -q FizzBuzz" },
    { "id": "summarize", "promptFile": "prompts/summarize.md", "verify": "test -s SUMMARY.md" },
    { "dir": "tasks/add-endpoint" }
  ]
}
```

| Key | Meaning |
|---|---|
| `name` | `[A-Za-z0-9][A-Za-z0-9._-]*`, no `@` or `/` |
| `version` | a semver version (`1.0.0`, `2.1.0-rc.1`) |
| `description` | free text; not part of the hash |
| `tasks` | one or more task entries (below), run in this order |

Task entries are the [matrix plan](TRIALS.md#plan-schema) task shapes plus one more:

| Entry | Shape |
|---|---|
| Inline | `{id, prompt, setup?, verify?, workspace?, cwd?, setupTimeoutMs?, verifyTimeoutMs?, sandbox?}` |
| Prompt file | the inline shape with `promptFile` (a path relative to the manifest) instead of `prompt` |
| Task directory | `{dir, id?, workspace?, setupTimeoutMs?, verifyTimeoutMs?, sandbox?}`: the `task.md` / `setup.sh` / `verify.sh` / `meta.json` layout of the bundled `tasks/` |

- Paths (`promptFile`, `dir`, `cwd`) resolve against the manifest's directory.
- Inline and prompt-file tasks default to `workspace: "fresh"` in a pack (a
  matrix plan defaults them to `shared`): each cell gets an empty directory,
  so an agent cannot edit the pack it is being measured on. Set
  `"workspace": "shared"` to run in `cwd` instead.
- Task ids must be unique within the pack.

**Resolution checks every task before anything runs.** A `promptFile` that
does not exist, a task directory without `task.md`, an empty prompt or a
duplicate id is a usage error that names the task. It is raised before agents
are picked, before a driver exists and before the ledger is opened, so a
broken pack launches nothing.

## Content hashes

Every task gets a `sha256:` content hash over everything that decides its
result:

| Task | What the hash covers |
|---|---|
| Inline | the prompt and every other field of the entry (`setup`, `verify`, `workspace`, timeouts, `sandbox`) |
| Prompt file | the prompt file's text and the other fields of the entry |
| Task directory | every file under the directory (sorted relative paths and their bytes, symlink targets), plus the entry's override fields |

So editing `verify.sh`, a hidden test or a starter file counts as a change.
Key order in the manifest and the `description` do not.

The **pack hash** covers the name, the version and the ordered list of task
ids and hashes. `ach pack show` prints both.

## Locking

```sh
ach pack lock <path|name@version>
```

writes `ach-pack.lock.json` next to the manifest:

```json
{
  "lockfileVersion": 1,
  "name": "mypack",
  "version": "1.0.0",
  "hash": "sha256:05a4...",
  "tasks": [{ "id": "fizzbuzz", "hash": "sha256:0dc3..." }]
}
```

Commit it with the pack. Before a locked pack runs, `ach trial --pack`
recomputes every hash and compares it with the lockfile. On any difference
it refuses to start:

```text
harness: pack mypack@1.0.0: hash mismatch against .../ach-pack.lock.json: task 'summarize' changed (locked sha256:0dc3e3b322ec, now sha256:41b4874f3467). Nothing was launched. Re-lock with `ach pack lock` if the change is intended, or pass --allow-drift to run anyway.
```

A task added to the manifest, a task removed from it, and a name or version
that differs from the lockfile's are mismatches too, each named. The exit
code is 1 and no agent, ledger row or run record is created.

**`--allow-drift`** is the escape hatch. The run goes ahead and a warning goes
to stderr (also under `--json`):

```text
[warn] DRIFT: pack mypack@1.0.0 does not match its lockfile (--allow-drift): task 'summarize' changed (...); the run records the current hash sha256:8d7945a27d11
```

Every run record of that trial then carries `pack.drift: ["summarize"]` and
the hash of the content that actually ran, never the locked one.

An **unlocked** pack (no lockfile) runs with a one-line `[warn] ... is not
locked` note, and its records say `locked: false`.

## The local registry and `name@version`

`ach pack add <path>` copies a pack directory into the registry as
`<packs dir>/<name>/<version>/` (its lockfile included). Versions of the same
name sit side by side, so `mypack@1.0.0` and `mypack@2.0.0` both resolve. A
version is immutable once added: adding different content under an existing
`name@version` is refused (bump the version); adding identical content is a
no-op. Every task must live inside the pack directory for `add`.

The registry is `--packs-dir DIR`, else `AGENTIC_CODING_HARNESS_PACKS_DIR`,
else `<stateDir>/packs`.

**Resolution order** for `--pack <ref>` (and every `ach pack` subcommand):

1. **An explicit path.** A pack directory or a manifest file. `./mypack@1.0.0`
   (a path followed by `@version`) is that path, and its manifest must say
   `1.0.0`. A reference counts as a path when it exists and contains a `/`,
   starts with `.`, ends in `.json`, or has no `@version`.
2. **The registry.** A bare `name@version` always means the registry entry,
   even when a directory of that name sits in the cwd. A bare `name` without a
   version is refused with the list of available versions: a reproducible
   trial names its version.

Remote pack URLs are not fetched; download the pack and pass its path.

## What a run records

Every cell is one registry record labelled experiment `pack/<name>@<version>`,
variant `{agent}:{model}` and cellId `agent:task:model:trialN`, and it carries:

```json
"pack": {
  "name": "mypack",
  "version": "1.0.0",
  "hash": "sha256:05a4...",
  "taskHash": "sha256:0dc3...",
  "resolvedFrom": "registry",
  "manifestPath": "/.../packs/mypack/1.0.0/ach-pack.json",
  "locked": true
}
```

`drift` is added under `--allow-drift`. `manifestPath` is a path field, so
`--privacy redact` shortens it to its basename in exports
([MASKING.md](MASKING.md)).

Output sits under `<stateDir>/packs-runs/`, keyed by name, version and the
first 12 hex digits of the pack hash:

| Path | Contents |
|---|---|
| `<name>@<version>-<hash12>.ledger.jsonl` | the resume ledger |
| `<name>@<version>-<hash12>.work/` | each cell's fresh workspace |
| `<name>@<version>-<hash12>.runs/<task>/...json` | one `ach report`-loadable result per cell, with the `pack` block |
| `<name>@<version>-<hash12>.report.html` | the HTML comparison |

Because the hash is in the key, two versions never share verdicts, and a run
under `--allow-drift` never resumes cells that ran against other content.
`--ledger PATH` moves all four, as for `--suite`.

## Referencing `name@version` in reports

The HTML report (`ach report`, and the one `ach trial --pack` writes) has a
**task packs** table whenever a run came from a pack: one row per
`name@version` and content hash, with its lock state (`locked`, `unlocked`,
or `DRIFT (--allow-drift): <task ids>`), task count and run count. The table
names the pack by identity only, never by its manifest path (the per-run
rows still show each task's verify command, as for `--suite`).

To cite a result, quote both parts: `mypack@1.0.0 (sha256:05a423b878bc...)`.
Anyone can check they have the same content with `ach pack show
mypack@1.0.0`, which prints the hash; matching hashes mean identical task
content. To group numbers by pack in `/compare` or `ach stats`, use the
experiment label `pack/mypack@1.0.0`.

## Flags

| Flag | Meaning |
|---|---|
| `--pack REF` | the pack to run; cannot be combined with `--matrix` or `--suite` |
| `--packs-dir DIR` | the registry (default `<stateDir>/packs`) |
| `--allow-drift` | run a locked pack whose content changed, with a warning |
| `--agent`, `--model`, `--repeat`, `--effort`, `--capture-mode`, `--ledger`, `--dry-run`, `--retry-failed`, `--json`, `--hermetic`, `--isolate`, the sandbox flags | as for `--suite` |

`--task` and `--tasks-dir` are refused with `--pack`: a pack runs exactly its
listed tasks. To run a subset, make a smaller pack.
