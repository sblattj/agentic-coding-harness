import { test } from "node:test";
import assert from "node:assert/strict";
import { formatEventLine } from "../src/cli/lib.ts";

test("model_call_start prints nothing; model_call_end prints one folded row with duration", () => {
  const starts = new Map<string, number>();
  assert.equal(formatEventLine({ type: "model_call_start", callId: "c1", timestamp: 1000 } as never, starts), null);
  const line = formatEventLine({ type: "model_call_end", callId: "c1", model: "claude-opus-5-5", outputTokens: 42, timestamp: 1250 } as never, starts);
  assert.match(line ?? "", /\] model   claude-opus-5-5 · 42 out · 250ms$/);
  assert.equal(starts.size, 0);
});

test("model_call_end without a matching start omits the duration", () => {
  const line = formatEventLine({ type: "model_call_end", callId: "zz", model: "m", timestamp: 5 } as never, new Map());
  assert.match(line ?? "", /\] model   m$/);
});

test("other events still format as before", () => {
  assert.match(formatEventLine({ type: "tool_call", functionName: "Bash", timestamp: 1 } as never) ?? "", /\] tool    Bash$/);
});

// #111: progress and error are diagnostics and must never be cut mid-sentence.
const LONG = "'New session' button not found; continuing in the current chat. ".repeat(5).trim();

test("a long progress line (>200 chars) prints in full", () => {
  assert.ok(LONG.length > 200);
  const line = formatEventLine({ type: "progress", data: LONG } as never) ?? "";
  assert.ok(line.endsWith(LONG), line);
  assert.ok(!line.includes("…"));
});

test("a long error line prints in full, from data or message", () => {
  const a = formatEventLine({ type: "error", data: LONG } as never) ?? "";
  assert.match(a, /^\[[^\]]+\] error   /);
  assert.ok(a.endsWith(LONG) && !a.includes("…"), a);
  const b = formatEventLine({ type: "error", message: LONG } as never) ?? "";
  assert.ok(b.endsWith(LONG) && !b.includes("…"), b);
});

test("multi-line progress keeps the prefix on line one and aligns continuation lines", () => {
  const line = formatEventLine({ type: "progress", data: "first\nsecond\n\nthird" } as never) ?? "";
  const rows = line.split("\n");
  assert.match(rows[0]!, /^\[[^\]]+\] »       first$/);
  const pad = " ".repeat(rows[0]!.length - "first".length);
  assert.deepEqual(rows.slice(1), [`${pad}second`, `${pad}third`]);
});

test("a long text line is still clipped to 60 chars", () => {
  const line = formatEventLine({ type: "message", data: LONG } as never) ?? "";
  const body = line.replace(/^\[[^\]]+\] text    /, "");
  assert.equal(body.length, 60);
  assert.ok(body.endsWith("…"));
});
