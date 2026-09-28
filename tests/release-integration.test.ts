import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { runExitCode } from '../src/cli/exit-codes.ts';
import { statsProvenance } from '../src/cli/stats-provenance.ts';
import { aggregateDims, baseCacheRatios } from '../src/cli/stats-dims.ts';
import { aggregate } from '../src/cli/lib.ts';
import { createPricer } from '../src/core/pricing.ts';
import { readAllRecords } from '../src/core/store.ts';

const cli = fileURLToPath(new URL('../src/cli/ach.ts', import.meta.url));
function invoke(state: string, args: string[]) {
  const bun = Boolean((process.versions as { bun?: string }).bun);
  return spawnSync(process.execPath, bun ? [cli, ...args] : ['--import', 'tsx', cli, ...args], {
    encoding: 'utf8', timeout: 15000,
    env: { ...process.env, HOME: state, AGENTIC_CODING_HARNESS_STATE_DIR: state,
      AGENTIC_CODING_HARNESS_COST_MODE: 'auto', AGENTIC_CODING_HARNESS_TZ: 'UTC',
      AGENTIC_CODING_HARNESS_BUDGET_USD: '100', AGENTIC_CODING_HARNESS_MAX_TURNS: '100',
      AGENTIC_CODING_HARNESS_WALL_MS: '10000', AGENTIC_CODING_HARNESS_IDLE_MS: '10000' },
  });
}
const row = { ts: '2026-09-28T01:00:00Z', agent: 'claude', model: 'claude-sonnet-4-5',
  inputTokens: 100, outputTokens: 10, cacheReadTokens: 20, cacheWriteTokens: 0, reasoningTokens: 0,
  costUsd: 2, costSource: 'reported' as const, cwd: '/project' };

test('timezone and week/month provenance, model days and cache ratios share bucket boundaries', () => {
  const opts = { timeZone: 'America/Los_Angeles', by: ['day', 'week', 'month'] as ('day'|'week'|'month')[] };
  const agg = aggregate([row], opts);
  const prov = statsProvenance([row], opts);
  assert.deepEqual(Object.keys(prov.byDay), Object.keys(agg.byDay));
  assert.deepEqual(Object.keys(prov.byWeek!), Object.keys(agg.byWeek!));
  assert.equal(prov.byDay['2026-09-27']!.costUsd, 'reported');
  const control = statsProvenance([row], { ...opts, timeZone: 'UTC' });
  assert.ok(control.byDay['2026-09-28']);
  const dims = aggregateDims([row], { timeZone: opts.timeZone, byModelDay: true });
  assert.ok(dims.byModelDay!['2026-09-27']);
  assert.deepEqual(Object.keys(baseCacheRatios(agg).byWeek!), Object.keys(agg.byWeek!));
  assert.deepEqual(Object.keys(baseCacheRatios(agg).byMonth!), Object.keys(agg.byMonth!));
});

test('calculate ignores per-model reported costs, display leaves unpriced project cost null', () => {
  const mixed = { ...row, extra: { raw: { models: [
    { model: 'claude-sonnet-4-5', input: 100, output: 10, costUsd: 9 },
    { model: 'claude-haiku-4-5', input: 100, output: 10, costUsd: 9 },
  ] } } };
  const auto = aggregateDims([mixed], { pricer: createPricer() });
  const calc = aggregateDims([mixed], { pricer: createPricer(), costMode: 'calculate' });
  assert.equal(auto.byModel['claude/claude-sonnet-4-5']!.costUsd, 9);
  assert.ok(calc.byModel['claude/claude-sonnet-4-5']!.costUsd! < 1);
  assert.equal(aggregateDims([{ ...row, costUsd: undefined }], { byProject: true }).byProject!['/project']!.costUsd, null);
});

test('repeat ladder matches single-run limit and verify failure policies', () => {
  const state = mkdtempSync(join(tmpdir(), 'ach-integration-'));
  try {
    for (const repeat of [[], ['--repeat', '2']]) {
      const result = invoke(state, ['run', '--agent', 'null', '--max-turns', '1', '--on-budget', 'warn', '--exit-codes', 'ladder', ...repeat, 'hello']);
      assert.equal(result.status, 11, result.stderr);
      const verify = invoke(state, ['run', '--agent', 'null', '--verify', 'false', '--exit-codes', 'ladder', ...repeat, 'hello']);
      assert.equal(verify.status, 1, verify.stderr);
    }
  } finally { rmSync(state, { recursive: true, force: true }); }
});

test('stats project/until filters cover unmetered and outcome registry groups', () => {
  const state = mkdtempSync(join(tmpdir(), 'ach-filter-'));
  try {
    mkdirSync(join(state, 'runs'));
    const t = Date.parse('2026-09-20T00:00:00Z');
    for (const [i, cwd, startedAt] of [[1, '/selected', t], [2, '/other', t], [3, '/selected', t + 86400000]] as const) {
      writeFileSync(join(state, 'runs', `${i}.json`), JSON.stringify({ runId: `${i}`, agent: 'custom', sessionId: `${i}`, cwd, startedAt, status: 'success', metering: 'none' }));
    }
    const r = invoke(state, ['stats', '--state-only', '--json', '--project', '/selected', '--until', '2026-09-21']);
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.unmetered.runs, 1);
    assert.equal(out.runOutcomes.total.runs, 1);
  } finally { rmSync(state, { recursive: true, force: true }); }
});

test('doctor discovers a descriptor and null without invoking a real vendor', () => {
  const state = mkdtempSync(join(tmpdir(), 'ach-doctor-integration-'));
  try {
    mkdirSync(join(state, 'agents.d'));
    writeFileSync(join(state, 'agents.d', 'local.json'), JSON.stringify({ name: 'localprobe', launch: { template: `${process.execPath} {prompt}` } }));
    for (const agent of ['localprobe', 'null']) {
      const r = invoke(state, ['doctor', '--agent', agent, '--json']);
      assert.equal(r.status, 0, r.stderr + r.stdout);
      const out = JSON.parse(r.stdout);
      assert.equal(out.promptsSent, 0);
      assert.ok(out.checks.some((c: { agent: string }) => c.agent === agent));
    }
  } finally { rmSync(state, { recursive: true, force: true }); }
});

test('state read preserves unknown cost separately from explicitly reported zero', async () => {
  const state = mkdtempSync(join(tmpdir(), 'ach-cost-honesty-'));
  const old = process.env.AGENTIC_CODING_HARNESS_STATE_DIR;
  try {
    process.env.AGENTIC_CODING_HARNESS_STATE_DIR = state;
    mkdirSync(join(state, 'raw'));
    writeFileSync(join(state, 'raw', 'claude-test.jsonl'), [
      { ...row, costUsd: undefined }, { ...row, costUsd: 0 },
    ].map((r) => JSON.stringify(r)).join('\n'));
    const rows = await readAllRecords();
    assert.equal(rows[0]!.costUsd, undefined);
    assert.equal(rows[1]!.costUsd, 0);
  } finally {
    if (old === undefined) delete process.env.AGENTIC_CODING_HARNESS_STATE_DIR; else process.env.AGENTIC_CODING_HARNESS_STATE_DIR = old;
    rmSync(state, { recursive: true, force: true });
  }
});

test('successful warn-only over-budget runs exit 11 while near-limit runs exit 10', () => {
  const result = { runId: 'r', sessionId: 's', events: [], tokens: [], warnings: [], durationMs: 1, exitStatus: 'success' as const, totalCost: 1.1 };
  assert.equal(runExitCode(result, { mode: 'ladder', budget: { usd: 1 } }), 11);
  assert.equal(runExitCode({ ...result, totalCost: 0.9 }, { mode: 'ladder', budget: { usd: 1 } }), 10);
  assert.equal(runExitCode(result, { mode: 'binary', budget: { usd: 1 } }), 0);
});
