// Desk power (`ach desk on|off|toggle|status|auto`, MCP desk_power, issue 1): a desk can be parked
// fully off (host, feed and pane gone, roster row state "off", desk_send gets a typed desk_off
// error) and started again; auto mode follows the desk feed's activeCheck with a grace period.
// Real hosts on the fake engine (ACH_DESK_FAKE_ENGINE=1) with a real feed process, a stubbed
// activeCheck (`cat <dir>/active.json`), ports 6440..6499. The service functions are looked up
// at call time (import * as svc) so each test fails on its own on a tree without them.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, describe, it } from 'node:test';
import { createMcpServer } from '../src/mcp/server.ts';
import { registerDeskTools } from '../src/mcp/tools-desks.ts';
import { cmdDesk } from '../src/cli/desk.ts';
import { hostHealth } from '../src/desks/host-client.ts';
import { readHostToken, readMessages, readRoster, updateRoster } from '../src/desks/roster.ts';
import * as svc from '../src/desks/service.ts';
import type { HostHealth, RosterEntry } from '../src/desks/types.ts';
import { VERSION } from '../src/version.ts';
import { BUILTIN_DESK_ASSETS } from '../src/desks/builtin-assets.gen.ts';

const S = svc as unknown as Record<string, (o: Record<string, unknown>) => Promise<any>>;
const ROOT = resolve(import.meta.dirname, '..');
const SELF = JSON.stringify([join(ROOT, 'node_modules', '.bin', 'tsx'), join(ROOT, 'src', 'cli', 'ach.ts')]);
process.env.ACH_SELF_ARGV = SELF;
process.env.ACH_DESK_FAKE_ENGINE = '1';
delete process.env.ACH_DESK_STACK;
delete process.env.ACH_DESK_NAME;
const ENV_STATE = mkdtempSync(join(tmpdir(), 'ach-desks-power-env-'));
process.env.AGENTIC_CODING_HARNESS_STATE_DIR = ENV_STATE;

const roots: string[] = [ENV_STATE];
after(() => {
  for (const d of roots) rmSync(d, { recursive: true, force: true });
});
function tmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'ach-desks-power-'));
  roots.push(d);
  return d;
}

const FEED = [process.execPath, '-e', 'setInterval(() => process.stdout.write(JSON.stringify({ type: "alive" }) + "\\n"), 300)'];

function setActive(sd: string, active: boolean): void {
  writeFileSync(join(sd, 'active.json'), JSON.stringify({ active }));
}

function layoutFile(sd: string, portBase: number): string {
  setActive(sd, false);
  const f = join(sd, 'desks.yaml');
  writeFileSync(
    f,
    JSON.stringify({
      portBase,
      agent: 'opencode',
      desks: [
        { name: 'ORCHESTRATOR', role: 'orchestrator', mcps: [] },
        { name: 'DECISIONS', role: 'decisions', mcps: [] },
        { name: 'LISTENER', role: 'listener', mcps: [], feed: { command: FEED, activeCheck: ['/bin/cat', join(sd, 'active.json')] } },
      ],
      lanes: { defaultMcps: [], ports: [10, 14], approval: 'none' },
    }),
  );
  return f;
}

function health(sd: string, stack: string, e: RosterEntry): Promise<HostHealth | null> {
  return hostHealth({ url: e.url, token: readHostToken(sd, stack, e.name, e.runId) }, 2000);
}

function pidAlive(pid: number | undefined): boolean {
  if (pid === undefined || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function until(what: string, pred: () => boolean | Promise<boolean>, ms = 20_000): Promise<number> {
  const t0 = Date.now();
  for (;;) {
    if (await pred()) return Date.now() - t0;
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function feedPidOf(sd: string, stack: string): Promise<number> {
  let pid = 0;
  await until('LISTENER feed pid', async () => {
    const e = readRoster(sd, stack).entries.LISTENER!;
    pid = (await health(sd, stack, e))?.feedPid ?? 0;
    return pid > 0;
  });
  return pid;
}

function mcp(sd: string, stack: string, me: string) {
  const server = createMcpServer({ name: 't', version: '0' });
  registerDeskTools(server, { stateDir: sd }, { env: { ACH_DESK_NAME: me, ACH_DESK_STACK: stack } });
  let id = 0;
  return async (name: string, args: Record<string, unknown> = {}): Promise<{ error?: { message: string }; value?: any }> => {
    const res = await server.dispatch({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: args } });
    if (res?.error) return { error: res.error as { message: string } };
    const text = (res!.result as { content: { text: string }[] }).content[0]!.text;
    return { value: JSON.parse(text) };
  };
}

describe('desk power on fake-engine hosts', () => {
  it('acceptance 1, 2, 4: status shows on with the feed pid; off stops host and feed, roster says off, desk_send gets desk_off; off and on are idempotent', { timeout: 120_000 }, async () => {
    const sd = tmpDir();
    const stack = 'p6440';
    await svc.deskUp({ stateDir: sd, stack, layoutFile: layoutFile(sd, 6440), term: 'none' });
    try {
      const before = readRoster(sd, stack).entries.LISTENER!;
      const feedPid = await feedPidOf(sd, stack);
      const st = await S.deskPower!({ stateDir: sd, stack, name: 'LISTENER', action: 'status' });
      assert.equal(st.status.state, 'on');
      assert.equal(st.status.feedPid, feedPid, 'status names the live feed pid');
      assert.equal(st.status.callLive, false);
      assert.equal(st.status.auto.running, false);

      const again = await S.deskPower!({ stateDir: sd, stack, name: 'LISTENER', action: 'on' });
      assert.equal(again.changed, false);
      assert.match(again.message, /already on/);
      assert.equal(readRoster(sd, stack).entries.LISTENER!.runId, before.runId, 'on when on changes nothing');

      const off = await S.deskPower!({ stateDir: sd, stack, name: 'LISTENER', action: 'off', by: 'human' });
      assert.equal(off.changed, true, JSON.stringify(off));
      assert.equal(off.status.state, 'off');
      await until('host and feed exit', () => !pidAlive(before.pid) && !pidAlive(feedPid), 10_000);
      assert.equal(await health(sd, stack, before), null, 'host gone');

      const view = await svc.deskRoster({ stateDir: sd, stack });
      const row = view.rows.find((r) => r.name === 'LISTENER');
      assert.ok(row, 'roster keeps the off desk');
      assert.equal(row.state, 'off');
      assert.equal(view.rows.find((r) => r.name === 'DECISIONS')?.state, 'idle', 'other desks untouched');

      await assert.rejects(svc.deskSend({ stateDir: sd, stack, from: 'ORCHESTRATOR', to: 'LISTENER', text: 'hi' }), (e: Error & { code?: string }) => {
        assert.equal(e.code, 'desk_off');
        assert.match(e.message, /^desk_off: LISTENER is off/);
        assert.match(e.message, /do not retry/i);
        return true;
      });
      const call = mcp(sd, stack, 'ORCHESTRATOR');
      const sent = await call('desk_send', { to: 'LISTENER', text: 'hi' });
      assert.match(sent.error?.message ?? '', /^desk_off: /, 'the MCP tool surfaces the typed error');

      const off2 = await S.deskPower!({ stateDir: sd, stack, name: 'LISTENER', action: 'off' });
      assert.equal(off2.changed, false);
      assert.match(off2.message, /already off/);

      const log = readMessages(sd, stack, { name: 'LISTENER' }).map((m) => `${m.from} -> ${m.to}: ${m.text}`);
      assert.ok(log.some((l) => /^human -> LISTENER: .*\boff\b/.test(l)), log.join('\n'));
      // A roster with an off desk prunes nothing and reload --all skips it.
      const rs = await svc.deskReload({ stateDir: sd, stack, all: true });
      const l = rs.find((r) => r.name === 'LISTENER');
      assert.ok(l?.skipped !== undefined && /off/.test(l.skipped), JSON.stringify(rs));
      await assert.rejects(svc.deskSwitchEngine({ stateDir: sd, stack, name: 'LISTENER', agent: 'opencode' }), /is off/);
    } finally {
      await svc.deskDown({ stateDir: sd, stack });
    }
  });

  it('acceptance 3: on from off starts a new host and a new feed; --resume continues the saved session', { timeout: 120_000 }, async () => {
    const sd = tmpDir();
    const stack = 'p6450';
    await svc.deskUp({ stateDir: sd, stack, layoutFile: layoutFile(sd, 6450), term: 'none' });
    try {
      const first = readRoster(sd, stack).entries.LISTENER!;
      const feed1 = await feedPidOf(sd, stack);
      await svc.deskSend({ stateDir: sd, stack, from: 'human', to: 'LISTENER', text: 'turn' });
      await until('a session', async () => (await health(sd, stack, first))?.state === 'idle');
      const session = (await health(sd, stack, first))?.sessionId;
      await S.deskPower!({ stateDir: sd, stack, name: 'LISTENER', action: 'off' });

      const on = await S.deskPower!({ stateDir: sd, stack, name: 'LISTENER', action: 'toggle' });
      assert.equal(on.changed, true, JSON.stringify(on));
      assert.equal(on.status.state, 'on');
      const second = readRoster(sd, stack).entries.LISTENER!;
      assert.notEqual(second.runId, first.runId, 'a new run');
      assert.equal(second.port, first.port, 'same port');
      const h = await health(sd, stack, second);
      assert.equal(h?.runId, second.runId, 'host healthy');
      assert.notEqual(h?.sessionId, session, 'a fresh session by default');
      const feed2 = await feedPidOf(sd, stack);
      assert.notEqual(feed2, feed1, 'a new feed');
      assert.ok(pidAlive(feed2));

      await S.deskPower!({ stateDir: sd, stack, name: 'LISTENER', action: 'off' });
      const sess2 = h?.sessionId;
      await S.deskPower!({ stateDir: sd, stack, name: 'LISTENER', action: 'on', resume: true });
      const third = readRoster(sd, stack).entries.LISTENER!;
      assert.equal((await health(sd, stack, third))?.sessionId, sess2, '--resume continues the saved session');
    } finally {
      await svc.deskDown({ stateDir: sd, stack });
    }
  });

  it('acceptance 6: desk_power refuses off and toggle during a live call; LISTENER turning itself off gets its reply before its host stops', { timeout: 120_000 }, async () => {
    const sd = tmpDir();
    const stack = 'p6460';
    await svc.deskUp({ stateDir: sd, stack, layoutFile: layoutFile(sd, 6460), term: 'none' });
    try {
      const e = readRoster(sd, stack).entries.LISTENER!;
      const orch = mcp(sd, stack, 'ORCHESTRATOR');
      setActive(sd, true);
      for (const action of ['off', 'toggle']) {
        const r = await orch('desk_power', { name: 'LISTENER', action });
        assert.match(r.error?.message ?? '', /refused: a call is live, LISTENER stays on/, action);
      }
      const st = await orch('desk_power', { name: 'LISTENER', action: 'status' });
      assert.equal(st.value.status.callLive, true);
      assert.equal(readRoster(sd, stack).entries.LISTENER!.runId, e.runId, 'still on');
      assert.equal((await health(sd, stack, e))?.runId, e.runId);

      setActive(sd, false);
      const self = mcp(sd, stack, 'LISTENER');
      const r = await self('desk_power', { name: 'LISTENER', action: 'off' });
      assert.equal(r.error, undefined, JSON.stringify(r.error));
      assert.equal(r.value.pending, true, JSON.stringify(r.value));
      assert.equal((await health(sd, stack, e))?.runId, e.runId, 'the host still answers right after the reply');
      await until('LISTENER off after the delay', () => readRoster(sd, stack).entries.LISTENER?.off !== undefined, 30_000);
      await until('host gone', async () => (await health(sd, stack, e)) === null, 15_000);
      const log = readMessages(sd, stack, { name: 'LISTENER' }).map((m) => `${m.from} -> ${m.to}: ${m.text}`);
      assert.ok(log.some((l) => /^LISTENER -> LISTENER: .*\boff\b/.test(l)), log.join('\n'));
    } finally {
      await svc.deskDown({ stateDir: sd, stack });
    }
  });

  it('acceptance 5, 7: auto turns the desk on within one poll of a live call and off after the grace period, with log lines; auto --stop and desk down end the watcher; another stack is untouched', { timeout: 180_000 }, async () => {
    const sd = tmpDir();
    const stack = 'p6470';
    const sd2 = tmpDir();
    const stack2 = 'p6480';
    await svc.deskUp({ stateDir: sd, stack, layoutFile: layoutFile(sd, 6470), term: 'none' });
    await svc.deskUp({ stateDir: sd2, stack: stack2, layoutFile: layoutFile(sd2, 6480), term: 'none' });
    try {
      await S.deskPower!({ stateDir: sd, stack, name: 'LISTENER', action: 'off' });
      const POLL = 500;
      const GRACE = 2000;
      const a = await S.deskAuto!({ stateDir: sd, stack, name: 'LISTENER', pollMs: POLL, graceMs: GRACE });
      assert.equal(a.status.auto.running, true, JSON.stringify(a));
      const watcher = a.status.auto.pid as number;
      assert.ok(pidAlive(watcher));
      const a2 = await S.deskAuto!({ stateDir: sd, stack, name: 'LISTENER', pollMs: POLL, graceMs: GRACE });
      assert.equal(a2.changed, false, 'one watcher per desk');
      assert.equal(a2.status.auto.pid, watcher);
      const logFile = join(sd, 'desks', stack, 'logs', 'LISTENER-auto.log');
      await until('watcher polling', () => existsSync(logFile) && /watching/.test(readFileSync(logFile, 'utf8')), 20_000);

      setActive(sd, true);
      const flipped = Date.now();
      await until('auto on', () => /call live -> on/.test(readFileSync(logFile, 'utf8')), 20_000);
      const onLine = readFileSync(logFile, 'utf8').split('\n').find((l) => /call live -> on/.test(l))!;
      // The switch starts within one poll of the flip (the line is written once the desk is up).
      const startedAt = Date.parse(onLine.split(' ')[0]!);
      assert.ok(Number.isFinite(startedAt), onLine);
      await until('roster on', async () => (await S.deskPower!({ stateDir: sd, stack, name: 'LISTENER', action: 'status' })).status.state === 'on', 20_000);
      assert.ok(startedAt - flipped < POLL + 15_000, `on line ${startedAt - flipped} ms after the flip`);

      setActive(sd, false);
      const ended = Date.now();
      await until('auto off', () => /no call for \d+s -> off/.test(readFileSync(logFile, 'utf8')), 30_000);
      assert.ok(Date.now() - ended >= GRACE, 'not before the grace period');
      assert.equal(readRoster(sd, stack).entries.LISTENER?.off !== undefined, true);

      // A call that resumes inside the grace period cancels the timer.
      setActive(sd, true);
      await until('auto on again', () => readFileSync(logFile, 'utf8').split('call live -> on').length === 3, 30_000);
      setActive(sd, false);
      await new Promise((r) => setTimeout(r, POLL * 2));
      setActive(sd, true);
      await new Promise((r) => setTimeout(r, GRACE + POLL * 2));
      assert.equal(readRoster(sd, stack).entries.LISTENER?.off, undefined, 'a resumed call keeps it on');
      assert.match(readFileSync(logFile, 'utf8'), /call live again, grace cancelled/);

      const stop = await S.deskAuto!({ stateDir: sd, stack, name: 'LISTENER', stop: true });
      assert.equal(stop.status.auto.running, false);
      await until('watcher exits on --stop', () => !pidAlive(watcher), 10_000);

      // desk down ends a running watcher too; the other stack's desks and watcher keep running.
      const other = await S.deskAuto!({ stateDir: sd2, stack: stack2, name: 'LISTENER', pollMs: POLL, graceMs: 60_000 });
      const otherWatcher = other.status.auto.pid as number;
      const otherBefore = readRoster(sd2, stack2).entries;
      const b = await S.deskAuto!({ stateDir: sd, stack, name: 'LISTENER', pollMs: POLL, graceMs: GRACE });
      const watcher2 = b.status.auto.pid as number;
      assert.ok(pidAlive(watcher2));
      await svc.deskDown({ stateDir: sd, stack });
      await until('watcher exits on desk down', () => !pidAlive(watcher2), 10_000);
      assert.ok(pidAlive(otherWatcher), 'the other stack keeps its watcher');
      const otherAfter = readRoster(sd2, stack2).entries;
      for (const n of ['ORCHESTRATOR', 'DECISIONS', 'LISTENER']) {
        assert.equal(otherAfter[n]?.runId, otherBefore[n]?.runId, `${n} of the other stack untouched`);
        assert.equal((await health(sd2, stack2, otherAfter[n]!))?.runId, otherBefore[n]?.runId);
      }
    } finally {
      await svc.deskDown({ stateDir: sd, stack });
      await svc.deskDown({ stateDir: sd2, stack: stack2 });
    }
  });

  it('auto refuses a desk whose feed has no activeCheck', { timeout: 60_000 }, async () => {
    const sd = tmpDir();
    const stack = 'p6485';
    await svc.deskUp({ stateDir: sd, stack, layoutFile: layoutFile(sd, 6485), term: 'none' });
    try {
      await assert.rejects(S.deskAuto!({ stateDir: sd, stack, name: 'DECISIONS' }), /no feed activeCheck/);
    } finally {
      await svc.deskDown({ stateDir: sd, stack });
    }
  });
});

describe('desk reload --stale (installed ach version changed)', () => {
  it('the host reports its ach version; only desks on an older version are reloaded, idle ones only, off ones never', { timeout: 120_000 }, async () => {
    const sd = tmpDir();
    const stack = 'p6487';
    await svc.deskUp({ stateDir: sd, stack, layoutFile: layoutFile(sd, 6487), term: 'none' });
    try {
      const r0 = readRoster(sd, stack).entries;
      assert.equal(r0.ORCHESTRATOR!.achVersion, VERSION, 'the roster records the host ach version');
      assert.equal((await health(sd, stack, r0.ORCHESTRATOR!))?.achVersion, VERSION);
      assert.deepEqual(await S.deskReloadStale!({ stateDir: sd, stack }), [], 'nothing stale');
      await S.deskPower!({ stateDir: sd, stack, name: 'LISTENER', action: 'off' });
      await updateRoster(sd, stack, (r) => {
        r.entries.ORCHESTRATOR!.achVersion = '0.0.1';
        r.entries.DECISIONS!.achVersion = '999.0.0';
        r.entries.LISTENER!.achVersion = '0.0.1';
      });
      const rs = await S.deskReloadStale!({ stateDir: sd, stack, by: 'human' });
      assert.deepEqual(rs.map((r: { name: string; ok: boolean }) => [r.name, r.ok]), [['ORCHESTRATOR', true]], JSON.stringify(rs));
      const r1 = readRoster(sd, stack).entries;
      assert.notEqual(r1.ORCHESTRATOR!.runId, r0.ORCHESTRATOR!.runId);
      assert.equal(r1.ORCHESTRATOR!.achVersion, VERSION);
      assert.equal(r1.DECISIONS!.runId, r0.DECISIONS!.runId, 'a newer desk is left alone');
      assert.ok(r1.LISTENER!.off !== undefined, 'an off desk stays off');
    } finally {
      await svc.deskDown({ stateDir: sd, stack });
    }
  });
});

describe('desk power CLI', () => {
  it('ach desk on|off|toggle|status|auto and ach listener map to the service', async () => {
    const calls: { fn: string; o: Record<string, unknown> }[] = [];
    const status = { name: 'LISTENER', state: 'on', feedPid: 42, pane: { kind: 'tmux', id: '%7' }, callLive: false, auto: { running: false } };
    const service = {
      ...svc,
      deskPower: async (o: Record<string, unknown>) => {
        calls.push({ fn: 'deskPower', o });
        return { name: 'LISTENER', action: o.action, changed: false, message: 'LISTENER is already on', status };
      },
      deskAuto: async (o: Record<string, unknown>) => {
        calls.push({ fn: 'deskAuto', o });
        return { name: 'LISTENER', action: o.stop ? 'auto_stop' : 'auto', changed: true, message: 'ok', status };
      },
    } as unknown as typeof svc;
    const out: string[] = [];
    const err: string[] = [];
    const deps = { service, stdout: (s: string) => void out.push(s), stderr: (s: string) => void err.push(s), env: {} };
    assert.equal(await cmdDesk(['status', 'LISTENER'], deps), 0, err.join(''));
    assert.match(out.join(''), /LISTENER on feed=42 pane=%7/);
    assert.match(out.join(''), /call: none/);
    assert.match(out.join(''), /auto: off/);
    assert.equal(await cmdDesk(['off', 'LISTENER', '--force'], deps), 0, err.join(''));
    assert.equal(await cmdDesk(['on', 'LISTENER', '--resume'], deps), 0, err.join(''));
    assert.equal(await cmdDesk(['toggle', 'LISTENER'], deps), 0, err.join(''));
    assert.equal(await cmdDesk(['auto', 'LISTENER', '--poll', '10', '--grace', '60'], deps), 0, err.join(''));
    assert.equal(await cmdDesk(['auto', 'LISTENER', '--stop'], deps), 0, err.join(''));
    const { cmdListener } = (await import('../src/cli/desk.ts')) as unknown as { cmdListener: typeof cmdDesk };
    assert.equal(await cmdListener(['off'], deps), 0, err.join(''));
    assert.equal(await cmdListener(['auto', '--stop'], deps), 0, err.join(''));
    assert.deepEqual(
      calls.map((c) => [c.fn, c.o.name, c.o.action ?? (c.o.stop ? 'stop' : 'start'), c.o.force, c.o.resume, c.o.pollMs, c.o.graceMs, c.o.by]),
      [
        ['deskPower', 'LISTENER', 'status', undefined, undefined, undefined, undefined, 'human'],
        ['deskPower', 'LISTENER', 'off', true, undefined, undefined, undefined, 'human'],
        ['deskPower', 'LISTENER', 'on', undefined, true, undefined, undefined, 'human'],
        ['deskPower', 'LISTENER', 'toggle', undefined, undefined, undefined, undefined, 'human'],
        ['deskAuto', 'LISTENER', 'start', undefined, undefined, 10_000, 60_000, 'human'],
        ['deskAuto', 'LISTENER', 'stop', undefined, undefined, undefined, undefined, 'human'],
        ['deskPower', 'LISTENER', 'off', undefined, undefined, undefined, undefined, 'human'],
        ['deskAuto', 'LISTENER', 'stop', undefined, undefined, undefined, undefined, 'human'],
      ],
    );
    assert.equal(await cmdDesk(['off'], deps), 2, 'a name is required');
  });
});

const hasTmux = (() => {
  try {
    execFileSync('tmux', ['-V'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

describe('desk power with tmux panes', { skip: hasTmux ? false : 'tmux not installed' }, () => {
  it('acceptance 1-3 (panes): status shows the pane; off closes it and the neighbors keep running; on opens a new pane', { timeout: 180_000 }, async () => {
    const sd = tmpDir();
    const stack = 'p6490';
    const sock = `ach-power-${process.pid}`;
    const tm = (...a: string[]): string => execFileSync('tmux', ['-L', sock, ...a], { encoding: 'utf8' });
    process.env.AGENTIC_CODING_HARNESS_STATE_DIR = sd;
    await svc.deskUp({ stateDir: sd, stack, layoutFile: layoutFile(sd, 6490), term: 'tmux', tmuxSocket: sock });
    try {
      const before = readRoster(sd, stack).entries;
      const pane = before.LISTENER!.terminal?.id;
      assert.match(pane ?? '', /^%\d+$/);
      await new Promise((r) => setTimeout(r, 3000));
      const st = await S.deskPower!({ stateDir: sd, stack, name: 'LISTENER', action: 'status' });
      assert.equal(st.status.pane?.id, pane, 'status shows the pane');
      const panes = () => tm('list-panes', '-a', '-F', '#{pane_id}').trim().split('\n').sort();
      assert.ok(panes().includes(pane!));

      await S.deskPower!({ stateDir: sd, stack, name: 'LISTENER', action: 'off' });
      assert.ok(!panes().includes(pane!), 'the pane closed');
      for (const n of ['ORCHESTRATOR', 'DECISIONS']) assert.ok(panes().includes(before[n]!.terminal!.id), `${n} pane kept`);
      assert.equal(readRoster(sd, stack).entries.LISTENER!.terminal, undefined);

      await S.deskPower!({ stateDir: sd, stack, name: 'LISTENER', action: 'on' });
      const now = readRoster(sd, stack).entries.LISTENER!;
      assert.match(now.terminal?.id ?? '', /^%\d+$/, 'a new pane');
      assert.notEqual(now.terminal?.id, pane);
      assert.ok(panes().includes(now.terminal!.id));
      const win = (id: string) => tm('display-message', '-p', '-t', id, '#{window_id}').trim();
      assert.equal(win(now.terminal!.id), win(before.DECISIONS!.terminal!.id), 'back in the desks window');
      await new Promise((r) => setTimeout(r, 3000));
      assert.equal(tm('display-message', '-p', '-t', now.terminal!.id, '#{pane_dead}').trim(), '0', 'the new pane runs its attach');
    } finally {
      process.env.AGENTIC_CODING_HARNESS_STATE_DIR = ENV_STATE;
      await svc.deskDown({ stateDir: sd, stack });
      try {
        tm('kill-server');
      } catch {
        /* already gone */
      }
    }
  });
});

describe('desk power in the role prompts', () => {
  it('common.md lists desk_reload and desk_power and the off rule; orchestrator.md sends history questions to a lane; boundary blocks kept', () => {
    const common = BUILTIN_DESK_ASSETS['roles/common.md']!;
    const orch = BUILTIN_DESK_ASSETS['roles/orchestrator.md']!;
    assert.match(common, /`desk_reload \{name\}`/);
    assert.match(common, /`desk_power \{name, action\}`/);
    assert.match(common, /`desk_off:`\. Do not retry/);
    assert.match(orch, /LISTENER may be off between calls/);
    assert.match(orch, /short read-only lane/);
    assert.match(orch, /^# Role: ORCHESTRATOR\n\n## Your role, and only this\n/);
    assert.equal(common, readFileSync(join(ROOT, 'roles', 'common.md'), 'utf8'), 'generated assets match roles/');
  });
});
