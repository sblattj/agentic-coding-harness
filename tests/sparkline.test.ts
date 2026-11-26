import "./support/no-network.mjs";
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { lastNDays, sparkline, sparkSupported } from '../src/cli/sparkline.ts';

describe('sparkline', () => {
  it('golden string: heights follow the ordering of the values', () => {
    assert.equal(sparkline([1, 2, 4, 8]), '▁▂▄█');
    assert.equal(sparkline([0, 1, 2, 3, 4, 5, 6, 7]), '▁▂▃▄▅▆▇█');
    assert.equal(sparkline([8, 4, 2, 1]), '█▄▂▁');
  });
  it('all-zero renders a flat low bar', () => {
    assert.equal(sparkline([0, 0, 0]), '▁▁▁');
  });
  it('single value and all-equal positive render flat mid blocks without NaN', () => {
    assert.equal(sparkline([5]), '▄');
    assert.equal(sparkline([3, 3, 3]), '▄▄▄');
    assert.equal(sparkline([0]), '▁');
  });
  it('empty input renders empty string', () => {
    assert.equal(sparkline([]), '');
  });
  it('NaN and negatives count as zero', () => {
    assert.equal(sparkline([NaN, -3, 4]), '▁▁█');
  });
  it('ascii mode prints min-max text', () => {
    assert.equal(sparkline([1, 2, 4, 8], { ascii: true }), 'min=1 max=8');
    assert.equal(sparkline([0.5, 2], { ascii: true, fmt: (n) => `$${n.toFixed(2)}` }), 'min=$0.50 max=$2.00');
    assert.equal(sparkline([], { ascii: true }), '');
  });
});

describe('lastNDays', () => {
  const b = (costUsd: number, inputTokens = 0, outputTokens = 0) => ({ costUsd, inputTokens, outputTokens });
  it('fills gaps with zero, ending at the latest day', () => {
    const byDay = { '2026-09-01': b(1), '2026-09-03': b(3), '2026-08-31': b(9) };
    assert.deepEqual(lastNDays(byDay, 4, 'cost'), [9, 1, 0, 3]);
  });
  it('tokens = input + output', () => {
    const byDay = { '2026-09-02': b(0, 10, 5), '2026-09-03': b(0, 1, 1) };
    assert.deepEqual(lastNDays(byDay, 3, 'tokens'), [0, 15, 2]);
  });
  it('crosses month boundaries and handles empty input', () => {
    assert.deepEqual(lastNDays({ '2026-03-01': b(2) }, 2, 'cost'), [0, 2]);
    assert.deepEqual(lastNDays({}, 3, 'cost'), [0, 0, 0]);
  });
  it('ends at an explicit endKey, so quiet trailing days are zeros', () => {
    const byDay = { '2026-09-01': b(1), '2026-09-02': b(2) };
    assert.deepEqual(lastNDays(byDay, 4, 'cost', '2026-09-04'), [1, 2, 0, 0]);
    assert.deepEqual(lastNDays({}, 2, 'cost', '2026-09-04'), [0, 0]);
    assert.deepEqual(lastNDays(byDay, 2, 'cost', 'not-a-day'), [1, 2]);
  });
});

describe('sparkSupported', () => {
  it('true for UTF-8 locales and unset env', () => {
    assert.equal(sparkSupported({ LANG: 'en_US.UTF-8' }), true);
    assert.equal(sparkSupported({ LANG: 'en_US.utf8' }), true);
    assert.equal(sparkSupported({}), true);
  });
  it('false for dumb/linux TERM', () => {
    assert.equal(sparkSupported({ TERM: 'dumb', LANG: 'en_US.UTF-8' }), false);
    assert.equal(sparkSupported({ TERM: 'linux' }), false);
  });
  it('false on an explicit non-UTF locale; first set var wins', () => {
    assert.equal(sparkSupported({ LANG: 'C' }), false);
    assert.equal(sparkSupported({ LC_ALL: 'POSIX', LANG: 'en_US.UTF-8' }), false);
    assert.equal(sparkSupported({ LC_ALL: 'en_US.UTF-8', LANG: 'C' }), true);
    assert.equal(sparkSupported({ LC_CTYPE: 'en_US.UTF-8', LANG: 'C' }), true);
  });
});

describe('ach stats --spark (CLI)', () => {
  const CLI = new URL('../src/cli/ach.ts', import.meta.url).pathname;
  let state: string;
  let home: string;

  function runCli(args: string[], extraEnv: Record<string, string> = {}) {
    const isBun = (process.versions as { bun?: string }).bun !== undefined;
    const clean = { ...process.env } as Record<string, string | undefined>;
    for (const k of ['AGENTIC_CODING_HARNESS_PLAN', 'AGENTIC_CODING_HARNESS_BUDGET_USD', 'LC_ALL', 'LC_CTYPE', 'LANG', 'TERM']) delete clean[k];
    const p = spawnSync(process.execPath, isBun ? [CLI, ...args] : ['--import', 'tsx', CLI, ...args], {
      env: { ...clean, AGENTIC_CODING_HARNESS_STATE_DIR: state, HOME: home, LANG: 'en_US.UTF-8', TERM: 'xterm', ...extraEnv } as NodeJS.ProcessEnv,
      encoding: 'utf8',
    });
    return { code: p.status ?? -1, stdout: p.stdout ?? '', stderr: p.stderr ?? '' };
  }

  before(async () => {
    state = await fs.mkdtemp(path.join(os.tmpdir(), 'ach-spark-state-'));
    home = await fs.mkdtemp(path.join(os.tmpdir(), 'ach-spark-home-'));
    await fs.mkdir(path.join(state, 'raw', 'claude'), { recursive: true });
    // Four consecutive UTC days ending today-ish, costs 1,2,4,8 (fixed absolute dates).
    const days = ['2026-05-01', '2026-05-02', '2026-05-03', '2026-05-04'];
    const costs = [1, 2, 4, 8];
    const lines = days.map((d, i) =>
      JSON.stringify({
        ts: `${d}T12:00:00.000Z`,
        agent: 'claude',
        sessionId: `s-${i}`,
        model: 'claude-sonnet-4-5',
        inputTokens: 1000,
        outputTokens: 100,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        costUsd: costs[i],
      }),
    );
    await fs.writeFile(path.join(state, 'raw', 'claude', 's.jsonl'), lines.join('\n') + '\n');
  });

  after(async () => {
    for (const d of [state, home]) await fs.rm(d, { recursive: true, force: true });
  });

  // Window ends 2026-05-04 (exclusive bound at the next midnight UTC).
  const UNTIL = '2026-05-05T00:00:00Z';

  const totalsLine = (out: string) => out.split('\n').find((l) => l.startsWith('totals'))!;

  it('--spark cost appends a 14-day bar to the totals line', () => {
    const r = runCli(['stats', '--spark', 'cost', '--until', UNTIL]);
    assert.equal(r.code, 0, r.stderr);
    assert.match(totalsLine(r.stdout), / spark\(cost,14d\)=▁{10}▂▃▅█/);
  });

  it('--no-spark and non-UTF locales fall back to ASCII min-max', () => {
    for (const r of [runCli(['stats', '--spark', 'cost', '--no-spark', '--until', UNTIL]), runCli(['stats', '--spark', 'cost', '--until', UNTIL], { LANG: 'C' })]) {
      assert.equal(r.code, 0, r.stderr);
      const l = totalsLine(r.stdout);
      assert.match(l, / spark\(cost,14d\)=min=\S+ max=\S+/);
      assert.doesNotMatch(l, /[▁-█�]/);
    }
  });

  it('--spark tokens works and --json adds a spark object only when asked', () => {
    const j = JSON.parse(runCli(['stats', '--spark', 'tokens', '--json', '--until', UNTIL]).stdout);
    assert.equal(j.spark.metric, 'tokens');
    assert.equal(j.spark.days, 14);
    assert.equal(j.spark.values.length, 14);
    assert.equal(j.spark.values[13], 1100);
    assert.ok(!('spark' in JSON.parse(runCli(['stats', '--json']).stdout)));
  });

  it('the bar ends at the window end, so quiet days after the last run show as low bars', () => {
    const r = runCli(['stats', '--spark', 'cost', '--until', '2026-05-07T00:00:00Z']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(totalsLine(r.stdout), / spark\(cost,14d\)=▁{8}▂▃▅█▁▁$/);
  });

  it('--spark bogus exits non-zero', () => {
    const r = runCli(['stats', '--spark', 'bogus']);
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /--spark/);
  });
});
