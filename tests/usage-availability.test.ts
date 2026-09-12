import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { parseKiroSessionStore, type ParsedKiroSessionStore } from '../src/adapters/kiro-session-store.ts';
import {
  ASSUMED_CONTEXT_WINDOWS,
  computeUsageAvailability,
} from '../src/core/usage-availability.ts';
import { UsageAvailabilitySchema, type CanonicalTokenRecord } from '../src/core/types.ts';

const FIXTURES = join(dirname(new URL(import.meta.url).pathname), 'fixtures', 'kiro');

function store(name: string): ParsedKiroSessionStore {
  const parsed = parseKiroSessionStore(JSON.parse(readFileSync(join(FIXTURES, name), 'utf8')));
  assert.ok(parsed, `${name} parses`);
  return parsed;
}

/** Expected credits, re-derived from the raw fixture rather than the parser. */
function fixtureCredits(name: string): number {
  const json = JSON.parse(readFileSync(join(FIXTURES, name), 'utf8')) as Record<string, unknown>;
  const state = json.session_state as Record<string, unknown>;
  const meta = state.conversation_metadata as Record<string, unknown>;
  const turns = meta.user_turn_metadatas as Array<Record<string, unknown>>;
  return turns.reduce(
    (sum, t) => sum + (t.metering_usage as Array<{ value: number }>).reduce((a, m) => a + m.value, 0),
    0,
  );
}

/** A kiro credits-only usage record, exactly as kiro-events.ts emits it. */
function kiroRecord(over: Partial<CanonicalTokenRecord> = {}): CanonicalTokenRecord {
  return {
    agent: 'kiro',
    model: 'unknown',
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    timestamp: 1,
    extra: { credits: 0.5, creditsCumulative: 0.5, source: 'native', tokensAvailable: false },
    ...over,
  } as CanonicalTokenRecord;
}

const base = { agent: 'kiro', totalCost: 0, pricerPriced: false } as const;

describe('computeUsageAvailability — tokens', () => {
  it('reports tokens UNAVAILABLE for the real kiro fixtures: every source is zero', () => {
    for (const name of ['session-store-auto.json', 'session-store-haiku.json']) {
      const parsed = store(name);
      const { usage } = computeUsageAvailability({
        ...base,
        tokens: [kiroRecord()],
        sessionStore: parsed,
      });
      assert.equal(usage.tokens.available, false, name);
      assert.equal(usage.tokens.source, undefined);
      // The evidence records still exist; they are simply not a token count.
      assert.equal(parsed.turns.every((t) => t.inputTokens === 0 && t.outputTokens === 0), true);
    }
  });

  it('vetoes a record that declares extra.tokensAvailable === false even with non-zero counters', () => {
    const { usage } = computeUsageAvailability({
      ...base,
      tokens: [kiroRecord({ inputTokens: 999, outputTokens: 42 })],
      sessionStore: null,
    });
    assert.equal(usage.tokens.available, false);
  });

  it('prefers the session store (per turn) when it carries real counts', () => {
    const parsed = store('session-store-haiku.json');
    const withTokens: ParsedKiroSessionStore = {
      ...parsed,
      turns: parsed.turns.map((t) => ({ ...t, inputTokens: 120, outputTokens: 7 })),
    };
    const { usage } = computeUsageAvailability({
      ...base,
      tokens: [kiroRecord({ inputTokens: 999 })], // tap kept as audit, not preferred
      sessionStore: withTokens,
    });
    assert.deepEqual(usage.tokens, {
      available: true,
      source: 'session-store',
      scope: 'turn',
      cumulative: false,
      complete: true,
    });
  });

  it('falls back to tap scope when only a plain (non-vetoed) record has counts', () => {
    const { usage } = computeUsageAvailability({
      agent: 'mock',
      tokens: [{ agent: 'mock', model: 'm', inputTokens: 10, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, timestamp: 1 }],
      sessionStore: null,
      totalCost: 0.25,
      pricerPriced: true,
    });
    assert.equal(usage.tokens.available, true);
    assert.equal(usage.tokens.source, 'tap');
    assert.equal(usage.tokens.scope, 'call');
  });
});

describe('computeUsageAvailability — credits reconciliation', () => {
  const expected = fixtureCredits('session-store-auto.json');

  it('reports the charge ONCE across three agreeing sources and records all of them', () => {
    const { usage, warnings } = computeUsageAvailability({
      ...base,
      tokens: [kiroRecord({ extra: { credits: expected, creditsCumulative: expected, tokensAvailable: false } })],
      sessionStore: store('session-store-auto.json'),
      streamCreditsCumulative: expected,
    });
    assert.deepEqual(warnings, []);
    assert.equal(usage.credits.available, true);
    assert.equal(usage.credits.value, expected);
    assert.equal(usage.credits.source, 'reconciled');
    assert.deepEqual(usage.credits.sources, { stream: expected, 'session-store': expected, tap: expected });
    // Reconciled, never summed: 3x the charge would be the bug.
    assert.notEqual(usage.credits.value, expected * 3);
  });

  it('prefers the stream over the store over the tap, and warns naming every value', () => {
    const { usage, warnings } = computeUsageAvailability({
      ...base,
      tokens: [kiroRecord({ extra: { credits: 0.3, tokensAvailable: false } })],
      sessionStore: { turns: [], creditsTotal: 0.2 },
      streamCreditsCumulative: 0.1,
    });
    assert.equal(usage.credits.value, 0.1);
    assert.equal(warnings.length, 1);
    for (const fragment of ['stream=0.1', 'session-store=0.2', 'tap=0.3']) {
      assert.ok(warnings[0]?.includes(fragment), `${warnings[0]} mentions ${fragment}`);
    }
  });

  it('treats a sub-tolerance float difference as agreement (no warning)', () => {
    const { usage, warnings } = computeUsageAvailability({
      ...base,
      tokens: [],
      sessionStore: { turns: [], creditsTotal: 0.1 + 1e-12 },
      streamCreditsCumulative: 0.1,
    });
    assert.deepEqual(warnings, []);
    assert.equal(usage.credits.value, 0.1);
  });

  it('falls back to the store when no stream figure exists', () => {
    const expectedHaiku = fixtureCredits('session-store-haiku.json');
    const { usage } = computeUsageAvailability({
      ...base,
      tokens: [],
      sessionStore: store('session-store-haiku.json'),
      streamCreditsCumulative: null,
    });
    assert.equal(usage.credits.value, expectedHaiku);
    assert.equal(usage.credits.source, 'native');
    assert.deepEqual(usage.credits.sources, { 'session-store': expectedHaiku });
  });

  it('reports credits unavailable when nothing reported any', () => {
    const { usage } = computeUsageAvailability({ ...base, tokens: [], sessionStore: null });
    assert.deepEqual(usage.credits, { available: false });
  });
});

describe('computeUsageAvailability — usd', () => {
  it('is unavailable whenever tokens are unavailable, even with a non-zero totalCost', () => {
    const { usage } = computeUsageAvailability({
      ...base,
      tokens: [kiroRecord()],
      sessionStore: store('session-store-auto.json'),
      totalCost: 1.23,
      pricerPriced: true,
    });
    assert.deepEqual(usage.usd, { available: false });
  });

  it('is unavailable when the pricer never priced anything', () => {
    const { usage } = computeUsageAvailability({
      agent: 'mock',
      tokens: [{ agent: 'mock', model: 'm', inputTokens: 5, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, timestamp: 1 }],
      sessionStore: null,
      totalCost: 0,
      pricerPriced: false,
    });
    assert.deepEqual(usage.usd, { available: false });
  });

  it('is available when a priced record actually carried tokens', () => {
    const { usage } = computeUsageAvailability({
      agent: 'mock',
      tokens: [{ agent: 'mock', model: 'm', inputTokens: 5, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, timestamp: 1 }],
      sessionStore: null,
      totalCost: 0.75,
      pricerPriced: true,
    });
    assert.deepEqual(usage.usd, { available: true, source: 'pricer', value: 0.75 });
  });
});

describe('computeUsageAvailability — derived context', () => {
  it('derives ctx tokens from the fixture percentage and the store window', () => {
    for (const name of ['session-store-auto.json', 'session-store-haiku.json']) {
      const parsed = store(name);
      const { usage } = computeUsageAvailability({ ...base, tokens: [], sessionStore: parsed });
      const pct = parsed.lastContextUsagePercentage as number;
      const window = parsed.contextWindowTokens as number;
      assert.deepEqual(
        usage.context,
        {
          available: true,
          source: 'derived',
          percentage: pct,
          windowTokens: window,
          windowSource: 'session-store',
          tokens: Math.round((pct / 100) * window),
          model: parsed.model,
        },
        name,
      );
    }
  });

  it('marks a fallback window as assumed rather than passing it off as reported', () => {
    const { usage } = computeUsageAvailability({
      ...base,
      tokens: [kiroRecord({ extra: { tokensAvailable: false, contextUsagePercentage: 10 } })],
      sessionStore: null,
    });
    assert.equal(usage.context?.windowSource, 'assumed');
    assert.equal(usage.context?.windowTokens, ASSUMED_CONTEXT_WINDOWS.default);
    assert.equal(usage.context?.tokens, Math.round(0.1 * (ASSUMED_CONTEXT_WINDOWS.default as number)));
  });

  it('is unavailable — not zero — when no percentage was ever reported', () => {
    const { usage } = computeUsageAvailability({ ...base, tokens: [], sessionStore: null });
    assert.equal(usage.context?.available, false);
    assert.equal(usage.context?.tokens, undefined);
  });
});

describe('computeUsageAvailability — schema', () => {
  it('every produced shape validates against UsageAvailabilitySchema', () => {
    const cases = [
      computeUsageAvailability({ ...base, tokens: [], sessionStore: null }),
      computeUsageAvailability({
        ...base,
        tokens: [kiroRecord()],
        sessionStore: store('session-store-haiku.json'),
        streamCreditsCumulative: 0.5,
      }),
    ];
    for (const c of cases) {
      const parsed = UsageAvailabilitySchema.safeParse(c.usage);
      assert.equal(parsed.success, true, JSON.stringify(parsed.error?.issues));
    }
  });
});
