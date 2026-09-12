import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, before, describe, it } from 'node:test';

// ---------------------------------------------------------------------------
// HTTP transport (src/serve/PLAN.md §C): `harness serve --port N --token T`
// speaks Streamable-HTTP MCP on POST /mcp (JSON in, JSON out; batches OK),
// GET /health is unauthenticated, missing bearer → 401, SIGTERM drains and
// exits. State sandboxed via AGENT_HARNESS_STATE_DIR.
//
// EXPECTED-RED until seat W3 lands the `serve` command (src/cli/harness.ts +
// src/mcp/http.ts). Every failure message carries the child's stderr tail.
// ---------------------------------------------------------------------------

const CLI = new URL('../src/cli/harness.ts', import.meta.url).pathname;
const TOKEN = 'testtok';

const EXPECTED_TOOLS = [
  'harness_run',
  'harness_agents',
  'harness_report',
  'harness_emit',
  'harness_stats',
  'harness_run_async',
  'harness_run_status',
  'harness_run_events',
  'harness_run_cancel',
] as const;

// bun runs .ts natively; node needs the tsx loader (same rule as mcp.test.ts).
const isBun = spawnSync('bun', ['--version'], { encoding: 'utf8' }).status === 0;

let stateTmp = '';
let cwdTmp = '';
let child: ChildProcess | null = null;
let extraChild: ChildProcess | null = null;
let port = 0;
let stderrTail = '';

function serveChild(extraArgs: string[], env: Record<string, string> = {}): ChildProcess {
  const args = isBun ? [CLI, 'serve', ...extraArgs] : ['--import', 'tsx', CLI, 'serve', ...extraArgs];
  const c = spawn(isBun ? 'bun' : process.execPath, args, {
    cwd: cwdTmp,
    env: { ...process.env, AGENT_HARNESS_STATE_DIR: stateTmp, ...env },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  c.stderr!.setEncoding('utf8');
  c.stderr!.on('data', (chunk: string) => {
    stderrTail = (stderrTail + chunk).slice(-800);
  });
  return c;
}

/** Bind-probe a free loopback port, then release it (tiny TOCTOU, fine here). */
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const p = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => (p > 0 ? resolve(p) : reject(new Error('no port'))));
    });
  });
}

async function killWithin(c: ChildProcess, signal: NodeJS.Signals, timeoutMs: number): Promise<string> {
  return new Promise((resolve) => {
    if (c.exitCode !== null || c.signalCode) return resolve(`already-exit:${c.exitCode}:${c.signalCode}`);
    const escalated = setTimeout(() => {
      try {
        c.kill('SIGKILL');
      } catch {
        /* gone */
      }
    }, timeoutMs);
    c.once('exit', (code, sig) => {
      clearTimeout(escalated);
      resolve(`exit:${code}:${sig}`);
    });
    c.kill(signal);
  });
}

function url(pathname: string): string {
  return `http://127.0.0.1:${port}${pathname}`;
}

async function postRpc(
  body: unknown,
  opts: { auth?: boolean } = {},
): Promise<{ status: number; json: any }> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.auth !== false) headers.authorization = `Bearer ${TOKEN}`;
  const res = await fetch(url('/mcp'), { method: 'POST', headers, body: JSON.stringify(body) });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = { __raw: text };
  }
  return { status: res.status, json };
}

const initializeReq = (id: number): unknown => ({
  jsonrpc: '2.0',
  id,
  method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'http-test', version: '0.0.0' } },
});

async function waitHealthy(timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (child && child.exitCode !== null) {
      throw new Error(`serve exited (code ${child.exitCode}) before /health answered; stderr: ${stderrTail}`);
    }
    try {
      const res = await fetch(url('/health'));
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error(`/health never answered; stderr: ${stderrTail}`);
    await new Promise((r) => setTimeout(r, 150));
  }
}

before(async () => {
  stateTmp = mkdtempSync(join(tmpdir(), 'harness-http-state-'));
  cwdTmp = mkdtempSync(join(tmpdir(), 'harness-http-cwd-'));
  port = await freePort();
  child = serveChild(['--port', String(port), '--token', TOKEN]);
  await waitHealthy();
});

afterEach(() => {
  // Safety net for the SIGTERM-test child (the shared child dies in after()).
  if (extraChild) {
    void killWithin(extraChild, 'SIGKILL', 0);
    extraChild = null;
  }
});

after(async () => {
  if (child) {
    await killWithin(child, 'SIGTERM', 3_000);
    child = null;
  }
  rmSync(stateTmp, { recursive: true, force: true });
  rmSync(cwdTmp, { recursive: true, force: true });
});

describe('harness serve (HTTP MCP subprocess)', () => {
  it('GET /health → 200 {"status":"ok"} with no auth', { timeout: 30_000 }, async () => {
    const res = await fetch(url('/health'));
    assert.equal(res.status, 200);
    const body = (await res.json()) as { status: string; version: string };
    assert.equal(body.status, 'ok');
    assert.equal(body.version, '0.2.2');
  });

  it('POST /mcp initialize with bearer token → protocolVersion 2025-06-18', { timeout: 30_000 }, async () => {
    const { status, json } = await postRpc(initializeReq(1));
    assert.equal(status, 200, `body: ${JSON.stringify(json)}`);
    assert.equal(json.error, undefined, `initialize failed: ${JSON.stringify(json.error)}`);
    assert.equal(json.result.protocolVersion, '2025-06-18');
    assert.ok(json.result.serverInfo.name.length > 0);
  });

  it('POST /mcp without Authorization → 401 JSON-RPC error', { timeout: 30_000 }, async () => {
    const { status, json } = await postRpc(initializeReq(2), { auth: false });
    assert.equal(status, 401);
    assert.ok(json.error, `expected a JSON-RPC error body, got: ${JSON.stringify(json)}`);
  });

  it('tools/list shows exactly the 9 harness tools', { timeout: 30_000 }, async () => {
    const { status, json } = await postRpc({ jsonrpc: '2.0', id: 3, method: 'tools/list' });
    assert.equal(status, 200, `body: ${JSON.stringify(json)}`);
    assert.equal(json.error, undefined, `tools/list failed: ${JSON.stringify(json.error)}`);
    const names = (json.result.tools as Array<{ name: string }>).map((t) => t.name).sort();
    assert.deepEqual(names, [...EXPECTED_TOOLS].sort());
  });

  it('batch [initialize, ping] → array of two results', { timeout: 30_000 }, async () => {
    const { status, json } = await postRpc([
      initializeReq(10),
      { jsonrpc: '2.0', id: 11, method: 'ping' },
    ]);
    assert.equal(status, 200, `body: ${JSON.stringify(json)}`);
    assert.ok(Array.isArray(json), `batch must answer with an array, got: ${typeof json}`);
    assert.equal(json.length, 2);
    const arr = json as Array<{ id: unknown; error?: unknown; result?: { protocolVersion?: string } }>;
    const byId = new Map(arr.map((r) => [r.id, r] as const));
    const init = byId.get(10);
    const ping = byId.get(11) as { result?: unknown } | undefined;
    assert.ok(init, 'initialize response missing from batch');
    assert.equal(init.error, undefined);
    assert.equal(init.result!.protocolVersion, '2025-06-18');
    assert.ok(ping, 'ping response missing from batch');
    assert.deepEqual(ping.result, {});
  });

  it('POST unknown path → 404', { timeout: 30_000 }, async () => {
    const res = await fetch(url('/nope'), {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 12, method: 'ping' }),
    });
    assert.equal(res.status, 404);
  });

  it('SIGTERM → process exits within 10s (graceful shutdown)', { timeout: 30_000 }, async () => {
    const child2Port = await freePort();
    const child2 = serveChild(['--port', String(child2Port), '--token', TOKEN]);
    extraChild = child2;
    const savedPort = port;
    port = child2Port;
    try {
      await waitHealthy(20_000);
      const t0 = Date.now();
      const verdict = await killWithin(child2, 'SIGTERM', 10_000);
      assert.ok(verdict.startsWith('exit:'), `server did not exit on SIGTERM: ${verdict}`);
      assert.ok(Date.now() - t0 < 10_000, `exit took ${Date.now() - t0}ms`);
      assert.ok(!verdict.includes('SIGKILL'), 'had to escalate to SIGKILL');
      extraChild = null;
    } finally {
      port = savedPort;
    }
  });
});
