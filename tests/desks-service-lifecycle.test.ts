// Desk/lane lifecycle robustness (review findings on #204): a failed engine switch keeps the desk,
// prune records a lane's end and spares a slow host, desk down survives a failing lane stop, a
// lane start does not retry on an old log line, desk costs survive an engine switch, and stops
// never touch a process or port that is no longer ours. Stub hosts (tests/support/stub-agent-host.mjs)
// on ports 6101 and 6130..6136; no terminal (term none).
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, describe, it } from 'node:test';
import { writeRunRecord, type RunRecord } from '../src/core/registry.ts';
import { parseLayout } from '../src/desks/config.ts';
import { hostHealth } from '../src/desks/host-client.ts';
import { deskPaths, putEntry, readRoster } from '../src/desks/roster.ts';
import { deskCosts, deskDown, deskRoster, deskSwitchEngine, deskUp, laneNew, laneStatus, laneStop } from '../src/desks/service.ts';
import type { HostSpec, RosterEntry } from '../src/desks/types.ts';

const ROOT = resolve(import.meta.dirname, '..');
const STUB = join(ROOT, 'tests', 'support', 'stub-agent-host.mjs');
process.env.ACH_SELF_ARGV = JSON.stringify([process.execPath, STUB]);
delete process.env.ACH_DESK_STACK;
const ENV_STATE = mkdtempSync(join(tmpdir(), 'ach-desks-life-env-'));
process.env.AGENTIC_CODING_HARNESS_STATE_DIR = ENV_STATE;

const roots: string[] = [ENV_STATE];
const children: ChildProcess[] = [];
after(() => {
  for (const c of children) c.kill('SIGKILL');
  for (const d of roots) rmSync(d, { recursive: true, force: true });
});
function tmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'ach-desks-life-'));
  roots.push(d);
  return d;
}

function entry(name: string, over: Partial<RosterEntry> = {}): RosterEntry {
  return {
    name,
    kind: 'lane',
    role: 'lane',
    agent: 'opencode',
    engine: 'opencode',
    mcps: [],
    port: 1,
    url: 'http://127.0.0.1:1',
    pid: 9_999_999,
    runId: `run-${name}`,
    cwd: '/tmp',
    startedAt: 1,
    ...over,
  };
}

function alive(pid: number | undefined): boolean {
  if (pid === undefined) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** A long-lived child with the given argv tail (shows in `ps`), killed after the file. */
function spawnIdle(...tail: string[]): ChildProcess {
  const c = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', ...tail], { stdio: 'ignore' });
  children.push(c);
  return c;
}

/** An HTTP host that answers /health with `runId` and counts POST /stop. */
async function countingHost(name: string, runId: string, kind: 'desk' | 'lane'): Promise<{ server: Server; url: string; stops: () => number }> {
  let stops = 0;
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/health') {
      res.end(JSON.stringify({ version: 1, name, kind, engine: 'opencode', agent: 'opencode', runId, pid: 9_999_999, state: 'idle', queueDepth: 0, lastSeq: 0 }));
    } else if (req.url === '/stop') {
      stops++;
      res.end('{}');
    } else res.end('{}');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  if (addr === null || typeof addr === 'string') throw new Error('no port');
  return { server, url: `http://127.0.0.1:${addr.port}`, stops: () => stops };
}

function lanesLog(sd: string, stack: string): Array<Record<string, unknown>> {
  return readFileSync(deskPaths(sd, stack).lanesLog, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
}

describe('engine switch failure keeps the desk', () => {
  function layoutFile(sd: string): string {
    const f = join(sd, 'desks.yaml');
    writeFileSync(f, ['portBase: 6100', 'agent: opencode', 'desks:', '  - {name: DESK1, role: orchestrator, mcps: []}', 'lanes:', '  ports: [10, 16]', ''].join('\n'));
    return f;
  }

  it('an unknown agent name is refused before the running host is stopped', { timeout: 60_000 }, async () => {
    const sd = tmpDir();
    await deskUp({ stateDir: sd, stack: 'p6100', layoutFile: layoutFile(sd), term: 'none' });
    const stack = 'p6100';
    try {
      const before = readRoster(sd, stack).entries.DESK1!;
      await assert.rejects(deskSwitchEngine({ stateDir: sd, stack, name: 'DESK1', agent: 'claud' }), /unknown agent "claud"/);
      const after = readRoster(sd, stack).entries.DESK1!;
      assert.equal(after.runId, before.runId, 'same run, never stopped');
      assert.equal((await hostHealth(after.url, 2000))?.runId, before.runId, 'old host still answering');
    } finally {
      await deskDown({ stateDir: sd, stack });
    }
  });

  it('a new engine that fails to start rolls back to the old agent on the same port; the original error surfaces', { timeout: 120_000 }, async () => {
    const sd = tmpDir();
    await deskUp({ stateDir: sd, stack: 'p6100', layoutFile: layoutFile(sd), term: 'none' });
    const stack = 'p6100';
    process.env.STUB_FAIL_AGENT = 'codex';
    try {
      const before = readRoster(sd, stack).entries.DESK1!;
      await assert.rejects(deskSwitchEngine({ stateDir: sd, stack, name: 'DESK1', agent: 'codex' }), /did not become idle/);
      const e = readRoster(sd, stack).entries.DESK1;
      assert.ok(e, 'desk still in the roster');
      assert.equal(e.agent, 'opencode');
      assert.equal(e.port, before.port);
      const h = await hostHealth(e.url, 2000);
      assert.equal(h?.runId, e.runId, 'the restored host answers for the roster runId');
      assert.equal(h?.agent, 'opencode');
      const spec = JSON.parse(readFileSync(join(deskPaths(sd, stack).specs, 'DESK1.json'), 'utf8')) as HostSpec;
      assert.equal(spec.agent, 'opencode', 'spec restored');
      const v = await deskRoster({ stateDir: sd, stack });
      assert.deepEqual(v.rows.map((r) => [r.name, r.state]), [['DESK1', 'idle']], 'prune keeps it');
    } finally {
      delete process.env.STUB_FAIL_AGENT;
      await deskDown({ stateDir: sd, stack });
    }
  });
});

describe('roster prune', () => {
  it('a crashed lane gets a stop line (by prune, final goal state) and loses its pid file; lane status answers for it', async () => {
    const sd = tmpDir();
    const p = deskPaths(sd, 'p');
    mkdirSync(p.events, { recursive: true });
    mkdirSync(p.specs, { recursive: true });
    const goal = (state: string) => JSON.stringify({ seq: 1, at: 1, runId: 'run-LANE1', name: 'LANE1', type: 'goal', data: { goal: { objective: 'o', state, source: 'opencode-plugin', updatedAt: 1 } } }) + '\n';
    appendFileSync(join(p.events, 'run-LANE1.jsonl'), goal('achieved'));
    writeFileSync(join(p.specs, 'LANE1.pid'), '9999998\n');
    await putEntry(sd, 'p', entry('LANE1', { launchedBy: 'human', goal: 'g' }));
    const rows = await laneStatus({ stateDir: sd, stack: 'p', name: 'LANE1' });
    assert.deepEqual(rows.map((r) => [r.name, r.state, r.goalState, r.runId]), [['LANE1', 'stopped', 'achieved', 'run-LANE1']]);
    const stop = lanesLog(sd, 'p').filter((l) => l.event === 'stop');
    assert.deepEqual(stop.map((l) => [l.name, l.by, l.goalState, l.runId]), [['LANE1', 'prune', 'achieved', 'run-LANE1']]);
    assert.equal(existsSync(join(p.specs, 'LANE1.pid')), false, 'pid file removed');
    await deskRoster({ stateDir: sd, stack: 'p' });
    assert.equal(lanesLog(sd, 'p').filter((l) => l.event === 'stop').length, 1, 'a second roster call logs nothing more');
  });

  it('a slow host whose own process is alive is kept; an entry whose pid now belongs to another process is pruned', async () => {
    const sd = tmpDir();
    const specFile = join(deskPaths(sd, 'p').specs, 'SLOW.json');
    const ours = spawnIdle('desk', 'host', '--spec', specFile);
    const foreign = spawnIdle('something', 'else');
    await new Promise((r) => setTimeout(r, 300));
    await putEntry(sd, 'p', entry('SLOW', { kind: 'desk', role: 'orchestrator', pid: ours.pid!, port: 2 }));
    await putEntry(sd, 'p', entry('REUSED', { kind: 'desk', role: 'decisions', pid: foreign.pid!, port: 3 }));
    const v = await deskRoster({ stateDir: sd, stack: 'p' });
    assert.deepEqual(v.rows.map((r) => r.name), ['SLOW'], 'slow host kept, reused pid pruned');
    assert.ok(readRoster(sd, 'p').entries.SLOW);
  });
});

describe('deskDown with a failing lane stop', () => {
  it('still stops every desk and empties the roster, then reports the lane error', async () => {
    const sd = tmpDir();
    const desk = await countingHost('DESK1', 'run-DESK1', 'desk');
    const lane = await countingHost('LANE1', 'run-LANE1', 'lane');
    try {
      await putEntry(sd, 'p', entry('DESK1', { kind: 'desk', role: 'orchestrator', url: desk.url, port: 2 }));
      await putEntry(sd, 'p', entry('LANE1', { url: lane.url, port: 3 }));
      mkdirSync(deskPaths(sd, 'p').lanesLog, { recursive: true }); // appending a stop line now throws EISDIR
      const r = await deskDown({ stateDir: sd, stack: 'p' }).then(
        (v) => v,
        (e: unknown) => e,
      );
      assert.equal(desk.stops(), 1, 'desk host was stopped');
      assert.deepEqual(readRoster(sd, 'p').entries, {}, 'roster emptied');
      assert.ok(r instanceof Error, 'the lane failure is reported');
      assert.match(r.message, /LANE1/);
    } finally {
      desk.server.close();
      lane.server.close();
    }
  });
});

describe('lane start: old log lines', () => {
  it('a failed start is not retried because an earlier run logged "already in use"', { timeout: 120_000 }, async () => {
    const sd = tmpDir();
    const stack = 'p6120';
    const layout = parseLayout(
      JSON.stringify({ portBase: 6120, agent: 'opencode', desks: [{ name: 'ORCHESTRATOR', role: 'orchestrator', mcps: [] }], lanes: { defaultMcps: [], ports: [10, 16], approval: 'none' } }),
      'inline',
    );
    const p = deskPaths(sd, stack);
    mkdirSync(p.logs, { recursive: true });
    writeFileSync(p.layout, JSON.stringify(layout));
    const log = join(p.logs, 'flaky.log');
    writeFileSync(log, 'Error: listen EADDRINUSE: address already in use 127.0.0.1:6130\n');
    process.env.STUB_FAIL_AGENT = 'codex';
    try {
      const err = await laneNew({ stateDir: sd, stack, name: 'flaky', goal: 'go', agent: 'codex', launchedBy: 'human' }).then(
        () => null,
        (e: unknown) => e as Error,
      );
      assert.ok(err instanceof Error);
      const starts = readFileSync(log, 'utf8').split('\n').filter((l) => l.startsWith('stub-host start')).length;
      assert.equal(starts, 1, `one start attempt, saw ${starts}`);
      assert.doesNotMatch(err.message, /already in use/, 'error tail holds only this attempt');
      assert.match(err.message, /agent codex refused/);
    } finally {
      delete process.env.STUB_FAIL_AGENT;
    }
  });
});

describe('desk costs across an engine switch', () => {
  function rec(runId: string, name: string, kind: 'desk' | 'lane', costUsd: number, over: Partial<RunRecord> = {}): RunRecord {
    return {
      runId,
      agent: 'opencode',
      startedAt: 1,
      status: 'success',
      producer: 'other',
      desk: { stack: 't', name, kind },
      totals: { inputTokens: 10, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd },
      ...over,
    };
  }

  it('the desk row sums every run of that desk and nests lanes launched by an earlier run', async () => {
    const sd = tmpDir();
    await putEntry(sd, 't', entry('DEC', { kind: 'desk', role: 'decisions', runId: 'r-new', port: 2 }));
    await putEntry(sd, 't', entry('live-lane', { runId: 'r-ll', parentRunId: 'r-old', port: 12 }));
    writeRunRecord(sd, rec('r-old', 'DEC', 'desk', 1, { startedAt: 1 }));
    writeRunRecord(sd, rec('r-new', 'DEC', 'desk', 0.5, { startedAt: 2 }));
    writeRunRecord(sd, rec('r-sl', 'stopped-lane', 'lane', 0.25, { startedAt: 3, parentRunId: 'r-old' }));
    writeRunRecord(sd, rec('r-other', 'DEC', 'desk', 9, { desk: { stack: 'other', name: 'DEC', kind: 'desk' } }));
    const rows = await deskCosts({ stateDir: sd, stack: 't' });
    assert.deepEqual(rows.map((r) => [r.name, r.kind]), [['DEC', 'desk']], 'no lane is promoted to top level');
    assert.equal(rows[0]!.runId, 'r-new', 'row keyed by the live run');
    assert.equal(rows[0]!.costUsd, 1.5, 'own cost covers the run before the switch');
    assert.equal(rows[0]!.inputTokens, 20);
    assert.deepEqual(rows[0]!.lanes.map((l) => l.name).sort(), ['live-lane', 'stopped-lane']);
    const v = await deskRoster({ stateDir: sd, stack: 't', prune: false });
    assert.equal(v.rows.find((r) => r.name === 'DEC')!.treeCostUsd, null, 'live lane without a record is unknown');
  });

  it('an unpriced earlier run makes the desk cost unknown', async () => {
    const sd = tmpDir();
    await putEntry(sd, 't', entry('DEC', { kind: 'desk', role: 'decisions', runId: 'r-new', port: 2 }));
    writeRunRecord(sd, rec('r-old', 'DEC', 'desk', 0, { totals: { inputTokens: 10, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, costUnpriced: true } }));
    writeRunRecord(sd, rec('r-new', 'DEC', 'desk', 0.5, { startedAt: 2 }));
    const rows = await deskCosts({ stateDir: sd, stack: 't' });
    assert.equal(rows[0]!.costUsd, null);
  });
});

describe('stops check identity', () => {
  it('a port now answering for another run gets no /stop and a recorded pid that is not our host gets no signal', { timeout: 40_000 }, async () => {
    const sd = tmpDir();
    const other = await countingHost('LANE1', 'someone-else', 'lane');
    const foreign = spawnIdle('not', 'a', 'desk');
    await new Promise((r) => setTimeout(r, 300));
    try {
      await putEntry(sd, 'p', entry('LANE1', { url: other.url, pid: foreign.pid! }));
      await laneStop({ stateDir: sd, stack: 'p', name: 'LANE1', by: 'human', now: true });
      assert.equal(other.stops(), 0, 'no /stop to a host of another run');
      assert.equal(alive(foreign.pid), true, 'foreign process not signalled');
      assert.equal(readRoster(sd, 'p').entries.LANE1, undefined, 'entry still removed');
    } finally {
      other.server.close();
    }
  });
});
