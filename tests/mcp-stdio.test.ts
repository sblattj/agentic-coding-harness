import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, beforeEach, describe, it } from 'node:test';

// ---------------------------------------------------------------------------
// `ach mcp` stdio transport (e2e, real subprocess)
//
// Spawns the CLI subcommand (src/cli/mcp.ts -> createMcpServer +
// registerHarnessTools) and speaks newline-delimited JSON-RPC over its stdin/
// stdout: one JSON response per stdout line, diagnostics on stderr. State is
// sandboxed via AGENTIC_CODING_HARNESS_STATE_DIR (src/core/store.ts stateDir())
// so nothing touches the real ~/.agentic-coding-harness.
//
// Protocol behaviors under test: initialize handshake + silent notifications,
// the exact 10-tool surface, tools/call, error codes (-32601/-32602/-32700/
// -32600), batch request arrays (one response-array line; all-notification
// batch -> []), stdout purity (every line ever written must JSON.parse), and
// exit semantics (stdin end -> exit 0).
// ---------------------------------------------------------------------------

const CLI = new URL('../src/cli/ach.ts', import.meta.url).pathname;

const EXPECTED_TOOLS = [
  'harness_run',
  'harness_run_async',
  'harness_run_status',
  'harness_run_events',
  'harness_run_cancel',
  'harness_kiro_preflight',
  'harness_report',
  'harness_emit',
  'harness_stats',
  'harness_agents',
] as const;

type RpcMsg = {
  jsonrpc: string;
  id?: number | string | null;
  result?: unknown;
  error?: { code: number; message: string };
};

// bun runs .ts natively; node needs the tsx loader (same rule as cli.test.ts).
const isBun = (process.versions as { bun?: string }).bun !== undefined;

// `--import tsx` resolves the specifier from the CHILD's cwd, and these spawns
// run with a bare tmp cwd — so resolve tsx to an absolute path from THIS test
// file (repo-rooted) instead. No-op under bun.
const TSX_IMPORT = createRequire(import.meta.url).resolve('tsx');

let child: ChildProcessWithoutNullStreams | null = null;
let stateTmp = '';
let cwdTmp = '';
let nextId = 1;
let pending: RpcMsg[] = [];
let rawQueue: string[] = [];
let lineBuf = '';
let stderrTail = '';
// Every stdout line every child of this file ever wrote (never reset): the
// stdout-purity evidence. A stray diagnostics line would fail JSON.parse.
const allLines: string[] = [];
const lineWaiters: Array<(line: string) => void> = [];
const waiters = new Map<number, (m: RpcMsg) => void>();
const tmpDirs: string[] = [];
let exitInfo: { code: number | null; signal: string | null } | null = null;
let exitPromise: Promise<void> = Promise.resolve();

function startServer(): void {
  stateTmp = mkdtempSync(join(tmpdir(), 'harness-mcp-stdio-state-'));
  cwdTmp = mkdtempSync(join(tmpdir(), 'harness-mcp-stdio-cwd-'));
  tmpDirs.push(stateTmp, cwdTmp);
  nextId = 1;
  pending = [];
  rawQueue = [];
  lineBuf = '';
  stderrTail = '';
  exitInfo = null;
  const args = isBun ? [CLI, 'mcp'] : ['--import', TSX_IMPORT, CLI, 'mcp'];
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
  exitPromise = new Promise<void>((resolve) => {
    child!.on('exit', (code, signal) => {
      exitInfo = { code, signal };
      resolve();
    });
  });
}

function onLine(line: string): void {
  allLines.push(line);
  const lineWaiter = lineWaiters.shift();
  if (lineWaiter) {
    lineWaiter(line);
    return;
  }
  rawQueue.push(line);
  let parsed: RpcMsg | null = null;
  try {
    const p: unknown = JSON.parse(line);
    if (p !== null && typeof p === 'object' && !Array.isArray(p)) parsed = p as RpcMsg;
  } catch {
    return; // garbage line — lives only in allLines/rawQueue
  }
  const id = typeof parsed!.id === 'number' ? parsed!.id : undefined;
  const w = id !== undefined ? waiters.get(id) : undefined;
  if (w) {
    waiters.delete(id!);
    const qi = rawQueue.indexOf(line);
    if (qi >= 0) rawQueue.splice(qi, 1);
    w(parsed!);
  } else {
    pending.push(parsed!);
  }
}

function writeRaw(text: string): void {
  if (!child || child.exitCode !== null) {
    throw new Error(`mcp server not running (cli ${CLI}); stderr: ${stderrTail}`);
  }
  child.stdin.write(text);
}

function send(method: string, params?: unknown): number {
  const id = nextId++;
  writeRaw(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  return id;
}

/** Next stdout line (oldest unconsumed first) — for non-id lines (batches, errors). */
function nextLine(timeoutMs = 15_000): Promise<string> {
  const cached = rawQueue.shift();
  if (cached !== undefined) return Promise.resolve(cached);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`no stdout line within ${timeoutMs}ms; stderr: ${stderrTail}`)),
      timeoutMs,
    );
    lineWaiters.push((line) => {
      clearTimeout(timer);
      resolve(line);
    });
  });
}

function recv(id: number, timeoutMs = 15_000): Promise<RpcMsg> {
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
    const finish = (err?: Error, m?: RpcMsg): void => {
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

const rpc = async (method: string, params?: unknown): Promise<RpcMsg> => {
  const id = send(method, params);
  return recv(id);
};

const callTool = (name: string, args: Record<string, unknown> = {}): Promise<RpcMsg> =>
  rpc('tools/call', { name, arguments: args });

/** Contract: tools/call wraps the handler result as content[0].{type:'text'}. */
function parseToolText(res: RpcMsg): unknown {
  assert.equal(res.error, undefined, `unexpected error: ${JSON.stringify(res.error)}`);
  const result = res.result as { content: Array<{ type: string; text: string }> };
  assert.equal(result.content[0]!.type, 'text');
  return JSON.parse(result.content[0]!.text);
}

function runCli(args: string[]): { code: number; stdout: string; stderr: string } {
  const env: Record<string, string | undefined> = { ...process.env };
  delete env.AGENTIC_CODING_HARNESS_ROOT; // the very thing under test must default to unset
  const p = spawnSync(process.execPath, isBun ? [CLI, ...args] : ['--import', TSX_IMPORT, CLI, ...args], {
    env: { ...env, AGENTIC_CODING_HARNESS_STATE_DIR: stateTmp } as NodeJS.ProcessEnv,
    encoding: 'utf8',
    timeout: 60_000,
  });
  return {
    code: p.status ?? -1,
    stdout: p.stdout ?? '',
    stderr: p.stderr ?? '',
  };
}

describe('ach mcp (stdio subcommand, real subprocess)', () => {
  beforeEach(() => {
    startServer();
  });

  afterEach(() => {
    if (child) {
      child.removeAllListeners();
      child.kill('SIGTERM');
      const c = child;
      setTimeout(() => {
        if (c.exitCode === null) c.kill('SIGKILL');
      }, 500);
      child = null;
    }
  });

  after(() => {
    // Stdout purity: every line the pump ever saw across all children must be
    // a JSON value (objects, arrays, and error objects all parse). Any stray
    // diagnostics on stdout would break this.
    for (const [i, line] of allLines.entries()) {
      assert.doesNotThrow(
        () => JSON.parse(line),
        `stdout line #${i + 1} is not valid JSON: ${JSON.stringify(line)}`,
      );
    }
  });

  after(() => {
    for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
  });

  it(
    'initialize returns protocolVersion 2025-06-18 + serverInfo; notifications/initialized never answers',
    { timeout: 30_000 },
    async () => {
      const res = await rpc('initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'mcp-stdio-test', version: '0.0.0' },
      });
      assert.equal(res.error, undefined, `initialize failed: ${JSON.stringify(res.error)}`);
      const result = res.result as {
        protocolVersion: string;
        serverInfo: { name: string; version: string };
      };
      assert.equal(result.protocolVersion, '2025-06-18');
      assert.equal(result.serverInfo.name, 'agentic-coding-harness');
      assert.match(result.serverInfo.version, /^\d+\.\d+\.\d+$/);

      // Contract: the initialized notification (no id) gets no response. Send
      // it, then a ping with a fresh id: the ONLY new stdout line must be the
      // ping's answer — proving nothing interleaved for the notification.
      const linesBefore = allLines.length;
      writeRaw(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
      const pingId = send('ping');
      const pong = await recv(pingId);
      assert.equal(pong.error, undefined);
      assert.equal(allLines.length, linesBefore + 1, 'notification must not produce any stdout line');
    },
  );

  it('tools/list exposes exactly the ten harness tools', { timeout: 30_000 }, async () => {
    const res = await rpc('tools/list');
    assert.equal(res.error, undefined, `tools/list failed: ${JSON.stringify(res.error)}`);
    const tools = (res.result as { tools: Array<{ name: string }> }).tools;
    assert.deepEqual(
      tools.map((t) => t.name).sort(),
      [...EXPECTED_TOOLS].sort(),
    );
  });

  it('tools/call harness_agents against an empty state dir returns text JSON with an agents array', { timeout: 30_000 }, async () => {
    const res = await callTool('harness_agents');
    const parsed = parseToolText(res) as { agents: unknown[] };
    assert.ok(Array.isArray(parsed.agents), `expected agents array, got: ${JSON.stringify(parsed)}`);
  });

  it('unknown method -> -32601; unknown tool name -> -32602 naming it', { timeout: 30_000 }, async () => {
    const badMethod = await rpc('no/such/method');
    assert.ok(badMethod.error, `expected an error response, got: ${JSON.stringify(badMethod)}`);
    assert.equal(badMethod.error!.code, -32601);

    const badTool = await callTool('harness_nope');
    assert.ok(badTool.error, `expected an error response, got: ${JSON.stringify(badTool)}`);
    assert.equal(badTool.error!.code, -32602);
    assert.match(badTool.error!.message, /harness_nope/);
  });

  it('garbage line -> -32700 with id null; server stays alive for the next request', { timeout: 30_000 }, async () => {
    writeRaw('not-json{{{\n');
    const line = await nextLine();
    const parsed = JSON.parse(line) as RpcMsg;
    assert.ok(parsed.error, `expected an error response on line: ${line}`);
    assert.equal(parsed.error!.code, -32700);
    assert.equal(parsed.id, null);
    const pingId = send('ping');
    const pong = await recv(pingId);
    assert.equal(pong.error, undefined, 'server must keep serving after a parse error');
  });

  it(
    'batch request array -> one stdout line with a response array (ids in order); all-notification batch -> []',
    { timeout: 30_000 },
    async () => {
      writeRaw(
        `[${JSON.stringify({ jsonrpc: '2.0', id: 101, method: 'ping' })},${JSON.stringify({ jsonrpc: '2.0', id: 102, method: 'tools/list' })}]\n`,
      );
      const line = await nextLine();
      const arr: unknown = JSON.parse(line);
      assert.ok(Array.isArray(arr), `batch response must be a JSON array line, got: ${line.slice(0, 120)}`);
      assert.deepEqual(
        (arr as RpcMsg[]).map((m) => m.id),
        [101, 102],
      );
      for (const m of arr as RpcMsg[]) assert.equal(m.error, undefined);

      writeRaw(`[${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}]\n`);
      const emptyLine = await nextLine();
      assert.equal(emptyLine.trim(), '[]');
    },
  );

  it('request object with an id but missing method -> -32600 echoing the id', { timeout: 30_000 }, async () => {
    writeRaw('{"jsonrpc":"2.0","id":7}\n');
    const line = await nextLine();
    const parsed = JSON.parse(line) as RpcMsg;
    assert.ok(parsed.error, `expected an error response on line: ${line}`);
    assert.equal(parsed.error!.code, -32600);
    assert.equal(parsed.id, 7);
  });

  it(
    'half-close drain: a request followed immediately by stdin end still gets its response',
    { timeout: 30_000 },
    async () => {
      // Regression: ach exits as soon as serve() resolves on stdin 'end';
      // without in-flight tracking the fs-async tool response lost the race
      // (0 bytes on stdout, exit 0). recv() rejects if the child exits first.
      const id = send('tools/call', { name: 'harness_stats', arguments: {} });
      child!.stdin.end();
      const res = await recv(id);
      assert.equal(res.error, undefined, `unexpected error: ${JSON.stringify(res.error)}`);
      assert.ok(res.result, 'no result on half-close response');
      const result = res.result as { content: Array<{ type: string; text: string }> };
      assert.equal(result.content[0]!.type, 'text');
      await exitPromise;
      assert.equal(exitInfo!.code, 0, `expected exit code 0, got code=${exitInfo!.code} signal=${exitInfo!.signal}`);
    },
  );

  it(
    'stdin end -> process exits 0; every stdout line ever written parses as JSON (stdout purity)',
    { timeout: 30_000 },
    async () => {
      const quiesceId = send('ping');
      await recv(quiesceId);
      child!.stdin.end();
      const result = await Promise.race([
        exitPromise.then(() => 'exited' as const),
        new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 10_000)),
      ]);
      assert.equal(result, 'exited', 'server did not exit within 10s of stdin end');
      assert.equal(exitInfo!.code, 0, `expected exit code 0, got code=${exitInfo!.code} signal=${exitInfo!.signal}`);
      for (const [i, line] of allLines.entries()) {
        assert.doesNotThrow(
          () => JSON.parse(line),
          `stdout line #${i + 1} is not valid JSON: ${JSON.stringify(line)}`,
        );
      }
    },
  );

  it('flag validation: --gateway without --root exits 1 naming the requirement; USAGE lists `  ach mcp `', { timeout: 30_000 }, () => {
    const gw = runCli(['mcp', '--gateway']);
    assert.equal(gw.code, 1, `expected exit 1, got ${gw.code}; stderr: ${gw.stderr}`);
    assert.match(gw.stderr, /--gateway requires --root/);

    const help = runCli(['--help']);
    assert.equal(help.code, 0, `--help failed: ${help.stderr}`);
    const usageLine = help.stdout.split('\n').find((l) => l.startsWith('  ach mcp '));
    assert.ok(usageLine, `no USAGE line starting with '  ach mcp ' in:\n${help.stdout}`);
  });
});
