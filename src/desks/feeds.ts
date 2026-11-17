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

function run(argv: string[], cwd: string | undefined, env: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(argv[0]!, argv.slice(1), { cwd, env, maxBuffer: 64 * 1024 * 1024 }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout);
    });
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
    /** First restart delay (ms); doubles to maxBackoffMs. Default 2000. */
    restartBaseMs?: number;
    /** Default 60000. */
    maxBackoffMs?: number;
    /** Grace between TERM and KILL on stop (ms). Default 3000. */
    killAfterMs?: number;
    /** Minimum gap between "feed stderr:" notes (ms). Default 5000. */
    stderrGapMs?: number;
  } = {}): FeedHandle {
  const note = (s: string) => { try { opts.onNote?.(s); } catch { /* host callback */ } };
  const err = (s: string) => { try { opts.onError?.(s); } catch { /* host callback */ } };
  const heartbeatType = spec.heartbeatType ?? "alive";
  const endType = spec.endType ?? "call_ended";
  const immediate = new Set(spec.immediate ?? []);
  const batchMs = Math.max(0, (spec.batchSeconds ?? 10) * 1000);
  const baseMs = opts.restartBaseMs ?? 2000;
  const maxMs = opts.maxBackoffMs ?? 60000;
  const killAfter = opts.killAfterMs ?? 3000;
  const stderrGap = opts.stderrGapMs ?? 5000;
  const env: NodeJS.ProcessEnv = { ...process.env, ...(opts.env ?? {}) };

  let stopped = false;
  let child: ChildProcess | undefined;
  let exited: Promise<void> = Promise.resolve();
  let backoff = baseMs;
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
    let lineChain: Promise<void> = Promise.resolve();

    const flush = () => {
      if (batchTimer) { clearTimeout(batchTimer); batchTimer = undefined; }
      if (batch.length === 0) return;
      const lines = batch; batch = [];
      enqueue(`New events (${lines.length}):\n${lines.map((l) => `- ${l}`).join("\n")}`, e);
    };

    const becomeActive = async (): Promise<void> => {
      phase = "active";
      if (spec.fullContext && spec.fullContext.length > 0) {
        try {
          const out = await run(spec.fullContext, opts.cwd, env);
          if (!stopped && e === epoch) enqueue(FULL_CONTEXT_PREFIX + out, e);
        } catch (x) {
          err(`feed full-context failed: ${x instanceof Error ? x.message : String(x)}`);
        }
      }
    };

    const checkActive = async (): Promise<boolean> => {
      if (!spec.activeCheck || spec.activeCheck.length === 0) return backlog > 0;
      try {
        const parsed = JSON.parse(await run(spec.activeCheck, opts.cwd, env)) as { active?: unknown };
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
        if (phase === "backlog" || (phase === "waiting" && spec.activeCheck)) {
          const first = phase === "backlog";
          if (await checkActive()) await becomeActive();
          else if (first) { phase = "waiting"; enqueue(WAITING_NOTE, e); }
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
      lineChain = lineChain.then(() => (stopped || e !== epoch ? undefined : onEvent(ev as Record<string, unknown>)))
        .catch((x) => err(`feed event failed: ${x instanceof Error ? x.message : String(x)}`));
    };

    let proc: ChildProcess;
    try {
      proc = spawn(spec.command[0]!, spec.command.slice(1), { cwd: opts.cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    } catch (x) {
      err(`feed spawn failed: ${x instanceof Error ? x.message : String(x)}`);
      scheduleRestart();
      return;
    }
    child = proc;
    let spawnFailed = false;
    exited = new Promise<void>((resolve) => {
      let done = false;
      const finish = (code: number | null, signal: NodeJS.Signals | null) => {
        if (done) return;
        done = true;
        if (batchTimer) { clearTimeout(batchTimer); batchTimer = undefined; }
        if (!stopped && !spawnFailed) note(`feed exited code=${code === null ? `signal ${signal}` : code}`);
        resolve();
        if (!stopped) scheduleRestart();
      };
      proc.on("error", (x) => { spawnFailed = true; err(`feed spawn failed: ${x.message}`); finish(null, null); });
      proc.on("close", finish);
    });

    let buf = "";
    proc.stdout!.setEncoding("utf8");
    proc.stdout!.on("data", (d: string) => {
      buf += d;
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) { onLine(buf.slice(0, i)); buf = buf.slice(i + 1); }
    });
    proc.stdout!.on("end", () => { if (buf) { onLine(buf); buf = ""; } });
    let errBuf = "";
    proc.stderr!.setEncoding("utf8");
    proc.stderr!.on("data", (d: string) => {
      errBuf += d;
      let i: number;
      while ((i = errBuf.indexOf("\n")) >= 0) {
        const l = errBuf.slice(0, i).trim(); errBuf = errBuf.slice(i + 1);
        const now = Date.now();
        if (l && now - lastStderr >= stderrGap) { lastStderr = now; note(`feed stderr: ${l}`); }
      }
    });
    proc.stderr!.on("error", () => {});
    proc.stdout!.on("error", () => {});
  }

  function scheduleRestart(): void {
    if (stopped) return;
    const wait = backoff;
    backoff = Math.min(backoff * 2, maxMs);
    restartTimer = setTimeout(() => { restartTimer = undefined; if (!stopped) spawnChild(); }, wait);
  }

  async function stop(): Promise<void> {
    if (!stopped) {
      stopped = true;
      if (restartTimer) { clearTimeout(restartTimer); restartTimer = undefined; }
    }
    const c = child;
    if (c && c.exitCode === null && c.signalCode === null) {
      c.kill("SIGTERM");
      const k = setTimeout(() => { try { c.kill("SIGKILL"); } catch { /* gone */ } }, killAfter);
      await exited;
      clearTimeout(k);
    } else {
      await exited;
    }
  }

  spawnChild();
  return handle;
}
