import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { describe, it } from 'node:test';
import { WebSocketServer } from 'ws';
import { type RunRecord } from '../src/core/registry.ts';
import { type RunSource, type SourceHealth } from '../src/web/run-source.ts';
import { HttpRunSource, ingestFeedPayload } from '../src/web/run-source-http.ts';
import { MergedRunSource } from '../src/web/run-source-merged.ts';

// ---------------------------------------------------------------------------
// HttpRunSource / MergedRunSource (spec §5.2/§5.3): the dashboard as a
// client of an external feed. A node:http stub on an ephemeral port plays
// the feed; ingestFeedPayload is unit-tested directly for the drop rules.
// ---------------------------------------------------------------------------

const T0 = 1_700_000_000_000;

function extRec(over: Partial<RunRecord> = {}): RunRecord {
  return {
    runId: 'ext-1',
    agent: 'claude',
    startedAt: T0,
    endedAt: T0 + 60_000,
    totals: { inputTokens: 4037, outputTokens: 75, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 },
    source: 'external',
    experiment: 'exp-a',
    variant: 'control',
    ...over,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface Stub {
  url: string;
  close(): Promise<void>;
}

function startStub(handler: http.RequestListener): Promise<Stub> {
  const server = http.createServer(handler);
  const sockets = new Set<net.Socket>();
  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as net.AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () =>
          new Promise<void>((done) => {
            for (const s of sockets) s.destroy();
            server.close(() => done());
          }),
      });
    });
  });
}

function firstChange(src: RunSource, timeoutMs = 4000): Promise<RunRecord[]> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out waiting for onChange')), timeoutMs);
    void src.start((records) => {
      clearTimeout(timer);
      resolve(records);
    });
  });
}

async function waitFor(cond: () => boolean, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for condition');
    await sleep(10);
  }
}

function captureStderr(): { text(): string; restore(): void } {
  const chunks: string[] = [];
  const orig = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array) => {
    chunks.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  return {
    text: () => chunks.join(''),
    restore: () => {
      process.stderr.write = orig;
    },
  };
}

describe('ingestFeedPayload', () => {
  it('passes valid records through with the source default filled', () => {
    const out = ingestFeedPayload({ records: [{ runId: 'a', agent: 'claude', startedAt: T0 }] });
    assert.equal(out.skipped, 0);
    assert.equal(out.reason, undefined);
    assert.deepEqual(out.records, [{ runId: 'a', agent: 'claude', startedAt: T0, source: 'local' }]);
  });

  it('counts one invalid record and reports the first failure reason', () => {
    const out = ingestFeedPayload({
      records: [{ runId: 'a', agent: 'claude', startedAt: T0 }, { junk: true }],
    });
    assert.equal(out.records.length, 1);
    assert.equal(out.skipped, 1);
    assert.ok(out.reason);
  });

  it('rejects payloads that are not { records: [...] } with skipped 0', () => {
    for (const bad of [null, 'nope', 42, {}, { records: 'x' }, []]) {
      assert.deepEqual(ingestFeedPayload(bad), {
        records: [],
        skipped: 0,
        reason: 'feed payload is not { records: [...] }',
      });
    }
  });
});

describe('HttpRunSource (poll)', () => {
  it('snapshot() is [] and health() ok before the first fetch', () => {
    const src = new HttpRunSource({ url: 'http://127.0.0.1:1' });
    assert.deepEqual(src.snapshot(), []);
    assert.deepEqual(src.health(), { healthy: true });
  });

  it('fetches /runs with bearer header, upserts both records, stays healthy', async (t) => {
    const auth: (string | undefined)[] = [];
    const stub = await startStub((req, res) => {
      auth.push(req.headers.authorization);
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          records: [extRec({ runId: 'ext-1' }), extRec({ runId: 'ext-2', startedAt: T0 + 1000 })],
        }),
      );
    });
    const src = new HttpRunSource({ url: `${stub.url}/`, token: 'sekrit', pollMs: 100 }); // trailing slash is stripped
    t.after(() => Promise.all([src.stop(), stub.close()]));
    const got = await firstChange(src);
    assert.equal(got.length, 2);
    assert.deepEqual(new Set(src.snapshot().map((r) => r.runId)), new Set(['ext-1', 'ext-2']));
    assert.ok(auth.includes('Bearer sekrit'));
    assert.deepEqual(src.health(), { healthy: true });
  });

  it('drops invalid records with one counted warning per poll; none when clean', async (t) => {
    const valid = extRec({ runId: 'ext-1' });
    let serveBad = true;
    const stub = await startStub((_req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(serveBad ? { records: [valid, { junk: true }] } : { records: [valid] }));
    });
    const cap = captureStderr();
    t.after(() => cap.restore());
    const src = new HttpRunSource({ url: stub.url, pollMs: 100 });
    t.after(() => Promise.all([src.stop(), stub.close()]));
    const calls: RunRecord[][] = [];
    await new Promise<void>((resolve) => {
      void src.start((records) => {
        calls.push(records);
        resolve();
      });
    });
    serveBad = false;
    await sleep(400); // several clean polls
    const warnings = cap.text().split('\n').filter((l) => l.startsWith('web: source:'));
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /^web: source: skipped 1 record\(s\): /);
    for (const delivered of calls) {
      assert.equal(delivered.length, 1);
      assert.equal(delivered[0].runId, 'ext-1');
    }
    assert.deepEqual(src.health(), { healthy: true });
  });

  it('upserts by runId and never removes on delta snapshots', async (t) => {
    let n = 0;
    const stub = await startStub((_req, res) => {
      n++;
      const records = n === 1 ? [extRec({ runId: 'ext-1' })] : [extRec({ runId: 'ext-2', startedAt: T0 + 1 })];
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ records }));
    });
    const src = new HttpRunSource({ url: stub.url, pollMs: 100 });
    t.after(() => Promise.all([src.stop(), stub.close()]));
    await firstChange(src);
    await waitFor(() => src.snapshot().some((r) => r.runId === 'ext-2'));
    assert.deepEqual(src.snapshot().map((r) => r.runId).sort(), ['ext-1', 'ext-2']);
  });

  it('stop() freezes onChange even as the feed keeps changing', async (t) => {
    let seq = 0;
    const stub = await startStub((_req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ records: [extRec({ runId: `ext-${++seq}` })] }));
    });
    const src = new HttpRunSource({ url: stub.url, pollMs: 60 });
    t.after(() => Promise.all([src.stop(), stub.close()]));
    let calls = 0;
    await new Promise<void>((resolve) => {
      void src.start(() => {
        calls++;
        resolve();
      });
    });
    await src.stop();
    await src.stop(); // idempotent
    const frozen = calls;
    await sleep(300);
    assert.equal(calls, frozen);
  });
});

describe('HttpRunSource (sse)', () => {
  it('ingests event-stream payloads; connection loss marks unhealthy', async (t) => {
    const live: http.ServerResponse[] = [];
    const accepts: string[] = [];
    const payload = JSON.stringify({ records: [extRec({ runId: 'ext-sse' })] });
    const stub = await startStub((req, res) => {
      accepts.push(String(req.headers.accept));
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`event: runs\ndata: ${payload}\n\n`);
      live.push(res);
    });
    const src = new HttpRunSource({ url: stub.url, mode: 'sse', pollMs: 1000 });
    t.after(() => Promise.all([src.stop(), stub.close()]));
    const got = await firstChange(src);
    assert.deepEqual(got.map((r) => r.runId), ['ext-sse']);
    assert.equal(accepts[0], 'text/event-stream');
    assert.deepEqual(src.health(), { healthy: true });
    live[0].destroy(); // feed dies
    await waitFor(() => !src.health().healthy);
    assert.ok(src.health().detail);
  });
});

describe('HttpRunSource (ws)', () => {
  it('ingests {type:"runs"} frames over the WebSocket feed', async (t) => {
    const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    wss.on('connection', (ws) => {
      ws.send(JSON.stringify({ type: 'runs', records: [extRec({ runId: 'ext-ws' })] }));
    });
    const port = await new Promise<number>((resolve) => {
      wss.on('listening', () => resolve((wss.address() as net.AddressInfo).port));
    });
    const src = new HttpRunSource({ url: `http://127.0.0.1:${port}`, mode: 'ws', pollMs: 100 });
    t.after(async () => {
      await src.stop(); // terminate the client socket BEFORE wss.close() waits on it
      await new Promise<void>((done) => wss.close(() => done()));
    });
    const got = await firstChange(src);
    assert.deepEqual(got.map((r) => r.runId), ['ext-ws']);
    assert.deepEqual(src.health(), { healthy: true });
  });
});

describe('MergedRunSource', () => {
  function fakeSource(snap: RunRecord[], health?: SourceHealth) {
    let cb: ((records: RunRecord[]) => void) | null = null;
    const src: RunSource = {
      start(onChange) {
        cb = onChange;
        return Promise.resolve();
      },
      stop: () => {
        cb = null;
        return Promise.resolve();
      },
      snapshot: () => snap,
      ...(health ? { health: () => health } : {}),
    };
    return { src, fire: () => cb?.(snap) };
  }

  it('later sources win on runId collision; health ANDs; children without health() count healthy', async (t) => {
    const a = fakeSource(
      [extRec({ runId: 'dup', agent: 'claude' }), extRec({ runId: 'local-1' })],
      { healthy: true },
    );
    const b = fakeSource([extRec({ runId: 'dup', agent: 'codex', producer: 'acme-feed/bridge' })], {
      healthy: false,
      detail: 'feed down',
    });
    const merged = new MergedRunSource([a.src, b.src]);

    const snap = merged.snapshot();
    assert.equal(snap.length, 2);
    assert.equal(snap.find((r) => r.runId === 'dup')?.agent, 'codex');
    assert.deepEqual(merged.health(), { healthy: false, detail: 'feed down' });

    const delivered: RunRecord[][] = [];
    await merged.start((records) => delivered.push(records));
    a.fire(); // a child change forwards the merged snapshot
    assert.equal(delivered.length, 1);
    assert.equal(delivered[0].length, 2);
    await merged.stop();

    const plain = fakeSource([extRec({ runId: 'x' })]); // no health() at all
    assert.deepEqual(new MergedRunSource([plain.src, fakeSource([]).src]).health(), { healthy: true });
    const c = fakeSource([], { healthy: false, detail: 'c down' });
    const d = fakeSource([], { healthy: false, detail: 'd down' });
    assert.deepEqual(new MergedRunSource([c.src, d.src]).health(), {
      healthy: false,
      detail: 'c down; d down',
    });
    void t;
  });
});
