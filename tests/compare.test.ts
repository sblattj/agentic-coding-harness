import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { listRunRecords, writeRunRecord, type RunRecord } from '../src/core/registry.ts';
import { computeCompareRows } from '../src/web/compare.ts';
import { startWebServer } from '../src/web/server.ts';

// ---------------------------------------------------------------------------
// /api/compare (src/web/compare.ts + the server route): pure rollup math with
// exact-number assertions against spec §6.1 fixtures (Reference shape, this
// tree's field mapping: totals.*, endedAt, status ?? exitStatus), then the
// HTTP route in-process via startWebServer (node:http — tsx-safe).
// ---------------------------------------------------------------------------

const T0 = 1_700_000_000_000;

function base(over: Partial<RunRecord> = {}): RunRecord {
  return {
    runId: 'run-cmp',
    agent: 'claude',
    startedAt: T0,
    status: 'success',
    ...over,
  };
}

// Reference fixture: 3 external runs, one experiment × variant cell.
function referenceRuns(): RunRecord[] {
  const cells: Array<[number, number, number]> = [
    // [inputTokens, outputTokens, endedAt - startedAt]
    [4037, 75, 3_000],
    [1972, 75, 4_000],
    [4160, 155, 5_000],
  ];
  return cells.map(([inTok, outTok, dur], i) =>
    base({
      runId: `ns-${i + 1}`,
      agent: 'acme_cloud_harness',
      startedAt: T0,
      endedAt: T0 + dur,
      experiment: 'acme-final-proof',
      variant: 'acme-harness',
      source: 'external',
      producer: 'acme-feed/bridge@1',
      status: 'success',
      totals: { inputTokens: inTok, outputTokens: outTok, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 },
    }),
  );
}

describe('computeCompareRows (pure math)', () => {
  it('Reference fixture: one exact row for the experiment × variant cell', () => {
    const rows = computeCompareRows(referenceRuns(), ['experiment', 'variant']);
    assert.equal(rows.length, 1);
    const row = rows[0]!;
    assert.equal(row.experiment, 'acme-final-proof');
    assert.equal(row.variant, 'acme-harness');
    assert.equal(row.agent, 'acme_cloud_harness');
    assert.equal(row.runs, 3);
    assert.equal(row.avgTotalTokens, 10474 / 3); // (4112 + 2047 + 4315) / 3, no rounding
    assert.equal(row.avgCostUsd, 0);
    assert.equal(row.avgDurationMs, 4000); // (3000 + 4000 + 5000) / 3
    assert.equal(row.successRate, 1);
  });

  it('mixed statuses: status beats exitStatus, missing status falls back to exitStatus', () => {
    const group = (i: number, over: Partial<RunRecord>): RunRecord =>
      base({ runId: `mix-${i}`, experiment: 'exp-b', variant: 'v1', ...over });
    const records = [
      group(1, {}), // status success
      group(2, {}), // status success
      group(3, { status: 'error', exitStatus: 'success' }), // status wins → not success
      base({
        runId: 'mix-4',
        agent: 'opencode',
        experiment: 'exp-b',
        variant: 'v1',
        source: 'external',
        endedAt: T0 + 1000,
        exitStatus: 'success', // no status → fallback succeeds
      }),
      base({ runId: 'solo-1', experiment: 'exp-a', variant: 'v0', endedAt: T0 + 500 }),
    ];
    const rows = computeCompareRows(records, ['experiment', 'variant']);
    // row separation + ascending order by experiment
    assert.deepEqual(
      rows.map((r) => r.experiment),
      ['exp-a', 'exp-b'],
    );
    assert.deepEqual(
      rows.map((r) => r.runs),
      [1, 4],
    );
    assert.equal(rows[1]!.successRate, 0.75); // 3 of 4
    assert.equal(rows[1]!.agent, 'claude'); // first record's agent
    assert.equal(rows[0]!.avgDurationMs, 500);
  });

  it('local record with no experiment groups under its agent (fallback)', () => {
    const rows = computeCompareRows([base({ runId: 'local-1' })], ['experiment', 'variant']);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.experiment, 'claude');
    assert.equal(rows[0]!.agent, 'claude');
  });

  it('empty groupBy defaults to experiment × variant', () => {
    const rows = computeCompareRows(referenceRuns(), []);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.experiment, 'acme-final-proof');
    assert.equal(rows[0]!.variant, 'acme-harness');
  });

  it('undefined group value omits the column and sorts its row last', () => {
    const records = [
      base({ runId: 'wf-1', workflow: 'review' }),
      base({ runId: 'wf-2' }), // no workflow
    ];
    const rows = computeCompareRows(records, ['workflow']);
    assert.equal(rows.length, 2);
    assert.deepEqual(
      rows.map((r) => r.workflow),
      ['review', undefined],
    );
    assert.ok(!('workflow' in rows[1]!), 'undefined value must omit the property entirely');
    assert.deepEqual(JSON.parse(JSON.stringify(rows[1])), {
      agent: 'claude',
      runs: 1,
      avgTotalTokens: 0,
      avgCostUsd: 0,
      avgDurationMs: 0,
      successRate: 1,
    });
  });
});

// ----------------------------------------------------------------- HTTP route

describe('GET /api/compare (in-process server)', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'harness-compare-'));
  let handle: Awaited<ReturnType<typeof startWebServer>> | null = null;
  const base2 = (over: Partial<RunRecord>): RunRecord => base({ ...over, status: 'success' });

  before(async () => {
    writeRunRecord(stateDir, base2({ runId: 'http-1', experiment: 'e1', variant: 'v1', endedAt: T0 + 2000 }));
    writeRunRecord(
      stateDir,
      base2({
        runId: 'http-2',
        agent: 'acme_cloud_harness',
        experiment: 'e1',
        variant: 'v1',
        source: 'external',
        producer: 'acme-feed/bridge@1',
        endedAt: T0 + 4000,
        totals: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.25 },
      }),
    );
    handle = await startWebServer({ port: 0, host: '127.0.0.1', token: 't', stateDir });
  });

  after(async () => {
    await handle?.close();
    rmSync(stateDir, { recursive: true, force: true });
  });

  const url = (pathname: string): string => `http://127.0.0.1:${handle!.port}${pathname}`;

  it('by=experiment,variant → 200 rows deep-equal the pure-math result', async () => {
    const expected = computeCompareRows(listRunRecords(stateDir), ['experiment', 'variant']);
    const res = await fetch(url('/api/compare?by=experiment,variant'), {
      headers: { authorization: 'Bearer t' },
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { groupBy: string[]; rows: unknown[] };
    assert.deepEqual(body.groupBy, ['experiment', 'variant']);
    assert.deepEqual(body.rows, expected);
    assert.equal(body.rows.length, 1);
  });

  it('unknown by key → 400 with the allowed-keys error', async () => {
    const res = await fetch(url('/api/compare?by=foo'));
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), {
      error: 'by must be a comma list of: experiment, variant, workflow, agent',
    });
  });

  it('no token behaves exactly like /api/runs (JSON API is unauthenticated)', async () => {
    const runs = await fetch(url('/api/runs'));
    const cmp = await fetch(url('/api/compare'));
    assert.equal(runs.status, 200); // documented: only /ws is token-gated
    assert.equal(cmp.status, runs.status); // SAME gate as /api/runs
    const body = (await cmp.json()) as { groupBy: string[] };
    assert.deepEqual(body.groupBy, ['experiment', 'variant']); // absent → default
  });
});
