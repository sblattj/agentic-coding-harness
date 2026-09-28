/**
 * Time windows, time zones and calendar bucket keys for `ach stats` and
 * `ach watch` (#26 date filters, #84 --tz, #44 --by week|month).
 *
 * Semantics (pinned by tests/stats-time.test.ts):
 *  - A window is `[sinceMs, untilMs)`: `--since` inclusive, `--until`
 *    exclusive, so adjacent ranges compose without overlap.
 *  - A bare date `YYYY-MM-DD` means local midnight of that day in the chosen
 *    zone; a full RFC 3339 timestamp is taken literally.
 *  - Relative forms (`7d ago`, `today`, `yesterday`, `now`) are resolved
 *    against an injected clock so tests are deterministic.
 *  - Bucket keys (`YYYY-MM-DD`, ISO week `YYYY-Www`, `YYYY-MM`) are computed
 *    in the chosen IANA zone with Intl (no dependencies).
 */
import { HarnessError } from "../core/types.ts";

export const TZ_ENV = "AGENTIC_CODING_HARNESS_TZ";

export type TimeGranularity = "day" | "week" | "month";
export const TIME_GRANULARITIES: readonly TimeGranularity[] = ["day", "week", "month"];

/** `[sinceMs, untilMs)`; an absent bound is unbounded on that side. */
export interface TimeWindow {
  sinceMs?: number;
  untilMs?: number;
}

const usage = (msg: string) => new HarnessError(msg, "USAGE");

// ---------------------------------------------------------------- zones

function isValidZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve the zone used for day/week/month boundaries and date parsing.
 * Precedence: `--tz` flag > AGENTIC_CODING_HARNESS_TZ > the machine's local
 * zone. Accepts `utc`, `local` (any case) or an IANA name. Returns the IANA
 * name actually used (reported as `timezone` in `stats --json`).
 */
export function resolveTimeZone(flag: string | undefined, env: string | undefined): string {
  const fromFlag = flag !== undefined && flag !== "";
  const fromEnv = !fromFlag && env !== undefined && env !== "";
  const raw = fromFlag ? flag : fromEnv ? env : "local";
  const lower = raw.toLowerCase();
  if (lower === "local") return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  if (lower === "utc" || lower === "z" || lower === "gmt") return "UTC";
  if (!isValidZone(raw)) {
    throw usage(
      `${fromFlag ? "--tz" : TZ_ENV}: unknown time zone '${raw}' ` +
        `(expected an IANA zone name such as America/Los_Angeles or Asia/Tokyo, or 'utc' / 'local')`,
    );
  }
  // Canonicalize case (e.g. asia/tokyo -> Asia/Tokyo).
  return new Intl.DateTimeFormat("en-US", { timeZone: raw }).resolvedOptions().timeZone;
}

const partsFmt = new Map<string, Intl.DateTimeFormat>();
function fmtFor(tz: string): Intl.DateTimeFormat {
  let f = partsFmt.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    partsFmt.set(tz, f);
  }
  return f;
}

interface Civil {
  y: number;
  m: number; // 1-12
  d: number;
  hh: number;
  mm: number;
  ss: number;
}

function civil(ms: number, tz: string): Civil {
  const out: Record<string, number> = {};
  for (const p of fmtFor(tz).formatToParts(new Date(ms))) {
    if (p.type !== "literal") out[p.type] = Number(p.value);
  }
  return { y: out.year!, m: out.month!, d: out.day!, hh: out.hour! % 24, mm: out.minute!, ss: out.second! };
}

/** Offset of `tz` from UTC at instant `ms`, in ms (Tokyo = +9h). */
function offsetMs(ms: number, tz: string): number {
  const c = civil(ms, tz);
  const asUtc = Date.UTC(c.y, c.m - 1, c.d, c.hh, c.mm, c.ss);
  return asUtc - (ms - (((ms % 1000) + 1000) % 1000));
}

/** Epoch ms of 00:00 local time on y-m-d in `tz` (DST-safe). */
export function zonedMidnight(y: number, m: number, d: number, tz: string): number {
  const guess = Date.UTC(y, m - 1, d);
  let t = guess - offsetMs(guess, tz);
  // Re-check at the candidate instant: the offset can differ across a DST
  // transition between `guess` and `t`.
  const t2 = guess - offsetMs(t, tz);
  if (t2 !== t) t = t2;
  return t;
}

const pad = (n: number, w = 2) => String(n).padStart(w, "0");

export function dayKey(ms: number, tz: string): string {
  const c = civil(ms, tz);
  return `${pad(c.y, 4)}-${pad(c.m)}-${pad(c.d)}`;
}

export function monthKey(ms: number, tz: string): string {
  const c = civil(ms, tz);
  return `${pad(c.y, 4)}-${pad(c.m)}`;
}

/** ISO-8601 week (Monday start; week 1 holds the year's first Thursday). */
export function weekKey(ms: number, tz: string): string {
  const c = civil(ms, tz);
  const date = new Date(Date.UTC(c.y, c.m - 1, c.d));
  const dow = date.getUTCDay() || 7; // Mon=1..Sun=7
  date.setUTCDate(date.getUTCDate() + 4 - dow); // Thursday of this week
  const isoYear = date.getUTCFullYear();
  const jan1 = Date.UTC(isoYear, 0, 1);
  const week = Math.ceil(((date.getTime() - jan1) / 86_400_000 + 1) / 7);
  return `${isoYear}-W${pad(week)}`;
}

/**
 * Bucket key for a record timestamp. Records without a parseable timestamp
 * land in "unknown" (never guessed).
 */
export function bucketKey(ts: string | null, g: TimeGranularity, tz: string): string {
  const t = ts ? Date.parse(ts) : NaN;
  if (!Number.isFinite(t)) return "unknown";
  return g === "day" ? dayKey(t, tz) : g === "week" ? weekKey(t, tz) : monthKey(t, tz);
}

// ---------------------------------------------------------------- parsing

export const ACCEPTED_FORMATS =
  "accepted: YYYY-MM-DD (midnight in the --tz zone), an RFC 3339 timestamp " +
  "(2026-09-01T12:00:00Z), '<N>m|h|d|w ago' (e.g. '7d ago'), today, yesterday, now";

const DUR_RE = /^(\d+(?:\.\d+)?)\s*(m|min|h|d|w)$/i;
const UNIT_MS: Record<string, number> = { m: 60_000, min: 60_000, h: 3_600_000, d: 86_400_000, w: 7 * 86_400_000 };

/** `7d` / `12h` / `2w` / `30m` → ms; undefined when not a duration. */
export function parseDuration(spec: string): number | undefined {
  const m = DUR_RE.exec(spec.trim());
  if (!m) return undefined;
  return Number(m[1]) * UNIT_MS[m[2]!.toLowerCase()]!;
}

export interface Clock {
  now: number;
  timeZone: string;
}

/** Parse one `--since` / `--until` value to epoch ms. */
export function parseTimeSpec(spec: string, clock: Clock, flag = "date"): number {
  const s = spec.trim();
  const bad = () => usage(`${flag}: cannot parse '${spec}' (${ACCEPTED_FORMATS})`);
  const lower = s.toLowerCase();
  if (lower === "now") return clock.now;
  if (lower === "today" || lower === "yesterday") {
    const c = civil(clock.now, clock.timeZone);
    const start = zonedMidnight(c.y, c.m, c.d, clock.timeZone);
    if (lower === "today") return start;
    const y = civil(start - 12 * 3_600_000, clock.timeZone);
    return zonedMidnight(y.y, y.m, y.d, clock.timeZone);
  }
  const ago = /^(.+?)\s+ago$/i.exec(s);
  if (ago) {
    const d = parseDuration(ago[1]!);
    if (d === undefined) throw bad();
    return clock.now - d;
  }
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (dateOnly) {
    const [y, m, d] = [Number(dateOnly[1]), Number(dateOnly[2]), Number(dateOnly[3])];
    const probe = new Date(Date.UTC(y, m - 1, d));
    if (m < 1 || m > 12 || probe.getUTCMonth() !== m - 1 || probe.getUTCDate() !== d) throw bad();
    return zonedMidnight(y, m, d, clock.timeZone);
  }
  // Full timestamps must carry a time and an explicit zone designator so the
  // instant is unambiguous.
  if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/i.test(s)) {
    const t = Date.parse(s.replace(" ", "T"));
    if (Number.isFinite(t)) return t;
  }
  throw bad();
}

export interface WindowFlags {
  days?: number;
  since?: string;
  until?: string;
  last?: string;
}

/**
 * The single code path that turns window flags into a `[since, until)` pair.
 * `--days N` (legacy) is mutually exclusive with --since/--until/--last;
 * `--last D` is sugar for `--since "D ago"`; `--until` alone means
 * "everything up to the bound".
 */
export function resolveWindow(f: WindowFlags & Clock): TimeWindow {
  if (f.days !== undefined) {
    const other = f.since !== undefined ? "--since" : f.until !== undefined ? "--until" : f.last !== undefined ? "--last" : undefined;
    if (other) throw usage(`--days cannot be combined with ${other} (use one way to express the window)`);
    return { sinceMs: f.now - f.days * 86_400_000 };
  }
  if (f.last !== undefined && f.since !== undefined) {
    throw usage(`--last cannot be combined with --since ('--last 7d' is sugar for '--since "7d ago"')`);
  }
  const w: TimeWindow = {};
  if (f.last !== undefined) {
    const d = parseDuration(f.last);
    if (d === undefined) throw usage(`--last: cannot parse '${f.last}' (expected <N>m|h|d|w, e.g. 7d)`);
    w.sinceMs = f.now - d;
  } else if (f.since !== undefined) {
    w.sinceMs = parseTimeSpec(f.since, f, "--since");
  }
  if (f.until !== undefined) w.untilMs = parseTimeSpec(f.until, f, "--until");
  if (w.sinceMs !== undefined && w.untilMs !== undefined && w.sinceMs >= w.untilMs) {
    throw usage(
      `empty window: --since ${new Date(w.sinceMs).toISOString()} is not before --until ${new Date(w.untilMs).toISOString()}`,
    );
  }
  return w;
}

/** `[since, until)` membership. A non-finite ts is outside any bounded window. */
export function inWindow(tsMs: number, w: TimeWindow): boolean {
  if (w.sinceMs === undefined && w.untilMs === undefined) return true;
  if (!Number.isFinite(tsMs)) return false;
  if (w.sinceMs !== undefined && tsMs < w.sinceMs) return false;
  if (w.untilMs !== undefined && tsMs >= w.untilMs) return false;
  return true;
}

/** JSON view of a window: ISO strings, null for an open side. */
export function windowJson(w: TimeWindow): { since: string | null; until: string | null } {
  return {
    since: w.sinceMs === undefined ? null : new Date(w.sinceMs).toISOString(),
    until: w.untilMs === undefined ? null : new Date(w.untilMs).toISOString(),
  };
}

/**
 * `ach stats --since 7d ago` (unquoted) reaches argv as three tokens; fold a
 * trailing `ago` into the preceding --since/--until value before parseArgs
 * sees it as a positional.
 */
export function joinAgoTokens(argv: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if ((a === "--since" || a === "--until") && argv[i + 2] === "ago") {
      out.push(a, `${argv[i + 1]} ago`);
      i += 2;
      continue;
    }
    if ((a.startsWith("--since=") || a.startsWith("--until=")) && argv[i + 1] === "ago") {
      out.push(`${a} ago`);
      i += 1;
      continue;
    }
    out.push(a);
  }
  return out;
}

/** `--by day|week|month` (repeatable, comma lists). Default: day. */
export function parseBy(values: string[] | undefined): TimeGranularity[] {
  if (!values || values.length === 0) return ["day"];
  const picked = new Set<TimeGranularity>();
  for (const v of values.flatMap((x) => x.split(","))) {
    const g = v.trim().toLowerCase();
    if (g === "") continue;
    if (!(TIME_GRANULARITIES as readonly string[]).includes(g)) {
      throw usage(`--by: unknown granularity '${v}' (expected one of: ${TIME_GRANULARITIES.join(", ")})`);
    }
    picked.add(g as TimeGranularity);
  }
  if (picked.size === 0) return ["day"];
  return TIME_GRANULARITIES.filter((g) => picked.has(g));
}
