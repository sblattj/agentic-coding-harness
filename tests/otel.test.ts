import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { toOtlpJson } from '../src/emitters/otel.js';
import type { OtlpSpanJson } from '../src/emitters/otel.js';
import type { AgentEvent } from '../src/core/types.js';

const T0 = Date.parse('2026-09-09T12:00:00Z');

function sampleEvents(): AgentEvent[] {
  return [
    { type: 'message', source: 'user', content: 'hi', timestamp: T0 },
    {
      type: 'tool_call',
      toolCallId: 'call_1',
      functionName: 'get_weather',
      arguments: { city: 'SF' },
      timestamp: T0 + 100,
    },
    { type: 'tool_result', toolCallId: 'call_1', content: 'sunny', timestamp: T0 + 200 },
    {
      type: 'usage',
      usage: {
        inputTokens: 3050,
        outputTokens: 45,
        cacheReadTokens: 128,
        cacheWriteTokens: 32,
        reasoningTokens: 12,
        costUsd: 0.0012,
      },
      timestamp: T0 + 250,
    },
    { type: 'message', source: 'agent', content: 'sunny!', timestamp: T0 + 300 },
  ];
}

const opts = { sessionId: 'sess-42', agentName: 'harness-agent', model: 'test-model' };

function findSpan(spans: OtlpSpanJson[], name: string): OtlpSpanJson {
  const span = spans.find((s) => s.name === name);
  assert.ok(span, `span "${name}" not found`);
  return span;
}

function attr(span: OtlpSpanJson, key: string): string | undefined {
  const found = span.attributes.find((a) => a.key === key);
  if (!found) return undefined;
  return (found.value.intValue ?? found.value.stringValue) as string | undefined;
}

describe('toOtlpJson', () => {
  const json = toOtlpJson(sampleEvents(), opts);
  const spans = json.resourceSpans[0].scopeSpans[0].spans;

  it('emits one resource span scope with root + tool + chat spans', () => {
    assert.equal(json.resourceSpans.length, 1);
    assert.deepEqual(json.resourceSpans[0].resource.attributes, [
      { key: 'service.name', value: { stringValue: 'agent-harness' } },
    ]);
    assert.deepEqual(spans.map((s) => s.name), [
      'invoke_agent harness-agent',
      'execute_tool get_weather',
      'chat test-model',
    ]);
  });

  it('uses correct span kinds', () => {
    assert.equal(findSpan(spans, 'invoke_agent harness-agent').kind, 'SPAN_KIND_CLIENT');
    assert.equal(findSpan(spans, 'chat test-model').kind, 'SPAN_KIND_CLIENT');
    assert.equal(findSpan(spans, 'execute_tool get_weather').kind, 'SPAN_KIND_INTERNAL');
  });

  it('carries gen_ai agent/conversation attributes on the root span', () => {
    const root = findSpan(spans, 'invoke_agent harness-agent');
    assert.equal(attr(root, 'gen_ai.operation.name'), 'invoke_agent');
    assert.equal(attr(root, 'gen_ai.agent.name'), 'harness-agent');
    assert.equal(attr(root, 'gen_ai.conversation.id'), 'sess-42');
    assert.equal(attr(root, 'gen_ai.request.model'), 'test-model');
  });

  it('reports gen_ai.usage.input_tokens with the correct value', () => {
    const chat = findSpan(spans, 'chat test-model');
    assert.equal(attr(chat, 'gen_ai.usage.input_tokens'), '3210');
    assert.equal(attr(chat, 'gen_ai.usage.output_tokens'), '45');
    assert.equal(attr(chat, 'gen_ai.usage.cache_read.input_tokens'), '128');
    assert.equal(attr(chat, 'gen_ai.usage.cache_write.input_tokens'), '32');
    assert.equal(attr(chat, 'gen_ai.usage.reasoning.output_tokens'), '12');
  });

  it('parents chat/tool spans to the root and derives timestamps from events', () => {
    const root = findSpan(spans, 'invoke_agent harness-agent');
    const chat = findSpan(spans, 'chat test-model');
    const tool = findSpan(spans, 'execute_tool get_weather');

    assert.equal(chat.parentSpanId, root.spanId);
    assert.equal(tool.parentSpanId, root.spanId);
    for (const span of spans) {
      assert.match(span.startTimeUnixNano, /^\d+$/);
      assert.match(span.endTimeUnixNano, /^\d+$/);
      assert.ok(
        BigInt(span.endTimeUnixNano) >= BigInt(span.startTimeUnixNano),
        `span ${span.name} ends before it starts`,
      );
    }
    assert.equal(chat.startTimeUnixNano, (BigInt(T0 + 250) * 1_000_000n).toString());
    assert.equal(tool.endTimeUnixNano, (BigInt(T0 + 200) * 1_000_000n).toString());
  });
});
