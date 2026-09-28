// Every section of `ach stats --json` must honour the same window
// (--since/--until/--last/--days, --tz) and the same --agent/--project filters.
// The fixture spans two projects x two days; only project /alpha on day 1
// survives `--project /alpha --until 2026-09-21`. The test enumerates the JSON
// top-level keys, so a future section added without a check here fails it.
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const cli = fileURLToPath(new URL("../src/cli/ach.ts", import.meta.url));

function invoke(state: string, args: string[]) {
  const bun = Boolean((process.versions as { bun?: string }).bun);
  return spawnSync(process.execPath, bun ? [cli, ...args] : ["--import", "tsx", cli, ...args], {
    encoding: "utf8",
    timeout: 20000,
    env: {
      ...process.env,
      HOME: state,
      AGENTIC_CODING_HARNESS_STATE_DIR: state,
      AGENTIC_CODING_HARNESS_COST_MODE: "auto",
      AGENTIC_CODING_HARNESS_TZ: "UTC",
      AGENTIC_CODING_HARNESS_PROJECT_ALIASES: "",
    },
  });
}

const DAY1 = Date.parse("2026-09-20T10:00:00Z");
const DAY2 = Date.parse("2026-09-21T10:00:00Z");
const CELLS = [
  { id: "a1", cwd: "/alpha", t: DAY1 }, // the only surviving cell
  { id: "b1", cwd: "/beta", t: DAY1 }, // excluded by --project
  { id: "a2", cwd: "/alpha", t: DAY2 }, // excluded by --until
  { id: "b2", cwd: "/beta", t: DAY2 }, // excluded by both
] as const;

function buildFixture(state: string): void {
  mkdirSync(join(state, "runs"));
  mkdirSync(join(state, "raw"));
  for (const c of CELLS) {
    // A metered claude run: token rows in raw/, context usage, a repeat group.
    writeFileSync(
      join(state, "runs", `claude-${c.id}.json`),
      JSON.stringify({
        runId: `claude-${c.id}`,
        agent: "claude",
        sessionId: `s-${c.id}`,
        cwd: c.cwd,
        startedAt: c.t,
        status: "success",
        exitStatus: "success",
        totals: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 50, cacheWriteTokens: 0, costUsd: 1 },
        usage: {
          tokens: { available: true },
          credits: { available: false },
          usd: { available: true, source: "pricer", value: 1 },
          context: { available: true, source: "derived", percentage: 10, windowTokens: 200000, tokens: 20000, model: "claude-sonnet-4-5" },
        },
        repeat: { group: `g-${c.id}`, index: 1, count: 1 },
      }),
    );
    // An unmetered (metering=none) custom run in the same cell.
    writeFileSync(
      join(state, "runs", `custom-${c.id}.json`),
      JSON.stringify({ runId: `custom-${c.id}`, agent: "custom", sessionId: `u-${c.id}`, cwd: c.cwd, startedAt: c.t + 60_000, status: "success", metering: "none" }),
    );
    writeFileSync(
      join(state, "raw", `claude-s-${c.id}.jsonl`),
      JSON.stringify({
        ts: new Date(c.t).toISOString(),
        agent: "claude",
        sessionId: `s-${c.id}`,
        model: "claude-sonnet-4-5",
        inputTokens: 100,
        outputTokens: 10,
        cacheReadTokens: 50,
        cacheWriteTokens: 0,
        costUsd: 1,
      }) + "\n",
    );
  }
}

type Json = Record<string, any>;
const keysOf = (o: unknown) => Object.keys(o as object).sort();
const sumRecords = (m: Record<string, { records: number }>) => Object.values(m).reduce((s, b) => s + b.records, 0);

test("every ach stats --json section honours --project and --until together", () => {
  const state = mkdtempSync(join(tmpdir(), "ach-stats-filters-"));
  try {
    buildFixture(state);
    const control = invoke(state, ["stats", "--state-only", "--json", "--by", "day,week,month,model,project", "--blocks", "--plan", "pro"]);
    assert.equal(control.status, 0, control.stderr);
    const all = JSON.parse(control.stdout) as Json;
    // Control: the unfiltered run sees all four cells, so each check below can fail.
    assert.equal(all.total.records, 4);
    assert.equal(all.runs.length, 8);
    assert.equal(all.runOutcomes.total.runs, 8);
    assert.equal(all.unmetered.runs, 4);
    assert.equal(all.byRepeatGroup.length, 4);
    assert.deepEqual(keysOf(all.byProject), ["/alpha", "/beta"]);

    const r = invoke(state, [
      "stats", "--state-only", "--json", "--by", "day,week,month,model,project", "--blocks", "--plan", "pro",
      "--project", "/alpha", "--until", "2026-09-21",
    ]);
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout) as Json;

    const checks: Record<string, (v: any) => void> = {
      total: (v) => assert.equal(v.records, 1),
      byAgent: (v) => {
        assert.deepEqual(keysOf(v), ["claude"]);
        assert.equal(v.claude.records, 1);
      },
      byDay: (v) => assert.deepEqual(keysOf(v), ["2026-09-20"]),
      byWeek: (v) => assert.equal(sumRecords(v), 1),
      byMonth: (v) => assert.equal(sumRecords(v), 1),
      timezone: (v) => assert.equal(v, "UTC"),
      window: (v) => assert.ok(v.until, JSON.stringify(v)),
      byModel: (v) => assert.equal(sumRecords(v), 1),
      unpricedModels: (v) => assert.deepEqual(v, []),
      cacheHitRatio: (v) => {
        assert.deepEqual(keysOf(v.byDay), ["2026-09-20"]);
        assert.deepEqual(keysOf(v.byAgent), ["claude"]);
        assert.deepEqual(keysOf(v.byWeek), keysOf(out.byWeek));
        assert.deepEqual(keysOf(v.byMonth), keysOf(out.byMonth));
        assert.equal(typeof v.total, "number");
      },
      byModelDay: (v) => assert.deepEqual(keysOf(v), ["2026-09-20"]),
      byProject: (v) => {
        assert.deepEqual(keysOf(v), ["/alpha"]);
        assert.equal(v["/alpha"].records, 1);
      },
      projectAliases: () => {},
      runs: (v) => assert.deepEqual(v.map((x: Json) => x.runId).sort(), ["claude-a1", "custom-a1"]),
      runOutcomes: (v) => assert.equal(v.total.runs, 2),
      pace: (v) => assert.ok(v !== undefined),
      blocks: (v) => {
        const cost = v.reduce((s: number, b: Json) => s + (b.costUsd ?? 0), 0);
        assert.equal(cost, 1, JSON.stringify(v));
      },
      plan: (v) => assert.equal(v.name, "pro"),
      unmetered: (v) => assert.deepEqual(v, { runs: 1, byAgent: { custom: { runs: 1 } } }),
      byRepeatGroup: (v) => assert.deepEqual(v.map((g: Json) => g.group), ["g-a1"]),
    };
    // A new top-level section must be added to `checks` (with a filter check).
    assert.deepEqual(keysOf(out), keysOf(checks));
    for (const [k, check] of Object.entries(checks)) {
      try {
        check(out[k]);
      } catch (e) {
        throw new Error(`section '${k}' ignores --project/--until: ${(e as Error).message}`);
      }
    }

    // --agent narrows every run-registry section too.
    const agentOnly = invoke(state, ["stats", "--state-only", "--json", "--agent", "custom", "--project", "/alpha", "--until", "2026-09-21"]);
    assert.equal(agentOnly.status, 0, agentOnly.stderr);
    const a = JSON.parse(agentOnly.stdout) as Json;
    assert.equal(a.total.records, 0);
    assert.deepEqual(a.runs.map((x: Json) => x.runId), ["custom-a1"]);
    assert.equal(a.runOutcomes.total.runs, 1);
    assert.equal(a.unmetered.runs, 1);
    assert.equal(a.byRepeatGroup, undefined);
  } finally {
    rmSync(state, { recursive: true, force: true });
  }
});

test("ach stats text output honours --project and --until in every section", () => {
  const state = mkdtempSync(join(tmpdir(), "ach-stats-filters-text-"));
  try {
    buildFixture(state);
    const r = invoke(state, ["stats", "--state-only", "--by", "day,project", "--project", "/alpha", "--until", "2026-09-21"]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^totals\s+records=1 /m);
    assert.match(r.stdout, /^unmetered runs=1 /m);
    assert.match(r.stdout, /^2026-09-20 /m);
    assert.doesNotMatch(r.stdout, /2026-09-21/);
    assert.doesNotMatch(r.stdout, /\/beta/);
    assert.doesNotMatch(r.stdout, /g-(b1|a2|b2)/);
    assert.match(r.stdout, /g-a1/);
  } finally {
    rmSync(state, { recursive: true, force: true });
  }
});
