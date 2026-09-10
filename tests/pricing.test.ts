import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { createPricer, resolveAlias } from '../src/core/pricing.js';
import type { CanonicalTokenRecord } from '../src/core/types.js';

const rec = (model: string, inputTokens: number, outputTokens: number, cacheReadTokens = 0, cacheWriteTokens = 0): CanonicalTokenRecord => ({
  agent: 'test',
  model,
  inputTokens,
  outputTokens,
  cacheReadTokens,
  cacheWriteTokens,
  timestamp: 0,
});

describe('embedded fallback map', () => {
  it('prices a claude-sonnet-4 record cache-aware (per 1M)', () => {
    const p = createPricer();
    // 100k in @$3 + 20k out @$15 + 50k cache-read @$0.30 + 10k cache-write @$3.75 per 1M
    const cost = p.price(rec('claude-sonnet-4', 100_000, 20_000, 50_000, 10_000));
    assert.equal(cost, 0.3 + 0.3 + 0.015 + 0.0375);
  });

  it('prices claude-opus-4 and gpt-5', () => {
    const p = createPricer();
    assert.equal(p.price(rec('claude-opus-4', 1_000_000, 0)), 15);
    assert.equal(p.price(rec('gpt-5', 0, 1_000_000, 1_000_000)), 10 + 0.125);
  });

  it('prices gemini-2.5-pro', () => {
    const p = createPricer();
    assert.equal(p.price(rec('gemini-2.5-pro', 1_000_000, 1_000_000)), 1.25 + 10);
  });

  it('prices the expanded entries: claude-fable-5-1 and gemini-3-pro', () => {
    const p = createPricer();
    // fable: 5 / 25 / 0.5 / 6.25 per 1M
    assert.equal(p.price(rec('claude-fable-5-1', 1_000_000, 500_000, 1_000_000, 1_000_000)), 5 + 12.5 + 0.5 + 6.25);
    // gemini-3-pro: 2 / 12 / 0.5 / 0 per 1M (no cache-write charge)
    assert.equal(p.price(rec('gemini-3-pro', 1_000_000, 1_000_000, 2_000_000)), 2 + 12 + 1);
  });
});

describe('alias resolution', () => {
  it('strips provider prefixes, date suffixes, and channels', () => {
    assert.equal(resolveAlias('anthropic/claude-sonnet-4-20250514'), 'claude-sonnet-4');
    assert.equal(resolveAlias('openai/gpt-5'), 'gpt-5');
    assert.equal(resolveAlias('google/gemini-2.5-pro-preview'), 'gemini-2.5-pro');
    assert.equal(resolveAlias('vertex_ai/claude-opus-4-20250514'), 'claude-opus-4');
    assert.equal(resolveAlias('CLAUDE-SONNET-4'), 'claude-sonnet-4');
    assert.equal(resolveAlias('google/gemini-3-pro-preview'), 'gemini-3-pro');
    assert.equal(resolveAlias('claude-fable-5-1'), 'claude-fable-5-1'); // no date/channel suffix to strip
  });

  it('prices through aliases without a separate entry', () => {
    const p = createPricer();
    assert.equal(p.price(rec('anthropic/claude-sonnet-4-20250514', 1_000_000, 0)), 3);
    assert.equal(p.price(rec('openai/gpt-5-latest', 0, 500_000)), 5);
    assert.equal(p.price(rec('google/gemini-3-pro-preview', 1_000_000, 0)), 2);
  });
});

describe('unknown models', () => {
  it('returns NaN and records a warning — never a silent 0', () => {
    const p = createPricer();
    assert.ok(Number.isNaN(p.price(rec('mystery-model-v9', 1_000, 1_000))));
    const warnings = p.drainWarnings();
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /unknown model "mystery-model-v9"/);
    assert.deepEqual(p.drainWarnings(), []); // drained
  });
});

describe('external LiteLLM-style cost map', () => {
  it('accepts per-token *_cost_per_token fields and overrides the fallback', () => {
    const dir = mkdtempSync(join(tmpdir(), 'harness-pricing-'));
    const mapPath = join(dir, 'prices.json');
    writeFileSync(
      mapPath,
      JSON.stringify({
        // LiteLLM per-token form: $5 / $25 per 1M.
        'claude-sonnet-4': {
          input_cost_per_token: 0.000005,
          output_cost_per_token: 0.000025,
          cache_read_input_token_cost: 0.0000005,
          cache_creation_input_token_cost: 0.00000625,
        },
      }),
    );
    const p = createPricer(mapPath);
    assert.equal(p.price(rec('claude-sonnet-4', 1_000_000, 100_000, 1_000_000, 0)), 5 + 2.5 + 0.5);
  });

  it('accepts per-1M fields too', () => {
    const dir = mkdtempSync(join(tmpdir(), 'harness-pricing-'));
    const mapPath = join(dir, 'prices.json');
    writeFileSync(mapPath, JSON.stringify({ 'weird-model': { input: 2, output: 4, cache_read: 0.2, cache_creation: 0 } }));
    const p = createPricer(mapPath);
    assert.equal(p.price(rec('weird-model', 1_000_000, 0)), 2);
  });

  it('falls back to embedded map with a warning on unreadable paths', () => {
    const p = createPricer('/nonexistent/prices.json');
    assert.equal(p.price(rec('claude-sonnet-4', 1_000_000, 0)), 3);
    assert.ok(p.drainWarnings().some((w) => /failed to load cost map/.test(w)));
  });
});
