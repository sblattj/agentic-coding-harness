// #59 follow-up: consumers that parse transcript lines as AgentEvents (web
// replay via RunEventHub.readTranscript, MCP harness_run_events) must see the
// pre-chain view: no `ach_chain` framing, no terminal `ach.seal` record.
//
// The chained transcript is written by the REAL driver (as in
// tests/hash-chain.test.ts); the control is the same events written unframed.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { createDriver } from "../src/core/driver.ts";
import { CHAIN_KEY, SEAL_EVENT_TYPE, stripChain, unchainedLines } from "../src/core/hash-chain.ts";
import { readRunRecord, writeRunRecord, type RunRecord } from "../src/core/registry.ts";
import type { AgentAdapter, AgentEvent, AgentHandle } from "../src/core/types.ts";
import type { McpServer, McpToolDef } from "../src/mcp/contract.ts";
import { registerJobTools } from "../src/mcp/tools-jobs.ts";
import { createRunEventHub } from "../src/web/hub.ts";

const SCRIPT: Array<Record<string, unknown>> = [
  { type: "step" },
  { type: "text", text: "hello" },
  { type: "step" },
  { type: "text", text: "world" },
];

class Handle implements AgentHandle {
  readonly sessionId = "sess-chain-consumers";
  async *attach(): AsyncIterable<AgentEvent> {
    for (const e of SCRIPT) yield { ...e, sessionId: this.sessionId, timestamp: 1 } as AgentEvent;
  }
  abort(): void {}
  async wait(): Promise<"success"> {
    return "success";
  }
}

async function chainedRun(stateDir: string): Promise<RunRecord> {
  const adapter: AgentAdapter = { name: "claude", launch: async () => new Handle() };
  const driver = createDriver({ adapters: { claude: adapter }, stateDir, registry: { stateDir } });
  const result = await driver.run("claude", { prompt: "chain consumers" });
  const rec = readRunRecord(stateDir, result.runId);
  assert.ok(rec?.rawTranscript, "driver wrote a RunRecord with a transcript");
  return rec;
}

/** The transcript as it read before #59: framing stripped, seal removed. */
function preChainLines(file: string): string[] {
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map(stripChain)
    .filter((l) => (JSON.parse(l) as { type?: string }).type !== SEAL_EVENT_TYPE);
}

function mcpEvents(stateDir: string): McpToolDef {
  const tools = new Map<string, McpToolDef>();
  const server: McpServer = { registerTool: (t: McpToolDef) => void tools.set(t.name, t) } as unknown as McpServer;
  registerJobTools(server, { stateDir } as never);
  return tools.get("harness_run_events")!;
}

describe("chained transcripts through AgentEvent consumers (#59)", () => {
  it("fixture control: the real writer frames every line and ends with a seal", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chain-consumers-"));
    const rec = await chainedRun(dir);
    const raw = fs.readFileSync(rec.rawTranscript!, "utf8").split("\n").filter((l) => l !== "");
    assert.ok(raw.length > SCRIPT.length);
    assert.ok(raw.every((l) => l.includes(`"${CHAIN_KEY}"`)), "every line framed");
    assert.equal((JSON.parse(raw[raw.length - 1]!) as { type: string }).type, SEAL_EVENT_TYPE);
    assert.deepEqual(unchainedLines(fs.readFileSync(rec.rawTranscript!, "utf8")), preChainLines(rec.rawTranscript!));
    assert.equal(unchainedLines("").length, 0);
    assert.deepEqual(unchainedLines('{"type":"legacy"}\n\n{"type":"x"}\n'), ['{"type":"legacy"}', '{"type":"x"}']);
  });

  it("RunEventHub.readTranscript: no ach_chain key, no seal, events equal the unchained log", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chain-consumers-"));
    const rec = await chainedRun(dir);
    const expected = preChainLines(rec.rawTranscript!).map((l) => JSON.parse(l) as AgentEvent);
    const events = await createRunEventHub(dir).readTranscript(rec.runId);
    assert.ok(events.length > 0);
    assert.deepEqual(events, expected);
    for (const e of events) {
      assert.equal(CHAIN_KEY in (e as object), false);
      assert.notEqual((e as { type: string }).type, SEAL_EVENT_TYPE);
    }

    // Control: the same events written UNCHAINED (pre-#59 layout) read identically.
    const legacy = path.join(dir, "raw", "legacy.jsonl");
    fs.writeFileSync(legacy, preChainLines(rec.rawTranscript!).join("\n") + "\n");
    writeRunRecord(dir, { ...rec, runId: "legacy-run-0001", rawTranscript: legacy, seal: undefined } as RunRecord);
    assert.deepEqual(await createRunEventHub(dir).readTranscript("legacy-run-0001"), expected);
  });

  it("live tail offsets (server.ts sendBacklogAndTail) line up as a chained log grows through its seal", async () => {
    // sendBacklogAndTail keeps `sent = events.length` from readTranscript and
    // each tick forwards `now.slice(sent)`. Both counts come from the same
    // unchained view, so the seal line (dropped) must never shift the offset:
    // replaying the log one line at a time must forward every event exactly
    // once, in order, and appending the seal must add nothing.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chain-consumers-"));
    const rec = await chainedRun(dir);
    const framed = fs.readFileSync(rec.rawTranscript!, "utf8").split("\n").filter((l) => l !== "");
    const expected = preChainLines(rec.rawTranscript!).map((l) => JSON.parse(l) as AgentEvent);
    const hub = createRunEventHub(dir);
    const live = rec.rawTranscript!;

    fs.writeFileSync(live, "");
    let sent = (await hub.readTranscript(rec.runId)).length;
    assert.equal(sent, 0);
    const forwarded: AgentEvent[] = [];
    for (let k = 1; k <= framed.length; k++) {
      fs.writeFileSync(live, framed.slice(0, k).join("\n") + "\n");
      const now = await hub.readTranscript(rec.runId);
      if (now.length > sent) {
        forwarded.push(...now.slice(sent));
        sent = now.length;
      }
      if (k === framed.length) assert.equal(now.length, framed.length - 1, "the seal line adds no event");
    }
    assert.deepEqual(forwarded, expected, "each event forwarded exactly once, no seal, no framing");
  });

  it("harness_run_events: same events, cursor and total as the unchained log", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chain-consumers-"));
    const rec = await chainedRun(dir);
    const expected = preChainLines(rec.rawTranscript!).map((l) => JSON.parse(l));
    const tool = mcpEvents(dir);

    const all = (await tool.handler({ runId: rec.runId })) as {
      events: unknown[];
      nextCursor: number;
      total: number;
      truncated: boolean;
    };
    assert.deepEqual(all.events, expected);
    assert.equal(all.total, expected.length, "seal line not counted");
    assert.equal(all.nextCursor, expected.length);
    assert.equal(all.truncated, false);
    assert.ok(!JSON.stringify(all).includes(CHAIN_KEY));
    assert.ok(!JSON.stringify(all).includes(SEAL_EVENT_TYPE));

    // Paging by line offset addresses the same events as before the chain.
    const page = (await tool.handler({ runId: rec.runId, cursor: 1, limit: 2 })) as { events: unknown[]; truncated: boolean };
    assert.deepEqual(page.events, expected.slice(1, 3));
    assert.equal(page.truncated, true);
  });
});
