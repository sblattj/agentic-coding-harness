// #42: `ach stats --compare prev|prev:<dur>` period-over-period comparison.
// Fixed fixtures, --until pinned: no test depends on today's date.
import "./support/no-network.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import {
  compareDelta,
  parseCompareSpec,
  resolveComparePeriods,
  unexplainedDays,
} from "../src/cli/compare-periods.ts";
import { writeRunRecord } from "../src/core/registry.ts";

const CLI = new URL("../src/cli/ach.ts", import.meta.url).pathname;
const iso = (s: string) => Date.parse(s);

function runCli(args: string[], env: Record<string, string>) {
  const isBun = (process.versions as { bun?: string }).bun !== undefined;
  const p = spawnSync(process.execPath, isBun ? [CLI, ...args] : ["--import", "tsx", CLI, ...args], {
    env: { ...process.env, AGENTIC_CODING_HARNESS_TZ: "", ...env },
    encoding: "utf8",
    timeout: 120_000,
    killSignal: "SIGKILL",
  });
  return { code: p.status ?? -1, stdout: p.stdout ?? "", stderr: p.stderr ?? "" };
}

function line(ts: string, agent: string, input: number, cost: number, sid: string): string {
  return JSON.stringify({ ts, agent, sessionId: sid, inputTokens: input, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, costUsd: cost });
}

describe("compare-periods: window arithmetic", () => {
  it("prev: Sep 1-7 compares against Aug 25-31 (calendar-exact, UTC)", () => {
    const w = { sinceMs: iso("2026-09-01T00:00:00Z"), untilMs: iso("2026-09-08T00:00:00Z") };
    const { previous } = resolveComparePeriods({ kind: "prev" }, w, iso("2026-12-01T00:00:00Z"), "UTC");
    assert.equal(new Date(previous.sinceMs).toISOString(), "2026-08-25T00:00:00.000Z");
    assert.equal(new Date(previous.untilMs).toISOString(), "2026-09-01T00:00:00.000Z");
  });

  it("prev across a month boundary is not a 30-day shift (Mar 1-7 -> Feb 22-28)", () => {
    const w = { sinceMs: iso("2026-03-01T00:00:00Z"), untilMs: iso("2026-03-08T00:00:00Z") };
    const { previous } = resolveComparePeriods({ kind: "prev" }, w, 0, "UTC");
    assert.equal(new Date(previous.sinceMs).toISOString(), "2026-02-22T00:00:00.000Z");
  });

  it("prev:7d shifts both ends by 7 calendar days in the selected zone", () => {
    const w = { sinceMs: iso("2026-09-01T07:00:00Z"), untilMs: iso("2026-09-08T07:00:00Z") }; // Sep 1-7 in Los_Angeles
    const { previous } = resolveComparePeriods(parseCompareSpec("prev:7d"), w, 0, "America/Los_Angeles");
    assert.equal(new Date(previous.sinceMs).toISOString(), "2026-08-25T07:00:00.000Z");
    assert.equal(new Date(previous.untilMs).toISOString(), "2026-09-01T07:00:00.000Z");
  });

  it("prev across a DST end keeps local midnights (Los_Angeles, Nov 2-8 -> Oct 26-Nov 1)", () => {
    const w = { sinceMs: iso("2026-11-02T08:00:00Z"), untilMs: iso("2026-11-09T08:00:00Z") }; // PST
    const { previous } = resolveComparePeriods({ kind: "prev" }, w, 0, "America/Los_Angeles");
    assert.equal(new Date(previous.sinceMs).toISOString(), "2026-10-26T07:00:00.000Z"); // PDT midnight
    assert.equal(new Date(previous.untilMs).toISOString(), "2026-11-02T08:00:00.000Z");
  });

  it("an open end means now; a rolling window steps back by its own length", () => {
    const now = iso("2026-09-27T12:00:00Z");
    const w = { sinceMs: now - 7 * 86_400_000 };
    const { current, previous } = resolveComparePeriods({ kind: "prev" }, w, now, "UTC");
    assert.equal(current.untilMs, now);
    assert.equal(previous.untilMs, w.sinceMs);
    assert.equal(previous.sinceMs, now - 14 * 86_400_000);
  });

  it("rejects unknown values and unbounded windows with USAGE", () => {
    for (const bad of ["", "previous", "prev:", "prev:abc", "prev:0d", "prev:-7d", "next"]) {
      assert.throws(() => parseCompareSpec(bad), (e: { code?: string }) => e.code === "USAGE", bad);
    }
    assert.throws(() => resolveComparePeriods({ kind: "prev" }, { untilMs: 1 }, 5, "UTC"), /bounded window/);
  });

  it("delta percentages are null on a zero or unknown base, never -100% or Infinity", () => {
    const zero = { tokens: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, costUsd: 0, runs: 0, records: 0 };
    const some = { ...zero, tokens: 100, costUsd: 2, runs: 4 };
    assert.deepEqual(compareDelta(some, zero), { tokens: 100, costUsd: 2, runs: 4, tokensPct: null, costUsdPct: null, runsPct: null });
    const gone = compareDelta(zero, some);
    assert.equal(gone.tokensPct, -100); // a real base that fell to zero is a real -100%
    assert.equal(compareDelta({ ...some, costUsd: null }, some).costUsd, null);
  });
});

describe("compare-periods: unexplained days", () => {
  it("names runs whose transcript is gone, per day, and skips present or recovered ones", () => {
    const w = { sinceMs: iso("2026-08-25T00:00:00Z"), untilMs: iso("2026-09-01T00:00:00Z") };
    const totals = { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.5 };
    const runs = [
      { runId: "gone", startedAt: iso("2026-08-27T10:00:00Z"), rawTranscript: "/x/gone.jsonl", totals },
      { runId: "present", startedAt: iso("2026-08-27T11:00:00Z"), rawTranscript: "/x/present.jsonl", totals },
      { runId: "recovered", startedAt: iso("2026-08-28T11:00:00Z"), rawTranscript: "/x/gone2.jsonl", totals },
      { runId: "external", startedAt: iso("2026-08-28T12:00:00Z"), totals },
      { runId: "outside", startedAt: iso("2026-09-02T12:00:00Z"), rawTranscript: "/x/gone3.jsonl", totals },
    ];
    const u = unexplainedDays(runs, w, "UTC", new Set(["recovered"]), (p) => p.endsWith("present.jsonl"));
    assert.deepEqual(u.days, [{ day: "2026-08-27", runs: 1, tokens: 15, costUsd: 0.5 }]);
    assert.equal(u.runs, 1);
  });
});

describe("ach stats --compare (#42)", () => {
  let tmp: string;
  let stateDir: string;
  let home: string;
  const env = () => ({ AGENTIC_CODING_HARNESS_STATE_DIR: stateDir, HOME: home });
  const base = ["stats", "--state-only", "--tz", "UTC", "--since", "2026-09-01", "--until", "2026-09-08"];

  before(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ach-compare-")));
    stateDir = path.join(tmp, "state");
    home = path.join(tmp, "home");
    fs.mkdirSync(path.join(stateDir, "raw", "claude"), { recursive: true });
    fs.mkdirSync(home, { recursive: true });
    const lines = [
      // current window Sep 1-7
      line("2026-09-01T00:00:00.000Z", "claude", 1000, 1.0, "c1"),
      line("2026-09-04T12:00:00.000Z", "claude", 2000, 2.0, "c2"),
      line("2026-09-07T23:59:59.000Z", "claude", 1000, 1.0, "c3"),
      line("2026-09-05T12:00:00.000Z", "codex", 500, 0.5, "x1"),
      // previous window Aug 25-31
      line("2026-08-25T00:00:00.000Z", "claude", 1000, 1.0, "p1"),
      line("2026-08-31T23:59:59.000Z", "claude", 1000, 1.0, "p2"),
      // outside both: before Aug 25, and Sep 8 00:00 (exclusive end)
      line("2026-08-24T23:59:59.000Z", "claude", 9999, 9.0, "o1"),
      line("2026-09-08T00:00:00.000Z", "claude", 9999, 9.0, "o2"),
    ];
    fs.writeFileSync(path.join(stateDir, "raw", "claude", "fixture.jsonl"), lines.join("\n") + "\n");
    // 3 runs in the current window, 1 in the previous (raw transcript pruned), 0 outside
    const run = (runId: string, agent: string, at: string, extra: object = {}) =>
      writeRunRecord(stateDir, { runId, agent, startedAt: iso(at), status: "success", ...extra });
    run("r-c1", "claude", "2026-09-01T09:00:00Z");
    run("r-c2", "claude", "2026-09-04T09:00:00Z");
    run("r-x1", "codex", "2026-09-05T09:00:00Z");
    run("r-p1", "claude", "2026-08-27T09:00:00Z", {
      rawTranscript: path.join(stateDir, "raw", "claude-gone.jsonl"),
      totals: { inputTokens: 700, outputTokens: 300, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.75 },
    });
  });
  after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it("text: both windows plus delta columns for tokens, cost and runs", () => {
    const r = runCli([...base, "--compare", "prev"], env());
    assert.equal(r.code, 0, r.stderr);
    const out = r.stdout.split("\n");
    const head = out.find((l) => l.startsWith("compare"))!;
    assert.match(head, /prev\s+current 2026-09-01\.\.2026-09-07 vs previous 2026-08-25\.\.2026-08-31/);
    const block = out.slice(out.indexOf(head));
    const row = (name: string) => block.find((l) => l.trim().startsWith(name + " "))!;
    // current tokens 4500, previous 2000: +2,500, +125.0%
    assert.match(row("tokens"), /4,500\s+2,000\s+\+2,500\s+\+125\.0%/);
    // current cost 4.5, previous 2.0
    assert.match(row("cost"), /\$4\.5000\s+\$2\.0000\s+\+\$2\.5000\s+\+125\.0%/);
    // runs 3 vs 1
    assert.match(row("runs"), /3\s+1\s+\+2\s+\+200\.0%/);
    for (const l of out) assert.ok(l.length <= 140 || !/^(compare|  )/.test(l) || /unexplained/.test(l), `compare line too wide: ${l}`);
    for (const l of out.filter((x) => /^  (tokens|cost|runs|\s+current)/.test(x))) assert.ok(l.length <= 100, l);
    // the existing table is still the current window only
    assert.match(out.find((l) => l.startsWith("totals"))!, /records=4 input=4,500/);
  });

  it("--json: compare object with per-window totals and signed deltas", () => {
    const r = runCli([...base, "--json", "--compare", "prev"], env());
    assert.equal(r.code, 0, r.stderr);
    const j = JSON.parse(r.stdout);
    assert.equal(j.compare.mode, "prev");
    assert.equal(j.compare.current.since, "2026-09-01T00:00:00.000Z");
    assert.equal(j.compare.current.until, "2026-09-08T00:00:00.000Z");
    assert.equal(j.compare.previous.since, "2026-08-25T00:00:00.000Z");
    assert.equal(j.compare.previous.until, "2026-09-01T00:00:00.000Z");
    assert.equal(j.compare.current.totals.tokens, 4500);
    assert.equal(j.compare.previous.totals.tokens, 2000);
    assert.equal(j.compare.current.totals.costUsd, 4.5);
    assert.equal(j.compare.current.totals.runs, 3);
    assert.equal(j.compare.previous.totals.runs, 1);
    assert.deepEqual(j.compare.delta, { tokens: 2500, costUsd: 2.5, runs: 2, tokensPct: 125, costUsdPct: 125, runsPct: 200 });
    assert.equal(j.total.records, 4, "the plain total is still the current window only");
  });

  it("--json without --compare keeps today's key set (no compare key)", () => {
    const r = runCli([...base, "--json"], env());
    assert.equal(r.code, 0, r.stderr);
    const j = JSON.parse(r.stdout);
    assert.deepEqual(Object.keys(j), [
      "total", "byAgent", "byDay", "timezone", "window", "pricing", "byModel", "unpricedModels", "cacheHitRatio", "cache", "codexAccounting", "runs", "runOutcomes", "pace",
    ]);
    assert.ok(!("compare" in j));
    // and --compare adds exactly one key, in front of pricing
    const c = JSON.parse(runCli([...base, "--json", "--compare", "prev"], env()).stdout);
    assert.deepEqual(Object.keys(c).filter((k) => k !== "compare"), Object.keys(j));
  });

  it("month boundary: Sep 1-7 compares to Aug 25-31, also with --tz and prev:7d", () => {
    const j = JSON.parse(runCli([...base, "--json", "--compare", "prev:7d"], env()).stdout);
    assert.equal(j.compare.mode, "prev:7d");
    assert.equal(j.compare.previous.since, "2026-08-25T00:00:00.000Z");
    assert.equal(j.compare.previous.until, "2026-09-01T00:00:00.000Z");
    const la = JSON.parse(runCli(["stats", "--state-only", "--tz", "America/Los_Angeles", "--since", "2026-09-01", "--until", "2026-09-08", "--json", "--compare", "prev"], env()).stdout);
    assert.equal(la.compare.previous.since, "2026-08-25T07:00:00.000Z");
    assert.equal(la.compare.previous.until, "2026-09-01T07:00:00.000Z");
    // prev:2w moves the comparison window two weeks back
    const w2 = JSON.parse(runCli([...base, "--json", "--compare", "prev:2w"], env()).stdout);
    assert.equal(w2.compare.previous.since, "2026-08-18T00:00:00.000Z");
    assert.equal(w2.compare.previous.totals.tokens, 9999); // only the Aug 24 record sits in Aug 18-24
  });

  it("empty previous window: n/a in text, null in JSON, never -100% or Infinity", () => {
    const args = ["stats", "--state-only", "--tz", "UTC", "--since", "2026-08-18", "--until", "2026-08-25"];
    // current = Aug 18-24 holds one record (9,999 tokens); previous = Aug 11-17 is empty
    const text = runCli([...args, "--compare", "prev"], env());
    assert.equal(text.code, 0, text.stderr);
    assert.match(text.stdout, /tokens\s+9,999\s+0\s+\+9,999\s+n\/a/);
    assert.match(text.stdout, /cost\s+\$9\.0000\s+\$0\.0000\s+\+\$9\.0000\s+n\/a/);
    assert.doesNotMatch(text.stdout, /-100|Infinity|NaN/);
    // both windows empty: n/a again, not 0% or NaN
    const none = runCli(["stats", "--state-only", "--tz", "UTC", "--since", "2026-07-01", "--until", "2026-07-08", "--compare", "prev"], env());
    assert.match(none.stdout, /tokens\s+0\s+0\s+0\s+n\/a/);
    assert.doesNotMatch(none.stdout, /-100|Infinity|NaN/);
    const j = JSON.parse(runCli([...args, "--json", "--compare", "prev"], env()).stdout);
    assert.equal(j.compare.delta.tokensPct, null);
    assert.equal(j.compare.delta.costUsdPct, null);
    assert.equal(j.compare.delta.runsPct, null);
    // a non-empty current against an empty previous
    const j2 = JSON.parse(runCli([...base, "--json", "--compare", "prev:4w"], env()).stdout);
    assert.equal(j2.compare.previous.totals.tokens, 0);
    assert.equal(j2.compare.delta.tokens, 4500);
    assert.equal(j2.compare.delta.tokensPct, null);
    const t2 = runCli([...base, "--compare", "prev:4w"], env());
    assert.match(t2.stdout, /tokens\s+4,500\s+0\s+\+4,500\s+n\/a/);
  });

  it("composes with --agent", () => {
    const j = JSON.parse(runCli([...base, "--agent", "codex", "--json", "--compare", "prev"], env()).stdout);
    assert.equal(j.compare.current.totals.tokens, 500);
    assert.equal(j.compare.current.totals.runs, 1);
    assert.equal(j.compare.previous.totals.tokens, 0);
    assert.equal(j.compare.previous.totals.runs, 0);
    const c = JSON.parse(runCli([...base, "--agent", "claude", "--json", "--compare", "prev"], env()).stdout);
    assert.equal(c.compare.current.totals.tokens, 4000);
    assert.equal(c.compare.previous.totals.runs, 1);
  });

  it("composes with --by week,month (selected-window maps unchanged)", () => {
    const plain = JSON.parse(runCli([...base, "--by", "week", "--json"], env()).stdout);
    const cmp = JSON.parse(runCli([...base, "--by", "week", "--json", "--compare", "prev"], env()).stdout);
    assert.deepEqual(cmp.byWeek, plain.byWeek);
    assert.deepEqual(cmp.byAgent, plain.byAgent);
    assert.deepEqual(cmp.total, plain.total);
  });

  it("unexplained: a previous-window day whose run transcript was pruned is named, not folded in", () => {
    const j = JSON.parse(runCli([...base, "--json", "--compare", "prev"], env()).stdout);
    assert.deepEqual(j.compare.previous.unexplained.days, [{ day: "2026-08-27", runs: 1, tokens: 1000, costUsd: 0.75 }]);
    assert.equal(j.compare.current.unexplained.runs, 0);
    assert.equal(j.compare.previous.totals.tokens, 2000, "unexplained amounts are not added to totals");
    const t = runCli([...base, "--compare", "prev"], env());
    assert.match(t.stdout, /unexplained \(previous\) 2026-08-27: 1 run\(s\), 1,000 tokens, \$0\.7500/);
  });

  it("USAGE errors: bad value and unbounded window exit non-zero with a clear message", () => {
    const bad = runCli([...base, "--compare", "sideways"], env());
    assert.notEqual(bad.code, 0);
    assert.match(bad.stderr, /--compare: unknown value 'sideways'/);
    const badDur = runCli([...base, "--compare", "prev:soon"], env());
    assert.notEqual(badDur.code, 0);
    assert.match(badDur.stderr, /cannot parse offset 'soon'/);
    const open = runCli(["stats", "--state-only", "--compare", "prev"], env());
    assert.notEqual(open.code, 0);
    assert.match(open.stderr, /--compare needs a bounded window/);
  });
});
