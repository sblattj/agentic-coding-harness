import assert from 'node:assert/strict';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { describe, it } from 'node:test';
import { hostEvents, hostHealth, hostSend, hostSetGoal, hostStop, hostSubscribe } from '../src/desks/host-client.ts';
import type { HostEvent } from '../src/desks/types.ts';

async function listen(handler: (url: URL, res: ServerResponse, method: string) => void): Promise<{ server: Server; url: string; close: () => Promise<void> }> {
  const server = createServer((req, res) => handler(new URL(req.url ?? '/', 'http://x'), res, req.method ?? 'GET'));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as { port: number }).port;
  return {
    server,
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((r) => {
        server.close(() => r());
        server.closeAllConnections();
      }),
  };
}

const ev = (seq: number): HostEvent => ({ seq, at: seq, runId: 'r', name: 'A', type: 'text', data: { text: `t${seq}` } });

async function waitFor(fn: () => boolean, what: string, ms = 8000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe('desks host-client', () => {
  it('hostHealth returns null on connection refused and on timeout', async () => {
    const s = await listen(() => {});
    const url = s.url;
    await s.close();
    assert.equal(await hostHealth(url, 500), null, 'refused');
    const hang = await listen(() => {
      /* never answers */
    });
    try {
      const t0 = Date.now();
      assert.equal(await hostHealth(hang.url, 300), null, 'timeout');
      assert.ok(Date.now() - t0 < 3000);
    } finally {
      await hang.close();
    }
  });

  it('errors include the URL and status/body; trailing slash tolerated', async () => {
    const s = await listen((u, res) => {
      if (u.pathname === '/send') {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end('{"error":"text must be a non-empty string"}');
      } else {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(u.pathname === '/events' ? JSON.stringify({ events: [ev(Number(u.searchParams.get('since')) + 1)] }) : '{}');
      }
    });
    try {
      await assert.rejects(hostSend(`${s.url}/`, 'human', ''), (e: Error) => {
        assert.ok(e.message.includes(`${s.url}/send`), e.message);
        assert.ok(e.message.includes('HTTP 400'), e.message);
        assert.ok(e.message.includes('non-empty string'), e.message);
        return true;
      });
      assert.deepEqual((await hostEvents(s.url, 7)).map((e) => e.seq), [8]);
      await hostStop(s.url);
      await hostSetGoal(s.url, 'x');
    } finally {
      await s.close();
    }
  });

  it('hostSubscribe parses chunked SSE, ignores comments, reconnects with since=lastSeq and dedupes', async () => {
    const sinces: number[] = [];
    let conn = 0;
    const s = await listen((u, res) => {
      if (u.pathname !== '/events') {
        res.writeHead(404);
        res.end();
        return;
      }
      sinces.push(Number(u.searchParams.get('since')));
      conn++;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      if (conn === 1) {
        // split one event across two writes, plus a comment
        const line = `data: ${JSON.stringify(ev(3))}\n\n`;
        res.write(': keep-alive\n\n');
        res.write(line.slice(0, 10));
        setTimeout(() => {
          res.write(line.slice(10));
          res.write(`data: ${JSON.stringify(ev(4))}\n\n`);
          res.end(); // drop the stream -> client reconnects
        }, 30);
      } else {
        // server replays an already-seen event; client must drop it
        res.write(`data: ${JSON.stringify(ev(4))}\n\n`);
        res.write(`data: ${JSON.stringify(ev(5))}\n\n`);
      }
    });
    const got: number[] = [];
    const unsub = hostSubscribe(s.url, 2, (e) => got.push(e.seq));
    try {
      await waitFor(() => got.includes(5), 'event 5 after reconnect');
      assert.deepEqual(got, [3, 4, 5]);
      assert.deepEqual(sinces.slice(0, 2), [2, 4]);
    } finally {
      unsub();
      await s.close();
    }
  });

  it('unsubscribe during backoff cancels the reconnect', async () => {
    let conns = 0;
    const s = await listen((_u, res) => {
      conns++;
      res.writeHead(500);
      res.end();
    });
    const unsub = hostSubscribe(s.url, 0, () => {});
    try {
      await waitFor(() => conns === 1, 'first connect');
      unsub();
      await new Promise((r) => setTimeout(r, 1300));
      assert.equal(conns, 1, 'no reconnect after unsubscribe');
    } finally {
      await s.close();
    }
  });
});
