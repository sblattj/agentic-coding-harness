import assert from 'node:assert/strict';
import fs, { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { writeRunRecord, type RunRecord } from '../src/core/registry.ts';
import { createRunEventHub } from '../src/web/hub.ts';
import { FsRunSource } from '../src/web/run-source.ts';

// ---------------------------------------------------------------------------
// RunSource seam (spec §5.3): FsRunSource owns the state-dir behavior the
// hub used to carry inline — snapshot via listRunRecords + debounced
// fs.watch. The hub delegates to it; public surface is unchanged.
// ---------------------------------------------------------------------------

const T0 = 1_700_000_000_000;

const stateDirs: string[] = [];
afterEach(() => { for (const dir of stateDirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function mkState(): string {
  const dir = mkdtempSync(join(tmpdir(), 'harness-run-source-'));
  stateDirs.push(dir);
  return dir;
}

function silenceNativeWatchers(): () => void {
  const originalWatch = fs.watch;
  fs.watch = ((...args: Parameters<typeof fs.watch>) => {
    const watcher = originalWatch(...args);
    watcher.close();
    return watcher;
  }) as typeof fs.watch;
  return () => { fs.watch = originalWatch; };
}

async function changedSnapshot(src: FsRunSource, write: () => void): Promise<RunRecord[]> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const delivered = new Promise<RunRecord[]>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('no changed snapshot within 1500ms')), 1500);
      void src.start(resolve);
    });
    write();
    return await delivered;
  } finally {
    clearTimeout(timer);
    await src.stop();
  }
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
    // Records written without `source` parse back with the 0.9.0 default.
    assert.deepEqual(src.snapshot(), [{ ...newer, source: 'local' }, { ...older, source: 'local' }]);
  });

  it('start(onChange) delivers the full snapshot after a write (debounced)', async () => {
    const dir = mkState();
    writeRunRecord(dir, rec({ runId: 'run-a' }));
    const src = new FsRunSource(dir);
    const got = await changedSnapshot(src, () => {
      writeRunRecord(dir, rec({ runId: 'run-b', startedAt: T0 + 1000 }));
    });
    assert.equal(got.length, 2);
    assert.deepEqual(got.map((r) => r.runId).sort(), ['run-a', 'run-b']);
  });
  it('reconciles creates and replacements when the native watcher delivers no notifications', async () => {
    for (const replace of [false, true]) {
      const dir = mkState();
      writeRunRecord(dir, rec({ runId: 'run-a' }));
      const src = new FsRunSource(dir);
      // Only native notification delivery varies; reads and timers stay real.
      const restoreWatch = silenceNativeWatchers();
      try {
        const got = await changedSnapshot(src, () => {
          restoreWatch();
          writeRunRecord(dir, rec({ runId: replace ? 'run-a' : 'run-b', startedAt: T0 + 1000 }));
        });
        assert.deepEqual(got.map((r) => r.runId).sort(), replace ? ['run-a'] : ['run-a', 'run-b']);
        assert.equal(got[0]!.startedAt, T0 + 1000);
      } finally {
        restoreWatch();
        await src.stop();
      }
    }
  });

  it('unchanged reconciliation does not reread the registry or emit duplicates', async () => {
    const dir = mkState();
    writeRunRecord(dir, rec());
    const src = new FsRunSource(dir);
    let calls = 0, reads = 0;
    const snapshot = src.snapshot.bind(src);
    src.snapshot = () => { reads++; return snapshot(); };
    const restoreWatch = silenceNativeWatchers();
    try {
      await src.start(() => calls++);
      restoreWatch();
      await sleep(1100);
      assert.equal(calls, 0);
      assert.equal(reads, 1, "only the startup snapshot reads registry contents");
    } finally { restoreWatch(); await src.stop(); }
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
    assert.deepEqual(hub.snapshotRuns(), [{ ...expected, source: 'local' }]);
  });
});
