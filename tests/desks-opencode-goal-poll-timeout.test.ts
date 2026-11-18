import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, it } from 'node:test';
import { setOpencodeGoal } from '../src/desks/engines/opencode-goals.ts';

async function serve(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<{ url: string; server: Server }> {
  const server = createServer((req, res) => {
    req.resume();
    req.on('end', () => handler(req, res));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, server };
}
const close = (s: Server) => new Promise<void>((r) => { s.closeAllConnections(); s.close(() => r()); });

/** Race p against a guard timer; 'hung' means p was still pending after ms. */
async function settleWithin(p: Promise<unknown>, ms: number): Promise<{ outcome: 'resolved' | 'rejected' | 'hung'; error?: unknown }> {
  let timer: NodeJS.Timeout | undefined;
  const guard = new Promise<{ outcome: 'hung' }>((r) => (timer = setTimeout(() => r({ outcome: 'hung' }), ms)));
  try {
    return await Promise.race([
      p.then(() => ({ outcome: 'resolved' as const }), (error: unknown) => ({ outcome: 'rejected' as const, error })),
      guard,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

describe('setOpencodeGoal poll timeout', () => {
  it('a message poll that never answers still rejects at timeoutMs', async () => {
    let gets = 0;
    const { url, server } = await serve((req, res) => {
      if (req.method === 'POST') return; // the goal command blocks, like opencode
      gets++;
      if (gets === 1) { res.end('[]'); return; } // baseline answers
      // every later poll stalls: no headers, no body
    });
    try {
      const t0 = Date.now();
      const r = await settleWithin(setOpencodeGoal({ baseUrl: url, sessionId: 's', objective: 'x', timeoutMs: 200, pollMs: 20 }), 3000);
      const elapsed = Date.now() - t0;
      assert.equal(r.outcome, 'rejected', `setOpencodeGoal must settle by the deadline; got ${r.outcome} after ${elapsed} ms`);
      assert.match(String((r.error as Error).message), /not active after 200 ms/);
      assert.ok(elapsed < 1500, `rejected near timeoutMs, took ${elapsed} ms`);
    } finally { await close(server); }
  });

  it('a stalled baseline read rejects within timeoutMs instead of hanging', async () => {
    const { url, server } = await serve(() => { /* never answers anything */ });
    try {
      const r = await settleWithin(setOpencodeGoal({ baseUrl: url, sessionId: 's', objective: 'x', timeoutMs: 200, pollMs: 20 }), 3000);
      assert.equal(r.outcome, 'rejected', `got ${r.outcome}`);
      assert.match(String((r.error as Error).message), /cannot read the session messages before posting/);
    } finally { await close(server); }
  });
});
