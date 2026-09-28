// Issue #14: the Claude CLI (observed 2.1.277, stream-json --verbose) can emit
// its final `result` line twice in one run, byte-identical. A result line is a
// cumulative-final record for the session, so the duplicate must count once:
// otherwise totalCost doubles and a finished run exits budget_exceeded.
// Distinct result lines (a different payload for the same or another session)
// still count, each one.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, it } from 'node:test';
import {
  ClaudeCodeAdapter,
  type HarnessChildProcess,
  type SpawnFn,
} from '../src/adapters/claude.ts';
import { createDriver } from '../src/core/driver.ts';
import type { RunResult } from '../src/core/types.ts';

const DUP_FIXTURE = readFileSync(
  new URL('./fixtures/claude/duplicate-result.ndjson', import.meta.url),
  'utf8',
);
const DUP_LINES = DUP_FIXTURE.trim().split('\n');

class FakeChild extends EventEmitter implements HarnessChildProcess {
  stdout: PassThrough = new PassThrough();
  stderr: PassThrough = new PassThrough();
  pid = 424243;
  killed = false;
  kill(signal?: string): boolean {
    this.killed = true;
    if (signal === 'SIGTERM') queueMicrotask(() => this.emit('close', 143, null));
    return true;
  }
}

/**
 * A driver over a real ClaudeCodeAdapter whose spawned child replays `lines`
 * on stdout and exits 0 — no real CLI, no network.
 */
async function runWithLines(lines: string[], budgetUsd?: number, exitCode = 0): Promise<RunResult> {
  const stateDir = mkdtempSync(path.join(tmpdir(), 'ach-claude-dup-'));
  try {
    const spawnFn: SpawnFn = () => {
      const child = new FakeChild();
      setImmediate(() => {
        child.stdout.write(lines.join('\n') + '\n');
        child.stdout.end();
        child.stderr.end();
        setImmediate(() => child.emit('close', exitCode, null));
      });
      return child;
    };
    const adapter = new ClaudeCodeAdapter({ stateDir, spawnFn });
    const driver = createDriver({ adapters: { claude: adapter }, stateDir });
    return await driver.run('claude', {
      prompt: 'x',
      ...(budgetUsd !== undefined ? { budget: { usd: budgetUsd, onExceed: 'abort' as const } } : {}),
    });
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
}

function approx(actual: number, expected: number): void {
  assert.ok(Math.abs(actual - expected) < 1e-9, `expected ${expected}, got ${actual}`);
}

describe('claude adapter: duplicate result line (#14)', () => {
  it('fixture really carries the same result line twice', () => {
    assert.equal(DUP_LINES.length, 4);
    assert.equal(DUP_LINES[2], DUP_LINES[3]);
    assert.equal(JSON.parse(DUP_LINES[2]!).type, 'result');
  });

  it('a byte-identical repeated result counts once: totalCost is 1x, one tokens row, no budget_exceeded', async () => {
    // Control: the same stream with the result line once.
    const single = await runWithLines(DUP_LINES.slice(0, 3));
    assert.equal(single.tokens.length, 1);
    assert.ok(single.totalCost > 0, 'control run must carry a priced cost');
    // Budget above 1x the run's cost, below 2x: only a doubled sum trips it.
    const result = await runWithLines(DUP_LINES, single.totalCost * 1.5);
    assert.equal(result.exitStatus, 'success');
    approx(result.totalCost, single.totalCost);
    assert.equal(result.tokens.length, 1);
    assert.equal(result.events.filter((e) => e.type === 'usage').length, 1);
  });

  it('final accounting above the cap preserves completion even with explicit abort', async () => {
    const control = await runWithLines(DUP_LINES.slice(0, 3));
    const result = await runWithLines(DUP_LINES, control.totalCost / 2);
    assert.equal(result.exitStatus, 'success');
    approx(result.totalCost, control.totalCost);
    assert.equal(result.tokens.length, 1);
    assert.equal(result.events.find((e) => e.type === 'usage')?.finalAccounting, true);
    assert.ok(result.warnings.some((w) => /exceeded .*by final accounting/.test(w)));
    assert.ok(!control.warnings.some((w) => /by final accounting/.test(w)));
  });

  it('final-accounting exemption does not hide a failing Claude process', async () => {
    const result = await runWithLines(DUP_LINES, 0.000001, 1);
    assert.equal(result.exitStatus, 'error');
    assert.ok(result.warnings.some((w) => /by final accounting/.test(w)));
  });

  it('a deep-equal repeat with a different key order also counts once', async () => {
    const obj = JSON.parse(DUP_LINES[2]!) as Record<string, unknown>;
    const reordered = JSON.stringify(Object.fromEntries(Object.entries(obj).reverse()));
    assert.notEqual(reordered, DUP_LINES[2]);
    const single = await runWithLines(DUP_LINES.slice(0, 3));
    const result = await runWithLines([DUP_LINES[0]!, DUP_LINES[1]!, DUP_LINES[2]!, reordered]);
    assert.equal(result.tokens.length, 1);
    approx(result.totalCost, single.totalCost);
  });

  it('two DISTINCT result lines both count (e.g. a resumed session emitting a new final record)', async () => {
    const first = JSON.parse(DUP_LINES[2]!) as Record<string, unknown>;
    const second = {
      ...first,
      num_turns: 5,
      total_cost_usd: 0.05,
      modelUsage: {
        'claude-sonnet-4-5-20250929': {
          inputTokens: 3,
          cacheCreationInputTokens: 100,
          cacheReadInputTokens: 15000,
          outputTokens: 200,
          costUSD: 0.05,
        },
      },
    };
    const onlyFirst = await runWithLines([JSON.stringify(first)]);
    const onlySecond = await runWithLines([JSON.stringify(second)]);
    assert.notEqual(onlyFirst.totalCost, onlySecond.totalCost);
    const result = await runWithLines([
      DUP_LINES[0]!,
      DUP_LINES[1]!,
      JSON.stringify(first),
      JSON.stringify(second),
    ]);
    assert.equal(result.tokens.length, 2);
    approx(result.totalCost, onlyFirst.totalCost + onlySecond.totalCost);
    assert.equal(result.exitStatus, 'success');
  });

  it('the same payload under a different session_id is distinct and counts', async () => {
    const first = JSON.parse(DUP_LINES[2]!) as Record<string, unknown>;
    const other = { ...first, session_id: '8f4c2a6e-1111-4e2a-9b3c-000000000002' };
    const single = await runWithLines([DUP_LINES[2]!]);
    const result = await runWithLines([DUP_LINES[2]!, JSON.stringify(other)]);
    assert.equal(result.tokens.length, 2);
    approx(result.totalCost, single.totalCost * 2);
  });
});
