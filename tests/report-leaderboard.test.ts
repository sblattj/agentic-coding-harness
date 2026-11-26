// League-table export (#90): `ach report` folds runs into experiment x
// variant rows (the /api/compare rollup), renders them as a sortable table,
// writes the same rows to a versioned leaderboard.json, can source its run
// set from the registry (--registry), lists each row's run ids with their seal
// verdict, and regenerates byte-identically from unchanged runs.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { writeRunRecord, type RunRecord } from "../src/core/registry.ts";
import { canonicalTotals, ChainWriter } from "../src/core/hash-chain.ts";
import { startWebServer } from "../src/web/server.ts";
import {
  computeLeaderboard,
  LEADERBOARD_SCHEMA,
  LEADERBOARD_SCHEMA_VERSION,
  type LeaderboardDoc,
  type LeaderboardRow,
} from "../src/report/leaderboard.ts";

const CLI = new URL("../src/cli/ach.ts", import.meta.url).pathname;
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const T0 = 1_700_000_000_000;

function cli(args: string[], stateDir: string): { code: number; stdout: string; stderr: string } {
  const isBun = (process.versions as { bun?: string }).bun !== undefined;
  const env: NodeJS.ProcessEnv = { ...process.env, AGENTIC_CODING_HARNESS_STATE_DIR: stateDir };
  delete env.AGENTIC_CODING_HARNESS_PRIVACY;
  delete env.AGENTIC_CODING_HARNESS_MASK;
  const p = spawnSync(process.execPath, isBun ? [CLI, ...args] : ["--import", "tsx", CLI, ...args], { encoding: "utf8", env });
  return { code: p.status ?? -1, stdout: p.stdout ?? "", stderr: p.stderr ?? "" };
}

const totals = (input: number, output: number, costUsd: number): NonNullable<RunRecord["totals"]> => ({
  inputTokens: input,
  outputTokens: output,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costUsd,
});

/** e1/v1: three runs (mean cost 1.0, median 0.5); e1/v2: one priced + one unpriced outage; e2: no variant. */
function fixtureRecords(stateDir: string): RunRecord[] {
  // r-a carries a real, intact hash-chained transcript (seal ok).
  const sealedTotals = totals(100, 20, 0.25);
  const w = new ChainWriter("r-a");
  const lines = [w.frame(JSON.stringify({ type: "session", timestamp: T0 }))];
  const sealed = w.seal(T0 + 2000, canonicalTotals(sealedTotals))!;
  lines.push(sealed.line);
  const raw = path.join(stateDir, "raw", "claude-r-a.jsonl");
  fs.mkdirSync(path.dirname(raw), { recursive: true });
  fs.writeFileSync(raw, lines.join("\n") + "\n");
  return [
    { runId: "r-a", agent: "claude", startedAt: T0, endedAt: T0 + 2000, status: "success", experiment: "e1", variant: "v1", totals: sealedTotals, rawTranscript: raw, seal: sealed.seal },
    { runId: "r-b", agent: "claude", startedAt: T0 + 10_000, endedAt: T0 + 14_000, status: "error", experiment: "e1", variant: "v1", totals: totals(300, 40, 0.5) },
    // Sealed but the transcript path is gone: tampered.
    {
      runId: "r-c", agent: "claude", startedAt: T0 + 20_000, endedAt: T0 + 29_000, status: "success", experiment: "e1", variant: "v1", totals: totals(500, 60, 2.25),
      seal: { ...sealed.seal },
    },
    { runId: "r-d", agent: "codex", startedAt: T0 + 30_000, endedAt: T0 + 31_000, status: "success", experiment: "e1", variant: "v2", totals: totals(50, 5, 1) },
    { runId: "r-e", agent: "codex", startedAt: T0 + 40_000, endedAt: T0 + 40_500, status: "unavailable", exitStatus: "unavailable", experiment: "e1", variant: "v2", metering: "none" },
    { runId: "r-f", agent: "kiro", startedAt: T0 + 50_000, endedAt: T0 + 53_000, status: "success", experiment: "e2", totals: totals(10, 1, 0.125) },
  ];
}

function seedState(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ach-league-"));
  for (const rec of fixtureRecords(dir)) writeRunRecord(dir, rec);
  return dir;
}

/** The league table's rows as {field: data-v} maps, straight from the HTML. */
function leagueCells(html: string): Array<Record<string, string>> {
  const start = html.indexOf('<table class="cmp sortable" id="league">');
  assert.ok(start >= 0, "league table present and sortable");
  const table = html.slice(start, html.indexOf("</table>", start));
  const body = table.slice(table.indexOf("<tbody>"));
  return [...body.matchAll(/<tr[^>]*>(.*?)<\/tr>/g)].map((m) =>
    Object.fromEntries([...m[1]!.matchAll(/<td data-f="(\w+)" data-v="([^"]*)"/g)].map((c) => [c[1]!, c[2]!])),
  );
}

/** What each league cell's data-v must be for a leaderboard.json row. */
function expectedCells(row: LeaderboardRow, shownFields: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of shownFields) {
    const v = (row as unknown as Record<string, unknown>)[f];
    out[f] = f === "members" ? row.members.map((m) => m.runId).join(" ") : v === null ? "" : String(v);
  }
  return out;
}

const readJson = (file: string): LeaderboardDoc => JSON.parse(fs.readFileSync(file, "utf8")) as LeaderboardDoc;
const rowKey = (r: { experiment?: unknown; variant?: unknown }): string => `${String(r.experiment)}|${r.variant === undefined || r.variant === null ? "" : String(r.variant)}`;

describe("ach report league table (#90)", () => {
  let stateDir: string;
  let outDir: string;

  before(() => {
    stateDir = seedState();
    outDir = fs.mkdtempSync(path.join(os.tmpdir(), "ach-league-out-"));
  });
  after(() => {
    fs.rmSync(stateDir, { recursive: true, force: true });
    fs.rmSync(outDir, { recursive: true, force: true });
  });

  test("renders aggregated experiment x variant rows (runs, success, mean/median cost, tokens, wall), sortable, beside the per-run rows", () => {
    const html = path.join(outDir, "ac1", "report.html");
    const r = cli(["report", "--registry", "--out", html], stateDir);
    assert.equal(r.code, 0, r.stderr);
    const page = fs.readFileSync(html, "utf8");
    const cells = leagueCells(page);
    assert.deepEqual(cells.map(rowKey), ["e1|v1", "e1|v2", "e2|"]);
    const v1 = cells[0]!;
    assert.equal(v1.runs, "3");
    assert.equal(v1.successRate, String(2 / 3));
    assert.equal(v1.avgCostUsd, "1");
    assert.equal(v1.medianCostUsd, "0.5");
    assert.equal(v1.avgTotalTokens, "340");
    assert.equal(v1.medianTotalTokens, "340");
    assert.equal(v1.avgDurationMs, "5000");
    assert.equal(v1.medianDurationMs, "4000");
    // e1/v2 has an unpriced outage: cost n/a (never a fabricated mean), success over verdicts only.
    assert.equal(cells[1]!.avgCostUsd, "");
    assert.equal(cells[1]!.medianCostUsd, "");
    assert.equal(cells[1]!.successRate, "1");
    // Every league column header is clickable (the sort JS binds table.sortable by id).
    for (const k of ["experiment", "variant", "runs", "successRate", "avgCostUsd", "medianCostUsd", "avgTotalTokens", "medianTotalTokens", "avgDurationMs", "medianDurationMs"]) {
      assert.match(page, new RegExp(`<th data-k="${k}" data-t="[sn]"`), `sortable header ${k}`);
    }
    // ...in addition to the per-run comparison table, one row per run.
    const cmpStart = page.indexOf('<table class="cmp sortable" id="comparison">');
    assert.ok(cmpStart > page.indexOf('id="league"'), "per-run comparison table still rendered");
    const cmp = page.slice(cmpStart, page.indexOf("</table>", cmpStart));
    assert.equal([...cmp.matchAll(/<tr data-agent=/g)].length, 6);
  });

  test("aggregated rows match GET /api/compare for the same run set (success rate and cost agree)", async () => {
    // Own state dir: the shared fixture plus a mixed-agent group whose costs
    // (0.1, 0.2, 0.3) sum to different floats in different orders.
    const dir = seedState();
    const html = path.join(outDir, "ac2", "report.html");
    for (const [i, [agent, cost]] of ([["kiro", 0.1], ["claude", 0.2], ["codex", 0.3]] as const).entries()) {
      writeRunRecord(dir, { runId: `mix-${i}`, agent, startedAt: T0 + 60_000 + i * 1000, endedAt: T0 + 60_500 + i * 1000, status: "success", experiment: "e3", variant: "mixed", totals: totals(7, 3, cost) });
    }
    const r = cli(["report", "--registry", "--out", html], dir);
    assert.equal(r.code, 0, r.stderr);
    const league = readJson(path.join(outDir, "ac2", "leaderboard.json"));
    assert.equal(league.rows.length, 4);
    const handle = await startWebServer({ port: 0, host: "127.0.0.1", token: "t", stateDir: dir });
    try {
      const res = await fetch(`http://127.0.0.1:${handle.port}/api/compare`);
      assert.equal(res.status, 200);
      const body = (await res.json()) as { groupBy: string[]; rows: Array<Record<string, unknown>> };
      assert.deepEqual(body.groupBy, league.groupBy);
      assert.deepEqual(body.rows.map(rowKey), league.rows.map(rowKey), "same groups in the same order");
      for (const [i, api] of body.rows.entries()) {
        const row = league.rows[i]!;
        assert.equal(row.runs, api.runs, `${rowKey(row)} runs`);
        assert.equal(row.successRate, api.successRate, `${rowKey(row)} success rate`);
        assert.equal(row.avgCostUsd, api.avgCostUsd, `${rowKey(row)} cost`);
        assert.equal(row.unpricedRuns, api.unpricedRuns ?? 0, `${rowKey(row)} unpriced`);
        assert.equal(row.avgTotalTokens, api.avgTotalTokens, `${rowKey(row)} tokens`);
        assert.equal(row.avgDurationMs, api.avgDurationMs, `${rowKey(row)} wall`);
        assert.equal(row.agent, api.agent, `${rowKey(row)} display agent`);
      }
    } finally {
      await handle.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a record-less trial dir: no fabricated time (dataAsOf null, no footer stamp) and byte-identical on regenerate", () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "ach-league-nostate-"));
    const trial = path.join(outDir, "plain", "20260102-000000");
    fs.mkdirSync(trial, { recursive: true });
    fs.writeFileSync(
      path.join(trial, "claude.json"),
      JSON.stringify({ runId: "plain-1", sessionId: "s", agent: "claude", events: [{ type: "session", timestamp: 1 }], tokens: [], totalCost: 0.5, durationMs: 1000, exitStatus: "success", warnings: [] }),
    );
    try {
      assert.equal(cli(["report", trial], empty).code, 0);
      const html1 = fs.readFileSync(path.join(trial, "report.html"), "utf8");
      const json1 = fs.readFileSync(path.join(trial, "leaderboard.json"), "utf8");
      assert.equal((JSON.parse(json1) as LeaderboardDoc).dataAsOf, null);
      assert.doesNotMatch(html1, /data as of/);
      assert.doesNotMatch(html1, /1970-01-01/);
      // Second run sees the first run's report.html and leaderboard.json in the directory.
      const again = cli(["report", trial], empty);
      assert.equal(again.code, 0, again.stderr);
      assert.match(again.stdout, /\(1 runs · 1 trial\)/);
      assert.equal(fs.readFileSync(path.join(trial, "report.html"), "utf8"), html1, "HTML byte-identical");
      assert.equal(fs.readFileSync(path.join(trial, "leaderboard.json"), "utf8"), json1, "JSON byte-identical");
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });

  test("trial-directory reports roll up the joined RunRecords, so they group like /api/compare too", () => {
    const trials = path.join(outDir, "trials", "20260101-000000");
    fs.mkdirSync(trials, { recursive: true });
    // Trial artifacts for two registry runs plus one run with no record.
    const artifact = (runId: string, agent: string, cost: number, exitStatus: string): string =>
      JSON.stringify({ runId, sessionId: `s-${runId}`, agent, events: [{ type: "session", timestamp: 1 }], tokens: [], totalCost: cost, durationMs: 1000, exitStatus, warnings: [] });
    fs.writeFileSync(path.join(trials, "claude.json"), artifact("r-a", "claude", 0.25, "success"));
    fs.writeFileSync(path.join(trials, "codex.json"), artifact("r-d", "codex", 1, "success"));
    fs.writeFileSync(path.join(trials, "opencode.json"), artifact("no-record-run", "opencode", 0.5, "error"));
    const html = path.join(trials, "report.html");
    const r = cli(["report", trials], stateDir);
    assert.equal(r.code, 0, r.stderr);
    const league = readJson(path.join(trials, "leaderboard.json"));
    // Record labels win (e1/v1, e1/v2); the record-less run falls back to its agent, like /api/compare.
    assert.deepEqual(league.rows.map(rowKey), ["e1|v1", "e1|v2", "opencode|"]);
    assert.equal(league.rows[2]!.successRate, 0);
    assert.equal(league.rows[2]!.avgCostUsd, 0.5);
    assert.deepEqual(league.rows[2]!.members, [{ runId: "no-record-run", agent: "opencode", verdict: "failure", seal: null }]);
    assert.equal(leagueCells(fs.readFileSync(html, "utf8")).length, 3);
  });

  test("leaderboard.json rows equal the rendered aggregated rows, under a versioned schema", () => {
    const html = path.join(outDir, "ac3", "report.html");
    const r = cli(["report", "--registry", "--out", html], stateDir);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /wrote .*leaderboard\.json \(3 league rows\)/);
    const doc = readJson(path.join(outDir, "ac3", "leaderboard.json"));
    assert.equal(doc.schema, LEADERBOARD_SCHEMA);
    assert.equal(doc.schemaVersion, LEADERBOARD_SCHEMA_VERSION);
    assert.equal(doc.schemaVersion, 1);
    assert.equal(doc.runs, 6);
    const cells = leagueCells(fs.readFileSync(html, "utf8"));
    assert.equal(cells.length, doc.rows.length);
    const shown = Object.keys(cells[0]!);
    // Every metric the issue names is a rendered column, not only a JSON field.
    for (const f of ["experiment", "variant", "runs", "successRate", "avgCostUsd", "medianCostUsd", "avgTotalTokens", "medianTotalTokens", "avgDurationMs", "medianDurationMs", "members"]) {
      assert.ok(shown.includes(f), `column ${f}`);
    }
    doc.rows.forEach((row, i) => assert.deepEqual(cells[i], expectedCells(row, shown), `row ${i}`));
    // Stable shape: every row carries every field (null = unknown, never omitted).
    const keys = Object.keys(doc.rows[0]!);
    for (const row of doc.rows) assert.deepEqual(Object.keys(row), keys);
  });

  test("the schema is documented: docs/LEADERBOARD.md names every top-level, row and member field", () => {
    const docs = fs.readFileSync(path.join(ROOT, "docs", "LEADERBOARD.md"), "utf8");
    const doc = computeLeaderboard(fixtureRecords(stateDir));
    const fields = [...Object.keys(doc), ...Object.keys(doc.rows[0]!), ...Object.keys(doc.rows[0]!.members[0]!)];
    for (const f of new Set(fields)) assert.ok(docs.includes(`\`${f}\``), `docs/LEADERBOARD.md documents \`${f}\``);
    assert.match(docs, new RegExp(`schemaVersion.*${LEADERBOARD_SCHEMA_VERSION}`));
  });

  test("--registry selects the run set from <stateDir>/runs/ with no positional paths; --limit keeps the newest N", () => {
    const html = path.join(outDir, "ac4", "report.html");
    const r = cli(["report", "--registry", "--out", html], stateDir);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /\(6 runs · 1 trial\)/);
    const two = path.join(outDir, "ac4b", "report.html");
    const l = cli(["report", "--registry", "--limit", "2", "--out", two], stateDir);
    assert.equal(l.code, 0, l.stderr);
    const doc = readJson(path.join(outDir, "ac4b", "leaderboard.json"));
    assert.deepEqual(doc.rows.flatMap((row) => row.members.map((m) => m.runId)), ["r-e", "r-f"]);
    // Positionals and --registry are two different run sources: refused.
    const both = cli(["report", "--registry", outDir], stateDir);
    assert.notEqual(both.code, 0);
    assert.match(both.stderr, /--registry reads the run registry/);
    const bad = cli(["report", "--registry", "--limit", "0"], stateDir);
    assert.notEqual(bad.code, 0);
    assert.match(bad.stderr, /--limit must be a positive integer/);
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "ach-league-empty-"));
    try {
      const none = cli(["report", "--registry", "--out", path.join(empty, "r.html")], empty);
      assert.notEqual(none.code, 0);
      assert.match(none.stderr, /no run records/);
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });

  test("each aggregated row lists the run ids it folds and the seal verdict per run (JSON and HTML)", () => {
    const html = path.join(outDir, "ac5", "report.html");
    const r = cli(["report", "--registry", "--out", html], stateDir);
    assert.equal(r.code, 0, r.stderr);
    const doc = readJson(path.join(outDir, "ac5", "leaderboard.json"));
    assert.deepEqual(
      doc.rows.map((row) => row.members.map((m) => [m.runId, m.seal, m.verdict])),
      [
        [["r-a", "ok", "success"], ["r-b", "unsealed", "failure"], ["r-c", "tampered", "success"]],
        [["r-d", "unsealed", "success"], ["r-e", "unsealed", "unavailable"]],
        [["r-f", "unsealed", "success"]],
      ],
    );
    const page = fs.readFileSync(html, "utf8");
    const league = page.slice(page.indexOf('id="league"'), page.indexOf("</table>", page.indexOf('id="league"')));
    assert.match(league, /data-run="r-a" data-seal="ok"><code>r-a<\/code> ✓ sealed/);
    assert.match(league, /data-run="r-c" data-seal="tampered"><code>r-c<\/code> ✗ TAMPERED/);
  });

  test("--privacy anon hashes league run ids exactly like the per-run rows", () => {
    const html = path.join(outDir, "anon", "report.html");
    const r = cli(["report", "--registry", "--privacy", "anon", "--out", html], stateDir);
    assert.equal(r.code, 0, r.stderr);
    const doc = readJson(path.join(outDir, "anon", "leaderboard.json"));
    const ids = doc.rows.flatMap((row) => row.members.map((m) => m.runId));
    assert.ok(ids.every((id) => /^anon-[0-9a-f]{12}$/.test(id)), ids.join(","));
    const json = cli(["report", "--registry", "--privacy", "anon", "--json"], stateDir);
    assert.equal(json.code, 0, json.stderr);
    const model = JSON.parse(json.stdout) as { runs: Array<{ result: { runId: string } }>; leaderboard: LeaderboardDoc };
    assert.deepEqual(
      [...ids].sort(),
      model.runs.map((x) => x.result.runId).sort(),
      "league ids equal the per-run ids",
    );
    assert.deepEqual(model.leaderboard.rows.flatMap((row) => row.members.map((m) => m.runId)), ids);
    const page = fs.readFileSync(html, "utf8");
    assert.ok(!/data-run="r-[a-f]"|<code>r-[a-f]<\/code>|data-v="r-[a-f]/.test(page), "no raw run id in the league table");
    assert.ok(page.includes(`data-run="${ids[0]}"`), "the hashed id is rendered");
  });

  test("regenerating from unchanged runs gives byte-identical HTML and JSON", () => {
    const one = path.join(outDir, "det1", "report.html");
    const two = path.join(outDir, "det2", "report.html");
    assert.equal(cli(["report", "--registry", "--out", one], stateDir).code, 0);
    // Rewrite the same records in reverse order between runs (registry file order must not leak in).
    const runsDir = path.join(stateDir, "runs");
    const saved = Object.fromEntries(fs.readdirSync(runsDir).map((f) => [f, fs.readFileSync(path.join(runsDir, f))]));
    for (const f of Object.keys(saved)) fs.rmSync(path.join(runsDir, f));
    for (const f of Object.keys(saved).reverse()) fs.writeFileSync(path.join(runsDir, f), saved[f]!);
    assert.equal(Object.keys(saved).length, 6);
    assert.equal(cli(["report", "--registry", "--out", two], stateDir).code, 0);
    assert.equal(fs.readFileSync(two, "utf8"), fs.readFileSync(one, "utf8"), "HTML byte-identical");
    assert.equal(
      fs.readFileSync(path.join(outDir, "det2", "leaderboard.json"), "utf8"),
      fs.readFileSync(path.join(outDir, "det1", "leaderboard.json"), "utf8"),
      "JSON byte-identical",
    );
    // The only timestamp is a real one: the newest run end in the set.
    assert.equal(readJson(path.join(outDir, "det1", "leaderboard.json")).dataAsOf, new Date(T0 + 53_000).toISOString());
    assert.match(fs.readFileSync(one, "utf8"), /data as of 2023-11-14T22:14:13\.000Z<\/footer>/);
  });

  test("docs walk through run matrix -> registry -> leaderboard (HTML + JSON) -> share", () => {
    const docs = fs.readFileSync(path.join(ROOT, "docs", "LEADERBOARD.md"), "utf8");
    for (const step of ["ach trial --matrix", "ach report --registry", "leaderboard.json", "/api/compare", "--privacy"]) {
      assert.ok(docs.includes(step), `walkthrough mentions ${step}`);
    }
    assert.match(docs, /^## .*[Ss]hare/m);
    const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
    assert.ok(readme.includes("docs/LEADERBOARD.md"), "README links the leaderboard doc");
    assert.ok(readme.includes("--registry"), "README documents --registry");
  });
});
