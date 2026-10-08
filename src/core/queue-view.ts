// Presentation layer over the run-queue state files (issue #115 part A), shared
// by `ach dash` (text + --json) and `ach web` (/api/queues, /queues). Pure
// except for the pid-liveness probe, which callers can inject.
import {
  listQueueStates,
  sliceCounts,
  type QueuePhase,
  type QueueState,
  type SliceState,
  type SliceStatus,
} from "./queue-state.ts";

/** A queue that ended less than this many hours ago is still shown by dash / web. */
export const QUEUE_RECENT_HOURS = 24;

export function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

export interface QueueSliceView extends SliceState {
  /** ms the slice has been running (running) or ran (finished); absent when never launched. */
  elapsedMs?: number;
}

export interface QueueView extends Omit<QueueState, "slices"> {
  slices: QueueSliceView[];
  counts: Record<SliceStatus, number>;
  /** phase === "running" but the queue process is gone: `ach queue run --resume <id>`. */
  died: boolean;
  /** Display phase: the stored phase, or "died" for a dead running queue. */
  displayPhase: QueuePhase | "died";
  /** ms until deadlineAt (negative once past); only meaningful while the queue is running. */
  timeLeftMs: number;
  /** ms since endedAt; absent while running. */
  endedAgoMs?: number;
  resumeHint?: string;
}

export function toQueueView(s: QueueState, now: number, alive: (pid: number) => boolean = pidIsAlive): QueueView {
  const died = s.phase === "running" && !alive(s.queuePid);
  return {
    ...s,
    slices: s.slices.map((sl) => {
      const v: QueueSliceView = { ...sl };
      if (sl.launchedAt !== undefined) v.elapsedMs = Math.max(0, (sl.finishedAt ?? now) - sl.launchedAt);
      return v;
    }),
    counts: sliceCounts(s),
    died,
    displayPhase: died ? "died" : s.phase,
    timeLeftMs: s.deadlineAt - now,
    ...(s.endedAt !== undefined ? { endedAgoMs: Math.max(0, now - s.endedAt) } : {}),
    ...(died ? { resumeHint: `ach queue run --resume ${s.id}` } : {}),
  };
}

/** Running queues, plus ones that ended (or last updated, for a dead one) within `hours`. */
export function visibleQueues(
  states: QueueState[],
  now: number,
  hours: number = QUEUE_RECENT_HOURS,
  alive: (pid: number) => boolean = pidIsAlive,
): QueueView[] {
  const cutoff = now - hours * 3_600_000;
  return states
    .filter((s) => s.phase === "running" || (s.endedAt ?? s.updatedAt) >= cutoff)
    .map((s) => toQueueView(s, now, alive));
}

export function collectQueueViews(stateDir: string, now: number = Date.now(), hours?: number): QueueView[] {
  return visibleQueues(listQueueStates(stateDir), now, hours);
}

export function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${s % 60}s`;
  return `${Math.floor(m / 60)}h${m % 60}m`;
}

/** One-line summary: `id  phase  q2 r1 d3 f0 [pre-failed 1]  cap 2  left 3h59m`. */
export function queueSummaryLine(v: QueueView): string {
  const c = v.counts;
  const pre = c["pre-failed"] > 0 ? ` pre-failed ${c["pre-failed"]}` : "";
  const phase = v.died ? "DIED" : v.phase;
  let left: string;
  if (v.phase !== "running") left = v.endedAgoMs !== undefined ? `ended ${fmtDuration(v.endedAgoMs)} ago` : "ended";
  else left = v.timeLeftMs >= 0 ? `left ${fmtDuration(v.timeLeftMs)}` : `deadline passed ${fmtDuration(-v.timeLeftMs)} ago`;
  return `${v.id}  ${phase}  queued ${c.queued} running ${c.running} done ${c.done} failed ${c.failed}${pre}  cap ${v.maxConcurrent}  ${left}`;
}

export function sliceDetail(sl: QueueSliceView): string {
  const ids = sl.runIds.length > 0 ? sl.runIds.map((r) => r.slice(0, 8)).join(",") : sl.pid !== undefined ? `pid ${sl.pid}` : "-";
  return ids;
}
