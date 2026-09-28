// Time windows (#26), timezone-aware day boundaries (#84) and week/month
// rollups (#44) for `ach stats` / `ach watch`.
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { after, before, describe, it } from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { aggregate, type AggregatableRecord } from "../src/cli/lib.ts";
import {
  dayKey,
  inWindow,
  joinAgoTokens,
  monthKey,
  parseBy,
  parseTimeSpec,
  resolveTimeZone,
  resolveWindow,
  weekKey,
  zonedMidnight,
} from "../src/cli/time-window.ts";

const CLI = fileURLToPath(new URL("../src/cli/ach.ts", import.meta.url));

function runCli(args: string[], env: Record<string, string>, timeoutMs?: number) {
  const isBun = (process.versions as { bun?: string }).bun !== undefined;
  const p = spawnSync(process.execPath, isBun ? [CLI, ...args] : ["--import", "tsx", CLI, ...args], {
    env: { ...process.env, AGENTIC_CODING_HARNESS_TZ: "", ...env },
    encoding: "utf8",
    ...(timeoutMs ? { timeout: timeoutMs, killSignal: "SIGKILL" as const } : {}),
  });
  return { code: p.status ?? -1, stdout: p.stdout ?? "", stderr: p.stderr ?? "" };
}

/**
 * Start a long-running `ach watch`, wait until its first tick has finished
 * (offsets.json appears in its state dir), then kill it.
 */
async function runCliAsync(args: string[], env: Record<string, string>) {
  const isBun = (process.versions as { bun?: string }).bun !== undefined;
  const child = spawn(process.execPath, isBun ? [CLI, ...args] : ["--import", "tsx", CLI, ...args], {
    env: { ...process.env, AGENTIC_CODING_HARNESS_TZ: "", ...env },
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => (stdout += String(d)));
  child.stderr.on("data", (d) => (stderr += String(d)));
  const offsets = path.join(env.AGENTIC_CODING_HARNESS_STATE_DIR!, "offsets.json");
  let ticked = false;
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline && child.exitCode === null) {
    try {
      await fs.access(offsets);
      ticked = true;
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  const exited = new Promise((r) => child.once("close", r));
  child.kill("SIGKILL");
  await exited;
  return { stdout, stderr, ticked };
}

const NOW = Date.parse("2026-09-27T12:00:00.000Z");
const ms = (iso: string) => Date.parse(iso);

function rec(ts: string | null, input = 1, agent = "claude"): AggregatableRecord {
  return { ts, agent, inputTokens: input, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 };
}

describe("time-window: timezone resolution (#84)", () => {
  it("accepts utc, local and IANA names; flag beats env; default is local", () => {
    assert.equal(resolveTimeZone("utc", undefined), "UTC");
    assert.equal(resolveTimeZone("UTC", undefined), "UTC");
    assert.equal(resolveTimeZone("Asia/Tokyo", undefined), "Asia/Tokyo");
    assert.equal(resolveTimeZone(undefined, "Asia/Tokyo"), "Asia/Tokyo");
    assert.equal(resolveTimeZone("utc", "Asia/Tokyo"), "UTC");
    const local = Intl.DateTimeFormat().resolvedOptions().timeZone;
    assert.equal(resolveTimeZone(undefined, undefined), local);
    assert.equal(resolveTimeZone(undefined, ""), local);
    assert.equal(resolveTimeZone("local", "Asia/Tokyo"), local);
  });

  it("rejects a bogus zone with the expected IANA format in the message", () => {
    assert.throws(() => resolveTimeZone("Bogus/Zone", undefined), /Bogus\/Zone.*IANA.*America\/Los_Angeles/s);
    assert.throws(() => resolveTimeZone(undefined, "Nope/Nope"), /AGENTIC_CODING_HARNESS_TZ/);
  });
});

describe("time-window: bucket keys", () => {
  it("dayKey computes the calendar day in the chosen zone", () => {
    assert.equal(dayKey(ms("2026-09-01T16:00:00Z"), "UTC"), "2026-09-01");
    assert.equal(dayKey(ms("2026-09-01T16:00:00Z"), "Asia/Tokyo"), "2026-09-02");
    assert.equal(dayKey(ms("2026-09-01T03:00:00Z"), "America/Los_Angeles"), "2026-08-31");
  });

  it("weekKey is the Monday-aligned ISO week, including year boundaries", () => {
    assert.equal(weekKey(ms("2026-09-20T12:00:00Z"), "UTC"), "2026-W38"); // Sunday
    assert.equal(weekKey(ms("2026-09-21T00:00:00Z"), "UTC"), "2026-W39"); // Monday
    assert.equal(weekKey(ms("2026-09-27T23:59:59Z"), "UTC"), "2026-W39"); // Sunday
    assert.equal(weekKey(ms("2027-01-01T12:00:00Z"), "UTC"), "2026-W53"); // 2026 has 53 ISO weeks
    assert.equal(weekKey(ms("2025-12-29T12:00:00Z"), "UTC"), "2026-W01");
    // Sunday 20:00 in LA is already Monday in UTC.
    assert.equal(weekKey(ms("2026-09-21T03:00:00Z"), "America/Los_Angeles"), "2026-W38");
  });

  it("monthKey honors the zone at the Aug 31 / Sep 1 boundary", () => {
    const t = ms("2026-09-01T06:30:00Z"); // Aug 31 23:30 in Los Angeles
    assert.equal(monthKey(t, "UTC"), "2026-09");
    assert.equal(monthKey(t, "America/Los_Angeles"), "2026-08");
  });

  it("zonedMidnight handles DST transitions", () => {
    assert.equal(new Date(zonedMidnight(2026, 3, 8, "America/Los_Angeles")).toISOString(), "2026-03-08T08:00:00.000Z");
    assert.equal(new Date(zonedMidnight(2026, 3, 9, "America/Los_Angeles")).toISOString(), "2026-03-09T07:00:00.000Z");
    assert.equal(new Date(zonedMidnight(2026, 9, 1, "Asia/Tokyo")).toISOString(), "2026-08-31T15:00:00.000Z");
    assert.equal(new Date(zonedMidnight(2026, 9, 1, "UTC")).toISOString(), "2026-09-01T00:00:00.000Z");
  });
});

describe("time-window: date specs and windows (#26)", () => {
  const ctx = { now: NOW, timeZone: "UTC" };

  it("parses explicit dates, RFC timestamps and relative forms", () => {
    assert.equal(parseTimeSpec("2026-09-01", ctx), ms("2026-09-01T00:00:00Z"));
    assert.equal(parseTimeSpec("2026-09-01", { now: NOW, timeZone: "Asia/Tokyo" }), ms("2026-08-31T15:00:00Z"));
    assert.equal(parseTimeSpec("2026-09-01T10:20:30Z", ctx), ms("2026-09-01T10:20:30Z"));
    assert.equal(parseTimeSpec("2026-09-01T10:20:30+02:00", ctx), ms("2026-09-01T08:20:30Z"));
    assert.equal(parseTimeSpec("7d ago", ctx), NOW - 7 * 86_400_000);
    assert.equal(parseTimeSpec("12h ago", ctx), NOW - 12 * 3_600_000);
    assert.equal(parseTimeSpec("2w ago", ctx), NOW - 14 * 86_400_000);
    assert.equal(parseTimeSpec("30m ago", ctx), NOW - 30 * 60_000);
    assert.equal(parseTimeSpec("today", ctx), ms("2026-09-27T00:00:00Z"));
    assert.equal(parseTimeSpec("yesterday", ctx), ms("2026-09-26T00:00:00Z"));
    assert.equal(parseTimeSpec("now", ctx), NOW);
  });

  it("rejects a malformed date and lists the accepted formats", () => {
    assert.throws(() => parseTimeSpec("not-a-date", ctx, "--since"), (e: Error) => {
      assert.match(e.message, /--since/);
      assert.match(e.message, /not-a-date/);
      assert.match(e.message, /YYYY-MM-DD/);
      assert.match(e.message, /7d ago/);
      assert.match(e.message, /yesterday/);
      return true;
    });
    assert.throws(() => parseTimeSpec("2026-13-45", ctx), /accepted/);
  });

  it("--since is inclusive and --until exclusive (Sep 1–10 fixture → exactly Sep 1–7)", () => {
    const w = resolveWindow({ since: "2026-09-01", until: "2026-09-08", ...ctx });
    const fixture: string[] = [];
    for (let d = 1; d <= 10; d++) {
      const day = String(d).padStart(2, "0");
      fixture.push(`2026-09-${day}T00:00:00.000Z`, `2026-09-${day}T12:00:00.000Z`, `2026-09-${day}T23:59:59.999Z`);
    }
    fixture.push("2026-08-31T23:59:59.999Z");
    const kept = fixture.filter((t) => inWindow(ms(t), w));
    assert.equal(kept.length, 7 * 3);
    assert.ok(kept.includes("2026-09-01T00:00:00.000Z"), "day-1 first millisecond included");
    assert.ok(!kept.some((t) => t.startsWith("2026-09-08")), "day-8 excluded");
    assert.ok(!kept.includes("2026-08-31T23:59:59.999Z"));
    assert.deepEqual([...new Set(kept.map((t) => t.slice(0, 10)))], [1, 2, 3, 4, 5, 6, 7].map((d) => `2026-09-0${d}`));
  });

  it("--last 7d equals --since '7d ago' under an injected clock", () => {
    assert.deepEqual(resolveWindow({ last: "7d", ...ctx }), resolveWindow({ since: "7d ago", ...ctx }));
    assert.deepEqual(resolveWindow({ last: "7d", ...ctx }), { sinceMs: NOW - 7 * 86_400_000 });
  });

  it("--days keeps working and maps to a since bound", () => {
    assert.deepEqual(resolveWindow({ days: 5, ...ctx }), { sinceMs: NOW - 5 * 86_400_000 });
    assert.deepEqual(resolveWindow({ ...ctx }), {});
  });

  it("flag conflicts are loud and name both flags", () => {
    assert.throws(() => resolveWindow({ days: 5, since: "2026-09-01", ...ctx }), /--days.*--since/);
    assert.throws(() => resolveWindow({ days: 5, until: "2026-09-01", ...ctx }), /--days.*--until/);
    assert.throws(() => resolveWindow({ days: 5, last: "7d", ...ctx }), /--days.*--last/);
    assert.throws(() => resolveWindow({ last: "7d", since: "2026-09-01", ...ctx }), /--last.*--since/);
    assert.throws(() => resolveWindow({ last: "7x", ...ctx }), /--last/);
    assert.throws(() => resolveWindow({ since: "2026-09-08", until: "2026-09-01", ...ctx }), /empty/);
  });

  it("--until without --since means everything up to the bound", () => {
    assert.deepEqual(resolveWindow({ until: "2026-09-08", ...ctx }), { untilMs: ms("2026-09-08T00:00:00Z") });
    assert.equal(inWindow(ms("2020-01-01T00:00:00Z"), { untilMs: ms("2026-09-08T00:00:00Z") }), true);
  });

  it("an unparseable timestamp is outside any bounded window but inside the unbounded one", () => {
    assert.equal(inWindow(NaN, { sinceMs: 0 }), false);
    assert.equal(inWindow(NaN, {}), true);
  });

  it("joinAgoTokens folds an unquoted 'ago' into the preceding --since/--until value", () => {
    assert.deepEqual(joinAgoTokens(["--since", "7d", "ago", "--json"]), ["--since", "7d ago", "--json"]);
    assert.deepEqual(joinAgoTokens(["--until=2d", "ago"]), ["--until=2d ago"]);
    assert.deepEqual(joinAgoTokens(["--since", "7d ago"]), ["--since", "7d ago"]);
    assert.deepEqual(joinAgoTokens(["--agent", "ago"]), ["--agent", "ago"]);
  });

  it("parseBy accepts day|week|month, comma lists and repeats; rejects others", () => {
    assert.deepEqual(parseBy(undefined), ["day"]);
    assert.deepEqual(parseBy(["week"]), ["week"]);
    assert.deepEqual(parseBy(["day,month", "week"]), ["day", "week", "month"]);
    assert.throws(() => parseBy(["fortnight"]), /--by.*day.*week.*month/s);
  });
});

describe("aggregate() with time options (#44, #84)", () => {
  const recs = [
    rec("2026-08-31T20:00:00.000Z", 1), // Aug 31 UTC, Sep 1 05:00 Tokyo
    rec("2026-09-01T10:00:00.000Z", 2),
    rec("2026-09-01T16:00:00.000Z", 4), // Sep 2 01:00 Tokyo
    rec("2026-09-21T01:00:00.000Z", 8), // Monday W39 UTC
    rec(null, 16),
  ];

  it("with no options keeps today's shape (UTC slice, no week/month maps)", () => {
    const a = aggregate(recs);
    assert.deepEqual(Object.keys(a).sort(), ["byAgent", "byDay", "totals"]);
    assert.deepEqual(Object.keys(a.byDay).sort(), ["2026-08-31", "2026-09-01", "2026-09-21", "unknown"]);
  });

  it("--tz Asia/Tokyo vs utc differ exactly around UTC-midnight-crossing records", () => {
    const utc = aggregate(recs, { timeZone: "UTC" });
    const tokyo = aggregate(recs, { timeZone: "Asia/Tokyo" });
    assert.deepEqual(
      Object.fromEntries(Object.entries(utc.byDay).map(([k, v]) => [k, v.inputTokens])),
      { "2026-08-31": 1, "2026-09-01": 2 + 4, "2026-09-21": 8, unknown: 16 },
    );
    assert.deepEqual(
      Object.fromEntries(Object.entries(tokyo.byDay).map(([k, v]) => [k, v.inputTokens])),
      { "2026-09-01": 1 + 2, "2026-09-02": 4, "2026-09-21": 8, unknown: 16 },
    );
  });

  it("byWeek/byMonth cover the same records as byDay with identical totals", () => {
    const a = aggregate(recs, { timeZone: "UTC", by: ["day", "week", "month"] });
    const sum = (m: Record<string, { records: number; inputTokens: number }>) =>
      Object.values(m).reduce((s, b) => ({ records: s.records + b.records, input: s.input + b.inputTokens }), { records: 0, input: 0 });
    assert.deepEqual(sum(a.byWeek!), sum(a.byDay));
    assert.deepEqual(sum(a.byMonth!), sum(a.byDay));
    assert.deepEqual(Object.keys(a.byWeek!).sort(), ["2026-W36", "2026-W39", "unknown"]);
    assert.deepEqual(Object.keys(a.byMonth!).sort(), ["2026-08", "2026-09", "unknown"]);
    assert.equal(a.byMonth!["2026-08"].inputTokens, 1);
  });

  it("month split at Aug 31 / Sep 1 follows the chosen zone", () => {
    const edge = [rec("2026-09-01T06:30:00.000Z", 1), rec("2026-09-01T08:30:00.000Z", 2)];
    const la = aggregate(edge, { timeZone: "America/Los_Angeles", by: ["month"] });
    assert.deepEqual(Object.fromEntries(Object.entries(la.byMonth!).map(([k, v]) => [k, v.inputTokens])), { "2026-08": 1, "2026-09": 2 });
    const utc = aggregate(edge, { timeZone: "UTC", by: ["month"] });
    assert.deepEqual(Object.keys(utc.byMonth!), ["2026-09"]);
  });
});

describe("ach stats / watch CLI time flags", () => {
  let stateDir: string;
  let home: string;

  before(async () => {
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "harness-stats-time-state-"));
    home = await fs.mkdtemp(path.join(os.tmpdir(), "harness-stats-time-home-"));
    const lines: string[] = [];
    for (let d = 1; d <= 10; d++) {
      const day = String(d).padStart(2, "0");
      for (const t of ["00:00:00.000", "12:00:00.000", "23:59:59.999"]) {
        lines.push(
          JSON.stringify({
            ts: `2026-09-${day}T${t}Z`,
            agent: "claude",
            sessionId: `s-${day}`,
            inputTokens: d,
            outputTokens: 1,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            reasoningTokens: 0,
            costUsd: 0.001,
          }),
        );
      }
    }
    // One record at 16:00Z on Aug 31 (= Sep 1 01:00 Tokyo) for the tz split.
    lines.push(
      JSON.stringify({ ts: "2026-08-31T16:00:00.000Z", agent: "codex", sessionId: "s-aug", inputTokens: 100, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 }),
    );
    await fs.mkdir(path.join(stateDir, "raw", "claude"), { recursive: true });
    await fs.writeFile(path.join(stateDir, "raw", "claude", "fixture.jsonl"), lines.join("\n") + "\n");

    // A machine transcript for the watch --since lookback test.
    const claudeDir = path.join(home, ".claude", "projects", "proj-w");
    await fs.mkdir(claudeDir, { recursive: true });
    await fs.writeFile(
      path.join(claudeDir, "sess-w.jsonl"),
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-09-05T10:00:00.000Z",
        sessionId: "sess-watch-1",
        requestId: "req-w",
        message: { id: "msg_w", model: "claude-sonnet-4-5", usage: { input_tokens: 42, output_tokens: 7 } },
      }) + "\n",
    );
  });

  after(async () => {
    await fs.rm(stateDir, { recursive: true, force: true });
    await fs.rm(home, { recursive: true, force: true });
  });

  const env = () => ({ AGENTIC_CODING_HARNESS_STATE_DIR: stateDir, HOME: home });

  it("--since/--until returns exactly Sep 1–7 and reports the window + timezone in JSON", () => {
    const r = runCli(["stats", "--json", "--state-only", "--tz", "utc", "--since", "2026-09-01", "--until", "2026-09-08"], env());
    assert.equal(r.code, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.total.records, 21);
    assert.deepEqual(Object.keys(out.byDay).sort(), [1, 2, 3, 4, 5, 6, 7].map((d) => `2026-09-0${d}`));
    assert.equal(out.timezone, "UTC");
    assert.deepEqual(out.window, { since: "2026-09-01T00:00:00.000Z", until: "2026-09-08T00:00:00.000Z" });
  });

  it("JSON and table outputs return identical filtered sets", () => {
    const flags = ["stats", "--state-only", "--tz", "utc", "--since", "2026-09-03", "--until", "2026-09-06"];
    const j = runCli([...flags, "--json"], env());
    const t = runCli(flags, env());
    assert.equal(j.code, 0, j.stderr);
    assert.equal(t.code, 0, t.stderr);
    const out = JSON.parse(j.stdout);
    const rows = Object.fromEntries(
      t.stdout
        .split("\n")
        .map((l) => l.match(/^(\S+)\s+records=(\d+) input=(\d+)/))
        .filter((m): m is RegExpMatchArray => m !== null)
        .map((m) => [m[1], { records: Number(m[2]), input: Number(m[3]) }]),
    );
    assert.deepEqual(rows.totals, { records: out.total.records, input: out.total.inputTokens });
    for (const [d, b] of Object.entries(out.byDay as Record<string, { records: number; inputTokens: number }>)) {
      assert.deepEqual(rows[d], { records: b.records, input: b.inputTokens }, d);
    }
    const tableDays = Object.keys(rows).filter((k) => /^\d{4}-\d{2}-\d{2}$/.test(k)).sort();
    assert.deepEqual(tableDays, Object.keys(out.byDay).sort());
  });

  it("'--since 7d ago' works unquoted and --last matches it", () => {
    // Both relative to the real clock; the fixture is far enough in the past
    // (or future) that either both see zero or both see the same set.
    const a = runCli(["stats", "--json", "--state-only", "--since", "7d", "ago"], env());
    const b = runCli(["stats", "--json", "--state-only", "--last", "7d"], env());
    assert.equal(a.code, 0, a.stderr);
    assert.equal(b.code, 0, b.stderr);
    assert.deepEqual(JSON.parse(a.stdout).total, JSON.parse(b.stdout).total);
  });

  it("--days with --since errors naming both flags", () => {
    const r = runCli(["stats", "--json", "--state-only", "--days", "5", "--since", "2026-09-01"], env());
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /--days/);
    assert.match(r.stderr, /--since/);
  });

  it("--until alone means everything up to the bound", () => {
    const r = runCli(["stats", "--json", "--state-only", "--tz", "utc", "--until", "2026-09-02"], env());
    assert.equal(r.code, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.total.records, 1 + 3); // Aug 31 codex + Sep 1 ×3
    assert.deepEqual(out.window, { since: null, until: "2026-09-02T00:00:00.000Z" });
  });

  it("malformed --since exits non-zero showing accepted formats", () => {
    const r = runCli(["stats", "--state-only", "--since", "not-a-date"], env());
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /not-a-date/);
    assert.match(r.stderr, /YYYY-MM-DD/);
  });

  it("--tz Asia/Tokyo moves the UTC-midnight-crossing record; env sets the default, flag wins", () => {
    const utc = JSON.parse(runCli(["stats", "--json", "--state-only", "--tz", "utc", "--until", "2026-09-02"], env()).stdout);
    const tokyo = JSON.parse(
      runCli(["stats", "--json", "--state-only", "--until", "2026-09-02T00:00:00Z"], { ...env(), AGENTIC_CODING_HARNESS_TZ: "Asia/Tokyo" }).stdout,
    );
    assert.equal(tokyo.timezone, "Asia/Tokyo");
    assert.equal(utc.byDay["2026-08-31"].inputTokens, 100);
    assert.equal(tokyo.byDay["2026-08-31"], undefined);
    assert.equal(tokyo.byDay["2026-09-01"].inputTokens, 100 + 1 + 1); // Aug 31 16:00Z + Sep 1 00:00Z/12:00Z
    assert.equal(tokyo.byDay["2026-09-02"].inputTokens, 1); // Sep 1 23:59Z
    const flagWins = JSON.parse(
      runCli(["stats", "--json", "--state-only", "--tz", "utc"], { ...env(), AGENTIC_CODING_HARNESS_TZ: "Asia/Tokyo" }).stdout,
    );
    assert.equal(flagWins.timezone, "UTC");
  });

  it("--tz Bogus/Zone exits non-zero naming the IANA format", () => {
    const r = runCli(["stats", "--state-only", "--tz", "Bogus/Zone"], env());
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /Bogus\/Zone/);
    assert.match(r.stderr, /IANA/);
  });

  it("--by week emits ISO-week rows; --json --by week has byWeek whose totals match byDay", () => {
    const base = ["stats", "--json", "--state-only", "--tz", "utc"];
    const day = JSON.parse(runCli(base, env()).stdout);
    const week = JSON.parse(runCli([...base, "--by", "week"], env()).stdout);
    assert.equal(week.byDay, undefined);
    assert.deepEqual(Object.keys(week.byWeek).sort(), ["2026-W36", "2026-W37"]);
    const sum = (m: Record<string, { records: number; inputTokens: number }>) =>
      Object.values(m).reduce((s, b) => [s[0] + b.records, s[1] + b.inputTokens], [0, 0]);
    assert.deepEqual(sum(week.byWeek), sum(day.byDay));
    const table = runCli(["stats", "--state-only", "--tz", "utc", "--by", "week"], env());
    assert.match(table.stdout, /^2026-W36 /m);
    assert.doesNotMatch(table.stdout, /^2026-09-01 /m);
  });

  it("--by month splits Aug 31 / Sep 1 in the chosen zone", () => {
    const utc = JSON.parse(runCli(["stats", "--json", "--state-only", "--tz", "utc", "--by", "month"], env()).stdout);
    assert.deepEqual(Object.keys(utc.byMonth).sort(), ["2026-08", "2026-09"]);
    assert.equal(utc.byMonth["2026-08"].records, 1);
    const tokyo = JSON.parse(runCli(["stats", "--json", "--state-only", "--tz", "Asia/Tokyo", "--by", "month"], env()).stdout);
    assert.deepEqual(Object.keys(tokyo.byMonth), ["2026-09"]);
  });

  it("default table output is identical to --by day (no week/month rows)", () => {
    const a = runCli(["stats", "--state-only", "--tz", "utc"], env());
    const b = runCli(["stats", "--state-only", "--tz", "utc", "--by", "day"], env());
    assert.equal(a.code, 0, a.stderr);
    assert.equal(a.stdout, b.stdout);
    assert.doesNotMatch(a.stdout, /W\d\d|^2026-0\d /m);
  });

  it("watch --since replays history newer than the bound on startup; without it, baselines silently", async () => {
    // watch never exits on its own: run the three variants concurrently and
    // kill each after its first tick has had time to print.
    const [w, q, late] = await Promise.all([
      runCliAsync(["watch", "--since", "2026-09-01", "--tz", "utc"], { AGENTIC_CODING_HARNESS_STATE_DIR: path.join(stateDir, "watch-a"), HOME: home }),
      runCliAsync(["watch"], { AGENTIC_CODING_HARNESS_STATE_DIR: path.join(stateDir, "watch-b"), HOME: home }),
      runCliAsync(["watch", "--since", "2026-09-06", "--tz", "utc"], { AGENTIC_CODING_HARNESS_STATE_DIR: path.join(stateDir, "watch-c"), HOME: home }),
    ]);
    assert.match(w.stdout, /claude\s+sess-watch-1\s+\+42 input/);
    // Controls: each run completed its first tick (offsets.json is written at
    // the end of a tick, after its delta lines), so "no line" is not "no tick".
    for (const r of [w, q, late]) assert.equal(r.ticked, true, r.stderr);
    assert.doesNotMatch(q.stdout, /sess-watch-1/);
    assert.doesNotMatch(late.stdout, /sess-watch-1/);
  });
});
