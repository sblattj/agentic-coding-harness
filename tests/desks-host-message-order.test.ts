import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { EchoEngine, nullMeter, runHost } from '../src/desks/host.ts';
import { hostEvents, hostHealth, hostSend, hostStop } from '../src/desks/host-client.ts';
import { deskPaths } from '../src/desks/roster.ts';
import type { HostEvent, HostSpec } from '../src/desks/types.ts';

const TOKEN = 'b'.repeat(64);
const dirs: string[] = [];
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

async function waitFor(fn: () => Promise<boolean>, what: string, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await fn())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 15));
  }
}

describe('desk host: message_in ordering', () => {
  it('records message_in before the status busy and turn_start it causes (EchoEngine emits turn_start synchronously)', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'ach-desks-host-'));
    dirs.push(stateDir);
    const spec: HostSpec = {
      stack: 'fixb',
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
      runId: 'run_fixb_1',
      token: TOKEN,
    };
    let url = '';
    const done = runHost(spec, {
      createEngine: async () => new EchoEngine(30),
      createHostMeter: () => nullMeter(),
      installSignals: false,
      onReady: (i) => (url = i.url),
    });
    const t = { url: '', token: TOKEN };
    try {
      await waitFor(async () => url !== '' && (await hostHealth(url))?.state === 'idle', 'host idle');
      t.url = url;
      const r = await hostSend(t, 'human', 'hello');
      assert.equal(r.delivered, 'now');
      await waitFor(async () => (await hostEvents(t, 0)).some((e) => e.type === 'turn_end'), 'turn_end');

      const check = (evs: HostEvent[], where: string): void => {
        const mi = evs.find((e) => e.type === 'message_in');
        const busy = evs.find((e) => e.type === 'status' && e.data.state === 'busy');
        const ts = evs.find((e) => e.type === 'turn_start');
        assert.ok(mi && busy && ts, `${where}: has message_in, status busy, turn_start`);
        assert.ok(mi.seq < busy.seq, `${where}: message_in (seq ${mi.seq}) before status busy (seq ${busy.seq})`);
        assert.ok(mi.seq < ts.seq, `${where}: message_in (seq ${mi.seq}) before turn_start (seq ${ts.seq})`);
        assert.equal((mi.data.message as { delivered: string }).delivered, 'now');
      };
      check(await hostEvents(t, 0), 'GET /events');
      const file = join(deskPaths(stateDir, 'fixb').events, 'run_fixb_1.jsonl');
      check(readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as HostEvent), 'events file');
    } finally {
      if (t.url !== '') await hostStop(t);
      assert.equal(await done, 0);
    }
  });
});

describe('desk host: pending queue cap', () => {
  it('refuses a message past the cap with 429 and keeps the queue at the cap', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'ach-desks-host-'));
    dirs.push(stateDir);
    const spec: HostSpec = {
      stack: 'fixq', stateDir, name: 'ALPHA', kind: 'desk', role: 'orchestrator', roleFiles: [], agent: 'claude',
      engine: 'driver', mcps: [], port: 0, cwd: stateDir, runId: 'run_fixq_1', token: TOKEN,
    };
    let url = '';
    const done = runHost(spec, {
      createEngine: async () => new EchoEngine(600),
      createHostMeter: () => nullMeter(),
      installSignals: false,
      queueCap: 2,
      onReady: (i) => (url = i.url),
    });
    const t = { url: '', token: TOKEN };
    try {
      await waitFor(async () => url !== '' && (await hostHealth(url))?.state === 'idle', 'host idle');
      t.url = url;
      assert.equal((await hostSend(t, 'human', 'first')).delivered, 'now');
      assert.equal((await hostSend(t, 'human', 'q1')).delivered, 'queued');
      assert.equal((await hostSend(t, 'human', 'q2')).delivered, 'queued');
      await assert.rejects(hostSend(t, 'human', 'q3'), /queue full|429/);
      const h = await hostHealth(url);
      assert.equal(h?.queueDepth, 2, 'queue length stays at the cap');
      const ins = (await hostEvents(t, 0)).filter((e) => e.type === 'message_in');
      assert.equal(ins.length, 3, 'the refused message is not recorded as accepted');
    } finally {
      if (t.url !== '') await hostStop(t);
      assert.equal(await done, 0);
    }
  });
});
