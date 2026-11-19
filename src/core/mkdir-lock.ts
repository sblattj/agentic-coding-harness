// A cross-process lock built on an atomic mkdir: whoever creates the directory
// holds it. Synchronous on purpose (callers hold it around execFileSync / sync
// fs work). The holder writes an `owner` file (pid + random token) inside, so
//   - a lock whose owner pid is gone is taken over at once, not after staleMs;
//   - release removes the directory only while it is still ours, so a holder
//     whose lock was taken over (it outlived staleMs) never deletes the
//     successor's lock.
//
// Every removal of the lock directory (a stale takeover or a release) happens
// under a short-lived guard, `<lock>.takeover` (its own atomic mkdir + owner
// file). Without it, two waiters can both judge the same lock stale; one
// removes it, a third process creates a successor, and the second waiter's
// remove then deletes the successor, letting two holders into `fn` at once.
// Under the guard a waiter re-reads the lock and removes it only if it is still
// the very instance (inode + owner token) it judged stale, and still stale.
// Plain acquires (mkdir of a free lock) never touch the guard.
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
  /** Test seam: runs after a waiter judges the lock stale, before it acts on that judgment. */
  beforeTakeover?: () => void;
}

/**
 * A guard is held for a few filesystem calls, so one left behind means its holder
 * died mid-takeover. It is cleared only when its owner pid is dead (or it has no
 * owner file) AND it is older than this. Clearing it is itself unguarded: two
 * waiters could both judge one dead guard stale and the slower could delete a
 * fresh guard taken in between. That residual window only opens after a process
 * died holding the guard, and is bounded by this age (it reopens at most once
 * per GUARD_STALE_MS per crashed guard holder).
 */
const GUARD_STALE_MS = 30_000;
/** Release waits this long for the guard (> GUARD_STALE_MS, so a crashed guard clears first), then removes unguarded. */
const RELEASE_GUARD_WAIT_MS = GUARD_STALE_MS + 5_000;

function readOwner(dir: string): { pid: number; token: string } | undefined {
  try {
    const [pid, token] = readFileSync(path.join(dir, "owner"), "utf8").trim().split(" ");
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

const newToken = (): string => `${process.pid} ${randomBytes(8).toString("hex")}`;

/** mkdir `dir` and stamp it with `token`; false if someone else holds it. */
function claim(dir: string, token: string): boolean {
  try {
    mkdirSync(dir, { mode: 0o700 });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw e;
  }
  try {
    writeFileSync(path.join(dir, "owner"), `${token}\n`, { mode: 0o600 });
  } catch {
    /* taken over already; the release check then leaves it alone */
  }
  return true;
}

type Judgment = "gone" | "held" | { ino: number; token: string | undefined };

/** Whether `lock` is stale right now, and if so which instance (inode + owner token). */
function judge(lock: string, staleMs: number): Judgment {
  const st = statSync(lock, { throwIfNoEntry: false });
  if (st === undefined) return "gone";
  const owner = readOwner(lock);
  const age = Date.now() - st.mtimeMs;
  // No owner file yet = a holder between mkdir and its write: only age makes it stale.
  const stale = age > staleMs || (owner !== undefined && owner.pid !== process.pid && !alive(owner.pid));
  return stale ? { ino: st.ino, token: owner?.token } : "held";
}

/** Takes the guard (returns its token), clearing a crashed holder's guard; undefined if busy. */
function tryGuard(guard: string): string | undefined {
  const token = newToken();
  if (claim(guard, token)) return token;
  const st = statSync(guard, { throwIfNoEntry: false });
  if (st !== undefined && Date.now() - st.mtimeMs > GUARD_STALE_MS) {
    const owner = readOwner(guard);
    if (owner === undefined || !alive(owner.pid)) rmSync(guard, { recursive: true, force: true });
  }
  return undefined;
}

function releaseGuard(guard: string, token: string): void {
  if (readOwner(guard)?.token === token.split(" ")[1]) rmSync(guard, { recursive: true, force: true });
}

/** Removes `lock` only while its owner token is ours, under the guard so no takeover interleaves. */
function release(lock: string, guard: string, token: string, poll: number): void {
  const mine = () => readOwner(lock)?.token === token.split(" ")[1];
  const deadline = Date.now() + RELEASE_GUARD_WAIT_MS;
  for (;;) {
    const g = tryGuard(guard);
    if (g !== undefined) {
      try {
        if (mine()) rmSync(lock, { recursive: true, force: true });
      } finally {
        releaseGuard(guard, g);
      }
      return;
    }
    if (Date.now() >= deadline) {
      // A live process has sat on the guard this long (e.g. stopped): fall back to the unguarded check.
      if (mine()) rmSync(lock, { recursive: true, force: true });
      return;
    }
    sleepSync(poll);
  }
}

/** Runs `fn` holding the lock directory `lock`, waiting (polling) for another holder. */
export function withMkdirLock<T>(lock: string, fn: () => T, opts: MkdirLockOptions): T {
  const token = newToken();
  const guard = `${lock}.takeover`;
  const poll = opts.pollMs ?? 10;
  const deadline = Date.now() + opts.waitMs;
  let held = false;
  for (;;) {
    if (claim(lock, token)) {
      held = true;
      break;
    }
    const seen = judge(lock, opts.staleMs);
    if (seen === "gone") continue; // released between our mkdir and stat
    if (seen !== "held") {
      opts.beforeTakeover?.();
      const g = tryGuard(guard);
      if (g !== undefined) {
        try {
          const now = judge(lock, opts.staleMs);
          // Only the exact instance we judged stale may go; a successor (new inode or token) stays.
          if (now !== "held" && (now === "gone" || (now.ino === seen.ino && now.token === seen.token))) {
            if (now !== "gone") rmSync(lock, { recursive: true, force: true });
            held = claim(lock, token); // false: a plain acquire beat us to the free lock
          }
        } finally {
          releaseGuard(guard, g);
        }
        if (held) break;
      }
    }
    if (Date.now() >= deadline) {
      if (opts.onTimeout === "run") break;
      throw new Error(`timed out waiting for ${lock}`);
    }
    sleepSync(poll);
  }
  try {
    return fn();
  } finally {
    if (held) release(lock, guard, token, poll);
  }
}
