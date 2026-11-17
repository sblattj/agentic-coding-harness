// src/desks/service.ts: pure parts (temp state dir) + the lane approval path on real
// fake-engine hosts (ACH_DESK_FAKE_ENGINE=1, ports 5900..). No terminal (term none).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, describe, it } from 'node:test';
import { writeRunRecord, type RunRecord } from '../src/core/registry.ts';
import { parseLayout } from '../src/desks/config.ts';
import { hostEvents, hostHealth } from '../src/desks/host-client.ts';
import { appendMessage, deskPaths, putEntry, readRoster } from '../src/desks/roster.ts';
import {
  decisionAnswer,
  decisionClose,
  decisionList,
  decisionOpen,
  deskCosts,
  deskInbox,
  deskRoster,
  deskSend,
  laneApprove,
  laneNew,
  laneReject,
  laneStatus,
  laneStop,
  resolveStack,
} from '../src/desks/service.ts';
import type { HostSpec, PendingLane, RosterEntry } from '../src/desks/types.ts';

const ROOT = resolve(import.meta.dirname, '..');
process.env.ACH_SELF_ARGV = JSON.stringify([join(ROOT, 'node_modules', '.bin', 'tsx'), join(ROOT, 'src', 'cli', 'ach.ts')]);
process.env.ACH_DESK_FAKE_ENGINE = '1';
delete process.env.ACH_DESK_STACK;
const ENV_STATE = mkdtempSync(join(tmpdir(), 'ach-desks-svc-env-'));
process.env.AGENTIC_CODING_HARNESS_STATE_DIR = ENV_STATE;

const tmpRoots: string[] = [ENV_STATE];
after(() => {
  for (const d of tmpRoots) rmSync(d, { recursive: true, force: true });
});
function tmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'ach-desks-svc-'));
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

function rec(runId: string, name: string, kind: 'desk' | 'lane' | 'turn', costUsd: number, input: number, parentRunId?: string, stack = 't'): RunRecord {
  return {
    runId,
    agent: 'claude',
    startedAt: Date.now(),
    status: 'success',
    desk: { stack, name, kind },
    ...(parentRunId ? { parentRunId } : {}),
    totals: { inputTokens: input, outputTokens: input * 2, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd },
  };
}

function pgrepStateDir(dir: string): string {
  try {
    return execFileSync('pgrep', ['-f', `desk host --spec ${dir}`], { encoding: 'utf8', timeout: 5000 }).trim();
  } catch {
    return '';
  }
}

function portFree(port: number): Promise<boolean> {
  return new Promise((r) => {
    const s = createServer();
    s.once('error', () => r(false));
    s.listen(port, '127.0.0.1', () => s.close(() => r(true)));
  });
}

describe('resolveStack', () => {
  it('explicit, then $ACH_DESK_STACK, then active-stack, then "default"', () => {
    const sd = tmpDir();
    assert.equal(resolveStack({ stateDir: sd }), 'default');
    mkdirSync(join(sd, 'desks'), { recursive: true });
    writeFileSync(join(sd, 'desks', 'active-stack'), 'p5900\n');
    assert.equal(resolveStack({ stateDir: sd }), 'p5900');
    process.env.ACH_DESK_STACK = 'fromenv';
    try {
      assert.equal(resolveStack({ stateDir: sd }), 'fromenv');
      assert.equal(resolveStack({ stateDir: sd, stack: 'explicit' }), 'explicit');
    } finally {
      delete process.env.ACH_DESK_STACK;
    }
  });
});

describe('deskSend refusals', () => {
  it('refuses self-send, unknown and dead targets, listing live names', async () => {
    const sd = tmpDir();
    await putEntry(sd, 't', entry('DEADDESK'));
    await assert.rejects(deskSend({ stateDir: sd, stack: 't', from: 'A', to: 'A', text: 'x' }), /cannot send to yourself/);
    await assert.rejects(deskSend({ stateDir: sd, stack: 't', from: 'human', to: 'NOPE', text: 'x' }), /unknown desk or lane "NOPE".*live: \(none\)/);
    await assert.rejects(deskSend({ stateDir: sd, stack: 't', from: 'human', to: 'DEADDESK', text: 'x' }), /DEADDESK is not running \(dead\)/);
    await assert.rejects(deskSend({ stateDir: sd, stack: 't', from: 'human', to: 'DEADDESK', text: '  ' }), /must not be empty/);
  });

  it('deskRoster prunes dead entries by default, keeps them with prune false', async () => {
    const sd = tmpDir();
    await putEntry(sd, 't', entry('DEADDESK'));
    const keep = await deskRoster({ stateDir: sd, stack: 't', prune: false, me: 'X' });
    assert.equal(keep.me, 'X');
    assert.deepEqual(keep.rows.map((r) => [r.name, r.state]), [['DEADDESK', 'dead']]);
    const v = await deskRoster({ stateDir: sd, stack: 't' });
    assert.equal(v.rows.length, 0);
    assert.deepEqual(readRoster(sd, 't').entries, {});
  });

  it('a dead entry with a fresh .switching marker (engine switch in flight) survives prune', async () => {
    const sd = tmpDir();
    await putEntry(sd, 't', entry('SWITCHING'));
    await putEntry(sd, 't', entry('GONE', { port: 2 }));
    mkdirSync(deskPaths(sd, 't').specs, { recursive: true });
    writeFileSync(join(deskPaths(sd, 't').specs, 'SWITCHING.switching'), '1\n');
    const v = await deskRoster({ stateDir: sd, stack: 't' });
    assert.deepEqual(v.rows.map((r) => [r.name, r.state]), [['SWITCHING', 'dead']]);
    rmSync(join(deskPaths(sd, 't').specs, 'SWITCHING.switching'));
    assert.equal((await deskRoster({ stateDir: sd, stack: 't' })).rows.length, 0, 'pruned once the marker is gone');
  });
});

describe('deskInbox', () => {
  it('filters by name and by an ABSOLUTE sinceMs, newest last, limit keeps the newest', async () => {
    const sd = tmpDir();
    const m = (id: string, from: string, to: string, at: number) => appendMessage(sd, 't', { id, from, to, text: id, at, delivered: 'now' });
    m('a', 'human', 'X', 1000);
    m('b', 'X', 'Y', 2000);
    m('c', 'Y', 'Z', 3000);
    assert.deepEqual((await deskInbox({ stateDir: sd, stack: 't' })).map((x) => x.id), ['a', 'b', 'c']);
    assert.deepEqual((await deskInbox({ stateDir: sd, stack: 't', name: 'X' })).map((x) => x.id), ['a', 'b']);
    assert.deepEqual((await deskInbox({ stateDir: sd, stack: 't', sinceMs: 2000 })).map((x) => x.id), ['b', 'c']);
    assert.deepEqual((await deskInbox({ stateDir: sd, stack: 't', limit: 1 })).map((x) => x.id), ['c']);
  });
});

describe('decisions lifecycle', () => {
  it('open -> list -> answer -> close; deliveries to dead/unknown targets never throw', async () => {
    const sd = tmpDir();
    const d = await decisionOpen({
      stateDir: sd,
      stack: 't',
      question: 'Ship it?',
      options: [{ label: 'no' }, { label: 'yes', recommended: true, reason: 'tests green' }],
      askedBy: 'lane-a',
      openedBy: 'DECISIONS',
    });
    assert.equal(d.id, 'D1');
    assert.equal(d.state, 'open');
    assert.deepEqual(d.options.map((o) => o.label), ['yes', 'no'], 'recommended first');
    const d2 = await decisionOpen({ stateDir: sd, stack: 't', question: 'Q2', options: [], askedBy: 'ORCHESTRATOR', openedBy: 'ORCHESTRATOR' });
    assert.equal(d2.id, 'D2');
    assert.deepEqual((await decisionList({ stateDir: sd, stack: 't', state: 'open' })).map((x) => x.id), ['D1', 'D2']);
    const a = await decisionAnswer({ stateDir: sd, stack: 't', id: 'D1', text: 'yes', by: 'human' });
    assert.equal(a.state, 'answered');
    assert.deepEqual(a.answer && { text: a.answer.text, by: a.answer.by }, { text: 'yes', by: 'human' });
    const c = await decisionClose({ stateDir: sd, stack: 't', id: 'D1', by: 'DECISIONS', reason: 'done' });
    assert.equal(c.state, 'closed');
    await assert.rejects(decisionAnswer({ stateDir: sd, stack: 't', id: 'D1', text: 'again', by: 'human' }), /closed/);
    await assert.rejects(decisionAnswer({ stateDir: sd, stack: 't', id: 'D9', text: 'x', by: 'human' }), /no decision D9/);
    await assert.rejects(decisionOpen({ stateDir: sd, stack: 't', question: ' ', options: [], askedBy: 'x', openedBy: 'x' }), /question/);
    assert.deepEqual((await decisionList({ stateDir: sd, stack: 't' })).map((x) => [x.id, x.state]), [['D1', 'closed'], ['D2', 'open']]);
    const v = await deskRoster({ stateDir: sd, stack: 't' });
    assert.deepEqual(v.openDecisions.map((x) => x.id), ['D2']);
  });
});

describe('deskCosts', () => {
  it('own cost = the run\'s own totals only (never adds kind "turn" children); tree = own + lane chain', async () => {
    const sd = tmpDir();
    await putEntry(sd, 't', entry('ORCH', { runId: 'r-orch', port: 2 }));
    await putEntry(sd, 't', entry('DEC', { runId: 'r-dec', port: 3 }));
    await putEntry(sd, 't', entry('lane-a', { kind: 'lane', runId: 'r-la', parentRunId: 'r-orch', port: 12 }));
    writeRunRecord(sd, rec('r-orch', 'ORCH', 'desk', 1.0, 100));
    // the meter already folded these turns into r-orch totals: they must not be added again
    writeRunRecord(sd, rec('r-t1', 'ORCH', 'turn', 0.4, 40, 'r-orch'));
    writeRunRecord(sd, rec('r-t2', 'ORCH', 'turn', 0.6, 60, 'r-orch'));
    writeRunRecord(sd, rec('r-la', 'lane-a', 'lane', 0.5, 10, 'r-orch'));
    writeRunRecord(sd, rec('r-lb', 'lane-b', 'lane', 0.25, 5, 'r-la')); // lane of a lane, stopped
    writeRunRecord(sd, rec('r-old', 'lane-c', 'lane', 2.0, 1, 'r-orch')); // stopped lane still rolls up
    writeRunRecord(sd, rec('r-other', 'ORCH', 'desk', 9, 9, undefined, 'otherstack'));
    const rows = await deskCosts({ stateDir: sd, stack: 't' });
    assert.deepEqual(rows.map((r) => r.name), ['ORCH', 'DEC']);
    const orch = rows[0]!;
    assert.equal(orch.costUsd, 1.0, 'own = desk totals only, no turn children');
    assert.equal(orch.inputTokens, 100);
    assert.equal(orch.outputTokens, 200);
    assert.deepEqual(orch.lanes.map((l) => l.name).sort(), ['lane-a', 'lane-c']);
    const la = orch.lanes.find((l) => l.name === 'lane-a')!;
    assert.equal(la.parentRunId, 'r-orch');
    assert.deepEqual(la.lanes.map((l) => [l.name, l.costUsd]), [['lane-b', 0.25]]);
    assert.equal(rows[1]!.costUsd, null, 'no record -> null');
    const v = await deskRoster({ stateDir: sd, stack: 't', prune: false });
    const row = (n: string) => v.rows.find((r) => r.name === n)!;
    assert.equal(row('ORCH').costUsd, 1.0);
    assert.equal(row('ORCH').treeCostUsd, 1.0 + 0.5 + 0.25 + 2.0);
    assert.equal(row('lane-a').costUsd, 0.5);
    assert.equal(row('lane-a').treeCostUsd, 0.75);
    assert.equal(row('DEC').treeCostUsd, null);
  });
});

describe('lanes: approval path on real fake-engine hosts', () => {
  const PORT_BASE = 5900;
  function setupStack(approval: 'decisions' | 'none'): { sd: string; stack: string } {
    const sd = tmpDir();
    const stack = 'p5900';
    const layout = parseLayout(
      JSON.stringify({
        portBase: PORT_BASE,
        agent: 'opencode',
        desks: [
          { name: 'ORCHESTRATOR', role: 'orchestrator', mcps: [] },
          { name: 'DECISIONS', role: 'decisions', mcps: [] },
        ],
        lanes: { defaultMcps: ['tracker'], ports: [10, 19], approval, defaultGoalFlags: '--max-minutes 5' },
      }),
      'inline',
    );
    const p = deskPaths(sd, stack);
    mkdirSync(p.root, { recursive: true });
    writeFileSync(p.layout, JSON.stringify(layout));
    return { sd, stack };
  }

  it('desk launcher -> pending; reject; approve starts the lane with brief + goal flags; laneStop refuses desks and cleans up', { timeout: 120_000 }, async () => {
    const { sd, stack } = setupStack('decisions');
    const r = await laneNew({ stateDir: sd, stack, name: 'probe-d1', goal: 'check access', launchedBy: 'ORCHESTRATOR', brief: 'Read-only probe.' });
    assert.ok('pending' in r, 'pending when a desk other than DECISIONS launches');
    const pending = (r as { pending: PendingLane }).pending;
    assert.equal(pending.id, 'L1');
    assert.equal(pending.state, 'pending');
    await assert.rejects(laneNew({ stateDir: sd, stack, name: 'probe-d1', goal: 'x', launchedBy: 'ORCHESTRATOR' }), /already pending/);
    const r2 = await laneNew({ stateDir: sd, stack, name: 'nope', goal: 'x', launchedBy: 'ORCHESTRATOR' });
    const rej = await laneReject({ stateDir: sd, stack, id: (r2 as { pending: PendingLane }).pending.id, by: 'DECISIONS', reason: 'dup' });
    assert.equal(rej.state, 'rejected');
    assert.equal(rej.reason, 'dup');
    await assert.rejects(laneApprove({ stateDir: sd, stack, id: rej.id, by: 'DECISIONS' }), /already rejected/);
    assert.deepEqual((await deskRoster({ stateDir: sd, stack })).pendingLanes.map((p) => p.id), ['L1']);

    let hostPid = 0;
    try {
      const e = await laneApprove({ stateDir: sd, stack, id: 'L1', by: 'DECISIONS' });
      hostPid = e.pid;
      assert.equal(e.kind, 'lane');
      assert.equal(e.launchedBy, 'ORCHESTRATOR');
      assert.equal(e.port, PORT_BASE + 10);
      assert.deepEqual(e.mcps, ['tracker'], 'lanes.defaultMcps');
      assert.equal(e.goal, '--max-minutes 5 check access');
      const spec = JSON.parse(readFileSync(join(deskPaths(sd, stack).specs, 'probe-d1.json'), 'utf8')) as HostSpec;
      assert.match(spec.brief ?? '', /You are lane probe-d1/);
      assert.match(spec.brief ?? '', /Read-only probe\./);
      assert.equal(spec.kind, 'lane');
      assert.equal(spec.role, 'lane');
      const h = await hostHealth(e.url, 2000);
      assert.equal(h?.state, 'idle');
      assert.equal(h?.goal?.objective, '--max-minutes 5 check access');
      const evs = await hostEvents(e.url);
      assert.ok(evs.some((x) => x.type === 'goal'), 'goal event recorded');
      const st = await laneStatus({ stateDir: sd, stack });
      assert.deepEqual(st.map((x) => [x.name, x.state, x.goalStatus?.state]), [['probe-d1', 'idle', 'active']]);
      assert.equal((await deskRoster({ stateDir: sd, stack })).pendingLanes.length, 0);

      // human launches skip approval; a used name is refused
      await assert.rejects(laneNew({ stateDir: sd, stack, name: 'probe-d1', goal: 'x', launchedBy: 'human' }), /already in use/);
      await assert.rejects(laneNew({ stateDir: sd, stack, name: 'Bad Name', goal: 'x', launchedBy: 'human' }), /invalid lane name/);

      await putEntry(sd, stack, entry('ORCHESTRATOR', { port: 1 }));
      await assert.rejects(laneStop({ stateDir: sd, stack, name: 'ORCHESTRATOR' }), /is a desk/);

      const s = await laneStop({ stateDir: sd, stack, name: 'probe-d1', by: 'ORCHESTRATOR' });
      assert.equal(s.stopped, 'probe-d1');
      assert.equal(readRoster(sd, stack).entries['probe-d1'], undefined);
      const log = readFileSync(deskPaths(sd, stack).lanesLog, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
      assert.deepEqual(log.map((l) => [l.event, l.name, l.by]), [['start', 'probe-d1', 'ORCHESTRATOR'], ['stop', 'probe-d1', 'ORCHESTRATOR']]);
      assert.equal(log[1].goalState, 'active');
      assert.equal(await portFree(PORT_BASE + 10), true, 'lane port freed');
      assert.equal(pgrepStateDir(sd), '', 'no host process left');
    } finally {
      if (hostPid > 0) {
        try {
          process.kill(hostPid, 'SIGKILL');
        } catch {
          /* gone */
        }
      }
    }
  });

  it('approval "none": a desk launcher starts the lane at once on the first free port', { timeout: 120_000 }, async () => {
    const { sd, stack } = setupStack('none');
    const blocker = createServer();
    await new Promise<void>((r) => blocker.listen(PORT_BASE + 10, '127.0.0.1', () => r()));
    try {
      const e = (await laneNew({ stateDir: sd, stack, name: 'quick', goal: '--max-minutes 1 do it', launchedBy: 'ORCHESTRATOR' })) as RosterEntry;
      assert.equal(e.port, PORT_BASE + 11, 'skips the bound port');
      assert.equal(e.goal, '--max-minutes 1 do it', 'goal with flags is not prefixed');
      await laneStop({ stateDir: sd, stack, name: 'quick' });
      assert.equal(pgrepStateDir(sd), '');
      assert.equal(existsSync(join(deskPaths(sd, stack).specs, 'quick.pid')), false);
    } finally {
      await new Promise<void>((r) => blocker.close(() => r()));
    }
  });
});
