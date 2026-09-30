// Issue #105: claude-opus-5-5 list rates, and cache writes billed per TTL.
//
// Claude Code writes its prompt cache with the 1h TTL (2x input) and its
// usage records split writes as usage.cache_creation =
// {ephemeral_5m_input_tokens, ephemeral_1h_input_tokens}. The split rides
// CanonicalTokenRecord.cacheWrite1hTokens from every claude parser to the
// pricer, and `ach audit` recomputes from the same split.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, it } from 'node:test';

import { ClaudeCodeAdapter, type HarnessChildProcess } from '../src/adapters/claude.ts';
import { auditRuns } from '../src/cli/audit.ts';
import { createDriver } from '../src/core/driver.ts';
import { normalizeClaude, sumTokens } from '../src/core/normalize.ts';
import { createPricer } from '../src/core/pricing.ts';
import { readRunRecord } from '../src/core/registry.ts';
import { readRecordFiles } from '../src/core/store.ts';
import type { CanonicalTokenRecord } from '../src/core/types.ts';
import { parseClaudeTranscript, toCanonicalTokenRecord } from '../src/monitors/transcripts.ts';

const close = (actual: number, expected: number, eps = 1e-6, msg?: string): void => {
  assert.ok(Math.abs(actual - expected) < eps, `${msg ?? ''} expected ${expected}, got ${actual}`);
};

const rec = (
  model: string,
  t: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; cacheWrite1h?: number },
): CanonicalTokenRecord => ({
  agent: 'claude',
  model,
  inputTokens: t.input ?? 0,
  outputTokens: t.output ?? 0,
  cacheReadTokens: t.cacheRead ?? 0,
  cacheWriteTokens: t.cacheWrite ?? 0,
  ...(t.cacheWrite1h !== undefined ? { cacheWrite1hTokens: t.cacheWrite1h } : {}),
});

// The issue's two real claude-opus-5-5 runs (medium effort, `ach run --json`).
// Every write was 1h; the CLI-reported costUsd is the reference.
const RUN_A = { input: 108, output: 38_126, cacheRead: 6_001_930, cacheWrite: 156_097, cli: 3.212114 };
const RUN_B = { input: 94, output: 33_269, cacheRead: 4_507_057, cacheWrite: 141_793, cli: 2.701511 };

describe('issue #105: claude-opus-5-5 list rates + 1h cache-write pricing', () => {
  it('regression: both real runs price to the CLI-reported cost when every write is 1h', () => {
    const p = createPricer();
    for (const run of [RUN_A, RUN_B]) {
      const cost = p.price(rec('claude-opus-5-5', { ...run, cacheWrite1h: run.cacheWrite }));
      close(cost, run.cli, 1e-6, `run ${run.cli}`);
    }
    // Dated / [1m]-tagged ids resolve to the same exact entry: no estimate.
    close(p.price(rec('claude-opus-5-5[1m]', { ...RUN_A, cacheWrite1h: RUN_A.cacheWrite })), RUN_A.cli);
    assert.deepEqual(p.drainWarnings(), []);
  });

  it('control: without a TTL split every write bills at the 5m rate (the pre-#105 fallback)', () => {
    const p = createPricer();
    // 108*4 + 38126*20 + 6001930*0.2 + 156097*5 = 2,743,823 micro-USD.
    close(p.price(rec('claude-opus-5-5', RUN_A)), 2.743823);
    // Same tokens, split present: strictly more (1h is 2x input vs 1.25x).
    assert.ok(p.price(rec('claude-opus-5-5', { ...RUN_A, cacheWrite1h: RUN_A.cacheWrite })) > 2.743823 + 0.4);
  });

  it('bills each TTL bucket at its own rate on a mixed split', () => {
    const p = createPricer();
    // 600k 5m @ $5 + 400k 1h @ $8 per 1M.
    close(p.price(rec('claude-opus-5-5', { cacheWrite: 1_000_000, cacheWrite1h: 400_000 })), 3 + 3.2, 1e-9);
    // ephemeral_1h = 0 is a real split: every write is 5m.
    close(p.price(rec('claude-opus-5-5', { cacheWrite: 1_000_000, cacheWrite1h: 0 })), 5, 1e-9);
  });

  it('clamps a 1h count larger than the total write count (never bills phantom tokens)', () => {
    const p = createPricer();
    close(p.price(rec('claude-opus-5-5', { cacheWrite: 1_000_000, cacheWrite1h: 5_000_000 })), 8, 1e-9);
    close(p.price(rec('claude-opus-5-5', { cacheWrite: 1_000_000, cacheWrite1h: -3 })), 5, 1e-9);
  });

  it('every Claude model bills a 1h write at 2x its input rate and a 5m write at 1.25x', () => {
    const p = createPricer();
    const models = [
      'claude-sonnet-4', 'claude-sonnet-4-5', 'claude-sonnet-4-6', 'claude-sonnet-5', 'claude-sonnet-5-5',
      'claude-haiku-4-5', 'claude-3-haiku', 'claude-3-7-sonnet', 'claude-4-sonnet', 'claude-4-opus',
      'claude-opus-4', 'claude-opus-4-1', 'claude-opus-4-5', 'claude-opus-4-8', 'claude-opus-5', 'claude-opus-5-5',
      'claude-fable-5', 'claude-fable-5-1',
    ];
    for (const m of models) {
      const input = p.price(rec(m, { input: 1_000_000 }));
      assert.ok(Number.isFinite(input) && input > 0, `${m} priced`);
      close(p.price(rec(m, { cacheWrite: 1_000_000, cacheWrite1h: 1_000_000 })), 2 * input, 1e-9, `${m} 1h`);
      if (m !== 'claude-3-haiku') {
        // claude-3-haiku's LiteLLM 5m rate is 1.2x ($0.30 on $0.25); every
        // other model follows Anthropic's 1.25x rule.
        close(p.price(rec(m, { cacheWrite: 1_000_000 })), 1.25 * input, 1e-9, `${m} 5m`);
      }
    }
    assert.deepEqual(p.drainWarnings(), []);
  });

  it('claude-sonnet-5-5 bills 1h writes at $4 (2x its $2 input)', () => {
    const p = createPricer();
    close(p.price(rec('claude-sonnet-5-5', { cacheWrite: 1_000_000, cacheWrite1h: 1_000_000 })), 4, 1e-9);
  });

  it('a model with no 1h tier bills 1h-split writes at its single cache_creation rate', () => {
    const p = createPricer();
    // gpt-5.6 cache_creation $5 per 1M, no 1h rate.
    close(p.price(rec('gpt-5.6', { cacheWrite: 1_000_000, cacheWrite1h: 1_000_000 })), 5, 1e-9);
  });

  it('override files: a cache_creation-only entry drops the 1h tier (issue workaround); 1h fields are read', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ach-105-override-'));
    try {
      const plain = join(dir, 'plain.json');
      writeFileSync(plain, JSON.stringify({ 'claude-opus-5-5': { input: 4, output: 20, cache_read: 0.2, cache_creation: 8 } }));
      close(createPricer(plain).price(rec('claude-opus-5-5', { cacheWrite: 1_000_000, cacheWrite1h: 1_000_000 })), 8, 1e-9);
      close(createPricer(plain).price(rec('claude-opus-5-5', { cacheWrite: 1_000_000 })), 8, 1e-9);

      const per1m = join(dir, 'per1m.json');
      writeFileSync(per1m, JSON.stringify({ 'claude-x-1': { input: 1, output: 1, cache_read: 0, cache_creation: 1.25, cache_creation_1h: 2 } }));
      close(createPricer(per1m).price(rec('claude-x-1', { cacheWrite: 1_000_000, cacheWrite1h: 250_000 })), 0.75 * 1.25 + 0.25 * 2, 1e-9);

      const perToken = join(dir, 'per-token.json');
      writeFileSync(perToken, JSON.stringify({
        'claude-x-2': {
          input_cost_per_token: 1e-6, output_cost_per_token: 1e-6,
          cache_creation_input_token_cost: 1.25e-6, cache_creation_input_token_cost_above_1hr: 2e-6,
        },
      }));
      close(createPricer(perToken).price(rec('claude-x-2', { cacheWrite: 1_000_000, cacheWrite1h: 1_000_000 })), 2, 1e-9);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  describe('multi-model records (split known only at the aggregate)', () => {
    const multi = (cacheWrite1h: number | undefined, withCost: boolean, sliceSplit = false): CanonicalTokenRecord => ({
      ...rec('claude-opus-5-5', { cacheWrite: 1_000_000, ...(cacheWrite1h !== undefined ? { cacheWrite1h } : {}) }),
      extra: {
        raw: {
          models: [
            { model: 'claude-haiku-4-5', input: 0, output: 0, cacheRead: 0, cacheWrite: 200_000, ...(withCost ? { costUsd: 1 } : {}), ...(sliceSplit ? { cacheWrite1h: 0 } : {}) },
            { model: 'claude-opus-5-5', input: 0, output: 0, cacheRead: 0, cacheWrite: 800_000, ...(withCost ? { costUsd: 2 } : {}) },
          ],
        },
      },
    });

    it('apportions the record-level 1h share across slices by each slice\'s writes', () => {
      const p = createPricer();
      // All 1h: haiku 200k @ $2 + opus 800k @ $8 = 0.4 + 6.4.
      close(p.price(multi(1_000_000, false)), 0.4 + 6.4, 1e-9);
      // Half 1h: each slice half 5m, half 1h.
      close(p.price(multi(500_000, false)), 0.1 * 1.25 + 0.1 * 2 + 0.4 * 5 + 0.4 * 8, 1e-9);
      // No split: 5m everywhere.
      close(p.price(multi(undefined, false)), 0.2 * 1.25 + 0.8 * 5, 1e-9);
    });

    it('a slice-level split wins over the apportioned share', () => {
      const p = createPricer();
      // haiku slice says 0 of its writes were 1h; opus gets the record share (100%).
      close(p.price(multi(1_000_000, false, true)), 0.2 * 1.25 + 0.8 * 8, 1e-9);
    });

    it('auto mode still sums CLI-reported slice costs; computedOnly uses the split', () => {
      const p = createPricer();
      assert.equal(p.price(multi(1_000_000, true)), 3);
      close(p.price(multi(1_000_000, true), { computedOnly: true }), 0.4 + 6.4, 1e-9);
    });
  });
});

// ---------------------------------------------------------------- parsers

const CACHE_SPLIT = (oneH: number, fiveM = 0) => ({ ephemeral_5m_input_tokens: fiveM, ephemeral_1h_input_tokens: oneH });

/** A stream-json result line in the observed CLI 2.x shape: modelUsage has no
 *  TTL split, the aggregate result.usage does. */
function resultLine(run: typeof RUN_A, model: string, split: unknown): string {
  return JSON.stringify({
    type: 'result',
    subtype: 'success',
    session_id: `sess-${run.cli}`,
    is_error: false,
    total_cost_usd: run.cli,
    usage: {
      input_tokens: run.input,
      output_tokens: run.output,
      cache_read_input_tokens: run.cacheRead,
      cache_creation_input_tokens: run.cacheWrite,
      ...(split !== undefined ? { cache_creation: split } : {}),
    },
    modelUsage: {
      [model]: {
        inputTokens: run.input,
        outputTokens: run.output,
        cacheReadInputTokens: run.cacheRead,
        cacheCreationInputTokens: run.cacheWrite,
        costUSD: run.cli,
      },
    },
  });
}

class FakeChild extends EventEmitter implements HarnessChildProcess {
  stdout = new PassThrough();
  stderr = new PassThrough();
  pid = 424242;
  kill(): boolean {
    queueMicrotask(() => this.emit('close', 143, null));
    return true;
  }
}

function claudeAdapterFeeding(stateDir: string, ndjson: string): ClaudeCodeAdapter {
  return new ClaudeCodeAdapter({
    stateDir,
    spawnFn: () => {
      const child = new FakeChild();
      queueMicrotask(() => {
        child.stdout.end(ndjson);
        child.stderr.end();
        child.emit('close', 0, null);
      });
      return child;
    },
  });
}

describe('issue #105: the TTL split reaches the pricer and ach audit', () => {
  it('stream-json → driver → RunRecord cost matches the CLI; audit recomputes it exactly', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ach-105-driver-'));
    try {
      const driver = createDriver({
        adapters: { claude: claudeAdapterFeeding(dir, resultLine(RUN_A, 'claude-opus-5-5', CACHE_SPLIT(RUN_A.cacheWrite)) + '\n') },
        stateDir: dir,
        registry: { stateDir: dir },
      });
      const res = await driver.run('claude', { prompt: 'fixture' });
      assert.equal(res.tokens.length, 1);
      assert.equal(res.tokens[0]!.cacheWrite1hTokens, RUN_A.cacheWrite);
      assert.equal(res.tokens[0]!.cacheWriteTokens, RUN_A.cacheWrite, 'cacheWriteTokens stays the 5m+1h total');
      const run = readRunRecord(dir, res.runId)!;
      close(run.totals!.costUsd, RUN_A.cli);

      const audit = auditRuns({ stateDir: dir });
      assert.equal(audit.rows.length, 1);
      const row = audit.rows[0]!;
      assert.equal(row.status, 'ok', JSON.stringify(row));
      assert.equal(row.derivation.raw, 1);
      close(row.recomputed!.costUsd!, RUN_A.cli);
      assert.equal(row.fieldStatus!.costUsd, 'ok');

      // The store lane (ach stats) reads the split off the recorded usage event.
      const raw = join(dir, 'raw');
      const [stat] = await readRecordFiles([{ file: join(raw, `claude-${res.sessionId}.jsonl`), root: raw }]);
      assert.equal(stat!.cacheWrite1hTokens, RUN_A.cacheWrite);
      close(createPricer().price(stat!), RUN_A.cli);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('control: a result line with no split (or a null split) prices every write at 5m', async () => {
    for (const split of [undefined, null]) {
      const dir = mkdtempSync(join(tmpdir(), 'ach-105-driver-'));
      try {
        const driver = createDriver({
          adapters: { claude: claudeAdapterFeeding(dir, resultLine(RUN_A, 'claude-opus-5-5', split) + '\n') },
          stateDir: dir,
          registry: { stateDir: dir },
        });
        const res = await driver.run('claude', { prompt: 'fixture' });
        assert.equal(res.tokens.length, 1, `split=${String(split)}: result line still parsed`);
        assert.equal(res.tokens[0]!.cacheWrite1hTokens, undefined);
        close(readRunRecord(dir, res.runId)!.totals!.costUsd, 2.743823);
        assert.equal(auditRuns({ stateDir: dir }).rows[0]!.status, 'ok');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it('assistant-message usage carries the split per message', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ach-105-msg-'));
    try {
      const assistant = JSON.stringify({
        type: 'assistant',
        session_id: 'sess-msg',
        message: {
          model: 'claude-opus-5-5',
          content: [{ type: 'text', text: 'hi' }],
          usage: { input_tokens: 2, output_tokens: 3, cache_read_input_tokens: 4, cache_creation_input_tokens: 700, cache_creation: CACHE_SPLIT(500, 200) },
        },
      });
      const adapter = claudeAdapterFeeding(dir, assistant + '\n');
      const handle = await adapter.launch({ prompt: 'x' });
      const events: { type: string; usage?: CanonicalTokenRecord }[] = [];
      for await (const e of handle.attach()) events.push(e as { type: string; usage?: CanonicalTokenRecord });
      await handle.wait();
      // claudeEventToCore bridges message usage through claudeUsageToCore.
      const usage = events.find((e) => e.type === 'message')?.usage;
      assert.ok(usage, 'message event carries usage');
      assert.equal(usage.cacheWrite1hTokens, 500);
      assert.equal(usage.cacheWriteTokens, 700);
      const house = normalizeClaude('claude', JSON.parse(assistant), 0)!;
      assert.equal(house.cacheWrite1hTokens, 500);
      assert.equal(house.cacheWriteTokens, 700);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('normalizer: result line (modelUsage + aggregate usage) and bare usage block carry the split', () => {
    const line = JSON.parse(resultLine(RUN_B, 'claude-opus-5-5', CACHE_SPLIT(RUN_B.cacheWrite)));
    const r = normalizeClaude('claude', line, 0)!;
    assert.equal(r.cacheWrite1hTokens, RUN_B.cacheWrite);
    close(createPricer().price(r), RUN_B.cli);
    const bare = normalizeClaude('claude', line.usage, 0)!;
    assert.equal(bare.cacheWrite1hTokens, RUN_B.cacheWrite);
    // Without the split the field is absent, never a fabricated 0.
    const none = normalizeClaude('claude', JSON.parse(resultLine(RUN_B, 'claude-opus-5-5', undefined)), 0)!;
    assert.equal('cacheWrite1hTokens' in none, false);
    // sumTokens sums the split only over records that define it.
    assert.equal(sumTokens([r, none]).cacheWrite1hTokens, RUN_B.cacheWrite);
    assert.equal('cacheWrite1hTokens' in sumTokens([none]), false);
  });

  it('transcript monitor: session JSONL usage.cache_creation reaches the canonical record', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ach-105-transcript-'));
    try {
      const file = join(dir, 'session.jsonl');
      const line = (id: string, usage: Record<string, unknown>) => JSON.stringify({
        type: 'assistant', sessionId: 's', requestId: id, timestamp: '2026-09-29T00:00:00.000Z',
        message: { id, model: 'claude-opus-5-5', usage },
      });
      writeFileSync(file, [
        line('a', { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 53_665, cache_creation: CACHE_SPLIT(53_665) }),
        line('b', { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 10, cache_creation: 'garbage' }),
      ].join('\n') + '\n');
      const recs = await parseClaudeTranscript(file);
      assert.equal(recs.length, 2, 'a malformed split never drops the record');
      const a = recs.find((r) => r.cacheWrite === 53_665)!;
      assert.equal(a.cacheWrite1h, 53_665);
      assert.equal(toCanonicalTokenRecord(a).cacheWrite1hTokens, 53_665);
      const b = recs.find((r) => r.cacheWrite === 10)!;
      assert.equal(b.cacheWrite1h, undefined);
      assert.equal('cacheWrite1hTokens' in toCanonicalTokenRecord(b), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
