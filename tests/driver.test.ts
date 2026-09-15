import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
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

// ---------------------------------------------------------------------------
// Wall-clock / idle budget enforcement (budget.wallMs / budget.idleMs). The
// stub handles model the two hang shapes: a stream that goes silent after one
// event (idle trip) and a stream that keeps emitting forever (wall trip).
// ---------------------------------------------------------------------------

class SilentThenHangHandle implements AgentHandle {
  readonly sessionId = 'silent-hang-1';
  aborted = false;
  #wake?: () => void;

  async *attach(): AsyncIterable<AgentEvent> {
    yield { type: 'step', sessionId: this.sessionId, timestamp: Date.now() };
    // Go silent forever; only abort() ends the stream.
    await new Promise<void>((resolve) => {
      this.#wake = resolve;
    });
  }

  abort(): void {
    this.aborted = true;
    this.#wake?.();
  }

  async wait(): Promise<'aborted' | 'success'> {
    return this.aborted ? 'aborted' : 'success';
  }
}

class SilentThenHangAdapter implements AgentAdapter {
  readonly name = 'silent-hang';
  lastHandle?: SilentThenHangHandle;

  async launch(): Promise<AgentHandle> {
    this.lastHandle = new SilentThenHangHandle();
    return this.lastHandle;
  }
}

class HeartbeatHandle implements AgentHandle {
  readonly sessionId = 'heartbeat-1';
  aborted = false;
  #abortWakers: Array<() => void> = [];

  async *attach(): AsyncIterable<AgentEvent> {
    while (!this.aborted) {
      yield { type: 'step', sessionId: this.sessionId, timestamp: Date.now() };
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 50);
        this.#abortWakers.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }

  abort(): void {
    this.aborted = true;
    for (const wake of this.#abortWakers.splice(0)) wake();
  }

  async wait(): Promise<'aborted' | 'success'> {
    return this.aborted ? 'aborted' : 'success';
  }
}

class HeartbeatAdapter implements AgentAdapter {
  readonly name = 'heartbeat';
  lastHandle?: HeartbeatHandle;

  async launch(): Promise<AgentHandle> {
    this.lastHandle = new HeartbeatHandle();
    return this.lastHandle;
  }
}

describe('wall/idle budget enforcement', () => {
  it('aborts a silent stream after idleMs and reports timeout with the idle warning', async () => {
    const adapter = new SilentThenHangAdapter();
    const driver = createDriver({ adapters: { 'silent-hang': adapter }, stateDir: tmpStateDir() });
    const started = Date.now();
    const result: RunResult = await driver.run('silent-hang', {
      prompt: 'hi',
      budget: { idleMs: 200 },
    });

    assert.equal(result.exitStatus, 'timeout');
    assert.ok(result.warnings.some((w) => w === 'budget: idle 200ms exceeded (no events)'), result.warnings.join(' | '));
    assert.ok(adapter.lastHandle!.aborted, 'handle.abort() was called');
    assert.ok(result.durationMs < 2000, `durationMs ${result.durationMs} should be well under 2s`);
    assert.ok(Date.now() - started < 2000);
    assert.equal(result.events.length, 1); // the one event before silence
  });

  it('aborts an event stream after wallMs and reports timeout with the wall-clock warning', async () => {
    const adapter = new HeartbeatAdapter();
    const driver = createDriver({ adapters: { heartbeat: adapter }, stateDir: tmpStateDir() });
    const result: RunResult = await driver.run('heartbeat', {
      prompt: 'hi',
      budget: { wallMs: 300 },
    });

    assert.equal(result.exitStatus, 'timeout');
    assert.ok(result.warnings.some((w) => w === 'budget: wall-clock 300ms exceeded'), result.warnings.join(' | '));
    assert.ok(adapter.lastHandle!.aborted, 'handle.abort() was called');
    assert.ok(result.durationMs < 2000, `durationMs ${result.durationMs} should be well under 2s`);
    // Events kept flowing until the wall clock cut the run off (~every 50ms).
    assert.ok(result.events.length >= 3, `expected several heartbeats, got ${result.events.length}`);
  });

  it('maps timeout exits to registry status aborted while keeping exitStatus timeout', async () => {
    const regDir = tmpStateDir();
    const driver = createDriver({
      adapters: { 'silent-hang': new SilentThenHangAdapter() },
      stateDir: tmpStateDir(),
      registry: { stateDir: regDir },
    });
    const result: RunResult = await driver.run('silent-hang', {
      prompt: 'hi',
      budget: { idleMs: 200 },
    });
    assert.equal(result.exitStatus, 'timeout');
    const recs = listRunRecords(regDir);
    assert.equal(recs.length, 1);
    assert.equal(recs[0]!.status, 'aborted');
    assert.equal(recs[0]!.exitStatus, 'timeout');
  });
});

// ---------------------------------------------------------------------------
// Kiro usage truth (PLAN-kiro-acp.md § Usage availability + amendment
// 2026-09-12). A fake adapter registered under the name `kiro` emits exactly
// the event shapes src/adapters/kiro-events.ts produces: credits-only `usage`
// records tagged `extra.tokensAvailable:false`, chunk/vendor `step` events
// tagged `payload.countsAsTurn:false`, and the native turn terminator
// `payload.kind === 'runFinished'`. The session store is faked on disk via
// KIRO_SESSIONS_DIR using the real sanitized fixture.
// ---------------------------------------------------------------------------

type KiroScripted = { type: 'step'; payload: Record<string, unknown> } | { type: 'usage'; usage: CanonicalTokenRecord };

class KiroMockHandle implements AgentHandle {
  aborted = false;
  readonly #events: KiroScripted[];
  readonly #done: Promise<void>;
  #markDone!: () => void;

  constructor(readonly sessionId: string, events: KiroScripted[]) {
    this.#events = events;
    this.#done = new Promise<void>((resolve) => {
      this.#markDone = resolve;
    });
  }

  async *attach(): AsyncIterable<AgentEvent> {
    try {
      for (const e of this.#events) {
        const ts = Date.now();
        if (e.type === 'step') yield { type: 'step', payload: e.payload, sessionId: this.sessionId, timestamp: ts };
        else yield { type: 'usage', usage: e.usage, sessionId: this.sessionId, timestamp: ts };
      }
    } finally {
      this.#markDone();
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

class KiroMockAdapter implements AgentAdapter {
  readonly name = 'kiro';
  lastHandle?: KiroMockHandle;
  constructor(readonly sessionId: string) {}
  async launch(spec: RunSpec): Promise<AgentHandle> {
    const handle = new KiroMockHandle(this.sessionId, (spec as { kiroEvents?: KiroScripted[] }).kiroEvents ?? []);
    this.lastHandle = handle;
    return handle;
  }
}

const kiroFixture = readFileSync(
  join(dirname(new URL(import.meta.url).pathname), 'fixtures', 'kiro', 'session-store-haiku.json'),
  'utf8',
);
/** Credits the haiku fixture really charges, summed from the raw JSON. */
const FIXTURE_CREDITS = (
  JSON.parse(kiroFixture).session_state.conversation_metadata.user_turn_metadatas as Array<{
    metering_usage: Array<{ value: number }>;
  }>
).reduce((sum, t) => sum + t.metering_usage.reduce((a, m) => a + m.value, 0), 0);
const FIXTURE_PCT = JSON.parse(kiroFixture).session_state.conversation_metadata.user_turn_metadatas[0]
  .final_context_usage_percentage as number;
const FIXTURE_WINDOW = JSON.parse(kiroFixture).session_state.rts_model_state.model_info
  .context_window_tokens as number;
const FIXTURE_CTX_TOKENS = Math.round((FIXTURE_PCT / 100) * FIXTURE_WINDOW);

/** Plant the fixture as <tmp>/<uuid>.json and point KIRO_SESSIONS_DIR at it. */
function seedKiroSessionStore(uuid: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'kiro-sessions-'));
  writeFileSync(join(dir, `${uuid}.json`), kiroFixture);
  process.env.KIRO_SESSIONS_DIR = dir;
  return dir;
}

function kiroUsage(over: Record<string, unknown> = {}): KiroScripted {
  return {
    type: 'usage',
    usage: {
      agent: 'kiro',
      model: 'unknown',
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      timestamp: Date.now(),
      extra: {
        credits: FIXTURE_CREDITS,
        creditsCumulative: FIXTURE_CREDITS,
        source: 'native',
        tokensAvailable: false,
        contextUsagePercentage: FIXTURE_PCT,
        ...over,
      },
    } as CanonicalTokenRecord,
  };
}

const kiroChunk = (): KiroScripted => ({ type: 'step', payload: { kind: 'chunk', countsAsTurn: false } });
const kiroTurnEnd = (): KiroScripted => ({
  type: 'step',
  payload: { kind: 'runFinished', countsAsTurn: false, status: 'ok' },
});

describe('kiro usage truth', () => {
  const previousSessionsDir = process.env.KIRO_SESSIONS_DIR;
  afterEach(() => {
    if (previousSessionsDir === undefined) delete process.env.KIRO_SESSIONS_DIR;
    else process.env.KIRO_SESSIONS_DIR = previousSessionsDir;
  });

  it('reports tokens/usd unavailable, credits reconciled, and context derived from the session store', async () => {
    const uuid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    seedKiroSessionStore(uuid);
    const regDir = tmpStateDir();
    const driver = createDriver({
      adapters: { kiro: new KiroMockAdapter(`kiro-${uuid}`) },
      stateDir: tmpStateDir(),
      registry: { stateDir: regDir },
    });

    const result = await driver.run('kiro', {
      prompt: 'ping',
      kiroEvents: [kiroChunk(), kiroUsage(), kiroTurnEnd()],
    });

    assert.equal(result.exitStatus, 'success');
    // The credits-only record is KEPT as evidence...
    assert.equal(result.tokens.length, 1);
    // ...and the session-store model backfills the 'unknown' placeholder.
    assert.equal(result.tokens[0]!.model, 'claude-haiku-4.5');

    assert.equal(result.usage?.tokens.available, false);
    assert.equal(result.usage?.usd.available, false);
    assert.equal(result.usage?.credits.available, true);
    assert.equal(result.usage?.credits.value, FIXTURE_CREDITS);
    // The only usage record is kiro's OWN metadata frame (extra.source:
    // 'native'); it is the stream figure, not a tap observation, so no
    // `tap` source is reported and nothing is double-counted.
    assert.deepEqual(result.usage?.credits.sources, {
      stream: FIXTURE_CREDITS,
      'session-store': FIXTURE_CREDITS,
    });
    assert.equal(result.usage?.context?.available, true);
    assert.equal(result.usage?.context?.windowSource, 'session-store');
    assert.equal(result.usage?.context?.tokens, FIXTURE_CTX_TOKENS);

    // Registry: zero token counters (never bumped by a placeholder record),
    // credits summed, derived context recorded, usage mirrored.
    const recs = listRunRecords(regDir);
    assert.equal(recs.length, 1);
    const totals = recs[0]!.totals;
    assert.equal(totals.inputTokens, 0);
    assert.equal(totals.outputTokens, 0);
    assert.equal(totals.cacheReadTokens, 0);
    assert.equal(totals.cacheWriteTokens, 0);
    assert.equal(totals.credits, FIXTURE_CREDITS);
    assert.equal(totals.contextTokens, FIXTURE_CTX_TOKENS);
    assert.equal(recs[0]!.usage?.tokens.available, false);
  });

  it('registry credits prefer the native figure over the tap sum when both observe one charge', async () => {
    // Headless + MITM tap: kiro's metadata frame (native) and the tap's
    // meteringEvent both report the SAME charge. Summing them doubled the
    // registry credits and raised a stream-vs-tap disagreement warning.
    const uuid = 'cccccccc-dddd-eeee-ffff-000000000000';
    seedKiroSessionStore(uuid);
    const regDir = tmpStateDir();
    const driver = createDriver({
      adapters: { kiro: new KiroMockAdapter(`kiro-${uuid}`) },
      stateDir: tmpStateDir(),
      registry: { stateDir: regDir },
    });

    const result = await driver.run('kiro', {
      prompt: 'ping',
      kiroEvents: [
        kiroChunk(),
        kiroUsage(),
        kiroUsage({ source: 'tap', creditsCumulative: undefined }),
        kiroTurnEnd(),
      ],
    });

    assert.equal(result.exitStatus, 'success');
    assert.deepEqual(result.usage?.credits.sources, {
      stream: FIXTURE_CREDITS,
      'session-store': FIXTURE_CREDITS,
      tap: FIXTURE_CREDITS,
    });
    assert.equal(result.usage?.credits.value, FIXTURE_CREDITS);
    assert.deepEqual(
      result.warnings.filter((w) => /credit/i.test(w)),
      [],
      'native and tap agree, so no disagreement warning',
    );
    assert.deepEqual(
      result.warnings.filter((w) => /pricing/i.test(w)),
      [],
      'a credits-only record must not be priced (no "unknown model" warning)',
    );

    const totals = listRunRecords(regDir)[0]!.totals;
    assert.equal(totals.credits, FIXTURE_CREDITS, 'registry credits are the native figure, not native + tap');
  });

  it('locates the session store from a usage record extra.kiroSessionId when no registry exists', async () => {
    const uuid = '11111111-2222-3333-4444-555555555555';
    seedKiroSessionStore(uuid);
    const driver = createDriver({
      adapters: { kiro: new KiroMockAdapter('') },
      stateDir: tmpStateDir(),
    });
    const result = await driver.run('kiro', {
      prompt: 'ping',
      kiroEvents: [kiroUsage({ kiroSessionId: uuid })],
    });
    assert.equal(result.usage?.context?.windowSource, 'session-store');
    assert.equal(result.usage?.context?.tokens, FIXTURE_CTX_TOKENS);
  });

  it('does NOT count chunk steps toward maxTurns, but DOES count runFinished steps', async () => {
    seedKiroSessionStore('no-such-session');

    const chunky = createDriver({ adapters: { kiro: new KiroMockAdapter('kiro-x') }, stateDir: tmpStateDir() });
    const notTripped = await chunky.run('kiro', {
      prompt: 'ping',
      budget: { maxTurns: 1 },
      kiroEvents: [kiroChunk(), kiroChunk(), kiroChunk(), kiroChunk()],
    });
    assert.equal(notTripped.exitStatus, 'success');
    assert.equal(notTripped.events.length, 4);

    const turnful = createDriver({ adapters: { kiro: new KiroMockAdapter('kiro-x') }, stateDir: tmpStateDir() });
    const tripped = await turnful.run('kiro', {
      prompt: 'ping',
      budget: { maxTurns: 1 },
      kiroEvents: [kiroChunk(), kiroTurnEnd(), kiroChunk(), kiroTurnEnd(), kiroTurnEnd()],
    });
    assert.equal(tripped.exitStatus, 'turn_limit');
  });

  it('warns that a usd budget cannot be enforced for kiro', async () => {
    seedKiroSessionStore('no-such-session');
    const driver = createDriver({ adapters: { kiro: new KiroMockAdapter('kiro-x') }, stateDir: tmpStateDir() });
    const result = await driver.run('kiro', { prompt: 'ping', budget: { usd: 5 }, kiroEvents: [kiroUsage()] });
    assert.ok(
      result.warnings.includes(
        'budget: usd cap is not enforceable for kiro (credits only); wall/idle/maxTurns still apply',
      ),
      result.warnings.join(' | '),
    );
    assert.equal(result.exitStatus, 'success'); // the cap never fires
  });

  it('warns when a kiro run produced no usage records at all', async () => {
    seedKiroSessionStore('no-such-session');
    const driver = createDriver({ adapters: { kiro: new KiroMockAdapter('kiro-x') }, stateDir: tmpStateDir() });
    const result = await driver.run('kiro', { prompt: 'ping', kiroEvents: [kiroChunk()] });
    assert.ok(
      result.warnings.includes('kiro: no usage records; tokens/credits/usd unavailable'),
      result.warnings.join(' | '),
    );
    assert.equal(result.usage?.credits.available, false);
    assert.equal(result.usage?.context?.available, false);
  });

  it('attaches the adapter kiro() hook result to RunResult.kiro when the handle exposes one', async () => {
    seedKiroSessionStore('no-such-session');
    const adapter = new KiroMockAdapter('kiro-x');
    const driver = createDriver({ adapters: { kiro: adapter }, stateDir: tmpStateDir() });
    const originalLaunch = adapter.launch.bind(adapter);
    adapter.launch = async (spec: RunSpec) => {
      const handle = await originalLaunch(spec);
      (handle as { kiro?: () => unknown }).kiro = () => ({ transport: 'acp', modelAck: 'acknowledged' });
      return handle;
    };
    const result = await driver.run('kiro', { prompt: 'ping', kiroEvents: [kiroUsage()] });
    assert.deepEqual(result.kiro, { transport: 'acp', modelAck: 'acknowledged' } as never);
  });

  it('surfaces a rejected --model (modelAck unsupported) as exactly one warning', async () => {
    seedKiroSessionStore('no-such-session');
    const driver = createDriver({ adapters: { kiro: new KiroMockAdapter('kiro-x') }, stateDir: tmpStateDir() });
    const ack = (): KiroScripted => ({
      type: 'step',
      payload: {
        kind: 'modelAck',
        transport: 'headless',
        countsAsTurn: false,
        modelAck: 'unsupported',
        model: 'claude-haiku-4.5',
        raw: "[warn] failed to set model 'claude-haiku-4.5': Method not found",
      },
    });
    const result = await driver.run('kiro', {
      prompt: 'ping',
      model: 'claude-haiku-4.5',
      kiroEvents: [ack(), kiroChunk(), ack(), kiroUsage(), kiroTurnEnd()],
    });
    assert.deepEqual(
      result.warnings.filter((w) => /requested model/.test(w)),
      [
        "kiro: requested model 'claude-haiku-4.5' was not applied (kiro-cli rejected --model: Method not found); the run used the CLI default",
      ],
      result.warnings.join(' | '),
    );
  });

  it('forwards a stderrNotice warning into result.warnings once even when emitted twice', async () => {
    seedKiroSessionStore('no-such-session');
    const driver = createDriver({ adapters: { kiro: new KiroMockAdapter('kiro-x') }, stateDir: tmpStateDir() });
    const notice = (): KiroScripted => ({
      type: 'step',
      payload: {
        kind: 'stderrNotice',
        transport: 'headless',
        countsAsTurn: false,
        notice: 'mcpLoadFailed',
        warning: 'kiro: mcp server "foo" failed to load',
        raw: '[warn] mcp foo failed',
      },
    });
    const result = await driver.run('kiro', { prompt: 'ping', kiroEvents: [notice(), notice(), kiroUsage()] });
    assert.deepEqual(
      result.warnings.filter((w) => /failed to load/.test(w)),
      ['kiro: mcp server "foo" failed to load'],
      result.warnings.join(' | '),
    );
  });

  it('warns when the session store recorded a different model than the run requested', async () => {
    // The fixture store records claude-haiku-4.5; the run asked for sonnet and
    // no modelAck step was emitted (the ACP silent-drop shape).
    const uuid = '99999999-8888-7777-6666-555555555555';
    seedKiroSessionStore(uuid);
    const driver = createDriver({ adapters: { kiro: new KiroMockAdapter('') }, stateDir: tmpStateDir() });
    const result = await driver.run('kiro', {
      prompt: 'ping',
      model: 'claude-sonnet-4.5',
      kiroEvents: [kiroUsage({ kiroSessionId: uuid }), kiroTurnEnd()],
    });
    assert.deepEqual(
      result.warnings.filter((w) => /requested model/.test(w)),
      ["kiro: requested model 'claude-sonnet-4.5' but the session store recorded 'claude-haiku-4.5'"],
      result.warnings.join(' | '),
    );
  });

  it('control: no modelAck step and no model request yields no model warning', async () => {
    seedKiroSessionStore('no-such-session');
    const driver = createDriver({ adapters: { kiro: new KiroMockAdapter('kiro-x') }, stateDir: tmpStateDir() });
    const result = await driver.run('kiro', { prompt: 'ping', kiroEvents: [kiroChunk(), kiroUsage(), kiroTurnEnd()] });
    assert.deepEqual(
      result.warnings.filter((w) => /requested model/.test(w)),
      [],
      result.warnings.join(' | '),
    );
  });

  it('leaves non-kiro agents counting every step as a turn', async () => {
    const driver = mockDriver(new MockAdapter());
    const result = await driver.run('mock', {
      prompt: 'hi',
      budget: { maxTurns: 2 },
      scriptedEvents: [ev.step(), ev.step(), ev.step(), ev.step()],
    });
    assert.equal(result.exitStatus, 'turn_limit');
  });
});

describe('driver onOutput raw-stdout tap forwarding', () => {
  /** Adapter that records the launch spec and resolves immediately. */
  class SpecCaptureAdapter implements AgentAdapter {
    readonly name = 'specap';
    lastSpec?: RunSpec;
    async launch(spec: RunSpec): Promise<AgentHandle> {
      this.lastSpec = spec;
      return new MockHandle([]);
    }
  }

  it('forwards DriverOptions.onOutput into the adapter launch spec', async () => {
    const adapter = new SpecCaptureAdapter();
    const driver = createDriver({ adapters: { specap: adapter }, stateDir: tmpStateDir(), onOutput: () => {} });
    await driver.run('specap', { prompt: 'hi' });
    assert.equal(typeof adapter.lastSpec?.onOutput, 'function', 'driver-level tap reached the adapter');
  });

  it('a per-run RunSpec.onOutput overrides the driver-level tap', async () => {
    const adapter = new SpecCaptureAdapter();
    const driverTap = (): void => {};
    const runTap = (): void => {};
    const driver = createDriver({ adapters: { specap: adapter }, stateDir: tmpStateDir(), onOutput: driverTap });
    await driver.run('specap', { prompt: 'hi', onOutput: runTap });
    assert.equal(adapter.lastSpec?.onOutput, runTap, 'spec tap wins');
    assert.notEqual(adapter.lastSpec?.onOutput, driverTap);
  });

  it('launch spec carries no onOutput when neither source provides one', async () => {
    const adapter = new SpecCaptureAdapter();
    const driver = createDriver({ adapters: { specap: adapter }, stateDir: tmpStateDir() });
    await driver.run('specap', { prompt: 'hi' });
    assert.equal(adapter.lastSpec?.onOutput, undefined);
  });
});

// Watchdog-style timeout/cancellation run shape (#5): top-level timeoutMs /
// idleTimeoutMs aliases plus out-of-band driver.abort(runId).
describe('timeoutMs / idleTimeoutMs aliases and driver.abort(runId)', () => {
  it('timeoutMs acts as budget.wallMs (wall-clock cap)', async () => {
    const adapter = new HeartbeatAdapter();
    const driver = createDriver({ adapters: { heartbeat: adapter }, stateDir: tmpStateDir() });
    const result: RunResult = await driver.run('heartbeat', { prompt: 'hi', timeoutMs: 300 });
    assert.equal(result.exitStatus, 'timeout');
    assert.ok(result.warnings.some((w) => w === 'budget: wall-clock 300ms exceeded'), result.warnings.join(' | '));
    assert.ok(adapter.lastHandle!.aborted, 'handle.abort() was called');
  });

  it('idleTimeoutMs acts as budget.idleMs (no-event cap)', async () => {
    const adapter = new SilentThenHangAdapter();
    const driver = createDriver({ adapters: { 'silent-hang': adapter }, stateDir: tmpStateDir() });
    const result: RunResult = await driver.run('silent-hang', { prompt: 'hi', idleTimeoutMs: 200 });
    assert.equal(result.exitStatus, 'timeout');
    assert.ok(result.warnings.some((w) => w === 'budget: idle 200ms exceeded (no events)'), result.warnings.join(' | '));
  });

  it('an explicit budget.wallMs wins over the timeoutMs alias', async () => {
    const adapter = new HeartbeatAdapter();
    const driver = createDriver({ adapters: { heartbeat: adapter }, stateDir: tmpStateDir() });
    const result: RunResult = await driver.run('heartbeat', {
      prompt: 'hi',
      budget: { wallMs: 250 },
      timeoutMs: 60_000,
    });
    assert.equal(result.exitStatus, 'timeout');
    // The alias (60s) never fired; the run ended at the explicit 250ms cap.
    assert.ok(result.warnings.some((w) => w === 'budget: wall-clock 250ms exceeded'), result.warnings.join(' | '));
    // Generous margin: under load the timer callback can overshoot the cap.
    assert.ok(result.durationMs < 5000, `durationMs ${result.durationMs} should be well under 5s`);
  });

  it('driver.abort(runId) cancels an in-flight run and resolves it as aborted', async () => {
    const adapter = new SilentThenHangAdapter();
    const driver = createDriver({ adapters: { 'silent-hang': adapter }, stateDir: tmpStateDir() });
    const pending = driver.run('silent-hang', { prompt: 'hi', runId: 'watchdog-1' });
    await new Promise((r) => setTimeout(r, 25)); // let launch() + attach() start
    assert.equal(driver.abort('watchdog-1'), true, 'active run matched');
    assert.equal(driver.abort('no-such-run'), false, 'unknown run id rejected');
    const result = await pending;
    assert.equal(result.exitStatus, 'aborted');
    assert.ok(adapter.lastHandle!.aborted, 'adapter handle was signalled');
    assert.equal(result.runId, 'watchdog-1', 'caller-chosen runId echoed back');
  });
});

// ---------------------------------------------------------------------------
// installSignalAbort (#11): opt-in SIGTERM/SIGINT → abort(runId) wiring.
// These tests NEVER raise a real signal in the test process — they diff
// process.listeners(sig) around the install call to capture the exact handler
// this call registered, then invoke that handler directly.
// ---------------------------------------------------------------------------

describe('installSignalAbort (signal-based abort helper)', () => {
  const sigListeners = (sig: NodeJS.Signals): Array<() => void> =>
    process.listeners(sig) as Array<() => void>;

  it('first signal aborts the run, self-uninstalls, and the disposer stays a no-op', async () => {
    const preTerm = new Set(sigListeners('SIGTERM'));
    const preInt = new Set(sigListeners('SIGINT'));
    const adapter = new SilentThenHangAdapter();
    const driver = createDriver({ adapters: { 'silent-hang': adapter }, stateDir: tmpStateDir() });
    const dispose = driver.installSignalAbort('sig-1');
    assert.equal(sigListeners('SIGTERM').length, preTerm.size + 1, 'one SIGTERM handler added');
    assert.equal(sigListeners('SIGINT').length, preInt.size + 1, 'one SIGINT handler added');
    const oursTerm = sigListeners('SIGTERM').find((fn) => !preTerm.has(fn));
    const oursInt = sigListeners('SIGINT').find((fn) => !preInt.has(fn));
    assert.ok(oursTerm && oursInt, 'captured the newly installed handlers');
    assert.equal(oursTerm, oursInt, 'one shared handler across both signals');

    const pending = driver.run('silent-hang', { prompt: 'hi', runId: 'sig-1' });
    await new Promise((r) => setTimeout(r, 25)); // let launch() + attach() start

    oursTerm!(); // simulate SIGTERM delivery to the captured handler
    const result: RunResult = await pending;
    assert.equal(result.exitStatus, 'aborted');
    assert.ok(adapter.lastHandle!.aborted, 'signal handler called driver.abort(runId)');

    // One-shot: both listeners are gone after the first fire, so later
    // signals fall through to Node's default semantics (no eternal swallow).
    assert.equal(sigListeners('SIGTERM').length, preTerm.size, 'SIGTERM handler self-removed');
    assert.equal(sigListeners('SIGINT').length, preInt.size, 'SIGINT handler self-removed');
    // Disposer after the self-uninstall must not throw or double-remove.
    dispose();
    assert.equal(sigListeners('SIGTERM').length, preTerm.size);
  });

  it('disposer removes exactly the installed listeners and is repeat-safe', () => {
    const preTerm = new Set(sigListeners('SIGTERM'));
    const preInt = new Set(sigListeners('SIGINT'));
    const driver = createDriver({ adapters: {}, stateDir: tmpStateDir() });
    const dispose = driver.installSignalAbort('sig-dispose');
    assert.equal(sigListeners('SIGTERM').length, preTerm.size + 1);
    assert.equal(sigListeners('SIGINT').length, preInt.size + 1);
    dispose();
    assert.equal(sigListeners('SIGTERM').length, preTerm.size, 'SIGTERM listener removed');
    assert.equal(sigListeners('SIGINT').length, preInt.size, 'SIGINT listener removed');
    dispose(); // idempotent: removing an absent listener is a no-op
    assert.equal(sigListeners('SIGTERM').length, preTerm.size);
    assert.equal(sigListeners('SIGINT').length, preInt.size);
  });

  it('honors a custom signals list', () => {
    const preHup = new Set(sigListeners('SIGHUP'));
    const preTerm = new Set(sigListeners('SIGTERM'));
    const driver = createDriver({ adapters: {}, stateDir: tmpStateDir() });
    const dispose = driver.installSignalAbort('sig-hup', ['SIGHUP']);
    assert.equal(sigListeners('SIGHUP').length, preHup.size + 1, 'SIGHUP handler added');
    assert.equal(sigListeners('SIGTERM').length, preTerm.size, 'defaults NOT installed');
    dispose();
    assert.equal(sigListeners('SIGHUP').length, preHup.size);
  });

  it('each install is independent: firing one leaves the other installed and untouched', async () => {
    const adapterA = new SilentThenHangAdapter();
    const adapterB = new SilentThenHangAdapter();
    const driver = createDriver({
      adapters: { a: adapterA, b: adapterB },
      stateDir: tmpStateDir(),
    });
    const preTerm = new Set(sigListeners('SIGTERM'));
    const disposeA = driver.installSignalAbort('run-a');
    const handlerA = sigListeners('SIGTERM').find((fn) => !preTerm.has(fn));
    assert.ok(handlerA, "captured A's handler");
    const disposeB = driver.installSignalAbort('run-b');
    assert.equal(sigListeners('SIGTERM').length, preTerm.size + 2, 'two installs → two handlers');

    const pendingA = driver.run('a', { prompt: 'hi', runId: 'run-a' });
    const pendingB = driver.run('b', { prompt: 'hi', runId: 'run-b' });
    await new Promise((r) => setTimeout(r, 25)); // let both launches start

    handlerA!(); // the signal reaches A's handler only
    const resultA = await pendingA;
    assert.equal(resultA.exitStatus, 'aborted');
    assert.ok(adapterA.lastHandle!.aborted, "A's run aborted");
    assert.ok(!adapterB.lastHandle!.aborted, "B's run untouched by A's signal");
    // A's one-shot removed only A's handler; B's is still installed.
    assert.equal(sigListeners('SIGTERM').length, preTerm.size + 1, "B's handler survives");

    // B ends via the normal abort path, then its own disposer cleans up.
    driver.abort('run-b');
    const resultB = await pendingB;
    assert.equal(resultB.exitStatus, 'aborted');
    disposeB();
    disposeA(); // already self-removed by its one-shot fire: harmless no-op
    assert.equal(sigListeners('SIGTERM').length, preTerm.size, 'no listener leaks');
  });
});
