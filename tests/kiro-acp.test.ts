import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import {
  buildKiroAcpArgs,
  KiroAcpClient,
  KiroAcpError,
  type AcpNotification,
} from '../src/adapters/kiro-acp.ts';

/**
 * Mirrors `SCENARIOS` in tests/fixtures/kiro/fake-acp-server.ts. That module is
 * a stdio program with top-level side effects, so importing it here to reuse
 * the type would start a server inside the test runner.
 */
type FakeAcpScenarioName =
  | 'ok'
  | 'silent-initialize'
  | 'slow-initialize'
  | 'reject-model'
  | 'wrong-mode'
  | 'permission'
  | 'mcp-fail'
  | 'crash-mid-prompt'
  | 'ignore-sigterm'
  | 'fs-request';

// ---------------------------------------------------------------------------
// Harness: every test drives the scripted fake server, never the paid binary.
// ---------------------------------------------------------------------------

const FIXTURE_DIR = join(import.meta.dirname, 'fixtures/kiro');
const SERVER = join(FIXTURE_DIR, 'fake-acp-server.ts');
// `node --import tsx <file>` keeps the server in ONE process. The `tsx`
// CLI wrapper re-spawns node, so a SIGKILL would land on the wrapper and the
// real server would outlive it — which is exactly what the SIGKILL test proves.
const REPO_ROOT = join(import.meta.dirname, '..');
const SERVER_ARGV = ['--import', 'tsx', SERVER];

const TMP = mkdtempSync(join(tmpdir(), 'kiro-acp-test-'));
const clients: KiroAcpClient[] = [];

function makeClient(
  scenario: FakeAcpScenarioName,
  opts: { startupMs?: number; log?: string; termGraceMs?: number; killGraceMs?: number } = {},
): KiroAcpClient {
  const client = new KiroAcpClient({
    command: process.execPath,
    args: SERVER_ARGV,
    cwd: REPO_ROOT,
    env: {
      FAKE_ACP_SCENARIO: scenario,
      ...(opts.log ? { FAKE_ACP_STDIN_LOG: opts.log } : {}),
    },
    startupMs: opts.startupMs ?? 15_000,
    termGraceMs: opts.termGraceMs ?? 300,
    killGraceMs: opts.killGraceMs ?? 300,
    clientInfo: { name: 'agentic-coding-harness-test', version: '0.0.1' },
  });
  clients.push(client);
  client.start();
  return client;
}

/** Drain notifications in the background so the queue never back-pressures. */
function collectNotifications(client: KiroAcpClient): {
  seen: AcpNotification[];
  closed: Promise<void>;
} {
  const seen: AcpNotification[] = [];
  const closed = (async () => {
    for await (const n of client.notifications) seen.push(n);
  })();
  return { seen, closed };
}

function logMethods(path: string): string[] {
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

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// Fixture-derived expectations: the receipt must match the RECORDED agent, not
// values hand-copied into this file.
const PROMPT_FIXTURE = readFileSync(join(FIXTURE_DIR, 'acp-prompt-2.21.2.jsonl'), 'utf8')
  .split('\n')
  .filter((l) => l.trim() && !l.startsWith('>> ') && !l.startsWith('!! '))
  .map((l) => JSON.parse(l) as Record<string, any>);
const INIT_RESULT = PROMPT_FIXTURE.find((m) => m.result?.agentInfo)!.result;
const NEW_RESULT = PROMPT_FIXTURE.find((m) => m.result?.sessionId)!.result;

after(async () => {
  await Promise.all(clients.map((c) => c.close()));
});

// ---------------------------------------------------------------------------

describe('buildKiroAcpArgs', () => {
  it('emits NO trust flag when tools is undefined', () => {
    assert.deepEqual(buildKiroAcpArgs({}), ['acp']);
    assert.deepEqual(buildKiroAcpArgs({ agent: 'dotai' }), ['acp', '--agent', 'dotai']);
  });

  it("maps tools:'all' to --trust-all-tools", () => {
    assert.deepEqual(buildKiroAcpArgs({ tools: 'all' }), ['acp', '--trust-all-tools']);
  });

  it("maps tools:'none' to an empty --trust-tools=", () => {
    assert.deepEqual(buildKiroAcpArgs({ tools: 'none' }), ['acp', '--trust-tools=']);
  });

  it('maps a tools array to a csv --trust-tools=', () => {
    assert.deepEqual(buildKiroAcpArgs({ tools: ['read', 'fs_write'] }), [
      'acp',
      '--trust-tools=read,fs_write',
    ]);
  });

  it('orders agent/model/effort/trust/engine and never emits -v', () => {
    const args = buildKiroAcpArgs({
      agent: 'dotai',
      model: 'claude-haiku-4.5',
      effort: 'high',
      tools: 'all',
      engine: 'v2',
    });
    assert.deepEqual(args, [
      'acp',
      '--agent',
      'dotai',
      '--model',
      'claude-haiku-4.5',
      '--effort',
      'high',
      '--trust-all-tools',
      '--agent-engine',
      'v2',
    ]);
    assert.ok(!args.includes('-v'));
  });
});

describe('KiroAcpClient handshake (fixture replay)', () => {
  it('returns a receipt matching the recorded agent', async () => {
    const client = makeClient('ok');
    const receipt = await client.handshake({
      cwd: TMP,
      mcpServers: [],
      agent: NEW_RESULT.modes.currentModeId,
      model: NEW_RESULT.models.currentModelId,
      requireModelAck: true,
    });

    assert.equal(receipt.cliVersion, INIT_RESULT.agentInfo.version);
    assert.equal(receipt.sessionId, NEW_RESULT.sessionId);
    assert.equal(receipt.currentModeId, NEW_RESULT.modes.currentModeId);
    assert.deepEqual(
      receipt.availableModes.map((m) => m.id),
      NEW_RESULT.modes.availableModes.map((m: { id: string }) => m.id),
    );
    assert.equal(receipt.currentModelId, NEW_RESULT.models.currentModelId);
    assert.equal(receipt.availableModels.length, NEW_RESULT.models.availableModels.length);
    assert.equal(receipt.modelAck, 'acknowledged');
    assert.equal(receipt.agentVerified, true);
    assert.equal(receipt.modelVerified, true);
    assert.deepEqual(receipt.mcpNotices, [
      '_kiro.dev/mcp/governance_disabled',
      '_kiro.dev/webTools/governance_disabled',
    ]);
    assert.ok(receipt.durationsMs.total >= 0);
    await client.close();
  });

  it("reports modelAck:'not-requested' when no model is asked for", async () => {
    const client = makeClient('ok');
    const receipt = await client.handshake({ cwd: TMP });
    assert.equal(receipt.modelAck, 'not-requested');
    assert.equal(receipt.modelVerified, false);
    assert.equal(receipt.agentVerified, false);
    await client.close();
  });

  it('sends set_model AFTER session/new and BEFORE session/prompt', async () => {
    const log = join(TMP, 'order.log');
    const client = makeClient('ok', { log });
    const receipt = await client.handshake({
      cwd: TMP,
      model: NEW_RESULT.models.currentModelId,
      requireModelAck: true,
    });
    const result = await client.prompt(receipt.sessionId, 'ping');
    assert.equal(result.stopReason, 'end_turn');
    await client.close();

    const methods = logMethods(log).filter((m) => m !== '<response>');
    assert.deepEqual(methods, ['initialize', 'session/new', 'session/set_model', 'session/prompt']);
  });

  it('surfaces the recorded session/update notifications', async () => {
    const client = makeClient('ok');
    const { seen } = collectNotifications(client);
    const receipt = await client.handshake({ cwd: TMP });
    await client.prompt(receipt.sessionId, 'ping');
    // The prompt result and the notifications that precede it arrive in the
    // same stdout chunk, and the collector drains the queue one microtask per
    // item — so `await prompt()` does NOT imply the collector has caught up.
    // Poll to a bounded deadline instead of racing it (observed failing ~1 run
    // in 3 under full-suite load).
    for (let i = 0; i < 100 && !seen.some((n) => n.method === '_kiro.dev/metadata'); i++) {
      await sleep(10);
    }
    const methods = seen.map((n) => n.method);
    assert.ok(methods.includes('session/update'));
    assert.ok(methods.includes('_kiro.dev/session/update'));
    assert.ok(methods.includes('_kiro.dev/metadata'));
    await client.close();
  });

  it('surfaces the governance notice for the mcp-fail scenario', async () => {
    const client = makeClient('mcp-fail');
    const { seen } = collectNotifications(client);
    const receipt = await client.handshake({ cwd: TMP });
    assert.ok(receipt.sessionId);
    // The notice lands just after the session/new result; give it a tick.
    await sleep(100);
    assert.ok(seen.some((n) => n.method === '_kiro.dev/mcp/governance_disabled'));
    await client.close();
  });
});

describe('KiroAcpClient startup deadlines', () => {
  it('fails initialize within startupMs and leaves no live child', async () => {
    const client = makeClient('silent-initialize', { startupMs: 300 });
    const pid = client.pid!;
    const started = Date.now();
    const err = await client.initialize().then(
      () => null,
      (e: unknown) => e,
    );
    assert.ok(err instanceof KiroAcpError, `expected KiroAcpError, got ${String(err)}`);
    assert.equal((err as KiroAcpError).phase, 'initialize');
    assert.match((err as KiroAcpError).message, /did not respond within 300ms/);
    assert.ok(Date.now() - started < 10_000);
    assert.equal(isAlive(pid), false);
    assert.notEqual(client.exitCode, undefined);
  });

  it('accepts a slow initialize that lands inside the deadline', async () => {
    const client = makeClient('slow-initialize', { startupMs: 10_000 });
    const init = await client.initialize();
    assert.equal(init.agentInfo?.version, INIT_RESULT.agentInfo.version);
    await client.close();
  });
});

describe('KiroAcpClient acknowledgement gates', () => {
  it('throws on a rejected set_model before any prompt is sent', async () => {
    const log = join(TMP, 'reject.log');
    const client = makeClient('reject-model', { log });
    const err = await client
      .handshake({ cwd: TMP, model: NEW_RESULT.models.currentModelId, requireModelAck: true })
      .then(
        () => null,
        (e: unknown) => e,
      );
    assert.ok(err instanceof KiroAcpError);
    assert.equal((err as KiroAcpError).phase, 'session/set_model');
    await client.close();
    assert.ok(!logMethods(log).includes('session/prompt'));
  });

  it('throws before set_model when the model is not offered at all', async () => {
    const log = join(TMP, 'unoffered.log');
    const client = makeClient('ok', { log });
    const err = await client
      .handshake({ cwd: TMP, model: 'no-such-model', requireModelAck: true })
      .then(
        () => null,
        (e: unknown) => e,
      );
    assert.ok(err instanceof KiroAcpError);
    assert.equal((err as KiroAcpError).phase, 'session/set_model');
    assert.match((err as KiroAcpError).message, /is not offered/);
    await client.close();
    const methods = logMethods(log);
    assert.ok(!methods.includes('session/set_model'));
    assert.ok(!methods.includes('session/prompt'));
  });

  it("records modelAck:'rejected' when requireModelAck is off", async () => {
    const client = makeClient('reject-model');
    const receipt = await client.handshake({
      cwd: TMP,
      model: NEW_RESULT.models.currentModelId,
      requireModelAck: false,
    });
    assert.equal(receipt.modelAck, 'rejected');
    await client.close();
  });

  it('throws naming the available mode ids when the agent does not take', async () => {
    const client = makeClient('wrong-mode');
    const err = await client.handshake({ cwd: TMP, agent: 'dotai' }).then(
      () => null,
      (e: unknown) => e,
    );
    assert.ok(err instanceof KiroAcpError);
    assert.equal((err as KiroAcpError).phase, 'session/new');
    const msg = (err as KiroAcpError).message;
    for (const mode of NEW_RESULT.modes.availableModes as Array<{ id: string }>) {
      assert.ok(msg.includes(mode.id), `message should name mode ${mode.id}: ${msg}`);
    }
    assert.match(msg, /current 'kiro_default'/);
    await client.close();
  });
});

describe('KiroAcpClient agent→client requests', () => {
  it('denies session/request_permission by default and records it', async () => {
    const client = makeClient('permission');
    const { seen } = collectNotifications(client);
    const receipt = await client.handshake({ cwd: TMP });
    const result = await client.prompt(receipt.sessionId, 'read something');
    assert.equal(result.stopReason, 'refusal');

    const records = seen.filter((n) => n.method === '__client_request');
    assert.equal(records.length, 1);
    const rec = records[0]!.params as { method: string; answered: unknown };
    assert.equal(rec.method, 'session/request_permission');
    assert.deepEqual(rec.answered, { outcome: { outcome: 'cancelled' } });
    assert.ok(!JSON.stringify(rec.answered).includes('selected'));
    await client.close();
  });

  it('honours an injected permission policy that selects an option', async () => {
    const client = new KiroAcpClient({
      command: process.execPath,
      args: SERVER_ARGV,
      cwd: REPO_ROOT,
      env: { FAKE_ACP_SCENARIO: 'permission' },
      startupMs: 15_000,
      termGraceMs: 300,
      killGraceMs: 300,
      onPermission: async () => ({ outcome: { outcome: 'selected', optionId: 'allow' } }),
    });
    clients.push(client);
    client.start();
    const receipt = await client.handshake({ cwd: TMP });
    const result = await client.prompt(receipt.sessionId, 'read something');
    assert.equal(result.stopReason, 'end_turn');
    await client.close();
  });

  it('answers fs/* and terminal/* with -32601 (we advertise fs:false, terminal:false)', async () => {
    const client = makeClient('fs-request');
    const { seen } = collectNotifications(client);
    const receipt = await client.handshake({ cwd: TMP });
    const result = await client.prompt(receipt.sessionId, 'read something');

    // The fake server echoes back exactly what we answered it.
    const probe = (result as { _probe?: { read?: { code?: number }; terminal?: { code?: number } } })
      ._probe;
    assert.equal(probe?.read?.code, -32601);
    assert.equal(probe?.terminal?.code, -32601);

    const records = seen
      .filter((n) => n.method === '__client_request')
      .map((n) => (n.params as { method: string }).method);
    assert.deepEqual(records, ['fs/read_text_file', 'terminal/create']);
    await client.close();
  });
});

describe('KiroAcpClient teardown', () => {
  it('closes notifications and reports exitCode 1 on a mid-prompt crash', async () => {
    const client = makeClient('crash-mid-prompt');
    const { seen, closed } = collectNotifications(client);
    const receipt = await client.handshake({ cwd: TMP });
    const err = await client.prompt(receipt.sessionId, 'ping').then(
      () => null,
      (e: unknown) => e,
    );
    assert.ok(err instanceof KiroAcpError);
    assert.equal((err as KiroAcpError).phase, 'session/prompt');
    await closed; // the queue must close on exit, or this hangs
    assert.equal(client.exitCode, 1);
    assert.ok(seen.length >= 1);
  });

  it('escalates to SIGKILL when the child ignores SIGTERM', async () => {
    const client = makeClient('ignore-sigterm', { termGraceMs: 200, killGraceMs: 200 });
    const pid = client.pid!;
    await client.handshake({ cwd: TMP });
    assert.equal(isAlive(pid), true);
    await client.close();
    assert.equal(isAlive(pid), false);
  });

  it('is idempotent: close() twice resolves the same way', async () => {
    const client = makeClient('ok');
    await client.handshake({ cwd: TMP });
    const first = await client.close();
    const second = await client.close();
    assert.equal(first, second);
    assert.equal(isAlive(client.pid!), false);
  });
});
