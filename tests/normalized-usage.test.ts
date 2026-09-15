// Normalized usage/cost on the run result (issue #7): every adapter's native
// output -> driver -> result.usage.cost, one shape with no stdout re-parsing.
//
// Adapters with an injectable spawn seam (claude/opencode/codex/gemini) are
// driven END TO END through their real parsers and the shared driver bridge;
// kiro's credits-only lane is scripted with the exact record shape
// kiro-events emits (same convention as the kiro usage-truth tests in
// tests/driver.test.ts). Expected numbers are derived from the fixture lines
// below, not from the implementation.
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { SpawnOptions } from 'node:child_process';
import { describe, it } from 'node:test';
import { createDriver } from '../src/core/driver.ts';
import { ClaudeCodeAdapter } from '../src/adapters/claude.ts';
import { OpenCodeAdapter } from '../src/adapters/opencode.ts';
import { CodexAdapter } from '../src/adapters/codex.ts';
import { GeminiAdapter } from '../src/adapters/gemini.ts';
import { computeUsageAvailability } from '../src/core/usage-availability.ts';
import {
  ReportedUsageCostSchema,
  UsageAvailabilitySchema,
  type AgentAdapter,
  type AgentEvent,
  type AgentHandle,
  type CanonicalTokenRecord,
  type RunResult,
  type RunSpec,
} from '../src/core/types.ts';

// ---------------------------------------------------------------------------
// Fake child: satisfies both spawn seams (claude's HarnessChildProcess with
// `on`, shared.ts ChildProcessLike with `once`). Lines are fed on a microtask
// so every adapter has attached its stdout listeners first.
// ---------------------------------------------------------------------------

class FakeChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin = null;
  readonly pid = 424242;
  killed = false;

  kill(signal?: string | number | NodeJS.Signals): boolean {
    void signal;
    this.killed = true;
    queueMicrotask(() => this.emit('close', 143, null));
    return true;
  }

  feed(text: string): void {
    this.stdout.write(text);
  }

  end(code: number | null = 0, signal: string | null = null): void {
    this.stdout.end();
    this.stderr.end();
    this.emit('close', code, signal);
  }
}

/** Spawn fn that replays `lines` into stdout, then closes with exit 0. */
function replaySpawn(lines: string) {
  return (command: string, args: readonly string[], options: SpawnOptions): FakeChild => {
    void command;
    void args;
    void options;
    const child = new FakeChild();
    queueMicrotask(() => {
      child.feed(lines);
      child.end(0);
    });
    return child;
  };
}

function tmpStateDir(): string {
  return mkdtempSync(join(tmpdir(), 'harness-normalized-usage-'));
}

/** Run one agent end to end through the real driver with a replayed child. */
async function runWith(adapter: AgentAdapter): Promise<RunResult> {
  const driver = createDriver({ adapters: { [adapter.name]: adapter }, stateDir: tmpStateDir() });
  return driver.run(adapter.name, { prompt: 'normalized usage fixture' });
}

const ndjson = (line: unknown): string => `${JSON.stringify(line)}\n`;

// ---------------------------------------------------------------------------
// claude — provider-reported cost: result.total_cost_usd (whole run).
// ---------------------------------------------------------------------------

const CLAUDE_LINES =
  ndjson({ type: 'system', subtype: 'init', session_id: 's-claude-1', model: 'claude-sonnet-4-5-20250929' }) +
  ndjson({
    type: 'result',
    subtype: 'success',
    session_id: 's-claude-1',
    total_cost_usd: 0.0771,
    usage: { input_tokens: 9, cache_creation_input_tokens: 15231, cache_read_input_tokens: 92, output_tokens: 431 },
    modelUsage: {
      'claude-sonnet-4-5-20250929': {
        inputTokens: 9,
        cacheCreationInputTokens: 15231,
        cacheReadInputTokens: 92,
        outputTokens: 431,
        reasoningTokens: 64,
        costUSD: 0.0771,
      },
    },
  });

describe('normalized usage/cost (#7) — claude reports cost', () => {
  it('surfaces costAvailability "reported" with the CLI figure and token totals', async () => {
    const result = await runWith(new ClaudeCodeAdapter({ stateDir: tmpStateDir(), spawnFn: replaySpawn(CLAUDE_LINES) }));
    assert.equal(result.exitStatus, 'success');
    assert.deepEqual(result.usage?.cost, {
      costAvailability: 'reported',
      reportedCostUsd: 0.0771,
      tokens: {
        inputTokens: 9,
        outputTokens: 431,
        cacheReadTokens: 92,
        cacheWriteTokens: 15231,
        reasoningTokens: 64,
      },
    });
  });
});

// ---------------------------------------------------------------------------
// opencode — provider-reported cost: per-step part.cost, summed across steps.
// ---------------------------------------------------------------------------

const OPENCODE_LINES =
  ndjson({ type: 'step_start', sessionID: 's-oc-1', part: { type: 'step-start' } }) +
  ndjson({
    type: 'step_finish',
    sessionID: 's-oc-1',
    part: { type: 'step-finish', tokens: { input: 100, output: 50, cache: { read: 10, write: 5 } }, cost: 0.125 },
  }) +
  ndjson({
    type: 'step_finish',
    sessionID: 's-oc-1',
    part: { type: 'step-finish', tokens: { input: 200, output: 80, reasoning: 7 }, cost: 0.0625 },
  });

describe('normalized usage/cost (#7) — opencode reports cost', () => {
  it('sums per-step costs and tokens into one reported figure', async () => {
    const result = await runWith(new OpenCodeAdapter({ spawnFn: replaySpawn(OPENCODE_LINES) }));
    assert.equal(result.exitStatus, 'success');
    assert.deepEqual(result.usage?.cost, {
      costAvailability: 'reported',
      reportedCostUsd: 0.1875, // 0.125 + 0.0625
      tokens: {
        inputTokens: 300,
        outputTokens: 130,
        cacheReadTokens: 10,
        cacheWriteTokens: 5,
        reasoningTokens: 7,
      },
    });
  });
});

// ---------------------------------------------------------------------------
// codex — token usage only: no cost in the native turn.completed output.
// ---------------------------------------------------------------------------

const CODEX_LINES =
  ndjson({ type: 'thread.started', thread_id: 't-codex-1' }) +
  ndjson({
    type: 'turn.completed',
    usage: { input_tokens: 1000, cached_input_tokens: 200, output_tokens: 300, reasoning_output_tokens: 50 },
  });

describe('normalized usage/cost (#7) — codex has no native cost', () => {
  it('reports "unavailable" with null while still normalizing tokens', async () => {
    const result = await runWith(new CodexAdapter({ spawnFn: replaySpawn(CODEX_LINES) }));
    assert.equal(result.exitStatus, 'success');
    assert.deepEqual(result.usage?.cost, {
      costAvailability: 'unavailable',
      reportedCostUsd: null,
      tokens: {
        inputTokens: 800, // input_tokens includes the cached slice; canonical input is uncached-only
        outputTokens: 300,
        cacheReadTokens: 200,
        cacheWriteTokens: 0,
        reasoningTokens: 50,
      },
    });
  });
});

// ---------------------------------------------------------------------------
// gemini — token stats only: no cost in the native result.stats output.
// ---------------------------------------------------------------------------

const GEMINI_LINES =
  ndjson({ type: 'init', session_id: 's-gem-1', model: 'gemini-2.5-pro' }) +
  ndjson({ type: 'result', status: 'success', stats: { input_tokens: 500, output_tokens: 120, cached: 80, thoughts: 30 } });

describe('normalized usage/cost (#7) — gemini has no native cost', () => {
  it('reports "unavailable" with null while still normalizing tokens', async () => {
    const result = await runWith(new GeminiAdapter({ spawnFn: replaySpawn(GEMINI_LINES) }));
    assert.equal(result.exitStatus, 'success');
    assert.deepEqual(result.usage?.cost, {
      costAvailability: 'unavailable',
      reportedCostUsd: null,
      tokens: {
        inputTokens: 420, // prompt minus the cached slice
        outputTokens: 120,
        cacheReadTokens: 80,
        cacheWriteTokens: 0,
        reasoningTokens: 30,
      },
    });
  });
});

// ---------------------------------------------------------------------------
// kiro — credits-metered, no USD anywhere: unavailable, and no token totals
// when the only record is the credits-only placeholder kiro-events emits.
// ---------------------------------------------------------------------------

type KiroScripted = { type: 'usage'; usage: CanonicalTokenRecord };

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
        yield { type: 'usage', usage: e.usage, sessionId: this.sessionId, timestamp: Date.now() };
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
  constructor(readonly events: KiroScripted[]) {}
  async launch(spec: RunSpec): Promise<AgentHandle> {
    return new KiroMockHandle('kiro-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', this.events);
  }
}

/** Credits-only placeholder record exactly as kiro-events emits it on 2.21.x. */
function kiroCreditsRecord(): CanonicalTokenRecord {
  return {
    agent: 'kiro',
    model: 'unknown',
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    timestamp: 1,
    extra: { credits: 0.5, creditsCumulative: 0.5, source: 'native', tokensAvailable: false },
  } as CanonicalTokenRecord;
}

describe('normalized usage/cost (#7) — kiro is credits-only', () => {
  it('reports "unavailable" with null and omits tokens when the record is a placeholder', async () => {
    const driver = createDriver({ adapters: { kiro: new KiroMockAdapter([{ type: 'usage', usage: kiroCreditsRecord() }]) }, stateDir: tmpStateDir() });
    const result = await driver.run('kiro', { prompt: 'ping' });
    assert.equal(result.usage?.credits.available, true); // credits ARE known —
    assert.deepEqual(result.usage?.cost, { costAvailability: 'unavailable', reportedCostUsd: null }); // …but never laundered into USD
  });
});

// ---------------------------------------------------------------------------
// Unit rules of the normalized block itself.
// ---------------------------------------------------------------------------

describe('computeUsageAvailability — normalized cost block', () => {
  const rec = (over: Partial<CanonicalTokenRecord> = {}): CanonicalTokenRecord => ({
    agent: 'mock',
    model: 'm',
    inputTokens: 10,
    outputTokens: 5,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    timestamp: 1,
    ...over,
  });
  const base = { agent: 'mock', totalCost: 0, pricerPriced: false } as const;

  it('sums every provider-reported costUsd and validates against the schema', () => {
    const { usage } = computeUsageAvailability({
      ...base,
      tokens: [rec({ costUsd: 0.25 }), rec({ costUsd: 0.5, inputTokens: 0, outputTokens: 0 })],
    });
    assert.deepEqual(usage.cost, {
      costAvailability: 'reported',
      reportedCostUsd: 0.75,
      tokens: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 },
    });
    assert.equal(ReportedUsageCostSchema.safeParse(usage.cost).success, true);
    assert.equal(UsageAvailabilitySchema.safeParse(usage).success, true);
  });

  it('is unavailable with null when no record carried a costUsd', () => {
    const { usage } = computeUsageAvailability({ ...base, tokens: [rec()] });
    assert.deepEqual(usage.cost, {
      costAvailability: 'unavailable',
      reportedCostUsd: null,
      tokens: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 },
    });
  });

  it('never treats a non-finite costUsd as reported (a missing cost is not $0)', () => {
    const { usage } = computeUsageAvailability({ ...base, tokens: [rec({ costUsd: Number.NaN })] });
    assert.equal(usage.cost?.costAvailability, 'unavailable');
    assert.equal(usage.cost?.reportedCostUsd, null);
  });

  it('omits tokens entirely when the run produced no usable records', () => {
    const { usage } = computeUsageAvailability({ ...base, tokens: [] });
    assert.deepEqual(usage.cost, { costAvailability: 'unavailable', reportedCostUsd: null });
  });
});
