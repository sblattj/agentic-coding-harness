import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { DEFAULT_TITLE_FORMAT, renderTitle, takeTitleFlag, titleSequence, titleStats } from '../src/cli/dash.ts';
import type { RunRecord } from '../src/core/registry.ts';

// Terminal title updates in dash (#92).

const CLI = new URL('../src/cli/ach.ts', import.meta.url).pathname;
const isBun = spawnSync('bun', ['--version'], { encoding: 'utf8' }).status === 0;
const now = Date.now();

function rec(over: Partial<RunRecord>): RunRecord {
  return {
    runId: `r-${Math.random().toString(16).slice(2)}`,
    agent: 'claude',
    startedAt: now - 60_000,
    updatedAt: now - 1_000,
    status: 'success',
    totals: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.25 },
    ...over,
  };
}

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('dash terminal title (#92)', () => {
  it('counts live, done and visible runs; transcript rows never count', () => {
    const recs = [
      rec({ status: 'running', pid: process.pid, updatedAt: now }),
      rec({ status: 'success' }),
      rec({ status: 'error' }),
      rec({ status: 'success', startedAt: now - 5 * 3_600_000, updatedAt: now - 4 * 3_600_000 }),
      rec({ metadata: { source: 'transcript' } }),
    ];
    const s = titleStats(recs, false, now);
    assert.deepEqual({ active: s.active, done: s.done, total: s.total }, { active: 1, done: 2, total: 3 });
    assert.equal(titleStats(recs, true, now).total, 4);
  });

  it('spend sums today only and skips unpriced runs', () => {
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    const s = titleStats(
      [
        rec({}),
        rec({ totals: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 1.5 } }),
        rec({ startedAt: yesterday.getTime() }),
        rec({ usage: { tokens: { available: true }, usd: { available: false } } as RunRecord['usage'] }),
      ],
      false,
      now,
    );
    assert.equal(s.spendUsd, 1.75);
  });

  it('substitutes every token and leaves unknown ones literal', () => {
    const s = { active: 2, done: 3, total: 4, spendUsd: 1.234 };
    assert.equal(renderTitle('{active}|{done}|{total}|{pct}%|{spend}|{plan}|{}', s), '2|3|4|75%|$1.23|{plan}|{}');
    assert.equal(renderTitle(DEFAULT_TITLE_FORMAT, s), '2 running · 3/4');
    assert.equal(renderTitle('{pct}', { active: 0, done: 0, total: 0, spendUsd: 0 }), '0');
  });

  it('wraps the text in OSC 0 and strips control bytes', () => {
    assert.equal(titleSequence('1 running'), '\x1b]0;1 running\x07');
    assert.equal(titleSequence('a\x07b\x1b]0;c\nd'), '\x1b]0;ab]0;cd\x07');
  });

  it('takes the flag bare or with a format and leaves other args alone', () => {
    assert.deepEqual(takeTitleFlag(['--all']), { rest: ['--all'], format: undefined });
    assert.deepEqual(takeTitleFlag(['--set-terminal-title', '--all']), { rest: ['--all'], format: DEFAULT_TITLE_FORMAT });
    assert.deepEqual(takeTitleFlag(['--set-terminal-title={pct}%']), { rest: [], format: '{pct}%' });
    assert.deepEqual(takeTitleFlag(['--set-terminal-title=']), { rest: [], format: DEFAULT_TITLE_FORMAT });
  });

  it('non-TTY and --json output carry no escape sequences', () => {
    const root = mkdtempSync(join(tmpdir(), 'ach-dash-title-'));
    dirs.push(root);
    mkdirSync(join(root, 'runs'), { recursive: true });
    const r0 = rec({});
    writeFileSync(join(root, 'runs', `${r0.runId}.json`), JSON.stringify(r0));
    const run = (extra: string[]) => {
      const args = isBun ? [CLI] : ['--import', 'tsx', CLI];
      const r = spawnSync(isBun ? 'bun' : process.execPath, [...args, 'dash', '--state-only', '--state-dir', root, ...extra], { encoding: 'utf8' });
      assert.equal(r.status, 0, r.stderr);
      return r;
    };
    const plain = run(['--json']);
    for (const extra of [['--json', '--set-terminal-title'], ['--set-terminal-title={active}'], ['--json', '--set-terminal-title=x']]) {
      const r = run(extra);
      assert.doesNotMatch(r.stdout + r.stderr, /\x1b/, extra.join(' '));
      if (extra.includes('--json')) assert.equal(r.stdout, plain.stdout);
    }
  });
});
