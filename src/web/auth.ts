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
import { chmodSync, closeSync, constants, fchmodSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
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

/**
 * The stored token, created on first use. A missing, empty or too-short file gets a fresh
 * 256-bit token. Symlinks are refused (O_NOFOLLOW) so the file cannot be redirected.
 *
 * Concurrent starters agree on one token: a token file only ever appears whole (written to a
 * temp file, then link(2)ed into place, which fails if the name is taken), so the first writer
 * wins and every other starter reads its token. An invalid file left by a crash or an outside
 * edit is moved aside first; if what got moved is not the invalid file this starter read (a
 * racer already replaced it), it is put back.
 */
export function loadOrCreateWebToken(stateDir: string): { token: string; path: string; created: boolean } {
  const dir = join(stateDir, "web");
  const file = webTokenPath(stateDir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const seenIno = inode(file);
  const existing = readTokenFile(file);
  if (existing !== null) return { token: existing, path: file, created: false };
  const token = randomBytes(32).toString("base64url");
  let tmp: string | undefined;
  let won = false;
  try {
    tmp = writeTempToken(file, token);
    if (seenIno !== null) {
      const aside = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.bad`;
      try {
        renameSync(file, aside);
        if (inode(aside) !== seenIno) claim(aside, file); // a racer's good token: put it back
        rmSync(aside, { force: true });
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; // another starter moved it first
      }
    }
    won = claim(tmp, file);
    // A racer may hold the good file aside for a moment before putting it back (above), so the
    // name can be briefly empty: wait a bounded time, and claim it again if it stays empty.
    for (let i = 0; i < 200; i++) {
      const t = readTokenFile(file);
      if (t !== null) return { token: t, path: file, created: won && t === token };
      if (inode(file) === null && claim(tmp, file)) won = true;
      else Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  } catch (e) {
    throw new Error(`web: cannot write the token file ${file}: ${(e as Error).message}`);
  } finally {
    if (tmp !== undefined) rmSync(tmp, { force: true });
  }
  throw new Error(`web: token file ${file} is still empty or too short after replacing it`);
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
