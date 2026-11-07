import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { createContext, runInContext } from 'node:vm';
import { writeRunRecord, type RunRecord } from '../src/core/registry.ts';
import {
  applyRunFilter,
  eventTextMatches,
  matchesRunFilter,
  matchesSummaryQuery,
  EVENT_SCAN_MAX_RUNS,
  parseRunFilter,
  type RunFilter,
} from '../src/web/run-filter.ts';

// #68: /api/runs filters. Pure parse/apply, client mirror in index.html, real server over HTTP.

const T0 = 1_700_000_000_000;
const NOW = T0 + 10 * 86_400_000;

function rec(over: Partial<RunRecord> & { runId: string }): RunRecord {
  return {
    agent: 'claude',
    promptPreview: 'list the files',
    startedAt: T0,
    updatedAt: T0,
    status: 'success',
    totals: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.5 },
    ...over,
  };
}

const RUNS: RunRecord[] = [
  rec({ runId: 'a', agent: 'claude', promptPreview: 'Refactor the Parser', startedAt: T0, totals: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.1 } }),
  rec({ runId: 'b', agent: 'kiro', status: 'error', promptPreview: 'fix flaky test', startedAt: T0 + 86_400_000, totals: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 2 } }),
  rec({ runId: 'c', agent: 'claude', status: 'aborted', promptPreview: 'x', command: ['mytool', '--deploy', 'prod'], startedAt: T0 + 2 * 86_400_000, totals: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 5 } }),
  rec({ runId: 'd', agent: 'codex', promptPreview: 'unpriced', startedAt: T0 + 3 * 86_400_000, totals: undefined }),
  // "running" with a stale heartbeat is derived as interrupted (effectiveStatus)
  rec({ runId: 'e', agent: 'codex', status: 'running', pid: 2_000_000_000, updatedAt: T0, startedAt: T0 + 4 * 86_400_000, promptPreview: 'stalled' }),
];

function filter(qs: string): RunFilter {
  const p = parseRunFilter(new URLSearchParams(qs));
  assert.ok(p.ok, JSON.stringify(p));
  return p.filter;
}
const ids = async (qs: string, readEvents?: (r: RunRecord) => Promise<string | null>) =>
  (await applyRunFilter(RUNS, filter(qs), { now: NOW, ...(readEvents ? { readEvents } : {}) })).records.map((r) => r.runId);

describe('parseRunFilter', () => {
  it('no params: inactive', () => {
    const p = parseRunFilter(new URLSearchParams(''));
    assert.ok(p.ok && !p.active);
  });
  it('unrelated params leave the request inactive (backward compat)', () => {
    const p = parseRunFilter(new URLSearchParams('token=abc&_=1'));
    assert.ok(p.ok && !p.active);
  });
  for (const [qs, msg] of [
    ['minCost=abc', /minCost must be a number/],
    ['maxCost=', /maxCost must be a number/],
    ['since=yesterday', /since must be/],
    ['status=bogus', /status must be/],
    ['limit=0', /limit must be/],
    ['limit=100000', /limit must be/],
    ['offset=-1', /offset must be/],
    ['qin=everything', /qin must be/],
  ] as const) {
    it(`rejects ${qs}`, () => {
      const p = parseRunFilter(new URLSearchParams(qs));
      assert.ok(!p.ok);
      assert.match((p as { error: string }).error, msg);
    });
  }
});

describe('applyRunFilter', () => {
  it('agent (single and comma list)', async () => {
    assert.deepEqual(await ids('agent=kiro'), ['b']);
    assert.deepEqual(await ids('agent=kiro,codex'), ['b', 'd', 'e']);
  });
  it('status uses the effective status (stale running => interrupted)', async () => {
    assert.deepEqual(await ids('status=interrupted'), ['e']);
    assert.deepEqual(await ids('status=error,aborted'), ['b', 'c']);
  });
  it('cost range is inclusive and excludes unpriced runs', async () => {
    assert.deepEqual(await ids('minCost=2'), ['b', 'c']);
    assert.deepEqual(await ids('maxCost=2'), ['a', 'b', 'e']); // 'd' has no totals: excluded
    assert.deepEqual(await ids('minCost=0.1&maxCost=0.1'), ['a']);
  });
  it('since / until accept ms epoch and ISO dates, filter on startedAt', async () => {
    assert.deepEqual(await ids(`since=${T0 + 2 * 86_400_000}`), ['c', 'd', 'e']);
    assert.deepEqual(await ids(`until=${new Date(T0 + 86_400_000).toISOString()}`), ['a', 'b']);
  });
  it('q matches prompt text case-insensitively and the command summary', async () => {
    assert.deepEqual(await ids('q=parser'), ['a']);
    assert.deepEqual(await ids('q=--deploy'), ['c']);
  });
  it('limit/offset page the matches and total counts all matches', async () => {
    const page = await applyRunFilter(RUNS, filter('limit=2&offset=1'), { now: NOW });
    assert.deepEqual(page.records.map((r) => r.runId), ['b', 'c']);
    assert.equal(page.total, 5);
    assert.equal(page.offset, 1);
    assert.equal(page.limit, 2);
  });
  it('filters combine with AND', async () => {
    assert.deepEqual(await ids('agent=claude&minCost=1'), ['c']);
  });
  it('qin=events scans transcripts only for summary misses, within the run cap', async () => {
    const scanned: string[] = [];
    const read = async (r: RunRecord) => {
      scanned.push(r.runId);
      return r.runId === 'd' ? JSON.stringify({ type: 'message', content: 'the NEEDLE is here' }) + '\n' : null;
    };
    assert.deepEqual(await ids('q=needle&qin=events', read), ['d']);
    const page = await applyRunFilter(RUNS, filter('q=needle&qin=events'), { now: NOW, readEvents: read });
    assert.equal(page.scan?.scanned, 5);
    assert.equal(page.scan?.capped, false);
    // without qin=events the transcript is never read
    scanned.length = 0;
    await ids('q=needle', read);
    assert.deepEqual(scanned, []);
  });
  it('qin=events caps the number of scanned runs (newest first) and reports capped', async () => {
    const many = Array.from({ length: EVENT_SCAN_MAX_RUNS + 20 }, (_, i) => rec({ runId: `m${i}`, startedAt: T0 + i, promptPreview: 'zzz' }));
    let reads = 0;
    const page = await applyRunFilter(many, filter('q=needle&qin=events'), {
      now: NOW,
      readEvents: async () => {
        reads += 1;
        return null;
      },
    });
    assert.equal(reads, EVENT_SCAN_MAX_RUNS);
    assert.equal(page.scan?.capped, true);
  });
  it('eventTextMatches walks nested string fields and skips bad lines', () => {
    const text = 'not json\n' + JSON.stringify({ type: 'tool_call', arguments: { path: '/a/Needle.ts' } }) + '\n';
    assert.equal(eventTextMatches(text, 'needle'), true);
    assert.equal(eventTextMatches(text, 'absent'), false);
  });
});

describe('index.html filter mirror', () => {
  const html = readFileSync(new URL('../src/web/index.html', import.meta.url), 'utf8');
  const block = /\/\* runfilter:begin \*\/([\s\S]*?)\/\* runfilter:end \*\//.exec(html);
  const ctx = createContext({ isLive: () => false });
  it('embeds the block and agrees with the server filter on the same cases', () => {
    assert.ok(block, 'index.html must carry the runfilter block');
    runInContext(block![1]!, ctx);
    const j = <T>(v: unknown) => JSON.parse(JSON.stringify(v)) as T;
    for (const qs of ['agent=kiro,codex', 'status=interrupted', 'status=error,aborted', 'minCost=2', 'maxCost=2', 'q=parser', 'q=--deploy', 'agent=claude&minCost=1']) {
      const f = ctx.parseRunFilterQuery(`?${qs}`);
      const client = RUNS.filter((r) => ctx.runPassesFilter(j(r), f)).map((r) => r.runId);
      const sf = filter(qs);
      const server = RUNS.filter((r) => ids_sync(r, sf)).map((r) => r.runId);
      assert.deepEqual(client, server, qs);
    }
  });
  it('round-trips the URL query', () => {
    const f = ctx.parseRunFilterQuery('?agent=kiro&status=error,success&minCost=1.5&q=a%20b');
    assert.equal(ctx.runFilterQuery(f), 'agent=kiro&status=error%2Csuccess&minCost=1.5&q=a%20b');
  });
});

function ids_sync(r: RunRecord, f: RunFilter): boolean {
  return matchesRunFilter(r, f, NOW) && (f.q === undefined || matchesSummaryQuery(r, f.q));
}

// ------------------------------------------------------------ real server

const RUNNER = new URL('./helpers/web-server-runner.ts', import.meta.url).pathname;
const isBun = spawnSync('bun', ['--version'], { encoding: 'utf8' }).status === 0;

describe('GET /api/runs filters (bun subprocess)', { skip: isBun ? false : 'bun not on PATH' }, () => {
  let state = '';
  let child: ChildProcess | undefined;
  let base = '';
  const get = (qs: string) => fetch(`${base}/api/runs${qs}`);

  before(async () => {
    state = mkdtempSync(join(tmpdir(), 'harness-runfilter-'));
    mkdirSync(join(state, 'raw'), { recursive: true });
    const raw = join(state, 'raw', 'claude-s1.jsonl');
    writeFileSync(raw, JSON.stringify({ type: 'message', source: 'assistant', content: 'found the Zebra bug', timestamp: T0 }) + '\n');
    const seeded: RunRecord[] = [
      rec({ runId: 'h1', agent: 'claude', startedAt: T0, promptPreview: 'refactor parser', rawTranscript: raw }),
      rec({ runId: 'h2', agent: 'kiro', status: 'error', startedAt: T0 + 1000, promptPreview: 'fix tests', totals: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 3 }, rawTranscript: '/nonexistent/x.jsonl' }),
      rec({ runId: 'h3', agent: 'claude', startedAt: T0 + 2000, promptPreview: 'write docs', rawTranscript: '/nonexistent/y.jsonl' }),
    ];
    for (const r of seeded) writeRunRecord(state, r);
    child = spawn('bun', [RUNNER, state, ''], { stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout!.setEncoding('utf8');
    let out = '';
    const port = await new Promise<number>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('server never ready')), 20_000);
      child!.stdout!.on('data', (c: string) => {
        out += c;
        const m = /READY (\d+)\n/.exec(out);
        if (m) {
          clearTimeout(t);
          resolve(Number(m[1]));
        }
      });
    });
    base = `http://127.0.0.1:${port}`;
  });

  after(() => {
    child?.kill('SIGTERM');
    if (state) rmSync(state, { recursive: true, force: true });
  });

  const idsOf = async (qs: string) => ((await (await get(qs)).json()) as { records: RunRecord[] }).records.map((r) => r.runId).sort();

  it('unfiltered request keeps the exact legacy shape {records} with every run', async () => {
    const res = await get('');
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-total-count'), null);
    const body = (await res.json()) as Record<string, unknown>;
    assert.deepEqual(Object.keys(body), ['records']);
    assert.equal((body.records as unknown[]).length, 3);
  });
  it('agent + status + cost filters', async () => {
    assert.deepEqual(await idsOf('?agent=claude'), ['h1', 'h3']);
    assert.deepEqual(await idsOf('?status=error'), ['h2']);
    assert.deepEqual(await idsOf('?minCost=1'), ['h2']);
    assert.deepEqual(await idsOf('?maxCost=1&agent=claude'), ['h1', 'h3']);
  });
  it('since/until bound startedAt', async () => {
    assert.deepEqual(await idsOf(`?since=${T0 + 1000}`), ['h2', 'h3']);
    assert.deepEqual(await idsOf(`?until=${T0 + 1000}`), ['h1', 'h2']);
  });
  it('q finds a run by prompt text; limit/offset page it with total + header', async () => {
    assert.deepEqual(await idsOf('?q=PARSER'), ['h1']);
    const res = await get('?limit=1&offset=1');
    const body = (await res.json()) as { records: RunRecord[]; total: number; offset: number; limit: number };
    assert.equal(body.records.length, 1);
    assert.equal(body.total, 3);
    assert.equal(body.offset, 1);
    assert.equal(body.limit, 1);
    assert.equal(res.headers.get('x-total-count'), '3');
  });
  it('qin=events finds text only present in stored events and reports scan bounds', async () => {
    assert.deepEqual(await idsOf('?q=zebra'), []);
    const res = await get('?q=zebra&qin=events');
    const body = (await res.json()) as { records: RunRecord[]; scan: { scanned: number; capped: boolean; maxRuns: number; maxBytesPerRun: number } };
    assert.deepEqual(body.records.map((r) => r.runId), ['h1']);
    assert.equal(body.scan.capped, false);
    assert.equal(body.scan.maxBytesPerRun, 1024 * 1024);
  });
  it('invalid params give 400 with a message', async () => {
    const res = await get('?minCost=abc');
    assert.equal(res.status, 400);
    assert.match(((await res.json()) as { error: string }).error, /minCost must be a number/);
  });
  it('compare and stats still answer', async () => {
    assert.equal((await fetch(`${base}/api/compare`)).status, 200);
    assert.equal((await fetch(`${base}/api/stats`)).status, 200);
  });
});
