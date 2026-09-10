import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  normalizeAuto,
  normalizeClaude,
  normalizeCodex,
  normalizeGemini,
  normalizeKiro,
  normalizeOpencode,
  normalizeUsage,
  sumTokens,
} from '../src/core/normalize.js';

const TS = 1_700_000_000_000;

describe('claude wire shapes', () => {
  it('result.modelUsage: the record KEY is the model (no inner model key)', () => {
    const raw = {
      modelUsage: {
        'claude-sonnet-4-20250514': {
          inputTokens: 100,
          outputTokens: 50,
          cacheCreationInputTokens: 20,
          cacheReadInputTokens: 30,
          reasoningTokens: 8,
          costUSD: 0.42,
        },
      },
    };
    assert.deepEqual(normalizeClaude('claude', raw, TS), {
      agent: 'claude',
      model: 'claude-sonnet-4-20250514',
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 30,
      cacheWriteTokens: 20,
      reasoningTokens: 8,
      costUsd: 0.42,
      timestamp: TS,
    });
  });

  it('result.modelUsage multi-model: sums classes, joins model names, sums costUsd over defined only', () => {
    const raw = {
      modelUsage: {
        'claude-sonnet-4': { inputTokens: 10, outputTokens: 1 },
        'claude-haiku-4': { inputTokens: 5, outputTokens: 2, cacheReadInputTokens: 7, reasoningTokens: 3, costUSD: 0.01 },
      },
    };
    const rec = normalizeClaude('claude', raw, TS);
    assert.ok(rec);
    assert.equal(rec.model, 'claude-sonnet-4+claude-haiku-4');
    assert.equal(rec.inputTokens, 15);
    assert.equal(rec.outputTokens, 3);
    assert.equal(rec.cacheReadTokens, 7);
    assert.equal(rec.cacheWriteTokens, 0);
    assert.equal(rec.reasoningTokens, 3);
    assert.equal(rec.costUsd, 0.01);
  });

  it('result.usage fallback block (snake_case, no model)', () => {
    const raw = {
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        cache_creation_input_tokens: 2,
        cache_read_input_tokens: 3,
        reasoning_tokens: 1,
      },
    };
    assert.deepEqual(normalizeClaude('claude', raw, TS), {
      agent: 'claude',
      model: 'unknown',
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 3,
      cacheWriteTokens: 2,
      reasoningTokens: 1,
      timestamp: TS,
    });
  });

  it('raw assistant stream-json line ({message: {model, usage}})', () => {
    const raw = {
      type: 'assistant',
      message: {
        model: 'claude-opus-4-1',
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          cache_creation_input_tokens: 2,
          cache_read_input_tokens: 3,
        },
      },
    };
    assert.deepEqual(normalizeClaude('claude', raw, TS), {
      agent: 'claude',
      model: 'claude-opus-4-1',
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 3,
      cacheWriteTokens: 2,
      timestamp: TS,
    });
  });

  it('bare result.usage block passed alone (claude-distinctive keys present)', () => {
    const raw = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 3, cache_creation_input_tokens: 2 };
    const rec = normalizeClaude('claude', raw, TS);
    assert.ok(rec);
    assert.equal(rec.model, 'unknown');
    assert.equal(rec.inputTokens, 10);
    assert.equal(rec.outputTokens, 5);
    assert.equal(rec.cacheReadTokens, 3);
    assert.equal(rec.cacheWriteTokens, 2);
  });

  it('legacy flattened entry with inner model still accepted', () => {
    const raw = {
      model: 'claude-sonnet-4-20250514',
      inputTokens: 100,
      outputTokens: 50,
      cacheCreationInputTokens: 20,
      cacheReadInputTokens: 30,
    };
    assert.deepEqual(normalizeClaude('claude', raw, TS), {
      agent: 'claude',
      model: 'claude-sonnet-4-20250514',
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 30,
      cacheWriteTokens: 20,
      timestamp: TS,
    });
  });

  it('does not swallow core-canonical records', () => {
    const canonical = { agent: 'opencode', inputTokens: 5, outputTokens: 2, cacheReadTokens: 1, cacheWriteTokens: 1, timestamp: TS };
    assert.equal(normalizeClaude('claude', canonical, TS), null);
  });

  it('does not claim bare codex-shaped usage blocks (ambiguity left to codex)', () => {
    assert.equal(normalizeClaude('claude', { input_tokens: 10, output_tokens: 5 }, TS), null);
  });
});

describe('opencode', () => {
  it('normalizes step_finish part.tokens', () => {
    const raw = {
      model: 'gpt-5',
      tokens: { input: 8, output: 4, reasoning: 1, cache: { read: 6, write: 2 } },
    };
    assert.deepEqual(normalizeOpencode('opencode', raw, TS), {
      agent: 'opencode',
      model: 'gpt-5',
      inputTokens: 8,
      outputTokens: 4,
      cacheReadTokens: 6,
      cacheWriteTokens: 2,
      reasoningTokens: 1,
      timestamp: TS,
    });
  });

  it('defaults model to unknown when the part carries none', () => {
    const raw = { tokens: { input: 8, output: 4, cache: { read: 6, write: 2 } } };
    const rec = normalizeOpencode('opencode', raw, TS);
    assert.ok(rec);
    assert.equal(rec.model, 'unknown');
  });
});

describe('codex', () => {
  it('subtracts cached input so canonical input is uncached-only', () => {
    const raw = {
      input_tokens: 100,
      cached_input_tokens: 40,
      output_tokens: 20,
      reasoning_output_tokens: 5,
    };
    const rec = normalizeCodex('codex', raw, TS);
    assert.ok(rec);
    assert.equal(rec.inputTokens, 60);
    assert.equal(rec.cacheReadTokens, 40);
    assert.equal(rec.cacheWriteTokens, 0);
    assert.equal(rec.outputTokens, 20);
    assert.equal(rec.reasoningTokens, 5);
  });

  it('passes through cache_write_input_tokens', () => {
    const raw = {
      input_tokens: 100,
      cached_input_tokens: 40,
      cache_write_input_tokens: 10,
      output_tokens: 20,
    };
    const rec = normalizeCodex('codex', raw, TS);
    assert.ok(rec);
    assert.equal(rec.inputTokens, 60);
    assert.equal(rec.cacheReadTokens, 40);
    assert.equal(rec.cacheWriteTokens, 10);
  });
});

describe('gemini', () => {
  it('nested stats: cached is a subset of prompt, thought is billable output', () => {
    const raw = {
      stats: {
        models: {
          'gemini-2.5-pro': {
            tokens: { prompt: 200, candidates: 30, cached: 50, thought: 10 },
          },
        },
      },
    };
    const rec = normalizeGemini('gemini', raw, TS);
    assert.ok(rec);
    assert.equal(rec.model, 'gemini-2.5-pro');
    assert.equal(rec.inputTokens, 150);
    assert.equal(rec.outputTokens, 40);
    assert.equal(rec.cacheReadTokens, 50);
    assert.equal(rec.reasoningTokens, 10);
  });

  it('nested stats multi-model: sums and joins names', () => {
    const raw = {
      stats: {
        models: {
          'gemini-2.5-pro': { tokens: { prompt: 200, candidates: 30, cached: 50 } },
          'gemini-3-pro': { tokens: { prompt: 100, candidates: 10, cached: 20, thought: 5 } },
        },
      },
    };
    const rec = normalizeGemini('gemini', raw, TS);
    assert.ok(rec);
    assert.equal(rec.model, 'gemini-2.5-pro+gemini-3-pro');
    assert.equal(rec.inputTokens, 230); // (200-50) + (100-20)
    assert.equal(rec.outputTokens, 45); // 30 + 10 + 5 thought
    assert.equal(rec.cacheReadTokens, 70);
    assert.equal(rec.reasoningTokens, 5);
  });

  it('flat stats with explicit uncached input field: input wins as-is', () => {
    const raw = { stats: { input: 80, input_tokens: 150, output_tokens: 40, cached: 60, thoughts: 12 } };
    const rec = normalizeGemini('gemini', raw, TS);
    assert.ok(rec);
    assert.equal(rec.model, 'unknown');
    assert.equal(rec.inputTokens, 80); // not derived 150-60=90
    assert.equal(rec.outputTokens, 40);
    assert.equal(rec.cacheReadTokens, 60);
    assert.equal(rec.reasoningTokens, 12);
  });

  it('flat stats without input field: derives input_tokens - cached', () => {
    const raw = { stats: { input_tokens: 150, output_tokens: 40, cached: 60, thoughts: 12 } };
    const rec = normalizeGemini('gemini', raw, TS);
    assert.ok(rec);
    assert.equal(rec.inputTokens, 90);
    assert.equal(rec.outputTokens, 40);
    assert.equal(rec.cacheReadTokens, 60);
    assert.equal(rec.reasoningTokens, 12);
  });

  it('flat stats without cached field: input is the whole prompt', () => {
    const raw = { stats: { input_tokens: 10, output_tokens: 5 } };
    const rec = normalizeGemini('gemini', raw, TS);
    assert.ok(rec);
    assert.equal(rec.inputTokens, 10);
    assert.equal(rec.outputTokens, 5);
    assert.equal(rec.cacheReadTokens, 0);
  });
});

describe('kiro', () => {
  it('normalizes MITM tokenUsage', () => {
    const raw = {
      model: 'claude-sonnet-4',
      tokenUsage: { inputTokens: 11, outputTokens: 7, cacheReadTokens: 4, cacheWriteTokens: 3 },
    };
    assert.deepEqual(normalizeKiro('kiro', raw, TS), {
      agent: 'kiro',
      model: 'claude-sonnet-4',
      inputTokens: 11,
      outputTokens: 7,
      cacheReadTokens: 4,
      cacheWriteTokens: 3,
      timestamp: TS,
    });
  });
});

describe('dispatcher', () => {
  it('routes each agent', () => {
    assert.ok(normalizeUsage('claude', { modelUsage: { m: { inputTokens: 1, outputTokens: 1 } } }, TS));
    assert.ok(normalizeUsage('opencode', { tokens: { input: 1, output: 1 } }, TS));
    assert.ok(normalizeUsage('codex', { input_tokens: 2, output_tokens: 1 }, TS));
    assert.ok(normalizeUsage('gemini', { stats: { models: { g: { tokens: { prompt: 1, candidates: 1 } } } } }, TS));
    assert.ok(normalizeUsage('gemini', { stats: { input_tokens: 2, output_tokens: 1 } }, TS));
    assert.ok(normalizeUsage('kiro', { tokenUsage: { inputTokens: 1, outputTokens: 1 } }, TS));
  });

  it('returns null for unknown agents, malformed payloads, and empty stats', () => {
    assert.equal(normalizeUsage('windsurf', { tokens: {} }, TS), null);
    assert.equal(normalizeUsage('claude', { garbage: true }, TS), null);
    assert.equal(normalizeUsage('kiro', { tokenUsage: { inputTokens: 'many' } }, TS), null);
    assert.equal(normalizeUsage('gemini', { stats: {} }, TS), null);
    assert.equal(normalizeUsage('claude', { modelUsage: {} }, TS), null);
  });

  it('normalizeAuto routes by payload shape regardless of agent name', () => {
    const flat = normalizeAuto('mock', { stats: { input_tokens: 10, output_tokens: 5, cached: 2 } }, TS);
    assert.ok(flat);
    assert.equal(flat.agent, 'mock'); // agent label preserved; shape picks the extractor
    assert.equal(flat.inputTokens, 8);
    const nested = normalizeAuto('mock', { modelUsage: { 'claude-sonnet-4': { inputTokens: 1, outputTokens: 1 } } }, TS);
    assert.ok(nested);
    assert.equal(nested.model, 'claude-sonnet-4');
    assert.equal(normalizeAuto('mock', { nothing: true }, TS), null);
  });
});

describe('sumTokens', () => {
  it('counts each token class exactly once across providers', () => {
    const codex = normalizeCodex('codex', { input_tokens: 100, cached_input_tokens: 40, output_tokens: 20 }, TS)!;
    const claude = normalizeClaude(
      'claude',
      { modelUsage: { 'claude-sonnet-4': { inputTokens: 10, outputTokens: 5, cacheCreationInputTokens: 3, cacheReadInputTokens: 4 } } },
      TS,
    )!;
    const total = sumTokens([codex, claude]);
    assert.deepEqual(
      {
        input: total.inputTokens,
        output: total.outputTokens,
        read: total.cacheReadTokens,
        write: total.cacheWriteTokens,
      },
      { input: 70, output: 25, read: 44, write: 3 },
    );
  });

  it('sums costUsd over defined values only; omits it when none defines one', () => {
    const a = normalizeCodex('codex', { input_tokens: 10, cached_input_tokens: 4, output_tokens: 2 }, TS)!;
    const b = normalizeClaude('claude', { modelUsage: { m1: { inputTokens: 1, outputTokens: 1, costUSD: 2 } } }, TS)!;
    const c = normalizeClaude('claude', { modelUsage: { m2: { inputTokens: 1, outputTokens: 1, costUSD: 3 } } }, TS)!;
    assert.equal(sumTokens([a, b, c]).costUsd, 5);
    assert.equal('costUsd' in sumTokens([a]), false);
  });

  it('returns zeros for an empty list', () => {
    const total = sumTokens([]);
    assert.equal(total.inputTokens, 0);
    assert.equal(total.outputTokens, 0);
    assert.equal(total.cacheReadTokens, 0);
    assert.equal(total.cacheWriteTokens, 0);
  });
});
