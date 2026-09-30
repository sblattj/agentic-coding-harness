// Issue #32: the claude adapter emits model_call_start / model_call_end from
// its stream-json (message.id brackets one API response; the init line and
// tool_result lines mark request starts), so RunRecord.latency gets real TTFT
// and throughput. The boundaries must not move any usage total.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, it } from 'node:test';
import { ClaudeCodeAdapter, type HarnessChildProcess, type SpawnFn } from '../src/adapters/claude.ts';
import { createDriver } from '../src/core/driver.ts';
import { deriveLatency } from '../src/core/latency.ts';
import { listRunRecords } from '../src/core/registry.ts';
import type { AgentAdapter, AgentEvent, AgentHandle, RunSpec } from '../src/core/types.ts';
import { deriveMetrics, deriveModelCache } from '../src/web/derive.ts';

const LINES = readFileSync(new URL('./fixtures/claude/multi-turn-latency.ndjson', import.meta.url), 'utf8')
  .trim()
  .split('\n');
const DUP_LINES = readFileSync(new URL('./fixtures/claude/duplicate-result.ndjson', import.meta.url), 'utf8')
  .trim()
  .split('\n');

/** Gap between replayed lines: well above Date.now() resolution. */
const GAP_MS = 25;

class FakeChild extends EventEmitter implements HarnessChildProcess {
  stdout: PassThrough = new PassThrough();
  stderr: PassThrough = new PassThrough();
  pid = 424250;
  kill(): boolean {
    queueMicrotask(() => this.emit('close', 143, null));
    return true;
  }
}

/** A spawn whose child writes one line every GAP_MS, then exits 0. */
function pacedSpawn(lines: string[]): SpawnFn {
  return () => {
    const child = new FakeChild();
    void (async () => {
      for (const line of lines) {
        await new Promise((r) => setTimeout(r, GAP_MS));
        child.stdout.write(line + '\n');
      }
      child.stdout.end();
      child.stderr.end();
      setImmediate(() => child.emit('close', 0, null));
    })();
    return child;
  };
}

type Ev = { type: string; [key: string]: unknown };

async function launchEvents(lines: string[]): Promise<Ev[]> {
  const stateDir = mkdtempSync(path.join(tmpdir(), 'ach-claude-calls-'));
  try {
    const adapter = new ClaudeCodeAdapter({ stateDir, spawnFn: pacedSpawn(lines) });
    const handle = await adapter.launch({ prompt: 'x' });
    const out: Ev[] = [];
    for await (const e of handle.attach()) out.push(e as Ev);
    await handle.wait();
    return out;
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
}

/** Strips the #32 boundaries: exactly the stream ce0a223 produced. */
class WithoutBoundaries implements AgentAdapter {
  readonly name = 'claude';
  constructor(private readonly inner: ClaudeCodeAdapter) {}
  get capabilities() {
    return this.inner.capabilities;
  }
  async launch(spec: RunSpec): Promise<AgentHandle> {
    const h = await this.inner.launch(spec);
    return {
      get sessionId() {
        return h.sessionId;
      },
      async *attach() {
        for await (const e of h.attach()) {
          if (e.type !== 'model_call_start' && e.type !== 'model_call_end') yield e;
        }
      },
      abort: () => h.abort(),
      wait: () => h.wait(),
    } as AgentHandle;
  }
}

async function driverRun(lines: string[], strip: boolean) {
  const stateDir = mkdtempSync(path.join(tmpdir(), 'ach-claude-calls-drv-'));
  const regDir = mkdtempSync(path.join(tmpdir(), 'ach-claude-calls-reg-'));
  try {
    const real = new ClaudeCodeAdapter({ stateDir, spawnFn: pacedSpawn(lines) });
    const adapter: AgentAdapter = strip ? new WithoutBoundaries(real) : real;
    const driver = createDriver({ adapters: { claude: adapter }, stateDir, registry: { stateDir: regDir } });
    const result = await driver.run('claude', { prompt: 'x' });
    const recs = listRunRecords(regDir);
    assert.equal(recs.length, 1);
    return { result, rec: recs[0]! };
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(regDir, { recursive: true, force: true });
  }
}

describe('claude model-call boundaries (#32)', () => {
  it('brackets each message.id: start at init / tool_result arrival, end at the last line of the id', async () => {
    const all = await launchEvents(LINES);
    assert.deepEqual(
      all.map((e) => e.type),
      [
        'step',
        'model_call_start', // msg_A, stamped at the init line
        'message',
        'message',
        'tool_call',
        'model_call_end', // msg_A closes when its tool result goes back
        'tool_result',
        'model_call_start', // msg_B, stamped at the tool_result line
        'message',
        'message',
        'model_call_end', // msg_B closes on the result line
        'usage',
      ],
    );
    const starts = all.filter((e) => e.type === 'model_call_start');
    const ends = all.filter((e) => e.type === 'model_call_end');
    assert.deepEqual(starts.map((e) => e.callId), ['msg_A', 'msg_B']);
    assert.deepEqual(ends.map((e) => e.callId), ['msg_A', 'msg_B']);
    assert.deepEqual(ends.map((e) => e.outputTokens), [40, 90]);
    assert.ok(ends.every((e) => e.usage === undefined), 'boundaries never carry summed usage');
    assert.ok(starts.every((e) => e.model === 'claude-sonnet-4-5-20250929'));

    const at = (i: number) => all[i]!.timestamp as number;
    // start A == init arrival; start B == tool_result arrival
    assert.equal(at(1), at(0));
    assert.equal(at(7), at(6));
    // end A == arrival of msg_A's LAST line (the tool_use block), not the tool_result
    assert.equal(at(5), at(3));
    assert.ok(at(6) > at(5));
    // end B == arrival of msg_B's second line
    assert.equal(at(10), at(9));
    // every boundary is causally ordered: start <= first output <= end
    assert.ok(at(1) < at(2) && at(2) < at(5));
    assert.ok(at(7) < at(8) && at(8) < at(10));
  });

  it('a response with no observed request start (sub-agent first call) gets no boundaries; its later calls do', async () => {
    const init = LINES[0]!;
    const sub = (id: string, text: string) =>
      JSON.stringify({
        type: 'assistant',
        message: { id, model: 'claude-haiku-4-5', content: [{ type: 'text', text }], usage: { input_tokens: 1, output_tokens: 7 } },
        parent_tool_use_id: 'toolu_task',
      });
    const subResult = JSON.stringify({
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_s1', content: 'ok' }] },
      parent_tool_use_id: 'toolu_task',
    });
    const all = await launchEvents([init, sub('msg_S1', 'a'), subResult, sub('msg_S2', 'b')]);
    const bounds = all.filter((e) => e.type.startsWith('model_call_')).map((e) => `${e.type}:${e.callId}`);
    // The main lane's init start is never consumed by a sub-agent line, and
    // msg_S2 has no end: the run closed with no result line (no fabricated end).
    assert.deepEqual(bounds, ['model_call_start:msg_S2']);
  });

  it('lines without message.id yield no boundaries (older CLIs)', async () => {
    const noId = LINES.map((l) => {
      const j = JSON.parse(l) as { type: string; message?: { id?: string } };
      if (j.message) delete j.message.id;
      return JSON.stringify(j);
    });
    const all = await launchEvents(noId);
    assert.equal(all.filter((e) => e.type.startsWith('model_call_')).length, 0);
  });

  it('driver: RunRecord.latency.ttft and throughput are non-null for the claude fixture', async () => {
    const { rec } = await driverRun(LINES, false);
    const lat = rec.latency;
    assert.ok(lat, 'latency recorded');
    assert.equal(lat.ttft?.count, 2);
    assert.ok(lat.ttft!.p50Ms >= GAP_MS - 5, `ttft ${lat.ttft!.p50Ms}ms spans at least one line gap`);
    assert.equal(lat.modelCalls?.count, 2);
    assert.ok(lat.outputTokensPerSec !== null && lat.outputTokensPerSec > 0);
    assert.ok(lat.tpotMs !== null && lat.tpotMs > 0);
    assert.deepEqual(lat.tools.map((t) => [t.name, t.count]), [['Bash', 1]]);
  });

  it('totals are byte-identical with and without the boundary events', async () => {
    for (const lines of [LINES, DUP_LINES]) {
      const before = await driverRun(lines, true);
      const after = await driverRun(lines, false);
      assert.ok(after.result.events.some((e) => e.type === 'model_call_end'), 'control: boundaries present');
      assert.ok(!before.result.events.some((e) => e.type === 'model_call_end'), 'control: boundaries stripped');
      assert.ok((after.rec.totals?.outputTokens ?? 0) > 0, 'control: totals were recorded');
      assert.equal(JSON.stringify(after.rec.totals), JSON.stringify(before.rec.totals));
      assert.equal(JSON.stringify(after.rec.usage), JSON.stringify(before.rec.usage));
      assert.equal(after.result.totalCost, before.result.totalCost);
      assert.equal(after.result.tokens.length, before.result.tokens.length);
      assert.deepEqual(
        after.result.tokens.map(({ timestamp: _t, ...r }) => r),
        before.result.tokens.map(({ timestamp: _t, ...r }) => r),
      );
      // The web token series and per-model cache rows sum model_call_end.usage
      // alongside usage events; boundaries must leave them unchanged too.
      const stripped = after.result.events.filter((e) => e.type !== 'model_call_start' && e.type !== 'model_call_end');
      const tail = (evs: AgentEvent[]) => deriveMetrics(evs).at(-1);
      assert.deepEqual({ ...tail(after.result.events), tMs: 0 }, { ...tail(stripped), tMs: 0 });
      assert.deepEqual(deriveModelCache(after.result.events), deriveModelCache(stripped));
      // And the stripped stream really has no latency beyond tools (the #32 gap).
      assert.equal(deriveLatency(stripped).ttft, null);
    }
  });
});
