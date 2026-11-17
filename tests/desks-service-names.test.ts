// Name safety in src/desks: stack names, desk/lane names from callers, case-insensitive
// collisions, the reserved "human" name, and concurrent lane starts (fake-engine hosts,
// ACH_DESK_FAKE_ENGINE=1, ports 6200..). No terminal.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, describe, it } from 'node:test';
import { parseLayout } from '../src/desks/config.ts';
import { deskPaths, putEntry, readRoster, validStackName } from '../src/desks/roster.ts';
import { deskEvents, deskSwitchEngine, laneApprove, laneNew, laneStop, resolveStack } from '../src/desks/service.ts';
import type { PendingLane, RosterEntry } from '../src/desks/types.ts';

const ROOT = resolve(import.meta.dirname, '..');
process.env.ACH_SELF_ARGV = JSON.stringify([join(ROOT, 'node_modules', '.bin', 'tsx'), join(ROOT, 'src', 'cli', 'ach.ts')]);
process.env.ACH_DESK_FAKE_ENGINE = '1';
delete process.env.ACH_DESK_STACK;
const ENV_STATE = mkdtempSync(join(tmpdir(), 'ach-desks-names-env-'));
process.env.AGENTIC_CODING_HARNESS_STATE_DIR = ENV_STATE;

const tmpRoots: string[] = [ENV_STATE];
after(() => {
  for (const d of tmpRoots) rmSync(d, { recursive: true, force: true });
});
function tmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'ach-desks-names-'));
  tmpRoots.push(d);
  return d;
}

function entry(name: string, over: Partial<RosterEntry> = {}): RosterEntry {
  return {
    name,
    kind: 'desk',
    role: 'orchestrator',
    agent: 'opencode',
    engine: 'opencode',
    mcps: [],
    port: 1,
    url: 'http://127.0.0.1:1',
    pid: 999_999_9,
    runId: `run-${name}`,
    cwd: '/tmp',
    startedAt: 1,
    ...over,
  };
}

function hostPids(dir: string): number[] {
  try {
    const out = execFileSync('pgrep', ['-f', `desk host --spec ${dir}`], { encoding: 'utf8', timeout: 5000 }).trim();
    return out ? out.split('\n').map(Number) : [];
  } catch {
    return [];
  }
}

function killHosts(dir: string): void {
  for (const pid of hostPids(dir)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* gone */
    }
  }
}

const PORT_BASE = 6200;
function setupStack(approval: 'decisions' | 'none'): { sd: string; stack: string } {
  const sd = tmpDir();
  const stack = 'p6200';
  const layout = parseLayout(
    JSON.stringify({
      portBase: PORT_BASE,
      agent: 'opencode',
      desks: [
        { name: 'ORCHESTRATOR', role: 'orchestrator', mcps: [] },
        { name: 'DECISIONS', role: 'decisions', mcps: [] },
      ],
      lanes: { defaultMcps: [], ports: [10, 19], approval },
    }),
    'inline',
  );
  const p = deskPaths(sd, stack);
  mkdirSync(p.root, { recursive: true });
  writeFileSync(p.layout, JSON.stringify(layout));
  return { sd, stack };
}

describe('stack names are validated', () => {
  it('resolveStack and deskPaths refuse a stack that is not a simple name, from every source', async () => {
    const sd = tmpDir();
    assert.equal(validStackName('p5900'), true);
    assert.equal(validStackName('my.stack-1'), true);
    for (const bad of ['../../x', '..', '.hidden', 'a/b', 'a\\b', '']) assert.equal(validStackName(bad), false, bad);
    assert.throws(() => resolveStack({ stateDir: sd, stack: '../../x' }), /invalid stack name/);
    assert.throws(() => deskPaths(sd, '../../x'), /invalid stack name/);
    process.env.ACH_DESK_STACK = '../env';
    try {
      assert.throws(() => resolveStack({ stateDir: sd }), /invalid stack name/);
    } finally {
      delete process.env.ACH_DESK_STACK;
    }
    mkdirSync(join(sd, 'desks'), { recursive: true });
    writeFileSync(join(sd, 'desks', 'active-stack'), '../file\n');
    assert.throws(() => resolveStack({ stateDir: sd }), /invalid stack name/);
    rmSync(join(sd, 'desks', 'active-stack'));
    await assert.rejects(laneNew({ stateDir: sd, stack: '../../x', name: 'l1', goal: 'g', launchedBy: 'human' }), /invalid stack name/);
    assert.deepEqual(readdirSync(sd), ['desks'], 'nothing written outside <stateDir>/desks');
    assert.throws(() => parseLayout(JSON.stringify({ stack: '../x', desks: [] }), 'inline'), /stack/);
  });
});

describe('desk/lane names reaching file paths', () => {
  it('deskEvents refuses a path-shaped name and a path-shaped spec runId', async () => {
    const { sd, stack } = setupStack('none');
    const p = deskPaths(sd, stack);
    // desks/evil.json is what specs/../../evil.json resolves to
    writeFileSync(join(sd, 'desks', 'evil.json'), JSON.stringify({ runId: 'r1' }));
    mkdirSync(p.events, { recursive: true });
    writeFileSync(join(p.events, 'r1.jsonl'), `${JSON.stringify({ seq: 1, at: 1, runId: 'r1', name: 'x', type: 'text', data: { text: 'leak' } })}\n`);
    await assert.rejects(deskEvents({ stateDir: sd, stack, name: '../../evil' }), /invalid desk or lane name/);
    // a spec whose runId climbs out of events/
    mkdirSync(p.specs, { recursive: true });
    writeFileSync(join(p.specs, 'good.json'), JSON.stringify({ runId: '../../secret' }));
    writeFileSync(join(sd, 'desks', 'secret.jsonl'), `${JSON.stringify({ seq: 1, at: 1, runId: 's', name: 'x', type: 'text', data: { text: 'leak' } })}\n`);
    await assert.rejects(deskEvents({ stateDir: sd, stack, name: 'good' }), /invalid run id/);
  });

  it('deskSwitchEngine refuses a path-shaped name before touching the disk', async () => {
    const { sd, stack } = setupStack('none');
    await assert.rejects(deskSwitchEngine({ stateDir: sd, stack, name: '../../made/x', agent: 'opencode' }), /invalid desk or lane name/);
    assert.equal(existsSync(join(sd, 'desks', 'made')), false, 'no directory created outside specs/');
  });
});

describe('lane names collide ignoring case', () => {
  it('refuses a lane that matches a layout desk, a roster entry or a pending lane in another case', async () => {
    const { sd, stack } = setupStack('decisions');
    await assert.rejects(laneNew({ stateDir: sd, stack, name: 'orchestrator', goal: 'x', launchedBy: 'ORCHESTRATOR' }), /already in use/);
    await putEntry(sd, stack, entry('probe', { kind: 'lane', role: 'lane' }));
    await assert.rejects(laneNew({ stateDir: sd, stack, name: 'PROBE', goal: 'x', launchedBy: 'ORCHESTRATOR' }), /already in use/);
    const r = await laneNew({ stateDir: sd, stack, name: 'abc', goal: 'x', launchedBy: 'ORCHESTRATOR' });
    assert.ok('pending' in r);
    await assert.rejects(laneNew({ stateDir: sd, stack, name: 'ABC', goal: 'x', launchedBy: 'ORCHESTRATOR' }), /already pending/);
  });
});

describe('"human" is reserved', () => {
  it('refuses a lane or desk named human in any case', async () => {
    const { sd, stack } = setupStack('decisions');
    for (const name of ['human', 'Human', 'HUMAN']) {
      await assert.rejects(laneNew({ stateDir: sd, stack, name, goal: 'x', launchedBy: 'ORCHESTRATOR' }), /reserved/, name);
    }
    assert.throws(
      () => parseLayout(JSON.stringify({ desks: [{ name: 'HUMAN', role: 'orchestrator' }] }), 'inline'),
      /desks\[0\]\.name: .*reserved/,
    );
  });
});

describe('concurrent lane starts', () => {
  it('two laneNew calls with one name: exactly one starts, no host leaks', { timeout: 120_000 }, async () => {
    const { sd, stack } = setupStack('none');
    try {
      const rs = await Promise.allSettled([
        laneNew({ stateDir: sd, stack, name: 'twin', goal: 'g', launchedBy: 'human' }),
        laneNew({ stateDir: sd, stack, name: 'twin', goal: 'g', launchedBy: 'human' }),
      ]);
      const ok = rs.filter((r) => r.status === 'fulfilled');
      const bad = rs.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
      assert.equal(ok.length, 1, `exactly one start wins; got ${rs.map((r) => r.status).join(',')}`);
      assert.match(String(bad[0]?.reason), /already in use|being started/);
      const roster = readRoster(sd, stack);
      assert.deepEqual(Object.keys(roster.entries), ['twin']);
      assert.equal((roster as { starting?: unknown }).starting, undefined, 'reservation cleared');
      assert.equal(hostPids(sd).length > 0, true, 'the winner runs');
      await laneStop({ stateDir: sd, stack, name: 'twin', by: 'human', now: true });
      assert.deepEqual(hostPids(sd), [], 'no host left after stopping the one roster entry');
    } finally {
      killHosts(sd);
    }
  });

  it('laneApprove twice on one pending id: one starts, the other is refused', { timeout: 120_000 }, async () => {
    const { sd, stack } = setupStack('decisions');
    try {
      const r = await laneNew({ stateDir: sd, stack, name: 'twice', goal: 'g', launchedBy: 'ORCHESTRATOR' });
      const id = (r as { pending: PendingLane }).pending.id;
      const rs = await Promise.allSettled([
        laneApprove({ stateDir: sd, stack, id, by: 'DECISIONS' }),
        laneApprove({ stateDir: sd, stack, id, by: 'DECISIONS' }),
      ]);
      const ok = rs.filter((x) => x.status === 'fulfilled');
      const bad = rs.filter((x): x is PromiseRejectedResult => x.status === 'rejected');
      assert.equal(ok.length, 1, `exactly one approve wins; got ${rs.map((x) => x.status).join(',')}`);
      assert.match(String(bad[0]?.reason), /already (approving|approved)/);
      await laneStop({ stateDir: sd, stack, name: 'twice', by: 'human', now: true });
      assert.deepEqual(hostPids(sd), [], 'no host left');
      const last = readFileSync(deskPaths(sd, stack).pendingLanes, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as PendingLane);
      assert.equal(last.filter((p) => p.state === 'approved').length, 1, 'one approved record');
    } finally {
      killHosts(sd);
    }
  });
});
