// `ach web` auth (#212 review, the Jupyter model): one bearer token per server.
//
// - `ach web` always has a token: --token, else AGENTIC_CODING_HARNESS_HTTP_TOKEN, else the
//   generated one in <stateDir>/web/token (32 random bytes, file 0600, dir 0700, reused across
//   restarts so a bookmarked ?token= URL keeps working). An empty value counts as unset.
// - A request proves it holds the token by ?token=, Authorization: Bearer, or the cookie the
//   server sets on a request that carried a valid ?token= (HttpOnly, SameSite=Strict, per
//   port). So a page opened once with ?token= keeps working: its same-origin fetch, EventSource
//   and WebSocket calls carry the cookie without the page knowing the token.
import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, closeSync, constants, fchmodSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmdirSync, rmSync, statSync, writeSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { join } from "node:path";

/** Where `ach web` keeps its generated token. The macOS app reads the same path. */
export function webTokenPath(stateDir: string): string {
  return join(stateDir, "web", "token");
}

const MIN_TOKEN_LEN = 16;

function readTokenFile(file: string): string | null {
  let fd: number;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
  try {
    fchmodSync(fd, 0o600); // tighten a file someone loosened
    const t = readFileSync(fd, "utf8").trim();
    return t.length >= MIN_TOKEN_LEN ? t : null;
  } finally {
    closeSync(fd);
  }
}

/** Writes a complete token file at a unique temp path (0600) and returns that path. */
function writeTempToken(file: string, token: string): string {
  const tmp = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  const fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    fchmodSync(fd, 0o600);
    writeSync(fd, `${token}\n`);
  } finally {
    closeSync(fd);
  }
  return tmp;
}

/** link(2) the finished temp file to `file`: true if ours won, false if a file was already there. */
function claim(tmp: string, file: string): boolean {
  try {
    linkSync(tmp, file);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw e;
  }
}

function inode(file: string): number | null {
  return lstatSync(file, { throwIfNoEntry: false })?.ino ?? null;
}

const sleepMs = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

/** A lock left by a starter that died mid-replace is taken over after this long. */
const LOCK_STALE_MS = 10_000;

/** Runs `fn` holding `<file>.lock` (an atomic mkdir), waiting up to ~15 s for another holder. */
function withReplaceLock<T>(file: string, fn: () => T): T {
  const lock = `${file}.lock`;
  for (let i = 0; ; i++) {
    try {
      mkdirSync(lock, { mode: 0o700 });
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      const st = statSync(lock, { throwIfNoEntry: false });
      if (st !== undefined && Date.now() - st.mtimeMs > LOCK_STALE_MS) {
        try {
          rmdirSync(lock);
        } catch {
          /* another starter took it over first */
        }
        continue;
      }
      if (i >= 1500) throw new Error(`timed out waiting for ${lock}`);
      sleepMs(10);
    }
  }
  try {
    return fn();
  } finally {
    rmdirSync(lock);
  }
}

/**
 * The stored token, created on first use. A missing, empty or too-short file gets a fresh
 * 256-bit token. Symlinks are refused (O_NOFOLLOW) so the file cannot be redirected.
 *
 * Concurrent starters agree on one token. A token file only ever appears whole: it is written
 * to a temp file first. A missing name is claimed with link(2), which fails if the name is
 * taken, so the first writer wins and the others read its token. An invalid file (left by a
 * crash or an outside edit) is replaced only under a lock, after re-reading it under that lock,
 * so a starter that arrives late reads the replacement instead of writing its own.
 */
export function loadOrCreateWebToken(stateDir: string): { token: string; path: string; created: boolean } {
  const dir = join(stateDir, "web");
  const file = webTokenPath(stateDir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const existing = readTokenFile(file);
  if (existing !== null) return { token: existing, path: file, created: false };
  const token = randomBytes(32).toString("base64url");
  let tmp: string | undefined;
  try {
    tmp = writeTempToken(file, token);
    const t = tmp;
    if (claim(t, file)) return { token, path: file, created: true };
    const raced = readTokenFile(file);
    if (raced !== null) return { token: raced, path: file, created: false };
    return withReplaceLock(file, () => {
      const now = readTokenFile(file);
      if (now !== null) return { token: now, path: file, created: false };
      if (inode(file) === null) {
        if (claim(t, file)) return { token, path: file, created: true };
      } else {
        renameSync(t, file); // replaces the invalid file atomically; only the lock holder does this
        tmp = undefined;
        return { token, path: file, created: true };
      }
      const after = readTokenFile(file);
      if (after === null) throw new Error("still empty or too short after replacing it");
      return { token: after, path: file, created: false };
    });
  } catch (e) {
    throw new Error(`web: cannot write the token file ${file}: ${(e as Error).message}`);
  } finally {
    if (tmp !== undefined) rmSync(tmp, { force: true });
  }
}

/** Cookie name per port: cookies ignore ports, so two servers on one host must not share one. */
export function tokenCookieName(port: number): string {
  return `ach_web_token_${port}`;
}

/** 30 days: the stored token survives restarts, so the cookie may too. */
const COOKIE_MAX_AGE_S = 30 * 24 * 3600;

/** Set-Cookie value for a request that proved the token with ?token=. */
export function tokenCookie(port: number, token: string): string {
  return `${tokenCookieName(port)}=${encodeURIComponent(token)}; Path=/; Max-Age=${COOKIE_MAX_AGE_S}; HttpOnly; SameSite=Strict`;
}

function cookieValue(req: IncomingMessage, name: string): string | undefined {
  const raw = req.headers.cookie;
  if (raw === undefined) return undefined;
  for (const part of raw.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    if (part.slice(0, i).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(i + 1).trim());
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function same(a: string | undefined | null, b: string): boolean {
  if (a === undefined || a === null) return false;
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** True when ?token= itself is valid (the server answers with the cookie then). */
export function queryHasToken(url: URL, token: string | undefined): boolean {
  return token !== undefined && token !== "" && same(url.searchParams.get("token"), token);
}

/** ?token=, Bearer, or the per-port cookie (when the port is known) matches. No token configured: never authorized. */
export function requestHasToken(req: IncomingMessage, url: URL, token: string | undefined, port?: number): boolean {
  if (token === undefined || token === "") return false;
  if (same(url.searchParams.get("token"), token)) return true;
  const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1];
  if (same(bearer, token)) return true;
  return port !== undefined && same(cookieValue(req, tokenCookieName(port)), token);
}
