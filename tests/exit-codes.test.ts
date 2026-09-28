// Issue #31: the opt-in automation exit-code ladder (`--exit-codes ladder`):
// 0 ok · 10 near-limit · 11 limit hit · 20 indeterminate (unavailable) ·
// 30 no data · 1 plain errors. Without the flag every command keeps 0/1.
//
// End-to-end cases drive the real CLI against a FAKE `codex` shell script on
// PATH (no real agent CLI, no network). budget_exceeded and turn_limit cannot
// be produced by the codex fake (its usage carries no priced model and it
// emits no step events), so 11 is covered through the real driver with a
// scripted in-process adapter and the same exit-code function the CLI uses.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import {
  EXIT_CODES,
  NEAR_LIMIT_FRACTION,
  budgetFractions,
  noDataExitCode,
  parseExitCodesMode,
  runExitCode,
} from '../src/cli/exit-codes.ts';
import { createDriver } from '../src/core/driver.ts';
import { HarnessError, type AdapterExit, type AgentAdapter, type AgentEvent, type AgentHandle, type RunResult } from '../src/core/types.ts';

const CLI = new URL('../src/cli/ach.ts', import.meta.url).pathname;

function result(over: Partial<RunResult>): RunResult {
  return {
    runId: 'r',
    sessionId: 's',
    events: [],
    tokens: [],
    totalCost: 0,
    durationMs: 100,
    exitStatus: 'success',
    warnings: [],
    ...over,
  };
}

describe('parseExitCodesMode', () => {
  it('defaults to binary; accepts ladder and binary', () => {
    assert.equal(parseExitCodesMode(undefined), 'binary');
    assert.equal(parseExitCodesMode('ladder'), 'ladder');
    assert.equal(parseExitCodesMode('binary'), 'binary');
  });
  it('rejects anything else as a USAGE error (exit 1)', () => {
    assert.throws(
      () => parseExitCodesMode('fancy'),
      (e: unknown) => e instanceof HarnessError && e.code === 'USAGE' && e.exitCode === 1,
    );
  });
});

describe('runExitCode — binary mode is exactly today (0/1)', () => {
  for (const s of ['error', 'timeout', 'aborted', 'cancelled', 'budget_exceeded', 'turn_limit', 'unavailable'] as const) {
    it(`${s} -> 1`, () => assert.equal(runExitCode(result({ exitStatus: s }), { mode: 'binary' }), 1));
  }
  it('success -> 0 even when near a limit', () => {
    assert.equal(runExitCode(result({ totalCost: 0.99 }), { mode: 'binary', budget: { usd: 1 } }), 0);
  });
});

describe('runExitCode — ladder mode', () => {
  const ladder = { mode: 'ladder' as const };
  it('success well inside every budget -> 0', () => {
    assert.equal(runExitCode(result({ totalCost: 0.1, durationMs: 100 }), { ...ladder, budget: { usd: 1, wallMs: 10_000 } }), 0);
  });
  it('success with no budget configured -> 0', () => {
    assert.equal(runExitCode(result({ totalCost: 50 }), ladder), EXIT_CODES.ok);
  });
  it(`success at >= ${NEAR_LIMIT_FRACTION * 100}% of the USD budget -> 10`, () => {
    assert.equal(runExitCode(result({ totalCost: 0.85 }), { ...ladder, budget: { usd: 1 } }), 10);
  });
  it('success at >= threshold of the wall-clock budget -> 10', () => {
    assert.equal(runExitCode(result({ durationMs: 900 }), { ...ladder, budget: { wallMs: 1000 } }), 10);
  });
  it('success at >= threshold of maxTurns (counted from step events) -> 10', () => {
    const steps: AgentEvent[] = Array.from({ length: 4 }, () => ({ type: 'step', timestamp: 0 }));
    assert.equal(runExitCode(result({ events: steps }), { ...ladder, agent: 'mock', budget: { maxTurns: 5 } }), 10);
  });
  it('a USD ratio is never claimed when the run says USD is unavailable (kiro credits)', () => {
    const r = result({
      totalCost: 0.95,
      usage: {
        tokens: { available: false, reason: 'x' },
        usd: { available: false, reason: 'credits only' },
      } as never,
    });
    assert.equal(runExitCode(r, { ...ladder, budget: { usd: 1 } }), 0);
    assert.deepEqual(budgetFractions(r, { budget: { usd: 1 } }), []);
  });
  it('budget_exceeded -> 11, turn_limit -> 11', () => {
    assert.equal(runExitCode(result({ exitStatus: 'budget_exceeded' }), ladder), 11);
    assert.equal(runExitCode(result({ exitStatus: 'turn_limit' }), ladder), 11);
  });
  it('unavailable -> 20', () => {
    assert.equal(runExitCode(result({ exitStatus: 'unavailable' }), ladder), 20);
  });
  it('error / timeout / aborted / cancelled keep 1', () => {
    for (const s of ['error', 'timeout', 'aborted', 'cancelled'] as const) {
      assert.equal(runExitCode(result({ exitStatus: s }), ladder), 1, s);
    }
  });
});

describe('noDataExitCode', () => {
  it('ladder: zero -> 30, some -> 0; binary: always 0', () => {
    assert.equal(noDataExitCode(0, 'ladder'), 30);
    assert.equal(noDataExitCode(3, 'ladder'), 0);
    assert.equal(noDataExitCode(0, 'binary'), 0);
  });
});

// ---- 11 through the real driver (scripted in-process adapter) ----

class StepHandle implements AgentHandle {
  readonly sessionId = 'steps';
  #aborted = false;
  constructor(readonly events: AgentEvent[]) {}
  async *attach(): AsyncIterable<AgentEvent> {
    for (const e of this.events) yield { ...e, timestamp: Date.now() };
  }
  abort(): void {
    this.#aborted = true;
  }
  async wait(): Promise<AdapterExit> {
    return this.#aborted ? 'aborted' : 'success';
  }
}

function scripted(events: AgentEvent[]): AgentAdapter {
  return { name: 'mock', launch: async () => new StepHandle(events) };
}

describe('ladder 11 through the driver', () => {
  it('a run the driver stops on turn_limit exits 11 (1 without the flag)', async () => {
    const driver = createDriver({
      adapters: { mock: scripted([{ type: 'step', timestamp: 0 }, { type: 'step', timestamp: 0 }, { type: 'step', timestamp: 0 }]) },
      stateDir: mkdtempSync(join(tmpdir(), 'ach31-turns-')),
    });
    const budget = { maxTurns: 1 };
    const r = await driver.run('mock', { prompt: 'hi', budget });
    assert.equal(r.exitStatus, 'turn_limit');
    assert.equal(runExitCode(r, { mode: 'ladder', agent: 'mock', budget }), 11);
    assert.equal(runExitCode(r, { mode: 'binary', agent: 'mock', budget }), 1);
  });

  it('a run the driver stops on budget_exceeded exits 11', async () => {
    const usage = {
      type: 'usage_raw',
      agent: 'mock',
      data: { modelUsage: { 'claude-sonnet-4': { model: 'claude-sonnet-4', inputTokens: 100_000, outputTokens: 10_000 } } },
    } as AgentEvent;
    const driver = createDriver({
      adapters: { mock: scripted([usage, usage]) },
      stateDir: mkdtempSync(join(tmpdir(), 'ach31-usd-')),
    });
    const budget = { usd: 0.5, onExceed: 'abort' as const };
    const r = await driver.run('mock', { prompt: 'hi', budget });
    assert.equal(r.exitStatus, 'budget_exceeded');
    assert.equal(runExitCode(r, { mode: 'ladder', agent: 'mock', budget }), 11);
  });
});

// ---- end-to-end: the real CLI against a fake `codex` on PATH ----

const FAKE_CODEX = `#!/bin/sh
# Fake codex for tests/exit-codes.test.ts: behaviour picked by FAKE_CODEX_MODE.
case "$FAKE_CODEX_MODE" in
  slow) /bin/sleep "$FAKE_CODEX_SLEEP" ;;
esac
echo '{"type":"thread.started","thread_id":"fake-thread"}'
echo '{"type":"item.completed","item":{"id":"i1","type":"agent_message","text":"done"}}'
if [ "$FAKE_CODEX_MODE" = "fail" ]; then
  echo '{"type":"turn.failed","error":{"message":"task failed"}}'
  exit 1
fi
echo '{"type":"turn.completed","usage":{"input_tokens":10,"cached_input_tokens":0,"output_tokens":5}}'
exit 0
`;

interface CliOut {
  code: number;
  stdout: string;
  stderr: string;
}

describe('ach CLI exit codes (end to end, fake codex)', () => {
  let root: string;
  let fakeBin: string;
  let emptyBin: string;

  before(() => {
    root = mkdtempSync(join(tmpdir(), 'ach31-cli-'));
    fakeBin = join(root, 'bin');
    emptyBin = join(root, 'empty-bin');
    mkdirSync(fakeBin);
    mkdirSync(emptyBin);
    writeFileSync(join(fakeBin, 'codex'), FAKE_CODEX);
    chmodSync(join(fakeBin, 'codex'), 0o755);
  });
  after(() => rmSync(root, { recursive: true, force: true }));

  function cli(args: string[], opts: { path?: string; env?: Record<string, string> } = {}): CliOut & { state: string } {
    const state = mkdtempSync(join(root, 'state-'));
    const home = mkdtempSync(join(root, 'home-'));
    const isBun = (process.versions as { bun?: string }).bun !== undefined;
    const p = spawnSync(process.execPath, isBun ? [CLI, ...args] : ['--import', 'tsx', CLI, ...args], {
      env: {
        ...process.env,
        AGENTIC_CODING_HARNESS_STATE_DIR: state,
        HOME: home,
        AGENTIC_CODING_HARNESS_BUDGET_USD: '',
        AGENTIC_CODING_HARNESS_MAX_TURNS: '',
        AGENTIC_CODING_HARNESS_WALL_MS: '',
        AGENTIC_CODING_HARNESS_IDLE_MS: '',
        PATH: opts.path ?? fakeBin,
        ...opts.env,
      },
      encoding: 'utf8',
      timeout: 60_000,
    });
    return { code: p.status ?? -1, stdout: p.stdout ?? '', stderr: p.stderr ?? '', state };
  }

  function exitStatusFromJson(out: CliOut): string {
    return (JSON.parse(out.stdout) as RunResult).exitStatus;
  }

  it('0: a clean run exits 0 with and without the flag', () => {
    const plain = cli(['run', '--agent', 'codex', '--json', 'hi'], { env: { FAKE_CODEX_MODE: 'ok' } });
    assert.equal(plain.code, 0, plain.stderr);
    assert.equal(exitStatusFromJson(plain), 'success');
    const ladder = cli(['run', '--agent', 'codex', '--json', '--exit-codes', 'ladder', '--wall-ms', '60000', 'hi'], {
      env: { FAKE_CODEX_MODE: 'ok' },
    });
    assert.equal(ladder.code, 0, ladder.stderr);
  });

  it('10: a successful run past the near-limit threshold of --wall-ms exits 10 (0 without the flag)', { timeout: 30_000 }, () => {
    const env = { FAKE_CODEX_MODE: 'slow', FAKE_CODEX_SLEEP: '4.2' };
    const ladder = cli(['run', '--agent', 'codex', '--json', '--exit-codes', 'ladder', '--wall-ms', '5000', 'hi'], { env });
    assert.equal(exitStatusFromJson(ladder), 'success', ladder.stderr);
    assert.equal(ladder.code, 10, ladder.stderr);
    const plain = cli(['run', '--agent', 'codex', '--json', '--wall-ms', '5000', 'hi'], { env });
    assert.equal(exitStatusFromJson(plain), 'success', plain.stderr);
    assert.equal(plain.code, 0, plain.stderr);
  });

  it('20: a missing agent binary records unavailable and exits 20 (1 without the flag)', () => {
    const ladder = cli(['run', '--agent', 'codex', '--json', '--exit-codes', 'ladder', 'hi'], { path: emptyBin });
    assert.equal(exitStatusFromJson(ladder), 'unavailable', ladder.stderr);
    assert.equal(ladder.code, 20, ladder.stderr);
    const plain = cli(['run', '--agent', 'codex', '--json', 'hi'], { path: emptyBin });
    assert.equal(exitStatusFromJson(plain), 'unavailable');
    assert.equal(plain.code, 1);
    // status surfaces in the run registry too
    const runsDir = join(plain.state, 'runs');
    const [file] = readdirSync(runsDir).filter((f) => f.endsWith('.json'));
    const rec = JSON.parse(readFileSync(join(runsDir, file!), 'utf8'));
    assert.equal(rec.exitStatus, 'unavailable');
  });

  it('1: a genuine task failure stays error and exits 1 under the flag', () => {
    const out = cli(['run', '--agent', 'codex', '--json', '--exit-codes', 'ladder', 'hi'], { env: { FAKE_CODEX_MODE: 'fail' } });
    assert.equal(exitStatusFromJson(out), 'error', out.stderr);
    assert.equal(out.code, 1);
  });

  it('1: argument and agent-name errors still exit 1 under the flag', () => {
    assert.equal(cli(['run', '--exit-codes', 'ladder', 'hi']).code, 1);
    assert.equal(cli(['run', '--agent', 'nope', '--exit-codes', 'ladder', 'hi']).code, 1);
    assert.equal(cli(['run', '--agent', 'codex', '--exit-codes', 'fancy', 'hi']).code, 1);
    assert.equal(cli(['stats', '--state-only', '--exit-codes', 'ladder', '--agent', 'nope']).code, 1);
  });

  it('30: stats with nothing to report exits 30 under the flag (0 without)', () => {
    const ladder = cli(['stats', '--state-only', '--json', '--exit-codes', 'ladder']);
    assert.equal(ladder.code, 30, ladder.stderr);
    const plain = cli(['stats', '--state-only', '--json']);
    assert.equal(plain.code, 0, plain.stderr);
    // No run records: no #60 runOutcomes rollup; #21's per-run context array is always present (empty).
    const j = JSON.parse(plain.stdout);
    assert.deepEqual(Object.keys(j).sort(), [
      'byAgent',
      'byDay',
      'byModel',
      'cacheHitRatio',
      'pace',
      'runs',
      'timezone',
      'total',
      'unpricedModels',
      'window',
    ]);
    assert.deepEqual(j.runs, []);
  });
});

describe('ach stats run outcomes (#60)', () => {
  let state: string;
  before(() => {
    state = mkdtempSync(join(tmpdir(), 'ach60-stats-'));
    mkdirSync(join(state, 'runs'));
    const base = { sessionId: 's', pid: 1, cwd: '/', promptPreview: '', startedAt: 1, updatedAt: 2, source: 'local' };
    const recs = [
      { runId: 'a', agent: 'codex', status: 'success', exitStatus: 'success' },
      { runId: 'b', agent: 'codex', status: 'error', exitStatus: 'error' },
      { runId: 'c', agent: 'codex', status: 'unavailable', exitStatus: 'unavailable' },
    ];
    for (const r of recs) writeFileSync(join(state, 'runs', `${r.runId}.json`), JSON.stringify({ ...base, ...r }));
  });
  after(() => rmSync(state, { recursive: true, force: true }));

  function stats(extra: string[]): CliOut {
    const isBun = (process.versions as { bun?: string }).bun !== undefined;
    const args = ['stats', '--state-only', ...extra];
    const p = spawnSync(process.execPath, isBun ? [CLI, ...args] : ['--import', 'tsx', CLI, ...args], {
      env: { ...process.env, AGENTIC_CODING_HARNESS_STATE_DIR: state, HOME: state },
      encoding: 'utf8',
    });
    return { code: p.status ?? -1, stdout: p.stdout ?? '', stderr: p.stderr ?? '' };
  }

  it('success rate excludes unavailable runs by default', () => {
    const out = stats(['--json']);
    assert.equal(out.code, 0, out.stderr);
    const j = JSON.parse(out.stdout);
    assert.equal(j.runOutcomes.total.runs, 3);
    assert.equal(j.runOutcomes.total.unavailable, 1);
    assert.equal(j.runOutcomes.total.successRate, 0.5);
    assert.equal(j.runOutcomes.includeUnavailable, false);
  });

  it('--include-unavailable restores the all-runs denominator', () => {
    const j = JSON.parse(stats(['--json', '--include-unavailable']).stdout);
    assert.equal(j.runOutcomes.total.successRate, 1 / 3);
  });

  it('text mode prints a runs line; run records count as data (ladder exit 0, not 30)', () => {
    const out = stats(['--exit-codes', 'ladder']);
    assert.equal(out.code, 0, out.stderr);
    assert.match(out.stdout, /runs codex\s+runs=3 success=1 unavailable=1 successRate=50\.0%/);
  });
});
