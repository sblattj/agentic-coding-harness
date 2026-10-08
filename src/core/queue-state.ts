// Run-queue state file (issue #115 part A). One JSON document per queue at
// <stateDir>/queues/<queueId>.json, written atomically (tmp + rename) by the
// queue process (src/core/queue-engine.ts) and read by `ach queue status` and
// the dashboards. This module is the contract: import `QueueState`,
// `QueueStateSchema`, `readQueueState`, `listQueueStates` from here.
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

export const SLICE_STATUSES = ["queued", "pre-failed", "running", "done", "failed"] as const;
export type SliceStatus = (typeof SLICE_STATUSES)[number];

export const QUEUE_PHASES = ["running", "drained", "expired", "stopped"] as const;
export type QueuePhase = (typeof QUEUE_PHASES)[number];

export const SliceStateSchema = z.object({
  label: z.string().min(1),
  /** Absolute working directory the `ach run` is launched in. */
  cwd: z.string(),
  agent: z.string(),
  /** Absent when the plan wrote `-`. */
  model: z.string().optional(),
  /** Absolute path of the prompt file (read at launch time). */
  promptFile: z.string(),
  /** Trailing plan tokens passed to `ach run` verbatim (--repeat, --experiment, ...). */
  runArgs: z.array(z.string()),
  preCmd: z.string().optional(),
  postCmd: z.string().optional(),
  status: z.enum(SLICE_STATUSES),
  /** pid of the detached `ach run` process (set once launched). */
  pid: z.number().int().optional(),
  /** Registry runIds written by that pid (discovered while running). */
  runIds: z.array(z.string()),
  /** Absolute path of the per-slice log (run stdout/stderr + hook output). */
  log: z.string(),
  preExit: z.number().int().nullable().optional(),
  /** Exit code of the `ach run` child; absent when it was only observed to be gone (queue restart). */
  runExit: z.number().int().nullable().optional(),
  postStartedAt: z.number().optional(),
  postExit: z.number().int().nullable().optional(),
  /** ms epoch timestamps. */
  preStartedAt: z.number().optional(),
  launchedAt: z.number().optional(),
  finishedAt: z.number().optional(),
  /** Human-readable reason for pre-failed / failed. */
  error: z.string().optional(),
});
export type SliceState = z.infer<typeof SliceStateSchema>;

export const QueueStateSchema = z.object({
  v: z.literal(1),
  id: z.string().min(1),
  planPath: z.string(),
  /** The state dir the queue launches into and counts live runs in. */
  stateDir: z.string(),
  /** Extra registries counted against the cap (--count-dir). */
  countDirs: z.array(z.string()),
  startedAt: z.number(),
  updatedAt: z.number(),
  endedAt: z.number().optional(),
  maxConcurrent: z.number().int().min(1),
  maxHours: z.number().positive(),
  /** ms epoch after which no further slice is launched. */
  deadlineAt: z.number(),
  /** pid of the queue process; alive => the queue is still driving. */
  queuePid: z.number().int(),
  phase: z.enum(QUEUE_PHASES),
  /** Absolute path of the tail-able queue log. */
  log: z.string(),
  slices: z.array(SliceStateSchema),
});
export type QueueState = z.infer<typeof QueueStateSchema>;

export function queuesDir(stateDir: string): string {
  return path.join(stateDir, "queues");
}
export function queueStatePath(stateDir: string, id: string): string {
  return path.join(queuesDir(stateDir), `${id}.json`);
}
export function queueLogPath(stateDir: string, id: string): string {
  return path.join(queuesDir(stateDir), `${id}.log`);
}
export function sliceLogPath(stateDir: string, id: string, label: string): string {
  return path.join(queuesDir(stateDir), id, `${label}.log`);
}

/** Atomic write: <id>.json.tmp-<pid> then rename (same pattern as writeRunRecord). */
export function writeQueueState(state: QueueState): void {
  const file = queueStatePath(state.stateDir, state.id);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, file);
}

/** Parse one state file; null when missing or invalid (a dashboard must not crash on a half-written file). */
export function readQueueState(stateDir: string, id: string): QueueState | null {
  try {
    const r = QueueStateSchema.safeParse(JSON.parse(fs.readFileSync(queueStatePath(stateDir, id), "utf8")));
    return r.success ? r.data : null;
  } catch {
    return null;
  }
}

/** All readable queue states, newest startedAt first. */
export function listQueueStates(stateDir: string): QueueState[] {
  let names: string[];
  try {
    names = fs.readdirSync(queuesDir(stateDir));
  } catch {
    return [];
  }
  const out: QueueState[] = [];
  for (const n of names) {
    if (!n.endsWith(".json")) continue;
    const s = readQueueState(stateDir, n.slice(0, -".json".length));
    if (s) out.push(s);
  }
  return out.sort((a, b) => b.startedAt - a.startedAt);
}

/** Per-status slice counts, for one-line summaries and dashboards. */
export function sliceCounts(state: QueueState): Record<SliceStatus, number> {
  const c: Record<SliceStatus, number> = { queued: 0, "pre-failed": 0, running: 0, done: 0, failed: 0 };
  for (const s of state.slices) c[s.status]++;
  return c;
}
