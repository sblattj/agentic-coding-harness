// RunSpec validation contract (agentic-coding-harness#10):
//   - typed, published schemas (RunSpecSchema / RunResultSchema) and the
//     parseRunSpec() helper the driver itself uses;
//   - Driver.run() fails fast with clear field-path errors: required fields,
//     finite positive timeouts, closed budget shape, and model pinning where
//     the adapter requires it (AgentAdapter.requiresModel, kiro.requireModelAck).

import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { createDriver } from '../src/core/driver.js';
import { HarnessError, type AgentAdapter, type AgentHandle, type RunSpec } from '../src/core/types.js';
import { parseRunSpec } from '../src/core/validate.js';

/** Minimal adapter: records the spec, settles immediately. */
class RecordingAdapter implements AgentAdapter {
  readonly name: string;
  lastSpec?: RunSpec;
  launched = 0;

  constructor(readonly requiresModel?: boolean) {
    this.name = `mock-${Math.random().toString(36).slice(2, 8)}`;
  }

  async launch(spec: RunSpec): Promise<AgentHandle> {
    this.launched += 1;
    this.lastSpec = spec;
    return {
      sessionId: `s-${this.launched}`,
      async *attach() {
        yield { type: 'step', timestamp: Date.now() };
      },
      abort() {},
      async wait() {
        return 'success';
      },
    };
  }
}

function driverWith(adapter: RecordingAdapter) {
  return createDriver({ adapters: { [adapter.name]: adapter }, stateDir: mkdtempSync(join(tmpdir(), 'harness-spec-')) });
}

/** Assert the rejection is an INVALID_SPEC HarnessError matching /re/. */
async function assertInvalidSpec(fn: () => Promise<unknown> | unknown, re: RegExp) {
  await assert.rejects(
    () => Promise.resolve().then(fn),
    (err: unknown) => {
      assert.ok(err instanceof HarnessError, `expected HarnessError, got ${err}`);
      assert.equal((err as HarnessError).code, 'INVALID_SPEC');
      assert.match((err as Error).message, re);
      return true;
    },
  );
}

describe('parseRunSpec: valid specs pass', () => {
  it('accepts a kitchen-sink spec and returns the parsed data', () => {
    const spec: RunSpec = {
      prompt: 'fix the flaky test',
      runId: 'run-42',
      cwd: '/tmp',
      model: 'claude-sonnet-4.5',
      resume: 'sess-1',
      budget: { usd: 1.5, maxTurns: 4, wallMs: 60_000, idleMs: 5_000 },
      timeoutMs: 90_000,
      idleTimeoutMs: 8_000,
      env: { FOO: 'bar' },
      extraArgs: ['--flag'],
      stateDir: '/tmp/state',
      kiro: { transport: 'headless', startupMs: 30_000, requireModelAck: true },
      scriptedEvents: [], // passthrough key must ride through untouched
    };
    const parsed = parseRunSpec('kiro', spec);
    assert.equal(parsed.prompt, 'fix the flaky test');
    assert.equal(parsed.budget?.usd, 1.5);
    assert.equal(parsed.timeoutMs, 90_000);
    assert.deepEqual(parsed.scriptedEvents, []);
  });

  it('accepts a minimal spec: only a prompt', () => {
    const parsed = parseRunSpec('mock', { prompt: 'hi' });
    assert.equal(parsed.prompt, 'hi');
    assert.equal(parsed.budget, undefined);
  });

  it('accepts an empty-but-present budget (CLI shape with all-undefined keys)', () => {
    const parsed = parseRunSpec('mock', { prompt: 'hi', budget: {} });
    assert.deepEqual(parsed.budget, {});
  });
});

describe('parseRunSpec: required fields', () => {
  it('rejects a missing prompt, naming the field', async () => {
    await assertInvalidSpec(() => parseRunSpec('mock', { model: 'm' } as RunSpec), /\bspec\.prompt\b.*prompt is required/);
  });

  it('rejects an empty prompt', async () => {
    await assertInvalidSpec(() => parseRunSpec('mock', { prompt: '' }), /\bspec\.prompt\b.*non-empty/);
  });

  it('rejects a wrong-typed prompt, showing the offending value', async () => {
    await assertInvalidSpec(
      () => parseRunSpec('mock', { prompt: 42 as unknown as string }),
      /spec\.prompt.*\(got 42\)/,
    );
  });
});

describe('parseRunSpec: timeouts must be finite and > 0', () => {
  const display = (v: number) => (Object.is(v, Infinity) ? 'Infinity' : Object.is(v, -Infinity) ? '-Infinity' : Object.is(v, NaN) ? 'NaN' : String(v));
  for (const bad of [Infinity, -Infinity, NaN, 0, -1]) {
    it(`rejects timeoutMs=${display(bad)}`, async () => {
      await assertInvalidSpec(
        () => parseRunSpec('mock', { prompt: 'hi', timeoutMs: bad }),
        new RegExp(`spec\\.timeoutMs.*finite number > 0 \\(got ${display(bad)}\\)`),
      );
    });
    it(`rejects budget.wallMs=${display(bad)}`, async () => {
      await assertInvalidSpec(
        () => parseRunSpec('mock', { prompt: 'hi', budget: { wallMs: bad } }),
        new RegExp(`spec\\.budget\\.wallMs.*finite number > 0 \\(got ${display(bad)}\\)`),
      );
    });
  }

  it('rejects a zero idleTimeoutMs alias', async () => {
    await assertInvalidSpec(
      () => parseRunSpec('mock', { prompt: 'hi', idleTimeoutMs: 0 }),
      /spec\.idleTimeoutMs.*finite number > 0/,
    );
  });

  it('rejects a non-finite kiro.startupMs', async () => {
    await assertInvalidSpec(
      () => parseRunSpec('kiro', { prompt: 'hi', kiro: { startupMs: Infinity } }),
      /spec\.kiro\.startupMs.*finite number > 0/,
    );
  });
});

describe('parseRunSpec: budget shape', () => {
  it('rejects a non-object budget', async () => {
    await assertInvalidSpec(
      () => parseRunSpec('mock', { prompt: 'hi', budget: 100 as unknown as RunSpec['budget'] }),
      /spec\.budget/,
    );
  });

  it('rejects a wrong-typed budget.usd, showing the value', async () => {
    await assertInvalidSpec(
      () => parseRunSpec('mock', { prompt: 'hi', budget: { usd: '5' as unknown as number } }),
      /spec\.budget\.usd.*finite number > 0.*\(got "5"\)/,
    );
  });

  it('rejects unknown budget keys (a typo would silently disable the cap)', async () => {
    await assertInvalidSpec(
      () => parseRunSpec('mock', { prompt: 'hi', budget: { maxTurn: 3 } as RunSpec['budget'] }),
      /spec\.budget.*maxTurn/,
    );
  });

  it('rejects a fractional maxTurns', async () => {
    await assertInvalidSpec(
      () => parseRunSpec('mock', { prompt: 'hi', budget: { maxTurns: 2.5 } }),
      /spec\.budget\.maxTurns.*finite integer > 0/,
    );
  });

  it('reports several issues in one message, path-qualified', async () => {
    await assertInvalidSpec(
      () => parseRunSpec('mock', { prompt: 'hi', budget: { usd: -1, wallMs: 0 } }),
      /spec\.budget\.usd.*finite number > 0 \(got -1\); spec\.budget\.wallMs.*finite number > 0 \(got 0\)/,
    );
  });
});

describe('parseRunSpec: model pinning', () => {
  it('rejects an unpinned model when the adapter requires one', async () => {
    await assertInvalidSpec(
      () => parseRunSpec('mock', { prompt: 'hi' }, { requiresModel: true }),
      /spec\.model must be a non-empty string.*agent "mock" requires a pinned model/,
    );
  });

  it('accepts a pinned model when the adapter requires one', () => {
    const parsed = parseRunSpec('mock', { prompt: 'hi', model: 'pinned-1' }, { requiresModel: true });
    assert.equal(parsed.model, 'pinned-1');
  });

  it('rejects ACP kiro.requireModelAck without a model (nothing to acknowledge)', async () => {
    await assertInvalidSpec(
      () => parseRunSpec('kiro', { prompt: 'hi', kiro: { transport: 'acp', requireModelAck: true } }),
      /spec\.model must be a non-empty string.*requireModelAck.*no model is set to acknowledge/,
    );
  });

  it('accepts ACP kiro.requireModelAck with a model', () => {
    const parsed = parseRunSpec('kiro', {
      prompt: 'hi',
      model: 'claude-haiku-4.5',
      kiro: { transport: 'acp', requireModelAck: true },
    });
    assert.equal(parsed.kiro?.requireModelAck, true);
  });

  it('tolerates headless kiro.requireModelAck without a model (no ack mechanism there)', () => {
    const parsed = parseRunSpec('kiro', { prompt: 'hi', kiro: { requireModelAck: true } });
    assert.equal(parsed.kiro?.requireModelAck, true);
  });

  it('allows no model when neither the adapter nor the spec requires one', () => {
    assert.equal(parseRunSpec('mock', { prompt: 'hi' }).model, undefined);
    assert.equal(parseRunSpec('kiro', { prompt: 'hi', kiro: { requireModelAck: false } }).model, undefined);
  });
});

describe('Driver.run validates at the entry point', () => {
  it('rejects an invalid spec before launching the adapter', async () => {
    const adapter = new RecordingAdapter();
    const driver = driverWith(adapter);
    await assertInvalidSpec(
      () => driver.run(adapter.name, { prompt: 'x', budget: { wallMs: Infinity } }),
      /spec\.budget\.wallMs.*finite number > 0/,
    );
    assert.equal(adapter.launched, 0, 'adapter.launch must not run for an invalid spec');
  });

  it('rejects a missing prompt through the driver', async () => {
    const adapter = new RecordingAdapter();
    const driver = driverWith(adapter);
    await assertInvalidSpec(() => driver.run(adapter.name, {} as RunSpec), /spec\.prompt/);
  });

  it('rejects an unpinned model for an adapter declaring requiresModel', async () => {
    const adapter = new RecordingAdapter(true);
    const driver = driverWith(adapter);
    await assertInvalidSpec(
      () => driver.run(adapter.name, { prompt: 'hi' }),
      /spec\.model must be a non-empty string.*requires a pinned model/,
    );
    assert.equal(adapter.launched, 0);
  });

  it('runs a valid spec with a pinned model through a requiresModel adapter', async () => {
    const adapter = new RecordingAdapter(true);
    const driver = driverWith(adapter);
    const result = await driver.run(adapter.name, { prompt: 'hi', model: 'm-1' });
    assert.equal(result.exitStatus, 'success');
    assert.equal(adapter.launched, 1);
  });
});
