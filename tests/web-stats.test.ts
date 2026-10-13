import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { writeRunRecord, type RunRecord } from '../src/core/registry.ts';
import { computeGlobalStats } from '../src/web/stats.ts';
import { startWebServer } from '../src/web/server.ts';

// #94: GET /api/stats. Pure rollup (src/web/stats.ts) with exact numbers, then
// the HTTP route in-process and the UI element in the served page.

const T0 = 1_700_000_000_000;
const NOW = T0 + 10_000_000;

function rec(over: Partial<RunRecord>): RunRecord {
  return { runId: 'r', agent: 'claude', startedAt: T0, status: 'success', ...over };
}
const totals = (i: number, o: number, cr: number, cw: number, cost: number): RunRecord['totals'] => ({
  inputTokens: i,
  outputTokens: o,
  cacheReadTokens: cr,
  cacheWriteTokens: cw,
  costUsd: cost,
});
const observed = (...m: string[]): RunRecord['usage'] =>
  ({ tokens: { available: true }, usd: { available: true }, model: { source: 'native', observed: m } }) as unknown as RunRecord['usage'];

function fixture(): RunRecord[] {
  return [
    rec({ runId: 'a', agent: 'claude', endedAt: T0 + 1000, exitStatus: 'success', totals: totals(100, 50, 10, 5, 1.5), usage: observed('opus') }),
    rec({ runId: 'b', agent: 'claude', endedAt: T0 + 3000, status: 'error', exitStatus: 'error', totals: totals(200, 100, 20, 0, 2.5), usage: observed('opus') }),
    rec({ runId: 'c', agent: 'codex', endedAt: T0 + 5000, exitStatus: 'success', totals: totals(10, 10, 0, 0, 0.5), usage: observed('gpt', 'mini') }),
    rec({ runId: 'd', agent: 'codex', endedAt: T0 + 7000, status: 'unavailable', exitStatus: 'unavailable', totals: totals(0, 0, 0, 0, 0) }),
    // live: running with a fresh heartbeat; unpriced (metering none)
    rec({ runId: 'e', agent: 'custom', status: 'running', pid: process.pid, updatedAt: NOW - 1000, startedAt: NOW - 9000, metering: 'none', totals: totals(5, 5, 0, 0, 0) }),
  ];
}

describe('computeGlobalStats', () => {
  const s = computeGlobalStats(fixture(), NOW);

  it('totals: runs, active, tokens by type, cost', () => {
    assert.equal(s.totalRuns, 5);
    assert.equal(s.activeRuns, 1);
    assert.deepEqual(s.tokens, { input: 315, output: 165, cacheRead: 30, cacheWrite: 5, total: 515 });
    assert.equal(s.costUsd, 4.5);
    assert.equal(s.unpricedRuns, 1);
  });

  it('success rate excludes unavailable outages and counts running as no success', () => {
    // verdicts: a b c e (d unavailable); successes: a c
    assert.equal(s.successRate, 2 / 4);
  });

  it('agent counts and per-agent success rate', () => {
    assert.equal(s.byAgent.claude!.runs, 2);
    assert.equal(s.byAgent.claude!.successRate, 0.5);
    assert.equal(s.byAgent.claude!.costUsd, 4);
    assert.equal(s.byAgent.codex!.runs, 2);
    assert.equal(s.byAgent.codex!.successRate, 1); // d excluded
    assert.equal(s.byAgent.custom!.unpricedRuns, 1);
  });

  it('model counts: observed, joined multi-model, unknown', () => {
    assert.equal(s.byModel.opus!.runs, 2);
    assert.equal(s.byModel['gpt+mini']!.runs, 1);
    assert.equal(s.byModel.unknown!.runs, 2);
  });

  it('status and exitStatus distributions', () => {
    assert.deepEqual(s.byStatus, { success: 2, error: 1, unavailable: 1, running: 1 });
    assert.deepEqual(s.byExitStatus, { success: 2, error: 1, unavailable: 1 });
  });

  it('per-run avg / p50 / p95 (nearest rank)', () => {
    // durations: 1000 3000 5000 7000 9000 (e: running, live => updatedAt - startedAt = 8000)
    assert.deepEqual(s.perRun.durationMs, { avg: 4800, p50: 5000, p95: 8000 });
    assert.deepEqual(s.perRun.costUsd, { avg: 1.125, p50: 0.5, p95: 2.5 }); // priced: 1.5 2.5 0.5 0
    assert.equal(s.perRun.tokens!.p50, 20);
  });

  it('empty input: zeros, null rates and distributions, no NaN', () => {
    const e = computeGlobalStats([], NOW);
    assert.equal(e.totalRuns, 0);
    assert.equal(e.successRate, null);
    assert.equal(e.perRun.durationMs, null);
    assert.deepEqual(e.byAgent, {});
  });

  it('is fast on a large snapshot (acceptance: sub-10ms path)', () => {
    const big: RunRecord[] = [];
    for (let i = 0; i < 2000; i++) big.push(rec({ runId: `x${i}`, agent: `a${i % 5}`, endedAt: T0 + i, totals: totals(i, i, 0, 0, 0.01) }));
    const t = performance.now();
    computeGlobalStats(big, NOW);
    assert.ok(performance.now() - t < 10, `took ${performance.now() - t}ms`);
  });
});

describe('GET /api/stats', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'ach-stats-94-'));
  let handle: Awaited<ReturnType<typeof startWebServer>> | null = null;
  before(async () => {
    for (const r of fixture()) writeRunRecord(stateDir, r);
    handle = await startWebServer({ port: 0, host: '127.0.0.1', token: 't', stateDir });
  });
  after(async () => {
    await handle?.close();
    rmSync(stateDir, { recursive: true, force: true });
  });
  const url = (p: string): string => `http://127.0.0.1:${handle!.port}${p}`;

  it('returns aggregate stats from the hub snapshot', async () => {
    const res = await fetch(url('/api/stats'));
    assert.equal(res.status, 200);
    const body = (await res.json()) as ReturnType<typeof computeGlobalStats>;
    assert.equal(body.totalRuns, 5);
    assert.equal(body.byAgent.claude!.runs, 2);
    assert.equal(body.tokens.input, 315);
    assert.equal(body.byStatus.error, 1);
  });

  it('main dashboard page carries the stats bar wired to /api/stats', async () => {
    const html = await (await fetch(url('/'))).text();
    assert.ok(html.includes('id="statsbar"'));
    assert.ok(html.includes('/api/stats'));
  });
});
