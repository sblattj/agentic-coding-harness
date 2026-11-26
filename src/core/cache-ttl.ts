// Prompt-cache TTL with honesty tiers (#83).
//
// A cache hit re-reads the prompt at a fraction of the input price; a miss
// re-pays it in full (a cache write). How long a cached prompt stays warm is
// the time-to-live (TTL). ach shows it next to the cache token counts, and
// every TTL value carries a tier that says where it came from:
//
//   reported  a vendor said so: an adapter event carried an explicit expiry
//             (extra.cacheTtlMs or extra.cacheExpiresAt), or Anthropic's
//             usage.cache_creation split (cacheWrite1hTokens, #105) said which
//             TTL class the write went into (5m or 1h).
//   measured  ach observed it: the longest gap between a cache write and the
//             next cache read on the same prompt prefix. A read that lands
//             proves the entry was still warm, so this is a lower bound on the
//             TTL, and it is measured behavior, not a constant.
//   est       our estimate: DEFAULT_CACHE_TTL_MS, used when cache tokens exist
//             but nothing better is known.
//
// `ttl: null` (rendered "n/a") means nothing is known: no cache tokens at all.
//
// The type is the honesty rule. CacheTtl is a tagged union whose tag is
// required and limited to the three tiers, so a bare number or an unlabeled
// object does not type-check (tests/cache-ttl-types.test.ts pins this with
// expected-error directives that `npm run typecheck` enforces). Display goes through
// fmtCacheTtl, which always prints the tier.
//
// Display and data model only: nothing here touches cost math.

/**
 * The estimated prompt-cache TTL: 5 minutes.
 *
 * Rationale: Anthropic's default ephemeral cache lives 5 minutes from its last
 * use (the 1-hour class is opt-in and is reported per write, so it never needs
 * this estimate), and OpenAI documents automatic prompt caching as typically
 * evicted after 5 to 10 minutes of inactivity. 5 minutes is the shortest of
 * those, so the estimate errs toward "expired" rather than promising a warm
 * cache. This is the ONE place the constant lives (docs/CACHE-TTL.md).
 */
export const DEFAULT_CACHE_TTL_MS = 5 * 60_000;

/** Anthropic's two ephemeral cache classes (usage.cache_creation). */
export const ANTHROPIC_TTL_5M_MS = 5 * 60_000;
export const ANTHROPIC_TTL_1H_MS = 60 * 60_000;

export const CACHE_TTL_TIERS = ["est", "reported", "measured"] as const;
export type CacheTtlTier = (typeof CACHE_TTL_TIERS)[number];

/** A TTL value always travels with its tier. `value` is milliseconds. */
export type CacheTtl =
  | { readonly tier: "est"; readonly value: number }
  | { readonly tier: "reported"; readonly value: number }
  | { readonly tier: "measured"; readonly value: number; readonly samples: number };

/** The cache panel `ach stats --json` and the web run view carry. */
export interface CachePanel {
  /** Prompt tokens served from the cache. */
  cacheRead: number;
  /** Prompt tokens written to the cache (cache_creation). */
  cacheCreation: number;
  /** Uncached, plain input tokens. */
  input: number;
  /** null = nothing known (no cache tokens). */
  ttl: CacheTtl | null;
}

/** One usage record as the TTL derivation sees it. */
export interface CacheSample {
  /** Epoch ms; null when the record has no usable time (never measured). */
  ts: number | null;
  agent?: string | undefined;
  sessionId?: string | null | undefined;
  model?: string | null | undefined;
  inputTokens?: number | undefined;
  cacheReadTokens?: number | undefined;
  cacheWriteTokens?: number | undefined;
  cacheWrite1hTokens?: number | undefined;
  extra?: Record<string, unknown> | undefined;
}

export const estTtl = (): CacheTtl => ({ tier: "est", value: DEFAULT_CACHE_TTL_MS });
export const reportedTtl = (value: number): CacheTtl => ({ tier: "reported", value });
export const measuredTtl = (value: number, samples: number): CacheTtl => ({ tier: "measured", value, samples });

const pos = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);

/**
 * The vendor-reported TTL a single record carries, in ms, or undefined.
 *
 *  - extra.cacheTtlMs: an explicit TTL (ms) an adapter copied from the vendor.
 *  - extra.cacheExpiresAt: an explicit expiry (epoch ms or ISO string); the
 *    TTL is expiry minus the record's own time.
 *  - cacheWrite1hTokens (Anthropic usage.cache_creation split, #105): defined
 *    only when the vendor reported the split. Any 5-minute slice means part of
 *    the write expires in 5m (the earliest expiry is the one that bites), so
 *    the record reports 5m; an all-1h write reports 1h. A record that wrote
 *    nothing says nothing about TTL.
 */
export function recordReportedTtlMs(s: CacheSample): number | undefined {
  const ex = s.extra;
  const ttl = ex?.cacheTtlMs;
  if (typeof ttl === "number" && Number.isFinite(ttl) && ttl > 0) return ttl;
  const exp = ex?.cacheExpiresAt;
  if (s.ts !== null && (typeof exp === "number" || typeof exp === "string")) {
    const at = typeof exp === "number" ? exp : Date.parse(exp);
    if (Number.isFinite(at) && at > s.ts) return at - s.ts;
  }
  const write = pos(s.cacheWriteTokens);
  if (s.cacheWrite1hTokens !== undefined && write > 0) {
    return pos(s.cacheWrite1hTokens) >= write ? ANTHROPIC_TTL_1H_MS : ANTHROPIC_TTL_5M_MS;
  }
  return undefined;
}

/**
 * The prompt-prefix key two records must share before a write-to-read gap
 * counts as a measurement, or null (never measured).
 *
 * An adapter that knows the prefix sets extra.cachePrefix (an opaque id, e.g.
 * a hash of the cached prompt prefix); then only an equal id matches. Without
 * one, the prefix is the conversation: same agent, same known session, same
 * model (provider caches are per model, and each agent turn re-sends the
 * session's earlier turns as its prompt prefix). A record with neither an id
 * nor a known session is never paired.
 */
export function cachePrefixKey(s: CacheSample): string | null {
  const p = s.extra?.cachePrefix;
  if (typeof p === "string" && p !== "") return `prefix\0${p}`;
  const sid = s.sessionId;
  if (typeof sid !== "string" || sid === "" || sid === "unknown") return null;
  return `session\0${s.agent ?? ""}\0${sid}\0${s.model ?? ""}`;
}

/**
 * Observed write-to-next-read gaps (ms) per prefix: for each prefix, walk its
 * records in time order; a record with a cache write arms the prefix, and the
 * next record on the same prefix that reads from the cache, strictly later,
 * yields one gap. A miss in between (another write without a read) re-arms it
 * at the newer write. Records without a time or a prefix key are skipped.
 */
export function observedCacheGaps(samples: readonly CacheSample[]): number[] {
  const byPrefix = new Map<string, CacheSample[]>();
  for (const s of samples) {
    if (s.ts === null || !Number.isFinite(s.ts)) continue;
    const key = cachePrefixKey(s);
    if (key === null) continue;
    const list = byPrefix.get(key) ?? [];
    list.push(s);
    byPrefix.set(key, list);
  }
  const gaps: number[] = [];
  for (const list of byPrefix.values()) {
    list.sort((a, b) => (a.ts as number) - (b.ts as number));
    let armed: number | null = null;
    for (const s of list) {
      const ts = s.ts as number;
      if (armed !== null && pos(s.cacheReadTokens) > 0 && ts > armed) {
        gaps.push(ts - armed);
        armed = null;
      }
      if (pos(s.cacheWriteTokens) > 0) armed = ts;
    }
  }
  return gaps;
}

/**
 * The TTL for a set of records, by honesty precedence:
 * reported (the earliest vendor expiry any record carried) > measured (the
 * longest observed write-to-read gap) > est (cache tokens exist) > null.
 */
export function deriveCacheTtl(samples: readonly CacheSample[]): CacheTtl | null {
  let reported: number | undefined;
  let anyCache = false;
  for (const s of samples) {
    if (pos(s.cacheReadTokens) > 0 || pos(s.cacheWriteTokens) > 0) anyCache = true;
    const r = recordReportedTtlMs(s);
    if (r !== undefined) reported = reported === undefined ? r : Math.min(reported, r);
  }
  if (reported !== undefined) return reportedTtl(reported);
  const gaps = observedCacheGaps(samples);
  if (gaps.length > 0) return measuredTtl(Math.max(...gaps), gaps.length);
  return anyCache ? estTtl() : null;
}

/** Token sums plus the TTL for a set of records. */
export function cachePanel(samples: readonly CacheSample[]): CachePanel {
  let cacheRead = 0;
  let cacheCreation = 0;
  let input = 0;
  for (const s of samples) {
    cacheRead += pos(s.cacheReadTokens);
    cacheCreation += pos(s.cacheWriteTokens);
    input += pos(s.inputTokens);
  }
  return { cacheRead, cacheCreation, input, ttl: deriveCacheTtl(samples) };
}

export interface SessionCachePanel extends CachePanel {
  agent: string;
  sessionId: string;
}

/** One panel per (agent, session), sessions with cache tokens only, sorted by agent then session. */
export function cachePanelsBySession(samples: readonly CacheSample[]): SessionCachePanel[] {
  const groups = new Map<string, { agent: string; sessionId: string; rows: CacheSample[] }>();
  for (const s of samples) {
    const sid = typeof s.sessionId === "string" && s.sessionId !== "" ? s.sessionId : "unknown";
    const agent = s.agent ?? "unknown";
    const key = `${agent}\0${sid}`;
    const g = groups.get(key) ?? { agent, sessionId: sid, rows: [] };
    g.rows.push(s);
    groups.set(key, g);
  }
  return [...groups.values()]
    .map((g) => ({ agent: g.agent, sessionId: g.sessionId, ...cachePanel(g.rows) }))
    .filter((p) => p.cacheRead > 0 || p.cacheCreation > 0)
    .sort((a, b) => a.agent.localeCompare(b.agent) || a.sessionId.localeCompare(b.sessionId));
}

/** "5m", "3m", "4.5m", "90s", "1h": compact duration for a TTL value. */
export function fmtTtlDuration(ms: number): string {
  const trim = (n: number) => (Math.round(n * 10) / 10).toString();
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${trim(ms / 60_000)}m`;
  return `${trim(ms / 3_600_000)}h`;
}

/** "5m est", "3m measured", "1h reported", or "n/a". The tier is never dropped. */
export function fmtCacheTtl(ttl: CacheTtl | null | undefined): string {
  if (ttl === null || ttl === undefined) return "n/a";
  return `${fmtTtlDuration(ttl.value)} ${ttl.tier}`;
}
