// JSONL feed runner (#204, guide section 7). Owner: feeds seat.
import { spawn, execFile, type ChildProcess } from "node:child_process";
import type { FeedSpec } from "./types.ts";

export interface FeedHandle {
  pid: number;
  stop(): Promise<void>;
}

export const FULL_CONTEXT_PREFIX = "Full context so far:\n";
export const WAITING_NOTE = "Waiting: no live session yet.";
export const CALL_ENDED_MESSAGE = "Call ended. Send the full action list and open asks now.";

type Phase = "backlog" | "waiting" | "active";

/** One event as a single text line: `[t] speaker: text` when those fields exist, else compact JSON. */
export function renderEvent(ev: Record<string, unknown>): string {
  const text = typeof ev.text === "string" ? ev.text : undefined;
  const speaker = typeof ev.speaker === "string" ? ev.speaker : undefined;
  const t = ev.t !== undefined && ev.t !== null && typeof ev.t !== "object" ? String(ev.t) : undefined;
  if (text === undefined && speaker === undefined) return JSON.stringify(ev);
  const head = [t !== undefined ? `[${t}]` : "", speaker !== undefined ? `${speaker}:` : ""].filter(Boolean).join(" ");
  return `${ev.type as string}: ${head ? head + " " : ""}${text ?? ""}`.trimEnd();
}

export const DEFAULT_HELPER_TIMEOUT_MS = 15_000;
export const DEFAULT_MAX_PENDING_EVENTS = 1000;
/** Longest feed stdout/stderr line kept in memory (chars); a longer line is dropped up to its newline. */
export const DEFAULT_MAX_LINE_CHARS = 1024 * 1024;

/**
 * Newline splitter with a bounded buffer. A line that grows past maxChars is reported once through
 * onOverflow (with its first 200 chars), its buffer is freed, and every further byte is discarded
 * until the next newline, so a runaway or newline-free stream never grows memory past maxChars.
 */
function lineSplitter(maxChars: number, onLine: (line: string) => void, onOverflow: (head: string) => void) {
  let buf = "";
  let discarding = false;
  return {
    push(d: string): void {
      let start = 0;
      for (;;) {
        const i = d.indexOf("\n", start);
        const piece = i >= 0 ? d.slice(start, i) : d.slice(start);
        if (!discarding) {
          if (buf.length + piece.length > maxChars) {
            const head = (buf + piece.slice(0, 200)).slice(0, 200);
            buf = "";
            discarding = true;
            onOverflow(head);
          } else {
            buf += piece;
          }
        }
        if (i < 0) return;
        if (discarding) discarding = false;
        else { const l = buf; buf = ""; onLine(l); }
        start = i + 1;
      }
    },
    end(): void {
      const l = buf;
      buf = "";
      if (!discarding && l) onLine(l);
      discarding = false;
    },
  };
}

/** Runs a helper command (activeCheck / fullContext). Killed at timeoutMs; `live` tracks it so stop() can kill it. */
function run(argv: string[], cwd: string | undefined, env: NodeJS.ProcessEnv, timeoutMs: number, live: Set<ChildProcess>): Promise<string> {
  return new Promise((resolve, reject) => {
    const c = execFile(argv[0]!, argv.slice(1), { cwd, env, maxBuffer: 64 * 1024 * 1024, timeout: timeoutMs, killSignal: "SIGKILL" }, (err, stdout) => {
      live.delete(c);
      if (err) reject((err as { killed?: boolean }).killed ? new Error(`timed out after ${timeoutMs}ms`) : err);
      else resolve(stdout);
    });
    live.add(c);
  });
}

/**
 * Start `spec.command`; deliver(text) is called with each message for the desk:
 * full context on the first heartbeat when active (else a waiting note), batched
 * events every batchSeconds, immediate events at once, a closing message on endType.
 */
export function startFeed(spec: FeedSpec, deliver: (text: string) => Promise<void>, opts: {
    cwd?: string;
    env?: Record<string, string>;
    /** Feed lifecycle notes and errors (spawn failure, exit, malformed line) -> host 'feed' / 'error' events. */
    onNote?: (note: string) => void;
    onError?: (error: string) => void;
    /** Call state changes: true when a live session starts, false on waiting / call ended. */
    onActive?: (active: boolean) => void;
    /** First restart delay (ms); doubles to maxBackoffMs. Default 2000. */
    restartBaseMs?: number;
    /** Default 60000. */
    maxBackoffMs?: number;
    /** Restarts in a row without a heartbeat before the feed gives up (reported as an error). Default 20. */
    maxRestarts?: number;
    /** Grace between TERM and KILL on stop (ms). Default 3000. */
    killAfterMs?: number;
    /** Minimum gap between "feed stderr:" notes (ms). Default 5000. */
    stderrGapMs?: number;
    /** Wall-clock cap for one activeCheck / fullContext command (ms). Default 15000. */
    helperTimeoutMs?: number;
    /** Max feed events waiting for the helper-gated handler; beyond it the oldest are dropped with a note. Default 1000. */
    maxPendingEvents?: number;
    /** Longest stdout/stderr line kept (chars); longer lines are dropped with one error each. Default 1 MiB. */
    maxLineChars?: number;
  } = {}): FeedHandle {
  const note = (s: string) => { try { opts.onNote?.(s); } catch { /* host callback */ } };
  const err = (s: string) => { try { opts.onError?.(s); } catch { /* host callback */ } };
  const active = (a: boolean) => { try { opts.onActive?.(a); } catch { /* host callback */ } };
  const heartbeatType = spec.heartbeatType ?? "alive";
  const endType = spec.endType ?? "call_ended";
  const immediate = new Set(spec.immediate ?? []);
  const batchMs = Math.max(0, (spec.batchSeconds ?? 10) * 1000);
  const baseMs = opts.restartBaseMs ?? 2000;
  const maxMs = opts.maxBackoffMs ?? 60000;
  const maxRestarts = Math.max(0, opts.maxRestarts ?? 20);
  const killAfter = opts.killAfterMs ?? 3000;
  const stderrGap = opts.stderrGapMs ?? 5000;
  const helperTimeout = opts.helperTimeoutMs ?? DEFAULT_HELPER_TIMEOUT_MS;
  const maxPending = Math.max(1, opts.maxPendingEvents ?? DEFAULT_MAX_PENDING_EVENTS);
  const maxLine = Math.max(1, opts.maxLineChars ?? DEFAULT_MAX_LINE_CHARS);
  const env: NodeJS.ProcessEnv = { ...process.env, ...(opts.env ?? {}) };
  const helpers = new Set<ChildProcess>();

  let stopped = false;
  let child: ChildProcess | undefined;
  let exited: Promise<void> = Promise.resolve();
  let backoff = baseMs;
  let restarts = 0; // in a row without a heartbeat
  let restartTimer: NodeJS.Timeout | undefined;
  let epoch = 0; // bumps per child; stale line work is dropped

  // Delivery queue: strictly serial, ordered.
  let deliverChain: Promise<void> = Promise.resolve();
  const enqueue = (text: string, e: number) => {
    deliverChain = deliverChain.then(async () => {
      if (stopped || e !== epoch) return;
      try { await deliver(text); } catch (x) { err(`feed deliver failed: ${x instanceof Error ? x.message : String(x)}`); }
    });
  };

  const handle: FeedHandle = {
    get pid(): number { return child?.pid ?? 0; },
    stop,
  };

  function spawnChild(): void {
    epoch++;
    const e = epoch;
    let phase: Phase = "backlog";
    let backlog = 0;
    let batch: string[] = [];
    let batchTimer: NodeJS.Timeout | undefined;
    let lastStderr = -Infinity;
    // Events wait here for the serial handler (which can sit on a helper command); bounded, oldest dropped.
    const pending: Record<string, unknown>[] = [];
    let draining = false;
    let drainIdle: Promise<void> = Promise.resolve(); // settles when the serial handler has gone idle
    let dropped = 0;

    const flush = () => {
      if (batchTimer) { clearTimeout(batchTimer); batchTimer = undefined; }
      if (batch.length === 0) return;
      const lines = batch; batch = [];
      enqueue(`New events (${lines.length}):\n${lines.map((l) => `- ${l}`).join("\n")}`, e);
    };

    const becomeActive = async (): Promise<void> => {
      phase = "active";
      active(true);
      if (spec.fullContext && spec.fullContext.length > 0) {
        try {
          const out = await run(spec.fullContext, opts.cwd, env, helperTimeout, helpers);
          if (!stopped && e === epoch) enqueue(FULL_CONTEXT_PREFIX + out, e);
        } catch (x) {
          err(`feed full-context failed: ${x instanceof Error ? x.message : String(x)}`);
        }
      }
    };

    const checkActive = async (): Promise<boolean> => {
      if (!spec.activeCheck || spec.activeCheck.length === 0) return backlog > 0;
      try {
        const parsed = JSON.parse(await run(spec.activeCheck, opts.cwd, env, helperTimeout, helpers)) as { active?: unknown };
        return parsed.active === true;
      } catch (x) {
        err(`feed active-check failed: ${x instanceof Error ? x.message : String(x)}`);
        return false;
      }
    };

    const onEvent = async (ev: Record<string, unknown>): Promise<void> => {
      const type = ev.type as string;
      if (type === heartbeatType) {
        backoff = baseMs;
        restarts = 0;
        if (phase === "backlog" || (phase === "waiting" && spec.activeCheck)) {
          const first = phase === "backlog";
          if (await checkActive()) await becomeActive();
          else if (first) { phase = "waiting"; active(false); enqueue(WAITING_NOTE, e); }
        }
        return;
      }
      if (phase === "backlog") { backlog++; return; }
      if (phase === "waiting") {
        // Without an active check, the first real event after the waiting note starts the session.
        if (spec.activeCheck) return;
        await becomeActive();
      }
      if (type === endType) {
        flush();
        enqueue(CALL_ENDED_MESSAGE, e);
        phase = "backlog"; backlog = 0;
        active(false);
        return;
      }
      if (immediate.has(type)) {
        flush();
        enqueue(renderEvent(ev), e);
        return;
      }
      batch.push(renderEvent(ev));
      if (!batchTimer) batchTimer = setTimeout(() => { batchTimer = undefined; flush(); }, batchMs);
    };

    const onLine = (line: string) => {
      if (!line.trim()) return;
      let ev: unknown;
      try { ev = JSON.parse(line); } catch { err(`feed malformed line: ${line.slice(0, 200)}`); return; }
      if (!ev || typeof ev !== "object" || Array.isArray(ev) || typeof (ev as { type?: unknown }).type !== "string") {
        err(`feed event without string type: ${line.slice(0, 200)}`);
        return;
      }
      pending.push(ev as Record<string, unknown>);
      if (pending.length > maxPending) {
        const n = pending.length - maxPending;
        pending.splice(0, n);
        const first = dropped === 0;
        dropped += n;
        if (first) note(`feed backlog over ${maxPending} events: dropped ${n} oldest (further drops are counted, not logged)`);
      }
      void drain();
    };

    const drain = async (): Promise<void> => {
      if (draining) return;
      draining = true;
      let release!: () => void;
      drainIdle = new Promise<void>((r) => { release = r; });
      try {
        while (pending.length > 0 && !stopped && e === epoch) {
          const next = pending.shift()!;
          try { await onEvent(next); } catch (x) { err(`feed event failed: ${x instanceof Error ? x.message : String(x)}`); }
        }
      } finally {
        draining = false;
        release();
      }
      if (dropped > 0 && pending.length === 0) { note(`feed dropped ${dropped} oldest events in total while the handler was busy`); dropped = 0; }
    };

    let proc: ChildProcess;
    try {
      proc = spawn(spec.command[0]!, spec.command.slice(1), { cwd: opts.cwd, env, stdio: ["ignore", "pipe", "pipe"], detached: true });
    } catch (x) {
      err(`feed spawn failed: ${x instanceof Error ? x.message : String(x)}`);
      scheduleRestart();
      return;
    }
    child = proc;
    let spawnFailed = false;
    exited = new Promise<void>((resolve) => {
      let done = false;
      const finish = async (code: number | null, signal: NodeJS.Signals | null) => {
        if (done) return;
        done = true;
        if (!stopped && draining) {
          // Events received before the exit may sit in `pending` behind an in-flight helper; let the handler drain them first (bounded).
          let t: NodeJS.Timeout | undefined;
          await Promise.race([drainIdle, new Promise<void>((r) => { t = setTimeout(r, helperTimeout + 1000); })]);
          if (t) clearTimeout(t);
        }
        if (!stopped) flush(); // events batched before the exit are delivered, not dropped
        else if (batchTimer) { clearTimeout(batchTimer); batchTimer = undefined; }
        if (!stopped && !spawnFailed) note(`feed exited code=${code === null ? `signal ${signal}` : code}`);
        resolve();
        if (!stopped) scheduleRestart();
      };
      proc.on("error", (x) => { spawnFailed = true; err(`feed spawn failed: ${x.message}`); finish(null, null); });
      proc.on("close", finish);
    });

    // Both streams are split with a bounded buffer: a feed that never writes a newline cannot grow host memory.
    const out = lineSplitter(maxLine, onLine, (head) => err(`feed line over ${maxLine} chars dropped up to its newline: ${head}`));
    proc.stdout!.setEncoding("utf8");
    proc.stdout!.on("data", (d: string) => out.push(d));
    proc.stdout!.on("end", () => out.end());
    const stderrNote = (text: string) => {
      const now = Date.now();
      if (now - lastStderr >= stderrGap) { lastStderr = now; note(text); }
    };
    const errLines = lineSplitter(maxLine, (raw) => {
      const l = raw.trim();
      if (l) stderrNote(`feed stderr: ${l}`);
    }, (head) => stderrNote(`feed stderr line over ${maxLine} chars dropped: ${head.trim()}`));
    proc.stderr!.setEncoding("utf8");
    proc.stderr!.on("data", (d: string) => errLines.push(d));
    proc.stderr!.on("error", () => {});
    proc.stdout!.on("error", () => {});
  }

  function scheduleRestart(): void {
    if (stopped) return;
    if (restarts >= maxRestarts) {
      err(`feed gave up after ${restarts} restarts without a heartbeat; fix the feed command and restart the desk`);
      return;
    }
    restarts++;
    const wait = backoff;
    backoff = Math.min(backoff * 2, maxMs);
    restartTimer = setTimeout(() => { restartTimer = undefined; if (!stopped) spawnChild(); }, wait);
  }

  async function stop(): Promise<void> {
    if (!stopped) {
      stopped = true;
      if (restartTimer) { clearTimeout(restartTimer); restartTimer = undefined; }
    }
    for (const h of helpers) { try { h.kill("SIGKILL"); } catch { /* gone */ } }
    const c = child;
    // The feed leads its own process group (detached spawn): signal the group so a shell wrapper's children die too.
    const sig = (s: NodeJS.Signals) => {
      const pid = c?.pid;
      if (pid === undefined) return;
      try { process.kill(-pid, s); } catch { try { c?.kill(s); } catch { /* gone */ } }
    };
    if (c && c.exitCode === null && c.signalCode === null) {
      sig("SIGTERM");
      const k = setTimeout(() => sig("SIGKILL"), killAfter);
      await exited;
      clearTimeout(k);
    } else {
      await exited;
    }
    sig("SIGKILL"); // stragglers that outlived the leader
  }

  spawnChild();
  return handle;
}

/**
 * Run a feed's activeCheck once (outside a feed: desk power status, the auto watcher, the
 * live-call refusal of `off`). Resolves with `active === true` from its JSON stdout; rejects when
 * the command fails, times out or prints no JSON object, so callers can tell "no call" from
 * "unknown".
 */
export async function runActiveCheck(argv: string[], opts: { cwd?: string; timeoutMs?: number; env?: Record<string, string> } = {}): Promise<boolean> {
  if (argv.length === 0) throw new Error("activeCheck is empty");
  const live = new Set<ChildProcess>();
  const env: NodeJS.ProcessEnv = { ...process.env, ...(opts.env ?? {}) };
  const out = await run(argv, opts.cwd, env, opts.timeoutMs ?? DEFAULT_HELPER_TIMEOUT_MS, live);
  let parsed: unknown;
  try {
    parsed = JSON.parse(out);
  } catch {
    throw new Error(`activeCheck printed no JSON: ${out.trim().slice(0, 200)}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`activeCheck printed no JSON object: ${out.trim().slice(0, 200)}`);
  return (parsed as { active?: unknown }).active === true;
}
