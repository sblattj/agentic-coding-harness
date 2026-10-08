# Run queue: `ach queue`

`ach queue run <plan>` launches the slices of a plan file as detached `ach run` processes while
keeping the number of **live `ach run` processes on the machine** at or below `--max-concurrent`.
It replaces hand-rolled launchers that polled `ps` (and broke on macOS bash 3.2 `mapfile` and zsh
word-splitting): the plan is parsed in TypeScript and nothing is split by a shell.

```
ach queue run <plan-file> [--max-concurrent N=2] [--max-hours H=24] [--poll-s S=5]
              [--dry-run] [--notify] [--state-dir <stateDir>] [--count-dir D ...]
              [--hook-timeout-s S=1800] [--quiet]
ach queue run --resume <queueId> [--max-concurrent N] [--max-hours H] [--count-dir D ...]
ach queue status [<queueId>] [--all] [--json] [--state-dir <stateDir>]
```

## Plan file

One slice per line; blank lines and `#` comments are ignored. Fields are separated by whitespace;
single quotes (literal), double quotes (`\"` and `\\` escapes) and backslash escapes group words.

```
<label> <cwd> <agent> <model> <prompt-file> [--pre "<cmd>"] [--post "<cmd>"] [ach run flags...]
```

| Field | Meaning |
|---|---|
| `label` | Unique, `[A-Za-z0-9][A-Za-z0-9._-]*`; names the slice's log file. |
| `cwd` | Directory the run starts in. Relative paths resolve against the plan file's directory; `~/` expands. |
| `agent` | Any `ach run --agent` value (`claude`, `codex`, `null`, `custom`, ...). |
| `model` | Passed as `--model`; `-` means none. |
| `prompt-file` | Read at launch time and passed to `ach run` as the prompt (max 200 000 bytes). |
| trailing tokens | Passed to `ach run` unchanged: `--repeat`, `--experiment`, `--variant`, `--budget-usd`, `--verify`, ... (`--agent`/`--model` are rejected: they are columns). |
| `--pre "<cmd>"` | Consumed by the queue. Shell command (`/bin/sh -c`, in the slice `cwd`) run **up front**, before anything is launched. |
| `--post "<cmd>"` | Consumed by the queue. Shell command run when the slice's `ach run` has finished (done or failed). |

Example:

```
# build sandboxes first, grade each slice when it finishes
base-opus   ./sandbox/base   claude opus   prompts/task1.md --experiment ctx --variant base --repeat 3 --pre "./mk-sandbox.sh base" --post "./grade.sh"
skill-opus  ./sandbox/skill  claude opus   prompts/task1.md --experiment ctx --variant skill --repeat 3 --pre "./mk-sandbox.sh skill" --post "./grade.sh"
smoke       .                null   -      prompts/hello.md
```

## Behaviour

- **Cap.** A slice launches only while `live < --max-concurrent`. `live` is the number of distinct pids
  with a live run record (`isLive` in `src/core/registry.ts`: status `running`, heartbeat <= 15 s,
  pid answers `kill(pid, 0)`) in `<stateDir>/runs` and any `--count-dir`, **unioned with the queue's
  own launched children** (so the gap before a child writes its record is covered). Other sessions'
  runs count; external/imported records never do. `ach run` writes to `$AGENTIC_CODING_HARNESS_STATE_DIR`
  (default `~/.agentic-coding-harness`); runs using a different state dir are counted only if you pass
  that dir as `--count-dir` (repeatable). Children of the queue inherit the queue's `--state-dir`.
- **pre.** All `pre` hooks run sequentially at startup. A non-zero exit (or timeout, `--hook-timeout-s`)
  marks the slice `pre-failed`; it is never launched and its `post` never runs.
- **Launch.** The queue re-enters the same `ach` program it is running as (`node dist/cli/ach.js`,
  `bun run src/cli/ach.ts`, or a compiled binary), `detached`, stdout/stderr appended to the slice log,
  `unref()`ed. **Runs outlive the queue**: Ctrl-C, SIGTERM or SIGKILL of the queue never signals them.
- **Completion.** A slice finishes when its pid is gone. While the queue is alive the exit code of the
  child decides (`0` = `done`, else `failed`). If the queue was restarted (`--resume`) the exit code is
  unknown, so the verdict comes from the run records written by that pid: `done` only if there is at
  least one and all are `success`.
- **post.** Starts as soon as the slice finishes, does not hold a concurrency slot, and gets
  `ACH_QUEUE_ID ACH_SLICE_LABEL ACH_SLICE_CWD ACH_SLICE_LOG ACH_SLICE_STATUS ACH_SLICE_EXIT
  ACH_SLICE_PID ACH_SLICE_RUN_IDS` plus `AGENTIC_CODING_HARNESS_STATE_DIR`. The queue drains only after
  all posts have finished. A post that exits non-zero fails the queue's exit code but not the slice.
- **`--max-hours`.** Once elapsed, no further slice launches; the queue writes its state and exits 40.
  Running children keep running (detached); queued slices stay `queued`.
- **Resume.** `ach queue run --resume <id>` continues from the state file (plan is not re-read):
  gone `running` slices are settled, a `post` that started but never reported is re-run, queued slices
  launch. Refused while the previous queue process is still alive. `--max-hours` restarts from now.
- **`--dry-run`** parses and validates the plan (cwd and prompt files exist), prints each slice's
  command, the current live count and which slices would launch now. It runs no hooks, launches
  nothing and writes no state.
- **`--notify`** posts a macOS notification (`osascript`) when the queue ends; silently skipped elsewhere.
  The queue process exit code is the portable signal.

## Files

| Path | Content |
|---|---|
| `<stateDir>/queues/<id>.json` | State file (below), rewritten atomically on every transition. |
| `<stateDir>/queues/<id>.log` | Queue log: `tail -f` it. |
| `<stateDir>/queues/<id>/<label>.log` | Per-slice log: the run's stdout/stderr and hook output. |

`ach queue status [<id>]` prints the table for the given (default: most recent) queue; `--all` lists
queues, `--json` emits the state file(s).

## State file schema

Defined with zod in `src/core/queue-state.ts` (`QueueStateSchema`, `QueueState`, `SliceState`,
`readQueueState`, `listQueueStates`, `sliceCounts`). `v` is `1`.

```ts
QueueState = {
  v: 1; id: string; planPath: string; stateDir: string; countDirs: string[];
  startedAt: number; updatedAt: number; endedAt?: number;   // ms epoch
  maxConcurrent: number; maxHours: number; deadlineAt: number;
  queuePid: number;                       // alive => the queue is still driving
  phase: "running" | "drained" | "expired" | "stopped";
  log: string;
  slices: SliceState[];
}
SliceState = {
  label: string; cwd: string; agent: string; model?: string; promptFile: string; runArgs: string[];
  preCmd?: string; postCmd?: string;
  status: "queued" | "pre-failed" | "running" | "done" | "failed";
  pid?: number; runIds: string[]; log: string;
  preExit?: number | null; runExit?: number | null; postExit?: number | null;
  preStartedAt?: number; launchedAt?: number; finishedAt?: number; postStartedAt?: number;
  error?: string;
}
```

`phase: "running"` with a dead `queuePid` means the queue process died; `--resume` it.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Queue drained; every slice `done` and every post succeeded. |
| 1 | Drained, but a slice is `failed` / `pre-failed` or a post failed (also usage errors). |
| 40 | `--max-hours` expired with slices still queued or running. |
| 130 | Queue interrupted (SIGINT/SIGTERM); runs keep going. |

These sit outside the `--exit-codes ladder` of [EXIT-CODES.md](EXIT-CODES.md), which describes `ach run`.
