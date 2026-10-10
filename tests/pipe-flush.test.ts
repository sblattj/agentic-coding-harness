import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

// ---------------------------------------------------------------------------
// #128: stdout truncated when piped.
//
// Under Bun (source and `bun build --compile` binaries) the CLI wrote a large
// payload to a pipe and then called process.exit before the pipe drained, so
// the reader saw only the first 64 KiB / 128 KiB. This spawns the real CLI
// from source under bun with stdout as a pipe and asserts the full multi-MiB
// `dash --json --all` payload arrives and parses.
// ---------------------------------------------------------------------------

const CLI = new URL('../src/cli/ach.ts', import.meta.url).pathname;
const hasBun = spawnSync('bun', ['--version'], { encoding: 'utf8' }).status === 0;

const RECORDS = 1500;
const state = mkdtempSync(join(tmpdir(), 'harness-pipe-flush-'));
after(() => rmSync(state, { recursive: true, force: true }));

function seed(): void {
  mkdirSync(join(state, 'runs'), { recursive: true });
  const pad = 'x'.repeat(600);
  for (let i = 0; i < RECORDS; i++) {
    const runId = `run-${String(i).padStart(5, '0')}`;
    writeFileSync(join(state, 'runs', `${runId}.json`), JSON.stringify({
      runId,
      agent: 'claude',
      pid: 999_999_9,
      cwd: tmpdir(),
      promptPreview: `synthetic prompt ${i} ${pad}`,
      startedAt: 1_700_000_000_000 + i,
      updatedAt: 1_700_000_000_000 + i,
      endedAt: 1_700_000_000_000 + i,
      status: 'success',
      totals: { inputTokens: 10, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.01 },
      rawTranscript: join(tmpdir(), 'raw.jsonl'),
    }));
  }
}

function runPiped(args: string[]): Promise<{ code: number | null; stdout: Buffer; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('bun', [CLI, ...args], {
      env: { ...process.env, HOME: state, AGENTIC_CODING_HARNESS_STATE_DIR: state, NO_COLOR: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const out: Buffer[] = [];
    let err = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 60_000);
    child.stdout.on('data', (b: Buffer) => out.push(b));
    child.stderr.on('data', (b: Buffer) => { err += b.toString(); });
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout: Buffer.concat(out), stderr: err });
    });
  });
}

describe('#128 piped stdout is not truncated', { skip: hasBun ? false : 'bun not installed' }, () => {
  it('dash --json --all delivers the full >1 MiB payload through a pipe', { timeout: 90_000 }, async () => {
    seed();
    const r = await runPiped(['dash', '--json', '--all', '--state-only', '--state-dir', state]);
    assert.equal(r.code, 0, r.stderr);
    assert.ok(r.stdout.length > 1024 * 1024, `expected > 1 MiB of output, got ${r.stdout.length} bytes`);
    const parsed = JSON.parse(r.stdout.toString('utf8')) as unknown[];
    assert.equal(parsed.length, RECORDS);
  });
});
