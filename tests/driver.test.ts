import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { createDriver, defaultAdapters } from '../src/core/driver.js';
import { listRunRecords } from '../src/core/registry.js';
import type { AgentAdapter, AgentEvent, AgentHandle, CanonicalTokenRecord, RunResult, RunSpec } from '../src/core/types.js';

type ScriptedEvent =
  | { type: 'step' }
  | { type: 'usage_raw'; agent: string; data: unknown }
  | { type: 'usage'; usage: CanonicalTokenRecord };

class MockHandle implements AgentHandle {
  readonly sessionId = `mock-${Math.random().toString(36).slice(2, 8)}`;
  aborted = false;
  readonly #events: ScriptedEvent[];
  readonly #done: Promise<void>;
  #markDone!: () => void;

  constructor(events: ScriptedEvent[]) {
    this.#events = events;
    this.#done = new Promise<void>((resolve) => {
      this.#markDone = resolve;
    });
  }

  async *attach(): AsyncIterable<AgentEvent> {
    try {
      for (const e of this.#events) {
        const ts = Date.now();
        if (e.type === 'step') {
          yield { type: 'step', sessionId: this.sessionId, timestamp: ts };
        } else if (e.type === 'usage_raw') {
          yield { type: 'usage_raw', agent: e.agent, data: e.data, sessionId: this.sessionId, timestamp: ts };
        } else {
          yield { type: 'usage', usage: e.usage, sessionId: this.sessionId, timestamp: ts };
        }
      }
    } finally {
      this.#markDone(); // stream consumed (or consumer broke out) -> settled
    }
  }

  abort(): void {
    this.aborted = true;
    this.#markDone();
  }

  async wait(): Promise<'aborted' | 'success'> {
    await this.#done;
    return this.aborted ? 'aborted' : 'success';
  }
}

class MockAdapter implements AgentAdapter {
  readonly name = 'mock';
  lastHandle?: MockHandle;

  constructor(readonly enforcesBudget?: boolean) {}

  async launch(spec: RunSpec): Promise<AgentHandle> {
    const handle = new MockHandle((spec as { scriptedEvents?: ScriptedEvent[] }).scriptedEvents ?? []);
    this.lastHandle = handle;
    return handle;
  }
}

const ev = {
  step: (): ScriptedEvent => ({ type: 'step' }),
  usage: (agent: string, data: unknown): ScriptedEvent => ({ type: 'usage_raw', agent, data }),
  preNormalized: (usage: CanonicalTokenRecord): ScriptedEvent => ({ type: 'usage', usage }),
};
const claudeUsage = (input: number, output: number) => ({
  modelUsage: { 'claude-sonnet-4': { model: 'claude-sonnet-4', inputTokens: input, outputTokens: output } },
});

function tmpStateDir(): string {
  return mkdtempSync(join(tmpdir(), 'harness-driver-'));
}

function mockDriver(adapter: MockAdapter) {
  return createDriver({ adapters: { mock: adapter }, stateDir: tmpStateDir() });
}

describe('budget enforcement', () => {
  it('aborts and reports budget_exceeded when cumulative cost exceeds spec.budget.usd', async () => {
    const adapter = new MockAdapter();
    const driver = mockDriver(adapter);
    // Each usage = 100k in * $3/1M + 10k out * $15/1M = $0.45. Budget $0.50.
    const result: RunResult = await driver.run('mock', {
      prompt: 'hi',
      budget: { usd: 0.5 },
      scriptedEvents: [
        ev.step(),
        ev.usage('mock', claudeUsage(100_000, 10_000)),
        ev.step(),
        ev.usage('mock', claudeUsage(100_000, 10_000)),
      ],
    });

    assert.equal(result.exitStatus, 'budget_exceeded');
    assert.equal(result.events.length, 4);
    assert.equal(result.tokens.length, 2);
    assert.ok(result.totalCost > 0.5, `totalCost ${result.totalCost} should exceed budget`);
    assert.ok(adapter.lastHandle!.aborted, 'handle.abort() was called');
    assert.ok(result.durationMs >= 0);
  });
});

describe('turn-limit enforcement', () => {
  it('aborts after maxTurns step events and reports turn_limit', async () => {
    const driver = mockDriver(new MockAdapter());
    const result = await driver.run('mock', {
      prompt: 'hi',
      budget: { maxTurns: 2 },
      scriptedEvents: [ev.step(), ev.step(), ev.step(), ev.step()],
    });
    assert.equal(result.exitStatus, 'turn_limit');
    assert.equal(result.events.length, 3); // third step crosses the ceiling
  });

  it('skips its own enforcement when the adapter declares enforcesBudget', async () => {
    const driver = mockDriver(new MockAdapter(true));
    const result = await driver.run('mock', {
      prompt: 'hi',
      budget: { maxTurns: 2 },
      scriptedEvents: [ev.step(), ev.step(), ev.step()],
    });
    assert.equal(result.exitStatus, 'success');
    assert.equal(result.events.length, 3);
  });
});

describe('success path and transcripts', () => {
  it('collects events, prices tokens, and streams NDJSON to stateDir/raw', async () => {
    const stateDir = tmpStateDir();
    const driver = createDriver({ adapters: { mock: new MockAdapter() }, stateDir });
    const result = await driver.run('mock', {
      prompt: 'hi',
      scriptedEvents: [ev.step(), ev.usage('mock', claudeUsage(1_000_000, 0)), ev.usage('mock', { tokenUsage: { inputTokens: 5, outputTokens: 5 } })],
    });

    assert.equal(result.exitStatus, 'success');
    assert.equal(result.totalCost, 3); // 1M input tokens at $3/1M
    assert.match(result.sessionId, /^mock-/);
    assert.equal(result.tokens[0]?.model, 'claude-sonnet-4');
    assert.equal(result.tokens[1]?.model, 'unknown'); // kiro fixture lacks a model name

    const rawPath = join(stateDir, 'raw', `mock-${result.sessionId}.jsonl`);
    const lines = readFileSync(rawPath, 'utf8').trim().split('\n');
    assert.equal(lines.length, result.events.length);
    result.events.forEach((event, i) => assert.deepEqual(JSON.parse(lines[i]!), event));
  });

  it('carries pre-normalized usage events through pricing unchanged', async () => {
    const driver = mockDriver(new MockAdapter());
    const result = await driver.run('mock', {
      prompt: 'hi',
      scriptedEvents: [
        ev.preNormalized({
          inputTokens: 150,
          outputTokens: 30,
          cacheReadTokens: 50,
          cacheWriteTokens: 0,
          model: 'gpt-5',
        }),
      ],
    });
    assert.equal(result.exitStatus, 'success');
    const rec = result.tokens[0];
    assert.ok(rec);
    assert.equal(rec.model, 'gpt-5');
    assert.equal(rec.inputTokens, 150);
    assert.equal(rec.outputTokens, 30);
    assert.equal(rec.cacheReadTokens, 50);
    // 150 in * $1.25/1M + 30 out * $10/1M + 50 cached * $0.125/1M
    assert.ok(Math.abs(result.totalCost - (0.0001875 + 0.0003 + 0.00000625)) < 1e-12);
  });

  it('prices a multi-model claude record via its per-model breakdown ($0.1028, not haiku-priced $0.0214)', async () => {
    const driver = mockDriver(new MockAdapter());
    // Real aggregate from a claude opus-5 run: label/first model was haiku
    // (a 950-token probe), but opus-5[1m] carried ~99% of the cost.
    const result = await driver.run('mock', {
      prompt: 'hi',
      scriptedEvents: [
        ev.preNormalized({
          agent: 'claude',
          model: 'claude-haiku-4-5-20251001',
          inputTokens: 954,
          outputTokens: 1671,
          cacheReadTokens: 26282,
          cacheWriteTokens: 7544,
          reasoningTokens: 55,
          extra: {
            raw: {
              input: 954,
              output: 1671,
              cacheRead: 26282,
              cacheWrite: 7544,
              reasoning: 55,
              models: [
                { model: 'claude-haiku-4-5-20251001', input: 950, output: 11, cacheRead: 0, cacheWrite: 0, reasoning: 0, costUsd: 0.001005 },
                { model: 'claude-opus-5[1m]', input: 4, output: 1660, cacheRead: 26282, cacheWrite: 7544, reasoning: 55, costUsd: 0.101811 },
              ],
            },
          },
        }),
      ],
    });
    assert.equal(result.exitStatus, 'success');
    assert.equal(result.tokens.length, 1);
    // Aggregate tokens stay intact (the haiku probe was a real API call) but
    // totalCost is the per-model sum, never the aggregate priced as haiku.
    assert.ok(Math.abs(result.totalCost - 0.102816) < 1e-12, `totalCost=${result.totalCost}`);
  });

  it('preserves producer extras (kiro tap credits in extra.credits) on collected records', async () => {
    const driver = mockDriver(new MockAdapter());
    const result: RunResult = await driver.run('mock', {
      prompt: 'hi',
      scriptedEvents: [
        ev.preNormalized({ inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, extra: { credits: 0.05, event: 'meteringEvent' } }),
        ev.preNormalized({ inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, extra: { credits: 0.07 } }),
      ],
    });
    assert.equal(result.exitStatus, 'success');
    assert.equal(result.tokens.length, 2);
    assert.equal(result.tokens[0]?.extra?.credits, 0.05);
    assert.equal(result.tokens[1]?.extra?.credits, 0.07);
    // Credits are metering units, never priced into totalCost.
    assert.equal(result.totalCost, 0);
  });

  it('warns but keeps running on unpriced models (cost contributes 0, never silent)', async () => {
    const driver = mockDriver(new MockAdapter());
    const result = await driver.run('mock', {
      prompt: 'hi',
      scriptedEvents: [ev.usage('mock', { tokenUsage: { inputTokens: 5, outputTokens: 5 }, model: 'mystery-model' })],
    });
    assert.equal(result.totalCost, 0);
    assert.equal(result.tokens.length, 1);
    assert.ok(result.warnings.some((w) => /unknown model "mystery-model"/.test(w)));
  });
});

describe('registry', () => {
  it('throws on an unregistered agent', async () => {
    const driver = createDriver({ adapters: {}, stateDir: tmpStateDir() });
    await assert.rejects(() => driver.run('nope', { prompt: 'x' }), /unknown agent "nope"/);
  });

  it('rejects malformed specs', async () => {
    const driver = mockDriver(new MockAdapter());
    await assert.rejects(() => driver.run('mock', { prompt: 42 as unknown as string }));
    await assert.rejects(() => driver.run('mock', { prompt: 'x', budget: { usd: -1 } }));
  });

  it('defaultAdapters instantiates every bundled adapter class and bridges launch()', async () => {
    const warnings: string[] = [];
    const original = console.warn;
    console.warn = (msg?: unknown) => warnings.push(String(msg));
    let adapters: Record<string, AgentAdapter>;
    try {
      adapters = await defaultAdapters();
    } finally {
      console.warn = original;
    }
    assert.deepEqual(Object.keys(adapters).sort(), ['claude', 'codex', 'gemini', 'kiro', 'opencode']);
    assert.equal(warnings.length, 0);
    for (const [name, adapter] of Object.entries(adapters)) {
      assert.equal(adapter.name, name, `adapter "${name}" carries its name`);
      assert.equal(typeof adapter.launch, 'function', `adapter "${name}" exposes launch()`);
    }
    // claude passes --max-turns itself, so its bridge must declare it.
    assert.equal(adapters.claude?.enforcesBudget, true);
  });
});

// ---------------------------------------------------------------------------
// Driver → run registry hook (seat D2 owns the wiring; expected to fail until
// createDriver honors options.registry). The stub adapter is constructed
// locally: a session event (sessionId), one usage event (token totals), and a
// clean success exit — the minimal stream that finalizes a RunRecord.
// ---------------------------------------------------------------------------

class RegistryStubHandle implements AgentHandle {
  readonly sessionId = 'regstub-session-1';
  aborted = false;

  async *attach(): AsyncIterable<AgentEvent> {
    const ts = Date.now();
    yield { type: 'session', sessionId: this.sessionId, timestamp: ts };
    yield {
      type: 'usage',
      usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 },
      sessionId: this.sessionId,
      timestamp: ts,
    };
  }

  abort(): void {
    this.aborted = true;
  }

  async wait(): Promise<'aborted' | 'success'> {
    return this.aborted ? 'aborted' : 'success';
  }
}

class RegistryStubAdapter implements AgentAdapter {
  readonly name = 'regstub';

  async launch(): Promise<AgentHandle> {
    return new RegistryStubHandle();
  }
}

describe('driver → run registry hook', () => {
  it('finalizes a RunRecord file with status success and token totals when registry.stateDir is set', async () => {
    const regDir = tmpStateDir();
    const driver = createDriver({
      adapters: { regstub: new RegistryStubAdapter() },
      stateDir: tmpStateDir(),
      registry: { stateDir: regDir },
    });
    const result: RunResult = await driver.run('regstub', { prompt: 'record me' });
    assert.equal(result.exitStatus, 'success');

    const files = readdirSync(join(regDir, 'runs')).filter((f) => f.endsWith('.json'));
    assert.equal(files.length, 1, `expected exactly one run record, got: ${files.join(', ')}`);
    const recs = listRunRecords(regDir);
    assert.equal(recs.length, 1);
    const record = recs[0];
    assert.equal(record.runId, files[0].replace(/\.json$/, ''));
    assert.equal(record.agent, 'regstub');
    assert.equal(record.status, 'success');
    assert.equal(record.exitStatus, 'success');
    assert.equal(record.totals.inputTokens, 100);
    assert.equal(record.totals.outputTokens, 20);
    assert.ok(record.rawTranscript.endsWith('.jsonl'), `rawTranscript: ${record.rawTranscript}`);
  });
});
