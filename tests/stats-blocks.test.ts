import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

// ---------------------------------------------------------------------------
// ach stats --blocks / --plan / pace (real subprocess). State is sandboxed via
// AGENTIC_CODING_HARNESS_STATE_DIR and an empty fake HOME so scanAll sees no
// real machine transcripts.
// ---------------------------------------------------------------------------

const CLI = new URL('../src/cli/ach.ts', import.meta.url).pathname;
const H = 3_600_000;
const M = 60_000;

function runCli(args: string[], env: Record<string, string>): { code: number; stdout: string; stderr: string } {
  const isBun = (process.versions as { bun?: string }).bun !== undefined;
  const clean = { ...process.env };
  delete clean.AGENTIC_CODING_HARNESS_PLAN;
  delete clean.AGENTIC_CODING_HARNESS_BUDGET_USD;
  const p = spawnSync(process.execPath, isBun ? [CLI, ...args] : ['--import', 'tsx', CLI, ...args], {
    env: { ...clean, ...env },
    encoding: 'utf8',
  });
  return { code: p.status ?? -1, stdout: p.stdout ?? '', stderr: p.stderr ?? '' };
}

function line(tsMs: number, agent: string, over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    ts: new Date(tsMs).toISOString(),
    agent,
    sessionId: `s-${agent}`,
    model: 'claude-sonnet-4-5',
    inputTokens: 1000,
    outputTokens: 100,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    costUsd: 0.5,
    ...over,
  });
}

describe('ach stats --blocks / --plan / pace', () => {
  let state: string;
  let codexOnly: string;
  let home: string;
  const now = Date.now();

  before(async () => {
    state = await fs.mkdtemp(path.join(os.tmpdir(), 'ach-blocks-state-'));
    codexOnly = await fs.mkdtemp(path.join(os.tmpdir(), 'ach-blocks-codex-'));
    home = await fs.mkdtemp(path.join(os.tmpdir(), 'ach-blocks-home-'));
    await fs.mkdir(path.join(state, 'raw', 'claude'), { recursive: true });
    await fs.writeFile(
      path.join(state, 'raw', 'claude', 's-claude.jsonl'),
      [
        line(now - 3 * 24 * H, 'claude'), // outside --days 2
        line(now - 30 * H, 'claude'),
        line(now - 20 * H, 'claude'),
        line(now - 10 * M, 'claude', { sessionId: 'x1' }), // active block
        line(now - 1 * M, 'claude', { sessionId: 'x2' }), // active block
        '',
      ].join('\n'),
    );
    await fs.mkdir(path.join(codexOnly, 'raw', 'codex'), { recursive: true });
    await fs.writeFile(path.join(codexOnly, 'raw', 'codex', 's.jsonl'), line(now - M, 'codex') + '\n');
  });

  after(async () => {
    for (const d of [state, codexOnly, home]) await fs.rm(d, { recursive: true, force: true });
  });

  const env = (dir = state) => ({ AGENTIC_CODING_HARNESS_STATE_DIR: dir, HOME: home });

  it('--blocks --json emits the block array with the documented fields', () => {
    const r = runCli(['stats', '--blocks', '--json'], env());
    assert.equal(r.code, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.blocks.length, 4);
    const active = out.blocks.filter((b: { active: boolean }) => b.active);
    assert.equal(active.length, 1);
    const b = active[0];
    for (const k of ['start', 'end', 'tokens', 'costUsd', 'active']) assert.ok(k in b, k);
    assert.equal(Date.parse(b.end) - Date.parse(b.start), 5 * H);
    assert.equal(b.records, 2);
    assert.equal(b.costUsd, 1);
    assert.ok(b.projection);
    assert.equal(typeof b.projection.usdPerHour, 'number');
    assert.equal(typeof b.projection.projectedCostUsd, 'number');
    assert.ok(b.projection.projectedCostUsd >= b.costUsd);
    for (const closed of out.blocks.filter((x: { active: boolean }) => !x.active)) assert.equal(closed.projection, null);
  });

  it('--blocks --days 2 limits blocks to the 2-day window', () => {
    const r = runCli(['stats', '--blocks', '--json', '--days', '2'], env());
    assert.equal(r.code, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).blocks.length, 3);
  });

  it('--blocks text shows the active block with $/h and a projected total', () => {
    const r = runCli(['stats', '--blocks'], env());
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /blocks \(claude 5h billing windows/);
    assert.match(r.stdout, /ACTIVE.*\$[\d.]+\/h.*projected \$[\d.]+/);
  });

  it('--blocks with no claude records prints the explanatory note and exits 0', () => {
    const r = runCli(['stats', '--blocks'], env(codexOnly));
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /Claude-scoped/);
    const j = runCli(['stats', '--blocks', '--json'], env(codexOnly));
    assert.equal(j.code, 0, j.stderr);
    const out = JSON.parse(j.stdout);
    assert.deepEqual(out.blocks, []);
    assert.match(out.blocksNote, /Claude-scoped/);
  });

  it('stats --json always carries a pace object with both trailing windows (additive)', () => {
    const r = runCli(['stats', '--json', '--budget-usd', '100'], env());
    assert.equal(r.code, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    for (const k of ['total', 'byAgent', 'byDay']) assert.ok(k in out, k);
    assert.deepEqual(Object.keys(out.pace.windows).sort(), ['15m', '1h']);
    assert.equal(out.pace.windows['15m'].records, 2);
    assert.equal(typeof out.pace.windows['15m'].usdPerHour, 'number');
    assert.equal(out.pace.budget, 'ok');
    assert.equal(out.pace.budgetUsd, 100);
    assert.equal(typeof out.pace.windows['1h'].etaBudgetHit, 'string');
  });

  it('pace: budget already exhausted → exhausted marker, null ETA', () => {
    const r = runCli(['stats', '--json'], { ...env(), AGENTIC_CODING_HARNESS_BUDGET_USD: '1' });
    assert.equal(r.code, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.pace.budget, 'exhausted');
    assert.equal(out.pace.windows['1h'].etaBudgetHit, null);
  });

  it('--plan max20 renders a "% of plan window used" line; absolute numbers unchanged', () => {
    const plain = runCli(['stats'], env());
    const r = runCli(['stats', '--plan', 'max20'], env());
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /% of plan window used/);
    assert.match(r.stdout, /max20/);
    const totals = (s: string) => s.split('\n').filter((l) => l.startsWith('totals'))[0];
    assert.equal(totals(r.stdout), totals(plain.stdout));
    const j = JSON.parse(runCli(['stats', '--plan', 'max20', '--json'], env()).stdout);
    assert.equal(j.plan.name, 'max20');
    assert.equal(j.plan.estimate, true);
    // active block: 2 records x (1000 in + 100 out) = 2200 of 220,000 = 1%.
    assert.equal(j.plan.current.tokensPct, 1);
  });

  it('--plan custom without allowances is a usage error naming the missing values', () => {
    const r = runCli(['stats', '--plan', 'custom'], env());
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /--plan-window-tokens, --plan-window-usd/);
  });

  it('--plan nonsense errors with the valid preset list', () => {
    const r = runCli(['stats', '--plan', 'nonsense'], env());
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /pro, max5, max20, custom/);
  });

  it('AGENTIC_CODING_HARNESS_PLAN=pro is honored; the CLI flag wins', () => {
    const r = runCli(['stats', '--json'], { ...env(), AGENTIC_CODING_HARNESS_PLAN: 'pro' });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).plan.name, 'pro');
    const f = runCli(['stats', '--json', '--plan', 'max5'], { ...env(), AGENTIC_CODING_HARNESS_PLAN: 'pro' });
    assert.equal(JSON.parse(f.stdout).plan.name, 'max5');
  });
});
