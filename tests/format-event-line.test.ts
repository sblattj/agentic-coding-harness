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
