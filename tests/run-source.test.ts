import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { writeRunRecord, type RunRecord } from '../src/core/registry.ts';
import { createRunEventHub } from '../src/web/hub.ts';
import { FsRunSource } from '../src/web/run-source.ts';

// ---------------------------------------------------------------------------
// RunSource seam (spec §5.3): FsRunSource owns the state-dir behavior the
// hub used to carry inline — snapshot via listRunRecords + debounced
// fs.watch. The hub delegates to it; public surface is unchanged.
// ---------------------------------------------------------------------------

const T0 = 1_700_000_000_000;

function mkState(): string {
  return mkdtempSync(join(tmpdir(), 'harness-run-source-'));
}

function rec(over: Partial<RunRecord> = {}): RunRecord {
  return {
    runId: 'run-src-1',
    agent: 'claude',
    pid: process.pid,
    cwd: '/tmp/proj',
    promptPreview: 'list the files',
    startedAt: T0,
    updatedAt: T0,
    status: 'success',
    exitStatus: 'success',
    totals: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4, costUsd: 0.5 },
    rawTranscript: '/nonexistent/transcript.jsonl',
    ...over,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('FsRunSource', () => {
  it('snapshot() of an empty state dir is []', () => {
    const src = new FsRunSource(mkState());
    assert.deepEqual(src.snapshot(), []);
  });

  it('snapshot() returns a written record (newest first)', () => {
    const dir = mkState();
    const older = rec({ runId: 'run-a', startedAt: T0 });
    const newer = rec({ runId: 'run-b', startedAt: T0 + 1000 });
    writeRunRecord(dir, older);
    writeRunRecord(dir, newer);
    const src = new FsRunSource(dir);
    assert.deepEqual(src.snapshot(), [newer, older]);
  });

  it('start(onChange) delivers the full snapshot after a write (debounced)', async () => {
    const dir = mkState();
    writeRunRecord(dir, rec({ runId: 'run-a' }));
    const src = new FsRunSource(dir);
    const calls: RunRecord[][] = [];
    await src.start((records) => calls.push(records));
    writeRunRecord(dir, rec({ runId: 'run-b', startedAt: T0 + 1000 }));
    const delivered = new Promise<RunRecord[]>((resolve) => {
      const t = setTimeout(() => resolve([]), 1500);
      const poll = setInterval(() => {
        if (calls.length > 0) {
          clearTimeout(t);
          clearInterval(poll);
          resolve(calls[0]);
        }
      }, 25);
    });
    const got = await delivered;
    assert.equal(got.length, 2);
    assert.deepEqual(got.map((r) => r.runId).sort(), ['run-a', 'run-b']);
    await src.stop();
  });

  it('stop() silences further writes', async () => {
    const dir = mkState();
    writeRunRecord(dir, rec({ runId: 'run-a' }));
    const src = new FsRunSource(dir);
    let calls = 0;
    await src.start(() => calls++);
    await src.stop();
    await src.stop(); // idempotent
    writeRunRecord(dir, rec({ runId: 'run-b', startedAt: T0 + 1000 }));
    await sleep(800);
    assert.equal(calls, 0);
  });

  it('health() reports healthy', () => {
    assert.deepEqual(new FsRunSource(mkState()).health(), { healthy: true });
  });
});

describe('RunSource seam behind the hub', () => {
  it('watchRegistry() returns a disposer; hub.snapshotRuns() mirrors the source', async () => {
    const dir = mkState();
    const expected = rec({ runId: 'run-a' });
    writeRunRecord(dir, expected);
    const src = new FsRunSource(dir);
    const hub = createRunEventHub(dir);
    const disposer = hub.watchRegistry();
    assert.equal(typeof disposer, 'function');
    assert.deepEqual(hub.snapshotRuns(), src.snapshot());
    disposer();
    assert.deepEqual(hub.snapshotRuns(), [expected]);
  });
});
