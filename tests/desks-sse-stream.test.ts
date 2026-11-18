import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { request, ServerResponse, type ClientRequest, type IncomingMessage } from 'node:http';
import { createServer as createNetServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { EchoEngine, nullMeter, runHost } from '../src/desks/host.ts';
import { hostHealth, hostRecord, hostStop, hostSubscribe } from '../src/desks/host-client.ts';
import type { HostEvent, HostSpec } from '../src/desks/types.ts';

const TOKEN = 'e'.repeat(64);
const dirs: string[] = [];
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn: () => boolean | Promise<boolean>, what: string, ms = 8000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await fn())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(20);
  }
}

async function startHost(): Promise<{ url: string; done: Promise<number> }> {
  const stateDir = mkdtempSync(join(tmpdir(), 'desks-sse-'));
  dirs.push(stateDir);
  const spec: HostSpec = {
    stack: 'test',
    stateDir,
    name: 'SSE',
    kind: 'desk',
    role: 'orchestrator',
    roleFiles: [],
    agent: 'claude',
    engine: 'driver',
    mcps: [],
    port: 0,
    cwd: stateDir,
    runId: 'run_sse_1',
    token: TOKEN,
  };
  let url = '';
  const done = runHost(spec, {
    createEngine: async () => new EchoEngine(),
    createHostMeter: () => nullMeter(),
    installSignals: false,
    onReady: (i) => (url = i.url),
  });
  await waitFor(async () => (url !== '' ? (await hostHealth(url))?.state === 'idle' : false), 'host idle');
  return { url, done };
}

/** A raw GET /events stream: collects the body text as it arrives. */
function openEvents(url: string): Promise<{ req: ClientRequest; res: IncomingMessage; body: () => string }> {
  return new Promise((resolve, reject) => {
    const u = new URL('/events?since=0', url);
    let text = '';
    const req = request(
      { host: u.hostname, port: u.port, path: `${u.pathname}${u.search}`, headers: { accept: 'text/event-stream', authorization: `Bearer ${TOKEN}` } },
      (res) => {
        res.setEncoding('utf8');
        res.on('data', (c: string) => (text += c));
        res.on('error', () => {});
        resolve({ req, res, body: () => text });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

describe('desk host SSE lifetime', () => {
  it('keeps an /events subscriber long after the GET request ends, and drops it when the client disconnects', async () => {
    const h = await startHost();
    // Count server-side writes of our marker events, so a dropped client that is still in the
    // subscriber set would show up as a write to its dead response.
    const realWrite = ServerResponse.prototype.write;
    let markerWrites = 0;
    ServerResponse.prototype.write = function (this: ServerResponse, chunk: unknown, ...rest: unknown[]) {
      if (typeof chunk === 'string' && chunk.includes('sse-marker')) markerWrites++;
      return (realWrite as (...a: unknown[]) => boolean).call(this, chunk, ...rest);
    } as typeof realWrite;
    try {
      const s = await openEvents(h.url);
      assert.equal(s.res.statusCode, 200);
      // The GET request has no body and is long finished; wait well past it.
      await sleep(1500);
      await hostRecord({ url: h.url, token: TOKEN }, 'feed', { text: 'sse-marker-1' });
      await waitFor(() => s.body().includes('sse-marker-1'), 'event delivered after the request ended', 3000);
      assert.equal(markerWrites, 1, 'one live subscriber received the first marker');

      const closed = new Promise<void>((r) => s.res.once('close', () => r()));
      s.req.destroy();
      await closed;
      await sleep(300); // let the server see the disconnect
      markerWrites = 0;
      await hostRecord({ url: h.url, token: TOKEN }, 'feed', { text: 'sse-marker-2' });
      await sleep(100);
      assert.equal(markerWrites, 0, 'the disconnected subscriber was removed from the fan-out set');
    } finally {
      ServerResponse.prototype.write = realWrite;
      await hostStop({ url: h.url, token: TOKEN });
      await h.done;
    }
  });
});

describe('hostSubscribe CRLF framing across chunks', () => {
  it('parses CRLF-delimited events when a chunk ends between the \\r and \\n of the blank line', async () => {
    const ev = (seq: number): HostEvent => ({ seq, at: seq, runId: 'r', name: 'A', type: 'text', data: { text: `t${seq}` } });
    const sockets = new Set<Socket>();
    // Raw TCP so each write really lands as its own chunk (setNoDelay + a pause between writes).
    const server = createNetServer((sock) => {
      sockets.add(sock);
      sock.setNoDelay(true);
      sock.on('error', () => {});
      sock.once('data', async () => {
        sock.write('HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\nconnection: close\r\n\r\n');
        const parts = [
          `: hello\r\n\r\ndata: ${JSON.stringify(ev(1))}\r\n\r`,
          `\ndata: ${JSON.stringify(ev(2))}\r\n\r`,
          `\ndata: ${JSON.stringify(ev(3))}\r`,
          `\n\r`,
          `\n`,
        ];
        for (const p of parts) {
          await sleep(60);
          sock.write(p);
        }
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const port = (server.address() as { port: number }).port;
    const got: number[] = [];
    const unsub = hostSubscribe(`http://127.0.0.1:${port}`, 0, (e) => got.push(e.seq));
    try {
      await waitFor(() => got.length >= 3, 'three events', 3000).catch(() => {});
      assert.deepEqual(got, [1, 2, 3]);
    } finally {
      unsub();
      for (const s of sockets) s.destroy();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
