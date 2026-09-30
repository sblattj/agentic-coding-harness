// Per-frame context annotation for the web feed (src/web/context-frames.ts).
//
// Sequences mirror the persisted claude transcript shape (see
// <stateDir>/raw/claude-*.jsonl): one `message` per content block, each
// repeating the model call's usage, then tool_call/tool_result rows, then the
// run-aggregate `usage` row. Windows come from the bundled LiteLLM table
// (claude-sonnet-4-5 → 200k, the same fixture model tests/context-meter.test.ts pins).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createFrameAnnotator, type ContextFrame } from '../src/web/context-frames.ts';
import { CONTEXT_WARN_FRACTION, createContextMeter, lookupContextWindow } from '../src/core/context-meter.ts';
import type { AgentEvent } from '../src/core/types.ts';

const MODEL = 'claude-sonnet-4-5';

function usage(model: string, input: number, cacheRead = 0, cacheWrite = 0, output = 5) {
  return { agent: 'claude', model, inputTokens: input, outputTokens: output, cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite };
}

function msg(content: string, u: ReturnType<typeof usage>): AgentEvent {
  return { type: 'message', agent: 'claude', source: 'agent', model: u.model, content, usage: u } as unknown as AgentEvent;
}

function toolCall(id: string): AgentEvent {
  return { type: 'tool_call', agent: 'claude', toolCallId: id, functionName: 'Bash', arguments: { command: 'ls' } } as unknown as AgentEvent;
}

function toolResult(id: string): AgentEvent {
  return { type: 'tool_result', agent: 'claude', toolCallId: id, content: 'a\nb' } as unknown as AgentEvent;
}

function run(agent: string, events: AgentEvent[]): (ContextFrame | undefined)[] {
  const a = createFrameAnnotator({ agent });
  assert.ok(a, `annotator for ${agent}`);
  return events.map((e) => a.annotate(e));
}

describe('context frame annotator', () => {
  it('claude: carries the last model call across tool events, deltas on growth, window from the table', () => {
    assert.equal(lookupContextWindow(MODEL), 200_000, 'fixture model window (bundled table)');
    const call1 = usage(MODEL, 10, 0, 18_390); // 18,400
    const call2 = usage(MODEL, 4, 18_390, 31_606); // 50,000
    const frames = run('claude', [
      { type: 'step', agent: 'claude', data: { model: MODEL } } as unknown as AgentEvent,
      msg('', call1), // empty first block: same call, not rendered by the feed
      msg('Reading the repo.', { ...call1 }),
      toolCall('t1'),
      toolResult('t1'),
      msg('Found it.', call2),
      toolCall('t2'),
      toolResult('t2'),
      { type: 'usage', agent: 'claude', usage: usage(MODEL, 999, 999_999, 999) } as unknown as AgentEvent, // run aggregate
    ]);

    assert.equal(frames[0], undefined, 'no gauge before the first usage');

    const f1 = frames[1]!;
    assert.equal(f1.tokens, 18_400);
    assert.equal(f1.window, 200_000);
    assert.equal(f1.pct, 9.2);
    assert.equal(f1.warnAt, CONTEXT_WARN_FRACTION);
    assert.equal(f1.basis, 'last-call');
    assert.equal(f1.fresh, true);
    assert.equal(f1.delta, 18_400, 'the first reading counts from 0');
    assert.equal(f1.seq, 1);
    assert.deepEqual([f1.input, f1.cacheRead, f1.cacheWrite], [10, 0, 18_390]);
    assert.equal(f1.model, MODEL);

    // the second content block of the SAME call: fresh, same reading, same delta
    const f2 = frames[2]!;
    assert.equal(f2.fresh, true);
    assert.equal(f2.seq, 1);
    assert.equal(f2.delta, 18_400);

    // tool rows carry the reading forward, stale, with no breakdown or delta
    for (const i of [3, 4]) {
      const t = frames[i]!;
      assert.equal(t.tokens, 18_400, `frame ${i}`);
      assert.equal(t.fresh, false, `frame ${i}`);
      assert.equal(t.seq, 1, `frame ${i}`);
      assert.equal(t.delta, 18_400, 'the reading\'s delta rides every frame of it');
      assert.equal(t.input, undefined);
      assert.equal(t.pct, 9.2);
    }

    const f5 = frames[5]!;
    assert.equal(f5.tokens, 50_000);
    assert.equal(f5.pct, 25);
    assert.equal(f5.fresh, true);
    assert.equal(f5.seq, 2);
    assert.equal(f5.delta, 50_000 - 18_400);

    assert.equal(frames[6]!.fresh, false);
    assert.equal(frames[7]!.tokens, 50_000);

    // claude's run-aggregate usage never replaces the per-call reading
    const agg = frames[8]!;
    assert.equal(agg.tokens, 50_000);
    assert.equal(agg.basis, 'last-call');
    assert.equal(agg.fresh, false);
    assert.equal(agg.input, undefined, 'the aggregate breakdown must not leak into the tooltip');
  });

  it("claude's <synthetic> messages (CLI-written, all-zero usage) are not a model call", () => {
    // Real shape: raw/claude-claude-fbd8f32c-….jsonl line 103, "Credit balance is too low".
    const synthetic = usage('<synthetic>', 0, 0, 0, 0);
    const a = createFrameAnnotator({ agent: 'claude' })!;
    const f0 = a.annotate(msg('working', usage(MODEL, 7, 160_000, 7_531)))!;
    const f1 = a.annotate(msg('Credit balance is too low', synthetic))!;
    assert.equal(f0.tokens, 167_538);
    assert.equal(f1.tokens, 167_538, 'the reading is carried, not reset to 0');
    assert.equal(f1.fresh, false);
    assert.equal(f1.window, 200_000, 'the window stays known: <synthetic> never becomes the model');
    const meter = createContextMeter({ agent: 'claude' })!;
    meter.observe(msg('working', usage(MODEL, 7, 160_000, 7_531)));
    meter.observe(msg('Credit balance is too low', synthetic));
    assert.equal(meter.snapshot()!.available, true);
    assert.equal(meter.snapshot()!.tokens, 167_538);
  });

  it('#59 chain framing is ignored and the ach.seal record is never a frame', () => {
    const chain = { v: 1, seq: 0, prev: 'p', hash: 'h' };
    const framed = { ach_chain: chain, ...(msg('hi', usage(MODEL, 10, 0, 49_990)) as object) } as unknown as AgentEvent;
    const seal = {
      ach_chain: { ...chain, seq: 2 }, type: 'ach.seal', runId: 'r', eventCount: 2, lastHash: 'x',
      totals: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 1, cacheWriteTokens: 1, costUsd: 0 }, totalsHash: 'y',
    } as unknown as AgentEvent;
    const frames = run('claude', [framed, toolCall('t'), seal]);
    assert.equal(frames[0]!.tokens, 50_000);
    assert.equal('ach_chain' in frames[0]!, false);
    assert.equal(frames[1]!.tokens, 50_000);
    assert.equal(frames[2], undefined, 'no gauge on the seal');
  });

  it('model_call_end (#32) alongside the message of the same call does not double count', () => {
    const call = usage(MODEL, 6, 18_398, 31_596); // 50,000
    const frames = run('claude', [
      { type: 'model_call_start', agent: 'claude' } as unknown as AgentEvent,
      msg('text', call),
      { type: 'model_call_end', agent: 'claude', model: MODEL, usage: { ...call } } as unknown as AgentEvent,
      toolCall('t'),
      { type: 'usage', agent: 'claude', usage: usage(MODEL, 50_000, 50_000, 50_000) } as unknown as AgentEvent,
    ]);
    assert.equal(frames[0], undefined);
    assert.equal(frames[1]!.tokens, 50_000);
    assert.equal(frames[2]!.tokens, 50_000, 'occupancy is the latest call, never a sum');
    assert.equal(frames[2]!.seq, 1, 'same reading, no second +Δ');
    assert.equal(frames[3]!.tokens, 50_000);
    assert.equal(frames[4]!.tokens, 50_000, 'the run aggregate does not displace the per-call reading');
  });

  it('adapter-emitted boundaries (#32: outputTokens, no usage) are carried-forward frames with no +Δ', () => {
    const a = usage(MODEL, 6, 18_398, 31_596); // 50,000
    const b = usage(MODEL, 2, 60, 51_938); // 52,000
    const start = (id: string) => ({ type: 'model_call_start', agent: 'claude', callId: id, model: MODEL }) as unknown as AgentEvent;
    const end = (id: string, out: number) =>
      ({ type: 'model_call_end', agent: 'claude', callId: id, model: MODEL, outputTokens: out }) as unknown as AgentEvent;
    const withBounds = run('claude', [start('A'), msg('a1', a), msg('a2', a), end('A', 40), start('B'), msg('b', b), end('B', 90)]);
    const without = run('claude', [msg('a1', a), msg('a2', a), msg('b', b)]);
    assert.equal(withBounds[0], undefined, 'no reading before the first usage');
    for (const i of [3, 4, 6]) {
      assert.equal(withBounds[i]!.fresh, false, `boundary frame ${i} never feeds a reading`);
    }
    assert.equal(withBounds[3]!.seq, 1);
    assert.equal(withBounds[4]!.seq, 1, 'the next call start shows the previous reading, no new seq');
    assert.equal(withBounds[6]!.seq, 2);
    assert.equal(withBounds[6]!.delta, 2_000, 'the +Δ rides the reading, not a second one for the end');
    // The message frames are identical with and without the boundaries.
    assert.deepEqual([withBounds[1], withBounds[2], withBounds[5]], without);
  });

  it('a shrinking reading reports a negative delta', () => {
    const frames = run('claude', [msg('a', usage(MODEL, 0, 0, 150_000)), msg('b', usage(MODEL, 0, 0, 20_000))]);
    assert.equal(frames[1]!.delta, -130_000);
    assert.equal(frames[1]!.seq, 2);
  });

  it('codex: a turn-total usage is fresh with basis turn-total (an upper bound)', () => {
    const a = createFrameAnnotator({ agent: 'codex', requestedModel: 'gpt-5-codex' })!;
    const f = a.annotate({ type: 'usage', agent: 'codex', usage: usage('unknown', 30_000) } as unknown as AgentEvent)!;
    assert.equal(f.basis, 'turn-total');
    assert.equal(f.fresh, true);
    assert.equal(f.tokens, 30_000);
    assert.equal(typeof f.window, 'number', 'gpt-5-codex is in the bundled table');
    assert.equal(f.window, lookupContextWindow('gpt-5-codex'));
  });

  it('unmetered agents get no annotator (no field on any event)', () => {
    assert.equal(createFrameAnnotator({ agent: 'kiro' }), null);
    assert.equal(createFrameAnnotator({ agent: 'my-custom-agent' }), null);
    assert.equal(createFrameAnnotator({ agent: undefined }), null);
  });

  it('unknown model: tokens only, no window, no pct', () => {
    const frames = run('claude', [msg('hi', usage('claude-nonesuch-9', 18_000, 0, 400)), toolCall('t')]);
    const f = frames[0]!;
    assert.equal(f.tokens, 18_400);
    assert.equal(f.window, undefined);
    assert.equal(f.pct, undefined);
    assert.equal(f.warnAt, undefined);
    assert.equal(f.fresh, true);
    assert.equal(frames[1]!.tokens, 18_400);
    assert.equal(frames[1]!.fresh, false);
  });
});
