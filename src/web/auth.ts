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
import { chmodSync, closeSync, constants, fchmodSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
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

/**
 * The stored token, created on first use. A missing, empty or too-short file gets a fresh
 * 256-bit token. Symlinks are refused (O_NOFOLLOW) so the file cannot be redirected.
 */
export function loadOrCreateWebToken(stateDir: string): { token: string; path: string; created: boolean } {
  const dir = join(stateDir, "web");
  const file = webTokenPath(stateDir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const existing = readTokenFile(file);
  if (existing !== null) return { token: existing, path: file, created: false };
  const token = randomBytes(32).toString("base64url");
  let fd: number;
  try {
    // O_EXCL: two `ach web` starting at once must not each keep a different token.
    fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") {
      const raced = readTokenFile(file);
      if (raced !== null) return { token: raced, path: file, created: false };
      // An empty or too-short file: replace it in place.
      fd = openSync(file, constants.O_WRONLY | constants.O_TRUNC | constants.O_NOFOLLOW);
    } else {
      throw new Error(`web: cannot write the token file ${file}: ${(e as Error).message}`);
    }
  }
  try {
    fchmodSync(fd, 0o600);
    writeSync(fd, `${token}\n`);
  } finally {
    closeSync(fd);
  }
  return { token, path: file, created: true };
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
