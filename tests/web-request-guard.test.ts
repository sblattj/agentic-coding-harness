// `ach web` request guard: cross-site and DNS-rebinding requests are refused on every
// route (plain HTTP and WebSocket upgrades), non-GET /api/* writes must be JSON, and
// /api/pty sits behind the token like the other API routes, and with no token it and every
// desks write fail closed (403). A native client (the macOS
// app: no Origin, Host 127.0.0.1:<port>, JSON bodies) keeps working.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { startWebServer, type WebServerHandle } from '../src/web/server.ts';

const dirs: string[] = [];
function tmp(tag: string): string {
  const d = mkdtempSync(join(tmpdir(), `ach-web-guard-${tag}-`));
  dirs.push(d);
  return d;
}
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function raw(port: number, method: string, path: string, headers: Record<string, string>, body?: string): Promise<{ status: number; text: string; upgraded: boolean }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => (text += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, text, upgraded: false }));
    });
    req.on('upgrade', (res, socket) => {
      socket.destroy();
      resolve({ status: res.statusCode ?? 0, text: '', upgraded: true });
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

const wsHeaders = { connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-version': '13', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==' };

describe('ach web request guard (no token, the default)', () => {
  let srv: WebServerHandle;
  before(async () => {
    srv = await startWebServer({ port: 0, host: '127.0.0.1', stateDir: tmp('open') });
  });
  after(async () => srv.close());

  it('a cross-origin text/plain POST /api/desks/lanes is refused before it reaches the service', async () => {
    const r = await raw(srv.port, 'POST', '/api/desks/lanes', { 'content-type': 'text/plain', origin: 'http://evil.example' }, '{}');
    assert.equal(r.status, 403, `cross-origin text/plain POST must be 403, got ${r.status} ${r.text}`);
  });

  it('a text/plain POST with no Origin is 415', async () => {
    const r = await raw(srv.port, 'POST', '/api/desks/lanes', { 'content-type': 'text/plain' }, '{}');
    assert.equal(r.status, 415, `text/plain POST must be 415, got ${r.status} ${r.text}`);
    const none = await raw(srv.port, 'POST', '/api/desks/lanes', {}, '{}');
    assert.equal(none.status, 415, 'a body with no content-type is 415');
  });

  it('a foreign Host is refused (DNS rebinding), on pages and the API', async () => {
    for (const host of ['evil.example', `evil.example:${srv.port}`, `127.0.0.1:${srv.port + 1}`]) {
      assert.equal((await raw(srv.port, 'GET', '/api/desks', { host })).status, 421, `GET /api/desks Host ${host}`);
      assert.equal((await raw(srv.port, 'GET', '/', { host })).status, 421, `GET / Host ${host}`);
    }
    for (const host of [`127.0.0.1:${srv.port}`, `localhost:${srv.port}`, `[::1]:${srv.port}`]) {
      assert.notEqual((await raw(srv.port, 'GET', '/health', { host })).status, 421, `Host ${host} is loopback`);
    }
  });

  it('a same-origin JSON POST passes the guard, then fails closed with no token (#212 review)', async () => {
    const r = await raw(srv.port, 'POST', '/api/desks/lanes', { 'content-type': 'application/json' }, '{}');
    assert.equal(r.status, 403, `tokenless desks write is refused: ${r.text}`);
    assert.match(r.text, /needs a token/);
    const kill = await raw(srv.port, 'POST', '/api/pty/no-such-session/kill', {});
    assert.equal(kill.status, 403, `tokenless /api/pty is refused: ${kill.text}`);
  });

  it('a cross-origin WebSocket upgrade is refused; a same-origin one upgrades', async () => {
    const bad = await raw(srv.port, 'GET', '/ws?runs=1', { ...wsHeaders, origin: 'http://evil.example' });
    assert.equal(bad.upgraded, false, 'cross-origin upgrade must not be accepted');
    assert.equal(bad.status, 403);
    const badHost = await raw(srv.port, 'GET', '/ws?runs=1', { ...wsHeaders, host: 'evil.example' });
    assert.equal(badHost.upgraded, false, 'foreign-Host upgrade must not be accepted');
    const good = await raw(srv.port, 'GET', '/ws?runs=1', { ...wsHeaders, origin: `http://127.0.0.1:${srv.port}` });
    assert.equal(good.upgraded, true, 'same-origin upgrade works');
  });
});

describe('ach web request guard: /api/pty behind the token', () => {
  let srv: WebServerHandle;
  before(async () => {
    srv = await startWebServer({ port: 0, host: '127.0.0.1', stateDir: tmp('tok'), token: 'tok' });
  });
  after(async () => srv.close());

  it('a same-origin JSON POST with no Origin (the macOS app) still reaches the route', async () => {
    const r = await raw(srv.port, 'POST', '/api/desks/lanes', { 'content-type': 'application/json', authorization: 'Bearer tok' }, '{}');
    assert.equal(r.status, 400, `reaches body validation: ${r.text}`);
    assert.match(r.text, /must be a non-empty string/);
    const same = await raw(srv.port, 'POST', '/api/desks/lanes', { 'content-type': 'application/json', authorization: 'Bearer tok', origin: `http://127.0.0.1:${srv.port}` }, '{}');
    assert.equal(same.status, 400, 'a same-origin browser POST reaches the route');
    const local = await raw(srv.port, 'POST', '/api/desks/lanes', { 'content-type': 'application/json', authorization: 'Bearer tok', host: `localhost:${srv.port}`, origin: `http://localhost:${srv.port}` }, '{}');
    assert.equal(local.status, 400, 'localhost origin on localhost host is same-origin');
  });

  it('a bodyless POST (the grid kill/continue buttons) needs no content-type', async () => {
    const r = await raw(srv.port, 'POST', '/api/pty/no-such-session/kill', { authorization: 'Bearer tok' });
    assert.equal(r.status, 404, `bodyless POST reaches the route: ${r.text}`);
  });

  it('POST and GET /api/pty and kill need the token when one is set', async () => {
    const post = await raw(srv.port, 'POST', '/api/pty', { 'content-type': 'application/json' }, '{}');
    assert.equal(post.status, 401, `POST /api/pty without the token must be 401, got ${post.status} ${post.text}`);
    assert.equal((await raw(srv.port, 'GET', '/api/pty', {})).status, 401, 'GET /api/pty without the token');
    assert.equal((await raw(srv.port, 'POST', '/api/pty/x/kill', {})).status, 401, 'kill without the token');
    const ok = await raw(srv.port, 'POST', '/api/pty?token=tok', { 'content-type': 'application/json' }, '{}');
    assert.equal(ok.status, 400, 'with the token the request reaches validation');
    const bearer = await raw(srv.port, 'GET', '/api/pty', { authorization: 'Bearer tok' });
    assert.equal(bearer.status, 200, 'Bearer works too');
  });
});
