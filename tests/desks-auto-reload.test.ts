// Automatic `desk reload` after an ach upgrade (#214 part 2, src/desks/auto-reload.ts).
// Part 1, in-process hosts (runHost, port 0) with a scripted engine and an injected version probe and
// spawn: a newer installed ach reloads an idle desk once, a busy desk waits until it is idle, a lane is
// never touched, a host that already got its reload for that version never asks again.
// Part 2, real detached hosts on the fake engine (ports 6360..6379): the host's own watcher spawns a
// real `ach desk reload`, every desk comes back on the same session once, the lane keeps its run.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, describe, it } from 'node:test';
import { autoReloadMarkFile, compareVersions, probeInstalledVersion, readAutoReloadMark, startVersionWatcher } from '../src/desks/auto-reload.ts';
import { runHost, type HostDeps } from '../src/desks/host.ts';
import { hostHealth, hostSend, hostStop } from '../src/desks/host-client.ts';
import { deskPaths, readHostToken, readRoster } from '../src/desks/roster.ts';
import { deskDown, deskUp, laneNew } from '../src/desks/service.ts';
import type { Engine, EngineEvent, GoalStatus, HostSpec, RosterEntry } from '../src/desks/types.ts';
import { VERSION } from '../src/version.ts';

const ROOT = resolve(import.meta.dirname, '..');
const TOKEN = 'e'.repeat(64);
const roots: string[] = [];
after(() => {
  for (const d of roots) rmSync(d, { recursive: true, force: true });
});
function tmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'ach-auto-reload-'));
  roots.push(d);
  return d;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor<T>(fn: () => T | undefined | false | Promise<T | undefined | false>, what: string, ms = 10_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v !== undefined && v !== false) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(20);
  }
}

/** send() starts a turn; finishTurn() ends it. */
class TurnEngine implements Engine {
  readonly kind = 'driver' as const;
  private cbs: ((e: EngineEvent) => void)[] = [];
  private busy = false;
  async start(): Promise<{ sessionId?: string }> {
    return { sessionId: 'sess-1' };
  }
  async send(): Promise<void> {
    this.busy = true;
    this.emit({ type: 'turn_start', data: {} });
  }
  finishTurn(): void {
    this.busy = false;
    this.emit({ type: 'turn_end', data: {} });
  }
  async note(): Promise<void> {}
  async state(): Promise<'busy' | 'idle'> {
    return this.busy ? 'busy' : 'idle';
  }
  async setGoal(): Promise<void> {}
  async goalStatus(): Promise<GoalStatus> {
    return { objective: '', state: 'none', source: 'ach-loop', updatedAt: 0 };
  }
  async mcpStatus(): Promise<Record<string, string>> {
    return {};
  }
  attachCommand(): string[] {
    return ['x'];
  }
  onEvent(cb: (e: EngineEvent) => void): void {
    this.cbs.push(cb);
  }
  async stop(): Promise<void> {}
  private emit(e: EngineEvent): void {
    for (const cb of this.cbs) cb(e);
  }
}

interface InProc {
  url: string;
  engine: TurnEngine;
  spawns: number[];
  done: Promise<number>;
  spec: HostSpec;
}

async function startHost(o: { stateDir?: string; kind?: 'desk' | 'lane'; runId?: string; installed: () => string }): Promise<InProc> {
  const stateDir = o.stateDir ?? tmpDir();
  const spec: HostSpec = {
    stack: 'auto', stateDir, name: o.kind === 'lane' ? 'scout' : 'ALPHA', kind: o.kind ?? 'desk', role: 'orchestrator', roleFiles: [],
    agent: 'claude', engine: 'driver', mcps: [], port: 0, cwd: stateDir, runId: o.runId ?? 'run-a', token: TOKEN,
  };
  const engine = new TurnEngine();
  const spawns: number[] = [];
  let url = '';
  const deps: HostDeps = {
    createEngine: async () => engine,
    createHostMeter: () => ({ begin() {}, usage() {}, heartbeat() {}, overBudget: () => false, finish() {}, totals: () => ({ costUsd: null, inputTokens: 0, outputTokens: 0 }) }),
    installSignals: false,
    onReady: (i) => (url = i.url),
    env: {},
    versionWatcher: { pollMs: 50, settleMs: 50, running: '1.0.0', probe: async () => o.installed(), spawn: () => (spawns.push(Date.now()), 4242) },
  };
  const done = runHost(spec, deps);
  await waitFor(async () => (url !== '' ? (await hostHealth(url))?.state === 'idle' : false), 'host idle');
  return { url, engine, spawns, done, spec };
}
const stop = async (h: InProc) => {
  await hostStop({ url: h.url, token: TOKEN });
  await h.done;
};

describe('auto reload after an ach upgrade: host watcher (in-process)', () => {
  it('compareVersions orders dotted versions numerically', () => {
    assert.equal(compareVersions('0.30.0', '0.30.0'), 0);
    assert.equal(compareVersions('0.30.1', '0.30.0'), 1);
    assert.equal(compareVersions('0.9.0', '0.10.0'), -1);
    assert.equal(compareVersions('1.0.0-rc.1', '1.0.0'), 0);
  });

  it('the default probe runs `<achSelfArgv> --version` (no ACH_DESK_VERSION_PROBE) and reads the version', async () => {
    const env = { PATH: process.env.PATH, ACH_SELF_ARGV: JSON.stringify([join(ROOT, 'node_modules', '.bin', 'tsx'), join(ROOT, 'src', 'cli', 'ach.ts')]) };
    assert.equal(await probeInstalledVersion(env), VERSION);
    assert.equal(await probeInstalledVersion({ ...env, ACH_SELF_ARGV: JSON.stringify(['/nonexistent/ach']) }), null, 'unreadable -> null (no reload)');
  });

  it('with no interval tick in between, going idle (nudge) is what fires the waiting reload', async () => {
    let idle = false;
    const spawns: number[] = [];
    const lines: string[] = [];
    const spec: HostSpec = {
      stack: 'auto', stateDir: tmpDir(), name: 'ALPHA', kind: 'desk', role: 'orchestrator', roleFiles: [],
      agent: 'claude', engine: 'driver', mcps: [], port: 0, cwd: '/', runId: 'run-n',
    };
    const w = startVersionWatcher({ spec, running: '1.0.0', pollMs: 0, settleMs: 20, isIdle: () => idle, probe: async () => '1.1.0', spawn: () => (spawns.push(1), 1), log: (l) => void lines.push(l) });
    try {
      await w.tick(); // the one poll: busy
      assert.equal(spawns.length, 0);
      assert.match(lines.join('\n'), /reloading once ALPHA is idle/);
      idle = true;
      w.nudge();
      await waitFor(() => spawns.length === 1, 'spawn after nudge', 2000);
      w.nudge(); // nothing pending any more
      await sleep(100);
      assert.equal(spawns.length, 1);
    } finally {
      w.stop();
    }
  });

  it('installed version not newer -> no reload', async () => {
    const h = await startHost({ installed: () => '1.0.0' });
    try {
      await sleep(400);
      assert.equal(h.spawns.length, 0);
      assert.equal(existsSync(autoReloadMarkFile(h.spec)), false);
    } finally {
      await stop(h);
    }
  });

  it('version changed -> an idle desk is reloaded once (one spawn, marked with this run), not on every poll', async () => {
    const h = await startHost({ installed: () => '1.1.0' });
    try {
      await waitFor(() => h.spawns.length > 0, 'reload spawned');
      await sleep(500); // ~10 more polls
      assert.equal(h.spawns.length, 1, 'spawned once');
      assert.deepEqual({ ...readAutoReloadMark(h.spec), at: 0 }, { version: '1.1.0', runId: 'run-a', attempts: 1, at: 0 });
    } finally {
      await stop(h);
    }
  });

  it('a busy desk waits: no reload while its turn runs or a message is queued, one reload once it is idle', async () => {
    let installed = '1.0.0';
    const h = await startHost({ installed: () => installed });
    try {
      await hostSend({ url: h.url, token: TOKEN }, 'human', 'long turn');
      await hostSend({ url: h.url, token: TOKEN }, 'human', 'queued');
      installed = '1.1.0'; // upgraded mid-turn
      await sleep(500);
      assert.equal(h.spawns.length, 0, 'busy: not reloaded');
      h.engine.finishTurn(); // the queued message starts the next turn at once
      await sleep(300);
      assert.equal(h.spawns.length, 0, 'still busy with the queued message');
      h.engine.finishTurn();
      await waitFor(() => h.spawns.length > 0, 'reload once idle');
      await sleep(300);
      assert.equal(h.spawns.length, 1);
    } finally {
      await stop(h);
    }
  });

  it('a lane is never reloaded', async () => {
    const h = await startHost({ kind: 'lane', installed: () => '9.0.0' });
    try {
      await sleep(400);
      assert.equal(h.spawns.length, 0);
    } finally {
      await stop(h);
    }
  });

  it('the host that came back from the reload (another run id) does not reload again for the same version', async () => {
    const stateDir = tmpDir();
    const first = await startHost({ stateDir, runId: 'run-old', installed: () => '1.1.0' });
    try {
      await waitFor(() => first.spawns.length > 0, 'first reload');
    } finally {
      await stop(first);
    }
    const second = await startHost({ stateDir, runId: 'run-new', installed: () => '1.1.0' });
    try {
      await sleep(400);
      assert.equal(second.spawns.length, 0, 'already reloaded once for 1.1.0');
    } finally {
      await stop(second);
    }
  });
});

// ---------------------------------------------------------------------------
// Part 2: real hosts, real detached `ach desk reload`
// ---------------------------------------------------------------------------

describe('auto reload after an ach upgrade: real hosts', () => {
  it('every desk reloads once on its own (same port and session, new run), the lane keeps its run, and it is logged', { timeout: 180_000 }, async () => {
    const sd = tmpDir();
    const stack = 'p6360';
    const versionFile = join(sd, 'installed-version');
    writeFileSync(versionFile, VERSION);
    const saved = { ...process.env };
    process.env.ACH_SELF_ARGV = JSON.stringify([join(ROOT, 'node_modules', '.bin', 'tsx'), join(ROOT, 'src', 'cli', 'ach.ts')]);
    process.env.ACH_DESK_FAKE_ENGINE = '1';
    process.env.AGENTIC_CODING_HARNESS_STATE_DIR = sd;
    process.env.ACH_DESK_VERSION_POLL_MS = '300';
    process.env.ACH_DESK_VERSION_PROBE = JSON.stringify([process.execPath, '-e', `process.stdout.write(require("fs").readFileSync(${JSON.stringify(versionFile)}, "utf8"))`]);
    delete process.env.ACH_DESK_NAME;
    delete process.env.ACH_DESK_STACK;
    const layout = join(sd, 'desks.yaml');
    writeFileSync(layout, JSON.stringify({
      portBase: 6360, agent: 'opencode',
      desks: [{ name: 'ORCHESTRATOR', role: 'orchestrator', mcps: [] }, { name: 'DECISIONS', role: 'decisions', mcps: [] }],
      lanes: { defaultMcps: [], ports: [10, 14], approval: 'none' },
    }));
    try {
      await deskUp({ stateDir: sd, stack, layoutFile: layout, term: 'none' });
      const lane = await laneNew({ stateDir: sd, stack, name: 'audit', goal: 'look around', launchedBy: 'human' });
      assert.ok(!('pending' in lane));
      const before = readRoster(sd, stack).entries;
      await sleep(1000);
      assert.equal(readRoster(sd, stack).entries.ORCHESTRATOR!.runId, before.ORCHESTRATOR!.runId, 'same version installed: nothing happens');

      writeFileSync(versionFile, '999.0.0'); // "upgrade"
      const desks = ['ORCHESTRATOR', 'DECISIONS'];
      await waitFor(() => desks.every((n) => { const e = readRoster(sd, stack).entries[n]; return e !== undefined && e.runId !== before[n]!.runId; }), 'both desks reloaded', 90_000);
      const mid = readRoster(sd, stack).entries;
      for (const n of desks) {
        const e = mid[n] as RosterEntry;
        await waitFor(async () => (await hostHealth({ url: e.url, token: readHostToken(sd, stack, n, e.runId) }, 2000))?.runId === e.runId, `${n} new host answers`, 20_000);
        const h = await hostHealth({ url: e.url, token: readHostToken(sd, stack, n, e.runId) }, 2000);
        assert.equal(e.port, before[n]!.port, `${n} same port`);
        assert.equal(h?.sessionId, `echo-${before[n]!.runId}`, `${n} kept its session`);
      }
      await sleep(3000); // ~10 polls of the new hosts, which still see 999.0.0 > their own version
      const end = readRoster(sd, stack).entries;
      for (const n of desks) assert.equal(end[n]!.runId, mid[n]!.runId, `${n} reloaded only once`);
      assert.equal(end.audit!.runId, before.audit!.runId, 'lane untouched');
      assert.equal(end.audit!.pid, before.audit!.pid, 'lane process untouched');
      const logs = deskPaths(sd, stack).logs;
      assert.match(readFileSync(join(logs, 'ORCHESTRATOR.log'), 'utf8'), /auto-reload: installed ach 999\.0\.0 is newer than this host's .* spawned `ach desk reload ORCHESTRATOR`/);
      assert.match(readFileSync(join(logs, 'ORCHESTRATOR.log'), 'utf8'), /already reloaded once for installed ach 999\.0\.0/);
      assert.match(readFileSync(join(logs, 'ORCHESTRATOR.auto-reload.log'), 'utf8'), /ORCHESTRATOR: reloaded on port 6361, session echo-/);
      assert.equal(existsSync(join(logs, 'audit.auto-reload.log')), false);
    } finally {
      await deskDown({ stateDir: sd, stack });
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
      Object.assign(process.env, saved);
    }
  });
});
