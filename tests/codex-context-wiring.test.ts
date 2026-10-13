// Codex native latest-call usage -> context meter (#140/#142 parser wired to the #141 meter).
// All fixtures are synthetic; model names are arbitrary and absent from the window table.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { parseCodexRollout, type CodexRecordMeta } from "../src/monitors/transcripts.ts";
import { latestCodexCall } from "../src/core/codex-native.ts";
import { createDriver } from "../src/core/driver.ts";
import { CodexAdapter } from "../src/adapters/codex.ts";
import { formatContextCell } from "../src/cli/lib.ts";
import { runContextRows } from "../src/cli/context-stats.ts";
import { listRunRecords } from "../src/core/registry.ts";
import { FakeChild, fakeSpawnFn } from "./helpers/fake-child.ts";

const v7 = (ms: number, tail: string): string => {
  const hex = ms.toString(16).padStart(12, "0");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7${tail.slice(0, 3)}-8${tail.slice(3, 6)}-${tail.slice(6, 18).padEnd(12, "0")}`;
};
const T0 = Date.parse("2026-09-01T10:00:00.000Z");
const THREAD = v7(T0, "ddddddd00000000001");
const TURN1 = v7(T0 + 500, "eeeeee000000000011");
const TURN2 = v7(T0 + 900, "ffffff000000000012");
const iso = (ms: number): string => new Date(ms).toISOString();
const tmp = (prefix: string): string => mkdtempSync(join(tmpdir(), prefix));
const jsonl = (lines: unknown[]): string => lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
function writeRollout(dir: string, id: string, lines: unknown[]): void {
  const day = join(dir, "2026", "09", "01");
  mkdirSync(day, { recursive: true });
  writeFileSync(join(day, `rollout-2026-09-01T10-00-00-${id}.jsonl`), jsonl(lines));
}
const meta = (id: string) => ({ timestamp: iso(T0), type: "session_meta", payload: { id, timestamp: iso(T0), cwd: "/work", source: "exec" } });
const ctx = (turn: string, ts = T0) => ({ timestamp: iso(ts), type: "turn_context", payload: { turn_id: turn, model: "fixture-model", effort: "medium" } });
const taskStarted = (turn: string, window?: number, ts = T0) => ({
  timestamp: iso(ts),
  type: "event_msg",
  payload: { type: "task_started", turn_id: turn, ...(window !== undefined ? { model_context_window: window } : {}) },
});
const counts = (input: number, cached: number, output: number) => ({ input_tokens: input, cached_input_tokens: cached, output_tokens: output, reasoning_output_tokens: 0 });
type Counts = ReturnType<typeof counts>;
const tokenCount = (total: Counts, last?: Counts, window?: number, ts = T0) => ({
  timestamp: iso(ts),
  type: "event_msg",
  payload: {
    type: "token_count",
    info: { total_token_usage: total, ...(last ? { last_token_usage: last } : {}), ...(window !== undefined ? { model_context_window: window } : {}) },
  },
});

/** One fake `codex exec --json` run: thread.started, then one turn.completed per entry. */
async function runCodex(sessions: string, turns: Counts[], model = "asked-model") {
  const stateDir = tmp("cdx-ctx-state-");
  const child = new FakeChild();
  const driver = createDriver({ adapters: { codex: new CodexAdapter({ spawnFn: fakeSpawnFn(child) }) }, stateDir, registry: { stateDir }, codexSessionsRoot: sessions });
  const running = driver.run("codex", { prompt: "hi", model });
  setTimeout(() => {
    child.writeStdout(
      jsonl([{ type: "thread.started", thread_id: THREAD }, ...turns.flatMap((u) => [{ type: "turn.started" }, { type: "turn.completed", usage: u }])]),
    );
    child.close(0);
  }, 10);
  const result = await running;
  const [rec] = listRunRecords(stateDir);
  return { result, rec: rec! };
}

describe("codex rollout latest-call usage drives the context meter (#141 x #142)", () => {
  it("token_count with last_token_usage + model_context_window: last-call, reported window, real percentage", async () => {
    const sessions = tmp("cdx-ctx-sessions-");
    writeRollout(sessions, THREAD, [meta(THREAD), ctx(TURN1), taskStarted(TURN1), tokenCount(counts(500, 400, 20), counts(450, 400, 10), 1000)]);
    const { result, rec } = await runCodex(sessions, [counts(500, 400, 20)]);
    const c = result.usage?.context;
    // lastCall: input 450 incl. 400 cached -> 50 uncached + 400 cache read = 450 occupied of 1000.
    assert.equal(c?.available, true);
    assert.equal(c?.basis, "last-call");
    assert.equal(c?.windowSource, "reported");
    assert.equal(c?.windowTokens, 1000);
    assert.equal(c?.estimated, false);
    assert.equal(c?.tokens, 450);
    assert.equal(c?.percentage, 45);
    assert.equal(c?.cumulativeTokens, undefined, "a last-call reading carries no cumulative count");
    // Billed tokens are untouched: still exactly the stream's single turn.
    assert.equal(result.tokens.length, 1);
    assert.equal(result.tokens[0]!.inputTokens, 100);
    // Registry record, totals and the stats/summary surfaces all use the sealed reading.
    assert.equal(rec.usage?.context?.basis, "last-call");
    assert.equal(rec.usage?.context?.percentage, 45);
    assert.equal(rec.totals?.contextTokens, 450);
    const [row] = runContextRows([rec]);
    assert.equal(row?.contextPercentage, 45);
    assert.equal(row?.windowSource, "reported");
    assert.equal(formatContextCell(c!), "ctx ~= 450 tok (45.0%)");
  });

  it("a rollout without last-call data stays turn-total: n/a (cumulative), no percentage, no contextTokens", async () => {
    const sessions = tmp("cdx-ctx-sessions-");
    writeRollout(sessions, THREAD, [meta(THREAD), ctx(TURN1), taskStarted(TURN1), tokenCount(counts(500, 400, 20))]);
    const { result, rec } = await runCodex(sessions, [counts(500, 400, 20)]);
    const c = result.usage?.context;
    assert.equal(c?.basis, "turn-total");
    assert.equal(c?.percentage, undefined);
    assert.equal(c?.cumulativeTokens, 500);
    assert.equal(rec.totals?.contextTokens, undefined);
    assert.equal(formatContextCell(c!), "ctx n/a (cumulative 500 tok, not occupancy)");
    const [row] = runContextRows([rec]);
    assert.equal(row?.contextPercentage, null);
    assert.equal(row?.cumulativeTokens, 500);
  });

  it("compaction: the LATEST call wins, never the max over the run", async () => {
    const sessions = tmp("cdx-ctx-sessions-");
    writeRollout(sessions, THREAD, [
      meta(THREAD),
      ctx(TURN1),
      taskStarted(TURN1),
      tokenCount(counts(900, 800, 10), counts(900, 800, 10), 1000),
      ctx(TURN2, T0 + 900),
      taskStarted(TURN2, undefined, T0 + 900),
      tokenCount(counts(1200, 1000, 20), counts(300, 200, 10), 1000, T0 + 1000),
    ]);
    const { result, rec } = await runCodex(sessions, [counts(900, 800, 10), counts(300, 200, 10)]);
    assert.equal(result.usage?.context?.basis, "last-call");
    assert.equal(result.usage?.context?.tokens, 300);
    assert.equal(result.usage?.context?.percentage, 30);
    assert.equal(rec.totals?.contextTokens, 300);
    assert.ok(!result.warnings.some((w) => w.startsWith("context:")), "the earlier 90% call is not the run's reading");
  });

  it("a crossing latest call raises the one-time overflow warning", async () => {
    const sessions = tmp("cdx-ctx-sessions-");
    writeRollout(sessions, THREAD, [meta(THREAD), ctx(TURN1), taskStarted(TURN1), tokenCount(counts(950, 900, 5), counts(950, 900, 5), 1000)]);
    const { result } = await runCodex(sessions, [counts(950, 900, 5)]);
    assert.equal(result.usage?.context?.percentage, 95);
    assert.ok(result.warnings.some((w) => /^context: codex run crossed 85%/.test(w)), result.warnings.join("\n"));
  });

  it("task_started.model_context_window is the window fallback, labelled task_started; token_count's own window wins", async () => {
    const dir = tmp("cdx-ctx-parse-");
    writeRollout(dir, THREAD, [meta(THREAD), ctx(TURN1), taskStarted(TURN1, 2000), tokenCount(counts(500, 400, 20), counts(500, 400, 20))]);
    const [r] = await parseCodexRollout(join(dir, "2026", "09", "01", `rollout-2026-09-01T10-00-00-${THREAD}.jsonl`));
    const m = r!.extra!.codex as CodexRecordMeta;
    assert.equal(m.contextWindow, 2000);
    assert.equal(m.contextWindowSource, "task_started");

    const dir2 = tmp("cdx-ctx-parse-");
    writeRollout(dir2, THREAD, [meta(THREAD), ctx(TURN1), taskStarted(TURN1, 2000), tokenCount(counts(500, 400, 20), counts(500, 400, 20), 1000)]);
    const [r2] = await parseCodexRollout(join(dir2, "2026", "09", "01", `rollout-2026-09-01T10-00-00-${THREAD}.jsonl`));
    assert.equal((r2!.extra!.codex as CodexRecordMeta).contextWindowSource, "token_count");
    assert.equal((r2!.extra!.codex as CodexRecordMeta).contextWindow, 1000);

    // The driver reads it as a reported window: 500 occupied of 2000 = 25%.
    const { result } = await runCodex(dir, [counts(500, 400, 20)]);
    assert.equal(result.usage?.context?.windowSource, "reported");
    assert.equal(result.usage?.context?.windowTokens, 2000);
    assert.equal(result.usage?.context?.percentage, 25);
  });

  it("a resumed session: an earlier run's call is not this run's reading", async () => {
    const sessions = tmp("cdx-ctx-sessions-");
    writeRollout(sessions, THREAD, [
      meta(THREAD),
      ctx(TURN1),
      taskStarted(TURN1),
      tokenCount(counts(500, 400, 20), counts(500, 400, 20), 1000),
      ctx(TURN2, T0 + 900),
      taskStarted(TURN2, undefined, T0 + 900),
      { timestamp: iso(T0 + 1000), type: "event_msg", payload: { type: "token_count", info: { total_token_usage: counts(800, 600, 30) } } },
    ]);
    const { result } = await runCodex(sessions, [counts(300, 200, 10)]);
    assert.equal(result.usage?.context?.basis, "turn-total", "TURN1 belongs to an earlier run");
  });

  it("latestCodexCall picks the newest record with lastCall, optionally within the given turns", () => {
    const rec = (turnId: string, input: number) => ({
      agent: "codex", sessionId: THREAD, timestamp: iso(T0), model: "fixture-model",
      input, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0,
      extra: { codex: { format: "token_count", turnId, lastCall: { input, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0 } } },
    });
    const noCall = { ...rec("t3", 9), extra: { codex: { format: "token_count", turnId: "t3" } } };
    const records = [rec("t1", 1), rec("t2", 2), noCall];
    assert.equal(latestCodexCall(records as never)?.lastCall.input, 2);
    assert.equal(latestCodexCall(records as never, new Set(["t1"]))?.lastCall.input, 1);
    assert.equal(latestCodexCall(records as never, new Set(["t3"])), undefined);
  });
});
