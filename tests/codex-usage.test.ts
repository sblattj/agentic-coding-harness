// Codex observed model/effort (#140) and parent/child token accounting (#142).
// Every fixture here is synthetic: ids, models and counts are invented.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  codexSessionUsageFromRecords,
  parseCodexRollout,
  parseCodexRolloutSession,
  reconcileCodexSessions,
  type CodexRecordMeta,
} from "../src/monitors/transcripts.ts";
import { readCodexNativeUsage, requestedCodexEffort } from "../src/core/codex-native.ts";
import { computeUsageAvailability, liveUsageAvailability } from "../src/core/usage-availability.ts";
import { modelProvenanceText, usageScopeBadge } from "../src/core/usage-scope.ts";
import { formatSummary } from "../src/cli/lib.ts";
import { usageDetailLine } from "../src/cli/dash.ts";
import { createDriver } from "../src/core/driver.ts";
import { CodexAdapter, parseCodexLine } from "../src/adapters/codex.ts";
import { UsageAvailabilitySchema, type CanonicalTokenRecord, type UsageAvailability } from "../src/core/types.ts";
import { FakeChild, fakeSpawnFn } from "./helpers/fake-child.ts";

// UUIDv7-shaped ids (codex thread/turn ids are v7: the first 48 bits are ms).
const v7 = (ms: number, tail: string): string => {
  const hex = ms.toString(16).padStart(12, "0");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7${tail.slice(0, 3)}-8${tail.slice(3, 6)}-${tail.slice(6, 18).padEnd(12, "0")}`;
};
const T0 = Date.parse("2026-09-01T10:00:00.000Z");
const PARENT = v7(T0, "aaaaaa000000000001");
const CHILD_A = v7(T0 + 60_000, "bbbbbb000000000002");
const CHILD_B = v7(T0 + 120_000, "cccccc000000000003");
const iso = (ms: number): string => new Date(ms).toISOString();

const tmp = (prefix: string): string => mkdtempSync(join(tmpdir(), prefix));
const jsonl = (lines: unknown[]): string => lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
function writeRollout(dir: string, id: string, lines: unknown[]): string {
  const day = join(dir, "2026", "09", "01");
  mkdirSync(day, { recursive: true });
  const path = join(day, `rollout-2026-09-01T10-00-00-${id}.jsonl`);
  writeFileSync(path, jsonl(lines));
  return path;
}

const meta = (id: string, extra: Record<string, unknown> = {}, ts = T0) => ({
  timestamp: iso(ts),
  type: "session_meta",
  payload: { id, timestamp: iso(ts), cwd: "/work", ...extra },
});
const ctx = (turn: string, model: string | null, effort: string | null, ts = T0) => ({
  timestamp: iso(ts),
  type: "turn_context",
  payload: { turn_id: turn, model, effort },
});
const taskStarted = (turn: string, ts = T0) => ({ timestamp: iso(ts), type: "event_msg", payload: { type: "task_started", turn_id: turn } });
const counts = (input: number, cached: number, output: number, reasoning = 0) => ({
  input_tokens: input,
  cached_input_tokens: cached,
  output_tokens: output,
  reasoning_output_tokens: reasoning,
});
const tc = (total: ReturnType<typeof counts>, last: ReturnType<typeof counts>, window = 1000, ts = T0) => ({
  timestamp: iso(ts),
  type: "event_msg",
  payload: { type: "token_count", info: { total_token_usage: total, last_token_usage: last, model_context_window: window } },
});
const tur = (thread: string, turn: string, total: ReturnType<typeof counts>, call: ReturnType<typeof counts>, ts = T0) => ({
  timestamp: iso(ts),
  type: "token_usage_record",
  payload: { thread_id: thread, turn_id: turn, thread_token_usage: { thread_id: thread, ...total }, usage: call },
});
const spawned = (childId: string, path: string, kind = "started") => ({
  timestamp: iso(T0),
  type: "event_msg",
  payload: { type: "item_completed", item: { type: "SubAgentActivity", agent_thread_id: childId, agent_path: path, kind } },
});
const codexMeta = (r: { extra?: Record<string, unknown> }): CodexRecordMeta => r.extra?.codex as CodexRecordMeta;

// ---------------------------------------------------------------- #142 parsing

describe("parseCodexRollout: modern token_count (#142)", () => {
  it("the issue's two-line fixture yields one record with uncached input, lastCall and the native window", async () => {
    const dir = tmp("cdx142-issue-");
    const path = join(dir, "r.jsonl");
    writeFileSync(
      path,
      '{"type":"session_meta","payload":{"id":"fixture-session"}}\n' +
        '{"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":120,"cached_input_tokens":80,"output_tokens":10},"last_token_usage":{"input_tokens":60,"cached_input_tokens":40,"output_tokens":5},"model_context_window":1000}}}\n',
    );
    const records = await parseCodexRollout(path);
    assert.equal(records.length, 1);
    const [r] = records;
    assert.equal(r!.sessionId, "fixture-session");
    assert.deepEqual([r!.input, r!.cacheRead, r!.output, r!.reasoning], [40, 80, 10, 0]);
    assert.deepEqual(codexMeta(r!), {
      format: "token_count",
      lastCall: { input: 20, cacheRead: 40, cacheWrite: 0, output: 5, reasoning: 0 },
      contextWindow: 1000,
      contextWindowSource: "token_count",
    });
  });

  it("cumulative snapshots become deltas; a repeated snapshot is counted once", async () => {
    const dir = tmp("cdx142-delta-");
    const path = writeRollout(dir, PARENT, [
      meta(PARENT),
      tc(counts(100, 60, 10, 4), counts(100, 60, 10, 4)),
      tc(counts(100, 60, 10, 4), counts(100, 60, 10, 4)), // re-emitted snapshot
      tc(counts(250, 160, 30, 9), counts(150, 100, 20, 5)),
    ]);
    const s = await parseCodexRolloutSession(path);
    assert.equal(s.records.length, 2);
    assert.deepEqual(
      s.records.map((r) => [r.input, r.cacheRead, r.output, r.reasoning]),
      [
        [40, 60, 10, 4],
        [50, 100, 20, 5],
      ],
    );
    assert.equal(s.snapshots.repeated, 1);
    const sum = s.records.reduce((a, r) => a + r.input + r.cacheRead, 0);
    assert.equal(sum, 250, "uncached + cached = native total input, never more");
    // reasoning stays a subset of output: never added to it
    assert.equal(s.records.reduce((a, r) => a + r.output, 0), 30);
  });

  it("legacy + modern lines for the same calls are deduped; legacy counts, modern enriches", async () => {
    const dir = tmp("cdx142-dedupe-");
    const turn = v7(T0 + 1000, "dddddd000000000004");
    const path = writeRollout(dir, PARENT, [
      meta(PARENT),
      ctx(turn, "model-x", "medium"),
      tur(PARENT, turn, counts(100, 60, 10), counts(100, 60, 10)),
      tc(counts(100, 60, 10), counts(100, 60, 10), 4096),
      tur(PARENT, turn, counts(250, 160, 30), counts(150, 100, 20)),
      tc(counts(250, 160, 30), counts(150, 100, 20), 4096),
      // A compaction call lands in the legacy counter only; modern lags from here.
      tur(PARENT, turn, counts(300, 160, 35), counts(50, 0, 5)),
      tur(PARENT, turn, counts(400, 200, 40), counts(100, 40, 5)),
      tc(counts(350, 200, 35), counts(100, 40, 5), 4096),
    ]);
    const s = await parseCodexRolloutSession(path);
    assert.equal(s.records.length, 4, "one record per legacy snapshot, none for modern");
    const total = s.records.reduce((a, r) => ({ in: a.in + r.input + r.cacheRead, out: a.out + r.output }), { in: 0, out: 0 });
    assert.deepEqual(total, { in: 400, out: 40 }, "the final legacy total, counted exactly once");
    assert.ok(s.records.every((r) => codexMeta(r).format === "token_usage_record"));
    assert.equal(codexMeta(s.records[0]!).contextWindow, 4096, "modern line enriched the legacy record");
    assert.deepEqual(codexMeta(s.records[1]!).lastCall, { input: 50, cacheRead: 100, cacheWrite: 0, output: 20, reasoning: 0 });
  });
});

// ---------------------------------------------------------------- #140 parsing

describe("parseCodexRollout: observed model and effort (#140)", () => {
  it("multiple models and an effort change: each record carries its own turn's model/effort", async () => {
    const dir = tmp("cdx140-models-");
    const t1 = v7(T0 + 1000, "eeeeee000000000005");
    const t2 = v7(T0 + 2000, "ffffff000000000006");
    const path = writeRollout(dir, PARENT, [
      meta(PARENT),
      taskStarted(t1),
      ctx(t1, "model-a", "low"),
      tc(counts(100, 0, 10), counts(100, 0, 10)),
      taskStarted(t2),
      ctx(t2, "model-b", "high"),
      tc(counts(300, 100, 30), counts(200, 100, 20)),
    ]);
    const s = await parseCodexRolloutSession(path);
    assert.deepEqual(
      s.records.map((r) => [r.model, codexMeta(r).effort, codexMeta(r).modelSource, codexMeta(r).turnId]),
      [
        ["model-a", "low", "turn_context", t1],
        ["model-b", "high", "turn_context", t2],
      ],
    );
    assert.deepEqual(s.models, ["model-a", "model-b"]);
    assert.deepEqual(s.efforts, ["low", "high"]);
    assert.deepEqual(s.turns.map((t) => t.turnId), [t1, t2]);
  });

  it("legacy records find their model by turn_id, not by line order", async () => {
    const dir = tmp("cdx140-byturn-");
    const t1 = v7(T0 + 1000, "abcdef000000000007");
    const t2 = v7(T0 + 2000, "abcdef000000000008");
    const path = writeRollout(dir, PARENT, [
      meta(PARENT),
      ctx(t1, "model-a", "low"),
      ctx(t2, "model-b", "xhigh"),
      tur(PARENT, t1, counts(10, 0, 1), counts(10, 0, 1)),
    ]);
    const [r] = await parseCodexRollout(path);
    assert.equal(r!.model, "model-a");
    assert.equal(codexMeta(r!).effort, "low");
  });

  it("missing native metadata: no turn_context means model null and no modelSource (never a guess)", async () => {
    const dir = tmp("cdx140-missing-");
    const path = writeRollout(dir, PARENT, [meta(PARENT), tc(counts(10, 0, 1), counts(10, 0, 1))]);
    const [r] = await parseCodexRollout(path);
    assert.equal(r!.model, null);
    assert.equal(codexMeta(r!).modelSource, undefined);
    assert.equal(codexMeta(r!).effort, undefined);
  });
});

// ---------------------------------------------------------------- #142 parent/child

describe("codex parent/child sessions (#142)", () => {
  /** A spawned child that replays its parent's metadata first (subagent_history_start_ordinal). */
  function childLines(id: string, name: string, model: string, total: number) {
    const own = v7(T0 + 90_000, `${id.slice(0, 6)}000000000009`);
    return [
      meta(id, {
        parent_thread_id: PARENT,
        forked_from_id: PARENT,
        agent_path: `/root/${name}`,
        subagent_history_start_ordinal: 3,
        source: { subagent: { thread_spawn: { parent_thread_id: PARENT, depth: 1 } } },
      }),
      meta(PARENT), // replayed parent metadata
      taskStarted(v7(T0 + 500, "999999000000000010")),
      ctx(v7(T0 + 500, "999999000000000010"), "parent-model", "xhigh"), // replayed parent turn_context
      taskStarted(own),
      ctx(own, model, "medium"),
      // the child reports the parent's root in its own SubAgentActivity: not a child of the child
      spawned(PARENT, "/root", "interacted"),
      tur(id, own, counts(total, 0, 10), counts(total, 0, 10)),
      tc(counts(total, 0, 10), counts(total, 0, 10)),
    ];
  }
  function parentLines(children: Array<[string, string]>) {
    const turn = v7(T0 + 500, "999999000000000010");
    return [
      meta(PARENT, { source: "cli" }),
      taskStarted(turn),
      ctx(turn, "parent-model", "xhigh"),
      ...children.map(([id, name]) => spawned(id, `/root/${name}`)),
      tur(PARENT, turn, counts(1000, 400, 50), counts(1000, 400, 50)),
      tc(counts(1000, 400, 50), counts(1000, 400, 50)),
    ];
  }

  it("repeated parent metadata in a child file never takes over its identity or model", async () => {
    const dir = tmp("cdx142-replay-");
    const path = writeRollout(dir, CHILD_A, childLines(CHILD_A, "alpha", "child-model", 200));
    const s = await parseCodexRolloutSession(path);
    assert.equal(s.sessionId, CHILD_A);
    assert.equal(s.parentSessionId, PARENT);
    assert.equal(s.depth, 1);
    assert.deepEqual(s.models, ["child-model"], "replayed parent turn_context is not observed here");
    assert.deepEqual(s.childSessionIds, [], "the parent named in the child's activity is not its child");
    assert.equal(s.records.length, 1);
    assert.equal(s.records[0]!.sessionId, CHILD_A);
    assert.equal(codexMeta(s.records[0]!).parentSessionId, PARENT);
  });

  it("a fork's replayed cumulative snapshots seed the baseline and are never counted", async () => {
    const dir = tmp("cdx142-fork-");
    const forkCreated = T0 + 600_000;
    const oldTurn = v7(T0 + 1000, "121212000000000011");
    const ownTurn = v7(forkCreated + 5000, "343434000000000012");
    const id = v7(forkCreated, "565656000000000013");
    const path = writeRollout(dir, id, [
      meta(id, { forked_from_id: PARENT }, forkCreated),
      meta(PARENT),
      taskStarted(oldTurn, forkCreated),
      ctx(oldTurn, "parent-model", null, forkCreated),
      tc(counts(5000, 4000, 100), counts(5000, 4000, 100), 1000, forkCreated),
      tc(counts(9000, 7000, 200), counts(4000, 3000, 100), 1000, forkCreated),
      taskStarted(ownTurn, forkCreated + 5000),
      ctx(ownTurn, "fork-model", "low", forkCreated + 5000),
      tc(counts(9300, 7100, 210), counts(300, 100, 10), 1000, forkCreated + 6000),
    ]);
    const s = await parseCodexRolloutSession(path);
    assert.equal(s.records.length, 1);
    const r = s.records[0]!;
    assert.deepEqual([r.input, r.cacheRead, r.output], [200, 100, 10], "only the fork's own call");
    assert.equal(r.model, "fork-model");
    assert.equal(s.sessionId, id);
  });

  it("two child sessions: the tree is child-inclusive and complete, each session counted once", async () => {
    const dir = tmp("cdx142-two-");
    const paths = [
      writeRollout(dir, PARENT, parentLines([[CHILD_A, "alpha"], [CHILD_B, "beta"]])),
      writeRollout(dir, CHILD_A, childLines(CHILD_A, "alpha", "child-model", 200)),
      writeRollout(dir, CHILD_B, childLines(CHILD_B, "beta", "child-model", 300)),
    ];
    const records = (await Promise.all(paths.map((p) => parseCodexRollout(p)))).flat();
    const acc = reconcileCodexSessions(codexSessionUsageFromRecords(records));
    assert.equal(acc.roots.length, 1);
    const [root] = acc.roots;
    assert.equal(root!.rootSessionId, PARENT);
    assert.equal(root!.scope, "child-inclusive");
    assert.equal(root!.complete, true);
    assert.deepEqual(root!.countedChildSessionIds.sort(), [CHILD_A, CHILD_B].sort());
    assert.deepEqual(root!.missingChildSessionIds, []);
    // parent 600 uncached + 400 cached, children 200 + 300 uncached: each once
    assert.deepEqual([root!.tokens.input, root!.tokens.cacheRead, root!.tokens.output], [600 + 200 + 300, 400, 50 + 10 + 10]);
  });

  it("missing child records: listed as missing, never zero-filled, and the tree is partial", async () => {
    const dir = tmp("cdx142-missing-");
    const paths = [
      writeRollout(dir, PARENT, parentLines([[CHILD_A, "alpha"], [CHILD_B, "beta"]])),
      writeRollout(dir, CHILD_A, childLines(CHILD_A, "alpha", "child-model", 200)),
    ];
    const records = (await Promise.all(paths.map((p) => parseCodexRollout(p)))).flat();
    const acc = reconcileCodexSessions(codexSessionUsageFromRecords(records));
    const [root] = acc.roots;
    assert.equal(root!.complete, false);
    assert.equal(root!.scope, "child-inclusive");
    assert.deepEqual(root!.missingChildSessionIds, [CHILD_B]);
    assert.deepEqual(acc.summary, {
      roots: 1,
      complete: 0,
      partial: 1,
      scopes: { session: 0, "parent-only": 0, "child-inclusive": 1 },
      childSessions: 2,
      countedChildSessions: 1,
      missingChildSessions: 1,
      missingRootSessions: 0,
    });
  });

  it("a child whose parent was not found makes the tree partial (parent usage unknown)", () => {
    const acc = reconcileCodexSessions([
      { sessionId: CHILD_A, parentSessionId: PARENT, tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, reasoning: 0 }, records: 1 },
    ]);
    assert.equal(acc.roots[0]!.rootSessionId, PARENT);
    assert.equal(acc.roots[0]!.rootFound, false);
    assert.equal(acc.roots[0]!.complete, false);
    assert.equal(acc.summary.missingRootSessions, 1);
  });
});

// ---------------------------------------------------------------- run-level evidence

describe("readCodexNativeUsage: requested vs observed (#140) and run completeness (#142)", () => {
  const rec = (model?: string): CanonicalTokenRecord => ({
    agent: "codex",
    ...(model !== undefined ? { model } : {}),
    inputTokens: 600,
    outputTokens: 50,
    cacheReadTokens: 400,
    cacheWriteTokens: 0,
  });

  it("observed model backfills 'unknown' records, a requested mismatch is flagged, children make it parent-only", async () => {
    const dir = tmp("cdx-native-");
    writeRollout(dir, PARENT, [
      meta(PARENT, { source: "exec" }),
      ctx(v7(T0 + 500, "999999000000000010"), "observed-model", "high"),
      spawned(CHILD_A, "/root/alpha"),
      spawned(CHILD_B, "/root/beta"),
      tur(PARENT, v7(T0 + 500, "999999000000000010"), counts(1000, 400, 50), counts(1000, 400, 50)),
    ]);
    writeRollout(dir, CHILD_A, [meta(CHILD_A, { parent_thread_id: PARENT, agent_path: "/root/alpha" }), tc(counts(200, 0, 10), counts(200, 0, 10))]);
    const tokens = [rec("unknown")];
    const out = await readCodexNativeUsage({ sessionId: PARENT, tokens, requestedModel: "asked-model", requestedEffort: "low", sessionsRoot: dir });
    assert.equal(tokens[0]!.model, "observed-model");
    assert.equal(tokens[0]!.extra?.modelSource, "observed");
    assert.equal(tokens[0]!.extra?.observedEffort, "high");
    assert.deepEqual(out.model, {
      source: "native",
      requested: "asked-model",
      requestedEffort: "low",
      observedSource: "rollout",
      observed: ["observed-model"],
      observedEffort: ["high"],
      mismatch: true,
      effortMismatch: true,
    });
    assert.ok(out.warnings.some((w) => w === "codex: requested model 'asked-model' but the native rollout recorded 'observed-model'"), out.warnings.join("\n"));
    assert.equal(out.tokens.coverage, "parent-only");
    assert.equal(out.tokens.complete, false);
    assert.deepEqual(out.tokens.missingChildSessionIds, [CHILD_B]);
    assert.deepEqual(out.tokens.childInclusive, {
      inputTokens: 800,
      outputTokens: 60,
      cacheReadTokens: 400,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      complete: false,
      countedChildSessions: 1,
    });
  });

  it("no children and stream totals equal the rollout's: complete, session scope", async () => {
    const dir = tmp("cdx-native-complete-");
    const turn = v7(T0 + 500, "999999000000000010");
    writeRollout(dir, PARENT, [meta(PARENT), ctx(turn, "m", null), tur(PARENT, turn, counts(1000, 400, 50), counts(1000, 400, 50))]);
    const out = await readCodexNativeUsage({ sessionId: PARENT, tokens: [rec()], sessionsRoot: dir });
    assert.deepEqual(out.tokens, { coverage: "session", complete: true });
    assert.equal(out.model.mismatch, undefined);
  });

  it("missing native metadata: no rollout keeps the model labelled REQUESTED and the record unverified", async () => {
    const dir = tmp("cdx-native-none-");
    const tokens = [rec("unknown")];
    const out = await readCodexNativeUsage({ sessionId: PARENT, tokens, requestedModel: "asked-model", sessionsRoot: dir });
    assert.equal(tokens[0]!.model, "unknown", "no evidence: the unknown stays unknown (its pricing warning stays valid)");
    assert.deepEqual(out.model, { source: "requested", requested: "asked-model" });
    assert.equal(out.tokens.complete, false);
    assert.match(out.warnings[0]!, /'asked-model' is the REQUESTED model, not verified/);
    assert.equal(modelProvenanceText(out.model), "requested asked-model (unverified: not observed)");
  });

  it("requestedCodexEffort reads -c model_reasoning_effort=… (last wins)", () => {
    assert.equal(requestedCodexEffort(["-c", "model_reasoning_effort=low", "--config=model_reasoning_effort=\"high\""]), "high");
    assert.equal(requestedCodexEffort(["-c", "sandbox_mode=workspace-write"]), undefined);
  });
});

describe("driver: codex run carries observed model + scope into RunResult and the registry", () => {
  it("backfills the observed model, labels requested vs observed, and states parent-only scope", async () => {
    const sessions = tmp("cdx-driver-sessions-");
    const stateDir = tmp("cdx-driver-state-");
    const turn = v7(T0 + 500, "999999000000000010");
    writeRollout(sessions, PARENT, [
      meta(PARENT, { source: "exec" }),
      ctx(turn, "observed-model", "medium"),
      spawned(CHILD_A, "/root/alpha"),
      tur(PARENT, turn, counts(120, 80, 10), counts(120, 80, 10)),
    ]);
    const child = new FakeChild();
    const adapter = new CodexAdapter({ spawnFn: fakeSpawnFn(child) });
    const driver = createDriver({ adapters: { codex: adapter }, stateDir, registry: { stateDir }, codexSessionsRoot: sessions });
    const running = driver.run("codex", { prompt: "hi", model: "asked-model" });
    setTimeout(() => {
      child.writeStdout(
        jsonl([
          { type: "thread.started", thread_id: PARENT },
          { type: "turn.started" },
          { type: "turn.completed", usage: { input_tokens: 120, cached_input_tokens: 80, output_tokens: 10 } },
        ]),
      );
      child.close(0);
    }, 10);
    const result = await running;
    assert.equal(result.tokens[0]!.model, "observed-model");
    assert.equal(result.usage?.model?.source, "native");
    assert.equal(result.usage?.model?.requested, "asked-model");
    assert.deepEqual(result.usage?.model?.observed, ["observed-model"]);
    assert.equal(result.usage?.tokens.coverage, "parent-only");
    assert.equal(result.usage?.tokens.complete, false);
    assert.deepEqual(result.usage?.tokens.missingChildSessionIds, [CHILD_A]);
    assert.ok(result.warnings.some((w) => w.startsWith("codex: requested model 'asked-model'")), result.warnings.join("\n"));
    assert.ok(UsageAvailabilitySchema.safeParse(result.usage).success, "the schema keeps the new fields");
    const { listRunRecords } = await import("../src/core/registry.ts");
    const [rr] = listRunRecords(stateDir);
    assert.equal(rr?.usage?.model?.observed?.[0], "observed-model", "registry mirrors the verdict");
    assert.equal(rr?.usage?.tokens.coverage, "parent-only");
    const line = usageDetailLine(rr!);
    assert.match(line!, /partial · parent-only \(1 child session, 1 missing\) · model observed observed-model effort medium \(requested asked-model, MISMATCH\)/);
  });
});

// ---------------------------------------------------------------- rendering

describe("usage scope rendering (#142)", () => {
  it("the issue's tap verdict renders as partial, not as a complete total", () => {
    const { usage } = computeUsageAvailability({
      agent: "codex",
      tokens: parseCodexLine(
        JSON.stringify({ type: "turn.completed", usage: { input_tokens: 120, cached_input_tokens: 80, output_tokens: 10 } }),
      ).flatMap((e) => (e.type === "usage" ? [{ agent: "codex", ...e.tokens }] : [])) as CanonicalTokenRecord[],
      totalCost: 0,
      pricerPriced: false,
    });
    assert.deepEqual(usage.tokens, { available: true, source: "tap", scope: "call", cumulative: false, complete: false });
    assert.equal(usageScopeBadge(usage)?.text, "partial · completeness not established");
  });

  it("before any usage arrives a live record says unavailable (n/a), never 0", () => {
    const live = liveUsageAvailability([], false, 0);
    assert.deepEqual(live.tokens, { available: false });
    assert.deepEqual(live.usd, { available: false });
    const later = liveUsageAvailability([{ inputTokens: 5, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }], true, 0.01);
    assert.equal(later.tokens.available, true);
    assert.equal(later.tokens.complete, false);
  });

  it("formatSummary prints the scope badge, child-inclusive totals and model provenance", () => {
    const usage: UsageAvailability = {
      tokens: {
        available: true,
        complete: false,
        coverage: "parent-only",
        childSessionIds: [CHILD_A, CHILD_B],
        missingChildSessionIds: [CHILD_B],
        incompleteReasons: ["run totals are parent-only"],
        childInclusive: { inputTokens: 800, outputTokens: 60, cacheReadTokens: 400, cacheWriteTokens: 0, complete: false, countedChildSessions: 1 },
      },
      credits: { available: false },
      usd: { available: false },
      model: { source: "native", requested: "a", observed: ["b"], mismatch: true },
    };
    const out = formatSummary({
      agent: "codex",
      sessionId: PARENT,
      tokens: { input: 600, output: 50, cacheRead: 400, cacheWrite: 0, reasoning: 0 },
      costUsd: 0,
      durationMs: 1,
      exitStatus: "success",
      usage,
    });
    assert.match(out, /usage {6}partial · parent-only \(2 child sessions, 1 missing\) — run totals are parent-only/);
    assert.match(out, /with kids  input=800 output=60 cacheRead=400 cacheWrite=0 \(child-inclusive, partial, 1 child session counted\)/);
    assert.match(out, /model {6}observed b \(requested a, MISMATCH\)/);
  });

  it("a verdict without the new fields renders no badge (older records unchanged)", () => {
    assert.equal(usageScopeBadge({ tokens: { available: true }, credits: { available: false }, usd: { available: false } }), undefined);
    assert.equal(usageScopeBadge({ tokens: { available: false }, credits: { available: false }, usd: { available: false } }), undefined);
    assert.equal(modelProvenanceText(undefined), undefined);
  });
});

describe("report + web surfaces (#140/#142)", () => {
  const usage: UsageAvailability = {
    tokens: { available: true, complete: false, coverage: "parent-only", childSessionIds: [CHILD_A], missingChildSessionIds: [CHILD_A], incompleteReasons: ["why"] },
    credits: { available: false },
    usd: { available: false },
    model: { source: "requested", requested: "asked-model" },
  };

  it("ach report shows a token-scope column and model provenance", async () => {
    const { renderReport } = await import("../src/report/html.ts");
    const { loadTrials } = await import("../src/report/model.ts");
    const dir = tmp("cdx-report-");
    mkdirSync(join(dir, "20260901-100000"), { recursive: true });
    writeFileSync(
      join(dir, "20260901-100000", "codex.json"),
      JSON.stringify({ runId: "r", sessionId: PARENT, events: [], tokens: [{ agent: "codex", model: "unknown", inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }], totalCost: 0, durationMs: 1, exitStatus: "success", warnings: [], usage }),
    );
    const html = renderReport(await loadTrials(dir), { version: "test", generatedAt: new Date(0) });
    assert.match(html, /<th data-k="usagescope" data-t="s">token scope<\/th>/);
    assert.match(html, /class="scope-partial" title="why">partial · parent-only \(1 child session, 1 missing\)<\/td>/);
    assert.match(html, /model provenance requested asked-model \(unverified: not observed\)/);
  });

  it("ach web metadata strip: n/a tokens before usage, then the scope badge and model provenance", async () => {
    const { readFileSync } = await import("node:fs");
    const { runInNewContext } = await import("node:vm");
    const html = readFileSync(new URL("../src/web/index.html", import.meta.url), "utf8");
    const renderer = html.slice(html.indexOf("function renderMeta()"), html.indexOf("/* ===== feed pane ===== */"));
    interface El { textContent: string; className: string; title: string; children: El[]; appendChild(e: El): void }
    const el = (_tag: string, cls: string, text = ""): El => ({ textContent: text, className: cls, title: "", children: [], appendChild(e) { this.children.push(e); } });
    const text = (e: El): string => e.textContent + " " + e.children.map(text).join(" ");
    const render = (r: Record<string, unknown>): string => {
      const box = el("div", "");
      runInNewContext(renderer + "\nrenderMeta();", {
        $: () => box, el, findRun: () => r, selectedId: "run", modelCache: {}, modelCachePending: { run: true },
        runCost: () => null, fmtTok: String, fmtCost: String, provMark: () => "", fmtCtx: () => "", fmtAgo: () => "", GLYPH: {},
      });
      return text(box);
    };
    const pending = render({ runId: "run", agent: "codex", startedAt: 1, status: "running", totals: { inputTokens: 0, outputTokens: 0 }, usage: liveUsageAvailability([], false, 0) });
    assert.match(pending, /in\s+n\/a/);
    assert.doesNotMatch(pending, /in\s+0 /);
    const done = render({ runId: "run", agent: "codex", startedAt: 1, totals: { inputTokens: 5, outputTokens: 1 }, usage });
    assert.match(done, /usage\s+partial · parent-only \(1 child session, 1 missing\)/);
    assert.match(done, /model\s+requested asked-model \(unverified: not observed\)/);
  });
});
