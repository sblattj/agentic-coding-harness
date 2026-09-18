import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { startWebServer, type WebServerHandle } from '../src/web/server.ts';

// ---------------------------------------------------------------------------
// /compare view + cross-page nav: served HTML only (the /api/compare rollup is
// a parallel workstream; this page is exercised as static markup + route
// wiring). The server runs in-process (node:http based) on an ephemeral port.
// ---------------------------------------------------------------------------

let handle: WebServerHandle;
let base: string;

before(async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'harness-compare-view-'));
  handle = await startWebServer({ port: 0, host: '127.0.0.1', token: 't', stateDir });
  base = `http://127.0.0.1:${handle.port}`;
});

after(async () => {
  await handle.close();
});

describe('compare view', () => {
  it('GET /compare (bearer) → 200 text/html with table scaffolding and the api rollup URL', async () => {
    const res = await fetch(`${base}/compare`, { headers: { authorization: 'Bearer t' } });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /^text\/html/);
    const body = await res.text();
    assert.ok(body.includes('id="expTable"'), 'expTable marker missing');
    assert.ok(body.includes('id="wfTable"'), 'wfTable marker missing');
    assert.ok(body.includes('/api/compare?by=experiment,variant'), 'exp rollup URL missing');
    assert.ok(body.includes('/api/compare?by=workflow,agent'), 'workflow rollup URL missing');
  });

  it('GET /compare without token behaves exactly like /grid without token', async () => {
    // Auth gate (src/web/server.ts): tokens gate the /ws family only; HTML
    // pages are served open — /compare must share that regime, not invent one.
    const cmp = await fetch(`${base}/compare`);
    const grid = await fetch(`${base}/grid`);
    assert.equal(cmp.status, grid.status);
    assert.equal(grid.status, 200);
  });

  it('grid, index and trio pages carry the nav marker data-nav="compare"', async () => {
    for (const path of ['/grid', '/', '/trio']) {
      const res = await fetch(base + path, { headers: { authorization: 'Bearer t' } });
      assert.equal(res.status, 200, path);
      const body = await res.text();
      assert.ok(body.includes('data-nav="compare"'), `${path} missing nav marker`);
    }
  });
});
