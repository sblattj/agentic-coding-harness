import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { createDriver, runTurns } from '../src/core/driver.ts';
import { EventTail } from '../src/core/event-retention.ts';
import { deriveLatency, runLatency } from '../src/core/latency.ts';
import { listRunRecords } from '../src/core/registry.ts';
import { stripChain } from '../src/core/hash-chain.ts';
import type { AdapterExit, AgentAdapter, AgentEvent, AgentHandle, RunResult } from '../src/core/types.ts';
import { budgetFractions } from '../src/cli/exit-codes.ts';
import { buildRunMetrics } from '../src/cli/run-sandbox.ts';
import { ClaudeCodeAdapter } from '../src/adapters/claude.ts';
import { ClaudeInteractiveAdapter, INTERACTIVE_RESULT_EVENT_TAIL } from '../src/interactive/claude-tui.ts';

// #199: a run whose adapter sets resultEventTail keeps only the last events
// in RunResult.events, while tokens, cost, the RunRecord, turns, latency and
// the unavailable verdict still cover the whole run.

const T0 = 1_800_000_000_000;

/** One model turn: a call that streams a message, a tool round trip, a step and its usage. */
function turn(i: number): AgentEvent[] {
  const t = T0 + i * 1000;
  return [
    { type: 'model_call_start', callId: `c${i}`, timestamp: t },
    { type: 'message', source: 'agent', content: `reply ${i} ${'x'.repeat(256)}`, timestamp: t + 40 },
    { type: 'tool_call', toolCallId: `t${i}`, functionName: 'Read', timestamp: t + 50 },
    { type: 'tool_result', toolCallId: `t${i}`, timestamp: t + 80 },
    { type: 'model_call_end', callId: `c${i}`, outputTokens: 12, timestamp: t + 200 },
    { type: 'step', timestamp: t + 201 },
    { type: 'usage_raw', agent: 'mock', data: { modelUsage: { 'claude-sonnet-4': { model: 'claude-sonnet-4', inputTokens: 1000 + i, outputTokens: 12 } } }, timestamp: t + 202 },
  ] as unknown as AgentEvent[];
}

class ScriptedHandle implements AgentHandle {
  readonly sessionId = `tail-${Math.random().toString(36).slice(2, 8)}`;
  constructor(
    readonly events: AgentEvent[],
    readonly exit: AdapterExit,
  ) {}
  async *attach(): AsyncIterable<AgentEvent> {
    for (const e of this.events) yield e;
  }
  abort(): void {}
  async wait(): Promise<AdapterExit> {
    return this.exit;
  }
}

function adapter(events: AgentEvent[], exit: AdapterExit, tail?: number): AgentAdapter {
  return { name: 'mock', ...(tail !== undefined ? { resultEventTail: tail } : {}), launch: async () => new ScriptedHandle(events, exit) };
}

async function run(events: AgentEvent[], exit: AdapterExit, tail?: number, spec: Record<string, unknown> = {}) {
  const stateDir = mkdtempSync(join(tmpdir(), 'ach-tail-'));
  const driver = createDriver({ adapters: { mock: adapter(events, exit, tail) }, stateDir, registry: { stateDir } });
  const result = await driver.run('mock', { prompt: 'hi', ...spec });
  const rec = listRunRecords(stateDir).find((r) => r.runId === result.runId);
  return { result, rec, stateDir };
}

describe('driver result event tail (#199)', () => {
  it('a capped run keeps the last N events and matches an uncapped run on every whole-run figure', async () => {
    const stream = Array.from({ length: 60 }, (_, i) => turn(i)).flat();
    const cap = 10; // not a multiple of the 7-event turn: a model call straddles the cut
    const full = await run(stream, 'success');
    const capped = await run(stream, 'success', cap);

    assert.equal(full.result.events.length, stream.length);
    assert.equal(full.result.eventSummary, undefined, 'uncapped results are unchanged');
    assert.equal(capped.result.events.length, cap);
    assert.deepEqual(capped.result.events, full.result.events.slice(-cap));
    assert.deepEqual(capped.result.tokens, full.result.tokens);
    assert.equal(capped.result.totalCost, full.result.totalCost);
    assert.ok(capped.result.totalCost > 0);
    assert.equal(capped.result.exitStatus, 'success');
    assert.deepEqual(capped.rec?.totals, full.rec?.totals, 'RunRecord totals are exact');
    assert.deepEqual(capped.rec?.latency, full.rec?.latency, 'RunRecord latency covers the whole run');

    const s = capped.result.eventSummary!;
    assert.equal(s.total, stream.length);
    assert.equal(s.retained, cap);
    assert.equal(s.turns, 60);
    assert.deepEqual(s.latency, deriveLatency(full.result.events));
    assert.equal(s.latency.modelCalls?.count, 60);
    assert.equal(s.latency.tools[0]?.count, 60);

    // The raw transcript still has every event.
    const raw = readFileSync(join(capped.stateDir, 'raw', `mock-${capped.result.sessionId}.jsonl`), 'utf8');
    assert.equal(raw.trim().split('\n').map(stripChain).filter((l) => JSON.parse(l).type !== 'ach.seal').length, stream.length);
  });

  it('readers take whole-run turns and latency from the summary, not the tail', async () => {
    const stream = Array.from({ length: 30 }, (_, i) => turn(i)).flat();
    const { result } = await run(stream, 'success', 5);
    assert.equal(result.events.filter((e) => e.type === 'step').length <= 1, true);
    assert.equal(runTurns(result, 'mock'), 30);
    assert.equal(runLatency(result).modelCalls?.count, 30);
    const f = budgetFractions({ ...result, agent: 'mock' } as RunResult, { budget: { maxTurns: 60 }, agent: 'mock' });
    assert.equal(f.find((x) => x.dimension === 'maxTurns')?.used, 30);
    assert.equal(buildRunMetrics({ agent: 'mock', result } as Parameters<typeof buildRunMetrics>[0]).turns, 30);
  });

  it('an early auth failure still settles unavailable after the tail has dropped it', async () => {
    const auth = { type: 'error', message: 'Not logged in. Run claude login', data: { kind: 'auth_failed' }, timestamp: T0 } as unknown as AgentEvent;
    const filler = Array.from({ length: 50 }, (_, i) => ({ type: 'message', source: 'agent', content: `working ${i}`, timestamp: T0 + i + 1 }) as unknown as AgentEvent);
    const { result } = await run([auth, ...filler], 'error', 5);
    assert.ok(!result.events.includes(auth));
    assert.equal(result.exitStatus, 'unavailable');
    assert.ok(result.warnings.some((w) => w.includes('Not logged in')));
  });

  it('memory: a long capped run holds at most N events', async () => {
    const stream = Array.from({ length: 3000 }, (_, i) => turn(i)).flat();
    const { result } = await run(stream, 'success', 100);
    assert.equal(result.events.length, 100);
    assert.equal(result.eventSummary?.total, 21_000);
  });

  it('the interactive adapter opts in; headless claude does not', () => {
    assert.equal(new ClaudeInteractiveAdapter({ stateDir: tmpdir() }).resultEventTail, INTERACTIVE_RESULT_EVENT_TAIL);
    assert.equal((new ClaudeCodeAdapter({ stateDir: tmpdir() }) as AgentAdapter).resultEventTail, undefined);
  });
});

describe('EventTail', () => {
  it('keeps the last cap events in order and counts all of them', () => {
    const t = new EventTail(3);
    for (let i = 0; i < 10; i++) t.push({ type: 'step', timestamp: i } as unknown as AgentEvent);
    assert.deepEqual(t.toArray().map((e) => e.timestamp), [7, 8, 9]);
    assert.equal(t.total, 10);
    assert.equal(t.retained, 3);
    const all = new EventTail();
    for (let i = 0; i < 10; i++) all.push({ type: 'step', timestamp: i } as unknown as AgentEvent);
    assert.equal(all.toArray().length, 10);
  });

  it('a fractional cap below 1 keeps every event instead of breaking the ring', () => {
    for (const cap of [0.5, 0, -1, Number.NaN]) {
      const t = new EventTail(cap);
      for (let i = 0; i < 5; i++) t.push({ type: 'step', timestamp: i } as unknown as AgentEvent);
      assert.equal(t.cap, undefined, `cap ${cap}`);
      assert.deepEqual(t.toArray().map((e) => e.timestamp), [0, 1, 2, 3, 4], `cap ${cap}`);
    }
    const t = new EventTail(2.7);
    for (let i = 0; i < 5; i++) t.push({ type: 'step', timestamp: i } as unknown as AgentEvent);
    assert.deepEqual(t.toArray().map((e) => e.timestamp), [3, 4]);
  });
});
