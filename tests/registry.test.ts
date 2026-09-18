import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import {
  effectiveStatus,
  isLive,
  listRunRecords,
  readRunRecord,
  registryDir,
  resolveRawTranscript,
  writeRunRecord,
  type RunRecord,
} from '../src/core/registry.js';

let stateDir = '';

function mkState(): string {
  stateDir = mkdtempSync(join(tmpdir(), 'harness-registry-'));
  return stateDir;
}

function rec(over: Partial<RunRecord> = {}): RunRecord {
  return {
    runId: `run-${Math.random().toString(36).slice(2, 10)}`,
    agent: 'claude',
    pid: process.pid,
    cwd: '/tmp/proj',
    promptPreview: 'p'.repeat(120),
    startedAt: 1_000,
    updatedAt: 1_000,
    status: 'running',
    totals: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4, costUsd: 0.5 },
    rawTranscript: '/tmp/proj/raw/claude-s1.jsonl',
    ...over,
  };
}

afterEach(() => {
  if (stateDir) {
    rmSync(stateDir, { recursive: true, force: true });
    stateDir = '';
  }
});

describe('run registry', () => {
  it('writeRunRecord → readRunRecord preserves every field including optional credits/lastEvent', () => {
    const dir = mkState();
    const full = rec({
      sessionId: 'sess-abc',
      exitStatus: 'success',
      lastEvent: 'assistant: done',
      status: 'success',
      totals: { inputTokens: 11, outputTokens: 22, cacheReadTokens: 33, cacheWriteTokens: 44, costUsd: 0.75, credits: 1.25 },
    });
    writeRunRecord(dir, full);
    assert.ok(
      existsSync(join(registryDir(dir), `${full.runId}.json`)),
      'record must land at <stateDir>/runs/<runId>.json',
    );
    // Parse fills the 0.9.0 `source` default on records written without one.
    assert.deepEqual(readRunRecord(dir, full.runId), { ...full, source: 'local' });
  });

  it('writeRunRecord is atomic: no .tmp-* residue remains after the call returns', () => {
    const dir = mkState();
    writeRunRecord(dir, rec());
    const residue = readdirSync(registryDir(dir)).filter((f) => f.includes('.tmp-'));
    assert.deepEqual(residue, []);
  });

  it('listRunRecords skips a corrupt file instead of throwing', () => {
    const dir = mkState();
    const a = rec({ startedAt: 2_000 });
    const b = rec({ startedAt: 1_000 });
    writeRunRecord(dir, a);
    writeRunRecord(dir, b);
    writeFileSync(join(registryDir(dir), 'bad.json'), 'not json{');
    assert.deepEqual(listRunRecords(dir).map((r) => r.runId), [a.runId, b.runId]);
  });

  it('listRunRecords sorts by startedAt descending', () => {
    const dir = mkState();
    const oldest = rec({ startedAt: 1_000 });
    const newest = rec({ startedAt: 3_000 });
    const middle = rec({ startedAt: 2_000 });
    for (const r of [oldest, newest, middle]) writeRunRecord(dir, r);
    assert.deepEqual(listRunRecords(dir).map((r) => r.runId), [newest.runId, middle.runId, oldest.runId]);
  });

  it('listRunRecords returns [] for an empty state dir (with or without a runs dir)', () => {
    const dir = mkState();
    assert.deepEqual(listRunRecords(dir), []);
    mkdirSync(registryDir(dir), { recursive: true });
    assert.deepEqual(listRunRecords(dir), []);
  });

  it('readRunRecord returns null for a missing run', () => {
    const dir = mkState();
    assert.equal(readRunRecord(dir, 'nope'), null);
  });
});

describe('isLive', () => {
  it('true: running + fresh heartbeat + a live pid', () => {
    const r = rec({ status: 'running', updatedAt: Date.now(), pid: process.pid });
    assert.equal(isLive(r), true);
  });

  it('false: heartbeat 60s old (> 15s freshness window)', () => {
    const r = rec({ status: 'running', updatedAt: Date.now() - 60_000, pid: process.pid });
    assert.equal(isLive(r), false);
  });

  it('false: status is not running', () => {
    const r = rec({ status: 'success', updatedAt: Date.now(), pid: process.pid });
    assert.equal(isLive(r), false);
  });

  it('false: dead pid (2^22-ish, outside the macOS pid space)', () => {
    const r = rec({ status: 'running', updatedAt: Date.now(), pid: 4194303 });
    assert.equal(isLive(r), false);
  });
});

describe('effectiveStatus', () => {
  it('running + own pid + fresh heartbeat → running', () => {
    const r = rec({ status: 'running', updatedAt: Date.now(), pid: process.pid });
    assert.equal(effectiveStatus(r), 'running');
  });

  it('running + dead pid (4194303) → interrupted', () => {
    const r = rec({ status: 'running', updatedAt: Date.now(), pid: 4194303 });
    assert.equal(effectiveStatus(r), 'interrupted');
  });

  it('running + stale heartbeat (> 15s) → interrupted despite live pid', () => {
    const r = rec({ status: 'running', updatedAt: Date.now() - 60_000, pid: process.pid });
    assert.equal(effectiveStatus(r), 'interrupted');
  });

  it('terminal statuses pass through unchanged (success/error/aborted)', () => {
    for (const status of ['success', 'error', 'aborted'] as const) {
      const r = rec({ status, updatedAt: Date.now() - 60_000, pid: 4194303 });
      assert.equal(effectiveStatus(r), status);
    }
  });
});

// --------------------------------------------------- stale rawTranscript
// Commit 77cf64e renamed the state dir (~/.agent-harness →
// ~/.agentic-coding-harness); pre-rename records still carry the OLD absolute
// path. resolveRawTranscript relocates by basename under the CURRENT stateDir.

describe('resolveRawTranscript', () => {
  it('returns the stored path unchanged when that file exists', () => {
    const dir = mkState();
    const raw = join(dir, 'elsewhere', 'claude-s1.jsonl');
    mkdirSync(join(dir, 'elsewhere'), { recursive: true });
    writeFileSync(raw, '{}\n');
    assert.equal(resolveRawTranscript(dir, rec({ rawTranscript: raw })), raw);
  });

  it('relocates to <stateDir>/raw/<basename> when the stored absolute path is gone', () => {
    const dir = mkState();
    mkdirSync(join(dir, 'raw'), { recursive: true });
    const relocated = join(dir, 'raw', 'claude-s1.jsonl');
    writeFileSync(relocated, '{}\n');
    // Default fixture path is '/tmp/proj/raw/claude-s1.jsonl' — same basename.
    const stale = '/Users/nobody/.agent-harness/raw/claude-s1.jsonl';
    assert.equal(existsSync(stale), false, 'precondition: stale path must not exist');
    assert.equal(resolveRawTranscript(dir, rec({ rawTranscript: stale })), relocated);
  });

  it('returns the original string when neither the stored path nor the basename exists', () => {
    const dir = mkState();
    const stale = '/Users/nobody/.agent-harness/raw/claude-never.jsonl';
    assert.equal(resolveRawTranscript(dir, rec({ rawTranscript: stale })), stale);
  });
});
