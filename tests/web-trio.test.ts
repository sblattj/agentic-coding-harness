import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { writeRunRecord, type RunRecord } from '../src/core/registry.ts';
import type { AgentEvent, CanonicalTokenRecord } from '../src/core/types.ts';
import { deriveLogs, deriveMetrics, deriveRunObservability, deriveSpans } from '../src/web/derive.ts';

// ---------------------------------------------------------------------------
// web trio feature (src/web/derive.ts + /grid, /trio,
// /api/runs/:runId/observability): the pure derivations run in-process; the
// HTTP routes ride Bun.serve and are exercised through the same bun-subprocess
// runner as tests/web.test.ts.
// ---------------------------------------------------------------------------

const RUNNER = new URL('./helpers/web-server-runner.ts', import.meta.url).pathname;
const isBun = spawnSync('bun', ['--version'], { encoding: 'utf8' }).status === 0;

const T0 = 1_700_000_000_000;

function mkState(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `harness-web-trio-${prefix}-`));
}

function rec(over: Partial<RunRecord> = {}): RunRecord {
  return {
    runId: 'run-trio-1',
    agent: 'claude',
    pid: process.pid,
    cwd: '/tmp/proj',
    promptPreview: 'run the tests',
    startedAt: T0,
    updatedAt: T0,
    status: 'success',
    exitStatus: 'success',
    totals: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4, costUsd: 0.5 },
    rawTranscript: '/nonexistent/transcript.jsonl',
    ...over,
  };
}

const U1: CanonicalTokenRecord = { inputTokens: 1_000, outputTokens: 500, cacheReadTokens: 2_000, cacheWriteTokens: 100 };
const U2: CanonicalTokenRecord = { inputTokens: 100, outputTokens: 50, cacheReadTokens: 500, cacheWriteTokens: 0 };

/** Hand-made timeline: one model call wrapping two tool calls (2nd fails). */
const EVENTS: AgentEvent[] = [
  { type: 'session_start', agent: 'claude', timestamp: T0 },
  { type: 'model_call_start', callId: 'c1', model: 'sonnet-4', timestamp: T0 + 100 },
  { type: 'tool_call', toolCallId: 't1', functionName: 'bash', arguments: 'ls -la', timestamp: T0 + 200 },
  { type: 'tool_result', toolCallId: 't1', content: 'file-a\nfile-b', timestamp: T0 + 600 },
  { type: 'tool_call', toolCallId: 't2', functionName: 'run_tests', arguments: { filter: 'web' }, timestamp: T0 + 650 },
  { type: 'tool_result', toolCallId: 't2', content: 'assert failed: spans nest', isError: true, timestamp: T0 + 800 },
  { type: 'model_call_end', callId: 'c1', model: 'sonnet-4', usage: U1, timestamp: T0 + 900 },
  { type: 'usage', usage: U2, timestamp: T0 + 950 },
  { type: 'done', exitStatus: 'success', timestamp: T0 + 1_000 },
];

// ------------------------------------------------------ derive (in-process)

describe('derive trio views (in-process, pure)', () => {
  it('deriveSpans nests: session root → model → tools, with depths, parents, offsets', () => {
    const spans = deriveSpans(EVENTS);
    assert.equal(spans.length, 4);
    const [session, model, bash, tests] = spans;

    assert.equal(session!.id, 's0');
    assert.equal(session!.kind, 'sys');
    assert.equal(session!.depth, 0);
    assert.equal(session!.parentId, null);
    assert.equal(session!.startMs, 0);
    assert.equal(session!.durationMs, 1_000, 'root spans first→last event offset');

    assert.equal(model!.kind, 'model');
    assert.equal(model!.name, 'llm sonnet-4');
    assert.equal(model!.depth, 1);
    assert.equal(model!.parentId, session!.id);
    assert.equal(model!.startMs, 100, 'start is an offset from the first event');
    assert.equal(model!.durationMs, 800);
    assert.deepEqual(model!.usage, U1, 'model_call_end usage attaches to the span');

    assert.equal(bash!.kind, 'tool');
    assert.equal(bash!.name, 'bash');
    assert.equal(bash!.depth, 2);
    assert.equal(bash!.parentId, model!.id);
    assert.equal(bash!.startMs, 200);
    assert.equal(bash!.durationMs, 400);
    assert.equal(bash!.isError, undefined);

    assert.equal(tests!.kind, 'test', 'functionName matching /test/ gets kind "test"');
    assert.equal(tests!.name, 'run_tests');
    assert.equal(tests!.depth, 2);
    assert.equal(tests!.parentId, model!.id);
    assert.equal(tests!.startMs, 650);
    assert.equal(tests!.durationMs, 150);
    assert.equal(tests!.isError, true);
  });

  it('deriveMetrics is cumulative, non-decreasing, cost growing', () => {
    const points = deriveMetrics(EVENTS);
    assert.equal(points.length, 2, 'one point per usage-bearing event (model_call_end + usage)');

    const [p1, p2] = points;
    assert.equal(p1!.tMs, 900);
    assert.deepEqual(
      [p1!.input, p1!.output, p1!.cacheRead, p1!.cacheWrite],
      [1_000, 500, 2_000, 100],
    );
    assert.deepEqual(
      [p2!.input, p2!.output, p2!.cacheRead, p2!.cacheWrite],
      [1_100, 550, 2_500, 100],
      'second point adds the usage event on top of the model_call_end usage',
    );

    const keys = ['input', 'output', 'cacheRead', 'cacheWrite', 'costUsd'] as const;
    for (const k of keys) {
      for (let i = 1; i < points.length; i++) {
        assert.ok(points[i]![k] >= points[i - 1]![k], `${k} must be non-decreasing at point ${i}`);
      }
    }
    assert.ok(p2!.costUsd > p1!.costUsd, 'cost must grow');
    // flat-rate sanity: U1 alone prices at (1000*3 + 500*15 + 2000*0.3 + 100*3.75)/1e6
    assert.ok(Math.abs(p1!.costUsd - 0.011_475) < 1e-9, `unexpected first cost ${p1!.costUsd}`);
  });

  it('deriveLogs levels: error for the failed tool_result, usage for the usage event', () => {
    const logs = deriveLogs(EVENTS);
    assert.ok(logs.length > 0);

    const err = logs.find((l) => l.level === 'error');
    assert.ok(err, 'no error log line');
    assert.equal(err!.span, 'run_tests');
    assert.ok(err!.text.startsWith('! '), 'failed tool_result text is "! "-prefixed');
    assert.ok(err!.text.includes('assert failed'));

    const usage = logs.find((l) => l.level === 'usage');
    assert.ok(usage, 'no usage log line');
    assert.ok(usage!.text.includes('usage 100 in · 50 out'), `unexpected usage text: ${usage!.text}`);
    assert.equal(usage!.tMs, 950);

    const bashCall = logs.find((l) => l.text === '$ bash ls -la');
    assert.ok(bashCall, 'tool_call renders as "$ name args"');
    assert.equal(bashCall!.span, 'bash');

    const done = logs.find((l) => l.span === 'session' && l.text === 'done success');
    assert.ok(done, 'done event renders as a session-span info line');
    assert.equal(done!.tMs, 1_000);
  });

  it('deriveRunObservability aggregates cost + duration; empty input → zeros', () => {
    const obs = deriveRunObservability(EVENTS);
    assert.equal(obs.durationMs, 1_000);
    assert.equal(obs.totalCostUsd, obs.metrics[obs.metrics.length - 1]!.costUsd);
    assert.ok(obs.totalCostUsd > 0);

    assert.deepEqual(deriveRunObservability([]), {
      spans: [],
      metrics: [],
      logs: [],
      totalCostUsd: 0,
      durationMs: 0,
    });
  });
});

// ------------------------------------------------------- server (bun subprocess)

interface ServerHandle {
  port: number;
  child: ChildProcess;
}

const states: string[] = [];
const children: ChildProcess[] = [];
let seeded: ServerHandle | null = null;

function urlOf(srv: ServerHandle, pathname: string): string {
  return `http://127.0.0.1:${srv.port}${pathname}`;
}

async function spawnServer(stateDir: string, token: string): Promise<ServerHandle> {
  const child = spawn('bun', [RUNNER, stateDir, token], { stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  let out = '';
  let err = '';
  child.stdout!.setEncoding('utf8');
  child.stderr!.setEncoding('utf8');
  child.stderr!.on('data', (c: string) => {
    err += c;
  });
  const port = await new Promise<number>((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error(`web server never became ready; stderr: ${err.slice(-400)}`)), 20_000);
    child.stdout!.on('data', (c: string) => {
      out += c;
      const m = /READY (\d+)\n/.exec(out);
      if (m) {
        clearTimeout(deadline);
        resolve(Number(m[1]));
      }
    });
    child.once('exit', (code, sig) => {
      clearTimeout(deadline);
      reject(new Error(`web server exited early (${code}/${sig}); stderr: ${err.slice(-400)}`));
    });
  });
  return { port, child };
}

async function killChild(c: ChildProcess): Promise<void> {
  if (c.exitCode !== null || c.signalCode) return;
  await new Promise<void>((resolve) => {
    const escalated = setTimeout(() => {
      try {
        c.kill('SIGKILL');
      } catch {
        /* gone */
      }
    }, 3_000);
    c.once('exit', () => {
      clearTimeout(escalated);
      resolve();
    });
    c.kill('SIGTERM');
  });
}

describe('grid/trio routes + observability API (bun subprocess)', { skip: isBun ? false : 'bun not on PATH' }, () => {
  before(async () => {
    const seedState = mkState('seeded');
    states.push(seedState);
    const raw = join(seedState, 'raw', 'claude-trio.jsonl');
    mkdirSync(join(seedState, 'raw'), { recursive: true });
    writeFileSync(
      raw,
      [
        { type: 'session_start', agent: 'claude', timestamp: T0 },
        { type: 'model_call_start', callId: 'c1', model: 'sonnet-4', timestamp: T0 },
        { type: 'tool_call', toolCallId: 't1', functionName: 'vitest', arguments: 'run', timestamp: T0 + 100 },
        { type: 'tool_result', toolCallId: 't1', content: '3 passed', timestamp: T0 + 400 },
        { type: 'model_call_end', callId: 'c1', model: 'sonnet-4', usage: U1, timestamp: T0 + 500 },
        { type: 'done', exitStatus: 'success', timestamp: T0 + 600 },
      ]
        .map((e) => JSON.stringify(e))
        .join('\n') + '\n',
    );
    writeRunRecord(seedState, rec({ rawTranscript: raw }));
    seeded = await spawnServer(seedState, '');
  });

  after(async () => {
    for (const c of children.splice(0)) await killChild(c);
    for (const s of states.splice(0)) rmSync(s, { recursive: true, force: true });
  });

  it('GET /grid → 200 HTML with a doctype', async () => {
    const res = await fetch(urlOf(seeded!, '/grid'));
    assert.equal(res.status, 200);
    assert.ok((res.headers.get('content-type') ?? '').includes('text/html'));
    const html = await res.text();
    assert.ok(/<!doctype html/i.test(html), 'missing doctype');
    assert.ok(html.includes('<html'), 'missing <html tag');
    assert.ok(html.includes('/feed.js'), 'grid must load the shared feed module');
    assert.ok(!/asciinema/i.test(html), 'grid must not reference asciinema');
    assert.ok(!/xterm/i.test(html), 'grid must not reference xterm');
  });

  it('GET /trio → 200 HTML with a doctype', async () => {
    const res = await fetch(urlOf(seeded!, '/trio'));
    assert.equal(res.status, 200);
    assert.ok((res.headers.get('content-type') ?? '').includes('text/html'));
    const html = await res.text();
    assert.ok(/<!doctype html/i.test(html), 'missing doctype');
    assert.ok(html.includes('<html'), 'missing <html tag');
    assert.ok(html.includes('/feed.js'), 'trio must load the shared feed module');
    assert.ok(!/asciinema/i.test(html), 'trio must not reference asciinema');
    assert.ok(!/xterm/i.test(html), 'trio must not reference xterm');
  });

  it('GET /api/runs/<runId>/observability → 200 with spans/metrics/logs arrays', async () => {
    const res = await fetch(urlOf(seeded!, '/api/runs/run-trio-1/observability'));
    assert.equal(res.status, 200);
    const obs = (await res.json()) as ReturnType<typeof deriveRunObservability>;
    assert.ok(Array.isArray(obs.spans) && obs.spans.length > 0, 'spans array missing');
    assert.ok(Array.isArray(obs.metrics) && obs.metrics.length > 0, 'metrics array missing');
    assert.ok(Array.isArray(obs.logs) && obs.logs.length > 0, 'logs array missing');
    assert.equal(obs.spans[0]!.id, 's0');
    assert.equal(obs.spans[0]!.kind, 'sys');
    const vitest = obs.spans.find((s) => s.name === 'vitest');
    assert.equal(vitest?.kind, 'test');
    assert.equal(obs.metrics[0]!.input, 1_000);
    assert.equal(obs.durationMs, 600);
    assert.ok(obs.totalCostUsd > 0);
  });

  it('GET /api/runs/<unknown>/observability → 404 JSON error', async () => {
    const res = await fetch(urlOf(seeded!, '/api/runs/no-such-run/observability'));
    assert.equal(res.status, 404);
    const body = (await res.json()) as { error: string };
    assert.ok(body.error, '404 must carry a JSON error body');
  });
});
