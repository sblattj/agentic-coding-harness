// #212 review (src/web/server.ts /api/pty gate, src/web/desks-api.ts authorize): `ach web` with
// no --token used to run every privileged route unauthenticated. The Jupyter model fixes it:
// - a tokenless `ach web` generates a token into <stateDir>/web/token (0600, dir 0700) and
//   reuses it on restart; --token / env still win; an empty value is unset;
// - every privileged route (/api/pty, /ws/pty incl. live-run input, /api/live/<id>/continue,
//   every /api/desks route) needs the token: unauthenticated = 401, the command never runs;
// - a valid ?token= sets an HttpOnly, SameSite=Strict cookie that then authenticates on its own;
// - a server embedded without any token fails closed (403) on the privileged routes.
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { startWebServer, type WebServerHandle } from '../src/web/server.ts';

const ACH = new URL('../src/cli/ach.ts', import.meta.url).pathname;
const isBun = spawnSync('bun', ['--version'], { encoding: 'utf8' }).status === 0;

const dirs: string[] = [];
const children: ChildProcess[] = [];
function tmp(tag: string): string {
  const d = mkdtempSync(join(tmpdir(), `ach-desks-${tag}-`));
  dirs.push(d);
  return d;
}
after(() => {
  for (const c of children) c.kill('SIGKILL');
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const json = { 'content-type': 'application/json' };

/** Starts the real `ach web` CLI under bun; resolves with the printed URL and the stderr so far. */
async function achWeb(state: string, extra: string[] = [], env: Record<string, string> = {}): Promise<{ child: ChildProcess; url: URL; err: () => string }> {
  const child = spawn('bun', [ACH, 'web', '--no-open', '--state-only', '--port', '0', '--state-dir', state, ...extra], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, HOME: state, AGENTIC_CODING_HARNESS_HTTP_TOKEN: '', ...env },
  });
  children.push(child);
  child.stderr!.setEncoding('utf8');
  let err = '';
  child.stderr!.on('data', (c: string) => (err += c));
  const url = await new Promise<URL>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`web never ready: ${err}`)), 20_000);
    const check = (): void => {
      const m = /web dashboard: (\S+)/.exec(err);
      if (m) {
        clearTimeout(t);
        resolve(new URL(m[1]!));
      }
    };
    child.stderr!.on('data', check);
  });
  return { child, url, err: () => err };
}

async function stop(c: ChildProcess): Promise<void> {
  if (c.exitCode !== null || c.signalCode) return;
  await new Promise<void>((r) => {
    c.once('exit', () => r());
    c.kill('SIGTERM');
  });
}

/** A WebSocket-upgrade request; resolves with the status (101 = upgraded). */
function upgrade(port: number, path: string, headers: Record<string, string> = {}): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, headers: { connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-version': '13', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==', ...headers } });
    req.on('response', (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('upgrade', (res, socket) => {
      socket.destroy();
      resolve(res.statusCode ?? 0);
    });
    req.on('error', reject);
    req.end();
  });
}

describe('tokenless `ach web` generates a token and gates every privileged route', { skip: isBun ? false : 'bun not on PATH' }, () => {
  let state = '';
  let base = '';
  let port = 0;
  let token = '';
  let child: ChildProcess;
  let marker = '';
  before(async () => {
    state = tmp('cli');
    marker = join(state, 'PWNED');
    const w = await achWeb(state);
    child = w.child;
    port = Number(w.url.port);
    base = `http://127.0.0.1:${port}`;
    token = w.url.searchParams.get('token') ?? '';
  });
  after(async () => stop(child));

  it('the token file is created 0600 in a 0700 dir and is the token in the printed URL', () => {
    const file = join(state, 'web', 'token');
    assert.ok(existsSync(file), 'token file exists');
    assert.equal(statSync(file).mode & 0o777, 0o600, 'token file is 0600');
    assert.equal(statSync(join(state, 'web')).mode & 0o777, 0o700, 'token dir is 0700');
    assert.equal(readFileSync(file, 'utf8').trim(), token, 'printed ?token= is the stored token');
    assert.ok(token.length >= 43, `>= 256 bits base64url, got ${token.length} chars`);
  });

  it('unauthenticated POST /api/pty is 401 and the command never runs', async () => {
    const res = await fetch(`${base}/api/pty`, { method: 'POST', headers: json, body: JSON.stringify({ command: 'touch', args: [marker] }) });
    assert.equal(res.status, 401, `got ${res.status} ${await res.text()}`);
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(existsSync(marker), false, 'the command must not have run');
  });

  it('unauthenticated list/kill, desks reads and writes, live continue and /ws/pty are 401', async () => {
    assert.equal((await fetch(`${base}/api/pty`)).status, 401, 'GET /api/pty');
    assert.equal((await fetch(`${base}/api/pty/x/kill`, { method: 'POST' })).status, 401, 'kill');
    assert.equal((await fetch(`${base}/api/desks`)).status, 401, 'GET /api/desks');
    assert.equal((await fetch(`${base}/api/desks/send`, { method: 'POST', headers: json, body: '{}' })).status, 401, 'desks send');
    assert.equal((await fetch(`${base}/api/live/x/continue`, { method: 'POST' })).status, 401, 'live continue');
    assert.equal(await upgrade(port, `/ws/pty/${encodeURIComponent('run:x')}`), 401, 'live-run PTY input');
    assert.equal((await fetch(`${base}/?token=wrong`)).headers.get('set-cookie'), null, 'a wrong ?token= earns no cookie');
  });

  it('control: pages and the run list still answer without a token, and never contain it', async () => {
    for (const p of ['/', '/grid', '/desks', '/trio', '/compare', '/api/runs', '/api/stats', '/health']) {
      const res = await fetch(base + p);
      assert.equal(res.status, 200, `GET ${p}`);
      assert.ok(!(await res.text()).includes(token), `GET ${p} must not leak the token`);
    }
    for (const p of ['/queues', '/api/queues', '/api/live']) {
      const res = await fetch(base + p);
      assert.equal(res.status, 401, `GET ${p} needs the token`);
      assert.ok(!(await res.text()).includes(token), `GET ${p} must not leak the token`);
    }
  });

  it('?token= sets an HttpOnly SameSite=Strict cookie that then authenticates by itself', async () => {
    const page = await fetch(`${base}/grid?token=${encodeURIComponent(token)}`);
    assert.equal(page.status, 200);
    const set = page.headers.get('set-cookie') ?? '';
    assert.match(set, new RegExp(`^ach_web_token_${port}=`), set);
    assert.match(set, /HttpOnly/);
    assert.match(set, /SameSite=Strict/);
    const cookie = set.split(';')[0]!;
    const list = await fetch(`${base}/api/pty`, { headers: { cookie } });
    assert.equal(list.status, 200, 'cookie lists PTYs');
    assert.equal((await fetch(`${base}/api/desks`, { headers: { cookie } })).status, 200, 'cookie reads desks');
    assert.equal((await fetch(`${base}/queues`, { headers: { cookie } })).status, 200, 'cookie opens the queue page');
    // grid.html always appends ?token=<TOKEN>, empty after a cookie-only reload: the cookie still counts.
    assert.equal((await fetch(`${base}/api/pty?token=`, { headers: { cookie } })).status, 200, 'empty ?token= falls through to the cookie');
    assert.equal((await fetch(`${base}/api/live/x/continue`, { method: 'POST', headers: { cookie } })).status, 404, 'cookie reaches continue (no such run)');
    assert.equal(await upgrade(port, `/ws/pty/${encodeURIComponent('run:x')}`, { cookie }), 404, 'cookie reaches the live PTY route (no such run)');
    const ok = join(state, 'COOKIE_OK');
    const spawned = await fetch(`${base}/api/pty`, { method: 'POST', headers: { ...json, cookie }, body: JSON.stringify({ command: 'touch', args: [ok] }) });
    assert.equal(spawned.status, 201, `cookie spawns: ${await spawned.text()}`);
    const deadline = Date.now() + 5_000;
    while (!existsSync(ok) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    assert.ok(existsSync(ok), 'the authenticated command ran');
    const wrong = cookie.replace(/=.*/, '=nope');
    assert.equal((await fetch(`${base}/api/pty`, { headers: { cookie: wrong } })).status, 401, 'a wrong cookie is refused');
    const otherPort = `ach_web_token_${port + 1}=${encodeURIComponent(token)}`;
    assert.equal((await fetch(`${base}/api/pty`, { headers: { cookie: otherPort } })).status, 401, "another port's cookie does not count");
  });

  it('a restart reuses the stored token (bookmarks survive)', async () => {
    await stop(child);
    const again = await achWeb(state);
    child = again.child;
    assert.equal(again.url.searchParams.get('token'), token);
    assert.match(again.err(), /using the token in/);
  });
});

describe('explicit tokens win; an empty one is unset', { skip: isBun ? false : 'bun not on PATH' }, () => {
  it('--token T is used and no token file is written', async () => {
    const state = tmp('explicit');
    const w = await achWeb(state, ['--token', 'explicit-token-123456']);
    await stop(w.child);
    assert.equal(w.url.searchParams.get('token'), 'explicit-token-123456');
    assert.equal(existsSync(join(state, 'web', 'token')), false);
  });

  it('`--token "" --host 0.0.0.0` generates a token and still forces loopback', async () => {
    const state = tmp('empty');
    const w = await achWeb(state, ['--token', '', '--host', '0.0.0.0']);
    await stop(w.child);
    assert.equal(w.url.hostname, '127.0.0.1', w.err());
    assert.equal(w.url.searchParams.get('token'), readFileSync(join(state, 'web', 'token'), 'utf8').trim());
  });
});

describe('a server embedded without a token fails closed', () => {
  let srv: WebServerHandle;
  let base = '';
  before(async () => {
    srv = await startWebServer({ port: 0, host: '127.0.0.1', stateDir: tmp('embedded'), token: '' });
    base = `http://127.0.0.1:${srv.port}`;
  });
  after(async () => srv.close());

  it('privileged routes are 403; ?token= (empty) unlocks nothing', async () => {
    for (const p of ['/api/desks/send', '/api/desks/up', '/api/desks/down', '/api/desks/lanes', '/api/desks/lanes/x/stop', '/api/desks/decisions/x/answer', '/api/desks/pending/x/approve', '/api/desks/pending/x/reject', '/api/desks/x/engine', '/api/pty', '/api/pty?token=', '/api/live/x/continue']) {
      const res = await fetch(base + p, { method: 'POST', headers: json, body: '{}' });
      assert.equal(res.status, 403, `POST ${p} must be 403, got ${res.status}`);
    }
    assert.equal(await upgrade(srv.port, `/ws/pty/${encodeURIComponent('run:x')}`), 403, 'live-run PTY input');
  });

  it('control: reads still answer 200', async () => {
    for (const p of ['/api/desks', '/api/desks/messages', '/api/desks/decisions', '/api/desks/costs', '/api/live', '/']) {
      assert.equal((await fetch(base + p)).status, 200, `GET ${p}`);
    }
  });
});
