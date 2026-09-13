// PtyManager: registry of live PTY sessions keyed by id, bridging spawned
// agent CLIs to browser websockets. Pure PTY/session layer — no Bun.serve.
// Backed by bun-pty (real PTY allocation: raw stdout bytes, ANSI intact,
// keystroke injection, SIGWINCH resize). bun-pty is loaded lazily so this
// module imports cleanly under the Node/tsx test runner (bun: scheme).
import type { IPty, IExitEvent } from "bun-pty";
import { HarnessError } from "../core/types.ts";

type PtySpawnFn = typeof import("bun-pty").spawn;
let ptySpawnCache: PtySpawnFn | null = null;
async function loadPtySpawn(): Promise<PtySpawnFn> {
  if (ptySpawnCache !== null) return ptySpawnCache;
  const mod = await import("bun-pty");
  ptySpawnCache = mod.spawn;
  return ptySpawnCache;
}

export interface PtySessionInfo {
  id: string;
  command: string;
  args: string[];
  cwd: string;
  cols: number;
  rows: number;
  startedAt: number;
  pid: number | null;
  alive: boolean;
  exitCode?: number;
  /** The harness run this terminal belongs to, when spawned from a run view. */
  runId?: string;
}

export interface PtySpawnOptions {
  command: string;
  args?: string[];
  cwd?: string;
  cols?: number;
  rows?: number;
  env?: Record<string, string>;
  id?: string;
  runId?: string;
}

interface Session {
  info: PtySessionInfo;
  term: IPty;
  chunks: string[];
  scrollbackLen: number;
  dataCbs: Set<(data: string) => void>;
  exitCbs: Set<(exitCode: number) => void>;
}

const SCROLLBACK_CAP = 200 * 1024; // bytes; late-joining browsers catch up

function newId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `pty-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export class PtyManager {
  #sessions = new Map<string, Session>();

  async spawn(opts: PtySpawnOptions): Promise<PtySessionInfo> {
    const id = opts.id ?? newId();
    let term: IPty;
    let spawnFn: PtySpawnFn;
    try {
      spawnFn = await loadPtySpawn();
    } catch (err) {
      throw new HarnessError(
        `bun-pty unavailable (PTY relay requires Bun): ${err instanceof Error ? err.message : String(err)}`,
        "SPAWN",
      );
    }
    try {
      term = spawnFn(opts.command, opts.args ?? [], {
        name: "xterm-color",
        cols: opts.cols ?? 80,
        rows: opts.rows ?? 24,
        cwd: opts.cwd ?? process.cwd(),
        env: (opts.env ?? process.env) as Record<string, string>,
      });
    } catch (err) {
      throw new HarnessError(
        `pty spawn failed for '${opts.command}': ${err instanceof Error ? err.message : String(err)}`,
        "SPAWN",
      );
    }
    const session: Session = {
      info: {
        id,
        command: opts.command,
        args: [...(opts.args ?? [])],
        cwd: opts.cwd ?? process.cwd(),
        cols: opts.cols ?? 80,
        rows: opts.rows ?? 24,
        startedAt: Date.now(),
        pid: typeof term.pid === "number" ? term.pid : null,
        alive: true,
        ...(opts.runId !== undefined ? { runId: opts.runId } : {}),
      },
      term,
      chunks: [],
      scrollbackLen: 0,
      dataCbs: new Set(),
      exitCbs: new Set(),
    };
    this.#sessions.set(id, session);
    term.onData((data: string) => {
      session.chunks.push(data);
      session.scrollbackLen += data.length;
      while (session.scrollbackLen > SCROLLBACK_CAP && session.chunks.length > 1) {
        session.scrollbackLen -= session.chunks[0]!.length;
        session.chunks.shift();
      }
      for (const cb of session.dataCbs) cb(data);
    });
    term.onExit((e: IExitEvent) => {
      session.info.alive = false;
      session.info.exitCode = e.exitCode;
      const cbs = [...session.exitCbs];
      session.dataCbs.clear();
      session.exitCbs.clear();
      for (const cb of cbs) cb(e.exitCode);
    });
    return { ...session.info };
  }

  onData(id: string, cb: (data: string) => void): () => void {
    const session = this.#sessions.get(id);
    if (session === undefined) return () => {};
    session.dataCbs.add(cb);
    return () => {
      session.dataCbs.delete(cb);
    };
  }

  onExit(id: string, cb: (exitCode: number) => void): () => void {
    const session = this.#sessions.get(id);
    if (session === undefined) return () => {};
    if (!session.info.alive) {
      cb(session.info.exitCode ?? 0);
      return () => {};
    }
    session.exitCbs.add(cb);
    return () => {
      session.exitCbs.delete(cb);
    };
  }

  write(id: string, data: string): boolean {
    const session = this.#sessions.get(id);
    if (session === undefined || !session.info.alive) return false;
    try {
      session.term.write(data);
      return true;
    } catch {
      return false;
    }
  }

  resize(id: string, cols: number, rows: number): boolean {
    const session = this.#sessions.get(id);
    if (session === undefined || !session.info.alive) return false;
    if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 1 || rows < 1) return false;
    try {
      session.term.resize(cols, rows);
      session.info.cols = cols;
      session.info.rows = rows;
      return true;
    } catch {
      return false;
    }
  }

  get(id: string): PtySessionInfo | null {
    const session = this.#sessions.get(id);
    return session === undefined ? null : { ...session.info };
  }

  list(includeDead = false): PtySessionInfo[] {
    return [...this.#sessions.values()]
      .filter((s) => includeDead || s.info.alive)
      .map((s) => ({ ...s.info }));
  }

  scrollback(id: string): string {
    const session = this.#sessions.get(id);
    return session === undefined ? "" : session.chunks.join("");
  }

  kill(id: string): boolean {
    const session = this.#sessions.get(id);
    if (session === undefined || !session.info.alive) return false;
    try {
      session.term.kill();
    } catch {
      // already gone
    }
    return true;
  }

  dispose(): void {
    for (const session of this.#sessions.values()) {
      if (session.info.alive) {
        try {
          session.term.kill();
        } catch {
          // already gone
        }
      }
    }
    this.#sessions.clear();
  }
}
