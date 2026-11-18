// A loopback bind other than 127.0.0.1 (e.g. 127.0.0.2) must accept its own Host.
import assert from 'node:assert/strict';
import type { IncomingMessage } from 'node:http';
import { hostname } from 'node:os';
import { describe, it } from 'node:test';
import { checkHostOrigin } from '../src/web/request-guard.ts';

const req = (host: string) => ({ headers: { host } }) as unknown as IncomingMessage;

describe('request guard on a 127.0.0.2 bind', () => {
  it('accepts Host equal to the bind address, with and without port', () => {
    assert.equal(checkHostOrigin(req('127.0.0.2:4000'), { host: '127.0.0.2', port: 4000 }), null);
    assert.equal(checkHostOrigin(req('127.0.0.2'), { host: '127.0.0.2', port: 80 }), null);
    assert.equal(checkHostOrigin(req('localhost:4000'), { host: '127.0.0.2', port: 4000 }), null);
  });
  it('still rejects rebinding names, other 127/8 hosts, and wrong ports', () => {
    assert.equal(checkHostOrigin(req('evil.example:4000'), { host: '127.0.0.2', port: 4000 })?.status, 421);
    assert.equal(checkHostOrigin(req('127.0.0.3:4000'), { host: '127.0.0.2', port: 4000 })?.status, 421);
    assert.equal(checkHostOrigin(req('127.0.0.2:9'), { host: '127.0.0.2', port: 4000 })?.status, 421);
    assert.equal(checkHostOrigin(req('127.0.0.2:4000'), { host: '127.0.0.1', port: 4000 })?.status, 421);
  });
});

// A non-loopback bind (0.0.0.0, a LAN IP, a hostname) must check Host too: rebinding needs
// an attacker DNS name, so IP literals, localhost, the bind name and this machine's
// hostname pass on any port, and any other name is 421.
describe('request guard on a non-loopback bind', () => {
  const me = hostname().trim().toLowerCase();
  const short = me.split('.')[0]!;
  it('accepts the bind IP and other IP literals, with and without port', () => {
    assert.equal(checkHostOrigin(req('192.168.1.20:8399'), { host: '192.168.1.20', port: 8399 }), null);
    assert.equal(checkHostOrigin(req('192.168.1.20'), { host: '192.168.1.20', port: 8399 }), null);
    assert.equal(checkHostOrigin(req('192.168.1.20:8080'), { host: '0.0.0.0', port: 8399 }), null, 'port forward');
    assert.equal(checkHostOrigin(req('127.0.0.1:8399'), { host: '0.0.0.0', port: 8399 }), null);
    assert.equal(checkHostOrigin(req('[fe80::1]:8399'), { host: '::', port: 8399 }), null);
  });
  it('accepts localhost, the bind hostname and this machine hostname (full, short, .local)', () => {
    assert.equal(checkHostOrigin(req('localhost:8399'), { host: '0.0.0.0', port: 8399 }), null);
    assert.equal(checkHostOrigin(req('ach-box.lan:8399'), { host: 'ach-box.lan', port: 8399 }), null);
    for (const n of [me, short, `${short}.local`]) {
      assert.equal(checkHostOrigin(req(`${n}:8399`), { host: '0.0.0.0', port: 8399 }), null, n);
      assert.equal(checkHostOrigin(req(n.toUpperCase()), { host: '0.0.0.0', port: 8399 }), null, `${n} uppercase, no port`);
    }
  });
  it('rejects an attacker hostname, a missing Host, and a name that is only the bind of another server', () => {
    for (const bindHost of ['0.0.0.0', '192.168.1.20', '::', 'ach-box.lan']) {
      assert.equal(checkHostOrigin(req('evil.example:8399'), { host: bindHost, port: 8399 })?.status, 421, `evil.example on ${bindHost}`);
      assert.equal(checkHostOrigin(req('evil.example'), { host: bindHost, port: 8399 })?.status, 421);
      assert.equal(checkHostOrigin(req(''), { host: bindHost, port: 8399 })?.status, 421, `empty Host on ${bindHost}`);
      assert.equal(checkHostOrigin(req(`${short}.evil.example:8399`), { host: bindHost, port: 8399 })?.status, 421, 'hostname as a subdomain of an attacker domain');
    }
    assert.equal(checkHostOrigin(req('other-box.lan:8399'), { host: 'ach-box.lan', port: 8399 })?.status, 421);
  });
  it('still applies the Origin check after Host passes', () => {
    const r = { headers: { host: '192.168.1.20:8399', origin: 'http://evil.example' } } as unknown as IncomingMessage;
    assert.equal(checkHostOrigin(r, { host: '0.0.0.0', port: 8399 })?.status, 403);
  });
});

describe('request guard with AGENTIC_CODING_HARNESS_WEB_ALLOWED_HOSTS', () => {
  const KEY = 'AGENTIC_CODING_HARNESS_WEB_ALLOWED_HOSTS';
  it('accepts a listed name on loopback and non-loopback binds, any port, and still rejects others', () => {
    const before = process.env[KEY];
    process.env[KEY] = ' Mac.Tailnet.ts.net. , router.lan';
    try {
      assert.equal(checkHostOrigin(req('mac.tailnet.ts.net'), { host: '127.0.0.1', port: 4000 }), null);
      assert.equal(checkHostOrigin(req('router.lan:8443'), { host: '0.0.0.0', port: 4000 }), null);
      assert.equal(checkHostOrigin(req('evil.example:4000'), { host: '0.0.0.0', port: 4000 })?.status, 421);
      assert.equal(checkHostOrigin(req('evil.example:4000'), { host: '127.0.0.1', port: 4000 })?.status, 421);
    } finally {
      if (before === undefined) delete process.env[KEY];
      else process.env[KEY] = before;
    }
    assert.equal(checkHostOrigin(req('router.lan:4000'), { host: '0.0.0.0', port: 4000 })?.status, 421, 'unlisted again once the env is gone');
  });
});
