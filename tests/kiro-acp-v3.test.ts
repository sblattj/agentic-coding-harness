import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import {
  buildKiroAcpArgs,
  KiroAcpClient,
  KiroAcpError,
  kiroToolsPermissionPolicy,
  type AcpNotification,
} from '../src/adapters/kiro-acp.ts';
import { launchKiroAcp, type KiroAcpHandle } from '../src/adapters/kiro-acp-launch.ts';
import type { AgentEvent, RunSpec } from '../src/core/types.ts';
import type { ChildProcessLike, SpawnFn } from '../src/adapters/shared.ts';

// ---------------------------------------------------------------------------
// Engine v3 over ACP (#127). The fake server's `v3` scenarios mirror what
// kiro-cli 2.29.0 does with `--agent-engine v3` (see fake-acp-server.ts).
// ---------------------------------------------------------------------------

const FIXTURE_DIR = join(fileURLToPath(new URL('.', import.meta.url)), 'fixtures/kiro');
const SERVER = join(FIXTURE_DIR, 'fake-acp-server.ts');
const REPO_ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const SERVER_ARGV = (process.versions as { bun?: string }).bun ? [SERVER] : ['--import', 'tsx', SERVER];
const TMP = mkdtempSync(join(tmpdir(), 'kiro-acp-v3-'));
const clients: KiroAcpClient[] = [];

after(async () => {
  await Promise.all(clients.map((c) => c.close()));
});

function makeClient(scenario: 'v3' | 'v3-permission' | 'v3-late-models', log?: string): KiroAcpClient {
  const client = new KiroAcpClient({
    command: process.execPath,
    args: SERVER_ARGV,
    cwd: REPO_ROOT,
    env: { FAKE_ACP_SCENARIO: scenario, ...(log ? { FAKE_ACP_STDIN_LOG: log } : {}) },
    startupMs: 15_000,
    termGraceMs: 300,
    killGraceMs: 300,
  });
  clients.push(client);
  client.start();
  return client;
}

function logLines(path: string): Array<{ method?: string; params?: Record<string, unknown> }> {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { method?: string; params?: Record<string, unknown> });
}

function logMethods(path: string): string[] {
  return logLines(path)
    .map((m) => m.method ?? '<response>')
    .filter((m) => m !== '<response>');
}

function drainInBackground(client: KiroAcpClient): AcpNotification[] {
  const seen: AcpNotification[] = [];
  void (async () => {
    for await (const n of client.notifications) seen.push(n);
  })();
  return seen;
}

async function rejection(p: Promise<unknown>): Promise<unknown> {
  return p.then(
    () => null,
    (e: unknown) => e,
  );
}

// ---------------------------------------------------------------------------

describe('buildKiroAcpArgs engine v3 (#127)', () => {
  it('omits --agent/--model/--effort/--trust-* for v3 and keeps --agent-engine v3', () => {
    for (const tools of ['all', 'none', ['read', 'shell']] as const) {
      const args = buildKiroAcpArgs({
        agent: 'demo-agent',
        model: 'claude-sonnet-5.5',
        effort: 'high',
        tools: tools as 'all' | 'none' | string[],
        engine: 'v3',
      });
      assert.deepEqual(args, ['acp', '--agent-engine', 'v3']);
    }
  });

  it('leaves v2 (and engine-less) argv unchanged', () => {
    const cfg = { agent: 'demo-agent', model: 'claude-sonnet-5.5', effort: 'high' as const, tools: 'all' as const };
    assert.deepEqual(buildKiroAcpArgs({ ...cfg, engine: 'v2' }), [
      'acp',
      '--agent',
      'demo-agent',
      '--model',
      'claude-sonnet-5.5',
      '--effort',
      'high',
      '--trust-all-tools',
      '--agent-engine',
      'v2',
    ]);
    assert.deepEqual(buildKiroAcpArgs(cfg), [
      'acp',
      '--agent',
      'demo-agent',
      '--model',
      'claude-sonnet-5.5',
      '--effort',
      'high',
      '--trust-all-tools',
    ]);
  });
});

describe('KiroAcpClient handshake on engine v3 (#127)', () => {
  it('selects agent, model and effort via session/set_config_option and verifies each', async () => {
    const log = join(TMP, `v3-ok-${Date.now()}.log`);
    const client = makeClient('v3', log);
    drainInBackground(client);
    const receipt = await client.handshake({
      cwd: TMP,
      engine: 'v3',
      agent: 'demo-agent',
      model: 'claude-sonnet-5.5',
      effort: 'high',
      requireModelAck: true,
    });
    const result = await client.prompt(receipt.sessionId, 'ping');
    assert.equal(result.stopReason, 'end_turn');
    await client.close();

    assert.equal(receipt.modelAck, 'acknowledged');
    assert.equal(receipt.modelVerified, true);
    assert.equal(receipt.agentVerified, true);
    assert.equal(receipt.effortAck, 'acknowledged');
    assert.equal(receipt.currentModeId, 'demo-agent');
    assert.equal(receipt.currentModelId, 'claude-sonnet-5.5');
    assert.equal(receipt.currentEffort, 'high');
    assert.ok(receipt.availableModels.some((m) => m.modelId === 'claude-sonnet-5.5'));

    // set_model does not exist on v3: never sent. Order: mode, model, effort, then prompt.
    assert.deepEqual(logMethods(log), [
      'initialize',
      'session/new',
      'session/set_config_option',
      'session/set_config_option',
      'session/set_config_option',
      'session/prompt',
    ]);
    const sets = logLines(log)
      .filter((m) => m.method === 'session/set_config_option')
      .map((m) => [m.params?.configId, m.params?.value]);
    assert.deepEqual(sets, [
      ['mode', 'demo-agent'],
      ['model', 'claude-sonnet-5.5'],
      ['effortLevel', 'high'],
    ]);
  });

  it('sets only the model when no agent/effort is requested', async () => {
    const log = join(TMP, `v3-model-${Date.now()}.log`);
    const client = makeClient('v3', log);
    drainInBackground(client);
    const receipt = await client.handshake({ cwd: TMP, engine: 'v3', model: 'claude-opus-5.5', requireModelAck: true });
    await client.close();
    assert.equal(receipt.modelAck, 'acknowledged');
    assert.equal(receipt.agentVerified, false);
    assert.equal(receipt.effortAck, 'not-requested');
    const sets = logLines(log)
      .filter((m) => m.method === 'session/set_config_option')
      .map((m) => m.params?.configId);
    assert.deepEqual(sets, ['model']);
  });

  it('fails fast on an agent v3 does not offer, suggesting the headless transport, before any prompt', async () => {
    const log = join(TMP, `v3-agent-${Date.now()}.log`);
    const client = makeClient('v3', log);
    drainInBackground(client);
    const err = await rejection(
      client.handshake({ cwd: TMP, engine: 'v3', agent: 'no-such-agent', model: 'claude-sonnet-5.5' }),
    );
    await client.close();
    assert.ok(err instanceof KiroAcpError, String(err));
    const msg = (err as KiroAcpError).message;
    assert.match(msg, /no-such-agent/);
    assert.match(msg, /--kiro-transport headless/);
    assert.match(msg, /demo-agent/, 'names the available agents');
    assert.ok(!logMethods(log).includes('session/prompt'));
  });

  it('a model the session does not offer is rejected (v3 would store it verbatim)', async () => {
    const client = makeClient('v3');
    drainInBackground(client);
    const err = await rejection(client.handshake({ cwd: TMP, engine: 'v3', model: 'no-such-model', requireModelAck: true }));
    await client.close();
    assert.ok(err instanceof KiroAcpError, String(err));
    assert.match((err as KiroAcpError).message, /no-such-model/);

    const lenient = makeClient('v3');
    drainInBackground(lenient);
    const receipt = await lenient.handshake({ cwd: TMP, engine: 'v3', model: 'no-such-model', requireModelAck: false });
    await lenient.close();
    assert.equal(receipt.modelAck, 'rejected');
    assert.equal(receipt.modelVerified, false);
  });

  it('fails when the requested effort is not available for the model, instead of claiming it', async () => {
    const client = makeClient('v3');
    drainInBackground(client);
    const err = await rejection(
      client.handshake({ cwd: TMP, engine: 'v3', model: 'claude-haiku-4.5', effort: 'high', requireModelAck: true }),
    );
    await client.close();
    assert.ok(err instanceof KiroAcpError, String(err));
    assert.match((err as KiroAcpError).message, /effort 'high'/);
  });

  it('waits (bounded) for a model catalog that loads after session/new, then sets and verifies', async () => {
    const log = join(TMP, `v3-late-${Date.now()}.log`);
    const client = makeClient('v3-late-models', log);
    drainInBackground(client);
    const receipt = await client.handshake({
      cwd: TMP,
      engine: 'v3',
      model: 'claude-sonnet-5.5',
      effort: 'low',
      requireModelAck: true,
    });
    await client.close();
    assert.equal(receipt.modelAck, 'acknowledged');
    assert.equal(receipt.currentModelId, 'claude-sonnet-5.5');
    assert.equal(receipt.effortAck, 'acknowledged');
    assert.equal(receipt.currentEffort, 'low');
  });

  it('resume on v3 applies the same selection after session/load', async () => {
    const log = join(TMP, `v3-resume-${Date.now()}.log`);
    const client = makeClient('v3', log);
    drainInBackground(client);
    const receipt = await client.handshake({
      cwd: TMP,
      engine: 'v3',
      resume: 'sess_fake-v3',
      model: 'claude-sonnet-5.5',
      requireModelAck: true,
    });
    await client.close();
    assert.equal(receipt.resumed, true);
    assert.equal(receipt.modelAck, 'acknowledged');
    assert.deepEqual(logMethods(log), ['initialize', 'session/load', 'session/set_config_option']);
  });
});

describe('kiroToolsPermissionPolicy (#127)', () => {
  const request = {
    sessionId: 's',
    toolCall: { toolCallId: 't', title: 'read', kind: 'execute', _meta: { kiro: { toolId: 'shell' } } },
    options: [
      { optionId: 'always', kind: 'allow_always' },
      { optionId: 'once', kind: 'allow_once' },
      { optionId: 'no', kind: 'reject_once' },
    ],
  };

  it("tools 'all' allows once", async () => {
    assert.deepEqual(await kiroToolsPermissionPolicy('all')!(request), {
      outcome: { outcome: 'selected', optionId: 'once' },
    });
  });

  it('a tool list allows only listed tools (by tool id or ACP kind, never by title)', async () => {
    assert.deepEqual(await kiroToolsPermissionPolicy(['shell'])!(request), {
      outcome: { outcome: 'selected', optionId: 'once' },
    });
    assert.deepEqual(await kiroToolsPermissionPolicy(['execute'])!(request), {
      outcome: { outcome: 'selected', optionId: 'once' },
    });
    assert.deepEqual(await kiroToolsPermissionPolicy(['read'])!(request), { outcome: { outcome: 'cancelled' } });
  });

  it("tools 'none' denies; undefined keeps the default (no policy)", async () => {
    assert.deepEqual(await kiroToolsPermissionPolicy('none')!(request), { outcome: { outcome: 'cancelled' } });
    assert.equal(kiroToolsPermissionPolicy(undefined), undefined);
  });

  it('never selects when no allow option is offered', async () => {
    const onlyReject = { ...request, options: [{ optionId: 'no', kind: 'reject_once' }] };
    assert.deepEqual(await kiroToolsPermissionPolicy('all')!(onlyReject), { outcome: { outcome: 'cancelled' } });
  });
});

// ---------------------------------------------------------------------------
// Launch path
// ---------------------------------------------------------------------------

interface Harness {
  spawnFn: SpawnFn;
  argv: string[];
  log: string;
}

function harness(scenario: string): Harness {
  const log = join(TMP, `launch-${scenario}-${Math.random().toString(36).slice(2)}.log`);
  const h: Harness = { spawnFn: () => ({}) as ChildProcessLike, argv: [], log };
  h.spawnFn = (_command, args, spawnOpts) => {
    h.argv = args;
    const child = spawn(process.execPath, SERVER_ARGV, {
      ...spawnOpts,
      cwd: REPO_ROOT,
      env: { ...process.env, FAKE_ACP_SCENARIO: scenario, FAKE_ACP_STDIN_LOG: log },
      shell: false,
    });
    return child as unknown as ChildProcessLike;
  };
  return h;
}

async function run(
  scenario: string,
  spec: Partial<RunSpec>,
): Promise<{ events: AgentEvent[]; status: string; handle: KiroAcpHandle; h: Harness }> {
  const h = harness(scenario);
  const handle = (await launchKiroAcp({ prompt: 'hello', cwd: REPO_ROOT, ...spec } as RunSpec, {
    command: 'kiro-cli',
    spawnFn: h.spawnFn,
  })) as KiroAcpHandle;
  const events: AgentEvent[] = [];
  for await (const e of handle.attach()) events.push(e);
  const status = await handle.wait();
  return { events, status, handle, h };
}

function permissionAnswer(events: AgentEvent[]): unknown {
  const step = events.find(
    (e) => e.type === 'step' && (e as { data?: { kind?: string } }).data?.kind === 'clientRequest',
  ) as { data: { method: string; answered: unknown } } | undefined;
  assert.ok(step, 'expected a clientRequest step');
  assert.equal(step.data.method, 'session/request_permission');
  return step.data.answered;
}

describe('launchKiroAcp on engine v3 (#127)', () => {
  it('spawns with only --agent-engine v3, applies agent/model/effort over ACP and records truthful evidence', async () => {
    const { events, status, handle, h } = await run('v3', {
      model: 'claude-sonnet-5.5',
      kiro: { transport: 'acp', engine: 'v3', agent: 'demo-agent', effort: 'high', tools: 'all' },
    });
    assert.deepEqual(
      events.filter((e) => e.type === 'error'),
      [],
    );
    assert.equal(status, 'success');
    assert.deepEqual(h.argv, ['acp', '--agent-engine', 'v3']);
    const kiro = handle.kiro();
    assert.ok(kiro);
    assert.equal(kiro.modelAck, 'acknowledged');
    const eff = kiro.effective as Record<string, unknown>;
    assert.equal(eff.engine, 'v3');
    assert.equal(eff.agentVerified, true);
    assert.equal(eff.currentModeId, 'demo-agent');
    assert.equal(eff.currentModelId, 'claude-sonnet-5.5');
    assert.equal(eff.effortAck, 'acknowledged');
    assert.equal(eff.currentEffort, 'high');
    assert.equal(eff.toolTrust, 'acp-permission-policy');
  });

  it('an unknown agent on v3 ends in one error naming the headless transport, and no prompt', async () => {
    const { events, status, handle, h } = await run('v3', {
      model: 'claude-sonnet-5.5',
      kiro: { transport: 'acp', engine: 'v3', agent: 'no-such-agent' },
    });
    assert.equal(status, 'error');
    const errs = events.filter((e) => e.type === 'error');
    assert.equal(errs.length, 1);
    assert.match(JSON.stringify(errs[0]), /--kiro-transport headless/);
    assert.ok(!logMethods(h.log).includes('session/prompt'));
    const eff = handle.kiro()!.effective as Record<string, unknown>;
    assert.equal(eff.agentVerified, false);
  });

  it("tools 'all' answers v3 permission requests with allow", async () => {
    const { events, status } = await run('v3-permission', { kiro: { transport: 'acp', engine: 'v3', tools: 'all' } });
    assert.deepEqual(permissionAnswer(events), { outcome: { outcome: 'selected', optionId: 'allow-once' } });
    assert.equal(status, 'success');
  });

  it('a tool list allows listed tools and denies the rest on v3', async () => {
    const allowed = await run('v3-permission', { kiro: { transport: 'acp', engine: 'v3', tools: ['shell'] } });
    assert.deepEqual(permissionAnswer(allowed.events), { outcome: { outcome: 'selected', optionId: 'allow-once' } });
    const denied = await run('v3-permission', { kiro: { transport: 'acp', engine: 'v3', tools: ['read'] } });
    assert.deepEqual(permissionAnswer(denied.events), { outcome: { outcome: 'cancelled' } });
  });

  it("tools 'none' or unset keeps the default deny on v3", async () => {
    for (const kiro of [
      { transport: 'acp' as const, engine: 'v3' as const, tools: 'none' as const },
      { transport: 'acp' as const, engine: 'v3' as const },
    ]) {
      const { events } = await run('v3-permission', { kiro });
      assert.deepEqual(permissionAnswer(events), { outcome: { outcome: 'cancelled' } });
    }
  });

  it('v2 keeps the argv trust flag and the default-deny client (unchanged)', async () => {
    const { events, h } = await run('permission', { kiro: { transport: 'acp', engine: 'v2', tools: 'all' } });
    assert.deepEqual(h.argv, ['acp', '--trust-all-tools', '--agent-engine', 'v2']);
    assert.deepEqual(permissionAnswer(events), { outcome: { outcome: 'cancelled' } });
  });
});
