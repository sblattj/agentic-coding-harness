import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { createDriver } from '../src/core/driver.js';
import { runToDirectory } from '../src/core/run-to-directory.js';
import type { AgentAdapter, AgentEvent, AgentHandle, RunResult, RunSpec } from '../src/core/types.js';

// ---------------------------------------------------------------------------
// Run-to-directory mode (#6): a RunSpec carrying outputDir mirrors the whole
// run into that directory and ALWAYS leaves a terminal status.json — on
// success, watchdog timeout, idle timeout, abort, and crash. The mock
// adapters mirror the hang shapes from tests/driver.test.ts.
// ---------------------------------------------------------------------------

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'harness-rtd-'));
}

function readJson(file: string): Record<string, unknown> {
  return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
}

class MockHandle implements AgentHandle {
  readonly sessionId = `rtd-${Math.random().toString(36).slice(2, 8)}`;
  aborted = false;
  readonly #events: AgentEvent[];

  constructor(events: AgentEvent[]) {
    this.#events = events;
  }

  async *attach(): AsyncIterable<AgentEvent> {
    for (const e of this.#events) yield e;
  }

  abort(): void {
    this.aborted = true;
  }

  async wait(): Promise<'aborted' | 'success'> {
    return this.aborted ? 'aborted' : 'success';
  }
}

interface ScriptedSpec extends RunSpec {
  scriptedEvents?: AgentEvent[];
  launchError?: string;
}

class MockAdapter implements AgentAdapter {
  readonly name = 'mock';
  lastSpec?: RunSpec;

  async launch(spec: RunSpec): Promise<AgentHandle> {
    this.lastSpec = spec;
    const scripted = spec as ScriptedSpec;
    if (scripted.launchError !== undefined) throw new Error(scripted.launchError);
    return new MockHandle(scripted.scriptedEvents ?? []);
  }
}

class SilentThenHangHandle implements AgentHandle {
  readonly sessionId = 'rtd-hang-1';
  aborted = false;
  #wake?: () => void;

  async *attach(): AsyncIterable<AgentEvent> {
    yield { type: 'step', sessionId: this.sessionId, timestamp: Date.now() };
    await new Promise<void>((resolve) => {
      this.#wake = resolve;
    });
  }

  abort(): void {
    this.aborted = true;
    this.#wake?.();
  }

  async wait(): Promise<'aborted' | 'success'> {
    return this.aborted ? 'aborted' : 'success';
  }
}

class SilentThenHangAdapter implements AgentAdapter {
  readonly name = 'silent-hang';

  async launch(): Promise<AgentHandle> {
    return new SilentThenHangHandle();
  }
}

class HeartbeatHandle implements AgentHandle {
  readonly sessionId = 'rtd-heartbeat-1';
  aborted = false;
  #abortWakers: Array<() => void> = [];

  async *attach(): AsyncIterable<AgentEvent> {
    while (!this.aborted) {
      yield { type: 'step', sessionId: this.sessionId, timestamp: Date.now() };
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 25);
        this.#abortWakers.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }

  abort(): void {
    this.aborted = true;
    for (const wake of this.#abortWakers.splice(0)) wake();
  }

  async wait(): Promise<'aborted' | 'success'> {
    return this.aborted ? 'aborted' : 'success';
  }
}

class HeartbeatAdapter implements AgentAdapter {
  readonly name = 'heartbeat';

  async launch(): Promise<AgentHandle> {
    return new HeartbeatHandle();
  }
}

/** Adapter that drives the driver-merged onOutput tap with raw stdout chunks. */
class TapHandle implements AgentHandle {
  readonly sessionId = 'rtd-tap-1';

  constructor(private readonly emit: (chunk: string) => void) {}

  async *attach(): AsyncIterable<AgentEvent> {
    this.emit('raw-chunk-1\n');
    yield { type: 'step', sessionId: this.sessionId, timestamp: Date.now() };
    this.emit('raw-chunk-2\n');
    yield { type: 'progress', text: 'a line the CLI wrote to stderr', sessionId: this.sessionId, timestamp: Date.now() };
  }

  abort(): void {}

  async wait(): Promise<'success'> {
    return 'success';
  }
}

class TapAdapter implements AgentAdapter {
  readonly name = 'tap';

  async launch(spec: RunSpec): Promise<AgentHandle> {
    return new TapHandle(spec.onOutput ?? (() => {}));
  }
}

describe('run-to-directory: happy path', () => {
  it('writes the full artifact set with a success status.json', async () => {
    const dir = tmpDir();
    const driver = createDriver({ adapters: { mock: new MockAdapter() }, stateDir: tmpDir() });
    const result: RunResult = await driver.run('mock', {
      prompt: 'do the thing',
      runId: 'rtd-happy-1',
      outputDir: dir,
      scriptedEvents: [
        { type: 'session', sessionId: 'sess-1', timestamp: Date.now() },
        { type: 'step', sessionId: 'sess-1', timestamp: Date.now() },
      ],
    });

    assert.equal(result.exitStatus, 'success');

    // Full artifact set on disk.
    for (const name of ['invocation.json', 'status.json', 'events.jsonl', 'stdout.txt', 'stderr.txt', 'result.json']) {
      assert.ok(existsSync(join(dir, name)), `${name} exists`);
    }
    // Atomic writes leave no temp-file residue.
    assert.deepEqual(
      readdirSync(dir).filter((f) => f.includes('.tmp-')),
      [],
      'no .tmp-* residue',
    );

    // status.json: required fields + terminal state.
    const status = readJson(join(dir, 'status.json'));
    assert.equal(status.runId, 'rtd-happy-1');
    assert.equal(status.status, 'success');
    assert.equal(status.exitStatus, 'success');
    assert.equal(typeof status.updatedAt, 'number');
    assert.equal(typeof status.eventCount, 'number');
    assert.equal(status.eventCount, 2);

    // events.jsonl: one event per line, matching the collected events.
    const lines = readFileSync(join(dir, 'events.jsonl'), 'utf8').trim().split('\n');
    assert.equal(lines.length, status.eventCount);
    assert.equal(lines.length, result.events.length);
    result.events.forEach((event, i) => assert.deepEqual(JSON.parse(lines[i]!), event));

    // invocation.json: resolved command, args, cwd, startedAt.
    const invocation = readJson(join(dir, 'invocation.json'));
    assert.equal(invocation.command, 'mock');
    assert.deepEqual(invocation.args, []);
    assert.equal(invocation.cwd, process.cwd());
    assert.equal(typeof invocation.startedAt, 'number');
    assert.equal(invocation.prompt, 'do the thing');
    assert.equal(invocation.runId, 'rtd-happy-1');

    // result.json: the final result object.
    assert.deepEqual(readJson(join(dir, 'result.json')), result);
  });

  it('mirrors raw stdout chunks to stdout.txt and progress lines to stderr.txt', async () => {
    const dir = tmpDir();
    const driver = createDriver({ adapters: { tap: new TapAdapter() }, stateDir: tmpDir() });
    const result = await driver.run('tap', { prompt: 'hi', outputDir: dir });

    assert.equal(result.exitStatus, 'success');
    assert.equal(readFileSync(join(dir, 'stdout.txt'), 'utf8'), 'raw-chunk-1\nraw-chunk-2\n');
    assert.equal(readFileSync(join(dir, 'stderr.txt'), 'utf8'), 'a line the CLI wrote to stderr\n');
  });

  it('chains a caller-provided onOutput tap alongside the stdout.txt mirror', async () => {
    const dir = tmpDir();
    const seen: string[] = [];
    const driver = createDriver({ adapters: { tap: new TapAdapter() }, stateDir: tmpDir() });
    await driver.run('tap', { prompt: 'hi', outputDir: dir, onOutput: (c) => seen.push(c) });
    assert.deepEqual(seen, ['raw-chunk-1\n', 'raw-chunk-2\n']);
    assert.equal(readFileSync(join(dir, 'stdout.txt'), 'utf8'), 'raw-chunk-1\nraw-chunk-2\n');
  });
});

describe('run-to-directory: terminal status on every exit path', () => {
  it('leaves status "timeout" when the watchdog wall clock kills the run', async () => {
    const dir = tmpDir();
    const driver = createDriver({ adapters: { heartbeat: new HeartbeatAdapter() }, stateDir: tmpDir() });
    const result = await driver.run('heartbeat', { prompt: 'hi', outputDir: dir, timeoutMs: 200 });

    assert.equal(result.exitStatus, 'timeout');
    const status = readJson(join(dir, 'status.json'));
    assert.equal(status.status, 'timeout');
    assert.equal(status.exitStatus, 'timeout');
    // eventCount stays consistent with events.jsonl even mid-kill.
    const lines = readFileSync(join(dir, 'events.jsonl'), 'utf8').trim().split('\n');
    assert.equal(status.eventCount, lines.length);
    assert.ok(lines.length >= 2, `expected several heartbeats, got ${lines.length}`);
  });

  it('leaves status "idle-timeout" when the idle watchdog kills a silent run', async () => {
    const dir = tmpDir();
    const driver = createDriver({ adapters: { 'silent-hang': new SilentThenHangAdapter() }, stateDir: tmpDir() });
    const result = await driver.run('silent-hang', { prompt: 'hi', outputDir: dir, idleTimeoutMs: 150 });

    assert.equal(result.exitStatus, 'timeout');
    const status = readJson(join(dir, 'status.json'));
    assert.equal(status.status, 'idle-timeout');
    assert.equal(status.exitStatus, 'timeout');
    assert.equal(status.eventCount, 1);
  });

  it('leaves status "aborted" when driver.abort(runId) cancels the run', async () => {
    const dir = tmpDir();
    const driver = createDriver({ adapters: { 'silent-hang': new SilentThenHangAdapter() }, stateDir: tmpDir() });
    const pending = driver.run('silent-hang', { prompt: 'hi', runId: 'rtd-abort-1', outputDir: dir });
    await new Promise((r) => setTimeout(r, 25));
    assert.equal(driver.abort('rtd-abort-1'), true);
    const result = await pending;

    assert.equal(result.exitStatus, 'aborted');
    const status = readJson(join(dir, 'status.json'));
    assert.equal(status.status, 'aborted');
    assert.equal(status.exitStatus, 'aborted');
    assert.equal(status.runId, 'rtd-abort-1');
  });

  it('leaves status "error" when the adapter launch crashes', async () => {
    const dir = tmpDir();
    const adapter = new MockAdapter();
    const driver = createDriver({ adapters: { mock: adapter }, stateDir: tmpDir() });
    await assert.rejects(
      driver.run('mock', { prompt: 'hi', outputDir: dir, launchError: 'spawn exploded' }),
      /spawn exploded/,
    );

    const status = readJson(join(dir, 'status.json'));
    assert.equal(status.status, 'error');
    assert.equal(status.eventCount, 0);
    // The run settled without a RunResult, so result.json is absent.
    assert.ok(!existsSync(join(dir, 'result.json')));
  });
});

describe('runToDirectory helper', () => {
  it('runs through a provided driver and returns the artifact paths', async () => {
    const dir = tmpDir();
    const driver = createDriver({ adapters: { mock: new MockAdapter() }, stateDir: tmpDir() });
    const outcome = await runToDirectory({
      driver,
      agent: 'mock',
      spec: { prompt: 'via helper', runId: 'rtd-helper-1', scriptedEvents: [{ type: 'step', sessionId: 's', timestamp: Date.now() }] },
      outputDir: dir,
    });

    assert.equal(outcome.result.exitStatus, 'success');
    assert.equal(outcome.outputDir, dir);
    assert.equal(outcome.paths.status, join(dir, 'status.json'));
    assert.equal(outcome.result.runId, 'rtd-helper-1');
    const status = readJson(outcome.paths.status);
    assert.equal(status.status, 'success');
    assert.equal(status.eventCount, 1);
    assert.ok(existsSync(outcome.paths.invocation));
    assert.ok(existsSync(outcome.paths.events));
    assert.ok(existsSync(outcome.paths.stdout));
    assert.ok(existsSync(outcome.paths.stderr));
    assert.ok(existsSync(outcome.paths.result));
  });
});
