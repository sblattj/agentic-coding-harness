// resolveSourceOptions unit tests: flag > env resolution, defaults, and
// every USAGE rejection for `ach web --source*` (spec §5.1/§9). The full
// end-to-end against a live stub feed is covered by a later seat (S8).
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { resolveSourceOptions, type SourceFlagValues } from "../src/cli/web.ts";
import { HarnessError } from "../src/core/types.ts";

const NO_ENV: Record<string, string | undefined> = {};

function flags(overrides: Partial<SourceFlagValues>): SourceFlagValues {
  return overrides;
}

function expectUsage(fn: () => unknown, needle: string): void {
  let err: unknown;
  try {
    fn();
  } catch (e) {
    err = e;
  }
  assert.ok(err instanceof HarnessError, `expected HarnessError, got ${String(err)}`);
  assert.equal((err as HarnessError).code, "USAGE");
  assert.ok(
    (err as HarnessError).message.includes(needle),
    `message '${(err as HarnessError).message}' lacks '${needle}'`,
  );
}

describe("resolveSourceOptions", () => {
  test("no source configured -> null", () => {
    assert.equal(resolveSourceOptions(flags({}), NO_ENV), null);
    assert.equal(resolveSourceOptions(flags({ token: "tok" }), NO_ENV), null);
    assert.equal(resolveSourceOptions(flags({}), { AGENTIC_CODING_HARNESS_HTTP_TOKEN: "tok" }), null);
  });

  test("only --source: defaults mode poll, pollMs 3000, merge only; token falls back to dashboard token", () => {
    const r = resolveSourceOptions(flags({ source: "http://feed.example.com:9400/api" }), NO_ENV);
    assert.ok(r !== null);
    assert.equal(r.mode, "poll");
    assert.equal(r.pollMs, 3000);
    assert.equal(r.merge, "only");
    assert.equal(r.token, undefined);
    assert.equal(r.host, "feed.example.com:9400");
    assert.equal(r.url, "http://feed.example.com:9400/api");
  });

  test("token fallback: --source-token > --token", () => {
    const withBoth = resolveSourceOptions(
      flags({ source: "https://feed.example.com", "source-token": "st", token: "dt" }),
      NO_ENV,
    );
    assert.ok(withBoth !== null);
    assert.equal(withBoth.token, "st");
    const withDash = resolveSourceOptions(flags({ source: "https://feed.example.com", token: "dt" }), NO_ENV);
    assert.ok(withDash !== null);
    assert.equal(withDash.token, "dt");
  });

  test("env fallback honored per key", () => {
    const r = resolveSourceOptions(flags({}), {
      AGENTIC_CODING_HARNESS_SOURCE: "https://feed.example.com",
      AGENTIC_CODING_HARNESS_SOURCE_TOKEN: "st",
      AGENTIC_CODING_HARNESS_SOURCE_MODE: "sse",
      AGENTIC_CODING_HARNESS_SOURCE_POLL_MS: "5000",
      AGENTIC_CODING_HARNESS_SOURCE_MERGE: "state",
    });
    assert.ok(r !== null);
    assert.equal(r.url, "https://feed.example.com/");
    assert.equal(r.token, "st");
    assert.equal(r.mode, "sse");
    assert.equal(r.pollMs, 5000);
    assert.equal(r.merge, "state");
  });

  test("flag wins over env for every key", () => {
    const r = resolveSourceOptions(
      flags({
        source: "http://flag.example.com",
        "source-token": "flagtok",
        "source-mode": "ws",
        "source-poll-ms": "999",
        "source-merge": "only",
      }),
      {
        AGENTIC_CODING_HARNESS_SOURCE: "http://env.example.com",
        AGENTIC_CODING_HARNESS_SOURCE_TOKEN: "envtok",
        AGENTIC_CODING_HARNESS_SOURCE_MODE: "poll",
        AGENTIC_CODING_HARNESS_SOURCE_POLL_MS: "8888",
        AGENTIC_CODING_HARNESS_SOURCE_MERGE: "state",
      },
    );
    assert.ok(r !== null);
    assert.equal(r.host, "flag.example.com");
    assert.equal(r.token, "flagtok");
    assert.equal(r.mode, "ws");
    assert.equal(r.pollMs, 999);
    assert.equal(r.merge, "only");
  });

  test("merge default only, explicit state", () => {
    const def = resolveSourceOptions(flags({ source: "http://f.example.com" }), NO_ENV);
    assert.ok(def !== null);
    assert.equal(def.merge, "only");
    const st = resolveSourceOptions(flags({ source: "http://f.example.com", "source-merge": "state" }), NO_ENV);
    assert.ok(st !== null);
    assert.equal(st.merge, "state");
  });

  test("--source-* without --source -> USAGE (flag and env origin)", () => {
    expectUsage(() => resolveSourceOptions(flags({ "source-token": "t" }), NO_ENV), "--source-token requires --source");
    expectUsage(() => resolveSourceOptions(flags({ "source-mode": "poll" }), NO_ENV), "--source-mode requires --source");
    expectUsage(() => resolveSourceOptions(flags({ "source-poll-ms": "1000" }), NO_ENV), "--source-poll-ms requires --source");
    expectUsage(() => resolveSourceOptions(flags({ "source-merge": "state" }), NO_ENV), "--source-merge requires --source");
    expectUsage(
      () => resolveSourceOptions(flags({}), { AGENTIC_CODING_HARNESS_SOURCE_MERGE: "state" }),
      "AGENTIC_CODING_HARNESS_SOURCE_MERGE requires --source",
    );
  });

  test("bad --source-mode rejected", () => {
    expectUsage(
      () => resolveSourceOptions(flags({ source: "http://f.example.com", "source-mode": "stream" }), NO_ENV),
      "--source-mode expects poll|sse|ws, got 'stream'",
    );
  });

  test("bad --source-merge rejected", () => {
    expectUsage(
      () => resolveSourceOptions(flags({ source: "http://f.example.com", "source-merge": "union" }), NO_ENV),
      "--source-merge expects state|only, got 'union'",
    );
  });

  test("bad --source-poll-ms rejected: non-integer, below 250", () => {
    expectUsage(
      () => resolveSourceOptions(flags({ source: "http://f.example.com", "source-poll-ms": "fast" }), NO_ENV),
      "--source-poll-ms expects an integer >= 250, got 'fast'",
    );
    expectUsage(
      () => resolveSourceOptions(flags({ source: "http://f.example.com", "source-poll-ms": "100" }), NO_ENV),
      "--source-poll-ms expects an integer >= 250, got '100'",
    );
    expectUsage(
      () =>
        resolveSourceOptions(flags({ source: "http://f.example.com" }), {
          AGENTIC_CODING_HARNESS_SOURCE_POLL_MS: "249.5",
        }),
      "AGENTIC_CODING_HARNESS_SOURCE_POLL_MS expects an integer >= 250, got '249.5'",
    );
  });

  test("bad --source URLs rejected: ftp, relative path, garbage", () => {
    expectUsage(
      () => resolveSourceOptions(flags({ source: "ftp://f.example.com/feed" }), NO_ENV),
      "--source expects an absolute http(s) URL, got 'ftp://f.example.com/feed'",
    );
    expectUsage(
      () => resolveSourceOptions(flags({ source: "feed.example.com/api" }), NO_ENV),
      "--source expects an absolute http(s) URL, got 'feed.example.com/api'",
    );
    expectUsage(
      () => resolveSourceOptions(flags({ source: "/tmp/relative" }), NO_ENV),
      "--source expects an absolute http(s) URL, got '/tmp/relative'",
    );
  });

  test("250 is the inclusive poll floor", () => {
    const r = resolveSourceOptions(flags({ source: "http://f.example.com", "source-poll-ms": "250" }), NO_ENV);
    assert.ok(r !== null);
    assert.equal(r.pollMs, 250);
  });
});
