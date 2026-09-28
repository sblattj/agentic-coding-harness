import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  BLOCK_MS,
  computeBlocks,
  computePace,
  currentBlock,
  paceFromSamples,
  type UsageWindowRecord,
} from '../src/core/usage-windows.ts';
import { PLAN_PRESETS, planUsage, resolvePlan } from '../src/core/plans.ts';

// ---------------------------------------------------------------------------
// Claude 5-hour billing blocks (#18), pace (#19), plan presets (#36).
// Pure functions: every test passes `now` explicitly, no clock, no I/O.
// ---------------------------------------------------------------------------

const H = 3_600_000;
const M = 60_000;
const T0 = Date.parse('2026-09-20T10:00:00.000Z'); // on the hour

function rec(tsMs: number, over: Partial<UsageWindowRecord> = {}): UsageWindowRecord {
  return {
    ts: new Date(tsMs).toISOString(),
    agent: 'claude',
    inputTokens: 100,
    outputTokens: 50,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: 0.5,
    ...over,
  };
}

describe('computeBlocks (5h billing windows)', () => {
  it('groups events spanning two blocks into exactly 2 blocks, each 5h from its start', () => {
    const recs = [rec(T0), rec(T0 + 1 * H), rec(T0 + 4 * H), rec(T0 + 6 * H), rec(T0 + 7 * H)];
    const blocks = computeBlocks(recs, { now: T0 + 30 * H });
    assert.equal(blocks.length, 2);
    assert.equal(blocks[0]!.start, new Date(T0).toISOString());
    assert.equal(blocks[0]!.end, new Date(T0 + BLOCK_MS).toISOString());
    assert.equal(blocks[0]!.records, 3);
    assert.equal(blocks[1]!.start, new Date(T0 + 6 * H).toISOString());
    assert.equal(blocks[1]!.end, new Date(T0 + 11 * H).toISOString());
    assert.equal(blocks[1]!.records, 2);
    assert.equal(blocks[0]!.tokens, 450);
    assert.equal(blocks[0]!.costUsd, 1.5);
    assert.equal(blocks[0]!.active, false);
    assert.equal(blocks[0]!.projection, null);
  });

  it('boundary: an event at exactly block-start + 5h opens the next block', () => {
    const blocks = computeBlocks([rec(T0), rec(T0 + BLOCK_MS - 1), rec(T0 + BLOCK_MS)], { now: T0 + 30 * H });
    assert.equal(blocks.length, 2);
    assert.equal(blocks[0]!.records, 2);
    assert.equal(blocks[1]!.start, new Date(T0 + BLOCK_MS).toISOString());
  });

  it('floors a block start to the hour (ccusage semantics) and orders unsorted input', () => {
    const first = T0 + 37 * M + 12_000;
    const blocks = computeBlocks([rec(first + 2 * H), rec(first)], { now: T0 + 30 * H });
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0]!.start, new Date(T0).toISOString());
    assert.equal(blocks[0]!.firstEventAt, new Date(first).toISOString());
  });

  it('only counts claude records and skips records without a timestamp', () => {
    const blocks = computeBlocks(
      [rec(T0), rec(T0 + H, { agent: 'codex' }), { ...rec(T0), ts: null }],
      { now: T0 + 30 * H },
    );
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0]!.records, 1);
  });

  it('unpriced records contribute tokens but not cost, and are counted', () => {
    const blocks = computeBlocks([rec(T0), rec(T0 + M, { costUsd: undefined })], { now: T0 + 30 * H });
    assert.equal(blocks[0]!.costUsd, 0.5);
    assert.equal(blocks[0]!.unpricedRecords, 1);
    assert.equal(blocks[0]!.tokens, 300);
  });

  it('active block: constant-rate fixture gives exact $/h and projected block total', () => {
    // $0.50 every 30 minutes from 10:00; now = 12:00 → $2.00 over 2h since the
    // first event = $1.00/h; 3h remain to 15:00 → projected $2.00 + $3.00 = $5.00.
    const recs = [rec(T0), rec(T0 + 30 * M), rec(T0 + 60 * M), rec(T0 + 90 * M)];
    const now = T0 + 2 * H;
    const blocks = computeBlocks(recs, { now });
    assert.equal(blocks.length, 1);
    const b = blocks[0]!;
    assert.equal(b.active, true);
    assert.ok(b.projection);
    assert.equal(b.projection.elapsedMs, 2 * H);
    assert.equal(b.projection.remainingMs, 3 * H);
    assert.equal(b.projection.usdPerHour, 1);
    assert.equal(b.projection.projectedCostUsd, 5);
    // 600 tokens over 120 minutes = 5 tok/min; projected 600 + 5*180 = 1500.
    assert.equal(b.projection.tokensPerMinute, 5);
    assert.equal(b.projection.projectedTokens, 1500);
  });

  it('active block with no priced records reports null $ projection, never 0', () => {
    const blocks = computeBlocks([rec(T0, { costUsd: undefined })], { now: T0 + H });
    assert.equal(blocks[0]!.projection!.usdPerHour, null);
    assert.equal(blocks[0]!.projection!.projectedCostUsd, null);
  });

  it('currentBlock returns the active block, or null when the window has closed', () => {
    const recs = [rec(T0), rec(T0 + H)];
    assert.equal(currentBlock(recs, T0 + 2 * H)?.start, new Date(T0).toISOString());
    assert.equal(currentBlock(recs, T0 + 5 * H), null);
    assert.equal(currentBlock([], T0), null);
  });
});

describe('computePace (trailing windows)', () => {
  // $0.01 and 100 tokens every minute for the last 2h, at minutes 1..120 before now.
  const now = T0 + 5 * H;
  const steady: UsageWindowRecord[] = [];
  for (let i = 0; i < 120; i++) {
    steady.push(rec(now - i * M, { inputTokens: 60, outputTokens: 40, costUsd: 0.01 }));
  }

  it('constant rate: $/h and tokens/min exact in both the 15m and 1h windows', () => {
    const pace = computePace(steady, { now });
    assert.deepEqual(Object.keys(pace.windows).sort(), ['15m', '1h']);
    const w15 = pace.windows['15m'];
    const w60 = pace.windows['1h'];
    assert.equal(w15.records, 15);
    assert.equal(w60.records, 60);
    assert.ok(Math.abs(w15.usdPerHour! - 0.6) < 1e-9);
    assert.ok(Math.abs(w60.usdPerHour! - 0.6) < 1e-9);
    assert.equal(w15.tokensPerMinute, 100);
    assert.equal(w60.tokensPerMinute, 100);
    assert.equal(w15.etaBudgetHit, null); // no budget set
    assert.equal(pace.budget, null);
  });

  it('ETA to budget = (budget - spent) / rate', () => {
    const pace = computePace(steady, { now, budgetUsd: 2, spentUsd: 1.4 });
    // $0.60 left at $0.60/h → exactly 1h from now.
    const eta = Date.parse(pace.windows['1h'].etaBudgetHit!);
    assert.ok(Math.abs(eta - (now + H)) < 1000);
    assert.equal(pace.budget, 'ok');
  });

  it('no events in the trailing window yields null rates, not zeros', () => {
    const pace = computePace([rec(now - 3 * H)], { now, budgetUsd: 5, spentUsd: 1 });
    for (const w of Object.values(pace.windows)) {
      assert.equal(w.records, 0);
      assert.equal(w.usdPerHour, null);
      assert.equal(w.tokensPerMinute, null);
      assert.equal(w.etaBudgetHit, null);
    }
  });

  it('budget exhausted → etaBudgetHit null with budget: "exhausted", never negative', () => {
    const pace = computePace(steady, { now, budgetUsd: 1, spentUsd: 1.2 });
    assert.equal(pace.budget, 'exhausted');
    assert.equal(pace.windows['15m'].etaBudgetHit, null);
    assert.equal(pace.windows['1h'].etaBudgetHit, null);
  });

  it('sinceMs shortens the denominator for an observation younger than the window', () => {
    // Run started 30 min ago, $0.30 spent evenly: 1h window rate is $0.60/h, not $0.30/h.
    const recs: UsageWindowRecord[] = [];
    for (let i = 0; i < 30; i++) recs.push(rec(now - i * M, { costUsd: 0.01 }));
    const pace = computePace(recs, { now, sinceMs: now - 30 * M });
    assert.ok(Math.abs(pace.windows['1h'].usdPerHour! - 0.6) < 1e-9);
    assert.equal(pace.windows['1h'].effectiveMs, 30 * M);
  });
});

describe('paceFromSamples (live run cumulative totals)', () => {
  it('constant-rate cumulative samples give the exact rate in both windows', () => {
    const start = T0;
    const now = T0 + 2 * H;
    // Cumulative $1/h and 1000 tokens/min, sampled every 10 minutes.
    const samples = [];
    for (let t = start; t <= now; t += 10 * M) {
      samples.push({ t, costUsd: (t - start) / H, tokens: ((t - start) / M) * 1000 });
    }
    const pace = paceFromSamples(samples, { now });
    assert.ok(Math.abs(pace.windows['15m'].usdPerHour! - 1) < 1e-9);
    assert.ok(Math.abs(pace.windows['1h'].usdPerHour! - 1) < 1e-9);
    assert.ok(Math.abs(pace.windows['15m'].tokensPerMinute! - 1000) < 1e-6);
  });

  it('a single sample (nothing observed yet) yields null rates', () => {
    const pace = paceFromSamples([{ t: T0, costUsd: 0, tokens: 0 }], { now: T0 });
    assert.equal(pace.windows['15m'].usdPerHour, null);
  });

  it('budget consumed mid-run marks exhausted', () => {
    const pace = paceFromSamples(
      [
        { t: T0, costUsd: 0, tokens: 0 },
        { t: T0 + H, costUsd: 3, tokens: 10 },
      ],
      { now: T0 + H, budgetUsd: 2 },
    );
    assert.equal(pace.budget, 'exhausted');
    assert.equal(pace.spentUsd, 3);
    assert.equal(pace.windows['1h'].etaBudgetHit, null);
  });
});

describe('plan presets', () => {
  it('pins the preset table (updates must be deliberate diffs)', () => {
    const pinned = Object.fromEntries(
      Object.entries(PLAN_PRESETS).map(([k, p]) => [k, [p.windowTokens, p.windowUsd, p.windowMessages]]),
    );
    assert.deepEqual(pinned, {
      pro: [19_000, 18, 250],
      max5: [88_000, 35, 1_000],
      max20: [220_000, 140, 2_000],
    });
    for (const p of Object.values(PLAN_PRESETS)) {
      assert.ok(p.source.length > 0, `${p.name} source`);
      assert.match(p.asOf, /^\d{4}-\d{2}-\d{2}$/);
      assert.equal(p.estimate, true);
    }
  });

  it('unknown preset fails loud with the valid list', () => {
    assert.throws(() => resolvePlan('nonsense', {}), /unknown plan 'nonsense'.*pro, max5, max20, custom/);
  });

  it('custom without allowances lists exactly the missing values', () => {
    assert.throws(() => resolvePlan('custom', {}), /--plan-window-tokens, --plan-window-usd/);
    assert.throws(() => resolvePlan('custom', { windowTokens: 1000 }), (e: Error) =>
      /requires --plan-window-usd/.test(e.message) && !/--plan-window-tokens/.test(e.message));
    const p = resolvePlan('custom', { windowTokens: 1000, windowUsd: 10 });
    assert.equal(p?.windowTokens, 1000);
    assert.equal(p?.estimate, false);
  });

  it('undefined plan name resolves to undefined', () => {
    assert.equal(resolvePlan(undefined, {}), undefined);
  });

  it('planUsage frames the block as % of the window allowance (tokens = input+output)', () => {
    const b = computeBlocks([rec(T0, { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 50_000, costUsd: 14 })], { now: T0 + H })[0]!;
    const u = planUsage(b, resolvePlan('max20', {})!);
    assert.equal(u.windowTokensUsed, 1100);
    assert.equal(u.tokensPct, 0.5);
    assert.equal(u.usdPct, 10);
    assert.equal(u.messagesPct, 0.05);
  });
});
