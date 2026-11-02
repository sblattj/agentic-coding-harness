import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
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

  it('success rate excludes unavailable, running and interrupted (no verdict)', () => {
    // verdicts: a b c (d unavailable, e live running); successes: a c.
    // Changed from 2/4 deliberately (#170): a live run has no verdict yet.
    assert.equal(s.successRate, 2 / 3);
    assert.equal(s.noVerdictRuns, 1); // e only; unavailable d is not counted
    assert.equal(s.window, 'all');
  });

  it('#170: many status-less (passive) rows do not drag the rate down; byStatus still shows them', () => {
    const rows: RunRecord[] = [];
    for (let i = 0; i < 50; i++) rows.push({ runId: `p${i}`, agent: 'claude', startedAt: T0 } as RunRecord);
    rows.push(rec({ runId: 's1' }), rec({ runId: 's2' }), rec({ runId: 'e1', status: 'error', exitStatus: 'error' }));
    const st = computeGlobalStats(rows, NOW);
    assert.equal(st.successRate, 2 / 3);
    assert.equal(st.byStatus.interrupted, 50);
    assert.equal(st.noVerdictRuns, 50);
    assert.equal(st.totalRuns, 53);
    assert.equal(st.byAgent.claude!.successRate, 2 / 3);
    assert.equal(st.byModel.unknown!.successRate, 2 / 3);
    // aborted stays a verdict
    assert.equal(computeGlobalStats([rec({ status: 'aborted' }), rec({ runId: 'q' })], NOW).successRate, 1 / 2);
    // only no-verdict rows: null, not 0
    assert.equal(computeGlobalStats(rows.slice(0, 5), NOW).successRate, null);
  });

  it('#170: window filters on updatedAt ?? endedAt ?? startedAt', () => {
    const day = 86_400_000;
    const rows = [
      rec({ runId: 'old', startedAt: NOW - 3 * day, endedAt: NOW - 3 * day + 10 }),
      rec({ runId: 'new', startedAt: NOW - 1000, endedAt: NOW - 500 }),
      rec({ runId: 'touched', startedAt: NOW - 9 * day, endedAt: NOW - 9 * day, updatedAt: NOW - 100 }),
    ];
    const w24 = computeGlobalStats(rows, NOW, NOW - day, '24h');
    assert.equal(w24.totalRuns, 2);
    assert.equal(w24.window, '24h');
    assert.equal(computeGlobalStats(rows, NOW).totalRuns, 3);
    assert.equal(computeGlobalStats(rows, NOW, NOW - 7 * day, '7d').totalRuns, 3); // old is 3d, touched updated just now
    assert.equal(computeGlobalStats(rows, NOW, NOW - 2 * day, '7d').totalRuns, 2);
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
    // Warm up once, then keep the best of 5: a single cold run on a loaded CI runner took 16 to 26ms.
    computeGlobalStats(big, NOW);
    let best = Infinity;
    for (let i = 0; i < 5; i++) {
      const t = performance.now();
      computeGlobalStats(big, NOW);
      best = Math.min(best, performance.now() - t);
    }
    assert.ok(best < 10, `best of 5 took ${best}ms`);
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
    assert.equal(body.window, 'all'); // absent param = all, unchanged for existing consumers
  });

  it('?window=bogus is a 400 listing the allowed values', async () => {
    const res = await fetch(url('/api/stats?window=bogus'));
    assert.equal(res.status, 400);
    const msg = JSON.stringify(await res.json());
    for (const w of ['24h', '7d', 'all']) assert.ok(msg.includes(w), msg);
  });

  it('?window=24h excludes fixture rows older than a day; all includes them', async () => {
    // fixture rows a-d are from 2023 (T0), e is relative to a synthetic NOW far in the past too.
    const day = (await (await fetch(url('/api/stats?window=24h'))).json()) as ReturnType<typeof computeGlobalStats>;
    assert.equal(day.window, '24h');
    assert.equal(day.totalRuns, 0);
    const all = (await (await fetch(url('/api/stats?window=all'))).json()) as ReturnType<typeof computeGlobalStats>;
    assert.equal(all.totalRuns, 5);
    const wk = (await (await fetch(url('/api/stats?window=7d'))).json()) as ReturnType<typeof computeGlobalStats>;
    assert.equal(wk.window, '7d');
  });

  it('main dashboard page carries the stats bar wired to /api/stats', async () => {
    const html = await (await fetch(url('/'))).text();
    assert.ok(html.includes('id="statsbar"'));
    assert.ok(html.includes('/api/stats'));
  });
});

describe('stats bar UI logic (index.html)', () => {
  const html = readFileSync(new URL('../src/web/index.html', import.meta.url), 'utf8');
  const block = /\/\* statsui:begin \*\/([\s\S]*?)\/\* statsui:end \*\//.exec(html);
  const ctx = createContext({ encodeURIComponent });
  it('carries the block; default window is 24h and the URL carries it', () => {
    assert.ok(block, 'index.html must carry the statsui block');
    runInContext(block![1], ctx);
    assert.equal(ctx.statsWindow, '24h');
    assert.equal(runInContext('statsUrl(statsWindow)', ctx), '/api/stats?window=24h');
    assert.equal(runInContext('statsUrl("7d")', ctx), '/api/stats?window=7d');
  });
  it('hides the models kv only when byModel is just the unknown bucket (or empty)', () => {
    const show = (m: unknown): boolean => runInContext(`showModelsKv(${JSON.stringify(m)})`, ctx) as boolean;
    assert.equal(show({ unknown: { runs: 3 } }), false);
    assert.equal(show({}), false);
    assert.equal(show({ opus: { runs: 1 } }), true);
    assert.equal(show({ unknown: { runs: 1 }, opus: { runs: 1 } }), true);
  });
  it('renderStats wiring: selector, window kv, no-verdict kv, selection kept across reload', () => {
    assert.ok(/kv\("window"/.test(html));
    assert.ok(/noVerdictRuns > 0\) kv\("no verdict"/.test(html));
    assert.ok(/fetch\(statsUrl\(statsWindow\)\)/.test(html));
    assert.ok(/setInterval\(loadStats, 5000\)/.test(html)); // reload reads the module-level statsWindow
  });
});
