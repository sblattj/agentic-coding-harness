import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { frame } from '../src/cli/dash.ts';
import type { RunRecord } from '../src/core/registry.ts';

// ---------------------------------------------------------------------------
// ach dash (integration, real subprocess)
//
// Spawns the CLI entrypoint (src/cli/ach.ts, wired by another seat) with
// pipes for stdio — i.e. non-TTY, where the documented fallback dumps the
// current RunRecord[] as JSON and exits (the --json flag forces the same).
// State is sandboxed via AGENTIC_CODING_HARNESS_STATE_DIR (src/core/store.ts
// stateDir()) so nothing touches the real ~/.agentic-coding-harness. Expected to fail
// until the dash subcommand lands.
// ---------------------------------------------------------------------------

const CLI = new URL('../src/cli/ach.ts', import.meta.url).pathname;

// bun runs .ts natively; node needs the tsx loader (same rule as mcp.test.ts).
const isBun = spawnSync('bun', ['--version'], { encoding: 'utf8' }).status === 0;

const states: string[] = [];
function mkState(): string {
  const dir = mkdtempSync(join(tmpdir(), 'harness-dash-'));
  states.push(dir);
  return dir;
}

afterEach(() => {
  while (states.length) rmSync(states.pop()!, { recursive: true, force: true });
});

function seedRuns(stateDir: string, recs: Array<Record<string, unknown>>): void {
  mkdirSync(join(stateDir, 'runs'), { recursive: true });
  for (const r of recs) {
    writeFileSync(join(stateDir, 'runs', `${r.runId}.json`), JSON.stringify(r));
  }
}

function dashArgs(stateDir: string, extra: string[] = []): string[] {
  return ['dash', '--dir', stateDir, ...extra];
}

function runCli(args: string[], stateDir: string): { code: number; stdout: string; stderr: string } {
  const cli = isBun ? [CLI, ...args] : ['--import', 'tsx', CLI, ...args];
  const p = spawnSync(isBun ? 'bun' : process.execPath, cli, {
    env: { ...process.env, AGENTIC_CODING_HARNESS_STATE_DIR: stateDir },
    encoding: 'utf8',
    timeout: 15_000,
    killSignal: 'SIGKILL',
    stdio: ['ignore', 'pipe', 'pipe'], // pipes => non-TTY from the child's view
  });
  return { code: p.status ?? -1, stdout: p.stdout ?? '', stderr: p.stderr ?? '' };
}

function runRec(over: Record<string, unknown>): Record<string, unknown> {
  return {
    agent: 'claude',
    pid: process.ppid,
    cwd: tmpdir(),
    promptPreview: 'hi',
    startedAt: 0,
    updatedAt: 0,
    status: 'running',
    totals: { inputTokens: 10, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.01 },
    rawTranscript: join(tmpdir(), 'raw.jsonl'),
    ...over,
  };
}

describe('ach dash --json (real subprocess, non-TTY)', () => {
  it('reports live, interrupted, and finished runs, sorted by startedAt desc, with correct live flags', { timeout: 20_000 }, () => {
    const state = mkState();
    const now = Date.now();
    const live = runRec({ runId: 'run-live-1', status: 'running', startedAt: now - 5_000, updatedAt: now });
    const interrupted = runRec({
      runId: 'run-intr-1',
      status: 'running', // on-disk status stays running; effectiveStatus derives interrupted
      pid: 4194303, // dead pid
      startedAt: now - 2_000,
      updatedAt: now,
    });
    const done = runRec({
      runId: 'run-done-1',
      status: 'success',
      exitStatus: 'success',
      pid: 4194303, // dead: no false live flag
      startedAt: now - 3_600_000,
      updatedAt: now - 3_600_000,
    });
    seedRuns(state, [done, interrupted, live]); // seeded out of order; dash must sort
    const res = runCli(dashArgs(state, ['--json']), state);
    assert.equal(res.code, 0, `exit ${res.code}; stderr: ${res.stderr}`);
    const rows = JSON.parse(res.stdout) as Array<{ runId: string; live: boolean; effectiveStatus: string }>;
    assert.ok(Array.isArray(rows), `expected a JSON array, got: ${res.stdout.slice(0, 200)}`);
    assert.equal(rows.length, 3);
    assert.deepEqual(rows.map((r) => r.runId), ['run-intr-1', 'run-live-1', 'run-done-1']);
    assert.equal(rows[0].live, false);
    assert.equal(rows[0].effectiveStatus, 'interrupted');
    assert.equal(rows[1].live, true);
    assert.equal(rows[1].effectiveStatus, 'running');
    assert.equal(rows[2].live, false);
    assert.equal(rows[2].effectiveStatus, 'success');
  });

  it('prints [] and exits 0 for an empty state dir', { timeout: 20_000 }, () => {
    const state = mkState();
    const res = runCli(dashArgs(state, ['--json']), state);
    assert.equal(res.code, 0, `exit ${res.code}; stderr: ${res.stderr}`);
    assert.deepEqual(JSON.parse(res.stdout), []);
  });

  it('non-TTY without --json falls back to the same JSON dump (exit 0)', { timeout: 20_000 }, () => {
    const state = mkState();
    const now = Date.now();
    seedRuns(state, [
      runRec({ runId: 'run-live-2', status: 'running', startedAt: now - 1_000, updatedAt: now }),
      runRec({
        runId: 'run-done-2',
        status: 'aborted',
        pid: 4194303,
        startedAt: now - 7_200_000,
        updatedAt: now - 7_200_000,
      }),
    ]);
    const res = runCli(dashArgs(state), state); // no --json; pipes make it non-TTY
    assert.equal(res.code, 0, `exit ${res.code}; stderr: ${res.stderr}`);
    const rows = JSON.parse(res.stdout) as unknown[];
    assert.ok(Array.isArray(rows), `expected a JSON array, got: ${res.stdout.slice(0, 200)}`);
    assert.equal(rows.length, 2);
  });
});

// ---------------------------------------------------------------------------
// Truthful-usage columns in the ANSI table (pure render, no subprocess).
// A RunRecord that claims `usage.tokens.available === false` must print `n/a`
// for the token/cost cells — never `0` / `$0.0000` — and a record WITHOUT a
// `usage` block (everything written before this landed) must render exactly as
// it always did.
// ---------------------------------------------------------------------------

function tableLine(rec: Record<string, unknown>): string {
  const lines = frame([rec as unknown as RunRecord], '/tmp/state', true, 200, false).split('\n');
  const row = lines.find((l) => l.includes(String(rec.runId)));
  assert.ok(row, `no row for ${String(rec.runId)}; frame was:\n${lines.join('\n')}`);
  return row;
}

const CREDITS_ONLY_USAGE = {
  tokens: { available: false },
  credits: { available: true, source: 'reconciled', value: 0.0247448, scope: 'run', cumulative: true },
  usd: { available: false },
  context: { available: true, source: 'derived', percentage: 5.0080004, windowTokens: 200000, windowSource: 'session-store', tokens: 10016 },
};

describe('dash table — truthful usage columns', () => {
  it('prints n/a for tokens and cost on a credits-only run, plus the derived ctx cell', () => {
    const row = tableLine(
      runRec({
        runId: 'kiro-cr',
        agent: 'kiro',
        status: 'success',
        totals: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, credits: 0.0247448, contextTokens: 10016 },
        usage: CREDITS_ONLY_USAGE,
      }),
    );
    assert.equal((row.match(/n\/a/g) ?? []).length, 4, row); // in, out, cache, cost
    assert.ok(!row.includes('$0.0000'), row);
    assert.ok(row.includes('0.02cr'), row); // credits still real
    assert.ok(row.includes('10.0k (5.0%)'), row); // derived context
  });

  it('renders a record WITHOUT a usage block exactly as before', () => {
    const row = tableLine(runRec({ runId: 'legacy-1', status: 'success' }));
    assert.ok(!row.includes('n/a'), row);
    assert.ok(row.includes('$0.0100'), row);
    assert.ok(row.includes('10') && row.includes('20'), row);
  });

  it('keeps an unavailable run out of the footer totals', () => {
    const now = Date.now();
    const rendered = frame(
      [
        runRec({ runId: 'kiro-cr', status: 'success', updatedAt: now, totals: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 999, credits: 1 }, usage: CREDITS_ONLY_USAGE }) as unknown as RunRecord,
        runRec({ runId: 'normal-1', status: 'success', updatedAt: now }) as unknown as RunRecord,
      ],
      '/tmp/state',
      true,
      200,
      false,
    );
    const footerLine = rendered.split('\n').at(-1) ?? '';
    assert.ok(footerLine.includes('in 10'), footerLine);
    assert.ok(footerLine.includes('cost $0.0100'), footerLine); // 999 excluded
  });
});
