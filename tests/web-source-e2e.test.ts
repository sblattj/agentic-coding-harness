// End-to-end proof of the external-source pipeline (spec §10 integration
// items) through the REAL CLI process: `npx tsx src/cli/ach.ts web ...` is
// spawned as a child, a node:http stub feed plays the Reference bridge
// behind a bearer check, and the running dashboard is probed over HTTP.
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { writeRunRecord, type RunRecord } from '../src/core/registry.ts';

const WORKTREE_ROOT = path.resolve(import.meta.dirname, '..');
const T0 = 1_700_000_000_000;
const SOURCE_TOKEN = 'st1';

// The three-run Reference set (spec §10): one experiment × variant, three
// workflows, in/out token pairs 4037/75, 1972/75, 4160/155, durations
// 3000/4000/5000 — avgTotalTokens (in+out) = 10474/3, avgDurationMs 4000.
function extRun(i: 1 | 2 | 3, workflow: string, inputTokens: number, outputTokens: number, durMs: number): RunRecord {
  const startedAt = T0 + (i - 1) * 10_000;
  return {
    runId: `e2e-run-${i}`,
    agent: 'acme_cloud_harness',
    experiment: 'acme-final-proof',
    variant: 'acme-harness',
    source: 'external',
    producer: 'e2e-stub',
    status: 'success',
    startedAt,
    endedAt: startedAt + durMs,
    totals: { inputTokens, outputTokens, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 },
    workflow,
  };
}

const FIXTURE: RunRecord[] = [
  extRun(1, 'implement', 4037, 75, 3000),
  extRun(2, 'review', 1972, 75, 4000),
  extRun(3, 'plan', 4160, 155, 5000),
];

// ---------------------------------------------------------------------------
// Stub feed: bearer-gated GET /runs snapshot + GET /runs/stream SSE push.
// ---------------------------------------------------------------------------

interface StubHit {
  pathname: string;
  authorization: string | undefined;
}

interface StubFeed {
  url: string;
  hits: StubHit[];
  close(): Promise<void>;
}

function startStubFeed(): Promise<StubFeed> {
  const hits: StubHit[] = [];
  const server = http.createServer((req, res) => {
    const pathname = req.url ?? '/';
    hits.push({ pathname, authorization: req.headers.authorization });
    if (req.headers.authorization !== `Bearer ${SOURCE_TOKEN}`) {
      res.writeHead(401, { 'content-type': 'text/plain' }).end('bad token');
      return;
    }
    if (req.method === 'GET' && pathname === '/runs') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ records: FIXTURE }));
      return;
    }
    if (req.method === 'GET' && pathname === '/runs/stream') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`event: runs\ndata: ${JSON.stringify({ records: FIXTURE })}\n\n`);
      return; // keep the socket open — live push channel
    }
    res.writeHead(404).end();
  });
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
        hits,
        close: () =>
          new Promise<void>((done) => {
            for (const s of sockets) s.destroy();
            server.close(() => done());
          }),
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Real CLI child process: `npx tsx src/cli/ach.ts web ...` in its own
// process group so a group SIGTERM/SIGKILL can never orphan the tsx server.
// ---------------------------------------------------------------------------

const children: ChildProcess[] = [];

function cliEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  for (const k of [
    'AGENTIC_CODING_HARNESS_SOURCE',
    'AGENTIC_CODING_HARNESS_SOURCE_TOKEN',
    'AGENTIC_CODING_HARNESS_SOURCE_MODE',
    'AGENTIC_CODING_HARNESS_SOURCE_POLL_MS',
    'AGENTIC_CODING_HARNESS_SOURCE_MERGE',
    'AGENTIC_CODING_HARNESS_HTTP_TOKEN',
  ]) {
    delete env[k];
  }
  env.NO_COLOR = '1';
  return env;
}

interface CliHandle {
  port: Promise<number>;
  stderrTail(): string;
  kill(): Promise<void>;
}

function killGroup(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  const exited = new Promise<void>((resolve) => {
    child.once('exit', () => resolve());
  });
  const signal = (sig: NodeJS.Signals): void => {
    try {
      process.kill(-child.pid!, sig); // the whole detached group
    } catch {
      child.kill(sig); // group already gone; the leader may not be
    }
  };
  signal('SIGTERM');
  const escalate = setTimeout(() => signal('SIGKILL'), 5000);
  return exited.finally(() => clearTimeout(escalate));
}

function spawnCliWeb(extraArgs: string[]): CliHandle {
  const child = spawn('npx', ['tsx', 'src/cli/ach.ts', 'web', ...extraArgs], {
    cwd: WORKTREE_ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: cliEnv(),
    detached: true, // own process group: npx + tsx die together
  });
  children.push(child);
  let stderr = '';
  child.stderr!.setEncoding('utf8');
  const port = new Promise<number>((resolve, reject) => {
    const deadline = setTimeout(
      () => reject(new Error(`ach web never announced its dashboard port within 15s; stderr tail:\n${stderr.slice(-2000)}`)),
      15_000,
    );
    const check = (): void => {
      const m = /web dashboard: http:\/\/127\.0\.0\.1:(\d+)/.exec(stderr);
      if (m) {
        clearTimeout(deadline);
        resolve(Number(m[1]));
      }
    };
    child.stderr!.on('data', (c: string) => {
      stderr += c;
      check();
    });
    child.once('exit', (code, sig) => {
      clearTimeout(deadline);
      reject(new Error(`ach web exited before announcing a port (${code}/${sig}); stderr tail:\n${stderr.slice(-2000)}`));
    });
  });
  port.catch(() => {}); // awaited (or not) by the test; never an unhandled rejection
  return {
    port,
    stderrTail: () => stderr.slice(-2000),
    kill: () => killGroup(child),
  };
}

// ---------------------------------------------------------------------------
// HTTP probes against the running dashboard.
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchOk(port: number, pathname: string, timeoutMs = 2000): Promise<Response> {
  const res = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    signal: AbortSignal.timeout(timeoutMs),
  });
  assert.equal(res.status, 200, `GET ${pathname} -> ${res.status}`);
  return res;
}

/** Poll GET /api/runs until it carries `want` records; returns them. */
async function waitForRuns(port: number, want: number, timeoutMs = 5000): Promise<RunRecord[]> {
  const deadline = Date.now() + timeoutMs;
  let last = 0;
  for (;;) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/runs`, { signal: AbortSignal.timeout(2000) });
      if (res.status === 200) {
        const body = (await res.json()) as { records: RunRecord[] };
        last = body.records.length;
        if (last >= want) return body.records;
      }
    } catch {
      // server not accepting yet — keep polling
    }
    if (Date.now() > deadline) {
      throw new Error(`/api/runs never reached ${want} records within ${timeoutMs}ms (last seen: ${last})`);
    }
    await sleep(100);
  }
}

describe('ach web --source (end-to-end via the real CLI process)', () => {
  let stub: StubFeed;

  before(async () => {
    stub = await startStubFeed();
  });

  after(async () => {
    for (const c of children.splice(0)) await killGroup(c);
    await stub.close();
  });

  it('poll mode: bearer-authed feed → /api/runs, /api/compare rollups, /health, /compare', { timeout: 25_000 }, async () => {
    const cli = spawnCliWeb([
      '--source', stub.url,
      '--source-token', SOURCE_TOKEN,
      '--no-open',
      '--token', 't',
      '--port', '0',
      '--source-poll-ms', '400',
    ]);
    try {
      const port = await cli.port;
      const records = await waitForRuns(port, 3);
      assert.deepEqual(
        records.map((r) => r.runId).sort(),
        ['e2e-run-1', 'e2e-run-2', 'e2e-run-3'],
      );
      assert.ok(records.every((r) => r.source === 'external'), 'every record carries source "external"');

      // The stub feed really saw the bearer the CLI was told to send.
      const polls = stub.hits.filter((h) => h.pathname === '/runs');
      assert.ok(polls.length >= 1, `stub /runs was polled (hits: ${polls.length})`);
      assert.ok(polls.every((h) => h.authorization === `Bearer ${SOURCE_TOKEN}`), 'every /runs hit bore the right bearer');

      // Default rollup: one experiment×variant row over all three runs.
      const cmp = (await (await fetchOk(port, '/api/compare')).json()) as {
        groupBy: string[];
        rows: Array<Record<string, string | number | undefined>>;
      };
      assert.deepEqual(cmp.groupBy, ['experiment', 'variant']);
      assert.equal(cmp.rows.length, 1);
      const row = cmp.rows[0]!;
      assert.equal(row.experiment, 'acme-final-proof');
      assert.equal(row.variant, 'acme-harness');
      assert.equal(row.runs, 3);
      assert.equal(row.avgTotalTokens, 10474 / 3);
      assert.equal(row.avgCostUsd, 0);
      assert.equal(row.avgDurationMs, 4000);
      assert.equal(row.successRate, 1);

      // Workflow × agent grouping: one row per workflow.
      const byWf = (await (await fetchOk(port, '/api/compare?by=workflow,agent')).json()) as {
        rows: Array<Record<string, string | number | undefined>>;
      };
      assert.deepEqual(
        byWf.rows.map((r) => r.workflow),
        ['implement', 'plan', 'review'],
      );
      assert.ok(byWf.rows.every((r) => r.agent === 'acme_cloud_harness' && r.runs === 1));

      // Health names the configured source and its live status.
      const health = (await (await fetchOk(port, '/health')).json()) as {
        ok: boolean;
        source: string | null;
        sourceHealthy: boolean | null;
      };
      assert.equal(health.ok, true);
      assert.equal(health.source, new URL(stub.url).toString());
      assert.equal(health.sourceHealthy, true);

      // The compare view renders.
      const page = await fetchOk(port, '/compare');
      assert.match(page.headers.get('content-type') ?? '', /^text\/html/);
      const html = await page.text();
      assert.ok(html.includes('compare'), '/compare HTML mentions compare');
    } finally {
      await cli.kill();
    }

  });

  it('sse mode: records arrive via the /runs/stream push, snapshot endpoint untouched', { timeout: 25_000 }, async () => {
    const cli = spawnCliWeb([
      '--source', stub.url,
      '--source-token', SOURCE_TOKEN,
      '--source-mode', 'sse',
      '--no-open',
      '--token', 't',
      '--port', '0',
    ]);
    const hitsBefore = stub.hits.length; // only THIS child's requests count
    try {
      const port = await cli.port;
      const records = await waitForRuns(port, 3);
      assert.deepEqual(
        records.map((r) => r.runId).sort(),
        ['e2e-run-1', 'e2e-run-2', 'e2e-run-3'],
      );
      assert.ok(records.every((r) => r.source === 'external'));
      // Live-only contract: sse mode subscribes; it never polls GET /runs.
      assert.equal(
        stub.hits.slice(hitsBefore).filter((h) => h.pathname === '/runs').length,
        0,
        'sse mode must not poll the snapshot endpoint',
      );
      assert.ok(
        stub.hits.slice(hitsBefore).some((h) => h.pathname === '/runs/stream' && h.authorization === `Bearer ${SOURCE_TOKEN}`),
        'sse subscription bore the right bearer',
      );
    } finally {
      await cli.kill();
    }

  });

  it('--source-merge state: local registry + feed union, external wins the runId collision', { timeout: 25_000 }, async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-e2e-source-merge-'));
    try {
      // A local record colliding with e2e-run-1 but with different totals,
      // and one unique local run (no `source` field → local on read).
      writeRunRecord(stateDir, {
        runId: 'e2e-run-1',
        agent: 'claude',
        startedAt: T0,
        endedAt: T0 + 60_000,
        totals: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 },
      });
      writeRunRecord(stateDir, {
        runId: 'e2e-run-local-only',
        agent: 'claude',
        startedAt: T0,
      });

      const cli = spawnCliWeb([
        '--source', stub.url,
        '--source-token', SOURCE_TOKEN,
        '--source-merge', 'state',
        '--dir', stateDir,
        '--no-open',
        '--token', 't',
        '--port', '0',
        '--source-poll-ms', '400',
      ]);
      try {
        const port = await cli.port;
        const records = await waitForRuns(port, 4);
        assert.equal(records.length, 4);
        assert.deepEqual(
          records.map((r) => r.runId).sort(),
          ['e2e-run-1', 'e2e-run-2', 'e2e-run-3', 'e2e-run-local-only'],
        );
        const collided = records.find((r) => r.runId === 'e2e-run-1');
        assert.equal(collided?.source, 'external');
        assert.equal(collided?.totals?.inputTokens, 4037, 'external record wins the runId collision');
        const local = records.find((r) => r.runId === 'e2e-run-local-only');
        assert.equal(local?.source, 'local');
      } finally {
        await cli.kill();
      }
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }

  });
});
