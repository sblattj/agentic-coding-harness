import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, it } from 'node:test';
import type { AgentEvent, CanonicalTokenRecord } from '../src/core/types.ts';
import { deriveLatency, deriveRunObservability, hasLatency } from '../src/web/derive.ts';
import { formatLatencyLines } from '../src/cli/lib.ts';

// Issue #32: TTFT, throughput/TPOT and per-tool durations derived from
// synthetic event logs; unmeasurable intervals are null/absent, never NaN.

const T0 = 1_700_000_000_000;
const usage = (outputTokens: number): CanonicalTokenRecord => ({
  inputTokens: 10,
  outputTokens,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
});

/** Two model calls; call 1 streams text at +200 and ends at +1200 with 500 output tokens. */
const EVENTS: AgentEvent[] = [
  { type: 'session_start', timestamp: T0 },
  { type: 'model_call_start', callId: 'c1', model: 'm', timestamp: T0 + 100 },
  { type: 'message', source: 'agent', content: 'hi', timestamp: T0 + 300 },
  { type: 'model_call_end', callId: 'c1', model: 'm', usage: usage(500), timestamp: T0 + 1_300 },
  { type: 'tool_call', toolCallId: 't1', functionName: 'bash', arguments: 'ls', timestamp: T0 + 1_400 },
  { type: 'tool_result', toolCallId: 't1', content: 'ok', timestamp: T0 + 1_500 },
  { type: 'tool_call', toolCallId: 't2', functionName: 'bash', arguments: 'make', timestamp: T0 + 1_600 },
  { type: 'tool_result', toolCallId: 't2', content: 'boom', isError: true, timestamp: T0 + 1_900 },
  { type: 'tool_call', toolCallId: 't3', functionName: 'read', arguments: 'a', timestamp: T0 + 2_000 },
  { type: 'tool_result', toolCallId: 't3', content: 'x', timestamp: T0 + 2_050 },
  { type: 'model_call_start', callId: 'c2', model: 'm', timestamp: T0 + 2_100 },
  { type: 'tool_call', toolCallId: 't4', functionName: 'read', arguments: 'b', timestamp: T0 + 2_500 },
  { type: 'tool_result', toolCallId: 't4', content: 'y', timestamp: T0 + 2_550 },
  { type: 'model_call_end', callId: 'c2', model: 'm', usage: usage(100), timestamp: T0 + 3_100 },
  { type: 'done', timestamp: T0 + 3_200 },
];

describe('deriveLatency (#32)', () => {
  it('computes TTFT, e2e, pooled throughput/TPOT and per-tool rows', () => {
    const l = deriveLatency(EVENTS);
    // TTFT: c1 200ms (message), c2 400ms (tool_call is the first output)
    assert.deepEqual(l.ttft, { count: 2, totalMs: 600, avgMs: 300, p50Ms: 200, p95Ms: 400, maxMs: 400 });
    assert.deepEqual(l.modelCalls, { count: 2, totalMs: 2_200, avgMs: 1_100, p50Ms: 1_000, p95Ms: 1_200, maxMs: 1_200 });
    // post-TTFT windows: c1 1000ms/500 tok, c2 600ms/100 tok -> 600 tok / 1.6 s
    assert.equal(l.outputTokensPerSec, 375);
    assert.equal(l.tpotMs, 1_600 / 600);
    assert.deepEqual(l.tools, [
      { name: 'bash', count: 2, totalMs: 400, avgMs: 200, p50Ms: 100, p95Ms: 300, maxMs: 300, errors: 1 },
      { name: 'read', count: 2, totalMs: 100, avgMs: 50, p50Ms: 50, p95Ms: 50, maxMs: 50, errors: 0 },
    ]);
    assert.equal(hasLatency(l), true);
  });

  it('adapter-style log (no model_call_*): tools measured, TTFT/throughput null', () => {
    const l = deriveLatency([
      { type: 'message', source: 'agent', content: 'x', timestamp: T0 },
      { type: 'tool_call', toolCallId: 'a', functionName: 'Bash', timestamp: T0 + 10 },
      { type: 'tool_result', toolCallId: 'a', content: 'ok', timestamp: T0 + 260 },
      { type: 'usage', usage: usage(50), timestamp: T0 + 300 },
    ]);
    assert.equal(l.ttft, null);
    assert.equal(l.modelCalls, null);
    assert.equal(l.outputTokensPerSec, null);
    assert.equal(l.tpotMs, null);
    assert.equal(l.tools.length, 1);
    assert.equal(l.tools[0]!.totalMs, 250);
  });

  it('no timestamps -> every metric null/empty, never 0 or NaN', () => {
    const noTs = EVENTS.map((e) => ({ ...e, timestamp: undefined })) as AgentEvent[];
    const l = deriveLatency(noTs);
    assert.deepEqual(l, { ttft: null, modelCalls: null, outputTokensPerSec: null, tpotMs: null, tools: [] });
    assert.equal(hasLatency(l), false);
    assert.doesNotMatch(JSON.stringify(deriveRunObservability(noTs)), /NaN|Infinity/);
  });

  it('unclosed model call and unanswered tool call are not measured', () => {
    const l = deriveLatency([
      { type: 'model_call_start', callId: 'c', timestamp: T0 },
      { type: 'message', source: 'agent', content: 'x', timestamp: T0 + 50 },
      { type: 'tool_call', toolCallId: 't', functionName: 'bash', timestamp: T0 + 60 },
      { type: 'done', timestamp: T0 + 5_000 },
    ]);
    assert.equal(l.ttft, null);
    assert.equal(l.modelCalls, null);
    assert.deepEqual(l.tools, []);
  });

  it('negative deltas are skipped; zero output tokens -> throughput null', () => {
    const l = deriveLatency([
      { type: 'model_call_start', callId: 'c', timestamp: T0 + 1_000 },
      { type: 'model_call_end', callId: 'c', usage: usage(10), timestamp: T0 },
      { type: 'model_call_start', callId: 'd', timestamp: T0 },
      { type: 'message', source: 'agent', content: 'x', timestamp: T0 + 100 },
      { type: 'model_call_end', callId: 'd', usage: usage(0), timestamp: T0 + 400 },
      { type: 'tool_call', toolCallId: 't', functionName: 'bash', timestamp: T0 + 900 },
      { type: 'tool_result', toolCallId: 't', content: 'x', timestamp: T0 + 800 },
    ]);
    assert.equal(l.modelCalls?.count, 1);
    assert.equal(l.ttft?.avgMs, 100);
    assert.equal(l.outputTokensPerSec, null);
    assert.equal(l.tpotMs, null);
    assert.deepEqual(l.tools, []);
  });

  it('usage tagged with the open call id supplies output tokens when the end carries none', () => {
    const l = deriveLatency([
      { type: 'model_call_start', callId: 'c', timestamp: T0 },
      { type: 'message', source: 'assistant', content: 'x', timestamp: T0 + 100 },
      { type: 'usage', callId: 'c', usage: usage(200), timestamp: T0 + 1_000 },
      { type: 'model_call_end', callId: 'c', timestamp: T0 + 1_100 },
    ]);
    assert.equal(l.outputTokensPerSec, 200);
    assert.equal(l.tpotMs, 5);
  });

  it('codex-style repeated results for one id: the last result closes the call', () => {
    const l = deriveLatency([
      { type: 'tool_call', toolCallId: 'x', functionName: 'shell', timestamp: T0 },
      { type: 'tool_result', toolCallId: 'x', content: 'partial', timestamp: T0 + 100 },
      { type: 'tool_result', toolCallId: 'x', content: 'done', isError: true, timestamp: T0 + 900 },
    ]);
    assert.equal(l.tools.length, 1);
    assert.equal(l.tools[0]!.count, 1);
    assert.equal(l.tools[0]!.maxMs, 900);
    assert.equal(l.tools[0]!.errors, 1);
  });

  it('deriveRunObservability carries latency only when the run has events', () => {
    assert.equal(deriveRunObservability([]).latency, undefined);
    assert.equal(deriveRunObservability(EVENTS).latency?.ttft?.count, 2);
  });
});

describe('formatLatencyLines (ach run summary)', () => {
  it('renders measured metrics and omits unmeasurable ones', () => {
    const lines = formatLatencyLines(deriveLatency(EVENTS));
    assert.deepEqual(lines, [
      'ttft       avg 300ms · p50 200ms · p95 400ms (2 calls)',
      'throughput 375.0 tok/s · tpot 2.7ms',
      'tools      bash 2× avg 200ms max 300ms · read 2× avg 50ms max 50ms',
    ]);
    const toolsOnly = formatLatencyLines(deriveLatency(EVENTS.filter((e) => !String(e.type).startsWith('model_call'))));
    assert.equal(toolsOnly.length, 1);
    assert.match(toolsOnly[0]!, /^tools /);
    assert.deepEqual(formatLatencyLines(deriveLatency([])), []);
    assert.deepEqual(formatLatencyLines(undefined), []);
  });
});

// Execute the shipped trio renderMetrics with a minimal DOM surface.
describe('trio metrics cards (#32)', () => {
  const html = readFileSync(new URL('../src/web/trio.html', import.meta.url), 'utf8');
  const start = html.indexOf('function renderMetrics()');
  const end = html.indexOf('/* crosshair */');
  assert.ok(start > 0 && end > start, 'renderMetrics block not found in trio.html');
  const renderer = html.slice(start, end);

  interface Node { tag: string; className: string; textContent: string; title?: string; children: Node[]; appendChild(n: Node): void }
  const render = (obs: unknown): string => {
    const nodes: Record<string, Node> = {};
    const mk = (tag: string, cls?: string | null, text?: string | null): Node => ({
      tag,
      className: cls ?? '',
      textContent: text ?? '',
      children: [],
      appendChild(n) { this.children.push(n); },
    });
    const ctx = {
      obs,
      rec: null,
      $: (id: string) => (nodes[id] ??= mk('div')),
      el: mk,
      K: (n: number) => String(n),
      S: (ms: number) => ((ms || 0) / 1000).toFixed(1) + 's',
      USD: () => 'n/a',
      observedCost: () => null,
      fmtDurMs: (ms: number) => (ms < 1000 ? Math.round(ms) + 'ms' : (ms / 1000).toFixed(2) + 's'),
      drawChart: () => {},
    };
    runInNewContext(renderer + '\nrenderMetrics();', ctx);
    const text = (n: Node): string => [n.textContent, ...n.children.map(text)].join(' ');
    return Object.values(nodes).map(text).join(' ');
  };

  it('shows ttft / tok/s / tpot cards and a per-tool breakdown', () => {
    const out = render(deriveRunObservability(EVENTS));
    assert.match(out, /ttft\s+300ms/);
    assert.match(out, /tok\/s\s+375\.0/);
    assert.match(out, /tpot\s+2\.7ms/);
    assert.match(out, /bash\s+2×\s+avg 200ms\s+p95 300ms\s+Σ 400ms/);
    assert.doesNotMatch(out, /NaN|Infinity|undefined/);
  });

  it('falls back to n/a without model-call timestamps and never renders NaN', () => {
    const noTs = EVENTS.map((e) => ({ ...e, timestamp: undefined })) as AgentEvent[];
    for (const obs of [deriveRunObservability(noTs), deriveRunObservability([]), null]) {
      const out = render(obs);
      assert.doesNotMatch(out, /NaN|Infinity|undefined/);
    }
    assert.match(render(deriveRunObservability(noTs)), /ttft\s+n\/a/);
  });
});
