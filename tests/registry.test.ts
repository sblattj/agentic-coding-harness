import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import {
  isLive,
  listRunRecords,
  readRunRecord,
  registryDir,
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
    assert.deepEqual(readRunRecord(dir, full.runId), full);
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
