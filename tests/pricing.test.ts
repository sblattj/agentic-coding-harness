import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { createPricer, resolveAlias } from '../src/core/pricing.js';
import { AGENTS, type CanonicalTokenRecord } from '../src/core/types.js';

const rec = (model: string, inputTokens: number, outputTokens: number, cacheReadTokens = 0, cacheWriteTokens = 0): CanonicalTokenRecord => ({
  agent: 'test',
  model,
  inputTokens,
  outputTokens,
  cacheReadTokens,
  cacheWriteTokens,
  timestamp: 0,
});

/** Flagship model each harness agent runs by default (AGENTS order). */
const AGENT_DEFAULT_MODELS: Record<(typeof AGENTS)[number], string> = {
  claude: 'claude-sonnet-5',
  opencode: 'anthropic/claude-sonnet-5',
  kiro: 'claude-sonnet-4-5',
  codex: 'gpt-5.6',
  gemini: 'gemini-3-flash',
};

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
    // fable (LiteLLM): 10 / 50 / 0.25 / 12.5 per 1M
    assert.equal(p.price(rec('claude-fable-5-1', 1_000_000, 500_000, 1_000_000, 1_000_000)), 10 + 25 + 0.25 + 12.5);
    // gemini-3-pro (LiteLLM gemini-3-pro-preview): 2 / 12 / 0.2 / 0 per 1M (no cache-write charge)
    assert.equal(p.price(rec('gemini-3-pro', 1_000_000, 1_000_000, 2_000_000)), 2 + 12 + 0.4);
  });

  it('prices the new flagships: claude-sonnet-5, claude-opus-5, claude-opus-4-8, gpt-5.6, gemini-3-flash', () => {
    const p = createPricer();
    // LiteLLM per 1M: sonnet-5 2/10/0.2/2.5; opus-5 & opus-4-8 5/25/0.5/6.25;
    // gpt-5.6 4/20/0.4/5; gemini-3-flash (flash-preview) 0.5/3/0.05/0.
    assert.equal(p.price(rec('claude-sonnet-5', 1_000_000, 1_000_000, 1_000_000, 1_000_000)), 2 + 10 + 0.2 + 2.5);
    assert.equal(p.price(rec('claude-opus-5', 1_000_000, 0)), 5);
    assert.equal(p.price(rec('claude-opus-4-8', 0, 1_000_000)), 25);
    assert.equal(p.price(rec('gpt-5.6', 1_000_000, 1_000_000, 0, 1_000_000)), 4 + 20 + 5);
    assert.equal(p.price(rec('gemini-3-flash', 1_000_000, 1_000_000, 1_000_000)), 0.5 + 3 + 0.05);
  });

  it('prices every AGENTS default model to a finite number — never NaN', () => {
    const p = createPricer();
    for (const agent of AGENTS) {
      const model = AGENT_DEFAULT_MODELS[agent];
      const cost = p.price(rec(model, 1_000, 1_000, 1_000, 1_000));
      assert.ok(Number.isFinite(cost), `${agent} default model "${model}" resolved to ${cost}`);
    }
  });

  it('loads the bundled LiteLLM extract as the base map (beyond-fallback models resolve)', () => {
    const p = createPricer();
    // 'claude-3-haiku' prices only via src/core/pricing-data.json (dated
    // LiteLLM entry claude-3-haiku-20240307 + derived alias); the embedded
    // fallback has no entry.
    const cost = p.price(rec('claude-3-haiku', 1_000_000, 0));
    assert.ok(Number.isFinite(cost) && cost > 0, `cost=${cost}`);
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
    assert.equal(resolveAlias('claude-opus-5[1m]'), 'claude-opus-5'); // context-window tag
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

describe('multi-model records (extra.raw.models per-model breakdown)', () => {
  // Real shapes from a claude opus-5 run (2026-09): the CLI routed a probe
  // call through haiku and the main turn through opus-5[1m]. The aggregated
  // record kept the first modelUsage key (haiku) as its label, and pricing
  // the mixed aggregate at haiku rates reported $0.0214 vs the true $0.1028.
  const multi = (slices: unknown[]): CanonicalTokenRecord => ({
    agent: 'claude',
    model: 'claude-haiku-4-5-20251001', // first-model label (pre-fix behavior)
    inputTokens: 954,
    outputTokens: 1671,
    cacheReadTokens: 26282,
    cacheWriteTokens: 7544,
    reasoningTokens: 55,
    extra: {
      raw: {
        input: 954,
        output: 1671,
        cacheRead: 26282,
        cacheWrite: 7544,
        reasoning: 55,
        models: slices,
      },
    },
    timestamp: 0,
  });

  const bugSlices = [
    // The 950-token haiku probe: a real API call that never appears in the
    // session JSONL — kept in the aggregate, billed at haiku rates via this
    // breakdown.
    { model: 'claude-haiku-4-5-20251001', input: 950, output: 11, cacheRead: 0, cacheWrite: 0, reasoning: 0, costUsd: 0.001005 },
    { model: 'claude-opus-5[1m]', input: 4, output: 1660, cacheRead: 26282, cacheWrite: 7544, reasoning: 55, costUsd: 0.101811 },
  ];

  it('sums CLI-reported per-model costUsd: the opus-5 run prices $0.1028, not the haiku-priced $0.0214', () => {
    const p = createPricer();
    const cost = p.price(multi(bugSlices));
    assert.ok(Math.abs(cost - 0.102816) < 1e-12, `cost=${cost}`);
    assert.ok(Math.abs(cost - 0.0213672) > 0.01, 'must not price the aggregate as one model');
  });

  it('prices each slice by its own model when costUsd is absent (claude-opus-5[1m] resolves via alias)', () => {
    const p = createPricer();
    const cost = p.price(multi(bugSlices.map(({ costUsd: _drop, ...s }) => s)));
    // haiku: (950*1 + 11*5)/1M = 0.001005;
    // opus-5: (4*5 + 26282*0.5 + 7544*6.25 + 1660*25)/1M = 0.101811.
    assert.ok(Math.abs(cost - 0.102816) < 1e-12, `cost=${cost}`);
  });

  it('one unpriceable slice voids the record: NaN plus a warning, never a silent partial sum', () => {
    const p = createPricer();
    const cost = p.price(
      multi([
        { model: 'claude-haiku-4-5-20251001', input: 950, output: 11, cacheRead: 0, cacheWrite: 0, costUsd: 0.001005 },
        { model: 'mystery-model-v9', input: 4, output: 1660, cacheRead: 0, cacheWrite: 0 },
      ]),
    );
    assert.ok(Number.isNaN(cost));
    const warnings = p.drainWarnings();
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /unknown model "mystery-model-v9".*per-model breakdown/);
  });

  it('single-model behavior unchanged: no breakdown, or a one-entry one, still prices the aggregate', () => {
    const p = createPricer();
    assert.equal(p.price(rec('claude-haiku-4-5', 954, 1671, 26282, 7544)), 0.0213672);
    const oneEntry = multi([
      { model: 'claude-haiku-4-5-20251001', input: 954, output: 1671, cacheRead: 26282, cacheWrite: 7544, reasoning: 55, costUsd: 9 },
    ]);
    // A 1-entry breakdown is ignored (the aggregate IS that model's usage);
    // the per-entry costUsd is NOT substituted in.
    assert.equal(p.price(oneEntry), 0.0213672);
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
