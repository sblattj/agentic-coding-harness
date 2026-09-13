import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, after, beforeEach, describe, it } from 'node:test';
import type { JsonRpcRequest, JsonRpcResponse } from '../src/mcp/contract.js';
import { __testables__ } from '../src/mcp/server.js';

// ---------------------------------------------------------------------------
// Protocol framing (unit, no subprocess)
//
// __testables__.FramingParser.push() returns raw text frames (one JSON
// message per frame). A garbage line still comes through as a frame; the
// parse-error signal is that frame failing JSON.parse — the exact predicate
// the server maps to -32700 (contract.ts).
// ---------------------------------------------------------------------------

const mkParser = (): { push(chunk: string): string[] } => new __testables__.FramingParser();

const msg = (id: number, method: string): JsonRpcRequest => ({ jsonrpc: '2.0', id, method });

describe('mcp framing (__testables__.FramingParser)', () => {
  it('parses two NDJSON messages sent in one chunk', () => {
    const frames = mkParser().push(
      `${JSON.stringify(msg(1, 'ping'))}\n${JSON.stringify(msg(2, 'tools/list'))}\n`,
    );
    assert.deepEqual(frames.map((f) => JSON.parse(f)), [
      msg(1, 'ping'),
      msg(2, 'tools/list'),
    ]);
  });

  it('assembles a message split across two chunks', () => {
    const p = mkParser();
    const whole = `${JSON.stringify(msg(7, 'ping'))}\n`;
    const cut = Math.floor(whole.length * 0.4); // mid-body, no newline yet
    const first = p.push(whole.slice(0, cut));
    assert.deepEqual(first, []); // incomplete — nothing emitted
    const rest = p.push(whole.slice(cut));
    assert.deepEqual(rest.map((f) => JSON.parse(f)), [msg(7, 'ping')]);
  });

  it('parses a Content-Length framed message', () => {
    const body = JSON.stringify(msg(3, 'ping'));
    const frame = `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
    const frames = mkParser().push(frame);
    assert.deepEqual(frames.map((f) => JSON.parse(f)), [msg(3, 'ping')]);
  });

  it('keeps two framings interleaved (contract: mode re-detected per message)', () => {
    const body = JSON.stringify(msg(4, 'ping'));
    const chunk =
      `${JSON.stringify(msg(1, 'tools/list'))}\n` +
      `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}` +
      `\n${JSON.stringify(msg(2, 'ping'))}\n`;
    const frames = mkParser().push(chunk);
    assert.deepEqual(frames.map((f) => JSON.parse(f)), [
      msg(1, 'tools/list'),
      msg(4, 'ping'),
      msg(2, 'ping'),
    ]);
  });

  it('allows newlines inside a Content-Length body (never splits in headers mode)', () => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'ping', params: { note: 'has\nnewline' } });
    const frame = `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
    const frames = mkParser().push(frame);
    assert.deepEqual(frames.map((f) => JSON.parse(f)), [
      { jsonrpc: '2.0', id: 5, method: 'ping', params: { note: 'has\nnewline' } },
    ]);
  });

  it('passes a garbage line through and JSON.parse of it throws — the -32700 signal', () => {
    const frames = mkParser().push('this is not json\n');
    assert.equal(frames.length, 1);
    assert.throws(() => JSON.parse(frames[0]!));
  });
});

// ---------------------------------------------------------------------------
// Server behavior (integration, real subprocess)
//
// Spawns the MCP entrypoint (src/mcp/index.ts, wired by another seat) as a
// child process speaking NDJSON stdio JSON-RPC. State is sandboxed via
// AGENTIC_CODING_HARNESS_STATE_DIR (src/core/store.ts stateDir()) so nothing touches
// the real ~/.agentic-coding-harness. Expected to fail until the entrypoint lands.
// ---------------------------------------------------------------------------

// Real entrypoint (src/mcp/index.ts, wired by another seat). The env
// override lets the plumbing be smoke-tested against a fake before it lands.
const ENTRY = process.env.HARNESS_MCP_ENTRY ?? new URL('../src/mcp/index.ts', import.meta.url).pathname;

const EXPECTED_TOOLS = [
  'harness_run',
  'harness_report',
  'harness_emit',
  'harness_stats',
  'harness_agents',
] as const;

// bun runs .ts natively; node needs the tsx loader (same rule as cli.test.ts).
const isBun = spawnSync('bun', ['--version'], { encoding: 'utf8' }).status === 0;

let child: ChildProcessWithoutNullStreams | null = null;
let stateTmp = '';
let cwdTmp = '';
let nextId = 1;
let pending: JsonRpcResponse[] = [];
let lineBuf = '';
let stderrTail = '';
const waiters = new Map<number, (m: JsonRpcResponse) => void>();

function startServer(): void {
  stateTmp = mkdtempSync(join(tmpdir(), 'harness-mcp-state-'));
  cwdTmp = mkdtempSync(join(tmpdir(), 'harness-mcp-cwd-'));
  nextId = 1;
  pending = [];
  lineBuf = '';
  stderrTail = '';
  const args = isBun ? [ENTRY] : ['--import', 'tsx', ENTRY];
  child = spawn(isBun ? 'bun' : process.execPath, args, {
    cwd: cwdTmp,
    env: { ...process.env, AGENTIC_CODING_HARNESS_STATE_DIR: stateTmp },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    lineBuf += chunk;
    for (;;) {
      const idx = lineBuf.indexOf('\n');
      if (idx < 0) return;
      const line = lineBuf.slice(0, idx);
      lineBuf = lineBuf.slice(idx + 1);
      onLine(line);
    }
  });
  child.stderr.on('data', (chunk: string) => {
    stderrTail = (stderrTail + chunk).slice(-800);
  });
  child.on('error', (err) => {
    stderrTail += `\nspawn error: ${err.message}`;
  });
}

function onLine(line: string): void {
  if (!line.trim()) return;
  let parsed: JsonRpcResponse;
  try {
    parsed = JSON.parse(line) as JsonRpcResponse;
  } catch {
    return; // non-JSON stdout noise; diagnostics live in stderrTail
  }
  const id = typeof parsed.id === 'number' ? parsed.id : undefined;
  const waiter = id !== undefined ? waiters.get(id) : undefined;
  if (waiter) {
    waiters.delete(id!);
    waiter(parsed);
  } else {
    pending.push(parsed);
  }
}

function send(req: Omit<JsonRpcRequest, 'id'>): number {
  if (!child || child.exitCode !== null) {
    throw new Error(`MCP server not running (entrypoint ${ENTRY} not startable); stderr: ${stderrTail}`);
  }
  const id = nextId++;
  child.stdin.write(`${JSON.stringify({ ...req, id })}\n`);
  return id;
}

function recv(id: number, timeoutMs = 15_000): Promise<JsonRpcResponse> {
  const cached = pending.find((m) => m.id === id);
  if (cached) {
    pending = pending.filter((m) => m !== cached);
    return Promise.resolve(cached);
  }
  return new Promise((resolve, reject) => {
    let done = false;
    const timer = setTimeout(
      () => finish(new Error(`no response for id=${id}; stderr tail: ${stderrTail}`)),
      timeoutMs,
    );
    const finish = (err?: Error, m?: JsonRpcResponse): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child?.off('exit', onExit);
      waiters.delete(id);
      if (err) reject(err);
      else resolve(m!);
    };
    const onExit = (): void =>
      finish(new Error(`server exited (code ${child?.exitCode}) before answering id=${id}; stderr: ${stderrTail}`));
    child?.once('exit', onExit);
    waiters.set(id, (m) => finish(undefined, m));
  });
}

const rpc = async (method: string, params?: unknown): Promise<JsonRpcResponse> => {
  const id = send({ jsonrpc: '2.0', method, params });
  return recv(id);
};

const callTool = (name: string, args: Record<string, unknown> = {}): Promise<JsonRpcResponse> =>
  rpc('tools/call', { name, arguments: args });

/** Contract: tools/call wraps the handler result as content[0].{type:'text'}. */
function parseToolText(res: JsonRpcResponse): unknown {
  assert.equal(res.error, undefined, `unexpected error: ${JSON.stringify(res.error)}`);
  const result = res.result as { content: Array<{ type: string; text: string }> };
  assert.equal(result.content[0]!.type, 'text');
  return JSON.parse(result.content[0]!.text);
}

describe('mcp server (real subprocess over NDJSON stdio)', () => {
  beforeEach(() => {
    startServer();
  });

  afterEach(() => {
    if (child) {
      child.removeAllListeners();
      child.kill('SIGTERM');
      const c = child;
      setTimeout(() => {
        if (c.exitCode === null && !c.killed) c.kill('SIGKILL');
      }, 500);
      child = null;
    }
  });

  after(() => {
    rmSync(stateTmp, { recursive: true, force: true });
    rmSync(cwdTmp, { recursive: true, force: true });
  });

  it('initialize returns protocolVersion 2025-06-18 and a serverInfo name', { timeout: 30_000 }, async () => {
    const res = await rpc('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'harness-mcp-test', version: '0.0.0' },
    });
    assert.equal(res.error, undefined, `initialize failed: ${JSON.stringify(res.error)}`);
    const result = res.result as { protocolVersion: string; serverInfo: { name: string; version: string } };
    assert.equal(result.protocolVersion, '2025-06-18');
    assert.ok(result.serverInfo.name.length > 0, 'serverInfo.name must be non-empty');
    // Contract: notifications/initialized never gets a response; send and move on.
    child!.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  });

  it('tools/list exposes the five harness tools', { timeout: 30_000 }, async () => {
    const res = await rpc('tools/list');
    assert.equal(res.error, undefined, `tools/list failed: ${JSON.stringify(res.error)}`);
    const tools = (res.result as { tools: Array<{ name: string }> }).tools;
    const names = new Set(tools.map((t) => t.name));
    for (const expected of EXPECTED_TOOLS) {
      assert.ok(names.has(expected), `missing tool: ${expected} (got: ${[...names].join(', ')})`);
    }
  });

  it('tools/call harness_agents returns JSON with an agents array', { timeout: 30_000 }, async () => {
    const res = await callTool('harness_agents');
    const parsed = parseToolText(res) as { agents: unknown[] };
    assert.ok(Array.isArray(parsed.agents), `expected agents array, got: ${JSON.stringify(parsed)}`);
  });

  it('harness_run with an unknown agent errors with -32603 or names the bad agent', { timeout: 30_000 }, async () => {
    const BAD = 'not-a-real-agent-xyz';
    const res = await callTool('harness_run', { agent: BAD, prompt: 'hi' });
    if (res.error) {
      assert.equal(res.error.code, -32603, `expected -32603, got: ${JSON.stringify(res.error)}`);
      assert.match(res.error.message, new RegExp(BAD));
    } else {
      const result = res.result as { content: Array<{ type: string; text: string }> };
      assert.match(result.content[0]!.text, new RegExp(BAD));
    }
  });

  it('unknown method returns -32601', { timeout: 30_000 }, async () => {
    const res = await rpc('no/such/method');
    assert.ok(res.error, `expected an error response, got: ${JSON.stringify(res)}`);
    assert.equal(res.error!.code, -32601);
  });

  it('unknown tool returns -32602', { timeout: 30_000 }, async () => {
    const res = await callTool('no_such_tool');
    assert.ok(res.error, `expected an error response, got: ${JSON.stringify(res)}`);
    assert.equal(res.error!.code, -32602);
    assert.match(res.error!.message, /no_such_tool/);
  });
});
