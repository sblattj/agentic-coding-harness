import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { PtySessionInfo } from '../src/web/pty-manager.ts';

// ---------------------------------------------------------------------------
// PTY relay (src/web/pty-manager.ts + the /api/pty + /ws/pty routes in
// src/web/server.ts). bun-pty PTYs only construct under Bun, so the manager
// scenario runs through a bun subprocess probe and the HTTP/WS surface
// through the same bun-subprocess web-server runner as tests/web.test.ts.
// ---------------------------------------------------------------------------

const RUNNER = new URL('./helpers/web-server-runner.ts', import.meta.url).pathname;
const PROBE = new URL('./helpers/pty-manager-probe.ts', import.meta.url).pathname;
const isBun = spawnSync('bun', ['--version'], { encoding: 'utf8' }).status === 0;

interface ProbeResult {
  spawnInfoOk: boolean;
  writeOk: boolean;
  scrollbackHasGot: boolean;
  getAlive: boolean;
  resizeZeroColsFalse: boolean;
  resizeZeroRowsFalse: boolean;
  resizeFracColsFalse: boolean;
  resizeOk: boolean;
  resizeUpdatesInfo: boolean;
  killTrue: boolean;
  exitCodeOnKill: number;
  killAgainFalse: boolean;
  deadInfoOk: boolean;
  writeAfterExitFalse: boolean;
  scrollbackSurvivesExit: boolean;
  writeUnknownFalse: boolean;
  killUnknownFalse: boolean;
  getUnknownNull: boolean;
  resizeUnknownFalse: boolean;
  scrollbackUnknownEmpty: boolean;
  scrollbackCapLen: number;
  scrollbackCapOk: boolean;
  listAliveOnlyEmpty: boolean;
  listIncludeDead: boolean;
  disposeKills: boolean;
}

// ------------------------------------------------- manager (bun subprocess)

describe('PtyManager (bun subprocess probe)', { skip: isBun ? false : 'bun not on PATH' }, () => {
  it('drives spawn → data → write → scrollback → kill/exit → guards → ring cap → dispose', async () => {
    const child = spawn('bun', [PROBE], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout!.setEncoding('utf8');
    child.stderr!.setEncoding('utf8');
    child.stdout!.on('data', (c: string) => {
      out += c;
    });
    child.stderr!.on('data', (c: string) => {
      err += c;
    });
    const code = await new Promise<number | null>((resolve, reject) => {
      const deadline = setTimeout(() => reject(new Error(`probe timed out; stderr: ${err.slice(-400)}`)), 90_000);
      child.once('exit', (c) => {
        clearTimeout(deadline);
        resolve(c);
      });
    });
    assert.equal(code, 0, `probe exited ${code}; stderr: ${err.slice(-400)}; output: ${out.slice(-2000)}`);
    const line = out.split('\n').filter((l) => l.startsWith('PROBE_RESULT ')).pop();
    assert.ok(line, `no PROBE_RESULT line; output: ${out.slice(-2000)}`);
    const r = JSON.parse(line!.slice('PROBE_RESULT '.length)) as ProbeResult;

    assert.equal(r.spawnInfoOk, true, 'spawned session info (id/pid/alive/cols/rows) wrong');
    assert.equal(r.writeOk, true, 'write on a live session must return true');
    assert.equal(r.scrollbackHasGot, true, 'scrollback must contain the echoed GOT: output');
    assert.equal(r.getAlive, true, 'get() on a live session reports alive');
    assert.equal(r.resizeZeroColsFalse, true, 'resize cols<1 must return false');
    assert.equal(r.resizeZeroRowsFalse, true, 'resize rows<1 must return false');
    assert.equal(r.resizeFracColsFalse, true, 'resize with non-integer cols must return false');
    assert.equal(r.resizeOk, true, 'valid resize must return true');
    assert.equal(r.resizeUpdatesInfo, true, 'resize must update info cols/rows');
    assert.equal(r.killTrue, true, 'kill on a live session must return true');
    assert.equal(r.exitCodeOnKill, 0, 'kill → onExit must fire with exitCode 0 (bun-pty semantics)');
    assert.equal(r.killAgainFalse, true, 'kill on a dead session must return false');
    assert.equal(r.deadInfoOk, true, 'get() after exit: alive=false, exitCode set');
    assert.equal(r.writeAfterExitFalse, true, 'write after kill must return false');
    assert.equal(r.scrollbackSurvivesExit, true, 'scrollback must survive session exit');
    assert.equal(r.writeUnknownFalse, true, 'write on unknown id must return false');
    assert.equal(r.killUnknownFalse, true, 'kill on unknown id must return false');
    assert.equal(r.getUnknownNull, true, 'get on unknown id must return null');
    assert.equal(r.resizeUnknownFalse, true, 'resize on unknown id must return false');
    assert.equal(r.scrollbackUnknownEmpty, true, 'scrollback of unknown id must be empty');
    assert.ok(r.scrollbackCapLen > 150_000, `scrollback kept too little: ${String(r.scrollbackCapLen)}`);
    assert.ok(r.scrollbackCapLen <= 200 * 1024, `scrollback exceeded the 200KB ring: ${String(r.scrollbackCapLen)}`);
    assert.equal(r.scrollbackCapOk, true, 'scrollback must keep the tail (CAPEND) within the 200KB cap');
    assert.equal(r.listAliveOnlyEmpty, true, 'list() must exclude dead sessions by default');
    assert.equal(r.listIncludeDead, true, 'list(true) must include dead sessions');
    assert.equal(r.disposeKills, true, 'dispose() must kill remaining sessions');
  });
});

// ------------------------------------- HTTP routes + WS relay (bun subprocess)

interface ServerHandle {
  port: number;
  child: ChildProcess;
}

interface ExitFrame {
  type: string;
  exitCode: number | null;
}

interface Relay {
  ws: WebSocket;
  raw(): string;
  exitFrame(): ExitFrame | null;
  isClosed(): boolean;
}

const states: string[] = [];
const children: ChildProcess[] = [];
let open: ServerHandle | null = null; // no token
let authed: ServerHandle | null = null; // token: sekret

function urlOf(srv: ServerHandle, pathname: string): string {
  return `http://127.0.0.1:${srv.port}${pathname}`;
}

function wsOf(srv: ServerHandle, pathname: string): string {
  return `ws://127.0.0.1:${srv.port}${pathname}`;
}

async function spawnServer(stateDir: string, token: string): Promise<ServerHandle> {
  const child = spawn('bun', [RUNNER, stateDir, token], { stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  let out = '';
  let err = '';
  child.stdout!.setEncoding('utf8');
  child.stderr!.setEncoding('utf8');
  child.stderr!.on('data', (c: string) => {
    err += c;
  });
  const port = await new Promise<number>((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error(`web server never became ready; stderr: ${err.slice(-400)}`)), 20_000);
    child.stdout!.on('data', (c: string) => {
      out += c;
      const m = /READY (\d+)\n/.exec(out);
      if (m) {
        clearTimeout(deadline);
        resolve(Number(m[1]));
      }
    });
    child.once('exit', (code, sig) => {
      clearTimeout(deadline);
      reject(new Error(`web server exited early (${code}/${sig}); stderr: ${err.slice(-400)}`));
    });
  });
  return { port, child };
}

async function killChild(c: ChildProcess): Promise<void> {
  if (c.exitCode !== null || c.signalCode) return;
  await new Promise<void>((resolve) => {
    const escalated = setTimeout(() => {
      try {
        c.kill('SIGKILL');
      } catch {
        /* gone */
      }
    }, 3_000);
    c.once('exit', () => {
      clearTimeout(escalated);
      resolve();
    });
    c.kill('SIGTERM');
  });
}

async function post(srv: ServerHandle, pathname: string, body: string): Promise<Response> {
  return fetch(urlOf(srv, pathname), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  });
}

async function spawnPty(srv: ServerHandle, command: string, args: string[]): Promise<PtySessionInfo> {
  const res = await post(srv, '/api/pty', JSON.stringify({ command, args }));
  if (res.status !== 201) {
    assert.fail(`spawn ${command} failed (${res.status}): ${await res.text()}`);
  }
  return (await res.json()) as PtySessionInfo;
}

/** Open a relay WS and split frames into raw output vs the exit control frame. */
function openRelay(url: string): Relay {
  const ws = new WebSocket(url);
  let raw = '';
  let frame: ExitFrame | null = null;
  let closed = false;
  ws.addEventListener('message', (ev: MessageEvent) => {
    const data = String(ev.data);
    if (frame === null && data.startsWith('{"type":"exit"')) {
      frame = JSON.parse(data) as ExitFrame;
      return;
    }
    raw += data;
  });
  ws.addEventListener('close', () => {
    closed = true;
  });
  return { ws, raw: () => raw, exitFrame: () => frame, isClosed: () => closed };
}

async function waitOpen(ws: WebSocket, timeoutMs = 5_000): Promise<void> {
  if (ws.readyState === WebSocket.OPEN) return;
  await new Promise<void>((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error('relay ws never opened')), timeoutMs);
    ws.addEventListener('open', () => {
      clearTimeout(deadline);
      resolve();
    }, { once: true });
    ws.addEventListener('error', () => {
      clearTimeout(deadline);
      reject(new Error('relay ws error before open'));
    }, { once: true });
  });
}

async function until(desc: string, cond: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.fail(`${desc} not observed within ${timeoutMs}ms`);
}

describe('PTY HTTP routes + WS relay (bun subprocess)', { skip: isBun ? false : 'bun not on PATH' }, () => {
  before(async () => {
    const s1 = mkdtempSync(join(tmpdir(), 'harness-web-pty-open-'));
    const s2 = mkdtempSync(join(tmpdir(), 'harness-web-pty-auth-'));
    states.push(s1, s2);
    open = await spawnServer(s1, '');
    authed = await spawnServer(s2, 'sekret');
  });

  after(async () => {
    for (const c of children.splice(0)) await killChild(c);
    for (const s of states.splice(0)) rmSync(s, { recursive: true, force: true });
  });

  it('POST /api/pty: valid → 201 with id+pid+alive; missing command → 400; bad JSON/args → 400', async () => {
    const info = await spawnPty(open!, 'bash', ['-lc', 'echo LIVE; read x']);
    assert.ok(typeof info.id === 'string' && info.id.length > 0, 'session id missing');
    assert.equal(info.command, 'bash');
    assert.equal(typeof info.pid, 'number');
    assert.ok(info.pid! > 0, 'pid must be a positive number');
    assert.equal(info.alive, true);

    const noCommand = await post(open!, '/api/pty', JSON.stringify({ args: ['x'] }));
    assert.equal(noCommand.status, 400);
    assert.ok(((await noCommand.json()) as { error: string }).error.includes('command'));

    const badJson = await post(open!, '/api/pty', 'this is not json');
    assert.equal(badJson.status, 400);

    const badArgs = await post(open!, '/api/pty', JSON.stringify({ command: 'bash', args: [1, 2] }));
    assert.equal(badArgs.status, 400);

    const badCols = await post(open!, '/api/pty', JSON.stringify({ command: 'bash', cols: 0 }));
    assert.equal(badCols.status, 400);
  });

  it('GET /api/pty lists live sessions; kill → 200; dead/unknown kill → 404', async () => {
    const info = await spawnPty(open!, 'bash', ['-lc', 'read x']);

    const listed = (await (await fetch(urlOf(open!, '/api/pty'))).json()) as { sessions: PtySessionInfo[] };
    const mine = listed.sessions.find((s) => s.id === info.id);
    assert.ok(mine, 'spawned session not listed');
    assert.equal(mine!.alive, true);

    const kill = await post(open!, `/api/pty/${info.id}/kill`, '');
    assert.equal(kill.status, 200);
    assert.deepEqual(await kill.json(), { ok: true });

    const listedAfter = (await (await fetch(urlOf(open!, '/api/pty'))).json()) as { sessions: PtySessionInfo[] };
    assert.ok(!listedAfter.sessions.some((s) => s.id === info.id), 'dead session still listed');

    const killAgain = await post(open!, `/api/pty/${info.id}/kill`, '');
    assert.equal(killAgain.status, 404, 'killing a dead session must 404');
    const killUnknown = await post(open!, '/api/pty/no-such-session/kill', '');
    assert.equal(killUnknown.status, 404);
  });

  it('WS relay: scrollback → keystroke echo → exit frame + close after kill', async () => {
    if (typeof WebSocket === 'undefined') {
      assert.ok(true, 'WebSocket global unavailable in this runner; skipped');
      return;
    }
    const info = await spawnPty(open!, 'bash', ['-lc', 'echo READY; read x; echo GOT:$x; read y']);
    const relay = openRelay(wsOf(open!, `/ws/pty/${info.id}`));
    try {
      await waitOpen(relay.ws);
      await until('READY frame (scrollback or live)', () => relay.raw().includes('READY'));

      relay.ws.send('hi\n');
      await until('echoed GOT:hi frame', () => relay.raw().includes('GOT:hi'));

      const kill = await post(open!, `/api/pty/${info.id}/kill`, '');
      assert.equal(kill.status, 200);
      await until('exit frame after kill', () => relay.exitFrame() !== null);
      assert.equal(relay.exitFrame()!.type, 'exit');
      assert.equal(relay.exitFrame()!.exitCode, 0, 'kill must report exitCode 0');
      await until('server closes the relay socket after exit', () => relay.isClosed());
    } finally {
      relay.ws.close();
    }
    // the server must still answer plain HTTP after a relay session
    const res = await fetch(urlOf(open!, '/api/pty'));
    assert.equal(res.status, 200);
  });

  it('WS resize control frame: invalid ignored, valid applied, natural exit delivers exit frame', async () => {
    if (typeof WebSocket === 'undefined') {
      assert.ok(true, 'WebSocket global unavailable in this runner; skipped');
      return;
    }
    const info = await spawnPty(open!, 'bash', ['-lc', 'read x; stty size']);
    const relay = openRelay(wsOf(open!, `/ws/pty/${info.id}`));
    try {
      await waitOpen(relay.ws);
      // invalid dims must be dropped server-side, not kill the socket
      relay.ws.send(JSON.stringify({ type: 'resize', cols: 0, rows: 40 }));
      relay.ws.send(JSON.stringify({ type: 'resize', cols: 120, rows: 40 }));
      relay.ws.send('\n'); // satisfy `read x`; then bash prints "rows cols"
      await until('stty size reflects 40 rows x 120 cols', () => relay.raw().includes('40 120'));

      // script ends → natural exit: exit frame then server-side close, no kill needed
      await until('exit frame after natural exit', () => relay.exitFrame() !== null);
      assert.equal(relay.exitFrame()!.exitCode, 0);
      await until('server closes the relay socket after natural exit', () => relay.isClosed());
    } finally {
      relay.ws.close();
    }
  });

  it('token-gated /ws/pty: missing/wrong token → 401 and upgrade rejected; valid token relays', async () => {
    const info = await spawnPty(authed!, 'bash', ['-lc', 'echo TOKENOK; read x']);
    const path = `/ws/pty/${info.id}`;

    const noTok = await fetch(wsOf(authed!, path).replace('ws://', 'http://'));
    assert.equal(noTok.status, 401, 'ws without token must 401');
    const wrongTok = await fetch(`http://127.0.0.1:${authed!.port}${path}?token=wrong`);
    assert.equal(wrongTok.status, 401, 'ws with wrong token must 401');

    if (typeof WebSocket !== 'undefined') {
      // a real browser-style upgrade without a token is rejected: error, never open
      const rejected = new WebSocket(wsOf(authed!, path));
      const outcome = await new Promise<'open' | 'error' | 'timeout'>((resolve) => {
        const deadline = setTimeout(() => resolve('timeout'), 5_000);
        rejected.addEventListener('open', () => {
          clearTimeout(deadline);
          resolve('open');
        }, { once: true });
        rejected.addEventListener('error', () => {
          clearTimeout(deadline);
          resolve('error');
        }, { once: true });
      });
      assert.equal(outcome, 'error', 'upgrade without token must be rejected with an error');

      // with the right token the relay works end to end
      const relay = openRelay(`${wsOf(authed!, path)}?token=sekret`);
      try {
        await waitOpen(relay.ws);
        await until('TOKENOK frame through token-gated relay', () => relay.raw().includes('TOKENOK'));
      } finally {
        relay.ws.close();
      }
    }

    const kill = await post(authed!, `/api/pty/${info.id}/kill`, '');
    assert.equal(kill.status, 200);
  });

  it('spawn with a nonexistent command → 400 (not a crash); server keeps serving', async () => {
    const res = await post(open!, '/api/pty', JSON.stringify({ command: '/no/such/binary-agb-pty-test' }));
    assert.equal(res.status, 400, 'nonexistent command must be a 400, not a crash');
    const body = (await res.json()) as { error: string };
    assert.ok(body.error.includes('spawn failed'), `unexpected error body: ${body.error}`);

    const still = await fetch(urlOf(open!, '/api/pty'));
    assert.equal(still.status, 200, 'server must keep serving after a failed spawn');
    assert.ok(Array.isArray(((await still.json()) as { sessions: unknown[] }).sessions));
  });
});
