import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { writeRunRecord, type RunRecord } from '../src/core/registry.ts';
import { createRunEventHub } from '../src/web/hub.ts';
import { asciicastHeader, eventToText, eventsToAsciicast } from '../src/web/asciicast.ts';
import type { AgentEvent } from '../src/core/types.ts';

// ---------------------------------------------------------------------------
// web dashboard (src/web/*): asciicast synthesis + run event hub test
// in-process (pure node:fs code), and the HTTP/WS server via a bun
// subprocess — startWebServer builds on Bun.serve, which is undefined under
// the tsx/node runner `npm test` uses (verified: typeof Bun === 'undefined'
// under tsx). Convention follows tests/http.test.ts.
// ---------------------------------------------------------------------------

const RUNNER = new URL('./helpers/web-server-runner.ts', import.meta.url).pathname;
const isBun = spawnSync('bun', ['--version'], { encoding: 'utf8' }).status === 0;

const T0 = 1_700_000_000_000;

function mkState(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `harness-web-${prefix}-`));
}

function rec(over: Partial<RunRecord> = {}): RunRecord {
  return {
    runId: 'run-web-1',
    agent: 'claude',
    pid: process.pid,
    cwd: '/tmp/proj',
    promptPreview: 'list the files',
    startedAt: T0,
    updatedAt: T0,
    status: 'success',
    exitStatus: 'success',
    totals: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4, costUsd: 0.5 },
    rawTranscript: '/nonexistent/transcript.jsonl',
    ...over,
  };
}

function msgEvent(text: string, ms: number): AgentEvent {
  return { type: 'message', source: 'assistant', content: text, timestamp: ms };
}

// --------------------------------------------------------------- asciicast

describe('asciicast synthesis (in-process)', () => {
  it('eventToText renders a tool_call as "$ name <args-summary>"', () => {
    const ev: AgentEvent = {
      type: 'tool_call',
      functionName: 'read_file',
      arguments: { path: 'notes.txt' },
      timestamp: T0,
    };
    assert.equal(eventToText(ev), '$ read_file {"path":"notes.txt"}');
  });

  it('eventToText renders a message as its content, null for blank content', () => {
    assert.equal(eventToText({ type: 'message', source: 'user', content: 'hello world', timestamp: T0 }), 'hello world');
    assert.equal(eventToText({ type: 'message', source: 'user', content: '   ', timestamp: T0 }), null);
  });

  it('eventToText returns null for unrendered event types', () => {
    assert.equal(eventToText({ type: 'step', timestamp: T0 }), null);
    assert.equal(eventToText({ type: 'done', timestamp: T0 }), null);
  });

  it('eventsToAsciicast emits a v2 header line then [t, "o"|"m", text] frames', () => {
    const cast = eventsToAsciicast(
      [
        msgEvent('first line', T0),
        { type: 'tool_call', functionName: 'bash', arguments: 'ls -la', timestamp: T0 + 1_500 },
        msgEvent('all done', T0 + 3_000),
      ],
      { title: 'run-x', width: 80, height: 24 },
    );
    const lines = cast.trimEnd().split('\n');
    assert.ok(lines.length >= 4, `expected header + >=3 frames, got ${lines.length} lines`);

    const header = JSON.parse(lines[0]!) as Record<string, unknown>;
    assert.equal(header.version, 2);
    assert.equal(header.width, 80);
    assert.equal(header.height, 24);
    assert.equal(header.title, 'run-x');
    assert.ok(typeof header.timestamp === 'number');

    let prevT = 0;
    const texts: string[] = [];
    for (const line of lines.slice(1)) {
      const frame = JSON.parse(line) as [number, string, string];
      assert.ok(Array.isArray(frame), `frame must be an array: ${line}`);
      const [t, kind, text] = frame;
      assert.ok(typeof t === 'number' && t >= prevT, `times must be sorted: ${t} after ${prevT}`);
      assert.ok(kind === 'o' || kind === 'm', `kind must be "o" or "m", got ${kind}`);
      assert.ok(typeof text === 'string' && text.length > 0);
      prevT = t;
      if (kind === 'o') texts.push(text);
    }
    // assistant messages render a marker frame + the full output frame
    assert.ok(texts.some((t) => t.startsWith('first line')), 'missing first message output');
    assert.ok(texts.some((t) => t.startsWith('$ bash ls -la')), 'missing tool_call output');
    const headerDur = (JSON.parse(lines[0]!) as { duration?: number }).duration;
    assert.equal(headerDur, prevT, 'header.duration must equal the last frame time');
  });

  it('eventsToAsciicast on an empty event list is a bare header (duration 0)', () => {
    const cast = eventsToAsciicast([]);
    const lines = cast.trimEnd().split('\n');
    assert.equal(lines.length, 1);
    const header = JSON.parse(lines[0]!) as { version: number; duration: number };
    assert.equal(header.version, 2);
    assert.equal(header.duration, 0);
  });

  it('events without timestamps all land at t=0; asciicastHeader defaults width/height', () => {
    const header = asciicastHeader({});
    assert.equal(header.version, 2);
    assert.equal(header.width, 100);
    assert.equal(header.height, 30);
    const cast = eventsToAsciicast([
      { type: 'message', source: 'user', content: 'a', timestamp: undefined },
      { type: 'message', source: 'user', content: 'b', timestamp: undefined },
    ]);
    for (const line of cast.trimEnd().split('\n').slice(1)) {
      const [t] = JSON.parse(line) as [number, string, string];
      assert.equal(t, 0);
    }
  });
});

// -------------------------------------------------------------------- hub

describe('run event hub (in-process)', () => {
  it('readTranscript parses a hand-written jsonl transcript and skips blank/partial lines', async () => {
    const dir = mkState('hub');
    const raw = join(dir, 'raw', 'claude-s1.jsonl');
    mkdirSync(join(dir, 'raw'), { recursive: true });
    writeFileSync(
      raw,
      [
        JSON.stringify({ type: 'message', source: 'user', content: 'hi', timestamp: T0 }),
        '',
        JSON.stringify({ type: 'tool_call', functionName: 'bash', arguments: 'ls', timestamp: T0 + 5 }),
        '{"type":"message","source":"agent","content":"partial line never writ', // live-writer tear
        '',
      ].join('\n') + '\n',
    );
    writeRunRecord(dir, rec({ rawTranscript: raw }));
    const hub = createRunEventHub(dir);
    const events = await hub.readTranscript('run-web-1');
    assert.equal(events.length, 2, `expected 2 parseable events, got ${events.length}`);
    assert.equal(events[0]!.type, 'message');
    assert.equal(events[1]!.type, 'tool_call');
  });

  it('readTranscript returns [] for an unknown run and for a missing transcript file', async () => {
    const dir = mkState('hub-missing');
    const hub = createRunEventHub(dir);
    assert.deepEqual(await hub.readTranscript('nope'), []);
    writeRunRecord(dir, rec()); // record exists, rawTranscript path does not
    assert.deepEqual(await hub.readTranscript('run-web-1'), []);
  });

  it('snapshotRuns lists seeded records, newest first; empty stateDir → []', () => {
    const dir = mkState('hub-snap');
    const hub = createRunEventHub(dir);
    assert.deepEqual(hub.snapshotRuns(), []);
    writeRunRecord(dir, rec({ runId: 'a', startedAt: 1_000 }));
    writeRunRecord(dir, rec({ runId: 'b', startedAt: 2_000 }));
    assert.deepEqual(hub.snapshotRuns().map((r) => r.runId), ['b', 'a']);
  });
});

// ---------------------------------------------------------- server (bun)

interface ServerHandle {
  port: number;
  child: ChildProcess;
}

const states: string[] = [];
const children: ChildProcess[] = [];
let empty: ServerHandle | null = null;
let seeded: ServerHandle | null = null;
let authed: ServerHandle | null = null;

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

describe('web dashboard server (bun subprocess)', { skip: isBun ? false : 'bun not on PATH' }, () => {
  before(async () => {
    const emptyState = mkState('empty');
    states.push(emptyState);
    empty = await spawnServer(emptyState, '');

    const seedState = mkState('seeded');
    states.push(seedState);
    const raw = join(seedState, 'raw', 'claude-s1.jsonl');
    mkdirSync(join(seedState, 'raw'), { recursive: true });
    writeFileSync(
      raw,
      [
        JSON.stringify({ type: 'message', source: 'user', content: 'list files', timestamp: T0 }),
        JSON.stringify({ type: 'tool_call', functionName: 'bash', arguments: 'ls -la', timestamp: T0 + 1_000 }),
        JSON.stringify({ type: 'message', source: 'assistant', content: 'done', timestamp: T0 + 2_000 }),
      ].join('\n') + '\n',
    );
    writeRunRecord(seedState, rec({ rawTranscript: raw }));
    seeded = await spawnServer(seedState, '');

    const authState = mkState('auth');
    states.push(authState);
    authed = await spawnServer(authState, 'tok');
  });

  after(async () => {
    for (const c of children.splice(0)) await killChild(c);
    for (const s of states.splice(0)) rmSync(s, { recursive: true, force: true });
  });

  it('GET / serves the dashboard HTML with the agent-harness title', async () => {
    const res = await fetch(urlOf(seeded!, '/'));
    assert.equal(res.status, 200);
    assert.ok((res.headers.get('content-type') ?? '').includes('text/html'));
    const html = await res.text();
    assert.ok(html.includes('<title>agent-harness</title>'), 'title tag missing');
    assert.ok(html.length > 500, 'dashboard HTML suspiciously small');
  });

  it('GET /api/runs on an empty stateDir → 200 {records: []}', async () => {
    const res = await fetch(urlOf(empty!, '/api/runs'));
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { records: [] });
  });

  it('GET /api/runs on a seeded stateDir returns the run record', async () => {
    const res = await fetch(urlOf(seeded!, '/api/runs'));
    assert.equal(res.status, 200);
    const body = (await res.json()) as { records: RunRecord[] };
    assert.deepEqual(body.records.map((r) => r.runId), ['run-web-1']);
    assert.equal(body.records[0]!.status, 'success');
  });

  it('GET /api/runs/<unknown>/cast → 404', async () => {
    const res = await fetch(urlOf(seeded!, '/api/runs/no-such-run/cast'));
    assert.equal(res.status, 404);
    const body = (await res.json()) as { error: string };
    assert.ok(body.error, '404 must carry a JSON error body');
  });

  it('GET /api/runs/<runId>/cast → 200 asciicast v2 of the transcript', async () => {
    const res = await fetch(urlOf(seeded!, '/api/runs/run-web-1/cast'));
    assert.equal(res.status, 200);
    assert.ok((res.headers.get('content-type') ?? '').startsWith('text/plain'));
    const cast = await res.text();
    const lines = cast.trimEnd().split('\n');
    const header = JSON.parse(lines[0]!) as { version: number; title: string; duration: number };
    assert.equal(header.version, 2);
    assert.equal(header.title, 'run-web-1');
    assert.equal(header.duration, 2);
    const frames = lines.slice(1).map((l) => JSON.parse(l) as [number, string, string]);
    assert.equal(frames.length, 4); // 2 assistant messages (marker+output) + tool_call output
    for (const [t, kind, text] of frames) {
      assert.ok(typeof t === 'number');
      assert.ok(kind === 'o' || kind === 'm');
      assert.ok(typeof text === 'string');
    }
    assert.equal(frames[0]![2], 'list files\n'); // first output frame is the earliest event
    assert.equal(frames[2]![1], 'm'); // assistant message renders a marker frame
    assert.equal(frames[2]![2], 'done');
    assert.ok(frames.some(([, , text]) => text.startsWith('$ bash ls -la')), 'tool_call frame missing');
  });

  it('GET /vendor/xterm/xterm.js → 200 javascript; unknown vendor file → 404', async () => {
    const res = await fetch(urlOf(seeded!, '/vendor/xterm/xterm.js'));
    assert.equal(res.status, 200);
    assert.ok(
      (res.headers.get('content-type') ?? '').startsWith('text/javascript'),
      `content-type: ${res.headers.get('content-type')}`,
    );
    const body = await res.text();
    assert.ok(body.length > 1_000, 'xterm.js bundle suspiciously small');
    const missing = await fetch(urlOf(seeded!, '/vendor/nope/missing.js'));
    assert.equal(missing.status, 404);
  });

  it('GET /vendor/<encoded traversal> → 400 (rejected before decode)', async () => {
    // fetch/URL normalize literal "..", so the traversal must arrive encoded
    // to exercise the server's own guard.
    const res = await fetch(urlOf(seeded!, '/vendor/%2e%2e%2f%2e%2e%2fetc%2fpasswd'));
    assert.equal(res.status, 400, 'encoded traversal must be rejected with 400');
    const body = (await res.json()) as { error: string };
    assert.equal(body.error, 'bad path');
  });

  it('token-gated /ws: missing or wrong token → 401; /api/runs stays open', async () => {
    const noTok = await fetch(urlOf(authed!, '/ws?runs=1'));
    assert.equal(noTok.status, 401);
    const wrongTok = await fetch(urlOf(authed!, '/ws?runs=1&token=wrong'));
    assert.equal(wrongTok.status, 401);
    // Only the websocket route is gated; the JSON API is unauthenticated
    // (documented server behavior, src/web/server.ts fetch handler).
    const runs = await fetch(urlOf(authed!, '/api/runs'));
    assert.equal(runs.status, 200);
    assert.deepEqual(await runs.json(), { records: [] });
  });

  it('WS ?runs=1 first message is {type:"runs", records} (Node global WebSocket)', async () => {
    if (typeof WebSocket === 'undefined') {
      assert.ok(true, 'WebSocket global unavailable in this runner; skipped');
      return;
    }
    const ws = new WebSocket(`ws://127.0.0.1:${seeded!.port}/ws?runs=1`);
    try {
      const first = await new Promise<Record<string, unknown>>((resolve, reject) => {
        const deadline = setTimeout(() => reject(new Error('no first message within 5s')), 5_000);
        ws.addEventListener('open', () => {}, { once: true });
        ws.addEventListener('message', (ev: MessageEvent) => {
          clearTimeout(deadline);
          try {
            resolve(JSON.parse(String(ev.data)) as Record<string, unknown>);
          } catch (e) {
            reject(e instanceof Error ? e : new Error(String(e)));
          }
        });
        ws.addEventListener('error', () => {
          clearTimeout(deadline);
          reject(new Error('websocket error before first message'));
        });
      });
      assert.equal(first.type, 'runs');
      const records = first.records as RunRecord[];
      assert.ok(Array.isArray(records), 'records must be an array');
      assert.deepEqual(records.map((r) => r.runId), ['run-web-1']);
    } finally {
      ws.close();
    }
    // the server must still answer plain HTTP after a websocket session
    const res = await fetch(urlOf(seeded!, '/api/runs'));
    assert.equal(res.status, 200);
  });
});
