import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, afterEach, describe, it } from 'node:test';
import {
  checkArtifactPath,
  checkCwd,
  filterExtraArgs,
  gatewayConfigFromFlags,
} from '../src/serve/gateway.js';

// ---------------------------------------------------------------------------
// Gateway profile (src/serve/PLAN.md §D) — policy module src/serve/gateway.ts.
//
// UNIT half: real signatures (seat W4 landed):
//   gatewayConfigFromFlags(flags: GatewayFlags, env: NodeJS.ProcessEnv):
//       GatewayConfig — flags win over env mirrors (AGENT_HARNESS_GATEWAY=1,
//       AGENT_HARNESS_ROOT, AGENT_HARNESS_MAX_JOBS, AGENT_HARNESS_MAX_OUTPUT_BYTES,
//       AGENT_HARNESS_ALLOW_EXTRA_ARGS); root is path.resolve()d.
//   checkCwd(cfg: GatewayConfig | undefined, cwd?: string):
//       {ok:true} | {ok:false, error} — off→ok; on+undefined→ok;
//       on+outside root→error naming the cwd.
//   filterExtraArgs(cfg, args?: string[]): {allowed, stripped} — exact match.
//   checkArtifactPath(cfg, stateDir: string, p?: string):
//       {ok} | {ok:false, error} — on + outside stateDir → error.
//
// INTEGRATION half (subprocess) is EXPECTED-RED until seat W3 lands the serve
// command (src/cli/serve.ts + src/mcp/http.ts).
// ---------------------------------------------------------------------------

const CLI = new URL('../src/cli/harness.ts', import.meta.url).pathname;
const TOKEN = 'testtok';
const isBun = spawnSync('bun', ['--version'], { encoding: 'utf8' }).status === 0;

// --- env passed explicitly (gatewayConfigFromFlags(flags, env)) ------------

describe('gateway policy: checkCwd', () => {
  const root = mkdtempSync(join(tmpdir(), 'harness-gw-root-'));
  const cfgOff = gatewayConfigFromFlags({}, {});
  const cfgOn = gatewayConfigFromFlags({ gateway: true, root }, {});

  it('gateway off → ok regardless of cwd', () => {
    assert.equal(cfgOff.enabled, false);
    const v = checkCwd(cfgOff, '/anywhere/outside');
    assert.equal(v.ok, true, JSON.stringify(v));
  });

  it('gateway on + cwd inside root → ok', () => {
    const v = checkCwd(cfgOn, join(root, 'sub', 'dir'));
    assert.equal(v.ok, true, JSON.stringify(v));
  });

  it('gateway on + cwd escaping via ../.. → error naming the cwd', () => {
    const escape = join(root, '..', '..', 'escaped');
    const v = checkCwd(cfgOn, escape);
    assert.equal(v.ok, false, JSON.stringify(v));
    const err = (v as { ok: false; error: string }).error;
    // "reject with error naming cwd" — the submitted path (and its resolved
    // form) must appear in the message.
    assert.ok(
      err.includes(escape) && err.includes(resolve(escape)),
      `error must name the cwd "${escape}" (resolved "${resolve(escape)}"), got: ${err}`,
    );
  });

  it('gateway on + cwd undefined → ok (server cwd checked at startup)', () => {
    const v = checkCwd(cfgOn, undefined);
    assert.equal(v.ok, true, JSON.stringify(v));
  });

  it('gateway on without root → config error naming the field', () => {
    const bad = gatewayConfigFromFlags({ gateway: true }, {});
    assert.equal(bad.root, undefined);
    const v = checkCwd(bad, join(root, 'sub'));
    assert.equal(v.ok, false, JSON.stringify(v));
    assert.match((v as { ok: false; error: string }).error, /root/);
  });

  after(() => rmSync(root, { recursive: true, force: true }));
});

describe('gateway policy: filterExtraArgs', () => {
  const root = mkdtempSync(join(tmpdir(), 'harness-gw-root2-'));
  // Passthrough happens only when the gateway is OFF (seat W4: cfgOff).
  const cfgOff = gatewayConfigFromFlags({ gateway: false });
  const cfgOn = gatewayConfigFromFlags({ gateway: true, root, allowExtraArgs: '--safe,--ok=1' });

  it('no allowlist configured → everything passes through untouched', () => {
    const v = filterExtraArgs(cfgOff, ['--anything', '-x', '--ok=1']);
    assert.deepEqual(v.allowed, ['--anything', '-x', '--ok=1']);
    assert.deepEqual(v.stripped, []);
  });

  it('gateway ON with an EMPTY allowlist → fail-closed, everything stripped', () => {
    // PLAN §D: "extraArgs stripped unless every arg matches the allowlist".
    // An allowlist-less gateway must not forward arbitrary CLI args.
    const bare = gatewayConfigFromFlags({ gateway: true, root });
    const v = filterExtraArgs(bare, ['--anything', '-x']);
    assert.deepEqual(v.allowed, []);
    assert.deepEqual(v.stripped, ['--anything', '-x']);
  });


  it('gateway on → exact matches allowed, everything else stripped', () => {
    const v = filterExtraArgs(cfgOn, ['--safe', '--bad', '--ok=1', '--ok=2']);
    assert.deepEqual(v.allowed, ['--safe', '--ok=1']);
    assert.deepEqual(v.stripped, ['--bad', '--ok=2']);
  });

  it('undefined args → empty both ways', () => {
    assert.deepEqual(filterExtraArgs(cfgOff, undefined), { allowed: [], stripped: [] });
    assert.deepEqual(filterExtraArgs(cfgOn, undefined), { allowed: [], stripped: [] });
  });

  after(() => rmSync(root, { recursive: true, force: true }));
});

describe('gateway policy: checkArtifactPath', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'harness-gw-state-'));
  const cfgOff = gatewayConfigFromFlags({}, {});
  const cfgOn = gatewayConfigFromFlags({ gateway: true, root: stateDir }, {});

  it('gateway off → ok even outside stateDir', () => {
    const v = checkArtifactPath(stateDir, '/etc/hosts', cfgOff);
    assert.equal(v.ok, true, JSON.stringify(v));
  });

  it('gateway on + artifact under stateDir → ok', () => {
    const v = checkArtifactPath(stateDir, join(stateDir, 'reports', 'r.json'), cfgOn);
    assert.equal(v.ok, true, JSON.stringify(v));
  });

  it('gateway on + artifact outside stateDir → error', () => {
    const v = checkArtifactPath(stateDir, '/etc/hosts', cfgOn);
    assert.equal(v.ok, false, JSON.stringify(v));
    const err = (v as { ok: false; error: string }).error;
    assert.ok(err.length > 0, 'error must carry a message');
  });

  it('gateway on + path undefined → ok', () => {
    assert.equal(checkArtifactPath(stateDir, undefined, cfgOn).ok, true);
  });

  after(() => rmSync(stateDir, { recursive: true, force: true }));
});

describe('gateway policy: gatewayConfigFromFlags (env/flag precedence)', () => {
  it('AGENT_HARNESS_GATEWAY=1 with no flags → enabled, root from env', () => {
    const cfg = gatewayConfigFromFlags({}, { AGENT_HARNESS_GATEWAY: '1', AGENT_HARNESS_ROOT: '/tmp/envroot' });
    assert.equal(cfg.enabled, true);
    assert.equal(cfg.root, resolve('/tmp/envroot'));
  });

  it('explicit flag wins over env (gateway:false beats AGENT_HARNESS_GATEWAY=1)', () => {
    const cfg = gatewayConfigFromFlags({ gateway: false }, { AGENT_HARNESS_GATEWAY: '1' });
    assert.equal(cfg.enabled, false);
  });

  it('flag root wins over AGENT_HARNESS_ROOT', () => {
    const cfg = gatewayConfigFromFlags(
      { gateway: true, root: '/tmp/flagroot' },
      { AGENT_HARNESS_ROOT: '/tmp/envroot' },
    );
    assert.equal(cfg.root, resolve('/tmp/flagroot'));
  });

  it('AGENT_HARNESS_MAX_JOBS respected; default is 4', () => {
    assert.equal(gatewayConfigFromFlags({}, { AGENT_HARNESS_MAX_JOBS: '7' }).maxJobs, 7);
    assert.equal(gatewayConfigFromFlags({}, {}).maxJobs, 4);
  });

  it('allowExtraArgs flag splits the comma-separated allowlist', () => {
    const cfg = gatewayConfigFromFlags({ allowExtraArgs: '--a,--b=2' }, {});
    assert.deepEqual(cfg.allowExtraArgs, ['--a', '--b=2']);
  });
});

// ---------------------------------------------------------------------------
// Integration: serve --gateway --root <tmp> over HTTP (subprocess).
// EXPECTED-RED until W3 (serve) + W4 (gateway flags) land.
// ---------------------------------------------------------------------------

describe('harness serve --gateway (subprocess integration)', () => {
  let stateTmp = '';
  let rootTmp = '';
  let child: ReturnType<typeof spawnServer> | null = null;
  let port = 0;

  function spawnServer(args: string[]): ChildProcess {
    const full = isBun ? [CLI, 'serve', ...args] : ['--import', 'tsx', CLI, 'serve', ...args];
    return spawn(isBun ? 'bun' : process.execPath, full, {
      env: { ...process.env, AGENT_HARNESS_STATE_DIR: stateTmp },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
  }

  async function post(body: unknown, auth = true): Promise<{ status: number; json: any }> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (auth) headers.authorization = `Bearer ${TOKEN}`;
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => null);
    return { status: res.status, json };
  }

  async function callTool(id: number, args: Record<string, unknown>): Promise<{ status: number; json: any }> {
    return post({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'harness_run_async', arguments: args } });
  }

  async function waitHealthy(timeoutMs = 20_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/health`);
        if (res.ok) return;
      } catch {
        /* not up yet */
      }
      if (Date.now() > deadline) throw new Error('gateway serve never became healthy');
      await new Promise((r) => setTimeout(r, 150));
    }
  }

  afterEach(async () => {
    if (child) {
      child.kill('SIGTERM');
      setTimeout(() => {
        if (child && child.exitCode === null) child.kill('SIGKILL');
      }, 1_000);
      child = null;
    }
    if (stateTmp) rmSync(stateTmp, { recursive: true, force: true });
    if (rootTmp) rmSync(rootTmp, { recursive: true, force: true });
  });

  it('run_async with cwd outside --root → error naming the cwd', { timeout: 30_000 }, async () => {
    stateTmp = mkdtempSync(join(tmpdir(), 'harness-gw-state-'));
    rootTmp = mkdtempSync(join(tmpdir(), 'harness-gw-root-'));
    port = 18_000 + Math.floor(Math.random() * 1_000);
    child = spawnServer(['--gateway', '--root', rootTmp, '--port', String(port), '--token', TOKEN]);
    await waitHealthy();
    await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'gw-test', version: '0.0.0' } } });

    const outside = join(tmpdir(), 'harness-gw-escape-cwd');
    const { json } = await callTool(2, { agent: 'kiro', prompt: 'hi', cwd: outside });
    const text = JSON.stringify(json);
    assert.ok(
      json.error || /error/i.test(text),
      `escaped cwd must be rejected, got: ${text}`,
    );
    assert.ok(
      text.includes(outside) || text.includes(resolve(outside)),
      `rejection must name the cwd "${outside}", got: ${text}`,
    );
  });

  it('run_async with a non-allowlisted extraArg → result carries a stripped warning', { timeout: 30_000 }, async () => {
    stateTmp = mkdtempSync(join(tmpdir(), 'harness-gw-state-'));
    rootTmp = mkdtempSync(join(tmpdir(), 'harness-gw-root-'));
    port = 18_000 + Math.floor(Math.random() * 1_000);
    child = spawnServer(['--gateway', '--root', rootTmp, '--port', String(port), '--token', TOKEN]);
    await waitHealthy();
    await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'gw-test', version: '0.0.0' } } });

    const { json } = await callTool(3, {
      agent: 'kiro',
      prompt: 'hi',
      cwd: rootTmp,
      extraArgs: ['--totally-bogus-flag'],
    });
    const text = JSON.stringify(json);
    assert.equal(json.error, undefined, `unexpected JSON-RPC error: ${text}`);
    // "stripped args → warning in result, not silent": the arg name and the
    // strip/allowlist complaint must both surface somewhere in the result.
    assert.ok(text.includes('--totally-bogus-flag'), `arg must be named in the result: ${text}`);
    assert.match(text, /stripp|allowlist|not allow|allow-list/i);
  });
});
