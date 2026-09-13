import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { readAllRecords } from '../src/core/store.js';

// Regression tests for driver-transcript routing in readAllRecords: the
// fixtures mirror the REAL on-disk shape written by src/core/driver.ts to
// <stateDir>/raw/<agent>-<sessionId>.jsonl (top-level keys: agent, data,
// timestamp, type, usage; the `data` blobs are trimmed but key-compatible).

describe('store readAllRecords driver transcripts', () => {
  let stateDir: string;

  before(() => {
    stateDir = mkdtempSync(join(tmpdir(), 'harness-store-'));
    process.env.AGENTIC_CODING_HARNESS_STATE_DIR = stateDir;
    mkdirSync(join(stateDir, 'raw'), { recursive: true });

    // Real-shape claude usage event (observed under ~/.agentic-coding-harness/raw/):
    // no top-level sessionId, canonical field names nested in `usage`.
    const claudeUsage = {
      type: 'usage',
      agent: 'claude',
      usage: {
        agent: 'claude',
        model: 'claude-haiku-4-5-20251001',
        inputTokens: 954,
        outputTokens: 1612,
        cacheReadTokens: 16104,
        cacheWriteTokens: 17662,
        reasoningTokens: 0,
        costUsd: 0.1594895,
        extra: { totalTokens: null, durationMs: null, raw: { input: 954, output: 1612 } },
      },
      // data is the raw provider payload (unused by the usage branch).
      data: { input: 954, output: 1612 },
      timestamp: 1789075428928,
    };
    // Same shape with the driver-attached sessionId to prove propagation.
    const claudeUsageWithSession = { ...claudeUsage, sessionId: 'sess-driver-1' };
    writeFileSync(
      join(stateDir, 'raw', 'claude-0adb92fc-fa36-481b-adfd-db6542fd42f3.jsonl'),
      [JSON.stringify(claudeUsage), JSON.stringify(claudeUsageWithSession), ''].join('\n'),
    );

    // Real-shape kiro meteringEvent: usage.extra.credits is a NUMBER (the
    // credit balance consumed by the turn).
    const kiroUsage = {
      type: 'usage',
      agent: 'kiro',
      usage: {
        agent: 'kiro',
        inputTokens: 12,
        outputTokens: 34,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        extra: {
          event: 'meteringEvent',
          totalTokens: 46,
          credits: 0.21785552902155886,
          raw: { event: 'meteringEvent' },
        },
      },
      data: { event: 'meteringEvent' },
      timestamp: 1789078520436,
    };
    writeFileSync(join(stateDir, 'raw', 'kiro-kiro-681658de.jsonl'), JSON.stringify(kiroUsage) + '\n');

    // Pre-existing shapes must keep parsing.
    const usageRaw = {
      type: 'usage_raw',
      agent: 'codex',
      data: { input_tokens: 100, cached_input_tokens: 20, output_tokens: 30 },
      sessionId: 'sess-raw-1',
      timestamp: 1789075428929,
    };
    const canonical = {
      ts: new Date(1789075428928).toISOString(),
      agent: 'claude',
      sessionId: 'sess-canonical',
      model: 'claude-sonnet-4-5',
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 10,
      cacheWriteTokens: 5,
      reasoningTokens: 0,
      costUsd: 0.01,
    };
    writeFileSync(
      join(stateDir, 'raw', 'codex-01a08c15.jsonl'),
      [JSON.stringify(usageRaw), JSON.stringify(canonical), ''].join('\n'),
    );

    // Control: non-usage event lines must stay dropped (not counted as
    // zero-token records).
    const noise = [
      JSON.stringify({ type: 'step', sessionId: 's', timestamp: 1789075428930 }),
      JSON.stringify({ type: 'message', data: 'hello', timestamp: 1789075428931 }),
      JSON.stringify({ type: 'tool_call', functionName: 'read', timestamp: 1789075428932 }),
    ];
    writeFileSync(join(stateDir, 'raw', 'gemini-e0eebb34.jsonl'), noise.join('\n') + '\n');
  });

  after(() => {
    delete process.env.AGENTIC_CODING_HARNESS_STATE_DIR;
    rmSync(stateDir, { recursive: true, force: true });
  });

  it('parses real-shape {type:"usage"} lines into StatRecords with exact token counts', async () => {
    const recs = await readAllRecords();
    const real = recs.find((r) => r.agent === 'claude' && r.sessionId === undefined);
    assert.ok(real, 'real-shape usage line (no sessionId) must survive');
    assert.equal(real.model, 'claude-haiku-4-5-20251001');
    assert.equal(real.inputTokens, 954);
    assert.equal(real.outputTokens, 1612);
    assert.equal(real.cacheReadTokens, 16104);
    assert.equal(real.cacheWriteTokens, 17662);
    assert.equal(real.reasoningTokens, 0);
    assert.equal(real.costUsd, 0.1594895);
    assert.equal(real.ts, new Date(1789075428928).toISOString());
  });

  it('propagates a driver-attached sessionId from usage lines', async () => {
    const recs = await readAllRecords({ agent: 'claude' });
    const withSession = recs.find((r) => r.sessionId === 'sess-driver-1');
    assert.ok(withSession, 'usage line with sessionId must survive');
    assert.equal(withSession.inputTokens, 954);
  });

  it('keeps kiro usage.extra.credits (number) in StatRecord.extra', async () => {
    const recs = await readAllRecords({ agent: 'kiro' });
    assert.equal(recs.length, 1);
    const rec = recs[0]!;
    assert.equal(rec.inputTokens, 12);
    assert.equal(rec.outputTokens, 34);
    assert.ok(rec.extra, 'extra must survive into StatRecord');
    assert.equal(typeof rec.extra!.credits, 'number');
    assert.equal(rec.extra!.credits, 0.21785552902155886);
    assert.equal(rec.extra!.event, 'meteringEvent');
  });

  it('usage_raw lines still parse via normalizeAuto (codex cached-input subtraction)', async () => {
    const recs = await readAllRecords({ agent: 'codex' });
    const raw = recs.find((r) => r.sessionId === 'sess-raw-1');
    assert.ok(raw, 'usage_raw line must survive');
    assert.equal(raw.inputTokens, 80); // 100 - 20 cached
    assert.equal(raw.outputTokens, 30);
  });

  it('canonical record lines still parse unchanged', async () => {
    const recs = await readAllRecords({ agent: 'claude' });
    const canonical = recs.find((r) => r.sessionId === 'sess-canonical');
    assert.ok(canonical, 'canonical line must survive');
    assert.deepEqual(
      {
        inputTokens: canonical.inputTokens,
        outputTokens: canonical.outputTokens,
        cacheReadTokens: canonical.cacheReadTokens,
        cacheWriteTokens: canonical.cacheWriteTokens,
        costUsd: canonical.costUsd,
      },
      { inputTokens: 100, outputTokens: 50, cacheReadTokens: 10, cacheWriteTokens: 5, costUsd: 0.01 },
    );
  });

  it('non-usage event lines (step/message/tool_call) are still dropped', async () => {
    const recs = await readAllRecords({ agent: 'gemini' });
    assert.deepEqual(recs, []);
  });
});
