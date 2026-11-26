// Issue #87: context composition breakdown per run.
//
// The derivation (src/core/context-composition.ts) runs in-process on
// hand-sized fixtures whose expected numbers are computed by hand below, so a
// wrong split, a wrong boundary or a fabricated share fails on a number, not
// on a tautology. `ach context` runs as a real subprocess over a seeded state
// dir; the /trio card runs from the shipped trio.html block in a vm, fed by
// the same /observability payload the server builds (and, with bun on PATH,
// by the live route).
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createContext, runInContext } from "node:vm";
import { after, before, describe, it } from "node:test";

import {
  CONTEXT_COMPOSITION_TOLERANCE,
  compositionInput,
  deriveContextComposition,
  type ContextComposition,
} from "../src/core/context-composition.ts";
import { writeRunRecord, type RunRecord } from "../src/core/registry.ts";
import type { AgentEvent, CanonicalTokenRecord } from "../src/core/types.ts";
import { deriveRunObservability } from "../src/web/derive.ts";

const CLI = new URL("../src/cli/ach.ts", import.meta.url).pathname;
const RUNNER = new URL("./helpers/web-server-runner.ts", import.meta.url).pathname;
const TRIO = readFileSync(new URL("../src/web/trio.html", import.meta.url), "utf8");
const hasBun = spawnSync("bun", ["--version"], { encoding: "utf8" }).status === 0;
const T0 = 1_700_000_000_000;

const x = (n: number): string => "x".repeat(n);
const usage = (input: number, cacheRead: number): CanonicalTokenRecord => ({
  agent: "claude",
  model: "claude-sonnet-4-5",
  inputTokens: input,
  outputTokens: 50,
  cacheReadTokens: cacheRead,
  cacheWriteTokens: 0,
});

/**
 * Hand-sized claude-shaped run. Chars and their tokens (chars / 4, ceil):
 *   user message      400 chars            -> prompt        100
 *   assistant text    800 chars            -> assistantText 200
 *   Read call args    {"path":"a.ts"}  15  \
 *   Bash call args    "ls"               2  > toolCalls ceil(17/4) = 5
 *   Read result       4000 chars           \
 *   Bash result       400 chars            > toolResults ceil(4400/4) = 1100
 * The last assistant message carries the latest call's usage (500 + 2000 =
 * 2500 occupancy) and its own text ("done", plus a later Grep call) is that
 * call's OUTPUT, so it must not be counted.
 */
const EVENTS: AgentEvent[] = [
  { type: "session_start", agent: "claude", model: "claude-sonnet-4-5", timestamp: T0 },
  { type: "message", source: "user", content: x(400), timestamp: T0 + 1 },
  { type: "message", source: "agent", content: x(300), usage: usage(100, 0), timestamp: T0 + 2 },
  { type: "tool_call", toolCallId: "t1", functionName: "Read", arguments: { path: "a.ts" }, timestamp: T0 + 3 },
  { type: "tool_result", toolCallId: "t1", content: x(4000), timestamp: T0 + 4 },
  { type: "message", source: "agent", content: x(500), timestamp: T0 + 5 },
  { type: "tool_call", toolCallId: "t2", functionName: "Bash", arguments: "ls", timestamp: T0 + 6 },
  { type: "tool_result", toolCallId: "t2", content: x(400), timestamp: T0 + 7 },
  { type: "message", source: "agent", content: "done", usage: usage(500, 2000), timestamp: T0 + 8 },
  { type: "tool_call", toolCallId: "t3", functionName: "Grep", arguments: x(4000), timestamp: T0 + 9 },
  { type: "done", exitStatus: "success", timestamp: T0 + 10 },
];

function rec(over: Partial<RunRecord> = {}): RunRecord {
  return {
    runId: "run-ctx-1",
    agent: "claude",
    pid: process.pid,
    cwd: "/tmp/proj",
    startedAt: T0,
    updatedAt: T0,
    status: "success",
    exitStatus: "success",
    totals: { inputTokens: 600, outputTokens: 100, cacheReadTokens: 2000, cacheWriteTokens: 0, costUsd: 0.01, contextTokens: 2500 },
    usage: {
      tokens: { available: true },
      credits: { available: false },
      usd: { available: false },
      context: { available: true, source: "derived", tokens: 2500, windowTokens: 200_000, windowSource: "assumed", basis: "last-call", estimated: true },
    },
    ...over,
  } as RunRecord;
}

const comp = (c: ContextComposition, key: string) => c.components.find((k) => k.key === key)!;

describe("context composition derivation (#87)", () => {
  it("parts of a fixture run sum to the recorded context total, each part at its hand-computed size", () => {
    const c = deriveContextComposition(EVENTS, compositionInput(rec()));
    assert.deepEqual(c.total, { tokens: 2500, source: "record" });
    assert.equal(comp(c, "prompt").tokens, 100);
    assert.equal(comp(c, "assistantText").tokens, 200, "the latest call's own output text is excluded");
    assert.equal(comp(c, "toolCalls").tokens, 5, "the Grep call after the latest reading is excluded");
    assert.equal(comp(c, "toolResults").tokens, 1100);
    assert.equal(c.attributedTokens, 1405);
    assert.equal(comp(c, "unattributed").tokens, 2500 - 1405);
    assert.equal(comp(c, "unattributed").estimated, false);
    assert.equal(c.sumTokens, 2500, "parts sum to the recorded total");
    assert.equal(c.overshoot, 0);
    assert.equal(c.withinTolerance, true);
    assert.equal(c.denominator, "context-total");
    assert.equal(comp(c, "toolResults").share, 1100 / 2500);
    const shareSum = c.components.reduce((a, k) => a + (k.share ?? 0), 0);
    assert.ok(Math.abs(shareSum - 1) < 1e-9, `shares must sum to 1, got ${shareSum}`);
    assert.equal(c.eventsCounted, 8);
    assert.equal(c.eventsTotal, EVENTS.length);
  });

  it("re-derives the total from the events with the context meter when the record carries none", () => {
    const c = deriveContextComposition(EVENTS, { agent: "claude" });
    assert.deepEqual(c.total, { tokens: 2500, source: "events" });
    assert.equal(c.sumTokens, 2500);
  });

  it("estimates past the total: unattributed is n/a (never negative), and the tolerance verdict is stated", () => {
    // attributed 1405 here; totals around it pick each side of the tolerance.
    const inside = deriveContextComposition(EVENTS, { agent: "claude", contextTokens: 1300 });
    assert.equal(comp(inside, "unattributed").tokens, null);
    assert.match(comp(inside, "unattributed").reason!, /inside the 10% estimate tolerance/);
    assert.ok(Math.abs(inside.overshoot! - (1405 - 1300) / 1300) < 1e-12);
    assert.equal(inside.withinTolerance, true);
    assert.equal(inside.sumTokens, 1405);
    const outside = deriveContextComposition(EVENTS, { agent: "claude", contextTokens: 1000 });
    assert.equal(comp(outside, "unattributed").tokens, null);
    assert.equal(outside.withinTolerance, false);
    assert.ok(outside.overshoot! > CONTEXT_COMPOSITION_TOLERANCE);
  });

  it("the per-tool table puts the dominant tool first even when another tool has more calls", () => {
    const events: AgentEvent[] = [
      ...[1, 2, 3, 4].map((i): AgentEvent => ({ type: "tool_call", toolCallId: `b${i}`, functionName: "Bash", arguments: "ls", timestamp: T0 + i })),
      ...[1, 2, 3, 4].map((i): AgentEvent => ({ type: "tool_result", toolCallId: `b${i}`, content: x(40), timestamp: T0 + 10 + i })),
      { type: "tool_call", toolCallId: "r1", functionName: "Read", arguments: { path: "big.ts" }, timestamp: T0 + 20 },
      { type: "tool_result", toolCallId: "r1", content: x(20_000), timestamp: T0 + 21 },
      // adapter-lane tool events (named on both phases) and an id-less pair
      { type: "tool", toolName: "WebFetch", phase: "start", input: { url: "u" }, timestamp: T0 + 22 },
      { type: "tool", toolName: "WebFetch", phase: "result", output: x(2_000), timestamp: T0 + 23 },
      { type: "tool_call", toolCallId: "", functionName: "Glob", arguments: "*", timestamp: T0 + 24 },
      { type: "tool_result", toolCallId: "", content: x(80), timestamp: T0 + 25 },
      { type: "tool_result", toolCallId: "orphan", content: x(8), timestamp: T0 + 26 },
      { type: "message", source: "agent", content: "ok", usage: usage(9_000, 0), timestamp: T0 + 30 },
    ];
    const c = deriveContextComposition(events, { agent: "claude" });
    assert.deepEqual(
      c.tools.map((t) => t.name),
      ["Read", "WebFetch", "Bash", "Glob", "unknown"],
    );
    const read = c.tools[0]!;
    assert.equal(read.resultTokens, 5_000);
    assert.equal(read.calls, 1);
    assert.equal(c.tools.find((t) => t.name === "Bash")!.calls, 4);
    assert.equal(c.tools.find((t) => t.name === "Glob")!.resultTokens, 20, "id-less result joins the id-less call");
    assert.equal(c.tools.find((t) => t.name === "unknown")!.results, 1, "an unmatched result is bucketed, not dropped");
    assert.equal(read.share, read.tokens! / 9_000);
  });

  it("a claude run (no reasoning split, no user message) renders reasoning and prompt n/a, never 0", () => {
    const events = EVENTS.filter((e) => !(e.type === "message" && e.source === "user"));
    const c = deriveContextComposition(events, compositionInput(rec()));
    for (const key of ["reasoning", "prompt"]) {
      assert.equal(comp(c, key).tokens, null, `${key} must be n/a`);
      assert.equal(comp(c, key).share, null, `${key} must have no share`);
      assert.ok(comp(c, key).reason, `${key} must say why`);
    }
    assert.equal(comp(c, "unattributed").tokens, 2500 - 1305, "the n/a parts stay in the unattributed remainder");
  });

  it("an adapter that records reasoning gets a measured reasoning share", () => {
    const events: AgentEvent[] = [
      { type: "message", source: "agent", content: x(1200), reasoning: true, timestamp: T0 },
      { type: "message", source: "agent", content: x(400), reasoningContent: x(400), timestamp: T0 + 1 },
      { type: "message", source: "agent", content: "ok", usage: { ...usage(1000, 0), agent: "opencode", model: "gpt-5" }, timestamp: T0 + 2 },
    ];
    const c = deriveContextComposition(events, { agent: "opencode" });
    assert.equal(comp(c, "reasoning").tokens, 400);
    assert.equal(comp(c, "assistantText").tokens, 100);
    assert.equal(comp(c, "reasoning").share, 0.4);
  });

  it("below full content capture every text component is n/a; with turn-total usage the total is n/a", () => {
    const stripped = deriveContextComposition(EVENTS, compositionInput(rec({ captureMode: "metadata" })));
    for (const k of stripped.components) assert.equal(k.tokens, null, `${k.key} must be n/a under metadata capture`);
    assert.match(comp(stripped, "toolResults").reason!, /capture mode metadata/);
    assert.equal(stripped.tools[0]!.tokens, null);
    const markers = EVENTS.map((e) => (e.type === "tool_result" ? { ...e, content: "[STRIPPED]" } : e));
    assert.equal(comp(deriveContextComposition(markers, { agent: "claude" }), "toolResults").tokens, null, "a [STRIPPED] marker has no size");

    const turn = rec();
    turn.usage!.context = { available: true, source: "derived", tokens: 9000, cumulativeTokens: 9000, basis: "turn-total", estimated: true };
    delete turn.totals!.contextTokens;
    const codexish = EVENTS.filter((e) => !("usage" in e)).concat([{ type: "usage", usage: usage(4000, 5000), timestamp: T0 + 20 }]);
    const c = deriveContextComposition(codexish, compositionInput({ ...turn, agent: "codex" }));
    assert.equal(c.total.tokens, null);
    assert.match(c.total.reason!, /turn-total/);
    assert.equal(comp(c, "unattributed").tokens, null);
    assert.equal(c.denominator, "attributed");
    assert.equal(c.withinTolerance, null);
  });

  it("counts explicit compaction markers and only what follows the last one; n/a when none is recorded", () => {
    assert.equal(deriveContextComposition(EVENTS, { agent: "claude" }).compactions.count, null);
    const events: AgentEvent[] = [
      { type: "tool_call", toolCallId: "a", functionName: "Read", arguments: "", timestamp: T0 },
      { type: "tool_result", toolCallId: "a", content: x(40_000), timestamp: T0 + 1 },
      { type: "step", data: { subtype: "compact_boundary" }, timestamp: T0 + 2 },
      { type: "message", source: "agent", content: x(400), timestamp: T0 + 3 },
      { type: "message", source: "agent", content: "ok", usage: usage(300, 0), timestamp: T0 + 4 },
    ];
    const c = deriveContextComposition(events, { agent: "claude" });
    assert.equal(c.compactions.count, 1);
    assert.equal(comp(c, "toolResults").tokens, null, "pre-compaction tool output is not in the window");
    assert.equal(comp(c, "assistantText").tokens, 100);
    assert.equal(comp(c, "unattributed").tokens, 200);
  });
});

// ------------------------------------------------------------------ CLI

function runCli(args: string[], env: Record<string, string> = {}): { code: number; stdout: string; stderr: string } {
  const isBun = (process.versions as { bun?: string }).bun !== undefined;
  const p = spawnSync(process.execPath, isBun ? [CLI, ...args] : ["--import", "tsx", CLI, ...args], {
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
  return { code: p.status ?? -1, stdout: p.stdout ?? "", stderr: p.stderr ?? "" };
}

function seedState(record: RunRecord, events: AgentEvent[]): string {
  const state = mkdtempSync(join(tmpdir(), "ach-ctx-"));
  mkdirSync(join(state, "raw"), { recursive: true });
  const raw = join(state, "raw", "claude-ctx.jsonl");
  writeFileSync(raw, events.map((e) => JSON.stringify(e)).join("\n") + "\n");
  writeRunRecord(state, { ...record, rawTranscript: raw });
  return state;
}

describe("ach context <runId> (#87)", () => {
  const states: string[] = [];
  after(() => {
    for (const s of states.splice(0)) rmSync(s, { recursive: true, force: true });
  });

  it("prints the component table, the per-tool rows and a sum line that matches the recorded total", () => {
    const state = seedState(rec(), EVENTS);
    states.push(state);
    const r = runCli(["context", "run-ctx-1", "--state-dir", state]);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /context\s+2,500 tok \(latest model call, recorded\)/);
    assert.match(r.stdout, /prompt \/ user\s+100\s+4\.0%/);
    assert.match(r.stdout, /assistant text\s+200\s+8\.0%/);
    assert.match(r.stdout, /reasoning\s+n\/a\s+n\/a\s+\(this adapter records no reasoning text\)/);
    assert.match(r.stdout, /tool results\s+1,100\s+44\.0%/);
    assert.match(r.stdout, /unattributed\s+1,095\s+43\.8%/);
    assert.match(r.stdout, /sum\s+2,500 of 2,500 tok \(parts sum to the total\)/);
    const tools = r.stdout.slice(r.stdout.indexOf("tools (top"));
    assert.match(tools, /^tools \(top 2 of 2 by context share\)\ntool\s+calls[^\n]*\nRead\s+1\s+1,004/m);
    assert.match(r.stdout, /compactions n\/a/);
    assert.doesNotMatch(r.stdout, /x{20}/, "no content reaches the output");
  });

  it("--json emits the component map, and an unknown run or missing log is a clear error", () => {
    const state = seedState(rec(), EVENTS);
    states.push(state);
    const r = runCli(["context", "run-ctx-1", "--json", "--state-dir", state]);
    assert.equal(r.code, 0, r.stderr);
    const j = JSON.parse(r.stdout) as ContextComposition & { runId: string };
    assert.equal(j.runId, "run-ctx-1");
    assert.equal(j.sumTokens, j.total.tokens);
    assert.equal(j.components.find((k) => k.key === "reasoning")!.tokens, null);
    assert.equal(j.tools[0]!.name, "Read");

    const missing = runCli(["context", "no-such-run", "--state-dir", state]);
    assert.notEqual(missing.code, 0);
    assert.match(missing.stderr, /no run 'no-such-run'/);
    const noLog = mkdtempSync(join(tmpdir(), "ach-ctx-nolog-"));
    states.push(noLog);
    writeRunRecord(noLog, rec({ rawTranscript: join(noLog, "raw", "gone.jsonl") }));
    const gone = runCli(["context", "run-ctx-1", "--state-dir", noLog]);
    assert.notEqual(gone.code, 0);
    assert.match(gone.stderr, /has no stored event log/);
  });

  it("a resumed session sharing one transcript: each run counts only its own window, not the next run's events", () => {
    const T1 = T0 + 1_000;
    const later: AgentEvent[] = [
      { type: "message", source: "user", content: x(40), timestamp: T1 + 1 },
      { type: "tool_call", toolCallId: "t9", functionName: "WebFetch", arguments: "u", timestamp: T1 + 2 },
      { type: "tool_result", toolCallId: "t9", content: x(40_000), timestamp: T1 + 3 },
      { type: "message", source: "agent", content: "ok", usage: usage(1_000, 12_000), timestamp: T1 + 4 },
      { type: "done", exitStatus: "success", timestamp: T1 + 5 },
    ];
    const state = seedState(rec(), [...EVENTS, ...later]);
    states.push(state);
    const raw = join(state, "raw", "claude-ctx.jsonl");
    writeRunRecord(state, rec({ runId: "run-ctx-2", startedAt: T1, updatedAt: T1, rawTranscript: raw }));

    const first = JSON.parse(runCli(["context", "run-ctx-1", "--json", "--state-dir", state]).stdout) as ContextComposition;
    assert.equal(first.eventsTotal, EVENTS.length, "run 1 stops at run 2's start");
    assert.equal(first.sumTokens, 2_500);
    assert.equal(comp(first, "toolResults").tokens, 1_100);
    assert.ok(!first.tools.some((t) => t.name === "WebFetch"), "run 2's tool is not in run 1's window");

    const second = JSON.parse(runCli(["context", "run-ctx-2", "--json", "--state-dir", state]).stdout) as ContextComposition;
    assert.equal(second.eventsTotal, EVENTS.length + later.length, "the latest run keeps the resumed window");
    assert.equal(second.tools[0]!.name, "WebFetch");
  });
});

// ------------------------------------------------------------------ /trio

function block(html: string, name: string): string {
  const m = new RegExp(`/\\* ${name}:begin \\*/([\\s\\S]*?)/\\* ${name}:end \\*/`).exec(html);
  assert.ok(m, `missing /* ${name}:begin */ block`);
  return m[1]!;
}

interface Node { tag: string; className: string; textContent: string; title: string; style: Record<string, string>; children: Node[] }
function renderCard(obs: unknown): { text: string; bar: Node | undefined } {
  const nodes: Record<string, Node> = {};
  const mk = (tag: string, cls?: string | null, text?: string | null): Node => {
    const n = {
      tag,
      className: cls ?? "",
      textContent: text ?? "",
      title: "",
      style: {},
      children: [] as Node[],
      appendChild(c: Node) { n.children.push(c); },
      setAttribute() {},
    };
    return n;
  };
  const ctx = createContext({ obs, $: (id: string) => (nodes[id] ??= mk("div")), el: mk });
  runInContext(block(TRIO, "context-composition") + "\nrenderComposition();", ctx);
  const text = (n: Node): string => [n.textContent, ...n.children.map(text)].join(" ");
  const root = nodes.ctxComp!;
  return { text: text(root), bar: root.children.find((c) => c.className === "bar") };
}

describe("/trio composition card (#87)", () => {
  it("is built from the persisted events the /observability route derives, without a re-run", () => {
    const obs = deriveRunObservability(EVENTS, null, compositionInput(rec()));
    assert.ok(obs.composition, "the observability payload carries the composition");
    const { text, bar } = renderCard(JSON.parse(JSON.stringify(obs)));
    assert.match(text, /tool results 44\.0%/);
    assert.match(text, /reasoning n\/a/);
    assert.match(text, /2500 tok recorded/);
    assert.match(text, /Read 40\.2%/);
    assert.deepEqual(
      bar!.children.map((c) => [c.className, c.style.flexGrow]),
      [["cc-prompt", "100"], ["cc-assistantText", "200"], ["cc-toolCalls", "5"], ["cc-toolResults", "1100"], ["cc-unattributed", "1095"]],
      "one stacked segment per known component, none for the n/a reasoning",
    );
    assert.doesNotMatch(text, /NaN|undefined|Infinity/);
  });

  it("the page wires the card: fetchObs keeps the payload field and renderAll draws it", () => {
    assert.match(TRIO, /composition: \(data && data\.composition\) \|\| null/);
    assert.match(TRIO, /renderMetrics\(\);\n\s*renderComposition\(\);/);
    assert.match(TRIO, /id="ctxComp"/);
    assert.equal(renderCard(null).text.trim(), "", "no payload, no card");
  });

  describe("live route (bun subprocess)", { skip: hasBun ? false : "bun not on PATH" }, () => {
    let child: ChildProcess | null = null;
    let port = 0;
    let state = "";
    before(async () => {
      state = seedState(rec(), EVENTS);
      child = spawn("bun", [RUNNER, state, ""], { stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      child.stdout!.setEncoding("utf8");
      port = await new Promise<number>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error("web server never became ready")), 20_000);
        child!.stdout!.on("data", (c: string) => {
          out += c;
          const m = /READY (\d+)\n/.exec(out);
          if (m) {
            clearTimeout(t);
            resolve(Number(m[1]));
          }
        });
        child!.once("exit", () => {
          clearTimeout(t);
          reject(new Error("web server exited early"));
        });
      });
    });
    after(async () => {
      if (child !== null && child.exitCode === null) {
        await new Promise<void>((resolve) => {
          child!.once("exit", () => resolve());
          child!.kill("SIGTERM");
        });
      }
      rmSync(state, { recursive: true, force: true });
    });

    it("GET /api/runs/<id>/observability carries the composition the card renders", async () => {
      const res = await fetch(`http://127.0.0.1:${port}/api/runs/run-ctx-1/observability`);
      assert.equal(res.status, 200);
      const obs = (await res.json()) as { composition?: ContextComposition };
      assert.equal(obs.composition?.total.tokens, 2500);
      assert.equal(obs.composition?.sumTokens, 2500);
      assert.match(renderCard(obs).text, /tool results 44\.0%/);
    });
  });
});
