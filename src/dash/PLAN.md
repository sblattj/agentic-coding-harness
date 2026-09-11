# `agh dash` build plan — contracts all seats code against

## Run registry (new, seat D1 owns)

File: `src/core/registry.ts`. The driver records run lifecycle so a dashboard
can see live + recent runs.

On-disk: `<stateDir>/runs/<runId>.json` — one file per run, written
atomically (tmp+rename), updated on heartbeats, deleted never (dash prunes
display, not files).

```ts
export interface RunRecord {
  runId: string;            // driver-generated uuid
  agent: string;            // 'claude' | 'kiro' | ...
  sessionId?: string;       // set once the adapter reports it
  pid: number;              // harness CLI process pid
  cwd: string;
  promptPreview: string;    // first 120 chars of prompt
  startedAt: number;        // ms epoch
  updatedAt: number;        // ms epoch — heartbeat
  status: 'running' | 'success' | 'error' | 'aborted';
  exitStatus?: string;      // final RunResult.exitStatus
  totals: {                 // running aggregates, updated per usage event
    inputTokens: number; outputTokens: number;
    cacheReadTokens: number; cacheWriteTokens: number;
    costUsd: number; credits?: number;
  };
  lastEvent?: string;       // one-line preview of the latest event
  rawTranscript: string;    // absolute path to <stateDir>/raw/<agent>-<session>.jsonl
}

export function registryDir(stateDir: string): string;
export function writeRunRecord(stateDir: string, rec: RunRecord): void;   // atomic
export function readRunRecord(stateDir: string, runId: string): RunRecord | null;
export function listRunRecords(stateDir: string): RunRecord[];            // sorted by startedAt desc
export function isLive(rec: RunRecord, now?: number): boolean;            // status running + updatedAt within 15s + pid alive (kill(pid,0))
```

## Driver hook (seat D2 owns)

`createDriver({ ... })` gains optional `registry?: { stateDir: string }` — when
present, `run()` creates the RunRecord at spawn, heartbeats `updatedAt` +
`totals` + `lastEvent` on every event (throttle writes to >= 500ms), and
finalizes `status`/`exitStatus` at exit. CLI `run` always passes it.
No signature changes to existing public APIs (additive only).

## CLI surface (seat D3 owns)

- package.json bin gains `"agh": "./src/cli/harness.ts"`.
- New subcommand: `harness dash` (and thus `agh dash`).
  - Default: terminal live view, redraw ~2/s, ANSI, no deps. Columns:
    STATUS(●/✓/✗) AGENT RUNID(short) SESSION(short) ELAPSED IN OUT CACHE COST CREDITS LAST-EVENT
  - Footer: totals across visible runs + "q to quit".
  - `--json`: dump current RunRecord[] and exit (no TTY loop) — this is how
    tests and other tools consume it.
  - `--all`: include non-live runs older than 1h.
- Key handling: raw stdin, q/Ctrl-C exits.

## Tests (seat D4 owns)

- `tests/registry.test.ts`: write/read/list/isLive (fake pids via process.pid
  for alive and a dead pid like 999999 for dead), atomicity (no partial JSON).
- `tests/dash.test.ts`: `agh dash --json` subprocess against a tmp state dir
  seeded with registry records → parses, sorted correctly, live flagging.
- Driver-hook integration: existing stub-adapter driver tests gain one case
  asserting a RunRecord file appears with status success and correct totals.
