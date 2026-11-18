// A loopback bind other than 127.0.0.1 (e.g. 127.0.0.2) must accept its own Host.
import assert from 'node:assert/strict';
import type { IncomingMessage } from 'node:http';
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
