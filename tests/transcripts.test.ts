import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import {
  parseClaudeSession,
  parseClaudeTranscript,
  parseCodexRollout,
  parseGeminiChat,
  scanAll,
  toCanonicalTokenRecord,
  type CanonicalTokenRecord,
} from "../src/monitors/transcripts.ts";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

test("parseClaudeTranscript: filters, dedupes, and maps assistant usage exactly", async () => {
  const records = await parseClaudeTranscript(
    join(fixtures, "claude", "session-abc.jsonl"),
  );

  const expected: CanonicalTokenRecord[] = [
    {
      agent: "claude",
      sessionId: "sess-abc",
      timestamp: "2026-09-09T12:00:02.000Z",
      model: "claude-sonnet-4-5",
      input: 100,
      output: 55,
      cacheRead: 30,
      cacheWrite: 25,
      reasoning: 8,
    },
    {
      agent: "claude",
      sessionId: "sess-abc",
      timestamp: "2026-09-09T12:00:03.000Z",
      model: "claude-opus-4-1",
      input: 10,
      output: 7,
      cacheRead: 5,
      cacheWrite: 0,
      reasoning: 0,
    },
  ];
  assert.deepStrictEqual(records, expected);
});

test("parseClaudeTranscript: duplicate message.id keeps the LATER record and ignores usage.iterations", async () => {
  const records = await parseClaudeTranscript(
    join(fixtures, "claude", "session-abc.jsonl"),
  );
  // Two records survive: msg_001 (deduped) and msg_002. The streaming partial
  // (output 40) was replaced by the final record (output 55).
  assert.equal(records.length, 2);
  assert.equal(records[0]?.output, 55);
  assert.equal(records[0]?.timestamp, "2026-09-09T12:00:02.000Z");
  // iterations[] held input_tokens: 999; it must not be added to input.
  assert.equal(records[1]?.input, 10);
  // usage:null record must be dropped.
  assert.ok(!records.some((r) => r.model === null));
});

test("parseCodexRollout: emits deltas from cumulative thread_token_usage", async () => {
  const records = await parseCodexRollout(
    join(fixtures, "codex", "rollout-test.jsonl"),
  );

  const expected: CanonicalTokenRecord[] = [
    {
      agent: "codex",
      sessionId: "sess-cdx",
      timestamp: "2026-09-09T13:00:10.000Z",
      model: null,
      input: 70,
      output: 50,
      cacheRead: 30,
      cacheWrite: 10,
      reasoning: 20,
    },
    {
      agent: "codex",
      sessionId: "sess-cdx",
      timestamp: "2026-09-09T13:00:30.000Z",
      model: null,
      input: 40,
      output: 40,
      cacheRead: 10,
      cacheWrite: 2,
      reasoning: 15,
    },
  ];
  assert.deepStrictEqual(records, expected);
});

test("parseGeminiChat: maps tokens, subtracts cached from input", async () => {
  const records = await parseGeminiChat(
    join(fixtures, "gemini", "chats", "chat-test.json"),
  );

  const expected: CanonicalTokenRecord[] = [
    {
      agent: "gemini",
      sessionId: "chat-test",
      timestamp: "2026-09-09T10:00:00.000Z",
      model: "gemini-2.5-pro",
      input: 80,
      output: 50,
      cacheRead: 20,
      cacheWrite: 0,
      reasoning: 10,
    },
    {
      agent: "gemini",
      sessionId: "chat-test",
      timestamp: null,
      model: "gemini-2.5-flash",
      input: 80,
      output: 30,
      cacheRead: 0,
      cacheWrite: 0,
      reasoning: 0,
    },
  ];
  assert.deepStrictEqual(records, expected);
});

test("parseClaudeSession: includes subagent transcripts", async () => {
  const records = await parseClaudeSession(
    join(fixtures, "claude-session"),
    "session-xyz",
  );
  assert.equal(records.length, 3);
  assert.deepStrictEqual(
    records.map((r) => r.model),
    ["claude-sonnet-4-5", "claude-haiku-4-5", "claude-haiku-4-5"],
  );
  assert.ok(records.every((r) => r.sessionId === "sess-xyz"));
});

test("scanAll: walks all three fixture sources with agent set", async () => {
  const records: CanonicalTokenRecord[] = [];
  for await (const record of scanAll({
    claudeDir: join(fixtures, "claude"),
    codexDir: join(fixtures, "codex"),
    geminiDir: join(fixtures, "gemini"),
  })) {
    records.push(record);
  }

  assert.equal(records.length, 6);
  const byAgent = (agent: CanonicalTokenRecord["agent"]) =>
    records.filter((r) => r.agent === agent);
  assert.equal(byAgent("claude").length, 2);
  assert.equal(byAgent("codex").length, 2);
  assert.equal(byAgent("gemini").length, 2);

  const total = (field: keyof CanonicalTokenRecord) =>
    records.reduce((sum, r) => sum + (r[field] as number), 0);
  // input 420 raw minus codex cached deltas (30 + 10) = 380 uncached-only
  assert.equal(total("input"), 380);
  assert.equal(total("output"), 232);
  assert.equal(total("cacheRead"), 95);
  assert.equal(total("cacheWrite"), 37);
  assert.equal(total("reasoning"), 53);
});

test("toCanonicalTokenRecord: bridges to the central src/core/types.ts shape", async () => {
  const records = await parseClaudeTranscript(
    join(fixtures, "claude", "session-abc.jsonl"),
  );
  const central = toCanonicalTokenRecord(records[0]!);
  assert.deepStrictEqual(central, {
    agent: "claude",
    sessionId: "sess-abc",
    model: "claude-sonnet-4-5",
    inputTokens: 100,
    outputTokens: 55,
    cacheReadTokens: 30,
    cacheWriteTokens: 25,
    reasoningTokens: 8,
    timestamp: Date.parse("2026-09-09T12:00:02.000Z"),
    extra: {
      timestampIso: "2026-09-09T12:00:02.000Z",
    },
  });
});
