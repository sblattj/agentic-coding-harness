import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { emitToLangfuse, toLangfuseOtlpJson } from '../src/emitters/langfuse.js';
import type { OtlpSpanJson } from '../src/emitters/otel.js';
import type { AgentEvent } from '../src/core/types.js';

const T0 = Date.parse('2026-09-10T12:00:00Z');

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
        model: 'test-model-2',
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
  const value = span.attributes.find((a) => a.key === key)?.value.stringValue;
  return typeof value === 'string' ? value : undefined;
}

describe('toLangfuseOtlpJson', () => {
  const doc = toLangfuseOtlpJson(sampleEvents(), opts);
  const spans = doc.resourceSpans[0].scopeSpans[0].spans;

  it('keeps the gen_ai span tree and adds langfuse observation types', () => {
    assert.deepEqual(
      spans.map((s) => s.name),
      ['invoke_agent harness-agent', 'execute_tool get_weather', 'chat test-model'],
    );
    assert.equal(attr(findSpan(spans, 'invoke_agent harness-agent'), 'langfuse.observation.type'), 'span');
    assert.equal(attr(findSpan(spans, 'chat test-model'), 'langfuse.observation.type'), 'generation');
    assert.equal(attr(findSpan(spans, 'execute_tool get_weather'), 'langfuse.observation.type'), 'span');
  });

  it('propagates langfuse.session.id to every span and names the trace', () => {
    for (const span of spans) {
      assert.equal(attr(span, 'langfuse.session.id'), 'sess-42', `span ${span.name} missing session id`);
    }
    assert.equal(attr(findSpan(spans, 'invoke_agent harness-agent'), 'langfuse.trace.name'), 'invoke_agent harness-agent');
  });

  it('maps usage to mutually-exclusive langfuse usage_details buckets', () => {
    const chat = findSpan(spans, 'chat test-model');
    const raw = attr(chat, 'langfuse.observation.usage_details');
    assert.ok(raw, 'usage_details attribute missing');
    const details = JSON.parse(raw as string) as Record<string, number>;
    // input excludes cache slices (prompt 3210 = 3050 + 128 + 32 -> 3050)
    assert.deepEqual(details, {
      input: 3050,
      output: 45,
      cache_read_input_tokens: 128,
      cache_creation_input_tokens: 32,
    });
    const sum = Object.values(details).reduce((a, b) => a + b, 0);
    assert.equal(sum, 3255); // every token counted exactly once
  });

  it('sets model from the usage record and cost_details when costUsd is present', () => {
    const chat = findSpan(spans, 'chat test-model');
    assert.equal(attr(chat, 'langfuse.observation.model.name'), 'test-model-2');
    assert.deepEqual(JSON.parse(attr(chat, 'langfuse.observation.cost_details') as string), {
      total: 0.0012,
    });
  });

  it('omits cost_details when no costUsd is present', () => {
    const events: AgentEvent[] = [
      {
        type: 'usage',
        usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 },
        timestamp: T0,
      },
    ];
    const chat = toLangfuseOtlpJson(events, opts).resourceSpans[0].scopeSpans[0].spans.find(
      (s) => attr(s, 'langfuse.observation.type') === 'generation',
    );
    assert.ok(chat, 'generation span missing');
    assert.equal(attr(chat, 'langfuse.observation.usage_details'), '{"input":10,"output":5}');
    assert.equal(attr(chat, 'langfuse.observation.cost_details'), undefined);
  });

  it('subtracts cache slices from legacy promptTokens aliases too', () => {
    const events: AgentEvent[] = [
      {
        type: 'usage',
        // legacy: prompt 1000 includes 600 cache-read + 200 cache-write
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          promptTokens: 1000,
          completionTokens: 40,
          cachedTokens: 600,
          cacheWriteTokens: 200,
        },
        timestamp: T0,
      },
    ];
    const chat = toLangfuseOtlpJson(events, opts).resourceSpans[0].scopeSpans[0].spans.find(
      (s) => attr(s, 'langfuse.observation.type') === 'generation',
    );
    assert.ok(chat);
    assert.deepEqual(JSON.parse(attr(chat, 'langfuse.observation.usage_details') as string), {
      input: 200,
      output: 40,
      cache_read_input_tokens: 600,
      cache_creation_input_tokens: 200,
    });
  });
});

describe('toLangfuseOtlpJson multi-model slice split', () => {
  const multiModelEvents = (): AgentEvent[] => [
    { type: 'message', source: 'user', content: 'go', timestamp: T0 },
    {
      type: 'usage',
      usage: {
        inputTokens: 989,
        outputTokens: 478,
        cacheReadTokens: 58791,
        cacheWriteTokens: 6369,
        reasoningTokens: 0,
        costUsd: 0.08191275,
        model: 'claude-opus-5[1m]',
        extra: {
          raw: {
            input: 989,
            output: 478,
            cacheRead: 58791,
            cacheWrite: 6369,
            reasoning: 0,
            costUsd: 0.08191275,
            models: [
              {
                model: 'claude-opus-5[1m]',
                input: 8,
                output: 465,
                cacheRead: 58791,
                cacheWrite: 6369,
                reasoning: 0,
                costUsd: 0.08086675,
              },
              {
                model: 'claude-haiku-4-5-20251001',
                input: 981,
                output: 13,
                cacheRead: 0,
                cacheWrite: 0,
                reasoning: 0,
                costUsd: 0.001046,
              },
            ],
          },
        },
      },
      timestamp: T0 + 100,
    },
  ];

  it('replaces one flattened chat span with one generation per slice', () => {
    const spans = toLangfuseOtlpJson(multiModelEvents(), opts).resourceSpans[0].scopeSpans[0].spans;
    const names = spans.map((s) => s.name);
    assert.deepEqual(names, [
      'invoke_agent harness-agent',
      'chat claude-opus-5[1m]',
      'chat claude-haiku-4-5-20251001',
    ]);
    const generations = spans.filter((s) => attr(s, 'langfuse.observation.type') === 'generation');
    assert.equal(generations.length, 2);
    // root span id is the parent for both
    const root = findSpan(spans, 'invoke_agent harness-agent');
    for (const g of generations) {
      assert.equal(g.parentSpanId, root.spanId);
      assert.equal(g.traceId, root.traceId);
      assert.equal(attr(g, 'langfuse.session.id'), 'sess-42');
    }
  });

  it('each slice carries its own model name, exclusive usage buckets, and cost', () => {
    const spans = toLangfuseOtlpJson(multiModelEvents(), opts).resourceSpans[0].scopeSpans[0].spans;
    const opus = findSpan(spans, 'chat claude-opus-5[1m]');
    assert.equal(attr(opus, 'langfuse.observation.model.name'), 'claude-opus-5[1m]');
    assert.deepEqual(JSON.parse(attr(opus, 'langfuse.observation.usage_details') as string), {
      input: 8,
      output: 465,
      cache_read_input_tokens: 58791,
      cache_creation_input_tokens: 6369,
    });
    assert.deepEqual(JSON.parse(attr(opus, 'langfuse.observation.cost_details') as string), {
      total: 0.080867,
    });

    const haiku = findSpan(spans, 'chat claude-haiku-4-5-20251001');
    assert.equal(attr(haiku, 'langfuse.observation.model.name'), 'claude-haiku-4-5-20251001');
    assert.deepEqual(JSON.parse(attr(haiku, 'langfuse.observation.usage_details') as string), {
      input: 981,
      output: 13,
    });
    assert.deepEqual(JSON.parse(attr(haiku, 'langfuse.observation.cost_details') as string), {
      total: 0.001046,
    });
  });

  it('slice totals add up to the flattened record total (no double count, no loss)', () => {
    const spans = toLangfuseOtlpJson(multiModelEvents(), opts).resourceSpans[0].scopeSpans[0].spans;
    const generations = spans.filter((s) => attr(s, 'langfuse.observation.type') === 'generation');
    const total = generations.reduce((acc, s) => {
      const c = JSON.parse(attr(s, 'langfuse.observation.cost_details') as string) as { total: number };
      return acc + c.total;
    }, 0);
    assert.equal(Math.round(total * 1e6) / 1e6, 0.081913); // == round6(0.08191275)
  });

  it('single-model events (1 slice) keep the original span shape', () => {
    const events: AgentEvent[] = [
      {
        type: 'usage',
        usage: {
          inputTokens: 10,
          outputTokens: 5,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          costUsd: 0.0001,
          model: 'solo-model',
          extra: {
            raw: {
              models: [
                { model: 'solo-model', input: 10, output: 5, cacheRead: 0, cacheWrite: 0, reasoning: 0, costUsd: 0.0001 },
              ],
            },
          },
        },
        timestamp: T0,
      },
    ];
    const spans = toLangfuseOtlpJson(events, opts).resourceSpans[0].scopeSpans[0].spans;
    const names = spans.map((s) => s.name);
    // 1 slice → no split; falls through to the flat chat span branch
    assert.deepEqual(names, ['invoke_agent harness-agent', 'chat test-model']);
  });
});

describe('emitToLangfuse', () => {
  function mockFetch(status: number, body = ''): typeof fetch & { calls: unknown[] } {
    const calls: unknown[] = [];
    const fn = (async (_url: unknown, init?: RequestInit) => {
      calls.push({ url: _url, init });
      return new Response(body, { status });
    }) as typeof fetch & { calls: unknown[] };
    fn.calls = calls;
    return fn;
  }

  const ingest = {
    baseUrl: 'http://lf.example.com/',
    publicKey: 'pk-lf-123',
    secretKey: 'sk-lf-456',
    ...opts,
  };

  it('POSTs OTLP JSON to /api/public/otel/v1/traces with Basic auth and ingestion-version 4', async () => {
    const fetchImpl = mockFetch(202);
    const result = await emitToLangfuse(sampleEvents(), { ...ingest, fetchImpl });
    assert.equal(result.ok, true);
    assert.equal(result.status, 202);
    assert.equal(result.url, 'http://lf.example.com/api/public/otel/v1/traces');

    assert.equal(fetchImpl.calls.length, 1);
    const { url, init } = fetchImpl.calls[0] as { url: string; init: RequestInit };
    assert.equal(url, result.url);
    const expectedAuth = Buffer.from('pk-lf-123:sk-lf-456').toString('base64');
    const headers = init.headers as Record<string, string>;
    assert.equal(headers.authorization, `Basic ${expectedAuth}`);
    assert.equal(headers['x-langfuse-ingestion-version'], '4');
    assert.equal(headers['content-type'], 'application/json');

    const payload = JSON.parse(init.body as string);
    const spans = payload.resourceSpans[0].scopeSpans[0].spans as OtlpSpanJson[];
    assert.equal(spans.length, 3);
    assert.match(result.traceId, /^[0-9a-f]{32}$/);
    assert.equal(spans[0].traceId, result.traceId);
    assert.equal(result.spanCount, 3);
  });

  it('reports non-2xx responses as not ok with status and body', async () => {
    const fetchImpl = mockFetch(401, '{"error":"invalid api key"}');
    const result = await emitToLangfuse(sampleEvents(), { ...ingest, fetchImpl });
    assert.equal(result.ok, false);
    assert.equal(result.status, 401);
    assert.equal(result.body, '{"error":"invalid api key"}');
  });
});
