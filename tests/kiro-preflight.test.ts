import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { kiroPreflight, maskIdentity, type PreflightReceipt } from '../src/adapters/kiro-preflight.ts';
import { registerPreflightTools } from '../src/mcp/tools-preflight.ts';
import { createMcpServer } from '../src/mcp/server.ts';
import type { ChildProcessLike, SpawnFn } from '../src/adapters/shared.ts';
import type { McpToolDef } from '../src/mcp/contract.ts';
import type { GatewayConfig } from '../src/serve/gateway.ts';

const FIXTURE_DIR = join(import.meta.dirname, 'fixtures/kiro');
const SERVER = join(FIXTURE_DIR, 'fake-acp-server.ts');
const REPO_ROOT = join(import.meta.dirname, '..');
const TMP = mkdtempSync(join(tmpdir(), 'kiro-preflight-'));

interface Fake {
  spawnFn: SpawnFn;
  log: string;
}

/**
 * One spawnFn standing in for the whole binary: `--version` and `whoami` are
 * answered by a node one-liner, `acp` by the scripted fake server.
 */
function fakeKiro(opts: {
  scenario?: string;
  version?: string;
  versionCode?: number;
  whoami?: string;
  whoamiCode?: number;
} = {}): Fake {
  const log = join(TMP, `stdin-${Math.random().toString(36).slice(2)}.log`);
  const spawnFn: SpawnFn = (_command, args, spawnOpts) => {
    const script = (out: string, code: number): string[] => [
      '-e',
      `process.stdout.write(${JSON.stringify(out)}); process.exit(${code});`,
    ];
    let argv: string[];
    if (args[0] === '--version') argv = script(opts.version ?? 'kiro-cli 2.21.2\n', opts.versionCode ?? 0);
    else if (args[0] === 'whoami') argv = script(opts.whoami ?? 'user@example.com\n', opts.whoamiCode ?? 0);
    else argv = ['--import', 'tsx', SERVER];
    const child = spawn(process.execPath, argv, {
      ...spawnOpts,
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        FAKE_ACP_SCENARIO: opts.scenario ?? 'ok',
        FAKE_ACP_STDIN_LOG: log,
      },
      shell: false,
    });
    return child as unknown as ChildProcessLike;
  };
  return { spawnFn, log };
}

function methods(path: string): string[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => String((JSON.parse(l) as { method?: string }).method ?? '<response>'));
}

const byName = (r: PreflightReceipt, name: string): { status: string; detail: string } => {
  const c = r.checks.find((x) => x.name === name);
  assert.ok(c, `missing check '${name}'`);
  return c;
};

describe('kiroPreflight', () => {
  it('all checks verified against the recorded handshake — and NO prompt is sent', async () => {
    const fake = fakeKiro();
    const receipt = await kiroPreflight({
      cwd: REPO_ROOT,
      spawnFn: fake.spawnFn,
      model: 'claude-haiku-4.5',
      kiro: { transport: 'acp', agent: 'dotai' },
    });
    assert.equal(receipt.ok, true, JSON.stringify(receipt.checks, null, 2));
    for (const name of ['executable', 'version', 'auth', 'agent', 'model', 'modelAck', 'extraArgs']) {
      assert.equal(byName(receipt, name).status, 'verified', `check ${name}`);
    }
    // `mcp` is UNPROVEN, not verified: the recorded real 2.21.2 handshake
    // carries `_kiro.dev/mcp/governance_disabled` even on a healthy session
    // with no MCP servers, so claiming 'verified' here would be a lie.
    assert.equal(byName(receipt, 'mcp').status, 'unproven');
    assert.equal(receipt.receipt.cliVersion, '2.21.2');
    assert.equal(receipt.receipt.modelAck, 'acknowledged');
    assert.ok((receipt.receipt.availableModels ?? []).length > 0);
    assert.ok((receipt.receipt.availableModes ?? []).length > 0);
    assert.ok(typeof receipt.receipt.sessionId === 'string');

    const sent = methods(fake.log);
    assert.ok(sent.includes('initialize') && sent.includes('session/new') && sent.includes('session/set_model'));
    assert.ok(!sent.includes('session/prompt'), `preflight must never prompt: ${sent.join(',')}`);

    // The unprovable is always declared.
    assert.ok(receipt.unproven.includes('task success'));
    assert.ok(receipt.unproven.includes('downstream tool dependencies'));
  });

  it('reject-model: model + modelAck fail, ok=false, still no prompt', async () => {
    const fake = fakeKiro({ scenario: 'reject-model' });
    const receipt = await kiroPreflight({
      cwd: REPO_ROOT,
      spawnFn: fake.spawnFn,
      model: 'claude-haiku-4.5',
      kiro: { transport: 'acp' },
    });
    assert.equal(receipt.ok, false);
    assert.equal(byName(receipt, 'model').status, 'failed');
    assert.equal(byName(receipt, 'modelAck').status, 'failed');
    assert.ok(!methods(fake.log).includes('session/prompt'));
  });

  it('wrong-mode: the agent check fails', async () => {
    const fake = fakeKiro({ scenario: 'wrong-mode' });
    const receipt = await kiroPreflight({
      cwd: REPO_ROOT,
      spawnFn: fake.spawnFn,
      kiro: { transport: 'acp', agent: 'dotai' },
    });
    assert.equal(receipt.ok, false);
    assert.equal(byName(receipt, 'agent').status, 'failed');
  });

  it('mcp-fail + requireMcpStartup: the mcp check fails on a governance notice', async () => {
    const fake = fakeKiro({ scenario: 'mcp-fail' });
    const receipt = await kiroPreflight({
      cwd: REPO_ROOT,
      spawnFn: fake.spawnFn,
      model: 'claude-haiku-4.5',
      kiro: { transport: 'acp', requireMcpStartup: true },
    });
    assert.equal(byName(receipt, 'mcp').status, 'failed');
    assert.match(byName(receipt, 'mcp').detail, /governance_disabled/);
    assert.equal(receipt.ok, false);
  });

  it('the 2.21.2 governance notice alone does NOT fail an ungated preflight', async () => {
    // Control for the test above: the recorded REAL handshake carries
    // `_kiro.dev/mcp/governance_disabled`, so failing on it unconditionally
    // would fail every healthy session.
    const fake = fakeKiro({ scenario: 'mcp-fail' });
    const receipt = await kiroPreflight({
      cwd: REPO_ROOT,
      spawnFn: fake.spawnFn,
      model: 'claude-haiku-4.5',
      kiro: { transport: 'acp' },
    });
    assert.equal(byName(receipt, 'mcp').status, 'unproven');
    assert.equal(receipt.ok, true, JSON.stringify(receipt.checks));
  });

  it('auth: a failing whoami fails the auth check and never leaks the identity', async () => {
    const fake = fakeKiro({ whoami: 'not logged in: person@corp.example\n', whoamiCode: 1 });
    const receipt = await kiroPreflight({ cwd: REPO_ROOT, spawnFn: fake.spawnFn, kiro: { transport: 'acp' } });
    assert.equal(byName(receipt, 'auth').status, 'failed');
    assert.ok(!byName(receipt, 'auth').detail.includes('person@corp.example'));
    assert.match(byName(receipt, 'auth').detail, /\*\*\*/);
    assert.equal(receipt.ok, false);
  });

  it('auth: a passing whoami is verified with the email masked', async () => {
    const fake = fakeKiro({ whoami: 'logged in as person@corp.example\n' });
    const receipt = await kiroPreflight({ cwd: REPO_ROOT, spawnFn: fake.spawnFn, kiro: { transport: 'acp' } });
    assert.equal(byName(receipt, 'auth').status, 'verified');
    assert.equal(byName(receipt, 'auth').detail, 'whoami ok: logged in as ***');
  });

  it('an unrunnable binary fails executable and leaves everything else unproven', async () => {
    const fake = fakeKiro({ versionCode: 127, version: '' });
    const receipt = await kiroPreflight({ cwd: REPO_ROOT, spawnFn: fake.spawnFn, kiro: { transport: 'acp' } });
    assert.equal(receipt.ok, false);
    assert.equal(byName(receipt, 'executable').status, 'failed');
    for (const name of ['version', 'auth', 'agent', 'model', 'modelAck', 'mcp']) {
      assert.equal(byName(receipt, name).status, 'unproven', `check ${name}`);
    }
    assert.equal(methods(fake.log).length, 0, 'no ACP session may be opened');
  });

  it('extraArgs: rejected when outside the gateway allowlist', async () => {
    const fake = fakeKiro();
    const receipt = await kiroPreflight({
      cwd: REPO_ROOT,
      spawnFn: fake.spawnFn,
      kiro: { transport: 'acp' },
      extraArgs: ['--allowed', '--sneaky'],
      gatewayAllowExtraArgs: ['--allowed'],
    });
    assert.equal(byName(receipt, 'extraArgs').status, 'failed');
    assert.match(byName(receipt, 'extraArgs').detail, /'--sneaky'/);
    assert.equal(receipt.ok, false);
  });

  it('maskIdentity replaces every address', () => {
    assert.equal(maskIdentity('a@b.com and c.d+e@f.co.uk'), '*** and ***');
  });
});

describe('harness_kiro_preflight (MCP tool)', () => {
  function toolServer(gateway?: GatewayConfig): {
    dispatch: ReturnType<typeof createMcpServer>['dispatch'];
    tools: McpToolDef[];
  } {
    const tools: McpToolDef[] = [];
    const server = createMcpServer({ name: 'test', version: '0' });
    const orig = server.registerTool.bind(server);
    server.registerTool = (def: McpToolDef): void => {
      tools.push(def);
      orig(def);
    };
    registerPreflightTools(server, gateway ? { gateway } : {});
    return { dispatch: server.dispatch, tools };
  }

  it('is listed with a kiro input schema', async () => {
    const { dispatch } = toolServer();
    const res = await dispatch({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    const listed = (res?.result as { tools: Array<{ name: string; inputSchema: { properties: Record<string, unknown> } }> })
      .tools;
    const tool = listed.find((t) => t.name === 'harness_kiro_preflight');
    assert.ok(tool, 'harness_kiro_preflight must be registered');
    assert.ok(tool.inputSchema.properties.kiro, 'kiro param must be exposed');
    assert.ok(tool.inputSchema.properties.cwd);
    assert.ok(tool.inputSchema.properties.model);
    assert.ok(tool.inputSchema.properties.extraArgs);
  });

  it('rejects a cwd outside the gateway root, exactly like harness_run', async () => {
    const { dispatch } = toolServer({ enabled: true, root: join(TMP, 'root'), maxJobs: 1, allowExtraArgs: [] });
    const res = await dispatch({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'harness_kiro_preflight', arguments: { cwd: '/etc' } },
    });
    assert.ok(res?.error, 'expected a JSON-RPC error');
    assert.match(res.error.message, /must resolve under gateway root/);
  });

  it('rejects an unknown kiro field (strict schema)', async () => {
    const { dispatch } = toolServer();
    const res = await dispatch({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'harness_kiro_preflight', arguments: { kiro: { nope: true } } },
    });
    assert.ok(res?.error);
    assert.match(res.error.message, /invalid harness_kiro_preflight arguments/);
  });
});
