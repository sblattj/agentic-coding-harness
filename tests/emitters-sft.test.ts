import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { before, describe, test } from "node:test";
import { z } from "zod";
import * as sft from "../src/emitters/sft.ts";

const { eventsToMessages, fullSample, turnSamples } = sft;
const withPrompt = (m: sft.SftMessage[], p: string | undefined): sft.SftMessage[] =>
  (sft as unknown as { withPrompt: (m: sft.SftMessage[], p: string | undefined) => sft.SftMessage[] }).withPrompt(m, p);
import type { AgentEvent } from "../src/core/types.ts";

const CLI = new URL("../src/cli/ach.ts", import.meta.url).pathname;
const EXAMPLE_DIR = new URL("../docs/examples/", import.meta.url).pathname;

// JSON-schema-equivalent of the OpenAI chat fine-tuning format.
const ToolCall = z.object({
  id: z.string().min(1),
  type: z.literal("function"),
  function: z.object({ name: z.string().min(1), arguments: z.string() }),
}).strict();
const Message = z.discriminatedUnion("role", [
  z.object({ role: z.literal("system"), content: z.string() }).strict(),
  z.object({ role: z.literal("user"), content: z.string() }).strict(),
  z.object({ role: z.literal("assistant"), content: z.string().nullable(), tool_calls: z.array(ToolCall).min(1).optional() }).strict(),
  z.object({ role: z.literal("tool"), tool_call_id: z.string().min(1), content: z.string() }).strict(),
]);
const Sample = z.object({ messages: z.array(Message).min(1) }).strict().superRefine((s, ctx) => {
  // Every tool message must follow an assistant message that issued its call id,
  // and every issued call must be answered before the next non-tool message
  // (except on the final assistant message of a turn-level sample).
  let pending = new Set<string>();
  for (const m of s.messages) {
    if (m.role === "tool") {
      if (!pending.delete(m.tool_call_id)) ctx.addIssue({ code: "custom", message: `orphan tool message ${m.tool_call_id}` });
      continue;
    }
    if (pending.size > 0) ctx.addIssue({ code: "custom", message: "unanswered tool_calls" });
    pending = new Set(m.role === "assistant" ? (m.tool_calls ?? []).map((c) => c.id) : []);
  }
  // A final assistant message may carry tool_calls (training target: emit the call).
  if (s.messages[s.messages.length - 1]?.role !== "assistant") ctx.addIssue({ code: "custom", message: "sample must end with assistant" });
});

function parseJsonl(text: string): unknown[] {
  return text.split("\n").filter((l) => l !== "").map((l) => JSON.parse(l));
}

function ev(partial: Record<string, unknown>, t: number): AgentEvent {
  return { timestamp: 1790000000000 + t, ...partial } as AgentEvent;
}

function conversation(): AgentEvent[] {
  return [
    ev({ type: "message", source: "system", content: "sys" }, 0),
    ev({ type: "message", source: "user", content: "read a.txt" }, 1),
    ev({ type: "message", source: "agent", content: "reading" }, 2),
    ev({ type: "tool_call", toolCallId: "c1", functionName: "read_file", arguments: { path: "a.txt" } }, 3),
    ev({ type: "tool_result", toolCallId: "c1", content: "hello" }, 4),
    ev({ type: "message", source: "assistant", content: "it says hello" }, 5),
  ];
}

describe("sft emitter: message mapping", () => {
  test("user/assistant/tool turns keep order, tool calls use the OpenAI shape", () => {
    const m = eventsToMessages(conversation());
    assert.deepEqual(m.map((x) => x.role), ["system", "user", "assistant", "tool", "assistant"]);
    const a = m[2] as { tool_calls: Array<{ id: string; type: string; function: { name: string; arguments: string } }> };
    assert.deepEqual(a.tool_calls, [{ id: "c1", type: "function", function: { name: "read_file", arguments: '{"path":"a.txt"}' } }]);
    assert.deepEqual(m[3], { role: "tool", tool_call_id: "c1", content: "hello" });
  });

  test("tool call with no preceding text gets its own assistant message; parallel calls share one", () => {
    const m = eventsToMessages([
      ev({ type: "message", source: "user", content: "go" }, 0),
      ev({ type: "tool_call", toolCallId: "a", functionName: "f", arguments: {} }, 1),
      ev({ type: "tool_call", toolCallId: "b", functionName: "g", arguments: "{}" }, 2),
      ev({ type: "tool_result", toolCallId: "b", content: { ok: true } }, 3),
      ev({ type: "tool_result", toolCallId: "a", content: "x" }, 4),
      ev({ type: "message", source: "agent", content: "done" }, 5),
    ]);
    assert.deepEqual(m.map((x) => x.role), ["user", "assistant", "tool", "tool", "assistant"]);
    assert.equal((m[1] as { tool_calls: unknown[] }).tool_calls.length, 2);
    assert.equal((m[2] as { content: string }).content, '{"ok":true}');
  });

  test("dangling calls and orphan results are dropped so output stays valid", () => {
    const m = eventsToMessages([
      ev({ type: "message", source: "user", content: "go" }, 0),
      ev({ type: "tool_result", toolCallId: "ghost", content: "?" }, 1),
      ev({ type: "tool_call", toolCallId: "never", functionName: "f", arguments: {} }, 2),
      ev({ type: "message", source: "agent", content: "final" }, 3),
    ]);
    assert.deepEqual(m.map((x) => x.role), ["user", "assistant"]);
  });

  test("reasoning message events are dropped, not exported as assistant turns", () => {
    const m = eventsToMessages([
      ev({ type: "message", source: "user", content: "go" }, 0),
      ev({ type: "message", source: "agent", content: "hidden thoughts", reasoning: true }, 1),
      ev({ type: "message", source: "agent", content: "answer" }, 2),
    ]);
    assert.deepEqual(m, [{ role: "user", content: "go" }, { role: "assistant", content: "answer" }]);
  });

  test("empty toolCallIds get unique synthetic ids and pair with results positionally", () => {
    const m = eventsToMessages([
      ev({ type: "message", source: "user", content: "go" }, 0),
      ev({ type: "tool_call", toolCallId: "", functionName: "f", arguments: "" }, 1),
      ev({ type: "tool_result", toolCallId: "", content: "r1" }, 2),
      ev({ type: "tool_call", toolCallId: "", functionName: "g", arguments: { a: 1 } }, 3),
      ev({ type: "tool_call", toolCallId: "", functionName: "h", arguments: "ls -la" }, 4),
      ev({ type: "tool_result", toolCallId: "", content: "r3" }, 5),
      ev({ type: "tool_result", toolCallId: "", content: "r2" }, 6),
      ev({ type: "message", source: "agent", content: "done" }, 7),
    ]);
    const sample = { messages: m };
    assert.ok(Sample.safeParse(sample).success, JSON.stringify(Sample.safeParse(sample)));
    const calls = m.flatMap((x) => (x.role === "assistant" ? (x.tool_calls ?? []) : []));
    assert.equal(calls.length, 3);
    assert.equal(new Set(calls.map((c) => c.id)).size, 3);
    for (const c of calls) assert.ok(c.id !== "");
    assert.deepEqual(calls.map((c) => c.function.arguments), ["{}", '{"a":1}', '{"input":"ls -la"}']);
    for (const c of calls) JSON.parse(c.function.arguments);
    // Most recent unanswered call (h) gets the first empty-id result after it.
    const tools = m.filter((x) => x.role === "tool") as Array<{ tool_call_id: string; content: string }>;
    const byId = new Map(calls.map((c) => [c.id, c.function.name]));
    assert.deepEqual(tools.map((t) => [byId.get(t.tool_call_id), t.content]), [["f", "r1"], ["h", "r3"], ["g", "r2"]]);
  });

  test("synthetic ids never collide with real ids", () => {
    const m = eventsToMessages([
      ev({ type: "tool_call", toolCallId: "call_sft_1", functionName: "f", arguments: {} }, 0),
      ev({ type: "tool_call", toolCallId: "", functionName: "g", arguments: {} }, 1),
      ev({ type: "tool_result", toolCallId: "call_sft_1", content: "a" }, 2),
      ev({ type: "tool_result", toolCallId: "", content: "b" }, 3),
    ]);
    const ids = (m[0] as { tool_calls: Array<{ id: string }> }).tool_calls.map((c) => c.id);
    assert.equal(new Set(ids).size, 2);
  });

  test("a recorded prompt becomes the first user turn (after any system message)", () => {
    assert.deepEqual(withPrompt([{ role: "assistant", content: "hi" }], "explain foo"), [
      { role: "user", content: "explain foo" },
      { role: "assistant", content: "hi" },
    ]);
    assert.deepEqual(withPrompt([{ role: "system", content: "s" }, { role: "assistant", content: "hi" }], "p").map((x) => x.role), ["system", "user", "assistant"]);
    // Already starts with a user message: unchanged.
    const m = eventsToMessages(conversation());
    assert.deepEqual(withPrompt(m, "read a.txt"), m);
    assert.deepEqual(withPrompt(m, undefined), m);
  });

  test("turn-level yields one sample per assistant message; full yields one", () => {
    const m = eventsToMessages(conversation());
    const turns = turnSamples(m);
    assert.equal(turns.length, 2);
    assert.deepEqual(turns[0]!.messages.map((x) => x.role), ["system", "user", "assistant"]);
    assert.equal(turns[1]!.messages.length, 5);
    const full = fullSample(m);
    assert.equal(full.length, 1);
    assert.equal(full[0]!.messages.length, 5);
    for (const s of [...turns, ...full]) assert.ok(Sample.safeParse(s).success, JSON.stringify(Sample.safeParse(s)));
  });
});

describe("ach emit --format sft", () => {
  let dir: string;

  function run(args: string[]) {
    const p = spawnSync(process.execPath, ["--import", "tsx", CLI, "emit", ...args], { encoding: "utf8" });
    return { code: p.status ?? -1, stdout: p.stdout ?? "", stderr: p.stderr ?? "" };
  }

  function result(agent: string, exitStatus: string, extra: Record<string, unknown>): string {
    return JSON.stringify({ runId: `r-${agent}`, sessionId: "s", agent, exitStatus, tokens: [], totalCost: 0, durationMs: 1, warnings: [], events: conversation(), ...extra });
  }

  before(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "sft-"));
    await fs.mkdir(path.join(dir, "sweep", "t1"), { recursive: true });
    await fs.mkdir(path.join(dir, "noscore"), { recursive: true });
    await fs.writeFile(path.join(dir, "single.json"), result("claude", "success", { score: 5 }));
    // 3-run sweep: claude score 5 success, codex score 3 success, kiro score 4 error.
    await fs.writeFile(path.join(dir, "sweep", "t1", "claude.json"), result("claude", "success", { score: 5 }));
    await fs.writeFile(path.join(dir, "sweep", "t1", "codex.json"), result("codex", "success", { score: 3 }));
    await fs.writeFile(path.join(dir, "sweep", "t1", "kiro.json"), result("kiro", "error", { score: 4 }));
    await fs.writeFile(path.join(dir, "noscore", "claude.json"), result("claude", "success", {}));
    await fs.writeFile(path.join(dir, "bare-events.json"), JSON.stringify(conversation()));
  });

  test("turn-level and --full-conversation output validate against the OpenAI chat schema", async () => {
    const out = path.join(dir, "turn.jsonl");
    const r = run(["--input", path.join(dir, "single.json"), "--format", "sft", "--out", out]);
    assert.equal(r.code, 0, r.stderr);
    const turn = parseJsonl(await fs.readFile(out, "utf8"));
    assert.equal(turn.length, 2);
    for (const s of turn) assert.ok(Sample.safeParse(s).success);

    const out2 = path.join(dir, "full.jsonl");
    const r2 = run(["--input", path.join(dir, "single.json"), "--format", "sft", "--full-conversation", "--out", out2]);
    assert.equal(r2.code, 0, r2.stderr);
    const full = parseJsonl(await fs.readFile(out2, "utf8"));
    assert.equal(full.length, 1);
    for (const s of full) assert.ok(Sample.safeParse(s).success);
    const roles = (full[0] as { messages: Array<{ role: string }> }).messages.map((m) => m.role);
    assert.deepEqual(roles, ["system", "user", "assistant", "tool", "assistant"]);
  });

  test("a bare event array works and prints to stdout", () => {
    const r = run(["--input", path.join(dir, "bare-events.json"), "--format", "sft", "--full-conversation"]);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(parseJsonl(r.stdout).length, 1);
  });

  const sweep = () => path.join(dir, "sweep");
  const agentsIn = (stdout: string) => parseJsonl(stdout).length / 2;

  test("--min-score 4 keeps only runs scored >= 4", () => {
    const all = run(["--input", sweep(), "--format", "sft", "--full-conversation"]);
    assert.equal(parseJsonl(all.stdout).length, 3);
    const r = run(["--input", sweep(), "--format", "sft", "--min-score", "4"]);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(agentsIn(r.stdout), 2); // claude(5) + kiro(4), two turn samples each
    assert.match(r.stderr, /2\/3 runs/);
  });

  test("--exit success excludes failed runs; --agent narrows; filters combine", () => {
    const e = run(["--input", sweep(), "--format", "sft", "--full-conversation", "--exit", "success"]);
    assert.equal(parseJsonl(e.stdout).length, 2);
    const a = run(["--input", sweep(), "--format", "sft", "--full-conversation", "--agent", "kiro"]);
    assert.equal(parseJsonl(a.stdout).length, 1);
    const both = run(["--input", sweep(), "--format", "sft", "--full-conversation", "--exit", "success", "--min-score", "4"]);
    assert.equal(parseJsonl(both.stdout).length, 1);
  });

  test("verify verdict counts as score 1/0 when no numeric score exists", async () => {
    const d = path.join(dir, "verified");
    await fs.mkdir(d, { recursive: true });
    await fs.writeFile(path.join(d, "a.json"), result("a", "success", { verify: { command: "x", exitCode: 0, status: "pass", durationMs: 1, timedOut: false } }));
    await fs.writeFile(path.join(d, "b.json"), result("b", "success", { verify: { command: "x", exitCode: 1, status: "fail", durationMs: 1, timedOut: false } }));
    const r = run(["--input", d, "--format", "sft", "--full-conversation", "--min-score", "1"]);
    assert.equal(parseJsonl(r.stdout).length, 1);
  });

  test("--min-score on an input with no score data is a USAGE error, not a silent pass", () => {
    const r = run(["--input", path.join(dir, "noscore"), "--format", "sft", "--min-score", "4"]);
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /--min-score needs score data/);
    const bare = run(["--input", path.join(dir, "bare-events.json"), "--format", "sft", "--exit", "success"]);
    assert.notEqual(bare.code, 0);
    assert.match(bare.stderr, /--exit needs run outcomes/);
  });

  test("sft-only flags on another format are a USAGE error, not silently ignored", () => {
    const r = run(["--input", path.join(dir, "bare-events.json"), "--format", "atif", "--min-score", "4", "--full-conversation"]);
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /--min-score, --full-conversation only applies to --format sft/);
  });

  test("a real `ach run --json` result yields a user turn then the assistant turn", async () => {
    const home = path.join(dir, "home");
    await fs.mkdir(home, { recursive: true });
    const p = spawnSync(process.execPath, ["--import", "tsx", CLI, "run", "--agent", "null", "--json", "explain foo"], {
      encoding: "utf8",
      env: { ...process.env, HOME: home, AGENTIC_CODING_HARNESS_STATE_DIR: path.join(dir, "state") },
    });
    assert.equal(p.status, 0, p.stderr);
    const json = p.stdout.slice(p.stdout.indexOf("{"), p.stdout.lastIndexOf("}") + 1);
    const res = JSON.parse(json) as { prompt?: string };
    assert.equal(res.prompt, "explain foo");
    const file = path.join(dir, "real-run.json");
    await fs.writeFile(file, json);
    const r = run(["--input", file, "--format", "sft"]);
    assert.equal(r.code, 0, r.stderr);
    const samples = parseJsonl(r.stdout) as Array<{ messages: Array<{ role: string; content: string }> }>;
    assert.equal(samples.length, 1);
    assert.deepEqual(samples[0]!.messages.map((m) => m.role), ["user", "assistant"]);
    assert.equal(samples[0]!.messages[0]!.content, "explain foo");
  });

  test("--exit rejects a value that is not an exit status", () => {
    const r = run(["--input", sweep(), "--format", "sft", "--exit", "succes"]);
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /--exit must be one of success, error, timeout/);
  });

  test("non-sft flags with --format sft are a USAGE error, not silently ignored", () => {
    const r = run(["--input", sweep(), "--format", "sft", "--model", "m", "--session-id", "s", "--langfuse-url", "http://x"]);
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /--model, --session-id, --langfuse-url do not apply to --format sft/);
  });

  test("docs example matches the CLI output for the recorded run", async () => {
    const r = run(["--input", path.join(EXAMPLE_DIR, "sft-run.result.json"), "--format", "sft", "--full-conversation"]);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout, await fs.readFile(path.join(EXAMPLE_DIR, "run.sft.jsonl"), "utf8"));
    for (const s of parseJsonl(r.stdout)) assert.ok(Sample.safeParse(s).success);
  });
});
