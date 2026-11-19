// `desk reload` without force vs a message that lands after its busy check (#223 review).
// The busy check reads /health; a message can reach the host between that read and the stop. The
// host must refuse the stop then (it is no longer idle), so the turn the message started is never
// cut. A proxy in front of an in-process host (runHost, port 0) answers the reload's first /health
// with the idle snapshot and, before it returns, sends the host a message, so the race happens on
// every run. The proxy reports a dead pid so the reload never signals this test process.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { runHost, type HostDeps } from '../src/desks/host.ts';
import { hostHealth, hostSend, hostStop } from '../src/desks/host-client.ts';
import { deskPaths, updateRoster } from '../src/desks/roster.ts';
import { deskReload } from '../src/desks/service.ts';
import type { Engine, EngineEvent, GoalStatus, HostSpec } from '../src/desks/types.ts';

const TOKEN = 'r'.repeat(64);
const DEAD_PID = 2 ** 22 + 12345;
const roots: string[] = [];
after(() => {
  for (const d of roots) rmSync(d, { recursive: true, force: true });
});

/** send() starts a turn that runs until finishTurn(). */
class TurnEngine implements Engine {
  readonly kind = 'driver' as const;
  private cbs: ((e: EngineEvent) => void)[] = [];
  sent: string[] = [];
  stopped = false;
  async start(): Promise<{ sessionId?: string }> {
    return { sessionId: 'sess-race' };
  }
  async send(text: string): Promise<void> {
    this.sent.push(text);
    this.emit({ type: 'turn_start', data: {} });
  }
  finishTurn(): void {
    this.emit({ type: 'turn_end', data: {} });
  }
  async note(): Promise<void> {}
  async state(): Promise<'busy' | 'idle'> {
    return 'idle';
  }
  async setGoal(): Promise<void> {}
  async goalStatus(): Promise<GoalStatus> {
    return { objective: '', state: 'none', source: 'ach-loop', updatedAt: 0 };
  }
  async mcpStatus(): Promise<Record<string, string>> {
    return {};
  }
  attachCommand(): string[] {
    return ['x'];
  }
  onEvent(cb: (e: EngineEvent) => void): void {
    this.cbs.push(cb);
  }
  async stop(): Promise<void> {
    this.stopped = true;
  }
  private emit(e: EngineEvent): void {
    for (const cb of this.cbs) cb(e);
  }
}

describe('desk reload: a message after the busy check', () => {
  it('a non-force reload refuses (host keeps running the turn the message started) instead of stopping it', { timeout: 60_000 }, async () => {
    const sd = mkdtempSync(join(tmpdir(), 'ach-reload-race-'));
    roots.push(sd);
    const stack = 'race';
    const spec: HostSpec = {
      stack, stateDir: sd, name: 'ALPHA', kind: 'desk', role: 'orchestrator', roleFiles: [],
      agent: 'claude', engine: 'driver', mcps: [], port: 0, cwd: sd, runId: 'run-race', token: TOKEN,
    };
    const engine = new TurnEngine();
    let hostUrl = '';
    const deps: HostDeps = {
      createEngine: async () => engine,
      createHostMeter: () => ({ begin() {}, usage() {}, heartbeat() {}, overBudget: () => false, finish() {}, totals: () => ({ costUsd: null, inputTokens: 0, outputTokens: 0 }) }),
      installSignals: false,
      onReady: (i) => (hostUrl = i.url),
      env: {},
      versionWatcher: { pollMs: 0 },
    };
    let exited = false;
    const done = runHost(spec, deps).then((c) => ((exited = true), c));
    const deadline = Date.now() + 10_000;
    while (!(hostUrl !== '' && (await hostHealth(hostUrl))?.state === 'idle')) {
      if (Date.now() > deadline) throw new Error('host never went idle');
      await new Promise((r) => setTimeout(r, 20));
    }

    // The proxy: forwards every request; the first /health returns the idle snapshot only after a
    // message has reached the host (the message "arrives after the check").
    let healthSeen = 0;
    const proxy: Server = createServer((req, res) => {
      void (async () => {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        const body = chunks.length > 0 ? Buffer.concat(chunks).toString('utf8') : undefined;
        const headers: Record<string, string> = {};
        if (req.headers.authorization) headers.authorization = req.headers.authorization;
        if (req.headers['content-type']) headers['content-type'] = req.headers['content-type'];
        const r = await fetch(`${hostUrl}${req.url ?? '/'}`, { method: req.method ?? 'GET', headers, ...(body !== undefined && req.method !== 'GET' ? { body } : {}) });
        let text = await r.text();
        if (req.url === '/health' && r.ok) {
          const h = JSON.parse(text) as Record<string, unknown>;
          h.pid = DEAD_PID;
          text = JSON.stringify(h);
          if (++healthSeen === 1) await hostSend({ url: hostUrl, token: TOKEN }, 'human', 'late message');
        }
        res.writeHead(r.status, { 'content-type': 'application/json' });
        res.end(text);
      })().catch((e: unknown) => {
        res.writeHead(502);
        res.end(String(e));
      });
    });
    await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', () => r()));
    const addr = proxy.address();
    const proxyPort = addr !== null && typeof addr === 'object' ? addr.port : 0;

    mkdirSync(deskPaths(sd, stack).specs, { recursive: true });
    writeFileSync(join(deskPaths(sd, stack).specs, 'ALPHA.json'), JSON.stringify({ ...spec, port: proxyPort }));
    await updateRoster(sd, stack, (ro) => {
      ro.entries.ALPHA = {
        name: 'ALPHA', kind: 'desk', role: 'orchestrator', agent: 'claude', engine: 'driver', mcps: [],
        port: proxyPort, url: `http://127.0.0.1:${proxyPort}`, pid: DEAD_PID, runId: 'run-race', cwd: sd, startedAt: Date.now(),
      };
    });

    try {
      await assert.rejects(deskReload({ stateDir: sd, stack, name: 'ALPHA' }), /ALPHA is busy \(state busy/);
      assert.equal(healthSeen >= 1, true, 'the reload read /health through the proxy');
      assert.deepEqual(engine.sent.map((t) => t.endsWith('late message')), [true], 'the late message started a turn');
      assert.equal(exited, false, 'the host was not stopped');
      assert.equal(engine.stopped, false, 'the engine (and its turn) was not stopped');
      const h = await hostHealth(hostUrl);
      assert.equal(h?.state, 'busy', 'the turn is still running');
      assert.equal(h?.runId, 'run-race');
    } finally {
      await new Promise<void>((r) => proxy.close(() => r()));
      if (!exited) {
        engine.finishTurn();
        await hostStop({ url: hostUrl, token: TOKEN });
      }
      await done;
    }
  });
});
