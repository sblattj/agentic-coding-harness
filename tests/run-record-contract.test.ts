import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { ExternalRunFeedSchema } from '../src/core/external-source.js';
import { isLive, listRunIds, readRunRecord, RunRecordSchema, writeRunRecord, type RunRecord } from '../src/core/registry.js';

let stateDir = '';

function mkState(): string {
  stateDir = mkdtempSync(join(tmpdir(), 'harness-run-record-'));
  return stateDir;
}

afterEach(() => {
  if (stateDir) {
    rmSync(stateDir, { recursive: true, force: true });
    stateDir = '';
  }
});

/** A full 0.8.0-era local record — the CURRENT field set minus the 0.9.0 additions. */
function legacyRecord(): RunRecord {
  return {
    runId: `run-${Math.random().toString(36).slice(2, 10)}`,
    agent: 'claude',
    pid: process.pid,
    cwd: '/tmp/proj',
    promptPreview: 'p'.repeat(120),
    startedAt: 1_000,
    updatedAt: 1_000,
    status: 'success',
    totals: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4, costUsd: 0.5 },
    rawTranscript: '/tmp/proj/raw/claude-s1.jsonl',
  };
}

function externalRecord(): RunRecord {
  return {
    runId: `run-${Math.random().toString(36).slice(2, 10)}`,
    agent: 'acme_cloud_harness',
    startedAt: 1_760_000_000_000,
    endedAt: 1_760_000_120_000,
    experiment: 'acme-final-proof',
    variant: 'acme-harness',
    workflow: 'implement',
    source: 'external',
    producer: 'acme-feed/bridge@1',
    metadata: { request_id: 'x', region: 'us-west-2' },
  };
}

describe('run-record contract (0.9.0)', () => {
  it('a full 0.8.0-era record parses unchanged with source defaulting to "local"', () => {
    const parsed = RunRecordSchema.safeParse(legacyRecord());
    assert.ok(parsed.success, `legacy record must parse: ${parsed.success ? '' : JSON.stringify(parsed.error.issues)}`);
    assert.equal(parsed.data.source, 'local');
  });

  it('a fully-tagged external record parses and round-trips through the registry', () => {
    const parsed = RunRecordSchema.safeParse(externalRecord());
    assert.ok(parsed.success, `external record must parse: ${parsed.success ? '' : JSON.stringify(parsed.error.issues)}`);
    const rec = parsed.data;
    const dir = mkState();
    writeRunRecord(dir, rec);
    assert.deepEqual(readRunRecord(dir, rec.runId), rec);
  });

  it('isLive() is false for an external record even when status is running and the heartbeat is fresh', () => {
    const rec = { ...externalRecord(), status: 'running' as const, updatedAt: Date.now() };
    assert.equal(isLive(rec), false);
  });

  it('ExternalRunFeedSchema accepts a mixed local+external feed and rejects a malformed entry', () => {
    const ext = RunRecordSchema.parse(externalRecord());
    const legacy = RunRecordSchema.parse(legacyRecord());
    const feed = ExternalRunFeedSchema.parse({ records: [ext, legacy] });
    assert.deepEqual(feed.records.map((r) => r.runId), [ext.runId, legacy.runId]);
    assert.equal(feed.records[0]?.source, 'external');
    assert.equal(feed.records[1]?.source, 'local');

    const malformed = ExternalRunFeedSchema.safeParse({ records: [ext, { runId: 1 }] });
    assert.equal(malformed.success, false, 'a feed entry failing RunRecordSchema must fail the feed schema');
  });

  it('listRunIds returns the runIds written to the state dir', () => {
    const dir = mkState();
    const rec = RunRecordSchema.parse(externalRecord());
    writeRunRecord(dir, rec);
    assert.deepEqual(listRunIds(dir), [rec.runId]);
  });
});
