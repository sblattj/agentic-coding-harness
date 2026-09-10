import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AtifWriter } from '../src/emitters/atif.js';
import type { AtifTrajectory } from '../src/emitters/atif.js';
import type { AgentEvent } from '../src/core/types.js';

const T0 = Date.parse('2026-09-09T12:00:00Z');

function sampleEvents(): AgentEvent[] {
  return [
    { type: 'message', source: 'user', content: 'What is the weather?', timestamp: T0 },
    {
      type: 'tool_call',
      toolCallId: 'call_1',
      functionName: 'get_weather',
      arguments: { city: 'SF' },
      timestamp: T0 + 100,
    },
    { type: 'tool_result', toolCallId: 'call_1', content: 'sunny, 68F', timestamp: T0 + 200 },
    {
      type: 'usage',
      usage: {
        inputTokens: 90,
        outputTokens: 45,
        cacheReadTokens: 30,
        cacheWriteTokens: 0,
        promptTokens: 120,
        completionTokens: 45,
        cachedTokens: 30,
        costUsd: 0.0012,
      },
      timestamp: T0 + 250,
    },
    { type: 'message', source: 'agent', content: 'It is sunny, 68F.', timestamp: T0 + 300 },
    {
      type: 'usage',
      usage: { inputTokens: 80, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.0004 },
      timestamp: T0 + 350,
    },
  ];
}

describe('AtifWriter', () => {
  it('builds a valid 3-step trajectory, writes it, and validates ok', () => {
    const dir = mkdtempSync(join(tmpdir(), 'atif-'));
    const outPath = join(dir, 'trajectory.json');

    const writer = AtifWriter.fromEvents(sampleEvents(), {
      agent: 'harness-agent',
      version: '1.2.0',
      modelName: 'test-model',
    });
    const doc = writer.finalize(outPath);

    assert.equal(doc.schema_version, 'ATIF-v1.7');
    assert.equal(doc.steps.length, 3);
    assert.deepEqual(doc.steps.map((s) => s.step_id), [1, 2, 3]);
    assert.equal(doc.steps[0].source, 'user');
    assert.equal(doc.steps[1].tool_calls[0].tool_call_id, 'call_1');
    assert.equal(doc.steps[1].tool_calls[0].function_name, 'get_weather');
    assert.deepEqual(doc.steps[1].observation.results[0], {
      source_call_id: 'call_1',
      content: 'sunny, 68F',
    });
    assert.equal(doc.steps[1].metrics.prompt_tokens, 120);
    assert.equal(doc.steps[1].metrics.completion_tokens, 45);
    assert.equal(doc.steps[1].metrics.cached_tokens, 30);
    assert.equal(doc.steps[1].metrics.cost_usd, 0.0012);
    assert.equal(doc.steps[1].llm_call_count, 1);
    assert.deepEqual(doc.final_metrics, {
      total_prompt_tokens: 200,
      total_completion_tokens: 65,
      total_cached_tokens: 30,
      total_cost_usd: 0.0016,
      total_steps: 3,
    });

    const onDisk = JSON.parse(readFileSync(outPath, 'utf8')) as AtifTrajectory;
    assert.equal(onDisk.trajectory_id, doc.trajectory_id);

    const result = AtifWriter.validate(outPath);
    assert.deepEqual(result, { ok: true, errors: [] });
  });

  it('fails validation when step order is broken', () => {
    const dir = mkdtempSync(join(tmpdir(), 'atif-'));
    const outPath = join(dir, 'broken.json');
    AtifWriter.fromEvents(sampleEvents()).finalize(outPath);

    const doc = JSON.parse(readFileSync(outPath, 'utf8')) as AtifTrajectory;
    doc.steps[0].step_id = 2;
    writeFileSync(outPath, JSON.stringify(doc));

    const result = AtifWriter.validate(outPath);
    assert.equal(result.ok, false);
    assert.ok(result.errors.length > 0, 'expected validation errors');
    assert.match(result.errors[0], /step order broken/);
  });

  it('fails validation when an observation references an unknown tool_call_id', () => {
    const dir = mkdtempSync(join(tmpdir(), 'atif-'));
    const outPath = join(dir, 'dangling.json');
    AtifWriter.fromEvents(sampleEvents()).finalize(outPath);

    const doc = JSON.parse(readFileSync(outPath, 'utf8')) as AtifTrajectory;
    doc.steps[1].observation.results[0].source_call_id = 'call_missing';
    writeFileSync(outPath, JSON.stringify(doc));

    const result = AtifWriter.validate(outPath);
    assert.equal(result.ok, false);
    assert.ok(
      result.errors.some((e) => e.includes('unknown tool_call_id')),
      `expected dangling-ref error, got: ${JSON.stringify(result.errors)}`,
    );
  });
});
