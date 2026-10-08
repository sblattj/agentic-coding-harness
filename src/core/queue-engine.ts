// Queue scheduler (issue #115 part A). All side effects (spawning, hooks,
// clocks, the live-run census, persistence) arrive through `EngineDeps`, so
// the scheduling rules are unit-testable without processes; the real wiring
// lives in src/cli/queue.ts.
//
// Rules:
//  - pre hooks run up front, sequentially, before ANY launch; a non-zero pre
//    marks the slice `pre-failed` and it is never launched.
//  - a slice launches only while  live < maxConcurrent  where `live` is the
//    number of distinct pids of live `ach run` processes on the machine
//    (every registry in play, other sessions included) unioned with this
//    queue's own launched-and-still-alive pids (covers the gap before a
//    child writes its registry record).
//  - a slice is finished when its pid is gone. Exit code is taken from the
//    child's exit event when this process spawned it; after a queue restart
//    (--resume) it is derived from the registry records written by that pid.
//  - post hooks start when a slice finishes (done or failed) and do not hold
//    a concurrency slot; the queue drains only after every post settled.
//  - past the deadline no further slice launches; running children are left
//    alone (they are detached).
import type { QueueState, SliceState } from "./queue-state.ts";

export const QUEUE_EXIT = {
  drained: 0,
  /** Some slice failed (pre-failed, run failed) or a post hook failed. */
  failed: 1,
  /** --max-hours elapsed with slices still queued or running. */
  expired: 40,
  /** SIGINT/SIGTERM at the queue process; children keep running. */
  interrupted: 130,
} as const;

export interface PidRunInfo {
  runIds: string[];
  /** Registry `status` values of the records written by that pid. */
  statuses: string[];
}

export interface Launched {
  pid: number;
  /** Subscribe to the child's exit; the code is null when killed by a signal. */
  onExit(cb: (code: number | null) => void): void;
}

export type HookKind = "pre" | "post";

export interface EngineDeps {
  now(): number;
  sleep(ms: number): Promise<void>;
  /** Pids of live `ach run` processes across the counted registries. */
  liveRunPids(): Set<number>;
  /** Registry records written by `pid` since `sinceMs`. */
  runInfoForPid(pid: number, sinceMs: number): PidRunInfo;
  isPidAlive(pid: number): boolean;
  /** Spawn a detached `ach run`; throws when it cannot (the slice then fails). */
  launch(slice: SliceState): Launched;
  runHook(kind: HookKind, slice: SliceState): Promise<number | null>;
  save(state: QueueState): void;
  log(line: string): void;
}

export interface EngineOptions {
  pollMs: number;
  /** Aborts the loop (SIGINT/SIGTERM at the queue process). */
  shouldStop?: () => boolean;
}

export function hasFailure(state: QueueState): boolean {
  return state.slices.some((s) => s.status === "failed" || s.status === "pre-failed" || (s.postExit !== undefined && s.postExit !== 0));
}

export function exitCodeFor(state: QueueState): number {
  if (state.phase === "expired") return QUEUE_EXIT.expired;
  if (state.phase === "stopped") return QUEUE_EXIT.interrupted;
  return hasFailure(state) ? QUEUE_EXIT.failed : QUEUE_EXIT.drained;
}

export async function runQueue(state: QueueState, deps: EngineDeps, opts: EngineOptions): Promise<QueueState> {
  const exitCodes = new Map<number, number | null>();
  const posts = new Set<Promise<void>>();
  const save = (): void => {
    state.updatedAt = deps.now();
    deps.save(state);
  };
  state.phase = "running";
  delete state.endedAt;
  save();

  // ---- pre hooks, up front, before anything is launched
  for (const s of state.slices) {
    if (s.preCmd === undefined || s.launchedAt !== undefined || s.status !== "queued" || s.preExit !== undefined) continue;
    s.preStartedAt = deps.now();
    deps.log(`pre   ${s.label}: ${s.preCmd}`);
    save();
    const code = await deps.runHook("pre", s);
    s.preExit = code;
    if (code !== 0) {
      s.status = "pre-failed";
      s.error = `pre hook exited ${code === null ? "by signal/timeout" : code}`;
      s.finishedAt = deps.now();
      deps.log(`pre   ${s.label}: FAILED (${s.error}); slice will not launch`);
    } else {
      deps.log(`pre   ${s.label}: ok`);
    }
    save();
  }

  const startPost = (s: SliceState): void => {
    if (s.postCmd === undefined || s.postStartedAt !== undefined) return;
    s.postStartedAt = deps.now();
    deps.log(`post  ${s.label}: ${s.postCmd}`);
    save();
    const p = deps.runHook("post", s).then((code) => {
      s.postExit = code;
      deps.log(`post  ${s.label}: ${code === 0 ? "ok" : `FAILED (exit ${code === null ? "signal/timeout" : code})`}`);
      save();
    });
    posts.add(p);
    void p.finally(() => posts.delete(p));
  };

  // A resume re-runs a post that was started but never reported an exit.
  for (const s of state.slices) {
    if ((s.status === "done" || s.status === "failed") && s.postCmd !== undefined && s.postExit === undefined) {
      delete s.postStartedAt;
      startPost(s);
    }
  }

  const finish = (s: SliceState): void => {
    const info = s.pid !== undefined ? deps.runInfoForPid(s.pid, (s.launchedAt ?? 0) - 1000) : { runIds: [], statuses: [] };
    s.runIds = info.runIds;
    const code = s.pid !== undefined ? exitCodes.get(s.pid) : undefined;
    let ok: boolean;
    if (code !== undefined) {
      s.runExit = code;
      ok = code === 0;
      if (!ok) s.error = `ach run exited ${code === null ? "by signal" : code}`;
    } else {
      // Observed only as gone (queue restarted): trust the records it left.
      const bad = info.statuses.some((x) => x !== "success");
      ok = info.statuses.length > 0 && !bad;
      if (!ok) s.error = info.statuses.length === 0 ? "process gone and no run record found" : `run record status: ${info.statuses.join(",")}`;
    }
    s.status = ok ? "done" : "failed";
    s.finishedAt = deps.now();
    deps.log(`end   ${s.label}: ${s.status}${s.error ? ` (${s.error})` : ""}`);
    save();
    startPost(s);
  };

  let phase: "drained" | "expired" | "stopped" = "drained";
  for (;;) {
    // 1. settle finished slices / refresh runIds
    for (const s of state.slices) {
      if (s.status !== "running" || s.pid === undefined) continue;
      const gone = exitCodes.has(s.pid) || !deps.isPidAlive(s.pid);
      if (gone) finish(s);
      else {
        const ids = deps.runInfoForPid(s.pid, (s.launchedAt ?? 0) - 1000).runIds;
        if (ids.length !== s.runIds.length) {
          s.runIds = ids;
          save();
        }
      }
    }

    const queued = state.slices.filter((s) => s.status === "queued");
    const running = state.slices.filter((s) => s.status === "running");
    if (queued.length === 0 && running.length === 0 && posts.size === 0) break;
    if (opts.shouldStop?.()) {
      phase = "stopped";
      break;
    }
    if (deps.now() >= state.deadlineAt) {
      if (queued.length > 0 || running.length > 0) {
        phase = "expired";
        deps.log(`max-hours reached: ${queued.length} queued, ${running.length} running (left running, detached)`);
        break;
      }
    }

    // 2. launch up to the cap
    if (queued.length > 0) {
      const live = new Set(deps.liveRunPids());
      for (const s of running) if (s.pid !== undefined && deps.isPidAlive(s.pid)) live.add(s.pid);
      let free = state.maxConcurrent - live.size;
      for (const s of queued) {
        if (free <= 0) break;
        s.launchedAt = deps.now();
        try {
          const l = deps.launch(s);
          s.pid = l.pid;
          s.status = "running";
          s.runIds = [];
          l.onExit((code) => exitCodes.set(l.pid, code));
          free--;
          deps.log(`start ${s.label}: pid ${l.pid} (live ${live.size + 1}/${state.maxConcurrent})`);
        } catch (e) {
          s.status = "failed";
          s.error = `launch failed: ${e instanceof Error ? e.message : String(e)}`;
          s.finishedAt = deps.now();
          deps.log(`start ${s.label}: ${s.error}`);
          startPost(s);
        }
        save();
      }
    }
    await deps.sleep(opts.pollMs);
  }

  if (phase === "drained") await Promise.all([...posts]);
  state.phase = phase;
  state.endedAt = deps.now();
  save();
  return state;
}
