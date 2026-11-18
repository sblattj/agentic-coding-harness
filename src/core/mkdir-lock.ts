// A cross-process lock built on an atomic mkdir: whoever creates the directory
// holds it. Synchronous on purpose (callers hold it around execFileSync / sync
// fs work). The holder writes an `owner` file (pid + random token) inside, so
//   - a lock whose owner pid is gone is taken over at once, not after staleMs;
//   - release removes the directory only while it is still ours, so a holder
//     whose lock was taken over (it outlived staleMs) never deletes the
//     successor's lock.
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

export const sleepSync = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

export interface MkdirLockOptions {
  /** A lock older than this is taken over even if its owner still looks alive. */
  staleMs: number;
  /** Give up waiting after this long. */
  waitMs: number;
  /** On timeout: throw (default), or run `fn` without the lock. */
  onTimeout?: "throw" | "run";
  /** Poll interval while waiting. */
  pollMs?: number;
}

function readOwner(lock: string): { pid: number; token: string } | undefined {
  try {
    const [pid, token] = readFileSync(path.join(lock, "owner"), "utf8").trim().split(" ");
    const n = Number(pid);
    return Number.isInteger(n) && n > 0 && token ? { pid: n, token } : undefined;
  } catch {
    return undefined;
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Runs `fn` holding the lock directory `lock`, waiting (polling) for another holder. */
export function withMkdirLock<T>(lock: string, fn: () => T, opts: MkdirLockOptions): T {
  const token = `${process.pid} ${randomBytes(8).toString("hex")}`;
  const poll = opts.pollMs ?? 10;
  const deadline = Date.now() + opts.waitMs;
  let held = false;
  for (;;) {
    try {
      mkdirSync(lock, { mode: 0o700 });
      held = true;
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
    const st = statSync(lock, { throwIfNoEntry: false });
    if (st === undefined) continue; // released between our mkdir and stat
    const owner = readOwner(lock);
    const age = Date.now() - st.mtimeMs;
    // No owner file yet = a holder between mkdir and its write: only age makes it stale.
    if (age > opts.staleMs || (owner !== undefined && owner.pid !== process.pid && !alive(owner.pid))) {
      try {
        rmSync(lock, { recursive: true, force: true });
      } catch {
        /* another waiter took it over first */
      }
      continue;
    }
    if (Date.now() >= deadline) {
      if (opts.onTimeout === "run") break;
      throw new Error(`timed out waiting for ${lock}`);
    }
    sleepSync(poll);
  }
  if (held) {
    try {
      writeFileSync(path.join(lock, "owner"), `${token}\n`, { mode: 0o600 });
    } catch {
      /* taken over already; the release check below then leaves it alone */
    }
  }
  try {
    return fn();
  } finally {
    if (held && readOwner(lock)?.token === token.split(" ")[1]) rmSync(lock, { recursive: true, force: true });
  }
}
