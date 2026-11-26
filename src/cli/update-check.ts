// `ach update --check` (#98): opt-in version awareness, never an installer.
//
// Nothing here downloads, replaces or modifies the running binary. The only
// thing written is a small JSON cache file in the state dir
// (<state>/update-check.json) holding the last check time and the last seen
// release. The only network call is one GET of the release feed:
//   https://api.github.com/repos/sblattj/agentic-coding-harness/releases/latest
// of which two fields are read: `tag_name` (the version, a leading `v` is
// stripped) and `html_url` (the release page shown to the user).
//
// Two modes:
//  - explicit (`ach update --check`): always hits the network, always
//    updates the cache, reports failure plainly (the caller exits non-zero).
//  - automatic (env AGENTIC_CODING_HARNESS_UPDATE_CHECK=1, default OFF): at
//    most one network call per 24h (cache honored), one stderr line when a
//    newer release exists, and every error swallowed.
import fs from "node:fs/promises";
import path from "node:path";
import { stateDir } from "../core/store.ts";
import { OfflineViolation } from "../core/offline.ts";

export const UPDATE_CHECK_ENV = "AGENTIC_CODING_HARNESS_UPDATE_CHECK";
export const UPDATE_FEED_URL_ENV = "AGENTIC_CODING_HARNESS_UPDATE_FEED_URL";
export const DEFAULT_FEED_URL = "https://api.github.com/repos/sblattj/agentic-coding-harness/releases/latest";
export const AUTO_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const EXPLICIT_TIMEOUT_MS = 8000;
export const AUTO_TIMEOUT_MS = 2500;

export interface UpdateCache {
  /** Epoch ms of the last network attempt that updated the cache. */
  checkedAt: number;
  /** Last seen release version (no leading v), when a check succeeded. */
  latest?: string;
  /** Last seen release page URL. */
  url?: string;
}

export interface UpdateResult {
  current: string;
  latest: string;
  url: string;
  updateAvailable: boolean;
  checkedAt: string;
}

export function feedUrl(env: NodeJS.ProcessEnv = process.env): string {
  const v = env[UPDATE_FEED_URL_ENV];
  return v !== undefined && v.trim() !== "" ? v.trim() : DEFAULT_FEED_URL;
}

export function autoCheckEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env[UPDATE_CHECK_ENV];
  return v === "1" || v === "true";
}

export function cachePath(): string {
  return path.join(stateDir(), "update-check.json");
}

export async function readCache(): Promise<UpdateCache | null> {
  try {
    const raw = JSON.parse(await fs.readFile(cachePath(), "utf8")) as Record<string, unknown>;
    if (typeof raw.checkedAt !== "number" || !Number.isFinite(raw.checkedAt)) return null;
    return {
      checkedAt: raw.checkedAt,
      ...(typeof raw.latest === "string" ? { latest: raw.latest } : {}),
      ...(typeof raw.url === "string" ? { url: raw.url } : {}),
    };
  } catch {
    return null;
  }
}

export async function writeCache(c: UpdateCache): Promise<void> {
  const file = cachePath();
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(c, null, 2) + "\n");
}

/** Strip a leading `v`/`V` and surrounding space. */
export function normalizeVersion(v: string): string {
  return v.trim().replace(/^[vV]/, "");
}

interface Parsed { core: number[]; pre: string[] }

function parseVersion(v: string): Parsed | null {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(normalizeVersion(v));
  if (m === null) return null;
  return { core: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] === undefined ? [] : m[4].split(".") };
}

/** Semver precedence: negative when a < b, 0 when equal, positive when a > b. null if unparseable. */
export function compareVersions(a: string, b: string): number | null {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (pa === null || pb === null) return null;
  for (let i = 0; i < 3; i++) {
    const d = pa.core[i]! - pb.core[i]!;
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  if (pa.pre.length === 0 && pb.pre.length === 0) return 0;
  if (pa.pre.length === 0) return 1; // a release outranks its prereleases
  if (pb.pre.length === 0) return -1;
  const n = Math.max(pa.pre.length, pb.pre.length);
  for (let i = 0; i < n; i++) {
    const x = pa.pre[i];
    const y = pb.pre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn) {
      if (Number(x) !== Number(y)) return Number(x) < Number(y) ? -1 : 1;
    } else if (xn !== yn) {
      return xn ? -1 : 1; // numeric identifiers rank below alphanumeric ones
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

export interface FeedRelease { version: string; url: string }

/**
 * GET the release feed and read `tag_name` + `html_url`. Throws an Error with
 * a plain reason on timeout, connection failure, non-2xx or a bad body. An
 * OfflineViolation (the --offline guard refusing a non-loopback feed) is
 * rethrown as-is.
 */
export async function fetchLatestRelease(
  url: string,
  currentVersion: string,
  timeoutMs: number,
): Promise<FeedRelease> {
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { accept: "application/vnd.github+json", "user-agent": `agentic-coding-harness/${currentVersion}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    if (e instanceof OfflineViolation) throw e;
    const why = e instanceof Error ? (e.name === "TimeoutError" ? `timed out after ${timeoutMs} ms` : (e.cause instanceof Error ? e.cause.message : e.message)) : String(e);
    throw new Error(`could not reach the release feed ${url}: ${why}`);
  }
  if (!res.ok) throw new Error(`release feed ${url} answered HTTP ${res.status}`);
  let body: unknown;
  try {
    body = JSON.parse(await res.text());
  } catch {
    throw new Error(`release feed ${url} did not return JSON`);
  }
  const o = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
  if (typeof o.tag_name !== "string" || typeof o.html_url !== "string" || parseVersion(o.tag_name) === null) {
    throw new Error(`release feed ${url} has no usable tag_name/html_url`);
  }
  return { version: normalizeVersion(o.tag_name), url: o.html_url };
}

/** Explicit check: always hits the network and refreshes the cache. Throws on failure (cache untouched). */
export async function checkForUpdate(
  currentVersion: string,
  opts: { url?: string; timeoutMs?: number; now?: () => number } = {},
): Promise<UpdateResult> {
  const now = opts.now ?? Date.now;
  const rel = await fetchLatestRelease(opts.url ?? feedUrl(), currentVersion, opts.timeoutMs ?? EXPLICIT_TIMEOUT_MS);
  const checkedAt = now();
  await writeCache({ checkedAt, latest: rel.version, url: rel.url });
  const cmp = compareVersions(rel.version, currentVersion);
  return {
    current: currentVersion,
    latest: rel.version,
    url: rel.url,
    updateAvailable: cmp !== null && cmp > 0,
    checkedAt: new Date(checkedAt).toISOString(),
  };
}

export function formatUpdateResult(r: UpdateResult): string {
  return r.updateAvailable
    ? `new version ${r.latest} available: ${r.url} (you have ${r.current})`
    : `up to date (${r.current})`;
}

/**
 * Automatic startup check. Returns the one line to print to stderr, or null.
 * Zero network calls unless the env opt-in is set AND the cache is 24h old
 * (or absent). Every failure is swallowed; a failed attempt still stamps the
 * cache so an offline machine does not retry (and stall) on every command.
 */
export async function autoUpdateNotice(
  currentVersion: string,
  opts: { env?: NodeJS.ProcessEnv; url?: string; timeoutMs?: number; now?: () => number } = {},
): Promise<string | null> {
  const env = opts.env ?? process.env;
  if (!autoCheckEnabled(env)) return null;
  const now = (opts.now ?? Date.now)();
  try {
    const cache = await readCache();
    if (cache !== null && now - cache.checkedAt >= 0 && now - cache.checkedAt < AUTO_INTERVAL_MS) return null;
    let line: string | null = null;
    let next: UpdateCache;
    try {
      const rel = await fetchLatestRelease(opts.url ?? feedUrl(env), currentVersion, opts.timeoutMs ?? AUTO_TIMEOUT_MS);
      next = { checkedAt: now, latest: rel.version, url: rel.url };
      const cmp = compareVersions(rel.version, currentVersion);
      if (cmp !== null && cmp > 0) {
        line = `ach: new version ${rel.version} available: ${rel.url} (you have ${currentVersion}; silence with ${UPDATE_CHECK_ENV}=0)`;
      }
    } catch {
      next = { ...(cache ?? {}), checkedAt: now };
    }
    await writeCache(next).catch(() => undefined);
    return line;
  } catch {
    return null;
  }
}
