import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { createDriver } from '../src/core/driver.ts';
import { listRunRecords, RunRecordSchema } from '../src/core/registry.ts';
import type { AgentAdapter, AgentEvent, AgentHandle } from '../src/core/types.ts';
import { runContextRows } from '../src/cli/context-stats.ts';

// Issue #32: the driver records deriveLatency() on the RunRecord at finalize;
// the registry schema round-trips it and `ach stats --json` runs[] carries it.

const T0 = 1_700_000_000_000;

class ScriptHandle implements AgentHandle {
  readonly sessionId = 'lat-1';
  constructor(private readonly events: AgentEvent[]) {}
  async *attach(): AsyncIterable<AgentEvent> {
    for (const e of this.events) yield e;
  }
  abort(): void {}
  async wait(): Promise<'success'> {
    return 'success';
  }
}

class ScriptAdapter implements AgentAdapter {
  readonly name = 'script';
  constructor(private readonly events: AgentEvent[]) {}
  async launch(): Promise<AgentHandle> {
    return new ScriptHandle(this.events);
  }
}

const tmp = (): string => mkdtempSync(join(tmpdir(), 'harness-latency-'));

async function runWith(events: AgentEvent[]) {
  const regDir = tmp();
  const driver = createDriver({ adapters: { script: new ScriptAdapter(events) }, stateDir: tmp(), registry: { stateDir: regDir } });
  const result = await driver.run('script', { prompt: 'x' });
  assert.equal(result.exitStatus, 'success');
  const recs = listRunRecords(regDir);
  assert.equal(recs.length, 1);
  return recs[0]!;
}

describe('RunRecord.latency (#32)', () => {
  it('driver records ttft, throughput and tool durations at finalize', async () => {
    const rec = await runWith([
      { type: 'model_call_start', callId: 'c', timestamp: T0 },
      { type: 'message', source: 'agent', content: 'hi', timestamp: T0 + 250 },
      { type: 'model_call_end', callId: 'c', usage: { inputTokens: 1, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0 }, timestamp: T0 + 1_250 },
      { type: 'tool_call', toolCallId: 't', functionName: 'bash', timestamp: T0 + 1_300 },
      { type: 'tool_result', toolCallId: 't', content: 'ok', timestamp: T0 + 1_700 },
    ]);
    assert.equal(rec.latency?.ttft?.avgMs, 250);
    assert.equal(rec.latency?.modelCalls?.maxMs, 1_250);
    assert.equal(rec.latency?.outputTokensPerSec, 100);
    assert.equal(rec.latency?.tpotMs, 10);
    assert.deepEqual(rec.latency?.tools.map((t) => [t.name, t.count, t.totalMs]), [['bash', 1, 400]]);
    // stats --json runs[] carries it verbatim
    assert.deepEqual(runContextRows([rec])[0]!.latency, rec.latency);
  });

  it('a run with nothing measurable writes no latency field', async () => {
    const rec = await runWith([
      { type: 'message', source: 'agent', content: 'hi', timestamp: T0 },
      { type: 'usage', usage: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 }, timestamp: T0 + 10 },
    ]);
    assert.equal('latency' in rec, false);
    assert.equal('latency' in runContextRows([rec])[0]!, false);
  });

  it('schema accepts null metrics and rejects a malformed latency block', () => {
    const base = { runId: 'r', agent: 'a', startedAt: T0 };
    const ok = RunRecordSchema.safeParse({
      ...base,
      latency: { ttft: null, modelCalls: null, outputTokensPerSec: null, tpotMs: null, tools: [] },
    });
    assert.equal(ok.success, true);
    const bad = RunRecordSchema.safeParse({ ...base, latency: { ttft: 'fast', tools: [] } });
    assert.equal(bad.success, false);
  });
});
