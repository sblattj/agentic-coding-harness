// src/desks/service.ts end to end: real detached host processes (ACH_DESK_FAKE_ENGINE=1)
// on ports 5801.., panes on a PRIVATE tmux server (-L ach-desks-svc-<pid>), temp state dir.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, describe, it } from 'node:test';
import { readRoster } from '../src/desks/roster.ts';
import {
  deskAttach,
  deskCosts,
  deskDown,
  deskEvents,
  deskInbox,
  deskRoster,
  deskSend,
  deskSwitchEngine,
  deskUp,
  laneNew,
  decisionAnswer,
  decisionOpen,
  laneApprove,
  resolveStack,
} from '../src/desks/service.ts';
import type { PendingLane, RosterEntry } from '../src/desks/types.ts';

const ROOT = resolve(import.meta.dirname, '..');
process.env.ACH_SELF_ARGV = JSON.stringify([join(ROOT, 'node_modules', '.bin', 'tsx'), join(ROOT, 'src', 'cli', 'ach.ts')]);
process.env.ACH_DESK_FAKE_ENGINE = '1';
delete process.env.ACH_DESK_STACK;

const SOCK = `ach-desks-svc-${process.pid}`;
const SESSION = 'svc';
const PORT_BASE = 5800;
const tmux = (...args: string[]): string => execFileSync('tmux', ['-L', SOCK, ...args], { encoding: 'utf8', timeout: 10_000 });

const sd = mkdtempSync(join(tmpdir(), 'ach-desks-svc-stack-'));
process.env.AGENTIC_CODING_HARNESS_STATE_DIR = sd;
let socketPath = '';
after(() => {
  try {
    tmux('kill-server');
  } catch {
    /* not running */
  }
  if (socketPath) rmSync(socketPath, { force: true });
  rmSync(sd, { recursive: true, force: true });
});

function hostPids(): string {
  try {
    return execFileSync('pgrep', ['-f', `desk host --spec ${sd}`], { encoding: 'utf8', timeout: 5000 }).trim();
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
async function waitFor<T>(fn: () => Promise<T | undefined | false> | T | undefined | false, what: string, ms = 15_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v as T;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}
const desksPanes = (): string[] => tmux('list-panes', '-t', `${SESSION}:desks`, '-F', '#{pane_id}').trim().split('\n').filter(Boolean);
const allPanes = (): string[] => {
  try {
    return tmux('list-panes', '-a', '-F', '#{pane_id}').trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }
};
const windows = (): string[] => tmux('list-windows', '-t', SESSION, '-F', '#{window_name}').trim().split('\n');

describe('desk service: real stack (3 fake-engine hosts, private tmux)', () => {
  it('up -> send -> lane -> switch engine -> costs -> attach -> down', { timeout: 240_000 }, async () => {
    const layoutFile = join(sd, 'desks.yaml');
    writeFileSync(
      layoutFile,
      [
        'portBase: 5700',
        'agent: opencode',
        'desks:',
        '  - {name: ORCHESTRATOR, role: orchestrator, pane: left, mcps: []}',
        '  - {name: DECISIONS, role: decisions, pane: right-top, mcps: []}',
        '  - {name: LISTENER, role: listener, pane: right-bottom, mcps: [transcripts]}',
        'lanes:',
        '  defaultMcps: []',
        '  ports: [10, 19]',
        '  approval: decisions',
        '',
      ].join('\n'),
    );
    // Private server; panes stay when their attach command exits (`desk chat` may be a stub here).
    tmux('new-session', '-d', '-s', SESSION, '-x', '200', '-y', '50');
    tmux('set-option', '-g', '-w', 'remain-on-exit', 'on');
    socketPath = tmux('display-message', '-p', '#{socket_path}').trim();
    const before = new Set(allPanes());
    let entries: RosterEntry[] = [];
    try {
      for (const p of [5801, 5802, 5803, 5810]) assert.equal(await portFree(p), true, `port ${p} free before`);

      // --- up ---------------------------------------------------------------
      const v = await deskUp({ stateDir: sd, layoutFile, portBase: PORT_BASE, term: 'tmux', tmuxSession: SESSION, tmuxSocket: SOCK });
      entries = v.rows;
      assert.equal(v.stack, 'p5800', 'portBase override re-derives the stack');
      assert.equal(v.portBase, PORT_BASE);
      assert.equal(resolveStack({ stateDir: sd }), 'p5800', 'active-stack written');
      assert.deepEqual(v.rows.map((r) => [r.name, r.state, r.port]), [
        ['ORCHESTRATOR', 'idle', 5801],
        ['DECISIONS', 'idle', 5802],
        ['LISTENER', 'idle', 5803],
      ]);
      assert.deepEqual(v.rows.map((r) => [r.name, r.pane]), [['ORCHESTRATOR', 'left'], ['DECISIONS', 'right-top'], ['LISTENER', 'right-bottom']], 'roster rows carry the layout pane');
      assert.notEqual(hostPids(), '', 'hosts are running (control for the empty check below)');
      const panes = desksPanes();
      assert.equal(panes.length, 3, 'desks window has 3 panes');
      assert.deepEqual(v.rows.map((r) => r.terminal?.id).sort(), [...panes].sort(), 'roster holds the pane ids');
      assert.ok(v.rows.every((r) => r.terminal?.kind === 'tmux'));
      await assert.rejects(deskUp({ stateDir: sd, layoutFile, portBase: PORT_BASE, term: 'none' }), /already up/);

      // --- send -------------------------------------------------------------
      const stack = 'p5800';
      const m = await deskSend({ stateDir: sd, stack, from: 'ORCHESTRATOR', to: 'DECISIONS', text: 'hello decisions' });
      assert.equal(m.from, 'ORCHESTRATOR');
      assert.equal(m.to, 'DECISIONS');
      await waitFor(async () => {
        const evs = await deskEvents({ stateDir: sd, stack, name: 'DECISIONS' });
        const inn = evs.some((e) => e.type === 'message_in' && (e.data.message as { from?: string }).from === 'ORCHESTRATOR');
        const echo = evs.some((e) => e.type === 'text' && e.data.text === 'echo: [desk-msg from ORCHESTRATOR] hello decisions');
        return inn && echo;
      }, 'DECISIONS message_in + echo with header');
      const out = await deskEvents({ stateDir: sd, stack, name: 'ORCHESTRATOR' });
      assert.ok(out.some((e) => e.type === 'message_out' && (e.data.message as { id?: string }).id === m.id), 'message_out on the sender');
      assert.deepEqual((await deskInbox({ stateDir: sd, stack, name: 'DECISIONS' })).map((x) => x.id), [m.id]);

      // --- lane -------------------------------------------------------------
      const orch = readRoster(sd, stack).entries.ORCHESTRATOR!;
      const msgIn = (name: string, re: RegExp, from?: string) =>
        waitFor(async () => {
          const evs = await deskEvents({ stateDir: sd, stack, name });
          return evs.some((e) => {
            const mm = e.data.message as { text?: string; from?: string } | undefined;
            return e.type === 'message_in' && re.test(mm?.text ?? '') && (from === undefined || mm?.from === from);
          });
        }, `${name} message_in ${re}`);
      const pend = await laneNew({ stateDir: sd, stack, name: 'audit-x', goal: 'list call sites', launchedBy: 'ORCHESTRATOR', brief: 'ctx' });
      assert.ok('pending' in pend, 'approval: decisions -> pending');
      assert.equal((pend as { pending: PendingLane }).pending.id, 'L1');
      await msgIn('DECISIONS', /^Lane request L1: audit-x/, 'ORCHESTRATOR');
      const lane = await laneApprove({ stateDir: sd, stack, id: 'L1', by: 'DECISIONS' });
      await msgIn('ORCHESTRATOR', /Lane request L1 \(audit-x\) approved/, 'DECISIONS');
      assert.equal(lane.kind, 'lane');
      assert.equal(lane.port, 5810);
      assert.equal(lane.parentRunId, orch.runId);
      assert.ok(windows().includes('audit-x'), 'lane got its own tmux window');
      const lr = (await deskRoster({ stateDir: sd, stack })).rows.find((r) => r.name === 'audit-x');
      assert.equal(lr?.state, 'idle');
      assert.equal(lr?.terminal?.kind, 'tmux');

      // --- decisions relays ---------------------------------------------------
      const dq = await decisionOpen({ stateDir: sd, stack, question: 'Write to the tracker?', options: [{ label: 'no', recommended: true, reason: 'draft first' }], askedBy: 'audit-x', openedBy: 'ORCHESTRATOR' });
      assert.equal(dq.id, 'D1');
      await msgIn('DECISIONS', /^Decision D1 opened \(asked by audit-x\)/, 'ORCHESTRATOR');
      const ans = await decisionAnswer({ stateDir: sd, stack, id: 'D1', text: 'no, draft to a file', by: 'human' });
      assert.equal(ans.state, 'answered');
      await msgIn('audit-x', /^Answer to D1 .*no, draft to a file/, 'human');
      await msgIn('DECISIONS', /^Answer to D1 .*no, draft to a file/, 'human');

      // --- switch engine ----------------------------------------------------
      const oldDec = readRoster(sd, stack).entries.DECISIONS!;
      const inboxBefore = (await deskInbox({ stateDir: sd, stack, name: 'DECISIONS' })).map((x) => x.id);
      assert.ok(inboxBefore.length >= 4 && inboxBefore[0] === m.id, 'DECISIONS inbox has the send + relays');
      const sw = await deskSwitchEngine({ stateDir: sd, stack, name: 'DECISIONS', agent: 'claude', model: 'claude-sonnet-5-5' });
      assert.equal(sw.agent, 'claude');
      assert.equal(sw.engine, 'driver');
      assert.equal(sw.model, 'claude-sonnet-5-5');
      assert.equal(sw.port, oldDec.port, 'same port');
      assert.notEqual(sw.runId, oldDec.runId, 'new run');
      assert.equal(sw.terminal?.id, oldDec.terminal?.id, 'same pane slot (respawned)');
      assert.equal(sw.pane, 'right-top', 'engine switch keeps the layout pane in the roster');
      assert.equal(desksPanes().length, 3, 'pane count unchanged');
      assert.deepEqual((await deskInbox({ stateDir: sd, stack, name: 'DECISIONS' })).map((x) => x.id), inboxBefore, 'history kept');
      const row = (await deskRoster({ stateDir: sd, stack })).rows.find((r) => r.name === 'DECISIONS');
      assert.equal(row?.state, 'idle');
      assert.equal(row?.runId, sw.runId);
      const r2 = await deskSend({ stateDir: sd, stack, from: 'human', to: 'DECISIONS', text: 'after switch' });
      assert.equal(r2.to, 'DECISIONS');

      // --- costs ------------------------------------------------------------
      const costs = await deskCosts({ stateDir: sd, stack });
      assert.deepEqual(costs.map((c) => c.name), ['ORCHESTRATOR', 'DECISIONS', 'LISTENER']);
      assert.deepEqual(costs[0]!.lanes.map((l) => l.name), ['audit-x'], 'lane nested under its launcher');

      // --- attach (move panes) ----------------------------------------------
      const oldIds = readRoster(sd, stack).entries;
      const av = await deskAttach({ stateDir: sd, stack, term: 'tmux' });
      assert.equal(av.rows.length, 4);
      const newPanes = desksPanes();
      assert.equal(newPanes.length, 3, 'desks window reopened with 3 panes');
      for (const r of av.rows) assert.notEqual(r.terminal?.id, oldIds[r.name]?.terminal?.id, `${r.name} got a new pane`);
      assert.deepEqual(av.rows.map((r) => r.runId).sort(), Object.values(oldIds).map((e) => e.runId).sort(), 'same sessions');
      assert.equal(windows().filter((w) => w === 'desks').length, 1, 'old desks window closed');
      entries = av.rows;

      // --- down -------------------------------------------------------------
      const opened = av.rows.map((r) => r.terminal?.id).filter((x): x is string => !!x);
      const d = await deskDown({ stateDir: sd, stack });
      assert.deepEqual([...d.stopped].sort(), ['DECISIONS', 'LISTENER', 'ORCHESTRATOR', 'audit-x']);
      assert.deepEqual(readRoster(sd, stack).entries, {}, 'empty roster');
      await waitFor(() => hostPids() === '', 'no host processes', 10_000);
      for (const p of [5801, 5802, 5803, 5810]) assert.equal(await portFree(p), true, `port ${p} freed`);
      const left = new Set(allPanes());
      for (const id of opened) assert.equal(left.has(id), false, `pane ${id} closed`);
      for (const id of before) assert.equal(left.has(id), true, `pre-existing pane ${id} untouched`);
      assert.equal(resolveStack({ stateDir: sd }), 'default', 'active-stack cleared');
      const rv = await deskRoster({ stateDir: sd, stack });
      assert.equal(rv.rows.length, 0);
      assert.ok(readFileSync(join(sd, 'desks', stack, 'lanes.log'), 'utf8').includes('"stop"'));
    } finally {
      for (const e of entries) {
        try {
          process.kill(e.pid, 'SIGKILL');
        } catch {
          /* gone */
        }
      }
    }
  });
});
