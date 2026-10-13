import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { createContext, runInContext } from 'node:vm';
import { frame } from '../src/cli/dash.ts';
import { createDriver } from '../src/core/driver.js';
import { modelChipsText, shortModelName } from '../src/core/model-chips.ts';
import { createPricer } from '../src/core/pricing.js';
import { listRunRecords, type RunRecord } from '../src/core/registry.js';
import type { AgentAdapter, AgentEvent, AgentHandle, CanonicalTokenRecord } from '../src/core/types.js';

// Per-model cost chips (#67): pricer split -> driver-persisted totals.byModel
// -> dash line + web chips. Single-model / slice-less runs stay unchanged.

const multi = (models: Array<Record<string, unknown>>): CanonicalTokenRecord => ({
  agent: 'claude',
  model: 'multi',
  sessionId: 's1',
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  timestamp: 0,
  extra: { raw: { models } },
});

const OPUS = { model: 'claude-opus-5[1m]', input: 4, output: 1660, cacheRead: 26282, cacheWrite: 7544, costUsd: 0.4 };
const HAIKU = { model: 'claude-haiku-4-5-20251001', input: 950, output: 11, cacheRead: 0, cacheWrite: 0, costUsd: 0.02 };

describe('Pricer.priceByModel', () => {
  it('splits a multi-model record per slice, reported cost verbatim, and sums to price()', () => {
    const pricer = createPricer();
    const r = multi([OPUS, HAIKU]);
    const split = pricer.priceByModel!(r);
    assert.deepEqual(split.map((s) => s.model), [OPUS.model, HAIKU.model]);
    assert.deepEqual(split.map((s) => s.costUsd), [0.4, 0.02]);
    assert.equal(split[0]!.tokens, 4 + 1660 + 26282 + 7544);
    assert.ok(Math.abs(split.reduce((a, s) => a + (s.costUsd ?? 0), 0) - pricer.price(r)) < 1e-9);
  });

  it('an unpriced slice is costUsd null plus the existing unknown-model warning, never a number', () => {
    const pricer = createPricer();
    const split = pricer.priceByModel!(multi([OPUS, { model: 'mystery-model-9', input: 5, output: 5, cacheRead: 0, cacheWrite: 0 }]));
    assert.equal(split[1]!.costUsd, null);
    assert.equal(split[0]!.costUsd, 0.4);
    assert.ok(pricer.drainWarnings().some((w) => w.includes('mystery-model-9') && w.includes('cost not computed')));
  });

  it('a slice-less record yields one entry for its own model; model-less yields none', () => {
    const pricer = createPricer();
    const one = pricer.priceByModel!({ agent: 'x', model: 'claude-sonnet-5', inputTokens: 1000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, timestamp: 0 });
    assert.equal(one.length, 1);
    assert.equal(one[0]!.costUsd, 0.002);
    assert.deepEqual(pricer.priceByModel!({ agent: 'x', inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, timestamp: 0 }), []);
  });
});

class MultiHandle implements AgentHandle {
  readonly sessionId = 'chips-session-1';
  readonly models: Array<Record<string, unknown>>;
  constructor(models: Array<Record<string, unknown>>) {
    this.models = models;
  }
  async *attach(): AsyncIterable<AgentEvent> {
    const ts = Date.now();
    yield { type: 'session', sessionId: this.sessionId, timestamp: ts };
    yield {
      type: 'usage',
      usage: { model: 'multi', inputTokens: 954, outputTokens: 1671, cacheReadTokens: 26282, cacheWriteTokens: 7544, extra: { raw: { models: this.models } } },
      sessionId: this.sessionId,
      timestamp: ts,
    };
  }
  abort(): void {}
  async wait(): Promise<'success'> {
    return 'success';
  }
}
const adapterOf = (models: Array<Record<string, unknown>>): AgentAdapter => ({ name: 'chipstub', launch: async () => new MultiHandle(models) });

async function runAndRead(models: Array<Record<string, unknown>>): Promise<RunRecord> {
  const regDir = mkdtempSync(join(tmpdir(), 'ach-chips-reg-'));
  const driver = createDriver({
    adapters: { chipstub: adapterOf(models) },
    stateDir: mkdtempSync(join(tmpdir(), 'ach-chips-state-')),
    registry: { stateDir: regDir },
  });
  await driver.run('chipstub', { prompt: 'x' });
  return listRunRecords(regDir)[0]!;
}

describe('driver persists totals.byModel', () => {
  it('multi-model run: byModel ordered by cost desc and summing to totals.costUsd', async () => {
    const rec = await runAndRead([HAIKU, OPUS]);
    assert.deepEqual(rec.totals!.byModel!.map((m) => m.model), [OPUS.model, HAIKU.model]);
    const sum = rec.totals!.byModel!.reduce((a, m) => a + (m.costUsd ?? 0), 0);
    assert.ok(Math.abs(sum - rec.totals!.costUsd) < 1e-9);
  });

  it('single-model (one slice) run has no byModel: aggregate unchanged', async () => {
    const rec = await runAndRead([OPUS]);
    assert.equal(rec.totals!.byModel, undefined);
  });

  it('unpriced model in the breakdown persists as costUsd null', async () => {
    const rec = await runAndRead([OPUS, { model: 'mystery-model-9', input: 5, output: 5, cacheRead: 0, cacheWrite: 0 }]);
    // Whole record is unpriceable (price() NaN) -> still listed with null for the unknown model.
    const m = rec.totals!.byModel!.find((x) => x.model === 'mystery-model-9')!;
    assert.equal(m.costUsd, null);
  });
});

function dashRec(over: Partial<RunRecord['totals']> = {}): RunRecord {
  const now = Date.now();
  return {
    runId: 'chips-run-1',
    agent: 'claude',
    startedAt: now - 1000,
    updatedAt: now,
    status: 'success',
    totals: { inputTokens: 10, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.42, ...over },
  };
}

describe('dash per-model line', () => {
  it('shows opus $0.4000 + haiku $0.0200 for a multi-model run', () => {
    const out = frame([dashRec({ byModel: [{ model: OPUS.model, costUsd: 0.4, tokens: 100 }, { model: HAIKU.model, costUsd: 0.02, tokens: 5 }] })], '/state', false, 160, false);
    assert.ok(out.split('\n').some((l) => l === 'models chips-ru opus $0.4000 + haiku $0.0200'), out);
  });

  it('single-model and slice-less runs print no models line', () => {
    assert.equal(frame([dashRec()], '/state', false, 160, false).includes('models '), false);
    const one = dashRec({ byModel: [{ model: OPUS.model, costUsd: 0.4, tokens: 1 }] });
    assert.equal(frame([one], '/state', false, 160, false).includes('models chips'), false);
  });

  it('unpriced model prints n/a, not a number', () => {
    assert.equal(modelChipsText([{ model: 'a-b', costUsd: 1, tokens: 1 }, { model: 'mystery', costUsd: null, tokens: 1 }]), 'a-b $1.0000 + mystery n/a');
  });

  it('shortModelName maps claude families and keeps others', () => {
    assert.equal(shortModelName('claude-opus-5[1m]'), 'opus');
    assert.equal(shortModelName('anthropic/claude-haiku-4-5-20251001'), 'haiku');
    assert.equal(shortModelName('gpt-5.6'), 'gpt-5.6');
  });
});

describe('web run header chips (index.html)', () => {
  const html = readFileSync(new URL('../src/web/index.html', import.meta.url), 'utf8');
  const block = /\/\* modelchips:begin \*\/([\s\S]*?)\/\* modelchips:end \*\//.exec(html);
  const fn = (name: string) => new RegExp(`function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`).exec(html)![0];
  const ctx = createContext({});
  it('embeds the chip helper', () => {
    assert.ok(block, 'index.html must carry the modelchips block');
    runInContext([fn('fmtTok'), fn('runCost'), block![1]].join('\n'), ctx);
  });
  it('renders model $cost · tokens chips ordered as persisted, n/a for unpriced, none for single-model', () => {
    const raw = ctx.modelChips as (r: unknown) => Array<{ text: string; unpriced: boolean }>;
    const modelChips = (r: unknown) => JSON.parse(JSON.stringify(raw(r))) as Array<{ text: string; unpriced: boolean }>; // vm arrays are cross-realm
    const t = { costUsd: 0.42, byModel: [{ model: 'claude-opus-5', costUsd: 0.4, tokens: 18200 }, { model: 'mystery', costUsd: null, tokens: 50 }] };
    assert.deepEqual(modelChips({ totals: t }), [
      { text: 'claude-opus-5 $0.40 · 18.2k', unpriced: false },
      { text: 'mystery n/a · 50', unpriced: true },
    ]);
    assert.deepEqual(modelChips({ totals: { costUsd: 0.4 } }), []);
    assert.deepEqual(modelChips({ totals: { costUsd: 0.4, byModel: [t.byModel[0]] } }), []);
    assert.deepEqual(modelChips({ metering: 'none', totals: t }), []);
  });
});
