import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { AgentEvent } from '../src/core/types.ts';
import { EventQueue } from '../src/interactive/claude-tui.ts';

// #197: the interactive adapter's event queue releases what the driver has
// consumed, so a long session's memory tracks the unconsumed window, not the
// whole transcript.

const ev = (i: number): AgentEvent => ({ type: 'message', agent: 'claude', role: 'assistant', content: `m${i} ${'x'.repeat(64)}`, timestamp: i }) as unknown as AgentEvent;
const idx = (e: AgentEvent) => (e as { timestamp: number }).timestamp;

describe('claude-tui EventQueue (#197)', () => {
  it('keeps retained slots bounded while a consumer drains N events', async () => {
    const q = new EventQueue();
    const it = q.attach()[Symbol.asyncIterator]();
    const N = 10_000;
    let maxCapacity = 0;
    for (let i = 0; i < N; i++) {
      q.push(ev(i));
      const r = await it.next();
      assert.equal(idx(r.value as AgentEvent), i);
      maxCapacity = Math.max(maxCapacity, q.capacity);
    }
    assert.equal(q.retained, 0);
    assert.ok(maxCapacity <= 2, `capacity grew to ${maxCapacity}`);
    q.close();
    assert.equal((await it.next()).done, true);
  });

  it('compacts a large burst as it is consumed and frees yielded payloads', async () => {
    const q = new EventQueue();
    const N = 5_000;
    for (let i = 0; i < N; i++) q.push(ev(i));
    const it = q.attach()[Symbol.asyncIterator]();
    let maxCapacityLate = 0;
    for (let i = 0; i < N; i++) {
      assert.equal(idx((await it.next()).value as AgentEvent), i);
      if (i >= N / 2) maxCapacityLate = Math.max(maxCapacityLate, q.capacity);
      assert.equal(q.retained, N - i - 1);
    }
    assert.ok(maxCapacityLate < N, `burst never compacted (capacity ${maxCapacityLate})`);
    assert.equal(q.capacity, 0);
  });

  it('delivers every event once, in order, across interleaved pushes and compactions', async () => {
    const q = new EventQueue();
    q.push(ev(0)); // pushed before attach, like session_start
    const seen: number[] = [];
    const consumer = (async () => {
      for await (const e of q.attach()) seen.push(idx(e));
    })();
    let n = 1;
    for (let round = 0; round < 40; round++) {
      const burst = 1 + ((round * 977) % 1500);
      for (let k = 0; k < burst; k++) q.push(ev(n++));
      if (round % 3 === 0) await new Promise((r) => setImmediate(r));
    }
    q.close();
    await consumer;
    assert.equal(seen.length, n);
    for (let i = 0; i < n; i++) assert.equal(seen[i], i);
    assert.equal(q.retained, 0);
  });
});
