// LivePty (#195): one ach-owned PTY for an interactive run.
//
// Wraps a bun-pty terminal with what the run needs on top of it: a scrollback
// ring for late joiners (web tile, `ach attach`), data/exit fan-out, an
// interrupt that escalates SIGINT -> SIGTERM -> SIGKILL, and an asciicast v2
// recording of the raw TUI bytes.
import { createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import path from "node:path";
import { HarnessError } from "../core/types.ts";

/** The slice of bun-pty's IPty this module uses (a fake implements it in tests). */
export interface PtyLike {
  readonly pid: number;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
  onData(cb: (data: string) => void): unknown;
  onExit(cb: (e: { exitCode: number; signal?: number | string }) => void): unknown;
}

export interface PtySpawnRequest {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  cols: number;
  rows: number;
}

export type PtyFactory = (req: PtySpawnRequest) => Promise<PtyLike>;

/** The error every runtime without bun-pty gets. Wording pinned by tests. */
export const NEEDS_BUN_PTY =
  "interactive runs need the npm/bun install: the PTY comes from bun-pty, which needs the Bun runtime and is not bundled in standalone binaries or the Node build";

/** True inside a `bun build --compile` executable (virtual /$bunfs root). */
function isStandaloneBinary(): boolean {
  try {
    return import.meta.url.includes("$bunfs") || import.meta.url.includes("~BUN");
  } catch {
    return false;
  }
}

/** Load bun-pty's spawn, or throw the NEEDS_BUN_PTY error with the reason. */
export async function loadBunPty(): Promise<PtyFactory> {
  const why = (detail: string) => new HarnessError(`${NEEDS_BUN_PTY} (${detail}). Install with \`bun add -g agentic-coding-harness\` or run from a checkout with \`bun src/cli/ach.ts\`.`, "USAGE");
  if (typeof (process.versions as Record<string, string | undefined>).bun !== "string") {
    throw why(`running under Node ${process.versions.node}`);
  }
  if (isStandaloneBinary()) throw why("this is a standalone binary");
  let spawn: typeof import("bun-pty").spawn;
  try {
    spawn = (await import("bun-pty")).spawn;
  } catch (err) {
    throw why(`bun-pty failed to load: ${err instanceof Error ? err.message : String(err)}`);
  }
  return async (req) => {
    let term: PtyLike;
    try {
      term = spawn(req.command, req.args, { name: "xterm-256color", cols: req.cols, rows: req.rows, cwd: req.cwd, env: req.env }) as unknown as PtyLike;
    } catch (err) {
      throw new HarnessError(`pty spawn failed for '${req.command}': ${err instanceof Error ? err.message : String(err)}`, "SPAWN");
    }
    // Subscribe in the same tick as spawn(): bun-pty reads in a microtask and
    // drops whatever it reads before the first listener exists.
    return holdUntilSubscribed(term);
  };
}

const SCROLLBACK_CAP = 256 * 1024;

/**
 * Wrap a PTY so output and exit that happen before anyone subscribes are
 * kept and handed to the first subscriber, instead of being lost.
 *
 * bun-pty starts its read loop in a microtask queued by spawn() and fires
 * each chunk only to the listeners present then. LivePty subscribes after
 * the async factory resolves, so a process that stalls between spawn() and
 * that first read (a loaded CI runner) read the TUI's first bytes, its
 * banner, with nobody listening: they never reached the scrollback, the
 * cast or any viewer. Call this synchronously right after spawn().
 */
export function holdUntilSubscribed(term: PtyLike): PtyLike {
  let early: string[] | null = [];
  let earlyLen = 0;
  const dataCbs = new Set<(d: string) => void>();
  let exitEvent: { exitCode: number; signal?: number | string } | null = null;
  const exitCbs = new Set<(e: { exitCode: number; signal?: number | string }) => void>();
  term.onData((d: string) => {
    if (early !== null) {
      early.push(d);
      earlyLen += d.length;
      while (earlyLen > SCROLLBACK_CAP && early.length > 1) earlyLen -= early.shift()!.length;
      return;
    }
    for (const cb of [...dataCbs]) cb(d);
  });
  term.onExit((e) => {
    exitEvent = e;
    for (const cb of [...exitCbs]) cb(e);
  });
  return {
    get pid() {
      return term.pid;
    },
    write: (data) => term.write(data),
    resize: (cols, rows) => term.resize(cols, rows),
    kill: (signal) => term.kill(signal),
    onData(cb) {
      dataCbs.add(cb);
      if (early !== null) {
        // The first subscriber gets the held output, oldest first, before any later chunk.
        const held = early;
        early = null;
        earlyLen = 0;
        for (const d of held) cb(d);
      }
      return { dispose: () => dataCbs.delete(cb) };
    },
    onExit(cb) {
      if (exitEvent !== null) {
        cb(exitEvent);
        return { dispose: () => {} };
      }
      exitCbs.add(cb);
      return { dispose: () => exitCbs.delete(cb) };
    },
  };
}

export interface LivePtyOptions {
  cols: number;
  rows: number;
  /** Write an asciicast v2 recording of the raw TUI output here. */
  castPath?: string;
  castTitle?: string;
  /** Escalation delays for interrupt(), ms (defaults 2000 then 3000). */
  sigtermAfterMs?: number;
  sigkillAfterMs?: number;
}

export class LivePty {
  readonly #term: PtyLike;
  #chunks: string[] = [];
  #len = 0;
  #dataCbs = new Set<(d: string) => void>();
  #exitCbs = new Set<(code: number) => void>();
  #alive = true;
  #exitCode: number | null = null;
  #cols: number;
  #rows: number;
  #cast: WriteStream | null = null;
  #castStart = Date.now();
  #interrupting = false;
  #timers: Array<ReturnType<typeof setTimeout>> = [];
  readonly #opts: LivePtyOptions;
  readonly exited: Promise<number>;

  constructor(term: PtyLike, opts: LivePtyOptions) {
    this.#term = term;
    this.#opts = opts;
    this.#cols = opts.cols;
    this.#rows = opts.rows;
    if (opts.castPath !== undefined) {
      try {
        mkdirSync(path.dirname(opts.castPath), { recursive: true });
        this.#cast = createWriteStream(opts.castPath, { encoding: "utf8" });
        this.#cast.on("error", () => {
          this.#cast = null;
        });
        const header = { version: 2, width: opts.cols, height: opts.rows, timestamp: Math.floor(this.#castStart / 1000), ...(opts.castTitle ? { title: opts.castTitle } : {}) };
        this.#cast.write(JSON.stringify(header) + "\n");
      } catch {
        this.#cast = null;
      }
    }
    let resolveExit!: (code: number) => void;
    this.exited = new Promise<number>((r) => {
      resolveExit = r;
    });
    term.onData((d: string) => {
      this.#chunks.push(d);
      this.#len += d.length;
      while (this.#len > SCROLLBACK_CAP && this.#chunks.length > 1) this.#len -= this.#chunks.shift()!.length;
      this.#castEvent("o", d);
      for (const cb of this.#dataCbs) {
        try {
          cb(d);
        } catch {
          /* a viewer must never break the run */
        }
      }
    });
    term.onExit((e) => {
      this.#alive = false;
      this.#exitCode = e.exitCode;
      for (const t of this.#timers) clearTimeout(t);
      this.#timers = [];
      this.#cast?.end();
      this.#cast = null;
      const cbs = [...this.#exitCbs];
      this.#exitCbs.clear();
      this.#dataCbs.clear();
      for (const cb of cbs) {
        try {
          cb(e.exitCode);
        } catch {
          /* ignore */
        }
      }
      resolveExit(e.exitCode);
    });
  }

  get pid(): number {
    return this.#term.pid;
  }
  get alive(): boolean {
    return this.#alive;
  }
  get exitCode(): number | null {
    return this.#exitCode;
  }
  get size(): { cols: number; rows: number } {
    return { cols: this.#cols, rows: this.#rows };
  }
  /** True once interrupt() was requested. */
  get interrupted(): boolean {
    return this.#interrupting;
  }

  scrollback(): string {
    return this.#chunks.join("");
  }

  onData(cb: (d: string) => void): () => void {
    if (!this.#alive) return () => {};
    this.#dataCbs.add(cb);
    return () => this.#dataCbs.delete(cb);
  }

  onExit(cb: (code: number) => void): () => void {
    if (!this.#alive) {
      cb(this.#exitCode ?? 0);
      return () => {};
    }
    this.#exitCbs.add(cb);
    return () => this.#exitCbs.delete(cb);
  }

  write(data: string): boolean {
    if (!this.#alive) return false;
    try {
      this.#term.write(data);
      return true;
    } catch {
      return false;
    }
  }

  resize(cols: number, rows: number): boolean {
    if (!this.#alive || !Number.isInteger(cols) || !Number.isInteger(rows) || cols < 1 || rows < 1) return false;
    if (cols === this.#cols && rows === this.#rows) return true;
    try {
      this.#term.resize(cols, rows);
      this.#cols = cols;
      this.#rows = rows;
      this.#castEvent("r", `${cols}x${rows}`);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Abort: SIGINT to the PTY's process, then SIGTERM, then SIGKILL if it is
   * still running. Idempotent.
   */
  interrupt(): void {
    if (!this.#alive || this.#interrupting) return;
    this.#interrupting = true;
    this.#signal("SIGINT");
    const t1 = setTimeout(() => {
      if (this.#alive) this.#signal("SIGTERM");
    }, this.#opts.sigtermAfterMs ?? 2000);
    const t2 = setTimeout(() => {
      if (this.#alive) this.#signal("SIGKILL");
    }, (this.#opts.sigtermAfterMs ?? 2000) + (this.#opts.sigkillAfterMs ?? 3000));
    t1.unref?.();
    t2.unref?.();
    this.#timers.push(t1, t2);
  }

  // bun-pty's kill() ignores its signal argument (it always tears the PTY
  // down), so SIGINT/SIGTERM go to the child pid directly and only the final
  // step closes the PTY handle.
  #signal(sig: "SIGINT" | "SIGTERM" | "SIGKILL"): void {
    try {
      process.kill(this.#term.pid, sig);
    } catch {
      /* already gone */
    }
    if (sig === "SIGKILL") {
      try {
        this.#term.kill();
      } catch {
        /* already closed */
      }
    }
  }

  #castEvent(kind: "o" | "r", data: string): void {
    if (this.#cast === null) return;
    const t = (Date.now() - this.#castStart) / 1000;
    this.#cast.write(JSON.stringify([Number(t.toFixed(6)), kind, data]) + "\n");
  }
}
