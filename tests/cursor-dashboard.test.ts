// Cursor dashboard usage export: parser (CSV + JSON), store dedupe, and
// `ach import --agent cursor --usage-export`. Fixtures are live captures
// from 2026-10-09 (tests/fixtures/cursor-dashboard/).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { parseCursorDashboardExport, parseCsvRecords, readCursorDashboardStore, CURSOR_CSV_HEADER } from "../src/monitors/cursor-dashboard.ts";

const CLI = new URL("../src/cli/ach.ts", import.meta.url).pathname;
const FIX = new URL("./fixtures/cursor-dashboard/", import.meta.url).pathname;
const CSV = path.join(FIX, "usage-live-2026-10-09.csv");
const JSON_F = path.join(FIX, "usage-live-2026-10-09.json");
const CONVERSATIONS = ["001054c5-592f-407c-8753-f1e5a5c91646", "3729c591-ad1f-4dbd-8ae0-c9a999920920", "2270cfa6-400b-442f-bc88-11ff110d7192"];
const TOKENS = [[12175, 247, 19328, 0], [12171, 279, 19328, 0], [12182, 289, 19328, 0]];

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ach-cursor-dash-"));
}

function runCli(args: string[]): { code: number; stdout: string; stderr: string } {
  const isBun = (process.versions as { bun?: string }).bun !== undefined;
  const p = spawnSync(process.execPath, isBun ? [CLI, ...args] : ["--import", "tsx", CLI, ...args], {
    env: { ...process.env, AGENTIC_CODING_HARNESS_TZ: "UTC" } as NodeJS.ProcessEnv,
    encoding: "utf8",
    timeout: 120_000,
  });
  return { code: p.status ?? -1, stdout: p.stdout ?? "", stderr: p.stderr ?? "" };
}

function parse(file: string): { recs: ReturnType<typeof parseCursorDashboardExport>; warnings: string[] } {
  const warnings: string[] = [];
  return { recs: parseCursorDashboardExport(fs.readFileSync(file, "utf8"), file, (m) => warnings.push(m)), warnings };
}

const tok = (r: { input: number; output: number; cacheRead: number; cacheWrite: number }) => [r.input, r.output, r.cacheRead, r.cacheWrite];

function allFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { recursive: true }).map(String);
}

describe("cursor dashboard export parser", () => {
  it("parses the live CSV into 3 records with the documented token mapping", () => {
    const { recs, warnings } = parse(CSV);
    assert.deepEqual(warnings, []);
    assert.equal(recs.length, 3);
    assert.deepEqual(recs.map(tok), TOKENS);
    for (const r of recs) {
      assert.equal(r.agent, "cursor");
      assert.equal(r.model, null);
      assert.equal(r.sessionId, null);
      assert.equal(r.costUsd, 0.02);
      assert.deepEqual(r.extra, { source: "cursor-dashboard", costBasis: "cursor-dashboard-charged" });
    }
    assert.equal(recs[0]!.timestamp, "2026-10-09T19:03:08.384Z");
  });

  it("parses the live JSON into 3 records with conversation ids and chargedCents/100", () => {
    const { recs, warnings } = parse(JSON_F);
    assert.deepEqual(warnings, []);
    assert.equal(recs.length, 3);
    assert.deepEqual(recs.map(tok), TOKENS);
    assert.deepEqual(recs.map((r) => r.sessionId), CONVERSATIONS);
    assert.ok(Math.abs(recs[0]!.costUsd! - 0.02153275) < 1e-6, `cost ${recs[0]!.costUsd}`);
    for (const r of recs) {
      assert.equal(r.model, null);
      assert.equal(r.timestamp!.length, 24);
      assert.deepEqual(r.extra, { source: "cursor-dashboard", costBasis: "cursor-dashboard-charged" });
    }
    assert.equal(recs[0]!.timestamp, "2026-10-09T19:03:08.384Z");
  });

  it("skips a CSV row whose Total Tokens is not the sum of the four counters, with one warning naming the row", () => {
    const csv = fs.readFileSync(CSV, "utf8").split("\n");
    csv[2] = csv[2]!.replace('"31778"', '"31779"');
    const warnings: string[] = [];
    const recs = parseCursorDashboardExport(csv.join("\n"), "bad.csv", (m) => warnings.push(m));
    assert.equal(recs.length, 2);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /row 2: skipped, Total Tokens 31779/);
  });

  it("skips negative and non-integer counters", () => {
    const body = [
      '"2026-10-09T10:00:00.000Z","","","free","auto","No","0","-5","0","1","-4","0.01"',
      '"2026-10-09T10:00:01.000Z","","","free","auto","No","0","1.5","0","1","2.5","0.01"',
      '"2026-10-09T10:00:02.000Z","","","free","auto","No","0","5","0","1","6",""',
    ].join("\n");
    const warnings: string[] = [];
    const recs = parseCursorDashboardExport(`${CURSOR_CSV_HEADER}\n${body}\n`, "x.csv", (m) => warnings.push(m));
    assert.equal(recs.length, 1);
    assert.equal(warnings.length, 2);
    assert.equal(recs[0]!.costUsd, undefined);
  });

  it("handles quoted commas, escaped quotes and a named model", () => {
    assert.deepEqual(parseCsvRecords('"a,b","c""d",e\n"x","y","z"\n'), [["a,b", 'c"d', "e"], ["x", "y", "z"]]);
    const row = '"2026-10-09T10:00:00.000Z","","","On-Demand","claude-4.5-sonnet, thinking","Yes","1","2","3","4","10","1.25"';
    const recs = parseCursorDashboardExport(`${CURSOR_CSV_HEADER}\n${row}\n`, "q.csv", () => assert.fail("no warning expected"));
    assert.equal(recs.length, 1);
    assert.equal(recs[0]!.model, "claude-4.5-sonnet, thinking");
    assert.deepEqual(tok(recs[0]!), [2, 4, 3, 1]);
    assert.equal(recs[0]!.costUsd, 1.25);
  });

  it("an unknown format gives one warning and no records", () => {
    const warnings: string[] = [];
    assert.deepEqual(parseCursorDashboardExport("hello,world\n1,2\n", "n.csv", (m) => warnings.push(m)), []);
    assert.deepEqual(parseCursorDashboardExport('{"nope":1}', "n.json", (m) => warnings.push(m)), []);
    assert.equal(warnings.length, 2);
  });

  it("JSON rows: absent counters are 0 only for token-based calls with at least one counter", () => {
    const ev = (extra: object) => ({ timestamp: "1791572588384", model: "gpt-5", conversationId: "c1", chargedCents: 50, ...extra });
    const doc = {
      usageEventsDisplay: [
        ev({ isTokenBasedCall: true, tokenUsage: { inputTokens: 10 } }),
        ev({ isTokenBasedCall: false, tokenUsage: { inputTokens: 10, outputTokens: 1, cacheReadTokens: 2 } }),
        ev({ isTokenBasedCall: true, tokenUsage: {} }),
        ev({ isTokenBasedCall: true }),
        ev({ isTokenBasedCall: true, tokenUsage: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4 } }),
      ],
    };
    const warnings: string[] = [];
    const recs = parseCursorDashboardExport(JSON.stringify(doc), "e.json", (m) => warnings.push(m));
    assert.equal(recs.length, 2);
    assert.deepEqual(tok(recs[0]!), [10, 0, 0, 0]);
    assert.deepEqual(tok(recs[1]!), [1, 2, 3, 4]);
    assert.equal(recs[0]!.model, "gpt-5");
    assert.equal(recs[0]!.costUsd, 0.5);
    assert.equal(warnings.length, 3);
  });
});

describe("cursor dashboard store", () => {
  it("a missing store directory yields [] and no warning", () => {
    const warnings: string[] = [];
    assert.deepEqual(readCursorDashboardStore(path.join(tmp(), "nope"), (m) => warnings.push(m)), []);
    assert.deepEqual(warnings, []);
  });

  it("the CSV and JSON of the same period come out once, as the JSON copies", () => {
    const state = tmp();
    const dir = path.join(state, "cursor-dashboard");
    fs.mkdirSync(dir);
    // 'a' sorts before 'z': the CSV is read first by name, yet the JSON must win.
    fs.copyFileSync(CSV, path.join(dir, "a.csv"));
    fs.copyFileSync(JSON_F, path.join(dir, "z.json"));
    fs.copyFileSync(CSV, path.join(dir, "b.csv"));
    const recs = readCursorDashboardStore(state, () => assert.fail("no warning expected"));
    assert.equal(recs.length, 3);
    assert.deepEqual(recs.map((r) => r.sessionId), CONVERSATIONS);
    assert.ok(recs.every((r) => r.costUsd! < 0.0219 && r.costUsd !== 0.02));
  });

  it("two stored copies of the same CSV count once", () => {
    const state = tmp();
    const dir = path.join(state, "cursor-dashboard");
    fs.mkdirSync(dir);
    fs.copyFileSync(CSV, path.join(dir, "a.csv"));
    fs.copyFileSync(CSV, path.join(dir, "b.csv"));
    assert.equal(readCursorDashboardStore(state, () => {}).length, 3);
  });
});

describe("ach import --agent cursor --usage-export", () => {
  it("stores a verbatim sha256-named copy, then reports unchanged and writes nothing else", () => {
    const state = tmp();
    const r1 = runCli(["import", "--agent", "cursor", "--usage-export", CSV, "--state-dir", state]);
    assert.equal(r1.code, 0, r1.stderr);
    assert.match(r1.stdout, /imported\s.*records=3 span=2026-10-09T18:58:39\.019Z\.\.2026-10-09T19:03:08\.384Z reported-cost=\$0\.0600/);
    const sha = createHash("sha256").update(fs.readFileSync(CSV)).digest("hex");
    const stored = path.join(state, "cursor-dashboard", `${sha}.csv`);
    assert.ok(fs.existsSync(stored));
    assert.deepEqual(fs.readFileSync(stored), fs.readFileSync(CSV));
    const mtime = fs.statSync(stored).mtimeMs;
    const r2 = runCli(["import", "--agent", "cursor", "--usage-export", CSV, "--state-dir", state]);
    assert.equal(r2.code, 0, r2.stderr);
    assert.match(r2.stdout, /^unchanged\s/);
    assert.equal(fs.statSync(stored).mtimeMs, mtime);
    assert.deepEqual(allFiles(state), ["cursor-dashboard", `cursor-dashboard/${sha}.csv`]);
    assert.ok(!fs.existsSync(path.join(state, "raw")));
    assert.ok(!fs.existsSync(path.join(state, "runs")));
  });

  it("--dry-run writes nothing; --json is parseable; JSON export is stored as .json", () => {
    const state = tmp();
    const r = runCli(["import", "--agent", "cursor", "--usage-export", JSON_F, "--state-dir", state, "--dry-run", "--json"]);
    assert.equal(r.code, 0, r.stderr);
    const out = JSON.parse(r.stdout) as { dryRun: boolean; files: { outcome: string; format: string; records: number; costUsd: number }[] };
    assert.equal(out.dryRun, true);
    assert.equal(out.files[0]!.outcome, "would-import");
    assert.equal(out.files[0]!.format, "json");
    assert.equal(out.files[0]!.records, 3);
    assert.deepEqual(allFiles(state), []);
    const real = runCli(["import", "--agent", "cursor", "--usage-export", JSON_F, "--usage-export", CSV, "--state-dir", state]);
    assert.equal(real.code, 0, real.stderr);
    assert.equal(allFiles(path.join(state, "cursor-dashboard")).length, 2);
  });

  it("a zero-record file exits nonzero and stores nothing (even beside a good file)", () => {
    const state = tmp();
    const bad = path.join(tmp(), "empty.csv");
    fs.writeFileSync(bad, `${CURSOR_CSV_HEADER}\n`);
    const r = runCli(["import", "--agent", "cursor", "--usage-export", CSV, "--usage-export", bad, "--state-dir", state]);
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /no usable Cursor dashboard usage records/);
    assert.deepEqual(allFiles(state), []);
    const junk = path.join(tmp(), "junk.txt");
    fs.writeFileSync(junk, "not an export");
    assert.notEqual(runCli(["import", "--agent", "cursor", "--usage-export", junk, "--state-dir", state]).code, 0);
  });

  it("rejects --days / --transcript-dir, and --agent cursor without --usage-export", () => {
    const state = tmp();
    const a = runCli(["import", "--agent", "cursor", "--usage-export", CSV, "--days", "5", "--state-dir", state]);
    assert.notEqual(a.code, 0);
    assert.match(a.stderr, /--days and --transcript-dir do not apply/);
    const b = runCli(["import", "--agent", "cursor", "--usage-export", CSV, "--transcript-dir", state, "--state-dir", state]);
    assert.notEqual(b.code, 0);
    const c = runCli(["import", "--agent", "cursor", "--state-dir", state]);
    assert.notEqual(c.code, 0);
    assert.match(c.stderr, /needs --usage-export/);
    assert.deepEqual(allFiles(state), []);
  });
});
