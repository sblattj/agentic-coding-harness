import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { describe, it } from 'node:test';
import { frame, PaceTracker } from '../src/cli/dash.ts';
import type { RunRecord } from '../src/core/registry.ts';

// ach dash pace row (#19): a live run shows its $/h and tok/min over the
// trailing 15m/1h windows; the row disappears (not stale) once the run ends.

const H = 3_600_000;

function rec(over: Partial<RunRecord>): RunRecord {
  const now = Date.now();
  return {
    runId: 'run-pace-1',
    agent: 'claude',
    pid: process.pid, // alive → isLive when status running + fresh heartbeat
    cwd: tmpdir(),
    startedAt: now - H,
    updatedAt: now,
    status: 'running',
    totals: { inputTokens: 60_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 2 },
    ...over,
  };
}

describe('dash pace row', () => {
  it('appears for a live run with $/h and tok/min', () => {
    const out = frame([rec({})], '/state', false, 160, false);
    const row = out.split('\n').find((l) => l.startsWith('pace'));
    assert.ok(row, out);
    // $2 over 1h since start = $2.0000/h; 60,000 tok / 60 min = 1000 tok/min.
    assert.match(row, /run-pace/);
    assert.match(row, /1h \$2\.0000\/h 1000\.0 tok\/min/);
  });

  it('disappears when the run ends (not stale)', () => {
    const out = frame([rec({ status: 'success' })], '/state', false, 160, false);
    assert.equal(out.split('\n').some((l) => l.startsWith('pace')), false);
  });

  it('budget consumed mid-run shows exhausted, never a negative ETA', () => {
    const out = frame([rec({})], '/state', false, 160, false, { budgetUsd: 1 });
    const row = out.split('\n').find((l) => l.startsWith('pace'))!;
    assert.match(row, /budget exhausted/);
  });

  it('budget left shows an ETA', () => {
    const out = frame([rec({})], '/state', false, 160, false, { budgetUsd: 4 });
    const row = out.split('\n').find((l) => l.startsWith('pace'))!;
    assert.match(row, /budget \$4 hit at \d\d:\d\d/);
  });

  it('a usd-unavailable run renders n/a, not $0', () => {
    const out = frame(
      [rec({ usage: { tokens: { available: false }, usd: { available: false } } as RunRecord['usage'] })],
      '/state',
      false,
      160,
      false,
    );
    const row = out.split('\n').find((l) => l.startsWith('pace'))!;
    assert.match(row, /15m n\/a n\/a/);
  });

  it('the tracker uses redraw samples so the 15m rate reflects recent activity', () => {
    const tracker = new PaceTracker();
    const now = Date.now();
    const base = rec({ startedAt: now - 2 * H });
    // Idle for 105 minutes, then $1 in the last 15 minutes.
    tracker.observe({ ...base, totals: { ...base.totals!, costUsd: 0 } }, now - 15 * 60_000);
    tracker.observe({ ...base, totals: { ...base.totals!, costUsd: 1 } }, now);
    const pace = tracker.pace(base, now, undefined);
    assert.ok(Math.abs(pace.windows['15m'].usdPerHour! - 4) < 1e-6);
    assert.ok(Math.abs(pace.windows['1h'].usdPerHour! - 1) < 1e-6);
  });
});
