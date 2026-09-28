// `ach dash` verify glyph (#29): the STATUS cell's second character carries
// the post-run checker verdict; unverified rows render exactly as before.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { frame } from "../src/cli/dash.ts";
import type { RunRecord } from "../src/core/registry.ts";

const now = Date.now();
function rec(runId: string, over: Partial<RunRecord> = {}): RunRecord {
  return {
    runId,
    agent: "claude",
    startedAt: now - 5_000,
    updatedAt: now - 1_000,
    status: "success",
    exitStatus: "success",
    totals: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 },
    ...over,
  };
}
const verdict = (status: "pass" | "fail" | "error") => ({
  command: "npm test",
  exitCode: status === "pass" ? 0 : status === "fail" ? 1 : null,
  status,
  durationMs: 1,
  timedOut: false,
});

describe("dash verify glyph", () => {
  it("plain mode: p / f / e after the status glyph; blank when unverified", () => {
    const out = frame(
      [
        rec("aaaaaaaa1", { verify: verdict("pass") }),
        rec("bbbbbbbb1", { verify: verdict("fail") }),
        rec("cccccccc1", { verify: verdict("error") }),
        rec("dddddddd1"),
      ],
      "/tmp/x",
      true,
      200,
      false,
    );
    const line = (id: string) => out.split("\n").find((l) => l.includes(id))!;
    assert.match(line("aaaaaaaa"), /^\+p  claude/);
    assert.match(line("bbbbbbbb"), /^\+f  claude/);
    assert.match(line("cccccccc"), /^\+e  claude/);
    assert.match(line("dddddddd"), /^\+   claude/);
  });

  it("ansi mode: colored ✓ / ✗ marks", () => {
    const out = frame([rec("aaaaaaaa2", { verify: verdict("pass") }), rec("bbbbbbbb2", { verify: verdict("fail") })], "/tmp/x", true, 200, true);
    assert.ok(out.includes("+\x1b[32m✓\x1b[0m  claude"));
    assert.ok(out.includes("+\x1b[31m✗\x1b[0m  claude"));
  });
});
