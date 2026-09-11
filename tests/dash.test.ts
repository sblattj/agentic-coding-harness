import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';

// ---------------------------------------------------------------------------
// agh dash (integration, real subprocess)
//
// Spawns the CLI entrypoint (src/cli/harness.ts, wired by another seat) with
// pipes for stdio — i.e. non-TTY, where the documented fallback dumps the
// current RunRecord[] as JSON and exits (the --json flag forces the same).
// State is sandboxed via AGENT_HARNESS_STATE_DIR (src/core/store.ts
// stateDir()) so nothing touches the real ~/.agent-harness. Expected to fail
// until the dash subcommand lands.
// ---------------------------------------------------------------------------

const CLI = new URL('../src/cli/harness.ts', import.meta.url).pathname;

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
    env: { ...process.env, AGENT_HARNESS_STATE_DIR: stateDir },
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

describe('agh dash --json (real subprocess, non-TTY)', () => {
  it('reports live and finished runs, sorted by startedAt desc, with correct live flags', { timeout: 20_000 }, () => {
    const state = mkState();
    const now = Date.now();
    const live = runRec({ runId: 'run-live-1', status: 'running', startedAt: now - 5_000, updatedAt: now });
    const done = runRec({
      runId: 'run-done-1',
      status: 'success',
      exitStatus: 'success',
      pid: 4194303, // dead: no false live flag
      startedAt: now - 3_600_000,
      updatedAt: now - 3_600_000,
    });
    seedRuns(state, [done, live]); // seeded out of order; dash must sort
    const res = runCli(dashArgs(state, ['--json']), state);
    assert.equal(res.code, 0, `exit ${res.code}; stderr: ${res.stderr}`);
    const rows = JSON.parse(res.stdout) as Array<{ runId: string; live: boolean }>;
    assert.ok(Array.isArray(rows), `expected a JSON array, got: ${res.stdout.slice(0, 200)}`);
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map((r) => r.runId), ['run-live-1', 'run-done-1']);
    assert.equal(rows[0].live, true);
    assert.equal(rows[1].live, false);
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
