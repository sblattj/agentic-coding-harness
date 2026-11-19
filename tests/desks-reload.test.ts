// `ach desk reload` (service deskReload): a desk's host restarts on the same port with the same
// engine and agent session, lanes are never touched by --all, a busy desk is refused unless forced,
// and a tmux pane ach opened is respawned in place (same pane id). Real hosts on the fake engine
// (ACH_DESK_FAKE_ENGINE=1, which honors HostSpec.resumeSessionId like the real engines), the busy
// stub host (tests/support/stub-busy-host.mjs) for the busy case, ports 6300..6389.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, describe, it } from 'node:test';
import { cmdDesk } from '../src/cli/desk.ts';
import { hostHealth } from '../src/desks/host-client.ts';
import { deskPaths, readHostToken, readRoster, updateRoster } from '../src/desks/roster.ts';
import { deskDown, deskInbox, deskReload, deskReloadStale, deskSend, deskSwitchEngine, deskUp, laneNew } from '../src/desks/service.ts';
import type { HostHealth, HostSpec, RosterEntry } from '../src/desks/types.ts';

const ROOT = resolve(import.meta.dirname, '..');
const SELF = JSON.stringify([join(ROOT, 'node_modules', '.bin', 'tsx'), join(ROOT, 'src', 'cli', 'ach.ts')]);
process.env.ACH_SELF_ARGV = SELF;
process.env.ACH_DESK_FAKE_ENGINE = '1';
delete process.env.ACH_DESK_STACK;
delete process.env.ACH_DESK_NAME;
const ENV_STATE = mkdtempSync(join(tmpdir(), 'ach-desks-reload-env-'));
process.env.AGENTIC_CODING_HARNESS_STATE_DIR = ENV_STATE;

const roots: string[] = [ENV_STATE];
after(() => {
  for (const d of roots) rmSync(d, { recursive: true, force: true });
});
function tmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'ach-desks-reload-'));
  roots.push(d);
  return d;
}

function layoutFile(sd: string, portBase: number): string {
  const f = join(sd, 'desks.yaml');
  writeFileSync(
    f,
    JSON.stringify({
      portBase,
      agent: 'opencode',
      desks: [
        { name: 'ORCHESTRATOR', role: 'orchestrator', mcps: [] },
        { name: 'DECISIONS', role: 'decisions', mcps: [] },
      ],
      lanes: { defaultMcps: [], ports: [10, 14], approval: 'none' },
    }),
  );
  return f;
}

const FEED = [process.execPath, '-e', 'setInterval(() => process.stdout.write(JSON.stringify({ type: "alive" }) + "\\n"), 300)'];

/** Like layoutFile plus a LISTENER whose feed activeCheck reads <sd>/active.json (a call is live). */
function liveLayoutFile(sd: string, portBase: number): string {
  writeFileSync(join(sd, 'active.json'), JSON.stringify({ active: true }));
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

async function waitIdle(sd: string, stack: string, e: RosterEntry): Promise<HostHealth> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const h = await health(sd, stack, e);
    if (h !== null && h.state === 'idle' && h.queueDepth === 0) return h;
    if (Date.now() > deadline) throw new Error(`${e.name} never went idle: ${JSON.stringify(h)}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

const spec = (sd: string, stack: string, name: string): HostSpec => JSON.parse(readFileSync(join(deskPaths(sd, stack).specs, `${name}.json`), 'utf8')) as HostSpec;

describe('desk reload: control', () => {
  it('`ach desk reload` is a known subcommand (base: "unknown subcommand", exit 2) and an unknown desk is refused', async () => {
    const sd = tmpDir();
    const err: string[] = [];
    const rc = await cmdDesk(['reload', 'NOPE', '--stack', 'p6399'], {
      stderr: (s) => void err.push(s),
      stdout: () => undefined,
      env: { AGENTIC_CODING_HARNESS_STATE_DIR: sd },
      service: { ...(await import('../src/desks/service.ts')), deskReload: (o: Parameters<typeof deskReload>[0]) => deskReload({ ...o, stateDir: sd }) },
    });
    assert.equal(rc, 1, err.join(''));
    assert.match(err.join(''), /unknown desk "NOPE"/);
    assert.doesNotMatch(err.join(''), /unknown subcommand/);
    await assert.rejects(deskReload({ stateDir: sd, stack: 'p6399' }), /a desk name or all/);
    await assert.rejects(deskReload({ stateDir: sd, stack: 'p6399', name: 'ORCHESTRATOR', all: true }), /a desk name or all/);
  });
});

describe('desk reload on fake-engine hosts', () => {
  it('acceptance 1: same port, new host process, the agent session id is kept and was handed to the engine; the marker message stays', { timeout: 120_000 }, async () => {
    const sd = tmpDir();
    const stack = 'p6300';
    await deskUp({ stateDir: sd, stack, layoutFile: layoutFile(sd, 6300), term: 'none' });
    try {
      const before = readRoster(sd, stack).entries.ORCHESTRATOR!;
      const marker = `MARKER-${Date.now()}`;
      await deskSend({ stateDir: sd, stack, from: 'human', to: 'ORCHESTRATOR', text: marker });
      const h0 = await waitIdle(sd, stack, before);
      assert.equal(h0.sessionId, `echo-${before.runId}`, 'fake engine session before the reload');

      // A roster goal the spec does not carry (set after the desk started) survives the reload.
      await updateRoster(sd, stack, (ro) => {
        ro.entries.ORCHESTRATOR!.goal = 'ROSTER-GOAL';
      });
      const [r] = await deskReload({ stateDir: sd, stack, name: 'ORCHESTRATOR' });
      assert.ok(r, 'one result');
      assert.equal(r.ok, true, JSON.stringify(r));
      assert.equal(r.resumed, true, JSON.stringify(r));
      assert.equal(r.previousSessionId, h0.sessionId);
      assert.equal(r.sessionId, h0.sessionId);
      assert.equal(r.note, undefined);

      const after = readRoster(sd, stack).entries.ORCHESTRATOR!;
      assert.notEqual(after.runId, before.runId, 'a new run');
      assert.equal(after.port, before.port, 'same port');
      assert.notEqual(after.pid, before.pid, 'a new host process (fresh code)');
      assert.equal(after.engine, before.engine);
      assert.equal(after.agent, before.agent);
      assert.equal(after.goal, 'ROSTER-GOAL', 'roster goal kept');
      assert.equal(spec(sd, stack, 'ORCHESTRATOR').resumeSessionId, h0.sessionId, 'the engine was asked to resume the old session');
      const h1 = await health(sd, stack, after);
      assert.equal(h1?.runId, after.runId);
      assert.equal(h1?.sessionId, h0.sessionId, 'the new host runs the old session, not echo-<new runId>');
      assert.notEqual(h1?.sessionId, `echo-${after.runId}`);
      assert.equal(await health(sd, stack, { ...before, runId: before.runId }).then((h) => h?.runId === before.runId), false, 'old host gone');

      const inbox = await deskInbox({ stateDir: sd, stack, name: 'ORCHESTRATOR' });
      assert.ok(inbox.some((m) => m.text === marker), 'marker message kept');
      // The desk still takes turns after the reload.
      await deskSend({ stateDir: sd, stack, from: 'human', to: 'ORCHESTRATOR', text: 'after' });
      await waitIdle(sd, stack, after);
      const other = readRoster(sd, stack).entries.DECISIONS!;
      assert.equal((await health(sd, stack, other))?.runId, other.runId, 'the other desk untouched');
    } finally {
      await deskDown({ stateDir: sd, stack });
    }
  });

  it('role files are resolved again by the reloading ach (a saved path from an older install is replaced), so new roles reach the resumed session', { timeout: 120_000 }, async () => {
    const sd = tmpDir();
    const stack = 'p6350';
    await deskUp({ stateDir: sd, stack, layoutFile: layoutFile(sd, 6350), term: 'none' });
    try {
      const current = spec(sd, stack, 'ORCHESTRATOR').roleFiles;
      // An older install's built-in roles (a versioned install dir) in the spec the host started with.
      const oldDir = join(tmpDir(), 'old-install', 'roles');
      const stale = { ...spec(sd, stack, 'ORCHESTRATOR'), roleFiles: [join(oldDir, 'common.md'), join(oldDir, 'orchestrator.md')] };
      writeFileSync(join(deskPaths(sd, stack).specs, 'ORCHESTRATOR.json'), JSON.stringify(stale));
      const [r] = await deskReload({ stateDir: sd, stack, name: 'ORCHESTRATOR' });
      assert.equal(r?.ok, true, JSON.stringify(r));
      assert.deepEqual(spec(sd, stack, 'ORCHESTRATOR').roleFiles, current, 'the reloaded host gets the roles this ach resolves');
    } finally {
      await deskDown({ stateDir: sd, stack });
    }
  });

  it('desk engine resolves the role files again with this ach (a saved path from an older install is replaced), like reload and desk on', { timeout: 120_000 }, async () => {
    const sd = tmpDir();
    const stack = 'p6380';
    await deskUp({ stateDir: sd, stack, layoutFile: layoutFile(sd, 6380), term: 'none' });
    try {
      const current = spec(sd, stack, 'ORCHESTRATOR').roleFiles;
      const oldDir = join(tmpDir(), 'old-install', 'roles');
      const stale = { ...spec(sd, stack, 'ORCHESTRATOR'), roleFiles: [join(oldDir, 'common.md'), join(oldDir, 'orchestrator.md')] };
      writeFileSync(join(deskPaths(sd, stack).specs, 'ORCHESTRATOR.json'), JSON.stringify(stale));
      const e = await deskSwitchEngine({ stateDir: sd, stack, name: 'ORCHESTRATOR', agent: 'claude' });
      assert.equal(e.agent, 'claude');
      assert.deepEqual(spec(sd, stack, 'ORCHESTRATOR').roleFiles, current, 'the switched host gets the roles this ach resolves');
    } finally {
      await deskDown({ stateDir: sd, stack });
    }
  });

  it('a live call on the desk feed refuses reload (name, --all, --stale) unless forced; the other desks still reload', { timeout: 240_000 }, async () => {
    const sd = tmpDir();
    const stack = 'p6385';
    await deskUp({ stateDir: sd, stack, layoutFile: liveLayoutFile(sd, 6385), term: 'none' });
    try {
      const before = readRoster(sd, stack).entries.LISTENER!;
      const refused = /refused: a call is live on LISTENER; pass --force to reload anyway/;
      await assert.rejects(deskReload({ stateDir: sd, stack, name: 'LISTENER' }), refused);
      assert.equal((await health(sd, stack, before))?.runId, before.runId, 'old host untouched');

      await updateRoster(sd, stack, (ro) => {
        for (const e of Object.values(ro.entries)) e.achVersion = '0.0.1';
      });
      const stale = await deskReloadStale({ stateDir: sd, stack, by: 'human' });
      const ls = stale.find((r) => r.name === 'LISTENER');
      assert.match(ls?.skipped ?? '', refused, JSON.stringify(stale));
      assert.ok(stale.filter((r) => r.name !== 'LISTENER').every((r) => r.ok), JSON.stringify(stale));
      assert.equal(readRoster(sd, stack).entries.LISTENER!.runId, before.runId, 'stale: LISTENER not reloaded');

      const all = await deskReload({ stateDir: sd, stack, all: true });
      const la = all.find((r) => r.name === 'LISTENER');
      assert.match(la?.skipped ?? '', refused, JSON.stringify(all));
      assert.ok(all.filter((r) => r.name !== 'LISTENER').every((r) => r.ok), JSON.stringify(all));
      assert.equal(readRoster(sd, stack).entries.LISTENER!.runId, before.runId, 'all: LISTENER not reloaded');

      const [r] = await deskReload({ stateDir: sd, stack, name: 'LISTENER', force: true });
      assert.equal(r?.ok, true, JSON.stringify(r));
      const mid = readRoster(sd, stack).entries.LISTENER!;
      assert.notEqual(mid.runId, before.runId, 'forced: reloaded');

      await updateRoster(sd, stack, (ro) => {
        ro.entries.LISTENER!.achVersion = '0.0.1';
      });
      const forcedStale = await deskReloadStale({ stateDir: sd, stack, by: 'human', force: true });
      assert.equal(forcedStale.find((x) => x.name === 'LISTENER')?.ok, true, JSON.stringify(forcedStale));
      assert.notEqual(readRoster(sd, stack).entries.LISTENER!.runId, mid.runId, 'forced stale: reloaded');

      writeFileSync(join(sd, 'active.json'), JSON.stringify({ active: false }));
      const [r2] = await deskReload({ stateDir: sd, stack, name: 'LISTENER' });
      assert.equal(r2?.ok, true, 'no call: reloads without force');
    } finally {
      await deskDown({ stateDir: sd, stack });
    }
  });

  it('acceptance 5: --all reloads every desk and no lane; a calling desk is skipped, a lane by name is refused', { timeout: 180_000 }, async () => {
    const sd = tmpDir();
    const stack = 'p6310';
    await deskUp({ stateDir: sd, stack, layoutFile: layoutFile(sd, 6310), term: 'none' });
    try {
      const lane = await laneNew({ stateDir: sd, stack, name: 'audit', goal: 'look around', launchedBy: 'human' });
      assert.ok(!('pending' in lane), 'approval none starts the lane');
      const before = readRoster(sd, stack).entries;
      const laneBefore = before.audit!;
      const rs = await deskReload({ stateDir: sd, stack, all: true });
      assert.deepEqual(rs.map((r) => [r.name, r.ok, r.resumed]).sort(), [['DECISIONS', true, true], ['ORCHESTRATOR', true, true]]);
      const after = readRoster(sd, stack).entries;
      assert.notEqual(after.ORCHESTRATOR!.runId, before.ORCHESTRATOR!.runId);
      assert.notEqual(after.DECISIONS!.runId, before.DECISIONS!.runId);
      assert.equal(after.audit!.runId, laneBefore.runId, 'lane run unchanged');
      assert.equal(after.audit!.pid, laneBefore.pid, 'lane process unchanged');
      assert.equal((await health(sd, stack, laneBefore))?.runId, laneBefore.runId, 'lane host still answering');

      await assert.rejects(deskReload({ stateDir: sd, stack, name: 'audit' }), /is a lane/);
      await assert.rejects(deskReload({ stateDir: sd, stack, name: 'ORCHESTRATOR', by: 'ORCHESTRATOR' }), /cannot reload itself/);
      const mid = readRoster(sd, stack).entries;
      const rs2 = await deskReload({ stateDir: sd, stack, all: true, by: 'ORCHESTRATOR' });
      assert.deepEqual(
        rs2.map((r) => [r.name, r.ok, r.skipped !== undefined]),
        [['ORCHESTRATOR', false, true], ['DECISIONS', true, false]],
      );
      const end = readRoster(sd, stack).entries;
      assert.equal(end.ORCHESTRATOR!.runId, mid.ORCHESTRATOR!.runId, 'the caller was not reloaded');
      assert.notEqual(end.DECISIONS!.runId, mid.DECISIONS!.runId);
      assert.equal(end.audit!.runId, laneBefore.runId);
    } finally {
      await deskDown({ stateDir: sd, stack });
    }
  });

  it('acceptance 4: a busy desk is refused without force (host untouched) and reloaded with it', { timeout: 120_000 }, async () => {
    const sd = tmpDir();
    const stack = 'p6320';
    process.env.ACH_SELF_ARGV = JSON.stringify([process.execPath, join(ROOT, 'tests', 'support', 'stub-busy-host.mjs')]);
    try {
      await deskUp({ stateDir: sd, stack, layoutFile: layoutFile(sd, 6320), term: 'none' });
      const before = readRoster(sd, stack).entries.ORCHESTRATOR!;
      const deadline = Date.now() + 5000;
      while ((await health(sd, stack, before))?.state !== 'busy' && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
      assert.equal((await health(sd, stack, before))?.state, 'busy');

      await assert.rejects(deskReload({ stateDir: sd, stack, name: 'ORCHESTRATOR' }), /ORCHESTRATOR is busy \(state busy/);
      assert.equal(readRoster(sd, stack).entries.ORCHESTRATOR!.runId, before.runId, 'not reloaded');
      assert.equal((await health(sd, stack, before))?.runId, before.runId, 'old host still up');
      const all = await deskReload({ stateDir: sd, stack, all: true });
      assert.ok(all.every((r) => !r.ok && /is busy/.test(r.error ?? '')), JSON.stringify(all));

      const [r] = await deskReload({ stateDir: sd, stack, name: 'ORCHESTRATOR', force: true });
      assert.equal(r?.ok, true, JSON.stringify(r));
      assert.equal(r?.resumed, false, 'the stub reports no session');
      assert.match(r?.note ?? '', /no agent session to resume/);
      const after = readRoster(sd, stack).entries.ORCHESTRATOR!;
      assert.notEqual(after.runId, before.runId);
      assert.equal(after.port, before.port);
      assert.equal((await health(sd, stack, after))?.runId, after.runId);
    } finally {
      await deskDown({ stateDir: sd, stack });
      process.env.ACH_SELF_ARGV = SELF;
    }
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

describe('desk reload keeps the tmux pane', { skip: hasTmux ? false : 'tmux not installed' }, () => {
  it('acceptance 2: the pane id is unchanged, its process was respawned, and remain-on-exit is cleared again', { timeout: 180_000 }, async () => {
    const sd = tmpDir();
    const stack = 'p6330';
    const sock = `ach-reload-${process.pid}`;
    const tm = (...a: string[]): string => execFileSync('tmux', ['-L', sock, ...a], { encoding: 'utf8' });
    // The panes run `ach desk chat <name>` with the tmux server's env (started by deskUp below from
    // this process): point its default state dir at this stack, or the chat exits and the pane closes.
    process.env.AGENTIC_CODING_HARNESS_STATE_DIR = sd;
    await deskUp({ stateDir: sd, stack, layoutFile: layoutFile(sd, 6330), term: 'tmux', tmuxSocket: sock });
    try {
      const before = readRoster(sd, stack).entries.ORCHESTRATOR!;
      const pane = before.terminal?.id;
      assert.match(pane ?? '', /^%\d+$/, 'desk has a tmux pane');
      await new Promise((r) => setTimeout(r, 3000)); // a pane whose command fails closes within this
      const panesBefore = tm('list-panes', '-a', '-F', '#{pane_id}').trim().split('\n').sort();
      const pidBefore = tm('display-message', '-p', '-t', pane!, '#{pane_pid}').trim();
      assert.equal(tm('display-message', '-p', '-t', pane!, '#{pane_dead}').trim(), '0', 'pane command running before the reload');

      const [r] = await deskReload({ stateDir: sd, stack, name: 'ORCHESTRATOR' });
      assert.equal(r?.ok, true, JSON.stringify(r));
      const after = readRoster(sd, stack).entries.ORCHESTRATOR!;
      assert.deepEqual(after.terminal, before.terminal, 'roster keeps the same pane');
      assert.deepEqual(tm('list-panes', '-a', '-F', '#{pane_id}').trim().split('\n').sort(), panesBefore, 'no pane closed or opened');
      assert.notEqual(tm('display-message', '-p', '-t', pane!, '#{pane_pid}').trim(), pidBefore, 'pane process respawned');
      assert.equal(tm('show-options', '-p', '-t', pane!, '-v', 'remain-on-exit').trim(), '', 'remain-on-exit unset after the reload');
      await new Promise((r) => setTimeout(r, 3000));
      assert.equal(tm('display-message', '-p', '-t', pane!, '#{pane_dead}').trim(), '0', 'respawned pane command still running');
    } finally {
      process.env.AGENTIC_CODING_HARNESS_STATE_DIR = ENV_STATE;
      await deskDown({ stateDir: sd, stack });
      try {
        tm('kill-server');
      } catch {
        /* already gone */
      }
    }
  });

  it('a roster ref whose ownership token does not match the pane is never held or respawned', { timeout: 180_000 }, async () => {
    const sd = tmpDir();
    const stack = 'p6340';
    const sock = `ach-reload-stale-${process.pid}`;
    const tm = (...a: string[]): string => execFileSync('tmux', ['-L', sock, ...a], { encoding: 'utf8' });
    process.env.AGENTIC_CODING_HARNESS_STATE_DIR = sd;
    await deskUp({ stateDir: sd, stack, layoutFile: layoutFile(sd, 6340), term: 'tmux', tmuxSocket: sock });
    try {
      const pane = readRoster(sd, stack).entries.ORCHESTRATOR!.terminal?.id;
      assert.match(pane ?? '', /^%\d+$/, 'desk has a tmux pane');
      // Make the pane someone else's: its own command and its own remain-on-exit setting, and a
      // stored ref whose token does not match it (as after a tmux server restart reused the id).
      tm('respawn-pane', '-k', '-t', pane!, 'sleep 600');
      tm('set-option', '-p', '-t', pane!, 'remain-on-exit', 'failed');
      const pidBefore = tm('display-message', '-p', '-t', pane!, '#{pane_pid}').trim();
      await updateRoster(sd, stack, (ro) => {
        ro.entries.ORCHESTRATOR!.terminal = { ...ro.entries.ORCHESTRATOR!.terminal!, token: 'not-ours' };
      });
      const [r] = await deskReload({ stateDir: sd, stack, name: 'ORCHESTRATOR' });
      assert.equal(r?.ok, true, JSON.stringify(r));
      assert.equal(tm('display-message', '-p', '-t', pane!, '#{pane_pid}').trim(), pidBefore, 'the stranger pane was not respawned');
      assert.equal(tm('show-options', '-p', '-t', pane!, '-v', 'remain-on-exit').trim(), 'failed', "the stranger pane's remain-on-exit is untouched");
      assert.notEqual(readRoster(sd, stack).entries.ORCHESTRATOR!.terminal?.id, undefined, 'the desk still has a pane');
    } finally {
      process.env.AGENTIC_CODING_HARNESS_STATE_DIR = ENV_STATE;
      await deskDown({ stateDir: sd, stack });
      try {
        tm('kill-server');
      } catch {
        /* already gone */
      }
    }
  });
});
