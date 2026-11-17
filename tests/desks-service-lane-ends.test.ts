// Lane endings and cost honesty (live E2E findings): laneStop records the goal state the host
// reached WHILE stopping, laneStatus remembers stopped lanes, deskCosts keeps unknown cost null and
// lists spend from lanes whose launcher is not a live desk.
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { writeRunRecord, type RunRecord } from '../src/core/registry.ts';
import { deskPaths, putEntry } from '../src/desks/roster.ts';
import { deskCosts, deskRoster, laneStatus, laneStop } from '../src/desks/service.ts';
import type { RosterEntry } from '../src/desks/types.ts';

const roots: string[] = [];
after(() => {
  for (const d of roots) rmSync(d, { recursive: true, force: true });
});
function tmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'ach-desks-ends-'));
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

/** A host whose /health says goal active; POST /stop appends a goal-achieved event (like the plugin does while stopping). */
async function fakeHost(sd: string, stack: string, runId: string, name: string): Promise<{ server: Server; url: string }> {
  const eventsFile = join(deskPaths(sd, stack).events, `${runId}.jsonl`);
  mkdirSync(deskPaths(sd, stack).events, { recursive: true });
  const ev = (seq: number, type: string, data: Record<string, unknown>) => JSON.stringify({ seq, at: Date.now(), runId, name, type, data }) + '\n';
  appendFileSync(eventsFile, ev(1, 'goal', { goal: { objective: 'o', state: 'active', source: 'opencode-plugin', updatedAt: 1 } }));
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/health') {
      res.end(JSON.stringify({ version: 1, name, kind: 'lane', engine: 'opencode', agent: 'opencode', runId, pid: 9_999_999, state: 'idle', queueDepth: 0, lastSeq: 1, goal: { objective: 'o', state: 'active', source: 'opencode-plugin', updatedAt: 1 } }));
    } else if (req.url === '/stop') {
      appendFileSync(eventsFile, ev(2, 'status', { state: 'stopping' }));
      appendFileSync(eventsFile, ev(3, 'goal', { goal: { objective: 'o', state: 'achieved', source: 'opencode-plugin', updatedAt: 2 } }));
      res.end('{}');
    } else res.end('{}');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  if (addr === null || typeof addr === 'string') throw new Error('no port');
  return { server, url: `http://127.0.0.1:${addr.port}` };
}

function rec(runId: string, name: string, kind: 'desk' | 'lane', over: Partial<RunRecord> = {}, stack = 't'): RunRecord {
  return {
    runId,
    agent: 'opencode',
    startedAt: Date.now(),
    status: 'success',
    producer: 'ach-desk-host',
    desk: { stack, name, kind },
    totals: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, costUnpriced: true },
    ...over,
  };
}

describe('laneStop final goal state', () => {
  it('records the goal state reported while stopping, not the pre-stop /health value', async () => {
    const sd = tmpDir();
    const { server, url } = await fakeHost(sd, 'p', 'run-LANE1', 'LANE1');
    try {
      await putEntry(sd, 'p', entry('LANE1', { url, launchedBy: 'human' }));
      await laneStop({ stateDir: sd, stack: 'p', name: 'LANE1', by: 'ORCHESTRATOR' });
    } finally {
      server.close();
    }
    const log = readFileSync(deskPaths(sd, 'p').lanesLog, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const stop = log.find((l) => l.event === 'stop');
    assert.equal(stop.goalState, 'achieved');
  });
});

describe('laneStatus after stop', () => {
  it('returns a stopped row with the final goal state; unknown names still throw; no name lists live lanes only', async () => {
    const sd = tmpDir();
    const { server, url } = await fakeHost(sd, 'p', 'run-LANE1', 'LANE1');
    try {
      await putEntry(sd, 'p', entry('LANE1', { url, launchedBy: 'human', goal: 'make the file' }));
      await laneStop({ stateDir: sd, stack: 'p', name: 'LANE1', by: 'ORCHESTRATOR' });
    } finally {
      server.close();
    }
    const rows = await laneStatus({ stateDir: sd, stack: 'p', name: 'LANE1' });
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.name, 'LANE1');
    assert.equal(rows[0]!.state, 'stopped');
    assert.equal(rows[0]!.goalState, 'achieved');
    assert.equal(rows[0]!.launchedBy, 'human');
    assert.equal(rows[0]!.runId, 'run-LANE1');
    await assert.rejects(laneStatus({ stateDir: sd, stack: 'p', name: 'NOPE' }), /unknown lane "NOPE"/);
    assert.deepEqual(await laneStatus({ stateDir: sd, stack: 'p' }), []);
  });

  it('a legacy lanes.log (start + stop, no entry snapshot) still yields a stopped row', async () => {
    const sd = tmpDir();
    mkdirSync(deskPaths(sd, 'p').root, { recursive: true });
    const l = (v: object) => JSON.stringify(v) + '\n';
    writeFileSync(
      deskPaths(sd, 'p').lanesLog,
      l({ at: 1, event: 'start', name: 'OLD', by: 'human', goal: 'g', runId: 'r-old', port: 4810 }) + l({ at: 2, event: 'stop', name: 'OLD', by: 'ORCHESTRATOR', goalState: 'active', runId: 'r-old' }),
    );
    const rows = await laneStatus({ stateDir: sd, stack: 'p', name: 'OLD' });
    assert.deepEqual([rows[0]!.name, rows[0]!.state, rows[0]!.goalState, rows[0]!.port, rows[0]!.launchedBy], ['OLD', 'stopped', 'active', 4810, 'human']);
  });
});

describe('deskCosts honesty', () => {
  it('unpriced usage stays null (flagged records and legacy 0-cost desk-host records), tree total with an unknown part is null', async () => {
    const sd = tmpDir();
    await putEntry(sd, 't', entry('ORCH', { kind: 'desk', runId: 'r-orch', port: 2 }));
    await putEntry(sd, 't', entry('PRICED', { kind: 'desk', runId: 'r-priced', port: 3 }));
    await putEntry(sd, 't', entry('LEGACY', { kind: 'desk', runId: 'r-legacy', port: 4 }));
    writeRunRecord(sd, rec('r-orch', 'ORCH', 'desk', { producer: 'other' }));
    writeRunRecord(sd, rec('r-lane', 'lane-a', 'lane', { parentRunId: 'r-orch', totals: { inputTokens: 5, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.5 } }));
    writeRunRecord(sd, rec('r-priced', 'PRICED', 'desk', { totals: { inputTokens: 5, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.25 } }));
    writeRunRecord(sd, rec('r-legacy', 'LEGACY', 'desk', { totals: { inputTokens: 5, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 } }));
    const rows = await deskCosts({ stateDir: sd, stack: 't' });
    const by = (n: string) => rows.find((r) => r.name === n)!;
    assert.equal(by('ORCH').costUsd, null, 'flagged unpriced -> null');
    assert.equal(by('ORCH').lanes[0]!.costUsd, 0.5, 'priced lane keeps its number');
    const v = await deskRoster({ stateDir: sd, stack: 't', prune: false });
    const row = (n: string) => v.rows.find((r) => r.name === n)!;
    assert.equal(row('ORCH').treeCostUsd, null, 'a tree with an unknown part is unknown');
    assert.equal(by('PRICED').costUsd, 0.25);
    assert.equal(row('PRICED').treeCostUsd, 0.25);
    assert.equal(by('LEGACY').costUsd, null, 'legacy desk-host record: 0 cost with tokens and no costSource is unknown');
  });

  it('lists stopped lanes launched by a human (or a gone launcher) as top-level rows', async () => {
    const sd = tmpDir();
    await putEntry(sd, 't', entry('ORCH', { kind: 'desk', runId: 'r-orch', port: 2 }));
    writeRunRecord(sd, rec('r-orch', 'ORCH', 'desk', { totals: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 1 } }));
    writeRunRecord(sd, rec('r-human', 'LANE1', 'lane', { startedAt: 10, totals: { inputTokens: 7, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.5 } }));
    writeRunRecord(sd, rec('r-orphan', 'LANE2', 'lane', { startedAt: 20, parentRunId: 'r-gone', totals: { inputTokens: 3, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.25 } }));
    writeRunRecord(sd, rec('r-child', 'LANE2-child', 'lane', { startedAt: 30, parentRunId: 'r-orphan', totals: { inputTokens: 2, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.125 } }));
    const rows = await deskCosts({ stateDir: sd, stack: 't' });
    assert.deepEqual(rows.map((r) => [r.name, r.kind]), [['ORCH', 'desk'], ['LANE1', 'lane'], ['LANE2', 'lane']]);
    assert.deepEqual(rows[2]!.lanes.map((l) => l.name), ['LANE2-child'], 'nested lane is not repeated at top level');
    assert.equal(rows[1]!.costUsd, 0.5);
  });
});
