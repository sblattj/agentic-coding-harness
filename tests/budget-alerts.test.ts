import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  ThresholdAlerter,
  alertStateFile,
  cooldownMsFromEnv,
  freshAlertState,
  loadAlertState,
  parseThresholds,
  saveAlertState,
  DEFAULT_COOLDOWN_MS,
} from '../src/core/budget-alerts.ts';
import { createDriver } from '../src/core/driver.ts';
import { frame } from '../src/cli/dash.ts';
import { listRunRecords, type RunRecord } from '../src/core/registry.ts';
import type { AgentAdapter, AgentEvent, AgentHandle, RunSpec } from '../src/core/types.ts';

const HOUR = 3_600_000;

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'ach-alerts-'));
}

// ---------------------------------------------------------------- engine

describe('ThresholdAlerter (edge-triggered + cooldown)', () => {
  it('crossing 80% fires exactly one warning across 100 consecutive refreshes', () => {
    let now = 1_000_000;
    const a = new ThresholdAlerter({ thresholds: [0.8], cooldownMs: 24 * HOUR, state: freshAlertState(), now: () => now });
    let fired = 0;
    for (let i = 0; i < 100; i++) {
      now += 60_000;
      fired += a.observe('src', 0.85).length;
    }
    assert.equal(fired, 1);
  });

  it('dropping below and re-crossing within the cooldown fires none; after expiry it fires again', () => {
    let now = 0;
    const a = new ThresholdAlerter({ thresholds: [0.8], cooldownMs: 24 * HOUR, state: freshAlertState(), now: () => now });
    assert.deepEqual(a.observe('src', 0.9), [0.8]);
    now += HOUR;
    assert.deepEqual(a.observe('src', 0.5), []);
    now += HOUR;
    assert.deepEqual(a.observe('src', 0.9), [], 're-cross inside cooldown must stay quiet');
    now += 24 * HOUR;
    assert.deepEqual(a.observe('src', 0.5), []);
    assert.deepEqual(a.observe('src', 0.9), [0.8], 're-cross after cooldown fires again');
  });

  it('a jump across several thresholds fires each once, in ascending order', () => {
    const a = new ThresholdAlerter({ thresholds: [1, 0.5, 0.8], cooldownMs: HOUR, state: freshAlertState(), now: () => 0 });
    assert.deepEqual(a.observe('src', 1.2), [0.5, 0.8, 1]);
    assert.deepEqual(a.observe('src', 1.5), []);
  });

  it('sources are independent', () => {
    const a = new ThresholdAlerter({ thresholds: [0.5], cooldownMs: HOUR, state: freshAlertState(), now: () => 0 });
    assert.deepEqual(a.observe('run-a', 0.6), [0.5]);
    assert.deepEqual(a.observe('run-b', 0.6), [0.5]);
  });

  it('persisted state carries the cooldown across processes (a new alerter stays quiet)', () => {
    const dir = tmpDir();
    const file = alertStateFile(dir);
    let now = 5 * HOUR;
    const first = new ThresholdAlerter({ thresholds: [0.8], cooldownMs: 24 * HOUR, state: loadAlertState(file).state, now: () => now });
    assert.deepEqual(first.observe('src', 0.85), [0.8]);
    saveAlertState(file, first.state);

    now += HOUR; // a second process (dash refresh / next watch) starts fresh in memory
    const second = new ThresholdAlerter({ thresholds: [0.8], cooldownMs: 24 * HOUR, state: loadAlertState(file).state, now: () => now });
    assert.deepEqual(second.observe('src', 0.85), [], 'already announced within the cooldown');
  });
});

// ---------------------------------------------------------------- parsing + env

describe('parseThresholds', () => {
  it('accepts fractions in (0, 1] and sorts/dedupes them', () => {
    assert.deepEqual(parseThresholds('0.95,0.5, 0.8,0.8', '--warn-at'), [0.5, 0.8, 0.95]);
    assert.deepEqual(parseThresholds('1', '--budget-alerts'), [1]);
  });

  it('rejects percent-style values like 85 with a clear message', () => {
    assert.throws(() => parseThresholds('0.5,85', '--warn-at'), /--warn-at: threshold '85' is not a fraction in \(0, 1\] \(write 0\.85 for 85%\)/);
  });

  it('rejects 0, negatives, >1, and non-numbers', () => {
    for (const bad of ['0', '-0.2', '1.5', 'abc', '0.5,,0.8']) {
      assert.throws(() => parseThresholds(bad, '--warn-at'), /--warn-at/, bad);
    }
  });

  it("'off' / 'none' disable the family", () => {
    assert.deepEqual(parseThresholds('off', '--warn-at'), []);
    assert.deepEqual(parseThresholds('none', '--warn-at'), []);
  });
});

describe('cooldownMsFromEnv', () => {
  it('defaults to 24h', () => {
    assert.equal(cooldownMsFromEnv({}), DEFAULT_COOLDOWN_MS);
    assert.equal(DEFAULT_COOLDOWN_MS, 24 * HOUR);
  });

  it('honors AGENTIC_CODING_HARNESS_WARN_COOLDOWN_H (1h, mocked clock)', () => {
    const cooldownMs = cooldownMsFromEnv({ AGENTIC_CODING_HARNESS_WARN_COOLDOWN_H: '1' });
    assert.equal(cooldownMs, HOUR);
    let now = 0;
    const a = new ThresholdAlerter({ thresholds: [0.8], cooldownMs, state: freshAlertState(), now: () => now });
    assert.deepEqual(a.observe('src', 0.9), [0.8]);
    a.observe('src', 0.1);
    now += 30 * 60_000;
    assert.deepEqual(a.observe('src', 0.9), [], 'inside the 1h cooldown');
    a.observe('src', 0.1);
    now += 31 * 60_000;
    assert.deepEqual(a.observe('src', 0.9), [0.8], 'after the 1h cooldown');
  });

  it('rejects a non-numeric or negative cooldown', () => {
    assert.throws(() => cooldownMsFromEnv({ AGENTIC_CODING_HARNESS_WARN_COOLDOWN_H: 'soon' }), /AGENTIC_CODING_HARNESS_WARN_COOLDOWN_H/);
    assert.throws(() => cooldownMsFromEnv({ AGENTIC_CODING_HARNESS_WARN_COOLDOWN_H: '-1' }), /AGENTIC_CODING_HARNESS_WARN_COOLDOWN_H/);
  });
});

// ---------------------------------------------------------------- state file

describe('alert state file', () => {
  it('lives at <stateDir>/alerts.json', () => {
    assert.equal(alertStateFile('/x/state'), join('/x/state', 'alerts.json'));
  });

  it('corrupt file -> warning + fresh state, never a throw', () => {
    const dir = tmpDir();
    writeFileSync(alertStateFile(dir), '{not json');
    const loaded = loadAlertState(alertStateFile(dir));
    assert.deepEqual(loaded.state, freshAlertState());
    assert.match(loaded.warning ?? '', /alerts: state file .* unreadable \(.*\); starting fresh/);
  });

  it('wrong-shape file -> warning + fresh state', () => {
    const dir = tmpDir();
    writeFileSync(alertStateFile(dir), JSON.stringify({ version: 1, fired: { k: 'yesterday' } }));
    const loaded = loadAlertState(alertStateFile(dir));
    assert.deepEqual(loaded.state, freshAlertState());
    assert.ok(loaded.warning);
  });

  it('missing file -> fresh state, no warning', () => {
    const loaded = loadAlertState(alertStateFile(tmpDir()));
    assert.deepEqual(loaded.state, freshAlertState());
    assert.equal(loaded.warning, undefined);
  });

  it('deleting the state file re-arms every warning', () => {
    const dir = tmpDir();
    const file = alertStateFile(dir);
    const a = new ThresholdAlerter({ thresholds: [0.5, 0.8], cooldownMs: 24 * HOUR, state: freshAlertState(), now: () => 0 });
    assert.deepEqual(a.observe('src', 0.9), [0.5, 0.8]);
    saveAlertState(file, a.state);
    assert.ok(existsSync(file));

    rmSync(file);
    const b = new ThresholdAlerter({ thresholds: [0.5, 0.8], cooldownMs: 24 * HOUR, state: loadAlertState(file).state, now: () => 1 });
    assert.deepEqual(b.observe('src', 0.9), [0.5, 0.8]);
  });
});

// ---------------------------------------------------------------- driver

type Scripted = { type: 'step' } | { type: 'usage_raw'; data: unknown };

class ScriptHandle implements AgentHandle {
  readonly sessionId = `mock-${Math.random().toString(36).slice(2, 8)}`;
  aborted = false;
  #done!: () => void;
  readonly #settled = new Promise<void>((r) => (this.#done = r));
  constructor(readonly script: Scripted[]) {}
  async *attach(): AsyncIterable<AgentEvent> {
    try {
      for (const e of this.script) {
        yield e.type === 'step'
          ? { type: 'step', sessionId: this.sessionId, timestamp: Date.now() }
          : { type: 'usage_raw', agent: 'mock', data: e.data, sessionId: this.sessionId, timestamp: Date.now() };
      }
    } finally {
      this.#done();
    }
  }
  abort(): void {
    this.aborted = true;
    this.#done();
  }
  async wait(): Promise<'aborted' | 'success'> {
    await this.#settled;
    return this.aborted ? 'aborted' : 'success';
  }
}

class ScriptAdapter implements AgentAdapter {
  readonly name = 'mock';
  last?: ScriptHandle;
  async launch(spec: RunSpec): Promise<AgentHandle> {
    this.last = new ScriptHandle((spec as { script?: Scripted[] }).script ?? []);
    return this.last;
  }
}

// 100k in * $3/1M = $0.30 per usage record (claude-sonnet-4 pricing).
const usd030 = (): Scripted => ({
  type: 'usage_raw',
  data: { modelUsage: { 'claude-sonnet-4': { model: 'claude-sonnet-4', inputTokens: 100_000, outputTokens: 0 } } },
});

function alertsOf(events: AgentEvent[]): AgentEvent[] {
  return events.filter((e) => e.type === 'budget.alert');
}

describe('driver budget alerts', () => {
  it('a run crossing 50/80/100% of budget.usd emits three budget.alert events and completes (onExceed: warn)', async () => {
    const stateDir = tmpDir();
    const tapped: AgentEvent[] = [];
    const adapter = new ScriptAdapter();
    const driver = createDriver({ adapters: { mock: adapter }, stateDir, registry: { stateDir }, onEvent: (e) => tapped.push(e) });
    // cumulative: 0.30 (30%), 0.60 (60%: 50 fires), 0.90 (90%: 80 fires), 1.20 (120%: 100 fires) of $1.00
    const result = await driver.run('mock', {
      prompt: 'hi',
      budget: { usd: 1, alerts: [0.5, 0.8, 1], onExceed: 'warn' },
      script: [usd030(), usd030(), usd030(), usd030(), { type: 'step' }],
    } as RunSpec);

    assert.equal(result.exitStatus, 'success', 'the run continues past the budget');
    assert.equal(adapter.last!.aborted, false);
    const alerts = alertsOf(result.events);
    assert.deepEqual(alerts.map((e) => e.threshold), [0.5, 0.8, 1]);
    for (const a of alerts) {
      assert.equal(a.metric, 'usd');
      assert.equal(a.family, 'budget');
      assert.equal(a.runId, result.runId);
      assert.equal(a.limit, 1);
      assert.equal(typeof a.data, 'string');
    }
    assert.deepEqual(alertsOf(tapped).map((e) => e.threshold), [0.5, 0.8, 1], 'alerts reach the onEvent tap');
    assert.ok(result.warnings.some((w) => /budget: usd cap \$1\.0000 exceeded .*continuing/.test(w)), result.warnings.join(' | '));

    // Same event stream: the raw transcript (what MCP harness_run_events pages) carries them.
    const raw = readFileSync(join(stateDir, 'raw', `mock-${result.sessionId}.jsonl`), 'utf8').trim().split('\n');
    assert.equal(raw.filter((l) => JSON.parse(l).type === 'budget.alert').length, 3);

    // Registry record (dash / web) carries them too.
    const rec = listRunRecords(stateDir).find((r) => r.runId === result.runId)!;
    assert.deepEqual(rec.alerts?.map((a) => a.threshold), [0.5, 0.8, 1]);
    assert.equal(rec.status, 'success');

    // Persisted state recorded each threshold.
    const state = JSON.parse(readFileSync(alertStateFile(stateDir), 'utf8'));
    assert.equal(Object.keys(state.fired).length, 3);
  });

  it('abort stays the default: the cap aborts (budget_exceeded) but the 100% alert still lands first', async () => {
    const stateDir = tmpDir();
    const adapter = new ScriptAdapter();
    const driver = createDriver({ adapters: { mock: adapter }, stateDir });
    const result = await driver.run('mock', {
      prompt: 'hi',
      budget: { usd: 0.5, alerts: [0.5, 0.8, 1] },
      script: [usd030(), usd030(), { type: 'step' }],
    } as RunSpec);
    assert.equal(result.exitStatus, 'budget_exceeded');
    assert.ok(adapter.last!.aborted);
    assert.deepEqual(alertsOf(result.events).map((e) => e.threshold), [0.5, 0.8, 1]);
  });

  it('the alert path never aborts on its own: alerts without a usd cap breach leave the run successful', async () => {
    const adapter = new ScriptAdapter();
    const driver = createDriver({ adapters: { mock: adapter }, stateDir: tmpDir() });
    const result = await driver.run('mock', {
      prompt: 'hi',
      budget: { usd: 1, alerts: [0.5, 0.8] },
      script: [usd030(), usd030(), usd030()],
    } as RunSpec);
    assert.equal(result.exitStatus, 'success');
    assert.equal(adapter.last!.aborted, false);
    assert.deepEqual(alertsOf(result.events).map((e) => e.threshold), [0.5, 0.8]);
  });

  it('near-limit warnings fire against budget.maxTurns', async () => {
    const driver = createDriver({ adapters: { mock: new ScriptAdapter() }, stateDir: tmpDir() });
    const result = await driver.run('mock', {
      prompt: 'hi',
      budget: { maxTurns: 10, warnAt: [0.5, 0.8] },
      script: Array.from({ length: 9 }, () => ({ type: 'step' }) as Scripted),
    } as RunSpec);
    assert.equal(result.exitStatus, 'success');
    const alerts = alertsOf(result.events);
    assert.deepEqual(alerts.map((e) => [e.metric, e.family, e.threshold, e.value]), [
      ['turns', 'near-limit', 0.5, 5],
      ['turns', 'near-limit', 0.8, 8],
    ]);
  });

  it('no thresholds configured -> no alert events (library default is opt-in)', async () => {
    const driver = createDriver({ adapters: { mock: new ScriptAdapter() }, stateDir: tmpDir() });
    const result = await driver.run('mock', { prompt: 'hi', budget: { usd: 10 }, script: [usd030()] } as RunSpec);
    assert.equal(alertsOf(result.events).length, 0);
  });

  it('a corrupt alert state file -> run warning + fresh state, exit status unaffected', async () => {
    const stateDir = tmpDir();
    writeFileSync(alertStateFile(stateDir), 'garbage');
    const driver = createDriver({ adapters: { mock: new ScriptAdapter() }, stateDir });
    const result = await driver.run('mock', {
      prompt: 'hi',
      budget: { usd: 1, alerts: [0.5] },
      script: [usd030(), usd030()],
    } as RunSpec);
    assert.equal(result.exitStatus, 'success');
    assert.ok(result.warnings.some((w) => /alerts: state file .* unreadable/.test(w)), result.warnings.join(' | '));
    assert.equal(alertsOf(result.events).length, 1);
  });

  it('rejects percent-style thresholds on the RunSpec', async () => {
    const driver = createDriver({ adapters: { mock: new ScriptAdapter() }, stateDir: tmpDir() });
    await assert.rejects(
      () => driver.run('mock', { prompt: 'hi', budget: { usd: 1, alerts: [85] } } as RunSpec),
      /budget\.alerts.*\(0, 1\]/,
    );
  });
});

// ---------------------------------------------------------------- dash

describe('dash banner', () => {
  it('renders one banner row per visible run with alerts (latest alert)', () => {
    const now = Date.now();
    const rec: RunRecord = {
      runId: 'abcdef1234',
      agent: 'claude',
      startedAt: now - 1000,
      updatedAt: now,
      status: 'success',
      alerts: [
        { at: now - 500, family: 'budget', metric: 'usd', threshold: 0.5, value: 0.6, limit: 1 },
        { at: now - 100, family: 'budget', metric: 'usd', threshold: 0.8, value: 0.9, limit: 1 },
      ],
    };
    const out = frame([rec], '/state', false, 160, false);
    const banner = out.split('\n').filter((l) => l.startsWith('ALERT'));
    assert.equal(banner.length, 1, out);
    assert.match(banner[0]!, /ALERT abcdef12 claude usd 80% \(\$0\.9000 of \$1\.0000\)/);
  });

  it('no banner when no run has alerts', () => {
    const now = Date.now();
    const out = frame([{ runId: 'r1', agent: 'claude', startedAt: now, updatedAt: now, status: 'success' }], '/s', false, 160, false);
    assert.ok(!out.includes('ALERT'));
  });
});

// ---------------------------------------------------------------- CLI flags

describe('ach run threshold flags', () => {
  const CLI = new URL('../src/cli/ach.ts', import.meta.url).pathname;
  function runCli(args: string[], env: Record<string, string> = {}) {
    const isBun = (process.versions as { bun?: string }).bun !== undefined;
    const p = spawnSync(process.execPath, isBun ? [CLI, ...args] : ['--import', 'tsx', CLI, ...args], {
      env: { ...process.env, AGENTIC_CODING_HARNESS_STATE_DIR: tmpDir(), ...env },
      encoding: 'utf8',
    });
    return { code: p.status ?? -1, stderr: p.stderr ?? '' };
  }

  it('--warn-at 85 errors before launching any agent', () => {
    const r = runCli(['run', '--agent', 'claude', '--max-turns', '5', '--warn-at', '0.5,85', 'hi']);
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /--warn-at: threshold '85' is not a fraction in \(0, 1\]/);
  });

  it('AGENTIC_CODING_HARNESS_BUDGET_ALERTS is validated the same way', () => {
    const r = runCli(['run', '--agent', 'claude', '--budget-usd', '1', 'hi'], { AGENTIC_CODING_HARNESS_BUDGET_ALERTS: '50,80' });
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /AGENTIC_CODING_HARNESS_BUDGET_ALERTS: threshold '50' is not a fraction/);
  });

  it('--on-budget rejects anything but abort|warn', () => {
    const r = runCli(['run', '--agent', 'claude', '--budget-usd', '1', '--on-budget', 'explode', 'hi']);
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /--on-budget expects abort\|warn/);
  });
});
