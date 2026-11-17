import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { readRunRecord } from '../src/core/registry.ts';
import type { AgentAdapter, AgentEvent, AgentHandle, RunSpec } from '../src/core/types.ts';
import { DriverEngine } from '../src/desks/engines/driver.ts';
import type { GoalLoopHandle, GoalLoopOptions } from '../src/desks/engines/goal-loop.ts';
import type { EngineEvent, GoalStatus, HostSpec } from '../src/desks/types.ts';

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

class FakeHandle implements AgentHandle {
  aborted = false;
  #done!: () => void;
  readonly #settled = new Promise<void>((r) => (this.#done = r));
  constructor(
    readonly sessionId: string,
    readonly spec: RunSpec,
  ) {}
  async *attach(): AsyncIterable<AgentEvent> {
    const ts = Date.now();
    try {
      yield { type: 'session', sessionId: this.sessionId, timestamp: ts } as AgentEvent;
      if (this.spec.prompt.includes('HANG')) {
        await this.#settled;
        return;
      }
      if (this.spec.prompt.includes('TWO')) {
        yield { type: 'message', source: 'agent', content: 'interim thought', timestamp: ts } as AgentEvent;
      }
      yield { type: 'tool_call', functionName: 'Read', arguments: { file: 'x.ts' }, timestamp: ts } as AgentEvent;
      yield { type: 'message', source: 'agent', content: `echo:${this.spec.prompt.split('\n').pop()}`, timestamp: ts } as AgentEvent;
      yield {
        type: 'usage',
        usage: { model: 'claude-sonnet-4', inputTokens: 100, outputTokens: 20, cacheReadTokens: 5, cacheWriteTokens: 1, costUsd: 0.01 },
        timestamp: ts,
      } as AgentEvent;
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

class FakeAdapter implements AgentAdapter {
  readonly name = 'fake';
  readonly specs: RunSpec[] = [];
  readonly handles: FakeHandle[] = [];
  async launch(spec: RunSpec): Promise<AgentHandle> {
    this.specs.push(spec);
    const h = new FakeHandle(spec.resume ?? 'fake-sess-1', spec);
    this.handles.push(h);
    return h;
  }
}

function hostSpec(over: Partial<HostSpec> = {}): HostSpec {
  const stateDir = tmp('ach-drvengine-state-');
  const roleDir = tmp('ach-drvengine-roles-');
  const common = join(roleDir, 'common.md');
  const role = join(roleDir, 'pm.md');
  writeFileSync(common, 'You are desk $DESK_NAME.');
  writeFileSync(role, 'Role: PM for $DESK_NAME.');
  return {
    stack: 'teststack',
    stateDir,
    name: 'PM',
    kind: 'desk',
    role: 'pm',
    roleFiles: [common, role],
    agent: 'fake',
    engine: 'driver',
    mcps: ['gh', 'nodef'],
    mcpServers: { gh: { command: 'gh-mcp', args: ['serve'] } },
    port: 4801,
    cwd: tmp('ach-drvengine-cwd-'),
    runId: 'desk-run-1',
    ...over,
  };
}

async function idle(engine: DriverEngine, ms = 10_000): Promise<void> {
  const until = Date.now() + ms;
  while ((await engine.state()) !== 'idle') {
    if (Date.now() > until) throw new Error('engine stayed busy');
    await new Promise((r) => setTimeout(r, 10));
  }
}

const ENV = { ACH_SELF_ARGV: JSON.stringify(['/bin/ach-test']) };

describe('DriverEngine (fake adapter through the real core driver)', () => {
  it('chains resume across 2 turns and writes child run records with parentRunId + desk.kind turn', async () => {
    const fake = new FakeAdapter();
    const engine = new DriverEngine({ adapters: { fake }, env: ENV });
    const spec = hostSpec();
    await engine.start(spec);
    await engine.send('hello one');
    assert.equal(await engine.state(), 'busy', 'busy right after send');
    await idle(engine);
    await engine.send('hello two');
    await idle(engine);
    assert.equal(fake.specs.length, 2);
    assert.equal(fake.specs[0]!.resume, undefined, 'turn 1 starts a fresh session');
    assert.equal(fake.specs[1]!.resume, 'fake-sess-1', 'turn 2 resumes turn 1');
    assert.equal(engine.sessionId, 'fake-sess-1');
    assert.equal(engine.turnRunIds.length, 2);
    for (const id of engine.turnRunIds) {
      const rec = readRunRecord(spec.stateDir, id);
      assert.ok(rec, `child record ${id} exists`);
      assert.equal(rec.parentRunId, 'desk-run-1');
      assert.deepEqual(rec.desk, { stack: 'teststack', name: 'PM', kind: 'turn' });
      assert.equal(rec.totals?.inputTokens, 100, 'child record carries the turn metering');
    }
    // role context: non-claude agents get it prefixed on the first prompt only
    assert.match(fake.specs[0]!.prompt, /^You are desk PM\.\n\nRole: PM for PM\./);
    assert.doesNotMatch(fake.specs[1]!.prompt, /You are desk/);
    assert.equal(fake.specs[0]!.cwd, spec.cwd);
    assert.equal(fake.specs[0]!.extraArgs, undefined, 'claude-only flags stay off other agents');
  });

  it('maps driver events to turn_start, tool, text, usage, turn_end in order', async () => {
    const fake = new FakeAdapter();
    const engine = new DriverEngine({ adapters: { fake }, env: ENV });
    const events: EngineEvent[] = [];
    engine.onEvent((e) => events.push(e));
    await engine.start(hostSpec());
    await engine.send('ping');
    await idle(engine);
    assert.deepEqual(
      events.map((e) => e.type),
      ['turn_start', 'tool', 'text', 'usage', 'turn_end'],
    );
    assert.deepEqual(events[1]!.data, { tool: 'Read', summary: '{"file":"x.ts"}' });
    assert.equal(events[2]!.data.text, 'echo:ping');
    const u = events[3]!.data;
    assert.equal(u.inputTokens, 100);
    assert.equal(u.outputTokens, 20);
    assert.equal(u.cacheReadTokens, 5);
    assert.equal(u.cacheWriteTokens, 1);
    assert.equal(typeof u.costUsd, 'number');
    assert.equal(u.messageId, engine.turnRunIds[0]);
    assert.equal(events[4]!.data.exitStatus, 'success');
    assert.equal(events[4]!.data.sessionId, 'fake-sess-1');
  });

  it('notes are buffered (no turn) and prepended to the next prompt only', async () => {
    const fake = new FakeAdapter();
    const engine = new DriverEngine({ adapters: { fake }, env: ENV });
    await engine.start(hostSpec());
    await engine.send('first');
    await idle(engine);
    await engine.note('NOTE-ALPHA');
    await engine.note('NOTE-BETA');
    assert.equal(fake.specs.length, 1, 'a note never starts a turn');
    assert.equal(await engine.state(), 'idle');
    await engine.send('second');
    await idle(engine);
    await engine.send('third');
    await idle(engine);
    const p2 = fake.specs[1]!.prompt;
    assert.match(p2, /NOTE-ALPHA\nNOTE-BETA/);
    assert.ok(p2.indexOf('NOTE-BETA') < p2.indexOf('second'), 'notes come before the message');
    assert.ok(p2.endsWith('second'));
    assert.doesNotMatch(fake.specs[2]!.prompt, /NOTE-/);
  });

  it('MCP config carries desks (ACH_DESK_NAME env) + defined names; strict + permission set', async () => {
    const fake = new FakeAdapter();
    const engine = new DriverEngine({ adapters: { fake }, env: ENV });
    const spec = hostSpec();
    await engine.start(spec);
    await engine.send('x');
    await idle(engine);
    const sandbox = fake.specs[0]!.sandbox!;
    assert.equal(sandbox.permissionMode, 'dontAsk');
    assert.equal(typeof sandbox.mcpConfig, 'string');
    const cfg = JSON.parse(readFileSync(sandbox.mcpConfig as string, 'utf8')) as {
      mcpServers: Record<string, { command: string; args?: string[]; env?: Record<string, string> }>;
    };
    assert.deepEqual(Object.keys(cfg.mcpServers), ['desks', 'gh']);
    assert.equal(cfg.mcpServers.desks!.command, '/bin/ach-test');
    assert.deepEqual(cfg.mcpServers.desks!.args, ['mcp']);
    assert.equal(cfg.mcpServers.desks!.env!.ACH_DESK_NAME, 'PM');
    assert.equal(cfg.mcpServers.desks!.env!.ACH_DESK_STACK, 'teststack');
    assert.equal(cfg.mcpServers.desks!.env!.AGENTIC_CODING_HARNESS_STATE_DIR, spec.stateDir);
    assert.deepEqual(await engine.mcpStatus(), { desks: 'configured', gh: 'configured', nodef: 'missing definition' });
    assert.deepEqual(engine.attachCommand(), ['env', 'ACH_DESK_STACK=teststack', '/bin/ach-test', 'desk', 'chat', 'PM']);
  });

  it('claude turns get --strict-mcp-config and the role as --append-system-prompt on every turn', async () => {
    const fake = new FakeAdapter();
    const engine = new DriverEngine({ adapters: { claude: fake }, env: ENV });
    await engine.start(hostSpec({ agent: 'claude' }));
    await engine.send('a');
    await idle(engine);
    await engine.send('b');
    await idle(engine);
    for (const s of fake.specs) {
      assert.deepEqual(s.extraArgs, ['--strict-mcp-config', '--append-system-prompt', 'You are desk PM.\n\nRole: PM for PM.']);
      assert.doesNotMatch(s.prompt, /You are desk/, 'claude role rides the system prompt, not the message');
    }
  });

  it('stop() aborts the in-flight run and the child record ends aborted', async () => {
    const fake = new FakeAdapter();
    const engine = new DriverEngine({ adapters: { fake }, env: ENV });
    const events: EngineEvent[] = [];
    engine.onEvent((e) => events.push(e));
    const spec = hostSpec();
    await engine.start(spec);
    await engine.send('please HANG');
    const until = Date.now() + 5000;
    while (fake.handles.length === 0 && Date.now() < until) await new Promise((r) => setTimeout(r, 5));
    assert.equal(await engine.state(), 'busy');
    await engine.stop();
    assert.equal(fake.handles[0]!.aborted, true, 'adapter handle was aborted');
    assert.equal(await engine.state(), 'idle');
    const end = events.find((e) => e.type === 'turn_end');
    assert.equal(end?.data.exitStatus, 'aborted');
    assert.equal(readRunRecord(spec.stateDir, engine.turnRunIds[0]!)?.status, 'aborted');
    await assert.rejects(engine.send('after stop'), /stopped/);
  });

  it('serializes send() behind an in-flight turn (one run at a time on the session)', async () => {
    const fake = new FakeAdapter();
    const engine = new DriverEngine({ adapters: { fake }, env: ENV });
    await engine.start(hostSpec());
    await engine.send('one');
    await engine.send('two');
    await idle(engine);
    assert.equal(fake.specs.length, 2);
    assert.equal(fake.specs[1]!.resume, 'fake-sess-1', 'queued turn resumed the first turn');
  });

  it('setGoal runs the injected goal loop over real turns; goalStatus reflects it', async () => {
    const fake = new FakeAdapter();
    let opts: GoalLoopOptions | undefined;
    let status: GoalStatus = { objective: 'ship it', state: 'active', source: 'ach-loop', updatedAt: 1 };
    let stopped = '';
    const startGoalLoop = (o: GoalLoopOptions): GoalLoopHandle => {
      opts = o;
      return {
        status: () => status,
        stop: (r?: string) => {
          stopped = r ?? 'stopped';
        },
        done: Promise.resolve(status),
      };
    };
    const engine = new DriverEngine({ adapters: { fake }, env: ENV, startGoalLoop });
    await engine.start(hostSpec());
    assert.equal((await engine.goalStatus()).state, 'none');
    await engine.setGoal('ship it');
    assert.equal(opts?.objective, 'ship it');
    const text = await opts!.runTurn('do step 1');
    assert.equal(text, 'echo:do step 1', 'runTurn resolves with the final assistant text');
    assert.equal(await opts!.runTurn('TWO messages'), 'echo:TWO messages', 'only the last assistant text, not the interim one');
    status = { ...status, state: 'achieved' };
    assert.equal((await engine.goalStatus()).state, 'achieved');
    await engine.stop();
    assert.equal(stopped, 'engine stopped');
  });
});

// ---------------------------------------------------------------- live (claude)

const LIVE = { skip: process.env.ACH_DESKS_LIVE === '1' ? false : 'set ACH_DESKS_LIVE=1' };

function claudeChildren(marker: string): string {
  const r = spawnSync('pgrep', ['-f', marker], { encoding: 'utf8' });
  return r.stdout.trim();
}

describe('DriverEngine live (claude)', () => {
  it('PONG turn, resumed second turn keeps the session, child record lineage', LIVE, async () => {
    const stateDir = tmp('ach-drvengine-live-state-');
    const cwd = tmp('ach-drvengine-live-cwd-');
    const roleDir = join(cwd, '.roles');
    mkdirSync(roleDir);
    const role = join(roleDir, 'r.md');
    writeFileSync(
      role,
      'You are desk $DESK_NAME. Your codename is ZEBRAQUILL. Answer in as few words as possible.',
    );
    const spec: HostSpec = {
      stack: 'livestack',
      stateDir,
      name: 'LIVE',
      kind: 'desk',
      role: 'r',
      roleFiles: [role],
      agent: 'claude',
      engine: 'driver',
      model: 'claude-haiku-5-5',
      mcps: [],
      port: 4899,
      cwd,
      runId: 'live-desk-run',
    };
    // A real `ach mcp` for the desks server, so claude's init line can report it connected.
    const selfArgv = [join(process.cwd(), 'node_modules', '.bin', 'tsx'), join(process.cwd(), 'src', 'cli', 'ach.ts')];
    let stdout = '';
    const engine = new DriverEngine({
      env: { ...process.env, ACH_SELF_ARGV: JSON.stringify(selfArgv) },
      onOutput: (c) => {
        stdout += c;
      },
    });
    const events: EngineEvent[] = [];
    engine.onEvent((e) => events.push(e));
    await engine.start(spec);
    await engine.send('[desk-msg from TEST] reply with the single word PONG');
    await idle(engine, 120_000);
    const texts = events.filter((e) => e.type === 'text').map((e) => String(e.data.text));
    const errs = events.filter((e) => e.type === 'error');
    assert.deepEqual(errs, [], 'no error events');
    assert.ok(texts.some((t) => t.includes('PONG')), `text has PONG: ${JSON.stringify(texts)}`);
    const sid = engine.sessionId;
    assert.ok(sid, 'session id known after turn 1');
    const before = events.length;
    await engine.send('[desk-msg from TEST] which single word did you reply with last time? reply with just that word');
    await idle(engine, 120_000);
    assert.equal(engine.sessionId, sid, 'turn 2 resumed the same session');
    const texts2 = events.slice(before).filter((e) => e.type === 'text').map((e) => String(e.data.text));
    assert.ok(texts2.some((t) => t.includes('PONG')), `turn 2 remembers turn 1: ${JSON.stringify(texts2)}`);
    // Role delivery on a RESUMED turn: the codename lives only in the role file (system prompt).
    const before3 = events.length;
    await engine.send('[desk-msg from TEST] what is your codename? reply with just the codename');
    await idle(engine, 120_000);
    const texts3 = events.slice(before3).filter((e) => e.type === 'text').map((e) => String(e.data.text));
    assert.ok(texts3.some((t) => t.toUpperCase().includes('ZEBRAQUILL')), `role reached turn 3: ${JSON.stringify(texts3)}`);
    const usage = events.filter((e) => e.type === 'usage');
    assert.equal(usage.length, engine.turnRunIds.length, 'one usage event per turn');
    for (const [i, id] of engine.turnRunIds.entries()) {
      const rec = readRunRecord(stateDir, id);
      assert.equal(rec?.parentRunId, 'live-desk-run');
      assert.equal(rec?.desk?.kind, 'turn');
      assert.equal(rec?.status, 'success');
      const u = usage[i]!.data;
      assert.equal(u.messageId, id);
      assert.equal(u.inputTokens, rec?.totals?.inputTokens, 'usage input = child record input');
      assert.equal(u.outputTokens, rec?.totals?.outputTokens, 'usage output = child record output');
      assert.equal(u.cacheReadTokens, rec?.totals?.cacheReadTokens);
      assert.equal(u.cacheWriteTokens, rec?.totals?.cacheWriteTokens);
      assert.ok(Math.abs(Number(u.costUsd) - Number(rec?.totals?.costUsd)) < 1e-9, `cost ${u.costUsd} vs ${rec?.totals?.costUsd}`);
    }
    // claude's init line lists the MCP servers it loaded: desks only (strict), no user globals.
    const init = stdout.split('\n').find((l) => l.includes('"mcp_servers"'));
    assert.ok(init, 'claude printed its init line');
    const servers = (JSON.parse(init) as { mcp_servers: { name: string; status: string }[] }).mcp_servers;
    console.log(`live init mcp: ${JSON.stringify(servers)}`);
    assert.deepEqual(
      servers.map((s) => s.name),
      ['desks'],
      'strict: only the desks server, none of the user globals',
    );
    assert.equal(servers[0]!.status, 'connected');
    await engine.stop();
    // every claude turn's argv carries --mcp-config <stateDir>/desks/..., so stateDir marks our children
    assert.equal(claudeChildren(stateDir), '', 'no claude child left behind');
    // the desks MCP server (`ach mcp` under claude) must exit with its claude parent
    assert.equal(claudeChildren(`${join(process.cwd(), 'src', 'cli', 'ach.ts')} mcp`), '', 'no ach mcp child left behind');
    console.log(`live: session ${sid}, turns ${engine.turnRunIds.join(',')}, texts ${JSON.stringify(texts)}`);
  });
});
