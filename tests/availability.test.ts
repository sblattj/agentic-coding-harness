// Issue #60: the `unavailable` exit status — a CLI/service outage is recorded
// apart from a genuine task failure, and success-rate rollups leave it out of
// the denominator by default.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { CodexAdapter } from '../src/adapters/codex.ts';
import { classifyLaunchError, classifyUnavailable } from '../src/core/availability.ts';
import { createDriver } from '../src/core/driver.ts';
import { listRunRecords, RunRecordSchema, type RunRecord } from '../src/core/registry.ts';
import { exitStatusToRunStatus } from '../src/core/run-artifacts.ts';
import { HarnessError, RunResultSchema, type AdapterExit, type AgentAdapter, type AgentEvent, type AgentHandle } from '../src/core/types.ts';
import { summarizeRunOutcomes } from '../src/cli/run-outcomes.ts';
import { computeCompareRows } from '../src/web/compare.ts';
import { renderReport } from '../src/report/html.ts';
import { toLoadedRun } from '../src/report/model.ts';

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** Scripted handle: yields the given events, then wait() reports `exit`. */
class ScriptedHandle implements AgentHandle {
  readonly sessionId = `scripted-${Math.random().toString(36).slice(2, 8)}`;
  constructor(
    readonly events: AgentEvent[],
    readonly exit: AdapterExit,
  ) {}
  async *attach(): AsyncIterable<AgentEvent> {
    for (const e of this.events) yield { ...e, timestamp: Date.now() };
  }
  abort(): void {}
  async wait(): Promise<AdapterExit> {
    return this.exit;
  }
}

function scripted(events: AgentEvent[], exit: AdapterExit): AgentAdapter {
  return { name: 'mock', launch: async () => new ScriptedHandle(events, exit) };
}

describe('classifyUnavailable (pure)', () => {
  it('flags the adapter spawn-failure error event (missing binary)', () => {
    const reason = classifyUnavailable({
      adapterExit: 'error',
      events: [{ type: 'error', message: 'failed to spawn codex: spawn codex ENOENT' }],
    });
    assert.match(reason ?? '', /could not be started/);
  });

  it('flags an error exit with no agent-activity events (crash before first event)', () => {
    const reason = classifyUnavailable({
      adapterExit: 'error',
      events: [
        { type: 'session', sessionId: 's1' },
        { type: 'progress', text: 'Error: not logged in' },
        { type: 'error', message: 'codex exited with code 1' },
      ],
    });
    assert.match(reason ?? '', /before its first event/);
  });

  it('keeps a genuine task failure (activity, then non-zero exit) as error', () => {
    assert.equal(
      classifyUnavailable({
        adapterExit: 'error',
        events: [
          { type: 'message', source: 'agent', content: 'working on it', timestamp: 0 },
          { type: 'tool_result', toolCallId: 't1', content: 'curl: 503 Service Unavailable ECONNREFUSED', timestamp: 0 },
          { type: 'error', message: 'codex exited with code 1' },
        ],
      }),
      null,
    );
  });

  it('never reclassifies a non-error exit', () => {
    for (const exit of ['success', 'aborted', 'cancelled', 'timeout'] as const) {
      assert.equal(classifyUnavailable({ adapterExit: exit, events: [] }), null, exit);
    }
  });

  it('classifyLaunchError: spawn ENOENT is unavailable, a missing cwd is not', () => {
    const err = Object.assign(new Error('spawn kiro-cli ENOENT'), { code: 'ENOENT' });
    assert.match(classifyLaunchError(err) ?? '', /could not be started/);
    assert.equal(classifyLaunchError(err, '/definitely/not/a/dir/ach-60'), null);
    assert.equal(classifyLaunchError(new Error('boom')), null);
  });
});

describe('ExitStatus schema carries unavailable', () => {
  it('RunResultSchema accepts exitStatus "unavailable"', () => {
    const parsed = RunResultSchema.safeParse({
      runId: 'r',
      sessionId: 's',
      events: [],
      tokens: [],
      totalCost: 0,
      durationMs: 1,
      exitStatus: 'unavailable',
      warnings: [],
    });
    assert.equal(parsed.success, true);
  });

  it('RunRecordSchema accepts status "unavailable"', () => {
    const parsed = RunRecordSchema.safeParse({
      runId: 'r',
      agent: 'codex',
      sessionId: 's',
      pid: 1,
      cwd: '/',
      promptPreview: 'p',
      startedAt: 1,
      updatedAt: 2,
      status: 'unavailable',
      exitStatus: 'unavailable',
    });
    assert.equal(parsed.success, true);
  });

  it('exitStatusToRunStatus maps unavailable to its own lifecycle state (never aborted)', () => {
    assert.equal(exitStatusToRunStatus('unavailable', null), 'unavailable');
  });
});

describe('driver records unavailable', () => {
  it('a run against a missing adapter binary records unavailable (real spawn ENOENT)', async () => {
    const stateDir = tmp('ach60-missing-');
    const outputDir = join(stateDir, 'out');
    const codex: AgentAdapter = {
      name: 'codex',
      launch: (spec) => new CodexAdapter({ command: '/nonexistent/ach-60/codex' }).launch(spec),
    };
    const driver = createDriver({ adapters: { codex }, stateDir, registry: { stateDir } });
    const result = await driver.run('codex', { prompt: 'hi', outputDir });
    assert.equal(result.exitStatus, 'unavailable');
    assert.ok(result.warnings.some((w) => /^unavailable: /.test(w)), result.warnings.join('\n'));
    const status = JSON.parse(readFileSync(join(outputDir, 'status.json'), 'utf8'));
    assert.equal(status.status, 'unavailable');
    assert.equal(status.exitStatus, 'unavailable');
    const [rec] = listRunRecords(stateDir);
    assert.equal(rec?.status, 'unavailable');
    assert.equal(rec?.exitStatus, 'unavailable');
  });

  it('an adapter that dies before the first event (simulated outage) records unavailable', async () => {
    const driver = createDriver({
      adapters: { mock: scripted([{ type: 'progress', text: '503 upstream overloaded' }], 'error') },
      stateDir: tmp('ach60-outage-'),
    });
    const result = await driver.run('mock', { prompt: 'hi' });
    assert.equal(result.exitStatus, 'unavailable');
  });

  it('a genuine task failure still records error', async () => {
    const driver = createDriver({
      adapters: {
        mock: scripted(
          [
            { type: 'message', source: 'agent', content: 'trying', timestamp: 0 },
            { type: 'error', message: 'mock exited with code 1' },
          ],
          'error',
        ),
      },
      stateDir: tmp('ach60-fail-'),
    });
    const result = await driver.run('mock', { prompt: 'hi' });
    assert.equal(result.exitStatus, 'error');
  });

  it('a launch() that throws spawn ENOENT rejects with an UNAVAILABLE HarnessError and settles status.json', async () => {
    const stateDir = tmp('ach60-launch-');
    const outputDir = join(stateDir, 'out');
    const adapter: AgentAdapter = {
      name: 'mock',
      launch: async () => {
        throw Object.assign(new Error('spawn kiro-cli ENOENT'), { code: 'ENOENT' });
      },
    };
    const driver = createDriver({ adapters: { mock: adapter }, stateDir });
    await assert.rejects(driver.run('mock', { prompt: 'hi', outputDir }), (err: unknown) => {
      assert.ok(err instanceof HarnessError);
      assert.equal(err.code, 'UNAVAILABLE');
      assert.equal(err.exitCode, 1);
      return true;
    });
    const status = JSON.parse(readFileSync(join(outputDir, 'status.json'), 'utf8'));
    assert.equal(status.status, 'unavailable');
    assert.equal(status.exitStatus, 'unavailable');
  });
});

function rec(agent: string, status: RunRecord['status'], exitStatus: string): RunRecord {
  return {
    runId: `${agent}-${Math.random()}`,
    agent,
    sessionId: 's',
    pid: 1,
    cwd: '/',
    promptPreview: '',
    startedAt: 1,
    updatedAt: 2,
    status,
    exitStatus,
  };
}

describe('success-rate rollups exclude unavailable by default', () => {
  const records = [
    rec('codex', 'success', 'success'),
    rec('codex', 'error', 'error'),
    rec('codex', 'unavailable', 'unavailable'),
    rec('codex', 'unavailable', 'unavailable'),
    rec('claude', 'success', 'success'),
  ];

  it('summarizeRunOutcomes: unavailable leaves the denominator unless included', () => {
    const def = summarizeRunOutcomes(records);
    assert.equal(def.total.runs, 5);
    assert.equal(def.total.unavailable, 2);
    assert.equal(def.total.successRate, 2 / 3);
    assert.equal(def.byAgent.codex?.successRate, 1 / 2);
    assert.equal(def.byAgent.codex?.unavailable, 2);
    const incl = summarizeRunOutcomes(records, { includeUnavailable: true });
    assert.equal(incl.total.successRate, 2 / 5);
    assert.equal(incl.byAgent.codex?.successRate, 1 / 4);
  });

  it('summarizeRunOutcomes: an all-unavailable agent has no success rate (null, rendered n/a)', () => {
    const out = summarizeRunOutcomes([rec('kiro', 'unavailable', 'unavailable')]);
    assert.equal(out.byAgent.kiro?.successRate, null);
  });

  it('computeCompareRows: unavailable excluded from successRate, counted separately', () => {
    const rows = computeCompareRows(records.filter((r) => r.agent === 'codex'), ['agent']);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.successRate, 1 / 2);
    assert.equal(rows[0]!.unavailable, 2);
  });

  it('computeCompareRows: no unavailable key when none were unavailable', () => {
    const rows = computeCompareRows([rec('claude', 'success', 'success')], ['agent']);
    assert.equal('unavailable' in rows[0]!, false);
  });
});

describe('report availability summary', () => {
  it('shows how many runs were unavailable per adapter', () => {
    const mk = (agent: string, exitStatus: string) =>
      toLoadedRun(
        agent,
        { runId: 'r', sessionId: 's', events: [], tokens: [], totalCost: 0, durationMs: 10, exitStatus, warnings: [] } as never,
        '/t/20260927-000000',
        '20260927-000000',
        null,
        false,
      );
    const html = renderReport(
      {
        rootDir: '/t',
        labels: ['20260927-000000'],
        runs: [mk('codex', 'unavailable'), mk('claude', 'success')],
      },
      { version: '0.0.0', generatedAt: new Date(0) },
    );
    assert.match(html, /availability/);
    assert.match(html, /codex[^<]*<\/td>\s*<td[^>]*>1<\/td>\s*<td[^>]*>1<\/td>/);
    assert.match(html, /st-unavailable/);
  });
});

describe('classifyUnavailable: auth failure event (claude not logged in)', () => {
  const msg: AgentEvent = { type: 'message', agent: 'claude', content: 'Not logged in', timestamp: 1 } as unknown as AgentEvent;
  it('an auth_failed error event settles unavailable with the hint, even after activity', () => {
    const auth = {
      type: 'error',
      agent: 'claude',
      message: 'claude: not logged in for this run. fix it',
      data: { kind: 'auth_failed' },
      timestamp: 2,
    } as AgentEvent;
    assert.equal(classifyUnavailable({ adapterExit: 'error', events: [msg, auth] }), 'claude: not logged in for this run. fix it');
  });
  it('a generic error after activity is still null', () => {
    const generic = { type: 'error', agent: 'claude', message: 'claude exited 1', data: { exitCode: 1 }, timestamp: 2 } as AgentEvent;
    assert.equal(classifyUnavailable({ adapterExit: 'error', events: [msg, generic] }), null);
  });
  it('an auth_failed event does not override a non-error exit', () => {
    const auth = { type: 'error', agent: 'claude', message: 'x', data: { kind: 'auth_failed' }, timestamp: 2 } as AgentEvent;
    assert.equal(classifyUnavailable({ adapterExit: 'success', events: [msg, auth] }), null);
  });
});
