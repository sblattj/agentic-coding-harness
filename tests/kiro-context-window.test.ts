import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createKiroNormalizer, deriveContextWindow } from '../src/adapters/kiro-events.js';
import { computeUsageAvailability } from '../src/core/usage-availability.js';
import { UsageAvailabilitySchema, type CanonicalEvent, type CanonicalTokenRecord } from '../src/core/types.js';

// #137: the context window is derived from the v3 breakdown (not assumed), and
// the start size (first reading) is kept next to the end size (last reading).

const fixtureLines = (name: string): string[] =>
  readFileSync(fileURLToPath(new URL(`./fixtures/kiro/${name}`, import.meta.url)), 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '');

function tokensOf(events: CanonicalEvent[]): CanonicalTokenRecord[] {
  return events
    .filter((e): e is Extract<CanonicalEvent, { type: 'usage' }> => e.type === 'usage')
    .map((e) => ({ agent: 'kiro', model: 'unknown', timestamp: 0, ...e.tokens }) as unknown as CanonicalTokenRecord);
}

function compute(tokens: CanonicalTokenRecord[]) {
  return computeUsageAvailability({ agent: 'kiro', tokens, totalCost: 0, pricerPriced: false }).usage;
}

describe('kiro context window (#137): v3 session_info_update', () => {
  const norm = createKiroNormalizer({ transport: 'acp' });
  const events: CanonicalEvent[] = [];
  // Fixture: update #1 (pct 1, yourPrompts 4296 tok), a focus_update (must be
  // ignored), then two later updates at pct 2.86 where yourPrompts.tokens is 0
  // while its percent is 2.3 (the stale-estimate trap: sum/pct would say 224k).
  for (const l of fixtureLines('context-usage-v3-2.28.0.jsonl')) events.push(...norm.pushAcpMessage(JSON.parse(l)));
  const usage = compute(tokensOf(events));

  it('emits one context-only usage record per context_usage update and ignores other kinds', () => {
    // 3 context_usage updates in the fixture (1 pct-only + 2 with breakdown); focus_update is not one.
    assert.equal(tokensOf(events).length, 3);
    const steps = events.filter((e) => e.type === 'step');
    assert.equal(steps.length, 4, 'every session_info_update still stays as raw vendor evidence');
  });

  it('derives the 1M window from the largest category and labels it derived', () => {
    assert.equal(usage.context?.available, true);
    assert.equal(usage.context?.windowSource, 'derived');
    assert.equal(usage.context?.windowTokens, 1_000_000);
  });

  it('keeps the window ~1M when a later update zeroes yourPrompts.tokens', () => {
    const last = tokensOf(events).at(-1)!;
    assert.equal(last.extra?.contextWindowDerived, 1_000_000);
    const naive = 6400 / 0.0286; // sum(tokens)/pct would be ~224k: the trap
    assert.ok(naive < 300_000);
  });

  it('separates start (first update) from end (last update)', () => {
    assert.equal(usage.context?.startPercentage, 1);
    assert.equal(usage.context?.startTokens, 10_000);
    assert.equal(usage.context?.percentage, 2.859699964523315);
    assert.equal(usage.context?.tokens, 28_597);
  });

  it('exposes the first update breakdown as category -> tokens', () => {
    assert.deepEqual(usage.context?.breakdown, {
      contextFiles: 0,
      tools: 6400,
      memory: 0,
      kiroResponses: 0,
      yourPrompts: 4296,
      sessionFiles: 0,
    });
  });

  it('round-trips through the UsageAvailability schema', () => {
    assert.ok(UsageAvailabilitySchema.safeParse(usage).success);
  });

  it('a session-store window outranks the derived one', () => {
    const u = computeUsageAvailability({
      agent: 'kiro',
      tokens: tokensOf(events),
      sessionStore: { contextWindowTokens: 500_000, lastContextUsagePercentage: 3, turns: [], hasTokenData: false } as never,
      totalCost: 0,
      pricerPriced: false,
    }).usage;
    assert.equal(u.context?.windowSource, 'session-store');
    assert.equal(u.context?.windowTokens, 500_000);
  });
});

describe('kiro context window (#137): deriveContextWindow', () => {
  const cat = (tokens: number, percent: number) => ({ tokens, percent });
  it('snaps to a known window within 15% and rejects tiny categories', () => {
    assert.equal(deriveContextWindow({ tools: cat(6400, 0.6) }), 1_000_000);
    assert.equal(deriveContextWindow({ contextFiles: cat(18840, 1.9), tools: cat(9968, 1) }), 1_000_000);
    assert.equal(deriveContextWindow({ tools: cat(999, 0.1) }), undefined);
    assert.equal(deriveContextWindow({ tools: cat(6400, 0) }), undefined);
    assert.equal(deriveContextWindow(undefined), undefined);
  });
  it('keeps the raw value when no known window is near', () => {
    assert.equal(deriveContextWindow({ tools: cat(30_000, 2) }), 1_500_000);
  });
});

describe('kiro context window (#137): v2 headless', () => {
  const norm = createKiroNormalizer({ transport: 'headless' });
  const events: CanonicalEvent[] = [];
  // Real 2.21.2 capture: first metadata frame 2.4215 (before the reply), last 1.3314.
  for (const l of fixtureLines('headless-stream-json-2.21.2.jsonl')) events.push(...norm.pushHeadlessLine(l));
  const usage = compute(tokensOf(events));

  it('startPercentage is the FIRST frame and percentage the LAST; window stays assumed', () => {
    assert.equal(usage.context?.startPercentage, 2.4214999675750732);
    assert.equal(usage.context?.percentage, 1.3314000368118286);
    assert.equal(usage.context?.windowSource, 'assumed');
    assert.equal(usage.context?.windowTokens, 200_000);
    assert.equal(usage.context?.startTokens, Math.round(0.024214999675750732 * 200_000));
    assert.equal(usage.context?.breakdown, undefined);
  });
});
