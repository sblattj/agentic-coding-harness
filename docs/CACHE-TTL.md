# Prompt-cache TTL (honesty tiers)

A prompt-cache hit re-reads the prompt at a fraction of the input price; a miss
pays full price again as a cache write (Anthropic `cache_creation`). How long a
cached prompt stays warm is its time-to-live (TTL). A run that is mostly cache
*creation* often means the TTL expired between turns.

ach shows a **cache panel** next to the token counts: cache reads, cache
creation, plain (uncached) input, and a **TTL that always carries a tier**.

| tier | meaning | source |
|---|---|---|
| `reported` | the vendor said so | an adapter event carried `extra.cacheTtlMs` (ms) or `extra.cacheExpiresAt` (epoch ms or ISO time), or Anthropic's `usage.cache_creation` split (`cacheWrite1hTokens`, see [TOKEN-COUNTING.md](TOKEN-COUNTING.md)) said which TTL class the write used: an all-1h write reports `1h`, any 5-minute slice reports `5m` |
| `measured` | ach observed it | the longest gap between a cache write and the next cache read on the same prompt prefix; the read landing proves the entry was still warm, so this is a lower bound on the TTL |
| `est` | our estimate | `DEFAULT_CACHE_TTL_MS` = 5 minutes, used when cache tokens exist and nothing better is known |
| `n/a` | nothing known | no cache tokens at all (`ttl: null`) |

Precedence when several apply: `reported` (the earliest vendor expiry any
record carried, since the earliest expiry is the one that forces a re-write)
over `measured` over `est`.

## The estimate

`DEFAULT_CACHE_TTL_MS` in `src/core/cache-ttl.ts` is the one place the
constant lives. 5 minutes is Anthropic's default ephemeral cache lifetime (the
1-hour class is opt-in and is reported per write), and OpenAI documents its
automatic prompt cache as typically evicted after 5 to 10 minutes of
inactivity. The estimate takes the shortest, so it errs toward "expired" rather
than promising a warm cache.

## Measured gaps and prompt prefixes

A gap only counts when the write and the read share a prompt prefix:

- an adapter that knows the prefix sets `extra.cachePrefix` (an opaque id, such
  as a hash of the cached prompt prefix); only an equal id matches;
- otherwise the prefix is the conversation: the same agent, the same known
  session id and the same model (provider caches are per model, and each agent
  turn re-sends the session's earlier turns). In the web run view a usage event
  without a session id belongs to the run's own conversation.

A record with neither an id nor a known session is never paired, and records
on different prefixes never produce a measurement. A miss (another write with
no read in between) re-arms the prefix at the newer write. Records with the
same timestamp or no timestamp never measure.

## Where it shows

- `ach stats --json`: a top-level `cache` object,
  `{ cacheRead, cacheCreation, input, ttl, bySession: [{ agent, sessionId, cacheRead, cacheCreation, input, ttl }] }`
  where `ttl` is `{ tier, value }` (`value` in milliseconds; a `measured` TTL
  also carries `samples`, the number of gaps it rests on) or `null`.
  `bySession` lists sessions with cache tokens only.
- `ach stats` (text): a `cache` line, e.g.
  `cache     read=4,000 creation=4,300 input=30 ttl=3m measured sessions=1`.
  Printed only when the window has cache tokens.
- `ach web`: the run view's metadata strip shows `cache ttl` (for example
  `5m est`), from `GET /api/runs/:id/observability` (`cache`, same panel shape).
  Hover for what the tier means.

## Type-level honesty

`CacheTtl` is a tagged union, `{ tier: "est" | "reported" | "measured", value }`.
A bare number, an object without a tier, or an unknown tier does not compile
(`tests/cache-ttl-types.test.ts` pins this with `@ts-expect-error`, checked by
`npm run typecheck`). Rendering goes through `fmtCacheTtl`, which always prints
the tier; the web helper prints `n/a` for anything without a known tier.

This is display and data model only: cost math is unchanged.
