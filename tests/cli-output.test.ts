import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const cli = new URL('../src/cli/ach.ts', import.meta.url).pathname;
const isBun = Boolean((process.versions as { bun?: string }).bun);
function run(args: string[], env: NodeJS.ProcessEnv = process.env) {
  return spawnSync(process.execPath, isBun ? [cli, ...args] : ['--import', 'tsx', cli, ...args], {
    encoding: 'utf8', env, timeout: 15000, maxBuffer: 8 * 1024 * 1024,
  });
}

test('CLI drains complete help on stdout and stderr before forced exit', () => {
  const help = run(['--help']);
  assert.equal(help.status, 0, help.stderr);
  assert.ok(Buffer.byteLength(help.stdout) > 8192, 'fixture exceeds a macOS pipe buffer');
  assert.match(help.stdout, /scripted turn count \(default 1\)\n$/);
  const invalid = run(['no-such-command']);
  assert.equal(invalid.status, 1);
  assert.equal(invalid.stdout, '');
  assert.equal(invalid.stderr, help.stdout + "harness: unknown subcommand 'no-such-command'\n");
  const version = run(['--version']);
  assert.equal(version.status, 0);
  assert.match(version.stdout, /^\d+\.\d+\.\d+\n$/);
});

test('CLI drains a large stats JSON document through its actual executable entrypoint', () => {
  const home = mkdtempSync(join(tmpdir(), 'ach-output-'));
  try {
    mkdirSync(join(home, 'raw'));
    const rows = Array.from({ length: 120 }, (_, i) => ({
      ts: new Date(Date.UTC(2026, 0, 1) + i * 86400000).toISOString(), agent: 'claude',
      sessionId: `session-${i}`, model: 'claude-sonnet-4-5', inputTokens: 1, outputTokens: 1, costUsd: 0.01,
    }));
    writeFileSync(join(home, 'raw', 'claude-output.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n'));
    const result = run(['stats', '--json', '--state-only', '--tz', 'UTC'], {
      ...process.env, HOME: home, AGENTIC_CODING_HARNESS_STATE_DIR: home,
      AGENTIC_CODING_HARNESS_COST_MODE: 'auto',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(Buffer.byteLength(result.stdout) > 65536, 'JSON exceeds typical pipe buffers');
    const doc = JSON.parse(result.stdout);
    assert.equal(doc.total.records, rows.length);
    assert.equal(Object.keys(doc.byDay).length, rows.length);
    assert.equal(doc.byDay['2026-04-30'].records, 1);
    assert.ok(result.stdout.endsWith('\n'));
  } finally { rmSync(home, { recursive: true, force: true }); }
});
