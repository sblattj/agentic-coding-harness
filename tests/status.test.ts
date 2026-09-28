// `ach status` (#45 compact line, #62 state-file protocol) and
// `ach statusline` (#61 Claude Code statusLine command). One snapshot module
// (src/cli/status.ts) feeds every surface; these tests pin its formats,
// its parity with `ach stats --days 1`, and the atomic write discipline.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { after, before, describe, it } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  BUDGET_NEAR_FRACTION,
  STATUS_JSON_KEYS,
  StatusSnapshotSchema,
  computeStatusSnapshot,
  deriveBudget,
  formatCompact,
  formatHuman,
  type StatusSnapshot,
} from "../src/cli/status.ts";
import { parseClaudeStatusInput, renderStatusline } from "../src/cli/statusline.ts";

const CLI = new URL("../src/cli/ach.ts", import.meta.url).pathname;
const STDIN_FIXTURE = new URL("./fixtures/claude-statusline/status-input.json", import.meta.url).pathname;
const BUDGET_ENV = "AGENTIC_CODING_HARNESS_BUDGET_USD";
const STATE_ENV = "AGENTIC_CODING_HARNESS_STATE_DIR";

interface RunOut {
  code: number;
  stdout: string;
  stderr: string;
}

function cliArgv(args: string[]): string[] {
  const isBun = (process.versions as { bun?: string }).bun !== undefined;
  return isBun ? [CLI, ...args] : ["--import", "tsx", CLI, ...args];
}

function runCli(args: string[], env: Record<string, string | undefined>, input?: string): RunOut {
  const merged: Record<string, string | undefined> = { ...process.env, ...env };
  for (const [k, v] of Object.entries(env)) if (v === undefined) delete merged[k];
  const p = spawnSync(process.execPath, cliArgv(args), {
    env: merged as NodeJS.ProcessEnv,
    encoding: "utf8",
    input: input ?? "",
  });
  return { code: p.status ?? -1, stdout: p.stdout ?? "", stderr: p.stderr ?? "" };
}

function mkTmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

const NOW = Date.now();
const recentIso = new Date(NOW - 2 * 3_600_000).toISOString(); // 2h ago: inside 24h
const oldIso = new Date(NOW - 3 * 86_400_000).toISOString(); // 3 days ago: outside

function writeJsonl(file: string, rows: unknown[]): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
}

function writeRun(dir: string, rec: Record<string, unknown>): void {
  fs.mkdirSync(path.join(dir, "runs"), { recursive: true });
  fs.writeFileSync(path.join(dir, "runs", `${rec.runId as string}.json`), JSON.stringify(rec));
}

/** State dir with: 2 recent priced records (claude 0.5, codex 0.25), 1 old
 *  record (excluded from today), and 3 registry runs (1 live, 1 success, 1
 *  error) all started in the last 24h plus one success from 3 days ago. */
function seedState(dir: string): void {
  writeJsonl(path.join(dir, "raw", "claude", "s1.jsonl"), [
    { ts: recentIso, agent: "claude", sessionId: "s1", model: "claude-sonnet-4-5", inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, costUsd: 0.5 },
    { ts: oldIso, agent: "claude", sessionId: "s1", model: "claude-sonnet-4-5", inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, costUsd: 9 },
  ]);
  writeJsonl(path.join(dir, "raw", "codex", "s2.jsonl"), [
    { ts: recentIso, agent: "codex", sessionId: "s2", model: "gpt-5", inputTokens: 50, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, costUsd: 0.25 },
  ]);
  writeRun(dir, { runId: "r-live", agent: "claude", pid: process.pid, startedAt: NOW - 60_000, updatedAt: Date.now() + 3_600_000, status: "running" });
  writeRun(dir, { runId: "r-ok", agent: "codex", pid: 1, startedAt: NOW - 3_600_000, endedAt: NOW - 3_000_000, status: "success" });
  writeRun(dir, { runId: "r-err", agent: "claude", pid: 1, startedAt: NOW - 7_200_000, status: "error" });
  writeRun(dir, { runId: "r-old", agent: "claude", pid: 1, startedAt: NOW - 3 * 86_400_000, status: "success" });
}

/** Run fn with the state env pointed at dir (in-process tests). */
async function withState<T>(dir: string, fn: () => Promise<T>, budget?: string): Promise<T> {
  const prevState = process.env[STATE_ENV];
  const prevBudget = process.env[BUDGET_ENV];
  process.env[STATE_ENV] = dir;
  if (budget === undefined) delete process.env[BUDGET_ENV];
  else process.env[BUDGET_ENV] = budget;
  try {
    return await fn();
  } finally {
    if (prevState === undefined) delete process.env[STATE_ENV];
    else process.env[STATE_ENV] = prevState;
    if (prevBudget === undefined) delete process.env[BUDGET_ENV];
    else process.env[BUDGET_ENV] = prevBudget;
  }
}

const COMPACT_GRAMMAR = /^runs=\d+ running=\d+ success=\d+ error=\d+ cost_today=\$\d+\.\d{4}( budget_left=\$-?\d+\.\d{4})?$/;

describe("status snapshot (#45 / #62)", () => {
  let state: string;
  let empty: string;
  let missing: string;
  before(() => {
    state = mkTmp("ach-status-state-");
    seedState(state);
    empty = mkTmp("ach-status-empty-");
    missing = path.join(mkTmp("ach-status-missing-"), "does-not-exist");
  });
  after(() => {
    fs.rmSync(state, { recursive: true, force: true });
    fs.rmSync(empty, { recursive: true, force: true });
  });

  it("formatCompact is exactly one stable key=value line (snapshot)", async () => {
    const snap = await withState(state, () => computeStatusSnapshot({ now: NOW }));
    const line = formatCompact(snap);
    assert.equal(line, "runs=3 running=1 success=1 error=1 cost_today=$0.7500");
    assert.match(line, COMPACT_GRAMMAR);
    assert.ok(!line.includes("\n"));
  });

  it("budget_left appears only when a budget is configured (never as 0)", async () => {
    const withBudget = await withState(state, () => computeStatusSnapshot({ now: NOW }), "1");
    assert.equal(formatCompact(withBudget), "runs=3 running=1 success=1 error=1 cost_today=$0.7500 budget_left=$0.2500");
    assert.equal(withBudget.budget.configured, true);
    assert.equal(withBudget.budget.state, "ok");
    const without = await withState(state, () => computeStatusSnapshot({ now: NOW }));
    assert.equal(without.budget.configured, false);
    assert.ok(!formatCompact(without).includes("budget_left"));
  });

  it("deriveBudget flips ok -> near -> exceeded at the documented threshold", () => {
    assert.equal(BUDGET_NEAR_FRACTION, 0.8);
    const on = (cost: number, usd: number) => {
      const b = deriveBudget(cost, usd);
      assert.ok(b.configured);
      return b;
    };
    assert.equal(on(0.79, 1).state, "ok");
    assert.equal(on(0.8, 1).state, "near");
    assert.equal(on(1, 1).state, "exceeded");
    assert.equal(on(1.5, 1).remainingUsd, -0.5);
    assert.equal(on(0.01, 0).state, "exceeded");
    assert.equal(on(0.01, 0).usedFraction, 1);
    assert.deepEqual(deriveBudget(1, undefined), { configured: false });
  });

  it("per-adapter today spend, active runs by agent, newest run", async () => {
    const snap = await withState(state, () => computeStatusSnapshot({ now: NOW }));
    assert.equal(snap.today.costUsd, 0.75);
    assert.equal(snap.today.byAgent.claude?.costUsd, 0.5);
    assert.equal(snap.today.byAgent.codex?.costUsd, 0.25);
    assert.deepEqual(snap.activeByAgent, { claude: 1 });
    assert.equal(snap.newestRun?.runId, "r-live");
    assert.equal(snap.window.kind, "trailing-24h");
    assert.deepEqual(snap.sources, ["state"]);
    const human = formatHuman(snap);
    assert.match(human, /active\s+1 \(claude=1\)/);
    assert.match(human, /today\s+\$0\.7500/);
  });

  it("block cost is n/a (null) unless a provider seam supplies it", async () => {
    const none = await withState(state, () => computeStatusSnapshot({ now: NOW }));
    assert.deepEqual(none.block, { costUsd: null, source: "unavailable" });
    const seamed = await withState(state, () =>
      computeStatusSnapshot({ now: NOW, blockCost: () => 1.5 }),
    );
    assert.deepEqual(seamed.block, { costUsd: 1.5, source: "provider" });
  });

  it("snapshot validates against the versioned schema with the documented key order", async () => {
    for (const dir of [state, empty, missing]) {
      const snap = await withState(dir, () => computeStatusSnapshot({ now: NOW }), "2");
      const parsed = StatusSnapshotSchema.strict().safeParse(snap);
      assert.ok(parsed.success, JSON.stringify(parsed.error?.issues));
      assert.equal(snap.schemaVersion, 1);
      assert.deepEqual(Object.keys(snap), [...STATUS_JSON_KEYS]);
    }
  });

  it("CLI: --compact on an empty and a missing state dir exits 0 with a valid zero line", () => {
    for (const dir of [empty, missing]) {
      const r = runCli(["status", "--compact"], { [STATE_ENV]: dir, [BUDGET_ENV]: undefined });
      assert.equal(r.code, 0, r.stderr);
      assert.equal(r.stdout, "runs=0 running=0 success=0 error=0 cost_today=$0.0000\n");
    }
  });

  it("CLI: --json is one object with stable documented keys; human block renders", () => {
    const j = runCli(["status", "--json"], { [STATE_ENV]: state, [BUDGET_ENV]: undefined });
    assert.equal(j.code, 0, j.stderr);
    const obj = JSON.parse(j.stdout) as StatusSnapshot;
    assert.deepEqual(Object.keys(obj), [...STATUS_JSON_KEYS]);
    assert.ok(StatusSnapshotSchema.strict().safeParse(obj).success);
    const h = runCli(["status"], { [STATE_ENV]: state, [BUDGET_ENV]: undefined });
    assert.equal(h.code, 0, h.stderr);
    assert.match(h.stdout, /^runs\s+3/m);
  });

  it("CLI parity: cost_today equals `ach stats --days 1 --state-only` total", () => {
    const env = { [STATE_ENV]: state, [BUDGET_ENV]: undefined };
    const stats = JSON.parse(runCli(["stats", "--days", "1", "--json", "--state-only"], env).stdout) as {
      total: { costUsd: number; records: number };
    };
    const status = JSON.parse(runCli(["status", "--json"], env).stdout) as StatusSnapshot;
    assert.equal(status.today.costUsd, stats.total.costUsd);
    assert.equal(status.today.records, stats.total.records);
  });

  it("CLI parity with --transcripts: equals `ach stats --days 1` over machine transcripts too", () => {
    const home = mkTmp("ach-status-home-");
    try {
      const proj = path.join(home, ".claude", "projects", "p1");
      writeJsonl(path.join(proj, "sess-x.jsonl"), [
        {
          type: "assistant",
          timestamp: recentIso,
          sessionId: "sess-x",
          requestId: "req-1",
          message: {
            id: "msg_1",
            model: "claude-sonnet-4-5",
            usage: { input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
          },
        },
      ]);
      const env = { [STATE_ENV]: state, HOME: home, [BUDGET_ENV]: undefined };
      const stats = JSON.parse(runCli(["stats", "--days", "1", "--json"], env).stdout) as {
        total: { costUsd: number; records: number };
      };
      const status = JSON.parse(runCli(["status", "--json", "--transcripts"], env).stdout) as StatusSnapshot;
      assert.ok(stats.total.costUsd > 0.75, "fixture transcript must contribute cost");
      assert.equal(status.today.costUsd, stats.total.costUsd);
      assert.equal(status.today.records, stats.total.records);
      assert.deepEqual(status.sources, ["state", "transcripts"]);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("status --once --write-state (#62)", () => {
  let state: string;
  let out: string;
  before(() => {
    state = mkTmp("ach-status-ws-");
    seedState(state);
    out = mkTmp("ach-status-out-");
  });
  after(() => {
    fs.rmSync(state, { recursive: true, force: true });
    fs.rmSync(out, { recursive: true, force: true });
  });

  it("writes a schema-valid snapshot, exits 0, leaves no tmp file; re-run overwrites", () => {
    const file = path.join(out, "nested", "state.json");
    const r1 = runCli(["status", "--once", "--write-state", file], { [STATE_ENV]: state, [BUDGET_ENV]: "5" });
    assert.equal(r1.code, 0, r1.stderr);
    assert.equal(r1.stdout, "");
    const s1 = StatusSnapshotSchema.parse(JSON.parse(fs.readFileSync(file, "utf8")));
    assert.equal(s1.today.costUsd, 0.75);
    assert.equal(s1.budget.configured, true);
    assert.equal(s1.runs.running, 1);
    assert.deepEqual(fs.readdirSync(path.dirname(file)), ["state.json"]);

    // More spend lands; re-run replaces the document in place.
    writeJsonl(path.join(state, "raw", "gemini", "s3.jsonl"), [
      { ts: recentIso, agent: "gemini", sessionId: "s3", inputTokens: 1, outputTokens: 1, costUsd: 0.125 },
    ]);
    const r2 = runCli(["status", "--once", "--write-state", file], { [STATE_ENV]: state, [BUDGET_ENV]: "5" });
    assert.equal(r2.code, 0, r2.stderr);
    const s2 = StatusSnapshotSchema.parse(JSON.parse(fs.readFileSync(file, "utf8")));
    assert.equal(s2.today.costUsd, 0.875);
    assert.equal(s2.today.byAgent.gemini?.costUsd, 0.125);
    assert.deepEqual(fs.readdirSync(path.dirname(file)), ["state.json"]);
  });

  it("atomic: a reader polling while the writer loops never sees truncated JSON", async () => {
    const file = path.join(out, "loop.json");
    const child = spawn(process.execPath, cliArgv(["status", "--write-state", file, "--interval-ms", "5"]), {
      env: { ...process.env, [STATE_ENV]: state },
      stdio: "ignore",
    });
    try {
      let reads = 0;
      let lastGeneratedAt: string | undefined;
      let rewrites = 0;
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline && (reads < 300 || rewrites < 5)) {
        let text: string;
        try {
          text = fs.readFileSync(file, "utf8");
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code === "ENOENT") {
            await new Promise((r) => setTimeout(r, 5));
            continue;
          }
          throw e;
        }
        const snap = StatusSnapshotSchema.parse(JSON.parse(text)); // throws on a torn read
        reads += 1;
        // Rewrites are counted by content (generatedAt), not mtime, so the
        // test does not depend on filesystem timestamp granularity.
        if (lastGeneratedAt !== undefined && snap.generatedAt !== lastGeneratedAt) rewrites += 1;
        lastGeneratedAt = snap.generatedAt;
        await new Promise((r) => setImmediate(r));
      }
      assert.ok(reads >= 300, `only ${reads} reads`);
      assert.ok(rewrites >= 5, `writer only rewrote ${rewrites} times`);
    } finally {
      child.kill("SIGTERM");
    }
  });
});

describe("statusline (#61)", () => {
  let state: string;
  let empty: string;
  const payload = fs.readFileSync(STDIN_FIXTURE, "utf8");
  before(() => {
    state = mkTmp("ach-sl-state-");
    seedState(state);
    empty = mkTmp("ach-sl-empty-");
  });
  after(() => {
    fs.rmSync(state, { recursive: true, force: true });
    fs.rmSync(empty, { recursive: true, force: true });
  });

  it("parses the documented stdin fields and ignores the rest", () => {
    const p = parseClaudeStatusInput(payload);
    assert.deepEqual(p, {
      sessionId: "abc123",
      modelId: "claude-opus-5-5",
      modelName: "Opus",
      sessionCostUsd: 0.01234,
      cwd: "/current/working/directory",
    });
    assert.deepEqual(parseClaudeStatusInput(""), {});
    assert.deepEqual(parseClaudeStatusInput("not json {"), {});
    assert.deepEqual(parseClaudeStatusInput("[1,2]"), {});
    assert.deepEqual(parseClaudeStatusInput('{"cost":{"total_cost_usd":"x"},"model":7}'), {});
  });

  it("CLI: piping the captured payload prints one line with session/today/block/model", () => {
    const r = runCli(["statusline", "--no-cache"], { [STATE_ENV]: state, [BUDGET_ENV]: undefined }, payload);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout, "Opus · session $0.0123 · today $0.7500 · block n/a\n");
  });

  it("CLI: with a budget, shows budget left and flips to a near-limit marker past 80%", () => {
    const ok = runCli(["statusline", "--no-cache"], { [STATE_ENV]: state, [BUDGET_ENV]: "10" }, payload);
    assert.equal(ok.stdout, "Opus · session $0.0123 · today $0.7500 · block n/a · budget $9.2500 left\n");
    const near = runCli(["statusline", "--no-cache"], { [STATE_ENV]: state, [BUDGET_ENV]: "0.9" }, payload);
    assert.equal(near.stdout, "Opus · session $0.0123 · today $0.7500 · block n/a · budget $0.1500 left [NEAR LIMIT]\n");
    const over = runCli(["statusline", "--no-cache"], { [STATE_ENV]: state, [BUDGET_ENV]: "0.5" }, payload);
    assert.equal(over.stdout, "Opus · session $0.0123 · today $0.7500 · block n/a · budget -$0.2500 left [OVER BUDGET]\n");
  });

  it("CLI: --chain prepends the user's own statusline, which receives the same stdin", () => {
    const r = runCli(
      ["statusline", "--no-cache", "--chain", "grep -o '\"display_name\": \"Opus\"' | head -n 1"],
      { [STATE_ENV]: state, [BUDGET_ENV]: undefined },
      payload,
    );
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout, "\"display_name\": \"Opus\" | Opus · session $0.0123 · today $0.7500 · block n/a\n");
  });

  it("CLI: a failing or missing chained command degrades to ach's segment, exit 0", () => {
    for (const cmd of ["echo partial; exit 3", "definitely-not-a-real-command-ach-xyz"]) {
      const r = runCli(["statusline", "--no-cache", "--chain", cmd], { [STATE_ENV]: state, [BUDGET_ENV]: undefined }, payload);
      assert.equal(r.code, 0, r.stderr);
      assert.equal(r.stdout, "Opus · session $0.0123 · today $0.7500 · block n/a\n");
      assert.match(r.stderr, /chained statusline/);
    }
  });

  it("CLI: empty or malformed stdin yields a minimal line and exit 0", () => {
    for (const input of ["", "{not json", "null"]) {
      const r = runCli(["statusline", "--no-cache"], { [STATE_ENV]: empty, [BUDGET_ENV]: undefined }, input);
      assert.equal(r.code, 0, r.stderr);
      assert.equal(r.stdout, "n/a · session n/a · today $0.0000 · block n/a\n");
    }
  });

  it("warm cache: a fresh snapshot file is reused (no recompute) and renders within the 300 ms budget", async () => {
    const cacheDir = mkTmp("ach-sl-cache-");
    try {
      const cache = path.join(cacheDir, "status-snapshot.json");
      // Prime: cold render writes the cache.
      await withState(state, () => renderStatusline({ stdinText: payload, cachePath: cache, maxAgeMs: 60_000 }));
      const primed = StatusSnapshotSchema.parse(JSON.parse(fs.readFileSync(cache, "utf8")));
      // Tamper the cached cost: a warm render must show the cached number.
      fs.writeFileSync(cache, JSON.stringify({ ...primed, today: { ...primed.today, costUsd: 4.2 } }));
      const t0 = performance.now();
      const res = await withState(state, () =>
        renderStatusline({ stdinText: payload, cachePath: cache, maxAgeMs: 60_000 }),
      );
      const ms = performance.now() - t0;
      assert.equal(res.line, "Opus · session $0.0123 · today $4.2000 · block n/a");
      assert.ok(ms < 300, `warm render took ${ms.toFixed(1)} ms`);
      // A stale cache is recomputed.
      const stale = { ...primed, generatedAt: new Date(Date.now() - 120_000).toISOString(), today: { ...primed.today, costUsd: 4.2 } };
      fs.writeFileSync(cache, JSON.stringify(stale));
      const fresh = await withState(state, () =>
        renderStatusline({ stdinText: payload, cachePath: cache, maxAgeMs: 60_000 }),
      );
      assert.equal(fresh.line, "Opus · session $0.0123 · today $0.7500 · block n/a");
    } finally {
      fs.rmSync(cacheDir, { recursive: true, force: true });
    }
  });

  it("block seam: a provider's block cost renders in the segment", async () => {
    const res = await withState(state, () =>
      renderStatusline({ stdinText: payload, noCache: true, blockCost: () => 1.5 }),
    );
    assert.equal(res.line, "Opus · session $0.0123 · today $0.7500 · block $1.5000");
  });
});
