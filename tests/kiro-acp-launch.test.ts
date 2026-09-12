import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { launchKiroAcp, type KiroAcpHandle } from '../src/adapters/kiro-acp-launch.ts';
import type { AgentEvent, RunSpec } from '../src/core/types.ts';
import type { ChildProcessLike, SpawnFn } from '../src/adapters/shared.ts';

// ---------------------------------------------------------------------------
// Every test drives the scripted fake ACP server, never the paid binary.
// `node --import tsx <file>` keeps the server in ONE process (the tsx CLI
// wrapper would re-spawn node and swallow signals).
// ---------------------------------------------------------------------------

const FIXTURE_DIR = join(import.meta.dirname, 'fixtures/kiro');
const SERVER = join(FIXTURE_DIR, 'fake-acp-server.ts');
const REPO_ROOT = join(import.meta.dirname, '..');
const TMP = mkdtempSync(join(tmpdir(), 'kiro-acp-launch-'));

interface Harness {
  spawnFn: SpawnFn;
  /** argv the adapter built, as handed to spawn. */
  argv: string[];
  pids: number[];
  log: string;
}

function harness(scenario: string, opts: { log?: boolean } = {}): Harness {
  const log = opts.log === true ? join(TMP, `stdin-${scenario}-${Math.random().toString(36).slice(2)}.log`) : '';
  const h: Harness = { spawnFn: () => ({}) as ChildProcessLike, argv: [], pids: [], log };
  h.spawnFn = (_command, args, spawnOpts) => {
    h.argv = args;
    const child = spawn(process.execPath, ['--import', 'tsx', SERVER], {
      ...spawnOpts,
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        FAKE_ACP_SCENARIO: scenario,
        ...(log ? { FAKE_ACP_STDIN_LOG: log } : {}),
      },
      shell: false,
    });
    if (child.pid !== undefined) h.pids.push(child.pid);
    return child as unknown as ChildProcessLike;
  };
  return h;
}

function logMethods(path: string): string[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => String((JSON.parse(l) as { method?: string }).method ?? '<response>'));
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function drain(handle: KiroAcpHandle): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const e of handle.attach()) events.push(e);
  return events;
}

async function run(
  scenario: string,
  spec: Partial<RunSpec> = {},
  opts: { log?: boolean } = {},
): Promise<{ events: AgentEvent[]; status: string; handle: KiroAcpHandle; h: Harness }> {
  const h = harness(scenario, opts);
  const handle = (await launchKiroAcp(
    { prompt: 'hello', cwd: REPO_ROOT, ...spec } as RunSpec,
    { command: 'kiro-cli', spawnFn: h.spawnFn },
  )) as KiroAcpHandle;
  const events = await drain(handle);
  const status = await handle.wait();
  return { events, status, handle, h };
}

const errors = (events: AgentEvent[]): AgentEvent[] => events.filter((e) => e.type === 'error');

describe('launchKiroAcp — happy path', () => {
  it('runs the recorded 2.21.2 traffic to a successful exit', async () => {
    const { events, status, handle, h } = await run(
      'ok',
      { model: 'claude-haiku-4.5', kiro: { transport: 'acp', agent: 'dotai' } },
      { log: true },
    );
    assert.equal(status, 'success');
    assert.deepEqual(errors(events), []);

    // argv carries the requested model and agent (the whole point of ACP).
    assert.deepEqual(h.argv.slice(0, 5), ['acp', '--agent', 'dotai', '--model', 'claude-haiku-4.5']);

    // Order on the wire: the prompt is LAST, after set_model.
    const methods = logMethods(h.log);
    assert.ok(methods.includes('session/set_model'), `saw ${methods.join(',')}`);
    assert.ok(
      methods.indexOf('session/set_model') < methods.indexOf('session/prompt'),
      `set_model must precede the prompt: ${methods.join(',')}`,
    );

    // A session id reached the driver lane.
    const session = events.find((e) => e.type === 'session');
    assert.ok(session, 'expected a session event');
    assert.ok(typeof handle.sessionId === 'string' && handle.sessionId.length > 0);

    // Tool calls: started once, resulted once — no duplicate from tool_call_chunk.
    const starts = events.filter((e) => e.type === 'tool_call');
    const results = events.filter((e) => e.type === 'tool_result');
    assert.ok(starts.length > 0, 'expected at least one tool_call');
    const startIds = starts.map((e) => (e as { toolCallId: string }).toolCallId);
    assert.equal(new Set(startIds).size, startIds.length, 'tool starts must be deduped');
    assert.equal(results.length, new Set(results.map((e) => (e as { toolCallId: string }).toolCallId)).size);

    // Assistant text arrives as a coalesced message.
    const message = events.find((e) => e.type === 'message');
    assert.ok(message, 'expected a coalesced assistant message');

    // Usage: credits present, tokens NOT fabricated.
    const usage = events.find((e) => e.type === 'usage') as
      | { usage: { inputTokens: number; outputTokens: number; extra?: Record<string, unknown> } }
      | undefined;
    assert.ok(usage, 'expected a usage event');
    assert.equal(usage.usage.extra?.tokensAvailable, false);
    assert.equal(typeof usage.usage.extra?.credits, 'number');
    assert.ok((usage.usage.extra?.credits as number) > 0, 'credits must be a real charge');
    assert.equal(usage.usage.inputTokens, 0);
    assert.equal(usage.usage.outputTokens, 0);

    // Effective-config evidence.
    const evidence = handle.kiro();
    assert.ok(evidence, 'expected kiro() evidence');
    assert.equal(evidence.transport, 'acp');
    assert.equal(evidence.modelAck, 'acknowledged');
    assert.equal(evidence.requested.agent, 'dotai');
    assert.equal((evidence.effective as { agentVerified: boolean }).agentVerified, true);
    assert.equal((evidence.effective as { modelVerified: boolean }).modelVerified, true);
    assert.match(evidence.configHash, /^[0-9a-f]{64}$/);
  });

  it('appends spec.extraArgs verbatim after the built flags', async () => {
    const { h, status } = await run('ok', {
      kiro: { transport: 'acp', tools: 'none' },
      extraArgs: ['--zzz', 'value'],
    });
    assert.equal(status, 'success');
    assert.deepEqual(h.argv, ['acp', '--trust-tools=', '--zzz', 'value']);
  });
});

describe('launchKiroAcp — failure artifacts (no prompt is ever sent)', () => {
  it('reject-model: one error event naming session/set_model, exit error, NO prompt', async () => {
    const { events, status, h, handle } = await run(
      'reject-model',
      { model: 'claude-haiku-4.5', kiro: { transport: 'acp' } },
      { log: true },
    );
    assert.equal(status, 'error');
    const errs = errors(events);
    assert.equal(errs.length, 1, 'exactly one terminal error artifact');
    assert.match(String((errs[0] as { message: string }).message), /session\/set_model/);
    assert.ok(!logMethods(h.log).includes('session/prompt'), 'a rejected model must not be prompted');
    assert.equal(handle.kiro()?.modelAck, 'rejected');
  });

  it('wrong-mode: the requested agent is not the session mode → session/new error', async () => {
    const { events, status, h } = await run(
      'wrong-mode',
      { kiro: { transport: 'acp', agent: 'dotai' } },
      { log: true },
    );
    assert.equal(status, 'error');
    assert.equal(errors(events).length, 1);
    assert.match(String((errors(events)[0] as { message: string }).message), /session\/new/);
    assert.ok(!logMethods(h.log).includes('session/prompt'));
  });

  it('mcp-fail + requireMcpStartup: phase mcp, no prompt', async () => {
    const { events, status, h } = await run(
      'mcp-fail',
      { model: 'claude-haiku-4.5', kiro: { transport: 'acp', requireMcpStartup: true } },
      { log: true },
    );
    assert.equal(status, 'error');
    const msg = String((errors(events)[0] as { message: string }).message);
    assert.match(msg, /phase 'mcp'/);
    assert.match(msg, /governance_disabled/);
    assert.ok(!logMethods(h.log).includes('session/prompt'));
  });

  it('mcp-fail WITHOUT requireMcpStartup still runs (the notice is only a notice)', async () => {
    const { status, h } = await run(
      'mcp-fail',
      { model: 'claude-haiku-4.5', kiro: { transport: 'acp' } },
      { log: true },
    );
    assert.equal(status, 'success');
    assert.ok(logMethods(h.log).includes('session/prompt'));
  });

  it('silent-initialize: phase initialize inside startupMs, and the child is dead', async () => {
    const { events, status, h } = await run('silent-initialize', {
      kiro: { transport: 'acp', startupMs: 300 },
    });
    assert.equal(status, 'error');
    const msg = String((errors(events)[0] as { message: string }).message);
    assert.match(msg, /phase 'initialize'/);
    await new Promise((r) => setTimeout(r, 200));
    for (const pid of h.pids) assert.equal(isAlive(pid), false, `pid ${pid} outlived the run`);
  });

  it('crash-mid-prompt: exit error', async () => {
    const { events, status } = await run('crash-mid-prompt', { kiro: { transport: 'acp' } });
    assert.equal(status, 'error');
    assert.equal(errors(events).length, 1);
  });
});

describe('launchKiroAcp — permissions and cancellation', () => {
  it('permission request surfaces as a clientRequest step and is DENIED by default', async () => {
    const h = harness('permission');
    const handle = (await launchKiroAcp(
      { prompt: 'hello', cwd: REPO_ROOT, kiro: { transport: 'acp' } } as RunSpec,
      { command: 'kiro-cli', spawnFn: h.spawnFn },
    )) as KiroAcpHandle;
    const events = await drain(handle);
    await handle.wait();
    const step = events.find(
      (e) => e.type === 'step' && (e as { data?: { kind?: string } }).data?.kind === 'clientRequest',
    ) as { data: { method: string; answered: unknown } } | undefined;
    assert.ok(step, 'expected a clientRequest step');
    assert.equal(step.data.method, 'session/request_permission');
    assert.deepEqual(step.data.answered, { outcome: { outcome: 'cancelled' } });
  });

  it('abort mid-prompt sends session/cancel and exits aborted', async () => {
    const h = harness('slow-prompt', { log: true });
    const handle = (await launchKiroAcp(
      { prompt: 'hello', cwd: REPO_ROOT, kiro: { transport: 'acp' } } as RunSpec,
      { command: 'kiro-cli', spawnFn: h.spawnFn },
    )) as KiroAcpHandle;
    const collected = drain(handle);
    // Wait until the prompt is actually on the wire before aborting.
    for (let i = 0; i < 200; i++) {
      if (logMethods(h.log).includes('session/prompt')) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    handle.abort();
    await collected;
    assert.equal(await handle.wait(), 'aborted');
    assert.ok(logMethods(h.log).includes('session/cancel'), `log: ${logMethods(h.log).join(',')}`);
  });
});
