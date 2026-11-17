import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, describe, it } from 'node:test';
import { EchoEngine, runHost, spawnHost, type HostDeps } from '../src/desks/host.ts';
import {
  hostAttach,
  hostEvents,
  hostGoal,
  hostHealth,
  hostMcp,
  hostNote,
  hostRecord,
  hostSend,
  hostSetGoal,
  hostStop,
  hostSubscribe,
} from '../src/desks/host-client.ts';
import type { FeedHandle } from '../src/desks/feeds.ts';
import type { HostMeter, UsageSample } from '../src/desks/host-metering.ts';
import { deskPaths } from '../src/desks/roster.ts';
import type { Engine, EngineEvent, FeedSpec, GoalStatus, HostEvent, HostSpec, HostState } from '../src/desks/types.ts';

const ROOT = resolve(import.meta.dirname, '..');
/** Every test host runs with this bearer token (the HostSpec field startHost fills in). */
const TOKEN = 'f'.repeat(64);
const AUTH = { authorization: `Bearer ${TOKEN}` };
const tmpRoots: string[] = [];
after(() => {
  for (const d of tmpRoots) rmSync(d, { recursive: true, force: true });
});

function tmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'ach-desks-host-'));
  tmpRoots.push(d);
  return d;
}

async function waitFor<T>(fn: () => T | undefined | false | Promise<T | undefined | false>, what: string, ms = 5000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v !== undefined && v !== false) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 15));
  }
}

/** Scripted engine: send() starts a turn; the test ends it with finishTurn(). */
class FakeEngine implements Engine {
  readonly kind = 'driver' as const;
  sent: string[] = [];
  notes: string[] = [];
  goals: string[] = [];
  stopped = false;
  failStart = false;
  usageCost = 0.01;
  goal: GoalStatus = { objective: '', state: 'none', source: 'ach-loop', updatedAt: 0 };
  private cbs: ((e: EngineEvent) => void)[] = [];
  private busy = false;
  async start(): Promise<{ sessionId?: string; engineUrl?: string }> {
    if (this.failStart) throw new Error('boom: no agent');
    return { sessionId: 'sess-1', engineUrl: 'http://127.0.0.1:1/engine' };
  }
  async send(text: string): Promise<void> {
    assert.equal(this.busy, false, 'host must only send when idle');
    this.sent.push(text);
    this.busy = true;
    this.emit({ type: 'turn_start', data: {} });
  }
  finishTurn(reply = 'ok'): void {
    this.emit({ type: 'text', data: { text: reply } });
    this.emit({ type: 'usage', data: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 1, cacheWriteTokens: 2, costUsd: this.usageCost, messageId: `msg${this.sent.length}` } });
    this.busy = false;
    this.emit({ type: 'turn_end', data: {} });
  }
  async note(text: string): Promise<void> {
    this.notes.push(text);
  }
  async state(): Promise<'busy' | 'idle'> {
    return this.busy ? 'busy' : 'idle';
  }
  async setGoal(objective: string): Promise<void> {
    this.goals.push(objective);
    this.goal = { objective, state: 'active', source: 'ach-loop', updatedAt: Date.now() };
  }
  async goalStatus(): Promise<GoalStatus> {
    return { ...this.goal };
  }
  async mcpStatus(): Promise<Record<string, string>> {
    return { desks: 'connected', whosaid: 'connected' };
  }
  attachCommand(): string[] {
    return ['fake-attach', '--session', 'sess-1'];
  }
  onEvent(cb: (e: EngineEvent) => void): void {
    this.cbs.push(cb);
  }
  async stop(): Promise<void> {
    this.stopped = true;
  }
  private emit(e: EngineEvent): void {
    for (const cb of this.cbs) cb(e);
  }
}

class FakeMeter implements HostMeter {
  begins: { sessionId?: string; pid: number }[] = [];
  usages: UsageSample[] = [];
  heartbeats: HostState[] = [];
  finished: string[] = [];
  over = false;
  lost = 0;
  begin(o: { sessionId?: string; pid: number }): void {
    this.begins.push(o);
  }
  usage(s: UsageSample): void {
    this.usages.push(s);
  }
  heartbeat(state: HostState): void {
    this.heartbeats.push(state);
  }
  overBudget(): boolean {
    return this.over;
  }
  finish(status: 'success' | 'error' | 'aborted'): void {
    this.finished.push(status);
  }
  totals() {
    return { costUsd: null, inputTokens: 0, outputTokens: 0, ...(this.lost > 0 ? { tokenRecordFailures: this.lost } : {}) };
  }
}

function baseSpec(stateDir: string, over: Partial<HostSpec> = {}): HostSpec {
  return {
    stack: 'test',
    stateDir,
    name: 'ALPHA',
    kind: 'desk',
    role: 'orchestrator',
    roleFiles: [],
    agent: 'claude',
    engine: 'driver',
    mcps: [],
    port: 0,
    cwd: stateDir,
    runId: 'run_test_1',
    token: TOKEN,
    ...over,
  };
}

interface Started {
  url: string;
  /** url + bearer token, what host-client calls take. */
  t: { url: string; token: string };
  done: Promise<number>;
  engine: FakeEngine;
  meter: FakeMeter;
  spec: HostSpec;
  feedDeliver?: (text: string) => Promise<void>;
  feedStopped: () => boolean;
}

async function start(over: Partial<HostSpec> = {}, tweak: (e: FakeEngine, m: FakeMeter) => void = () => {}, extra: HostDeps = {}): Promise<Started> {
  const stateDir = tmpDir();
  const spec = baseSpec(stateDir, over);
  const engine = new FakeEngine();
  const meter = new FakeMeter();
  tweak(engine, meter);
  let url = '';
  let feedDeliver: ((text: string) => Promise<void>) | undefined;
  let feedStopped = false;
  const deps: HostDeps = {
    createEngine: async () => engine,
    createHostMeter: () => meter,
    startFeed: (_s: FeedSpec, deliver): FeedHandle => {
      feedDeliver = deliver;
      return { pid: 4242, stop: async () => void (feedStopped = true) };
    },
    installSignals: false,
    onReady: (i) => (url = i.url),
    ...extra,
  };
  const done = runHost(spec, deps);
  await waitFor(async () => (url !== '' ? (await hostHealth(url))?.state === 'idle' : false), 'host idle');
  return { url, t: { url, token: TOKEN }, done, engine, meter, spec, get feedDeliver() { return feedDeliver; }, feedStopped: () => feedStopped } as Started;
}

async function stopAndWait(s: Started): Promise<number> {
  await hostStop(s.t);
  return s.done;
}

describe('desk host: message queue', () => {
  it('delivers now when idle, queues while busy, drains after turn_end', async () => {
    const s = await start();
    try {
      const a = await hostSend(s.t, 'human', 'first');
      assert.equal(a.delivered, 'now');
      assert.match(a.id, /^m_[0-9a-z]+_[0-9a-z]+$/);
      assert.deepEqual(s.engine.sent, ['first'], 'human message has no header');
      const b = await hostSend(s.t, 'BRAVO', 'second');
      assert.equal(b.delivered, 'queued');
      assert.equal((await hostHealth(s.url))?.queueDepth, 1);
      assert.equal((await hostHealth(s.url))?.state, 'busy');
      s.engine.finishTurn();
      await waitFor(() => s.engine.sent.length === 2, 'queued delivery');
      assert.equal(s.engine.sent[1], '[desk-msg from BRAVO] second');
      assert.equal((await hostHealth(s.url))?.queueDepth, 0);
    } finally {
      assert.equal(await stopAndWait(s), 0);
    }
  });

  it('merges several queued messages into one turn', async () => {
    const s = await start();
    try {
      await hostSend(s.t, 'human', 'go');
      const q = await Promise.all([hostSend(s.t, 'BRAVO', 'one'), hostSend(s.t, 'CHARLIE', 'two'), hostSend(s.t, 'human', 'three')]);
      assert.deepEqual(q.map((x) => x.delivered), ['queued', 'queued', 'queued']);
      assert.equal((await hostHealth(s.url))?.queueDepth, 3);
      s.engine.finishTurn();
      await waitFor(() => s.engine.sent.length === 2, 'merged turn');
      const merged = s.engine.sent[1] as string;
      for (const part of ['[desk-msg from BRAVO] one', '[desk-msg from CHARLIE] two', 'three']) assert.ok(merged.includes(part), `merged turn has ${part}`);
      assert.equal(merged.split('\n\n').length, 3, 'joined with blank lines');
      s.engine.finishTurn();
      await waitFor(async () => (await hostHealth(s.url))?.state === 'idle', 'idle after merged turn');
      assert.equal(s.engine.sent.length, 2, 'exactly one merged turn');
    } finally {
      await stopAndWait(s);
    }
  });

  it('two concurrent sends to an idle desk: one now, one queued', async () => {
    const s = await start();
    try {
      const r = await Promise.all([hostSend(s.t, 'human', 'a'), hostSend(s.t, 'human', 'b')]);
      assert.deepEqual(r.map((x) => x.delivered).sort(), ['now', 'queued']);
      assert.equal(s.engine.sent.length, 1);
    } finally {
      await stopAndWait(s);
    }
  });

  it('refuses empty text with 400', async () => {
    const s = await start();
    try {
      await assert.rejects(hostSend(s.t, 'human', ''), (e: Error) => /HTTP 400/.test(e.message) && e.message.includes(`${s.url}/send`));
      await assert.rejects(hostSend(s.t, 'human', '   '), /HTTP 400/);
      assert.equal(s.engine.sent.length, 0);
      const bad = await fetch(`${s.url}/send`, { method: 'POST', headers: { ...AUTH, 'content-type': 'application/json' }, body: '{not json' });
      assert.equal(bad.status, 400);
      const nf = await fetch(`${s.url}/nope`, { headers: AUTH });
      assert.equal(nf.status, 404);
    } finally {
      await stopAndWait(s);
    }
  });

  it('records message_in with the full DeskMessage', async () => {
    const s = await start();
    try {
      const r = await hostSend(s.t, 'BRAVO', 'hello');
      const evs = await hostEvents(s.t, 0);
      const mi = evs.find((e) => e.type === 'message_in');
      assert.ok(mi);
      assert.deepEqual({ ...(mi.data.message as object), at: 0 }, { id: r.id, from: 'BRAVO', to: 'ALPHA', text: 'hello', at: 0, delivered: 'now' });
    } finally {
      await stopAndWait(s);
    }
  });
});

describe('desk host: events', () => {
  it('seq is monotonic, the file is complete, since filters', async () => {
    const s = await start();
    try {
      await hostSend(s.t, 'human', 'x');
      s.engine.finishTurn('reply x');
      await waitFor(async () => (await hostHealth(s.url))?.state === 'idle', 'idle');
      const all = await hostEvents(s.t);
      assert.ok(all.length >= 6);
      all.forEach((e, i) => {
        assert.equal(e.seq, i + 1);
        assert.equal(e.runId, 'run_test_1');
        assert.equal(e.name, 'ALPHA');
        assert.equal(typeof e.at, 'number');
      });
      for (const t of ['status', 'message_in', 'turn_start', 'text', 'usage', 'turn_end']) assert.ok(all.some((e) => e.type === t), `has ${t}`);
      const file = join(deskPaths(s.spec.stateDir, 'test').events, 'run_test_1.jsonl');
      const lines = readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as HostEvent);
      assert.deepEqual(lines.map((e) => e.seq), all.map((e) => e.seq));
      const tail = await hostEvents(s.t, 3);
      assert.deepEqual(tail.map((e) => e.seq), all.filter((e) => e.seq > 3).map((e) => e.seq));
      const h = await hostHealth(s.url);
      assert.equal(h?.lastSeq, all.at(-1)?.seq);
      assert.equal(s.meter.usages.length, 1);
      assert.equal(s.meter.usages[0]?.costUsd, 0.01);
      assert.equal(s.meter.usages[0]?.messageId, 'msg1');
      const hb = s.meter.heartbeats;
      const iBusy = hb.indexOf('busy');
      assert.ok(iBusy >= 0 && hb.indexOf('idle', iBusy) > iBusy, `heartbeat on state change: ${hb.join(',')}`);
    } finally {
      await stopAndWait(s);
    }
  });

  it('since older than the memory window reads the complete file', async () => {
    const s = await start({}, () => {}, { eventMemoryCap: 5 });
    try {
      await hostSend(s.t, 'human', 'x');
      s.engine.finishTurn();
      await waitFor(async () => (await hostHealth(s.url))?.state === 'idle', 'idle');
      const last = (await hostHealth(s.url))?.lastSeq ?? 0;
      assert.ok(last > 5);
      const all = await hostEvents(s.t, 0);
      assert.deepEqual(all.map((e) => e.seq), Array.from({ length: last }, (_, i) => i + 1));
      const recent = await hostEvents(s.t, last - 2);
      assert.deepEqual(recent.map((e) => e.seq), [last - 1, last]);
    } finally {
      await stopAndWait(s);
    }
  });

  it('SSE: backlog after since, then live events', async () => {
    const s = await start();
    const got: HostEvent[] = [];
    let unsub = (): void => {};
    try {
      await hostSend(s.t, 'human', 'early');
      s.engine.finishTurn();
      await waitFor(async () => (await hostHealth(s.url))?.state === 'idle', 'idle');
      const before = await hostEvents(s.t);
      unsub = hostSubscribe(s.t, 2, (e) => got.push(e));
      await waitFor(() => got.length === before.length - 2, 'backlog');
      assert.deepEqual(got.map((e) => e.seq), before.filter((e) => e.seq > 2).map((e) => e.seq));
      await hostSend(s.t, 'BRAVO', 'live one');
      await waitFor(() => got.some((e) => e.type === 'message_in' && (e.data.message as { text: string }).text === 'live one'), 'live message_in');
      s.engine.finishTurn('live reply');
      await waitFor(() => got.some((e) => e.type === 'text' && e.data.text === 'live reply'), 'live text');
      const seqs = got.map((e) => e.seq);
      assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b), 'ordered');
      assert.equal(new Set(seqs).size, seqs.length, 'no duplicates');
    } finally {
      unsub();
      await stopAndWait(s);
    }
  });

  it('SSE stream is closed by stop so the server can exit', async () => {
    const s = await start();
    const got: HostEvent[] = [];
    const unsub = hostSubscribe(s.t, 0, (e) => got.push(e));
    try {
      await waitFor(() => got.length > 0, 'first event');
      assert.equal(await stopAndWait(s), 0);
      await waitFor(() => got.some((e) => e.type === 'status' && e.data.state === 'stopping'), 'stopping event over SSE', 2000);
    } finally {
      unsub();
    }
  });
});

describe('desk host: other routes', () => {
  it('/health fields', async () => {
    const s = await start({ feed: { command: ['fake-feed'] } });
    try {
      const h = await hostHealth(s.url);
      assert.ok(h);
      assert.equal(h.version, 'desks-api/1');
      assert.equal(h.name, 'ALPHA');
      assert.equal(h.kind, 'desk');
      assert.equal(h.engine, 'driver');
      assert.equal(h.agent, 'claude');
      assert.equal(h.runId, 'run_test_1');
      assert.equal(h.sessionId, 'sess-1');
      assert.equal(h.engineUrl, 'http://127.0.0.1:1/engine');
      assert.equal(h.pid, process.pid);
      assert.equal(h.state, 'idle');
      assert.equal(h.queueDepth, 0);
      assert.equal(h.feedPid, 4242);
      assert.ok(h.lastSeq > 0);
      assert.deepEqual(s.meter.begins.at(-1), { sessionId: 'sess-1', pid: process.pid });
    } finally {
      await stopAndWait(s);
      assert.equal(s.feedStopped(), true, 'feed stopped on /stop');
    }
  });

  it('/record allows message_out and feed, refuses others', async () => {
    const s = await start();
    try {
      const seq = await hostRecord(s.t, 'message_out', { message: { to: 'BRAVO', text: 'hi' } });
      assert.equal(typeof seq, 'number');
      const seq2 = await hostRecord(s.t, 'feed', { note: 'n' });
      assert.equal(seq2, seq + 1);
      await assert.rejects(hostRecord(s.t, 'text', { text: 'forged' }), /HTTP 400/);
      await assert.rejects(hostRecord(s.t, 'turn_end', {}), /HTTP 400/);
      const evs = await hostEvents(s.t, seq - 1);
      assert.deepEqual(evs.map((e) => e.type), ['message_out', 'feed']);
    } finally {
      await stopAndWait(s);
    }
  });

  it('/goal get and set, /note, /attach, /mcp', async () => {
    const s = await start();
    try {
      assert.equal((await hostGoal(s.t)).state, 'none');
      await hostSetGoal(s.t, 'ship it');
      assert.deepEqual(s.engine.goals, ['ship it']);
      const g = await hostGoal(s.t);
      assert.equal(g.state, 'active');
      assert.equal(g.objective, 'ship it');
      assert.equal((await hostHealth(s.url))?.goal?.state, 'active');
      assert.ok((await hostEvents(s.t)).some((e) => e.type === 'goal'), 'goal event recorded');
      await assert.rejects(hostSetGoal(s.t, ''), /HTTP 400/);
      await hostNote(s.t, 'silent context');
      assert.deepEqual(s.engine.notes, ['silent context']);
      assert.equal(s.engine.sent.length, 0, 'note starts no turn');
      assert.deepEqual(await hostAttach(s.t), ['fake-attach', '--session', 'sess-1']);
      assert.deepEqual(await hostMcp(s.t), { desks: 'connected', whosaid: 'connected' });
    } finally {
      await stopAndWait(s);
    }
  });

  it('feed text is delivered with no header and recorded from "feed"', async () => {
    const s = await start({ feed: { command: ['fake-feed'] } });
    try {
      assert.ok(s.feedDeliver);
      await s.feedDeliver('utterance batch');
      assert.deepEqual(s.engine.sent, ['utterance batch']);
      const mi = (await hostEvents(s.t)).find((e) => e.type === 'message_in');
      assert.equal((mi?.data.message as { from: string }).from, 'feed');
    } finally {
      await stopAndWait(s);
    }
  });

  it('/stop responds, stops engine, finishes meter, closes server, resolves 0', async () => {
    const s = await start();
    let stopCalls = 0;
    const origStop = s.engine.stop.bind(s.engine);
    s.engine.stop = async () => {
      stopCalls++;
      await origStop();
    };
    await hostStop(s.t);
    assert.equal(await s.done, 0);
    assert.equal(s.engine.stopped, true);
    assert.equal(stopCalls, 1, 'a stop with no start in flight stops the engine once');
    assert.deepEqual(s.meter.finished, ['aborted']);
    assert.equal(await hostHealth(s.url, 1000), null, 'server closed');
  });

  it('stop finishes "success" when the goal was achieved', async () => {
    const s = await start();
    s.engine.goal = { objective: 'g', state: 'achieved', source: 'ach-loop', updatedAt: 1 };
    assert.equal(await stopAndWait(s), 0);
    assert.deepEqual(s.meter.finished, ['success']);
  });
});

describe('desk host: lanes, budget, failures', () => {
  it('lane: brief as note, then goal; goal event recorded', async () => {
    const s = await start({ kind: 'lane', name: 'lane-a', brief: 'you are a lane', goal: 'fix #1' });
    try {
      await waitFor(() => s.engine.goals.length === 1, 'goal set');
      assert.deepEqual(s.engine.notes, ['you are a lane']);
      assert.deepEqual(s.engine.goals, ['fix #1']);
      await waitFor(async () => (await hostEvents(s.t)).some((e) => e.type === 'goal'), 'goal event');
    } finally {
      await stopAndWait(s);
    }
  });

  it('lane over budget: error event, host stops itself', async () => {
    const s = await start({ kind: 'lane', name: 'lane-b', budgetUsd: 0.001 });
    s.meter.over = true;
    await hostSend(s.t, 'human', 'spend');
    s.engine.finishTurn();
    assert.equal(await s.done, 0);
    assert.equal(s.engine.stopped, true);
    const file = join(deskPaths(s.spec.stateDir, 'test').events, 'run_test_1.jsonl');
    const evs = readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as HostEvent);
    assert.equal(evs.filter((e) => e.type === 'error' && e.data.error === 'budget exceeded').length, 1);
    assert.deepEqual(s.meter.finished, ['error'], 'a budget auto-stop is a failure, not a plain abort');
  });

  it('lost token records: one error event per new loss, host keeps running', async () => {
    const s = await start({});
    try {
      await hostSend(s.t, 'human', 'a');
      s.engine.finishTurn();
      await waitFor(async () => (await hostHealth(s.url))?.state === 'idle', 'idle');
      assert.equal((await hostEvents(s.t)).filter((e) => e.type === 'error').length, 0, 'no loss, no error');
      s.meter.lost = 2;
      await hostSend(s.t, 'human', 'b');
      s.engine.finishTurn();
      await waitFor(async () => (await hostHealth(s.url))?.state === 'idle', 'idle again');
      await hostSend(s.t, 'human', 'c');
      s.engine.finishTurn();
      await waitFor(async () => (await hostHealth(s.url))?.state === 'idle', 'idle a third time');
      const errs = (await hostEvents(s.t)).filter((e) => e.type === 'error');
      assert.equal(errs.length, 1, 'an unchanged count is not reported again');
      assert.equal(errs[0]?.data.error, 'metering: token record write failed');
      assert.equal(errs[0]?.data.tokenRecordFailures, 2);
    } finally {
      await stopAndWait(s);
    }
  });

  it('desk over budget: alert once, keeps running', async () => {
    const s = await start({ budgetUsd: 0.001 });
    try {
      s.meter.over = true;
      await hostSend(s.t, 'human', 'a');
      s.engine.finishTurn();
      await waitFor(async () => (await hostHealth(s.url))?.state === 'idle', 'idle');
      await hostSend(s.t, 'human', 'b');
      s.engine.finishTurn();
      await waitFor(async () => (await hostHealth(s.url))?.state === 'idle', 'idle again');
      const errs = (await hostEvents(s.t)).filter((e) => e.type === 'error');
      assert.equal(errs.length, 1);
      assert.equal(errs[0]?.data.error, 'budget exceeded');
    } finally {
      await stopAndWait(s);
    }
  });

  it('engine start failure: error event, meter finish("error"), exit 1', async () => {
    const stateDir = tmpDir();
    const engine = new FakeEngine();
    engine.failStart = true;
    const meter = new FakeMeter();
    let url = '';
    const code = await runHost(baseSpec(stateDir), {
      createEngine: async () => engine,
      createHostMeter: () => meter,
      installSignals: false,
      onReady: (i) => (url = i.url),
    });
    assert.equal(code, 1);
    assert.deepEqual(meter.finished, ['error']);
    assert.equal(await hostHealth(url, 1000), null, 'server closed after failure');
    const file = join(deskPaths(stateDir, 'test').events, 'run_test_1.jsonl');
    assert.ok(readFileSync(file, 'utf8').includes('engine start failed: boom: no agent'));
  });

  it('stop while engine.start is in flight: the engine is stopped again after start settles', async () => {
    const stateDir = tmpDir();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    // An engine that cannot abort its own start: it comes up after stop() was called once.
    let live = false;
    const engine = new FakeEngine();
    engine.start = async () => {
      await gate;
      live = true;
      return { sessionId: 'sess-1' };
    };
    engine.stop = async () => {
      engine.stopped = true;
      live = false;
    };
    let url = '';
    const done = runHost(baseSpec(stateDir), {
      createEngine: async () => engine,
      createHostMeter: () => new FakeMeter(),
      installSignals: false,
      onReady: (i) => (url = i.url),
    });
    await waitFor(() => url !== '', 'ready');
    await hostStop({ url, token: TOKEN });
    await new Promise((r) => setTimeout(r, 50));
    release();
    const code = await Promise.race([done, new Promise<string>((r) => setTimeout(() => r('timeout'), 3000))]);
    assert.equal(code, 0);
    assert.equal(live, false, 'no engine left running after stop');
  });

  it('stop while the engine is still being created: start is never called', async () => {
    const stateDir = tmpDir();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const engine = new FakeEngine();
    let startCalls = 0;
    engine.start = async () => {
      startCalls++;
      return { sessionId: 'sess-1' };
    };
    let url = '';
    const done = runHost(baseSpec(stateDir), {
      createEngine: async () => {
        await gate;
        return engine;
      },
      createHostMeter: () => new FakeMeter(),
      installSignals: false,
      onReady: (i) => (url = i.url),
    });
    await waitFor(() => url !== '', 'ready');
    await hostStop({ url, token: TOKEN });
    await new Promise((r) => setTimeout(r, 50));
    release();
    const code = await Promise.race([done, new Promise<string>((r) => setTimeout(() => r('timeout'), 3000))]);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(code, 0);
    assert.ok(startCalls === 0 || engine.stopped, 'an engine that started was stopped');
    assert.equal(startCalls, 0, 'start skipped once a stop is in flight');
  });

  it('a fatal engine error stops the host with status error and exit 1', async () => {
    const s = await start();
    (s.engine as unknown as { emit(e: EngineEvent): void }).emit({ type: 'error', data: { error: 'opencode serve exited (1)', fatal: true } });
    const code = await Promise.race([s.done, new Promise<string>((r) => setTimeout(() => r('timeout'), 3000))]);
    assert.equal(code, 1);
    assert.equal(s.engine.stopped, true);
    assert.deepEqual(s.meter.finished, ['error']);
  });

  it('port in use: exit 3, engine never started', async () => {
    const blocker = createServer();
    await new Promise<void>((r) => blocker.listen(0, '127.0.0.1', () => r()));
    const port = (blocker.address() as { port: number }).port;
    let created = false;
    try {
      const code = await runHost(baseSpec(tmpDir(), { port }), {
        createEngine: async () => {
          created = true;
          return new FakeEngine();
        },
        createHostMeter: () => new FakeMeter(),
        installSignals: false,
      });
      assert.equal(code, 3);
      assert.equal(created, false);
    } finally {
      await new Promise<void>((r) => blocker.close(() => r()));
    }
  });
});

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function portFree(port: number): Promise<boolean> {
  const s = createServer();
  return new Promise((r) => {
    s.once('error', () => r(false));
    s.listen(port, '127.0.0.1', () => s.close(() => r(true)));
  });
}

describe('desk host: real child process via spawnHost', () => {
  async function childHost(port: number, how: 'stop' | 'sigterm'): Promise<void> {
    const stateDir = tmpDir();
    assert.equal(await portFree(port), true, `port ${port} free before the test`);
    const spec = baseSpec(stateDir, { port, name: 'ECHO', runId: 'run_echo_1' });
    mkdirSync(join(stateDir, 'specs'), { recursive: true });
    const specFile = join(stateDir, 'specs', 'ECHO.json');
    writeFileSync(specFile, JSON.stringify(spec));
    const logFile = join(stateDir, 'logs', 'ECHO.log');
    const saved = { self: process.env.ACH_SELF_ARGV, fake: process.env.ACH_DESK_FAKE_ENGINE };
    process.env.ACH_SELF_ARGV = JSON.stringify([join(ROOT, 'node_modules', '.bin', 'tsx'), join(ROOT, 'src', 'cli', 'ach.ts')]);
    process.env.ACH_DESK_FAKE_ENGINE = '1';
    let pid = 0;
    let hostPid = 0;
    const url = `http://127.0.0.1:${port}`;
    try {
      pid = spawnHost(specFile, logFile);
      assert.ok(pid > 0);
      const h = await waitFor(async () => {
        const x = await hostHealth(url, 1000);
        return x?.state === 'idle' ? x : undefined;
      }, `host health (log: ${logFile})`, 60_000);
      hostPid = h.pid;
      assert.equal(h.name, 'ECHO');
      assert.equal(h.version, 'desks-api/1');
      assert.equal(h.sessionId, 'echo-run_echo_1');
      const t = { url, token: TOKEN };
      const r = await hostSend(t, 'BRAVO', 'ping');
      assert.equal(r.delivered, 'now');
      await waitFor(async () => (await hostEvents(t)).some((e) => e.type === 'text' && e.data.text === 'echo: [desk-msg from BRAVO] ping'), 'echo reply');
      if (how === 'stop') await hostStop(t);
      else process.kill(hostPid, 'SIGTERM');
      await waitFor(() => !pidAlive(hostPid) && !pidAlive(pid), 'host process exit', 15_000);
      assert.equal(await hostHealth(url, 1000), null);
      assert.equal(await portFree(port), true, 'port freed');
      const file = join(deskPaths(stateDir, 'test').events, 'run_echo_1.jsonl');
      const evs = readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as HostEvent);
      assert.ok(evs.some((e) => e.type === 'status' && e.data.state === 'stopping'), `${how}: stopping recorded`);
    } finally {
      for (const p of [hostPid, pid]) if (p > 0 && pidAlive(p)) process.kill(p, 'SIGKILL');
      if (saved.self === undefined) delete process.env.ACH_SELF_ARGV;
      else process.env.ACH_SELF_ARGV = saved.self;
      if (saved.fake === undefined) delete process.env.ACH_DESK_FAKE_ENGINE;
      else process.env.ACH_DESK_FAKE_ENGINE = saved.fake;
    }
  }

  it('ach desk host --spec runs EchoEngine, answers HTTP, exits on /stop and frees the port', { timeout: 90_000 }, () => childHost(5711, 'stop'));
  it('SIGTERM stops the host the same way: process exits, port freed', { timeout: 90_000 }, () => childHost(5712, 'sigterm'));

  it('EchoEngine replies "echo: <text>"', async () => {
    const e = new EchoEngine(1);
    const got: EngineEvent[] = [];
    e.onEvent((x) => got.push(x));
    await e.start(baseSpec(tmpDir()));
    await e.send('hi');
    await waitFor(() => got.some((x) => x.type === 'turn_end'), 'echo turn_end');
    assert.deepEqual(got.map((x) => x.type), ['turn_start', 'text', 'usage', 'turn_end']);
    assert.equal(got[1]?.data.text, 'echo: hi');
  });
});
