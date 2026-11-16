// #198: `ach web` bounds its run-list views (bare GET /api/runs, the runs=1
// socket) to the newest page of slim records, pages older runs with
// ?order=newest&offset=, serves one full record at /api/runs/<runId>, and the
// grid prunes only tiles inside the pushed window.
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { after, before, describe, it } from 'node:test';
import { writeRunRecord, type RunRecord } from '../src/core/registry.ts';
import { applyRunFilter, parseRunFilter } from '../src/web/run-filter.ts';
import { newestFirst, slimRunRecord, windowRuns } from '../src/web/run-window.ts';
import { resolveListWindow } from '../src/cli/web.ts';
import { HarnessError } from '../src/core/types.ts';

const RUNNER = new URL('./helpers/web-server-runner.ts', import.meta.url).pathname;
const ACH = new URL('../src/cli/ach.ts', import.meta.url).pathname;
const isBun = spawnSync('bun', ['--version'], { encoding: 'utf8' }).status === 0;
const NOW = 1_800_000_000_000;
const DAY = 86_400_000;
const TAIL = 'x'.repeat(4000);

function rec(id: string, startedAt: number, over: Partial<RunRecord> = {}): RunRecord {
  return {
    runId: id, agent: 'claude', startedAt, updatedAt: startedAt, endedAt: startedAt,
    status: 'success', exitStatus: 'success', promptPreview: `prompt ${id}`,
    totals: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.01 },
    verify: { command: 'npm test', exitCode: 0, status: 'pass', durationMs: 5, timedOut: false, outputTail: TAIL, at: startedAt },
    ...over,
  };
}

describe('windowRuns / slimRunRecord (pure)', () => {
  const runs = [
    rec('old', NOW - 30 * DAY),
    rec('a', NOW - 1000),
    rec('b', NOW - 2000),
    rec('c', NOW - 2 * DAY),
    // running for 40 days with a fresh heartbeat: live, outside the window
    rec('live-old', NOW - 40 * DAY, { status: 'running', updatedAt: NOW - 1000, pid: process.pid, endedAt: undefined }),
  ];

  it('page one is the newest pageSize runs within recentMs, newest first', () => {
    const w = windowRuns(runs, { recentMs: 7 * DAY, pageSize: 2 }, NOW);
    assert.deepEqual(w.records.map((r) => r.runId), ['a', 'b', 'live-old']);
    assert.equal(w.nextOffset, 2);
    assert.equal(w.total, 5);
    assert.deepEqual(w.window, { recentMs: 7 * DAY, pageSize: 2 });
  });

  it('the age bound stops page one before the page size does', () => {
    const w = windowRuns(runs, { recentMs: 7 * DAY, pageSize: 50 }, NOW);
    assert.deepEqual(w.records.map((r) => r.runId), ['a', 'b', 'c', 'live-old']);
    assert.equal(w.nextOffset, 3);
  });

  it('no recentMs means the newest pageSize regardless of age', () => {
    const w = windowRuns(runs, { pageSize: 50 }, NOW);
    assert.deepEqual(w.records.map((r) => r.runId), ['a', 'b', 'c', 'old', 'live-old']);
    assert.equal(w.nextOffset, 5);
    assert.equal(w.window.recentMs, null);
  });

  it('list records drop the verify output tail, seal and corrections, keep the verdict', () => {
    const full = rec('s', NOW, {
      regrades: [{ command: 'npm test', exitCode: 1, status: 'fail', durationMs: 1, timedOut: false, outputTail: TAIL, at: NOW }],
      seal: { alg: 'sha256', head: 'h', count: 1 } as unknown as RunRecord['seal'],
      corrections: [] as unknown as RunRecord['corrections'],
    });
    const slim = slimRunRecord(full);
    assert.equal(slim.verify?.outputTail, undefined);
    assert.equal(slim.verify?.status, 'pass');
    assert.equal(slim.verify?.command, 'npm test');
    assert.equal(slim.regrades?.[0]?.outputTail, undefined);
    assert.equal(slim.regrades?.[0]?.status, 'fail');
    assert.equal('seal' in slim, false);
    assert.equal('corrections' in slim, false);
    assert.equal(full.verify?.outputTail, TAIL, 'the source record is not mutated');
  });

  it('newestFirst breaks startedAt ties by runId so pages are stable', () => {
    const tied = [rec('z', 5), rec('m', 5), rec('a', 9)];
    assert.deepEqual(newestFirst(tied).map((r) => r.runId), ['a', 'm', 'z']);
  });
});

describe('GET /api/runs order=newest (pure filter)', () => {
  const runs = [rec('mid', 2), rec('new', 3), rec('old', 1)];
  it('order=newest sorts before limit/offset; without it snapshot order is kept', async () => {
    const parsed = parseRunFilter(new URLSearchParams('order=newest&offset=1&limit=1'));
    assert.ok(parsed.ok && parsed.active);
    const page = await applyRunFilter(runs, parsed.filter);
    assert.deepEqual(page.records.map((r) => r.runId), ['mid']);
    const plain = parseRunFilter(new URLSearchParams('offset=1&limit=1'));
    assert.ok(plain.ok);
    assert.deepEqual((await applyRunFilter(runs, plain.filter)).records.map((r) => r.runId), ['new']);
  });
  it('rejects an unknown order', () => {
    const parsed = parseRunFilter(new URLSearchParams('order=oldest'));
    assert.ok(!parsed.ok);
    assert.match(parsed.error, /order must be/);
  });
});

describe('resolveListWindow (ach web --recent / --page-size)', () => {
  it('defaults to the last 7 days and 200 runs', () => {
    assert.deepEqual(resolveListWindow(undefined, undefined), { recentMs: 7 * DAY, pageSize: 200 });
  });
  it('accepts a duration, all, and a page size', () => {
    assert.deepEqual(resolveListWindow('12h', '50'), { recentMs: 12 * 3_600_000, pageSize: 50 });
    assert.deepEqual(resolveListWindow('all', undefined), { pageSize: 200 });
  });
  it('rejects bad values as usage errors', () => {
    for (const [r, p] of [['soon', undefined], ['0d', undefined], [undefined, '0'], [undefined, '1001'], [undefined, '2.5']] as const) {
      assert.throws(() => resolveListWindow(r, p), (e: unknown) => e instanceof HarnessError && e.code === 'USAGE');
    }
  });
});

describe('ach web --help', { skip: isBun ? false : 'bun not on PATH' }, () => {
  it('lists --state-only, --recent and --page-size', () => {
    const out = spawnSync('bun', [ACH, 'web', '--help'], { encoding: 'utf8' });
    const text = out.stdout + out.stderr;
    const block = text.slice(text.indexOf('ach web ['), text.indexOf('ach mcp ['));
    assert.ok(block.length > 0, 'web usage block present');
    for (const flag of ['--state-only', '--recent', '--page-size']) assert.ok(block.includes(flag), flag);
  });
});

describe('bounded list views (bun subprocess)', { skip: isBun ? false : 'bun not on PATH' }, () => {
  let state = '';
  let child: ChildProcess | undefined;
  let base = '';
  const N = 600;
  const now = Date.now();

  before(async () => {
    state = mkdtempSync(join(tmpdir(), 'harness-bounded-'));
    // N runs one hour apart: the newest few days are in the 7-day window.
    for (let i = 0; i < N; i++) writeRunRecord(state, rec(`r${String(i).padStart(4, '0')}`, now - i * 3_600_000));
    child = spawn('bun', [RUNNER, state, '', JSON.stringify({ recentMs: 7 * DAY, pageSize: 50 })], { stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout!.setEncoding('utf8');
    let out = '';
    const port = await new Promise<number>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('server never ready')), 20_000);
      child!.stdout!.on('data', (c: string) => {
        out += c;
        const m = /READY (\d+)\n/.exec(out);
        if (m) { clearTimeout(t); resolve(Number(m[1])); }
      });
    });
    base = `http://127.0.0.1:${port}`;
  });

  after(() => {
    child?.kill('SIGTERM');
    if (state) rmSync(state, { recursive: true, force: true });
  });

  it('bare GET /api/runs carries page one only, slim, with paging metadata', async () => {
    const res = await fetch(`${base}/api/runs`);
    const text = await res.text();
    const body = JSON.parse(text) as { records: RunRecord[]; total: number; nextOffset: number; window: { pageSize: number } };
    assert.equal(body.records.length, 50);
    assert.equal(body.records[0]!.runId, 'r0000');
    assert.equal(body.total, N);
    assert.equal(body.nextOffset, 50);
    assert.equal(body.window.pageSize, 50);
    assert.equal(res.headers.get('x-total-count'), String(N));
    assert.ok(!text.includes(TAIL), 'verify output tails stay out of the list');
    // 600 records with a 4 KB tail each would be >2.4 MB; page one is tiny.
    assert.ok(text.length < 50 * 1024, `page one is ${text.length} bytes`);
  });

  it('order=newest&offset pages reach the oldest run', async () => {
    let offset = 50;
    const seen: string[] = [];
    for (let guard = 0; guard < 20 && offset < N; guard++) {
      const page = (await (await fetch(`${base}/api/runs?order=newest&offset=${offset}&limit=200`)).json()) as { records: RunRecord[]; total: number };
      assert.ok(page.records.length > 0);
      assert.ok(page.records.every((r) => r.verify?.outputTail === undefined), 'pages are slim too');
      seen.push(...page.records.map((r) => r.runId));
      offset += page.records.length;
    }
    assert.equal(seen[0], 'r0050');
    assert.equal(seen.at(-1), `r${String(N - 1).padStart(4, '0')}`);
    assert.equal(new Set(seen).size, N - 50);
  });

  it('GET /api/runs/<runId> returns the full record, 404 for an unknown id', async () => {
    const res = await fetch(`${base}/api/runs/r0599`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { record: RunRecord };
    assert.equal(body.record.runId, 'r0599');
    assert.equal(body.record.verify?.outputTail, TAIL);
    assert.equal((await fetch(`${base}/api/runs/nope`)).status, 404);
  });

  it('the runs=1 socket snapshot is the same bounded page', async () => {
    if (typeof WebSocket === 'undefined') return;
    const ws = new WebSocket(`${base.replace('http', 'ws')}/ws?runs=1`);
    const msg = await new Promise<{ type: string; records: RunRecord[]; total: number; nextOffset: number }>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('no runs message')), 10_000);
      ws.onmessage = (ev) => { clearTimeout(t); resolve(JSON.parse(String(ev.data))); };
    });
    ws.close();
    assert.equal(msg.type, 'runs');
    assert.equal(msg.records.length, 50);
    assert.equal(msg.total, N);
    assert.equal(msg.nextOffset, 50);
  });
});

describe('grid tilesToPrune', () => {
  const html = readFileSync(new URL('../src/web/grid.html', import.meta.url), 'utf8');
  const start = html.indexOf('function tilesToPrune(');
  let end = -1;
  for (let i = html.indexOf('{', start), depth = 0; i < html.length; i++) {
    if (html[i] === '{') depth++;
    if (html[i] === '}' && --depth === 0) { end = i + 1; break; }
  }
  const fn = html.slice(start, end);
  const prune = (states: Map<string, { rec: { startedAt: number }; older?: boolean }>, seen: string[], mode: string, boundary: number | null): string[] =>
    [...(runInNewContext(`${fn}\ntilesToPrune(states, seen, mode, boundary)`, { states, seen: new Set(seen), mode, boundary }) as string[])];

  const states = new Map([
    ['new', { rec: { startedAt: 30 } }],
    ['gone', { rec: { startedAt: 20 } }],
    ['fell-out', { rec: { startedAt: 5 } }],
    ['older-page', { rec: { startedAt: 25 }, older: true }],
  ]);

  it('a window push keeps older-page tiles and tiles older than the window', () => {
    assert.deepEqual(prune(states, ['new'], 'window', 10), ['gone']);
  });
  it('an older page prunes nothing; a full snapshot prunes every missing tile', () => {
    assert.deepEqual(prune(states, [], 'none', 10), []);
    assert.deepEqual(prune(states, ['new'], 'all', null).sort(), ['fell-out', 'gone', 'older-page']);
  });
});

describe('ach web reads web.recent / web.pageSize from the config file', { skip: isBun ? false : 'bun not on PATH' }, () => {
  let state = '';
  let child: ChildProcess | undefined;
  after(() => {
    child?.kill('SIGTERM');
    if (state) rmSync(state, { recursive: true, force: true });
  });

  it('a numeric pageSize and recent "all" bound the real CLI list', async () => {
    state = mkdtempSync(join(tmpdir(), 'harness-bounded-cfg-'));
    // Years old: outside the 7d default, so only recent "all" shows them.
    for (let i = 0; i < 5; i++) writeRunRecord(state, rec(`c${i}`, NOW - 400 * DAY - i * 1000));
    const cfg = join(state, 'config.json');
    writeFileSync(cfg, JSON.stringify({ web: { recent: 'all', pageSize: 3 } }));
    child = spawn('bun', [ACH, 'web', '--no-open', '--state-only', '--port', '0', '--state-dir', state], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, HOME: state, AGENTIC_CODING_HARNESS_CONFIG: cfg, AGENTIC_CODING_HARNESS_HTTP_TOKEN: '' },
    });
    child.stderr!.setEncoding('utf8');
    let err = '';
    const port = await new Promise<number>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`web never ready: ${err}`)), 20_000);
      child!.stderr!.on('data', (c: string) => {
        err += c;
        const m = /web dashboard: http:\/\/[^:]+:(\d+)/.exec(err);
        if (m) { clearTimeout(t); resolve(Number(m[1])); }
      });
    });
    const body = (await (await fetch(`http://127.0.0.1:${port}/api/runs`)).json()) as { records: RunRecord[]; total: number; window: { recentMs: number | null; pageSize: number } };
    assert.deepEqual(body.window, { recentMs: null, pageSize: 3 });
    assert.deepEqual(body.records.map((r) => r.runId), ['c0', 'c1', 'c2']);
    assert.equal(body.total, 5);
  });
});

describe('index mergeRunList', () => {
  const html = readFileSync(new URL('../src/web/index.html', import.meta.url), 'utf8');
  const start = html.indexOf('function mergeRunList(');
  let end = -1;
  for (let i = html.indexOf('{', start), depth = 0; i < html.length; i++) {
    if (html[i] === '{') depth++;
    if (html[i] === '}' && --depth === 0) { end = i + 1; break; }
  }
  const fn = html.slice(start, end);
  type R = { runId: string; startedAt: number };
  const merge = (current: R[], data: unknown, older: string[]): string[] =>
    [...(runInNewContext(`${fn}\nmergeRunList(current, data, older).map(function (r) { return r.runId; })`, { current, data, older: new Set(older) }) as string[])];

  const current: R[] = [
    { runId: 'new', startedAt: 30 }, { runId: 'gone', startedAt: 35 },
    { runId: 'older-page', startedAt: 33 }, { runId: 'fell-out', startedAt: 5 },
  ];
  it('a bounded push keeps older-page runs and runs older than the window, drops deleted ones', () => {
    const data = { records: [{ runId: 'newer', startedAt: 40 }, { runId: 'new', startedAt: 30 }], nextOffset: 2, total: 9, window: { recentMs: null, pageSize: 2 } };
    assert.deepEqual(merge(current, data, ['older-page']), ['newer', 'new', 'older-page', 'fell-out']);
  });
  it('an unbounded snapshot replaces the list', () => {
    assert.deepEqual(merge(current, { records: [{ runId: 'only', startedAt: 1 }] }, ['older-page']), ['only']);
  });
});
