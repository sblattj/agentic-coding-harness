// Desk host HTTP API trust checks: bearer token, Host and Origin guard, JSON-only writes.
// A web page can POST text/plain to 127.0.0.1:<port> without a CORS preflight, and DNS
// rebinding lets it read answers; the host must refuse both.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { bearerOk, EchoEngine, nullMeter, runHost } from '../src/desks/host.ts';
import { hostEvents, hostHealth, hostSend, hostStop } from '../src/desks/host-client.ts';
import type { HostSpec } from '../src/desks/types.ts';

const TOKEN = 'a'.repeat(64);
const dirs: string[] = [];
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function spec(stateDir: string, over: Partial<HostSpec> = {}): HostSpec {
  return {
    stack: 'auth', stateDir, name: 'ALPHA', kind: 'desk', role: 'orchestrator', roleFiles: [], agent: 'claude',
    engine: 'driver', mcps: [], port: 0, cwd: stateDir, runId: 'run_auth_1', token: TOKEN, ...over,
  };
}

interface Host { port: number; url: string; done: Promise<number> }

async function start(over: Partial<HostSpec> = {}): Promise<Host> {
  const stateDir = mkdtempSync(join(tmpdir(), 'ach-desks-host-auth-'));
  dirs.push(stateDir);
  let port = 0;
  const done = runHost(spec(stateDir, over), {
    createEngine: async () => new EchoEngine(1),
    createHostMeter: () => nullMeter(),
    installSignals: false,
    onReady: (i) => (port = i.port),
  });
  const deadline = Date.now() + 5000;
  for (;;) {
    if (port !== 0 && (await hostHealth(`http://127.0.0.1:${port}`))?.state === 'idle') break;
    if (Date.now() > deadline) throw new Error('host never became idle');
    await new Promise((r) => setTimeout(r, 15));
  }
  return { port, url: `http://127.0.0.1:${port}`, done };
}

/** Raw request so the test controls Host and Origin (fetch forbids setting Host). */
function raw(port: number, method: string, path: string, headers: Record<string, string>, body?: string): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => (text += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, text }));
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

const json = { 'content-type': 'application/json' };
const auth = { authorization: `Bearer ${TOKEN}` };
const sendBody = JSON.stringify({ from: 'human', text: 'hi' });

describe('desk host: auth', () => {
  it('401 without the bearer token or with a wrong one; the right token is accepted', async () => {
    const h = await start();
    try {
      const none = await raw(h.port, 'POST', '/send', json, sendBody);
      assert.equal(none.status, 401, 'POST /send without a token must be 401');
      const wrong = await raw(h.port, 'POST', '/send', { ...json, authorization: `Bearer ${'b'.repeat(64)}` }, sendBody);
      assert.equal(wrong.status, 401, 'wrong token must be 401');
      const short = await raw(h.port, 'POST', '/send', { ...json, authorization: 'Bearer x' }, sendBody);
      assert.equal(short.status, 401, 'a token of another length must be 401');
      for (const path of ['/events', '/goal', '/attach', '/mcp']) {
        assert.equal((await raw(h.port, 'GET', path, {})).status, 401, `GET ${path} without a token must be 401`);
      }
      assert.equal((await raw(h.port, 'POST', '/stop', json, '{}')).status, 401, 'POST /stop without a token must be 401');
      const ok = await raw(h.port, 'POST', '/send', { ...json, ...auth }, sendBody);
      assert.equal(ok.status, 200, `the right token is accepted: ${ok.text}`);
      assert.equal((await raw(h.port, 'GET', '/health', {})).status, 200, 'GET /health needs no token');
      const target = { url: h.url, token: TOKEN };
      assert.equal(typeof (await hostSend(target, 'human', 'via client')).id, 'string');
      assert.ok((await hostEvents(target)).some((e) => e.type === 'message_in'), 'host-client passes the token');
      await assert.rejects(hostEvents(h.url), /HTTP 401/, 'host-client without a token is refused');
    } finally {
      await hostStop({ url: h.url, token: TOKEN });
      assert.equal(await h.done, 0);
    }
  });

  it('a spec without a token refuses every bearer (fail closed)', () => {
    assert.equal(bearerOk(undefined, undefined), false);
    assert.equal(bearerOk('Bearer ', undefined), false);
    assert.equal(bearerOk('Bearer undefined', undefined), false);
    assert.equal(bearerOk('Bearer ', ''), false);
    assert.equal(bearerOk(`Bearer ${TOKEN}`, TOKEN), true);
    assert.equal(bearerOk(`bearer ${TOKEN}`, TOKEN), true, 'the scheme is case-insensitive');
    assert.equal(bearerOk(TOKEN, TOKEN), false, 'the scheme is required');
  });

  it('wrong Host is refused on every route, /health included (DNS rebinding)', async () => {
    const h = await start();
    try {
      for (const host of ['evil.example', `evil.example:${h.port}`, `127.0.0.1:${h.port + 1}`, '127.0.0.1']) {
        const r = await raw(h.port, 'GET', '/health', { host });
        assert.equal(r.status, 421, `GET /health with Host ${host} must be 421`);
        const s = await raw(h.port, 'POST', '/send', { ...json, ...auth, host }, sendBody);
        assert.equal(s.status, 421, `POST /send with Host ${host} must be 421`);
      }
      assert.equal((await raw(h.port, 'GET', '/health', { host: `localhost:${h.port}` })).status, 200, 'localhost:<port> is fine');
    } finally {
      await hostStop({ url: h.url, token: TOKEN });
      await h.done;
    }
  });

  it('a foreign Origin is refused even with the token; a same-origin one passes', async () => {
    const h = await start();
    try {
      for (const origin of ['http://evil.example', 'null', `http://127.0.0.1:${h.port + 1}`, `https://127.0.0.1:${h.port}`]) {
        const r = await raw(h.port, 'POST', '/send', { ...json, ...auth, origin }, sendBody);
        assert.equal(r.status, 403, `Origin ${origin} must be 403`);
        assert.equal((await raw(h.port, 'GET', '/health', { origin })).status, 403, `GET /health with Origin ${origin} must be 403`);
      }
      const same = await raw(h.port, 'POST', '/send', { ...json, ...auth, origin: `http://127.0.0.1:${h.port}` }, sendBody);
      assert.equal(same.status, 200);
    } finally {
      await hostStop({ url: h.url, token: TOKEN });
      await h.done;
    }
  });

  it('a non-JSON POST is 415, even with the token', async () => {
    const h = await start();
    try {
      const r = await raw(h.port, 'POST', '/send', { ...auth, 'content-type': 'text/plain' }, sendBody);
      assert.equal(r.status, 415, 'text/plain POST must be 415');
      const none = await raw(h.port, 'POST', '/stop', { ...auth });
      assert.equal(none.status, 415, 'a POST with no content-type must be 415');
      const cs = await raw(h.port, 'POST', '/send', { ...auth, 'content-type': 'application/json; charset=utf-8' }, sendBody);
      assert.equal(cs.status, 200, 'a charset parameter is fine');
    } finally {
      await hostStop({ url: h.url, token: TOKEN });
      await h.done;
    }
  });
});
