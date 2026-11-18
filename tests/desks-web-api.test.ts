// Desks Web API + /desks page (#205). Routes run against a fake service (the real one
// lives in src/desks/service.ts and is exercised by its own tests); the stream tails
// real stack files in a temp state dir.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, get as httpGet, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createContext, runInContext, Script } from 'node:vm';
import { readFileSync } from 'node:fs';
import {
  handleDesksApi,
  listDeskMcps,
  openDesksStreamCount,
  STREAM_MAX_BUFFERED_BYTES,
  probeEngines,
  statusForError,
  type DesksApiDeps,
  type DesksService,
} from '../src/web/desks-api.ts';
import { startWebServer, type WebServerHandle } from '../src/web/server.ts';
import { deskPaths } from '../src/desks/roster.ts';
import type { HostTarget } from '../src/desks/host-client.ts';

const urlOf = (t: HostTarget): string => (typeof t === 'string' ? t : t.url);
import type { Decision, DecisionEvent, DeskMessage, HostEvent, RosterRow, RosterView } from '../src/desks/types.ts';

const STACK = 'web-test';

function row(name: string, over: Partial<RosterRow> = {}): RosterRow {
  return {
    name,
    kind: 'desk',
    role: name.toLowerCase(),
    agent: 'opencode',
    engine: 'opencode',
    mcps: [],
    port: 4801,
    url: `http://127.0.0.1:1/${name}`,
    pid: 1,
    runId: `run-${name}`,
    cwd: '/tmp',
    startedAt: 1,
    state: 'idle',
    queueDepth: 0,
    costUsd: null,
    treeCostUsd: null,
    ...over,
  };
}

function viewOf(rows: RosterRow[]): RosterView {
  return { version: 'desks-api/1', stack: STACK, portBase: 4800, rows, pendingLanes: [], openDecisions: [] };
}

interface Call {
  fn: string;
  arg: Record<string, unknown>;
}

function fakeService(calls: Call[], st: { view: RosterView; throwFor?: Record<string, Error> }): DesksService {
  const rec =
    (fn: string, result: (a: Record<string, unknown>) => unknown) =>
    async (a: Record<string, unknown> = {}): Promise<unknown> => {
      calls.push({ fn, arg: a });
      const e = st.throwFor?.[fn];
      if (e) throw e;
      return result(a);
    };
  const msg = (a: Record<string, unknown>): DeskMessage => ({ id: 'm1', from: a.from as string, to: a.to as string, text: a.text as string, at: 5, delivered: 'now' });
  const dec = (a: Record<string, unknown>): Decision => ({
    id: a.id as string,
    question: 'q',
    options: [],
    askedBy: 'ORCH',
    openedBy: 'DECISIONS',
    openedAt: 1,
    state: 'answered',
    answer: { text: a.text as string, by: a.by as string, at: 2 },
  });
  const svc = {
    deskUp: rec('deskUp', () => st.view),
    deskDown: rec('deskDown', () => ({ stopped: ['A', 'B'] })),
    deskSend: rec('deskSend', msg),
    deskRoster: rec('deskRoster', () => st.view),
    deskInbox: rec('deskInbox', () => [msg({ from: 'A', to: 'B', text: 'hi' })]),
    deskEvents: rec('deskEvents', () => [{ seq: 1, at: 1, runId: 'r', name: 'A', type: 'text', data: { text: 'x' } }]),
    deskSwitchEngine: rec('deskSwitchEngine', (a) => ({ ...row(a.name as string), agent: a.agent })),
    laneNew: rec('laneNew', (a) => (a.name === 'needs-ok' ? { pending: { id: 'L1', request: a, requestedAt: 1, state: 'pending' } } : row(a.name as string, { kind: 'lane' }))),
    laneApprove: rec('laneApprove', () => row('lane1', { kind: 'lane' })),
    laneReject: rec('laneReject', (a) => ({ id: a.id, request: { name: 'x', goal: 'g', launchedBy: 'ORCH' }, requestedAt: 1, state: 'rejected', decidedBy: a.by, reason: a.reason })),
    laneStop: rec('laneStop', (a) => ({ stopped: a.name })),
    decisionAnswer: rec('decisionAnswer', dec),
    decisionList: rec('decisionList', () => []),
    deskCosts: rec('deskCosts', () => [{ name: 'A', kind: 'desk', runId: 'r', costUsd: 1, inputTokens: 1, outputTokens: 2, lanes: [] }]),
    resolveStack: (o: { stack?: string } = {}) => o.stack ?? STACK,
  };
  return svc as unknown as DesksService;
}

interface Harness {
  server: Server;
  base: string;
  calls: Call[];
  st: { view: RosterView; throwFor?: Record<string, Error> };
  subs: Array<{ url: HostTarget; since: number; emit: (e: HostEvent) => void; unsubscribed: boolean }>;
  attachUrls: HostTarget[];
  /** Sent as Bearer by call() when the harness was built with autoAuth (and no header was given). */
  autoToken?: string;
}

async function harness(stateDir: string, token?: string, autoAuth = false, wrapRes?: (res: ServerResponse) => void): Promise<Harness> {
  const calls: Call[] = [];
  const st: Harness['st'] = { view: viewOf([row('ORCH')]) };
  const subs: Harness['subs'] = [];
  const attachUrls: HostTarget[] = [];
  const deps: DesksApiDeps = {
    service: fakeService(calls, st),
    hostSubscribe: (url, since, onEvent) => {
      const s = { url, since, emit: onEvent, unsubscribed: false };
      subs.push(s);
      return () => {
        s.unsubscribed = true;
      };
    },
    hostLastSeq: async () => 7,
    hostAttach: async (url) => {
      attachUrls.push(url);
      return ['opencode', 'attach', urlOf(url)];
    },
    engines: async (sd) => {
      assert.equal(sd, stateDir, 'engines probe uses the server state dir');
      return [{ agent: 'claude', found: true, path: '/bin/claude', auth: 'verified' }];
    },
    mcps: async (sd, stack) => [`${stack}:${sd === stateDir ? 'ok' : 'bad'}`],
  };
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    wrapRes?.(res);
    void handleDesksApi(req, res, url, { stateDir, ...(token !== undefined ? { token } : {}) }, deps).then((handled) => {
      if (!handled) res.writeHead(418).end();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, calls, st, subs, attachUrls, ...(autoAuth && token !== undefined ? { autoToken: token } : {}) };
}

async function closeHarness(h: Harness): Promise<void> {
  h.server.closeAllConnections();
  await new Promise<void>((r) => h.server.close(() => r()));
}

async function call(h: Harness, method: string, path: string, body?: string, headers: Record<string, string> = {}): Promise<{ status: number; json: any }> {
  if (h.autoToken !== undefined && headers.authorization === undefined) headers = { ...headers, authorization: `Bearer ${h.autoToken}` };
  const res = await fetch(h.base + path, { method, ...(body !== undefined ? { body, headers: { 'content-type': 'application/json', ...headers } } : { headers }) });
  const text = await res.text();
  return { status: res.status, json: text === '' ? null : JSON.parse(text) };
}

const lastCall = (h: Harness, fn: string): Call => {
  const c = [...h.calls].reverse().find((x) => x.fn === fn);
  assert.ok(c, `expected a ${fn} call`);
  return c;
};

/** Minimal SSE client over node:http (no EventSource in node:test). */
function openSse(url: string): Promise<{ frames: any[]; status: number; waitFor: (pred: (f: any) => boolean, ms?: number) => Promise<any>; close: () => void }> {
  return new Promise((resolve, reject) => {
    const frames: any[] = [];
    const waiters: Array<{ pred: (f: any) => boolean; resolve: (f: any) => void }> = [];
    const req = httpGet(url, { headers: { accept: 'text/event-stream' } }, (res: IncomingMessage) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        buf += chunk;
        let i: number;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const data = block
            .split('\n')
            .filter((l) => l.startsWith('data:'))
            .map((l) => l.slice(5).trim())
            .join('\n');
          if (data === '') continue;
          const f = JSON.parse(data);
          frames.push(f);
          for (const w of [...waiters]) {
            if (w.pred(f)) {
              waiters.splice(waiters.indexOf(w), 1);
              w.resolve(f);
            }
          }
        }
      });
      res.on('error', () => {});
      resolve({
        frames,
        status: res.statusCode ?? 0,
        waitFor: (pred, ms = 2000) =>
          new Promise((res2, rej2) => {
            const hit = frames.find(pred);
            if (hit) return res2(hit);
            const t = setTimeout(() => rej2(new Error(`no matching frame within ${ms} ms; got ${JSON.stringify(frames).slice(0, 500)}`)), ms);
            waiters.push({
              pred,
              resolve: (f) => {
                clearTimeout(t);
                res2(f);
              },
            });
          }),
        close: () => req.destroy(),
      });
    });
    req.on('error', (e) => {
      if ((e as NodeJS.ErrnoException).code !== 'ECONNRESET') reject(e);
    });
  });
}

async function until(pred: () => boolean, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 20));
  }
}

const tmpDirs: string[] = [];
function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), `ach-desks-web-${prefix}-`));
  tmpDirs.push(d);
  return d;
}
after(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

describe('desks web api: routes', () => {
  let h: Harness;
  let stateDir: string;
  before(async () => {
    stateDir = tmp('routes');
    // Writes fail closed without a token (#212 review), so the route suite runs with one.
    h = await harness(stateDir, 'routes-tok', true);
  });
  after(async () => closeHarness(h));

  it('GET /api/desks -> RosterView; ?stack= is passed through', async () => {
    const r = await call(h, 'GET', '/api/desks?stack=s2');
    assert.equal(r.status, 200);
    assert.equal(r.json.version, 'desks-api/1');
    assert.equal(r.json.rows[0].name, 'ORCH');
    const c = lastCall(h, 'deskRoster');
    assert.equal(c.arg.stateDir, stateDir);
    assert.equal(c.arg.stack, 's2');
  });

  it('GET /messages?since= -> {messages}; bad since is 400', async () => {
    const r = await call(h, 'GET', '/api/desks/messages?since=5');
    assert.equal(r.status, 200);
    assert.equal(r.json.messages.length, 1);
    assert.equal(lastCall(h, 'deskInbox').arg.sinceMs, 5);
    assert.equal((await call(h, 'GET', '/api/desks/messages?since=abc')).status, 400);
  });

  it('GET /decisions -> {decisions}; ?state validated', async () => {
    const r = await call(h, 'GET', '/api/desks/decisions?state=open');
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { decisions: [] });
    assert.equal(lastCall(h, 'decisionList').arg.state, 'open');
    const bad = await call(h, 'GET', '/api/desks/decisions?state=bogus');
    assert.equal(bad.status, 400);
    assert.match(bad.json.error, /state/);
  });

  it('POST /decisions/:id/answer -> Decision answered by human', async () => {
    const r = await call(h, 'POST', '/api/desks/decisions/D3/answer', JSON.stringify({ text: 'ship it' }));
    assert.equal(r.status, 200);
    assert.equal(r.json.id, 'D3');
    const c = lastCall(h, 'decisionAnswer');
    assert.deepEqual([c.arg.id, c.arg.text, c.arg.by], ['D3', 'ship it', 'human']);
    assert.equal((await call(h, 'POST', '/api/desks/decisions/D3/answer', '{}')).status, 400);
    h.st.throwFor = { decisionAnswer: new Error('desks: unknown decision D9') };
    const nf = await call(h, 'POST', '/api/desks/decisions/D9/answer', JSON.stringify({ text: 'x' }));
    h.st.throwFor = undefined;
    assert.equal(nf.status, 404);
    assert.match(nf.json.error, /unknown decision D9/);
  });

  it('POST /send -> DeskMessage from "human"; validation and refusals', async () => {
    const r = await call(h, 'POST', '/api/desks/send', JSON.stringify({ to: 'ORCH', text: 'hello', from: 'DECISIONS' }));
    assert.equal(r.status, 200);
    assert.equal(r.json.from, 'human');
    assert.equal(lastCall(h, 'deskSend').arg.from, 'human', 'a body "from" must not spoof the sender');
    assert.equal((await call(h, 'POST', '/api/desks/send', '{not json')).status, 400);
    assert.equal((await call(h, 'POST', '/api/desks/send', JSON.stringify({ text: 'x' }))).status, 400);
    assert.equal((await call(h, 'POST', '/api/desks/send', JSON.stringify([1]))).status, 400);
    h.st.throwFor = { deskSend: new Error('desks: ORCH is not running (dead) in stack "s"; live: A') };
    const refused = await call(h, 'POST', '/api/desks/send', JSON.stringify({ to: 'ORCH', text: 'x' }));
    h.st.throwFor = undefined;
    assert.equal(refused.status, 409);
    assert.deepEqual(Object.keys(refused.json), ['error']);
  });

  it('POST /up -> RosterView, no terminal by default; layoutFile passed', async () => {
    const r = await call(h, 'POST', '/api/desks/up', '');
    assert.equal(r.status, 200);
    assert.equal(r.json.stack, STACK);
    assert.equal(lastCall(h, 'deskUp').arg.term, 'none');
    await call(h, 'POST', '/api/desks/up', JSON.stringify({ layoutFile: '/x/desks.yaml' }));
    assert.equal(lastCall(h, 'deskUp').arg.layoutFile, '/x/desks.yaml');
    assert.equal((await call(h, 'POST', '/api/desks/up', JSON.stringify({ term: 'xterm' }))).status, 400);
    assert.equal((await call(h, 'POST', '/api/desks/up', JSON.stringify({ layoutFile: 3 }))).status, 400);
  });

  it('POST /down -> {stopped}', async () => {
    const r = await call(h, 'POST', '/api/desks/down');
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { stopped: ['A', 'B'] });
  });

  it('POST /lanes -> RosterEntry or {pending}, launched by human', async () => {
    const body = { name: 'fix-1', goal: 'fix it', mcps: ['tracker'], cwd: '/w', agent: 'claude', model: 'm', budgetUsd: 2 };
    const r = await call(h, 'POST', '/api/desks/lanes', JSON.stringify(body));
    assert.equal(r.status, 200);
    assert.equal(r.json.name, 'fix-1');
    const c = lastCall(h, 'laneNew');
    assert.equal(c.arg.launchedBy, 'human');
    assert.deepEqual(c.arg.mcps, ['tracker']);
    assert.equal(c.arg.budgetUsd, 2);
    const p = await call(h, 'POST', '/api/desks/lanes', JSON.stringify({ name: 'needs-ok', goal: 'g' }));
    assert.equal(p.json.pending.id, 'L1');
    assert.equal((await call(h, 'POST', '/api/desks/lanes', JSON.stringify({ name: 'x', goal: 'g', mcps: 'tracker' }))).status, 400);
    assert.equal((await call(h, 'POST', '/api/desks/lanes', JSON.stringify({ name: 'x', goal: 'g', budgetUsd: -1 }))).status, 400);
    assert.equal((await call(h, 'POST', '/api/desks/lanes', JSON.stringify({ name: 'x' }))).status, 400);
  });

  it('POST /lanes/:name/stop -> exactly {}', async () => {
    const r = await call(h, 'POST', '/api/desks/lanes/fix-1/stop');
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, {});
    const c = lastCall(h, 'laneStop');
    assert.equal(c.arg.name, 'fix-1');
    assert.equal(c.arg.by, 'human');
    assert.equal(c.arg.now, undefined);
    await call(h, 'POST', '/api/desks/lanes/fix-1/stop', JSON.stringify({ now: true }));
    assert.equal(lastCall(h, 'laneStop').arg.now, true);
    assert.equal((await call(h, 'POST', '/api/desks/lanes/fix-1/stop', JSON.stringify({ now: 'yes' }))).status, 400);
  });

  it('POST /pending/:id/approve and /reject, decided by human', async () => {
    const a = await call(h, 'POST', '/api/desks/pending/L1/approve');
    assert.equal(a.status, 200);
    assert.equal(a.json.kind, 'lane');
    assert.deepEqual([lastCall(h, 'laneApprove').arg.id, lastCall(h, 'laneApprove').arg.by], ['L1', 'human']);
    const r = await call(h, 'POST', '/api/desks/pending/L2/reject', JSON.stringify({ reason: 'too costly' }));
    assert.equal(r.status, 200);
    assert.equal(r.json.state, 'rejected');
    const c = lastCall(h, 'laneReject');
    assert.deepEqual([c.arg.id, c.arg.by, c.arg.reason], ['L2', 'human', 'too costly']);
  });

  it('POST /:name/engine -> RosterEntry; unknown desk is 404', async () => {
    const r = await call(h, 'POST', '/api/desks/ORCH/engine', JSON.stringify({ agent: 'claude', model: 'claude-sonnet-5-5' }));
    assert.equal(r.status, 200);
    assert.equal(r.json.agent, 'claude');
    const c = lastCall(h, 'deskSwitchEngine');
    assert.deepEqual([c.arg.name, c.arg.agent, c.arg.model], ['ORCH', 'claude', 'claude-sonnet-5-5']);
    assert.equal((await call(h, 'POST', '/api/desks/ORCH/engine', '{}')).status, 400);
    h.st.throwFor = { deskSwitchEngine: new Error('desks: unknown desk NOPE (known: ORCH)') };
    const nf = await call(h, 'POST', '/api/desks/NOPE/engine', JSON.stringify({ agent: 'claude' }));
    h.st.throwFor = undefined;
    assert.equal(nf.status, 404);
  });

  it('GET /:name/events?since= -> {events}', async () => {
    const r = await call(h, 'GET', '/api/desks/ORCH/events?since=3');
    assert.equal(r.status, 200);
    assert.equal(r.json.events[0].seq, 1);
    const c = lastCall(h, 'deskEvents');
    assert.deepEqual([c.arg.name, c.arg.since], ['ORCH', 3]);
  });

  it('GET /:name/attach -> {argv} from the host at the roster url; unknown is 404, dead is 409', async () => {
    h.st.view = viewOf([row('ORCH', { url: 'http://127.0.0.1:59999' }), row('GONE', { state: 'dead' })]);
    const r = await call(h, 'GET', '/api/desks/ORCH/attach');
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { argv: ['opencode', 'attach', 'http://127.0.0.1:59999'] });
    assert.deepEqual(h.attachUrls, ['http://127.0.0.1:59999']);
    const unknown = await call(h, 'GET', '/api/desks/NOPE/attach');
    assert.equal(unknown.status, 404);
    assert.match(unknown.json.error, /unknown desk or lane NOPE/);
    const dead = await call(h, 'GET', '/api/desks/GONE/attach');
    assert.equal(dead.status, 409, 'a dead desk is a conflict (DESKS.md: not running (dead))');
    assert.match(dead.json.error, /GONE is not running \(dead\)/);
    assert.equal(h.attachUrls.length, 1, 'no host call for unknown or dead names');
    assert.equal((await call(h, 'POST', '/api/desks/ORCH/attach')).status, 405);
    h.st.view = viewOf([row('ORCH')]);
  });

  it('GET /:name/attach calls the host with the bearer token from its spec (same run only)', async () => {
    const specs = deskPaths(stateDir, STACK).specs;
    mkdirSync(specs, { recursive: true });
    writeFileSync(join(specs, 'TOK.json'), JSON.stringify({ name: 'TOK', runId: 'run-TOK', token: 'hosttoken' }));
    h.st.view = viewOf([row('TOK', { url: 'http://127.0.0.1:59998' }), row('OLD', { url: 'http://127.0.0.1:59997' })]);
    writeFileSync(join(specs, 'OLD.json'), JSON.stringify({ name: 'OLD', runId: 'run-newer', token: 'other' }));
    const before = h.attachUrls.length;
    assert.equal((await call(h, 'GET', '/api/desks/TOK/attach')).status, 200);
    assert.deepEqual(h.attachUrls[before], { url: 'http://127.0.0.1:59998', token: 'hosttoken' });
    assert.equal((await call(h, 'GET', '/api/desks/OLD/attach')).status, 200);
    assert.equal(h.attachUrls[before + 1], 'http://127.0.0.1:59997', 'a spec for another run lends no token');
    const view = await call(h, 'GET', '/api/desks');
    assert.ok(!JSON.stringify(view.json).includes('hosttoken'), 'the roster answer never carries a host token');
    h.st.view = viewOf([row('ORCH')]);
  });

  it('GET /costs, /engines, /mcps', async () => {
    const costs = await call(h, 'GET', '/api/desks/costs');
    assert.equal(costs.status, 200);
    assert.equal(costs.json.rows[0].name, 'A');
    const eng = await call(h, 'GET', '/api/desks/engines');
    assert.deepEqual(eng.json, { engines: [{ agent: 'claude', found: true, path: '/bin/claude', auth: 'verified' }] });
    const mcps = await call(h, 'GET', '/api/desks/mcps');
    assert.deepEqual(mcps.json, { names: [`${STACK}:ok`] });
  });

  it('wrong method 405, unknown route 404, not-implemented service 500', async () => {
    assert.equal((await call(h, 'GET', '/api/desks/send')).status, 405);
    assert.equal((await call(h, 'POST', '/api/desks')).status, 405);
    const nf = await call(h, 'GET', '/api/desks/a/b/c/d');
    assert.equal(nf.status, 404);
    assert.ok(nf.json.error);
    h.st.throwFor = { deskCosts: new Error('desks: deskCosts not implemented yet') };
    const ni = await call(h, 'GET', '/api/desks/costs');
    h.st.throwFor = undefined;
    assert.equal(ni.status, 500);
  });

  it('a body over the cap gets a real 413 response, not a reset socket', async () => {
    const port = Number(new URL(h.base).port);
    const r = await new Promise<{ status?: number; body: string; err?: string }>((resolve) => {
      let done = false;
      const fin = (v: { status?: number; body: string; err?: string }): void => {
        if (!done) {
          done = true;
          resolve(v);
        }
      };
      const req = httpRequest({ host: '127.0.0.1', port, path: '/api/desks/send', method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${h.autoToken}` } }, (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => fin({ status: res.statusCode, body }));
      });
      req.on('error', (e) => fin({ body: '', err: String(e) }));
      const chunk = Buffer.alloc(256 * 1024, 97);
      // 8 MiB against a 1 MiB cap: the server must drain it and answer, not close on unread data (a reset).
      for (let i = 0; i < 32; i++) req.write(chunk);
      req.end();
    });
    assert.equal(r.status, 413, `expected a 413 response, got ${r.status ?? r.err}`);
    assert.match(JSON.parse(r.body).error, /body over/);
    assert.equal((await call(h, 'GET', '/api/desks')).status, 200, 'the server still serves after an oversized body');
  });

  it('a bad ?stack= or a path-shaped name segment is 400 and never reaches the service', async () => {
    const before = h.calls.length;
    for (const path of ['/api/desks?stack=..%2F..%2Fx', '/api/desks/messages?stack=../x', '/api/desks/mcps?stack=.hidden', '/api/desks/stream?stack=a%2Fb']) {
      const r = await call(h, 'GET', path);
      assert.equal(r.status, 400, path);
      assert.match(r.json.error, /invalid stack name/, path);
    }
    for (const path of ['/api/desks/..%2F..%2Fx/events', '/api/desks/a%5Cb/events', '/api/desks/.x/events']) {
      const r = await call(h, 'GET', path);
      assert.equal(r.status, 400, path);
    }
    const sw = await call(h, 'POST', '/api/desks/..%2Fx/engine', JSON.stringify({ agent: 'claude' }));
    assert.equal(sw.status, 400);
    assert.equal(h.calls.length, before, 'no service call');
  });

  it('returns false for paths outside /api/desks', async () => {
    const res = await fetch(h.base + '/api/desksx');
    assert.equal(res.status, 418);
    await res.text();
  });

  it('statusForError maps service messages', () => {
    assert.equal(statusForError(new Error('desks: unknown desk X')), 404);
    assert.equal(statusForError(new Error('desks: lane approve: only the human or the decisions desk may decide pending lanes (you are X)')), 403);
    assert.equal(statusForError(new Error('lane foo not found')), 404);
    assert.equal(statusForError(new Error('no such decision D4')), 404);
    assert.equal(statusForError(new Error('desks: stack default is already up (ORCH alive)')), 409);
    assert.equal(statusForError(new Error('refusing self-send')), 500, 'an unmatched message is a server bug, not a conflict');
    assert.equal(statusForError(new Error('something nobody wrote a rule for')), 500);
    assert.equal(statusForError(new Error('desks: invalid stack name "../x"')), 400);
    assert.equal(statusForError(new Error('desks: invalid desk or lane name "../x"')), 400);
    assert.equal(statusForError(new Error('desks: invalid run id "../x"')), 400);
    assert.equal(statusForError(new Error('desks: lane request L1 is already approving')), 409);
    assert.equal(statusForError(new Error('desks: deskUp not implemented yet')), 500);
    assert.equal(statusForError('boom'), 500);
  });

  it('statusForError: config and server failures are 500, bad input 400, conflicts 409, missing resources 404', () => {
    const cases: Array<[string, number]> = [
      // 404: a desk, lane, decision or pending item named in the request
      ['desks: unknown desk or lane "X" in stack "s"; live: A, B', 404],
      ['desks: unknown desk "X" in stack "s"', 404],
      ['desks: unknown lane "X" in stack "s"', 404],
      ['desks: no pending lane L9 in stack "s"', 404],
      ['desks: no decision D9 in stack "s"', 404],
      // 500: config or server-side failure, even though the text says "not found"
      ['desks: layout file not found: /x/desks.yaml', 500],
      ['desks: roles/common.md not found in: /a, /b', 500],
      ['desks: role file orchestrator.md not found in: /a, /b', 500],
      ['desks: invalid layout /x/desks.yaml: desks.0.name: required', 500],
      ['desks: cannot parse layout /x/desks.yaml: bad yaml', 500],
      ['desks: corrupt layout /x/layout.json: oops', 500],
      ['desks: corrupt roster /x/roster.json: oops', 500],
      ['desks: the layout has no desks', 500],
      ['desks: host ORCH did not become idle on port 4801 (timeout); log /x/log:\n...', 500],
      ['desks: no spec or layout entry for ORCH', 500],
      ['desk host GET http://127.0.0.1:1/health: HTTP 500: boom', 500],
      // 400: bad input
      ['desks: invalid lane name "a b" (want /^[a-z0-9][a-z0-9_-]{0,47}$/i)', 400],
      ['desks: lane goal must not be empty', 400],
      ['desks: message text must not be empty', 400],
      ['desks: decision options must be an array', 400],
      ['desks: every decision option needs a label', 400],
      ['desks: agent must be a non-empty string', 400],
      ['desks: ORCH cannot send to yourself', 400],
      // 409: conflicts and refusals
      ['desks: stack "s" is already up (alive: A); run `ach desk down` first', 409],
      ['desks: port(s) 4801 already in use; pick another portBase (--port-base)', 409],
      ['desks: name "x" is already in use in stack "s"', 409],
      ['desks: lane "x" is already pending approval (L1)', 409],
      ['desks: lane request L1 is already approved', 409],
      ['desks: decision D1 is closed', 409],
      ['desks: ORCH is not running (dead) in stack "s"; live: A', 409],
      ['desks: X is a lane; only desks switch engines', 409],
      ['desks: no free lane port in 4810..4819', 409],
    ];
    for (const [msg, want] of cases) assert.equal(statusForError(new Error(msg)), want, msg);
  });

  it('desks.html resyncs every loaded chat from its lastSeq after the stream (re)opens', () => {
    const html = readFileSync(join(import.meta.dirname, '..', 'src', 'web', 'desks.html'), 'utf8');
    const src = /function resyncTargets[\s\S]*?\n  }\n/.exec(html)?.[0];
    assert.ok(src, 'resyncTargets found in the page script');
    const ctx = createContext({});
    runInContext(`${src}; this.resyncTargets = resyncTargets;`, ctx);
    const out = (ctx as any).resyncTargets({
      A: { loaded: true, loading: false, lastSeq: 12 },
      B: { loaded: true, loading: false, lastSeq: 0 },
      C: { loaded: false, loading: true, lastSeq: 0 },
    }) as Array<{ name: string; since: number }>;
    assert.deepEqual([...out].map((t) => `${t.name}:${t.since}`), ['A:12', 'B:0'], 'loading chats are skipped (their history fetch replays pending events)');
    // the handlers call it: onopen and the first roster frame after it
    assert.match(html, /es\.onopen = function \(\) \{[\s\S]*?resyncChats\(\);[\s\S]*?resyncOnSnapshot = true/);
    assert.match(html, /f\.kind === "roster"\) \{[\s\S]*?if \(resyncOnSnapshot\)/);
  });

  it('desks.html retries a failed chat-history fetch: loaded is set only on success, and an in-flight load is not duplicated', async () => {
    const html = readFileSync(join(import.meta.dirname, '..', 'src', 'web', 'desks.html'), 'utf8');
    const src = /function chatOf[\s\S]*?\n  function eventNode/.exec(html)?.[0]?.replace(/function eventNode$/, '');
    assert.ok(src, 'chatOf + loadHistory found in the page script');
    let calls = 0;
    let failNext = true;
    const ctx = createContext({
      chats: {}, MAX_EVENTS: 300, es: null, errs: 0,
      api: () => {
        calls++;
        return failNext ? Promise.reject(new Error('boom')) : Promise.resolve({ events: [] });
      },
      addEvent: () => {}, renderAllChatNodes: () => {}, renderFeeds: () => {}, resyncChats: () => {},
      showErr: () => { (ctx as any).errs++; },
    });
    runInContext(`${src}; this.loadHistory = loadHistory;`, ctx);
    const row = { name: 'A', runId: 'r1' };
    (ctx as any).loadHistory(row);
    (ctx as any).loadHistory(row); // in flight: no second fetch
    assert.equal(calls, 1, 'concurrent load guarded');
    await new Promise((r) => setTimeout(r, 10));
    const c = (ctx as any).chats.A;
    assert.equal(c.loaded, false, 'a failed fetch leaves the chat unloaded');
    assert.equal(c.loading, false);
    failNext = false;
    (ctx as any).loadHistory(row);
    assert.equal(calls, 2, 'retried after the failure');
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(c.loaded, true, 'success marks it loaded');
    (ctx as any).loadHistory(row);
    assert.equal(calls, 2, 'a loaded chat is not refetched');
  });

  it('desks.html places each desk by its roster pane, falling back to port order', () => {
    const html = readFileSync(join(import.meta.dirname, '..', 'src', 'web', 'desks.html'), 'utf8');
    const src = /var SLOTS = [\s\S]*?\n  function deskSlots[\s\S]*?\n  }\n/.exec(html)?.[0];
    assert.ok(src, 'deskSlots found in the page script');
    const ctx = createContext({});
    runInContext(`${src}; this.deskSlots = deskSlots;`, ctx);
    const place = (ds: Array<{ name: string; port: number; pane?: string }>): string[] => {
      const rows = ds.map((d) => ({ ...d }));
      const slots = (ctx as any).deskSlots(rows) as string[];
      return rows.map((r, i) => `${r.name}:${slots[i]}`);
    };
    // pane wins over port order
    assert.deepEqual(place([{ name: 'A', port: 4801, pane: 'right-bottom' }, { name: 'B', port: 4802, pane: 'left' }, { name: 'C', port: 4803, pane: 'right-top' }]), ['B:left', 'C:right-top', 'A:right-bottom']);
    // no pane anywhere: port order guess
    assert.deepEqual(place([{ name: 'B', port: 4802 }, { name: 'A', port: 4801 }, { name: 'C', port: 4803 }, { name: 'D', port: 4804 }]), ['A:left', 'B:right-top', 'C:right-bottom', 'D:extra']);
    // mixed: the unset desk takes the free slot
    assert.deepEqual(place([{ name: 'A', port: 4801 }, { name: 'B', port: 4802, pane: 'left' }]), ['B:left', 'A:right-top']);
  });
});

describe('desks web api: token gate', () => {
  let h: Harness;
  before(async () => {
    h = await harness(tmp('token'), 'sekret');
  });
  after(async () => closeHarness(h));

  it('401 without the token; ?token= and Bearer pass', async () => {
    const no = await call(h, 'GET', '/api/desks');
    assert.equal(no.status, 401);
    assert.deepEqual(no.json, { error: 'unauthorized' });
    assert.equal((await call(h, 'GET', '/api/desks?token=wrong')).status, 401);
    assert.equal((await call(h, 'POST', '/api/desks/send', JSON.stringify({ to: 'A', text: 'x' }))).status, 401);
    assert.equal(h.calls.length, 0, 'no service call before auth');
    assert.equal((await call(h, 'GET', '/api/desks?token=sekret')).status, 200);
    assert.equal((await call(h, 'GET', '/api/desks', undefined, { authorization: 'Bearer sekret' })).status, 200);
  });

  it('the stream is gated too', async () => {
    const s = await openSse(`${h.base}/api/desks/stream`);
    assert.equal(s.status, 401);
    s.close();
    const ok = await openSse(`${h.base}/api/desks/stream?token=sekret`);
    assert.equal(ok.status, 200);
    await ok.waitFor((f) => f.kind === 'roster');
    ok.close();
    await until(() => openDesksStreamCount() === 0);
  });
});

describe('desks web api: stream', () => {
  let h: Harness;
  let stateDir: string;
  before(async () => {
    stateDir = tmp('stream');
    h = await harness(stateDir);
  });
  after(async () => closeHarness(h));

  it('roster on connect, message within 1 s, folded decisions, host events, roster changes, cleanup', async () => {
    const p = deskPaths(stateDir, STACK);
    mkdirSync(p.root, { recursive: true });
    appendFileSync(p.messages, JSON.stringify({ id: 'old', from: 'A', to: 'B', text: 'before connect', at: 1, delivered: 'now' }) + '\n');
    h.st.view = viewOf([row('ORCH'), row('DECISIONS', { port: 4802 })]);

    const s = await openSse(`${h.base}/api/desks/stream?stack=${STACK}`);
    assert.equal(s.status, 200);
    const first = await s.waitFor(() => true);
    assert.equal(first.kind, 'roster', 'the first frame is the roster');
    assert.deepEqual(first.view.rows.map((r: RosterRow) => r.name), ['ORCH', 'DECISIONS']);
    assert.equal(lastCall(h, 'deskRoster').arg.prune, false, 'the stream never prunes (no self-triggered roster writes)');

    // host subscriptions start at the host's last seq, one per live row
    await until(() => h.subs.length === 2);
    assert.deepEqual(h.subs.map((x) => x.since), [7, 7]);
    h.subs[0]!.emit({ seq: 8, at: 2, runId: 'run-ORCH', name: 'ORCH', type: 'text', data: { text: 'thinking' } });
    const ev = await s.waitFor((f) => f.kind === 'event');
    assert.equal(ev.event.data.text, 'thinking');

    // a desk_send appended to messages.jsonl arrives within 1 s; history before connect does not replay
    const m: DeskMessage = { id: 'm-live', from: 'ORCH', to: 'DECISIONS', text: 'need a call', at: Date.now(), delivered: 'now' };
    const t0 = Date.now();
    appendFileSync(p.messages, JSON.stringify(m) + '\n');
    const got = await s.waitFor((f) => f.kind === 'message' && f.message.id === 'm-live', 1000);
    assert.ok(Date.now() - t0 < 1000);
    assert.deepEqual(got.message, m);
    assert.ok(!s.frames.some((f) => f.kind === 'message' && f.message.id === 'old'));

    // a torn line is held until its newline arrives
    const torn = JSON.stringify({ id: 'm-torn', from: 'human', to: 'ORCH', text: 'split', at: 3, delivered: 'queued' });
    appendFileSync(p.messages, torn.slice(0, 20));
    await new Promise((r) => setTimeout(r, 700));
    appendFileSync(p.messages, torn.slice(20) + '\n');
    await s.waitFor((f) => f.kind === 'message' && f.message.id === 'm-torn', 1000);
    assert.equal(s.frames.filter((f) => f.kind === 'message' && f.message.id === 'm-torn').length, 1);

    // decisions arrive folded
    const open: DecisionEvent = { type: 'open', decision: { id: 'D1', question: 'merge?', options: [{ label: 'yes', recommended: true, reason: 'green' }, { label: 'no' }], askedBy: 'ORCH', openedBy: 'DECISIONS', openedAt: 10 } };
    appendFileSync(p.decisions, JSON.stringify(open) + '\n');
    const d1 = await s.waitFor((f) => f.kind === 'decision' && f.decision.id === 'D1');
    assert.equal(d1.decision.state, 'open');
    assert.equal(d1.decision.options[0].label, 'yes');
    const ans: DecisionEvent = { type: 'answer', id: 'D1', text: 'yes', by: 'human', at: 11 };
    appendFileSync(p.decisions, JSON.stringify(ans) + '\n');
    const d2 = await s.waitFor((f) => f.kind === 'decision' && f.decision.state === 'answered');
    assert.deepEqual(d2.decision.answer, { text: 'yes', by: 'human', at: 11 });
    assert.equal(d2.decision.question, 'merge?', 'folded: the answer frame carries the whole decision');

    // roster.json replaced by rename (as updateRoster does) -> new roster frame, subscriptions diffed
    const rosterFrames = () => s.frames.filter((f) => f.kind === 'roster').length;
    const before = rosterFrames();
    h.st.view = viewOf([row('ORCH'), row('LANE1', { kind: 'lane', port: 4810 })]);
    writeFileSync(p.roster + '.tmp', '{"entries":{}}');
    renameSync(p.roster + '.tmp', p.roster);
    const r2 = await s.waitFor((f) => f.kind === 'roster' && f.view.rows.some((x: RosterRow) => x.name === 'LANE1'));
    assert.ok(rosterFrames() > before);
    assert.ok(r2);
    await until(() => h.subs.length === 3);
    assert.equal(h.subs.find((x) => urlOf(x.url).endsWith('/DECISIONS'))!.unsubscribed, true, 'removed row is unsubscribed');
    assert.equal(h.subs.find((x) => urlOf(x.url).endsWith('/ORCH'))!.unsubscribed, false, 'kept row keeps its subscription');
    assert.equal(h.subs.filter((x) => urlOf(x.url).endsWith('/ORCH')).length, 1, 'kept row is not resubscribed');

    // closing the client cleans up every subscription and the stream itself
    assert.equal(openDesksStreamCount(), 1);
    s.close();
    await until(() => openDesksStreamCount() === 0);
    assert.ok(h.subs.every((x) => x.unsubscribed), 'all host subscriptions closed');
    const callsAfter = h.calls.length;
    appendFileSync(p.roster, ' ');
    await new Promise((r) => setTimeout(r, 900));
    assert.equal(h.calls.length, callsAfter, 'no roster refresh after close (watchers and timers gone)');
  });

  it('a stack dir created after connect is picked up (poll fallback)', async () => {
    const stack = 'late';
    const p = deskPaths(stateDir, stack);
    const s = await openSse(`${h.base}/api/desks/stream?stack=${stack}`);
    await s.waitFor((f) => f.kind === 'roster');
    mkdirSync(p.root, { recursive: true });
    const t0 = Date.now();
    appendFileSync(p.messages, JSON.stringify({ id: 'late-1', from: 'A', to: 'B', text: 'x', at: 1, delivered: 'now' }) + '\n');
    await s.waitFor((f) => f.kind === 'message' && f.message.id === 'late-1', 1000);
    assert.ok(Date.now() - t0 < 1000);
    s.close();
    await until(() => openDesksStreamCount() === 0);
  });

  it('a client that never drains is cut off at the buffer cap: queued bytes stay bounded and later events are not written', async () => {
    const sd = tmp('stream-slow');
    let queued = 0; // what a non-draining client leaves queued on the response (the stub's writableLength)
    let writesAfterDestroy = 0;
    let destroyed = false;
    let writeFalse = 0;
    const slow = await harness(sd, undefined, false, (res) => {
      const realWrite = res.write.bind(res) as (...a: unknown[]) => boolean;
      (res as unknown as { write: (c: unknown, ...r: unknown[]) => boolean }).write = (c, ...r) => {
        if (destroyed) writesAfterDestroy++;
        queued += Buffer.byteLength(String(c));
        realWrite(c, ...r);
        writeFalse++;
        return false; // backpressure: the client is not reading
      };
      Object.defineProperty(res, 'writableLength', { get: () => (destroyed ? 0 : queued) });
      const realDestroy = res.destroy.bind(res);
      res.destroy = ((e?: Error) => {
        destroyed = true;
        return realDestroy(e);
      }) as typeof res.destroy;
    });
    try {
      const s = await openSse(`${slow.base}/api/desks/stream?stack=${STACK}`);
      await s.waitFor((f) => f.kind === 'roster');
      await until(() => slow.subs.length === 1);
      const big = 'x'.repeat(64 * 1024);
      let peak = 0;
      for (let i = 0; i < 80; i++) {
        slow.subs[0]!.emit({ seq: 10 + i, at: i, runId: 'run-ORCH', name: 'ORCH', type: 'text', data: { text: big } });
        peak = Math.max(peak, queued);
      }
      assert.ok(destroyed, 'the response was destroyed once the buffer passed the cap');
      assert.ok(writeFalse > 0, 'precondition: write() returned false');
      assert.equal(writesAfterDestroy, 0, 'nothing is written after the cut');
      assert.ok(peak <= STREAM_MAX_BUFFERED_BYTES + 128 * 1024, `queued bytes stayed bounded (peak ${peak}, cap ${STREAM_MAX_BUFFERED_BYTES})`);
      assert.ok(peak < 80 * big.length, 'far less than all 80 events were queued');
      await until(() => openDesksStreamCount() === 0);
      assert.ok(slow.subs[0]!.unsubscribed, 'host subscription released');
      s.close();
    } finally {
      await closeHarness(slow);
    }
  });
});

describe('desks web api: engines and mcps (real probes, hermetic env)', () => {
  it('probeEngines reports found/path/auth from the doctor checks', async () => {
    const dir = tmp('engines');
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'claude'), '#!/bin/sh\necho "1.2.3 (Claude Code)"\n');
    chmodSync(join(bin, 'claude'), 0o755);
    const env = { PATH: bin, HOME: dir, ANTHROPIC_API_KEY: 'sk-ant-test-value' };
    const engines = await probeEngines(env, join(dir, 'state'));
    const claude = engines.find((e) => e.agent === 'claude');
    assert.deepEqual(claude, { agent: 'claude', found: true, path: join(bin, 'claude'), auth: 'verified' });
    const codex = engines.find((e) => e.agent === 'codex');
    assert.equal(codex?.found, false);
    assert.equal(codex?.path, undefined);
    assert.ok(engines.some((e) => e.agent === 'opencode'));
    assert.ok(engines.some((e) => e.agent === 'kiro'), 'every adapter is listed');
  });

  it('listDeskMcps unions the stack layout and the user MCP config', async () => {
    const dir = tmp('mcps');
    const p = deskPaths(dir, 's');
    mkdirSync(p.root, { recursive: true });
    writeFileSync(
      p.layout,
      JSON.stringify({ portBase: 4800, desks: [{ name: 'A', role: 'a', mcps: ['tracker', 'ach'] }], lanes: { defaultMcps: ['github'], ports: [10, 99] }, mcpServers: { wiki: { command: 'wiki' } } }),
    );
    mkdirSync(join(dir, 'home', '.config', 'opencode'), { recursive: true });
    writeFileSync(join(dir, 'home', '.config', 'opencode', 'opencode.json'), JSON.stringify({ mcp: { sentry: { type: 'remote', url: 'https://x' } } }));
    const names = await listDeskMcps(dir, 's', { HOME: join(dir, 'home'), PATH: '' });
    assert.deepEqual(names, ['github', 'sentry', 'tracker', 'wiki']);
  });
});

describe('desks page via ach web', () => {
  let srv: WebServerHandle;
  let base: string;
  before(async () => {
    srv = await startWebServer({ port: 0, host: '127.0.0.1', stateDir: tmp('page'), token: 'tok' });
    base = `http://127.0.0.1:${srv.port}`;
  });
  after(async () => srv.close());

  it('GET /desks serves the page with every main region and a script that compiles', async () => {
    const res = await fetch(`${base}/desks`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /text\/html/);
    const html = await res.text();
    for (const id of ['desk-grid', 'lane-strip', 'lane-cards', 'new-lane-form', 'nl-mcps', 'nl-agent', 'timeline', 'timeline-filter', 'decisions', 'pending', 'feed-panel', 'costs', 'lane-modal']) {
      assert.ok(html.includes(`id="${id}"`), `missing #${id}`);
    }
    assert.match(html, /<title>ach desks<\/title>/);
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]!);
    assert.equal(scripts.length, 1);
    assert.doesNotThrow(() => new Script(scripts[0]!, { filename: 'desks.html' }));
    assert.ok(!/innerHTML/.test(scripts[0]!), 'agent text must go in as textContent');
    for (const route of ['/stream', '/send', '/decisions/', '/lanes', '/pending/', '/costs', '/engines', '/mcps', '/events?since=', '/engine', '/up', '/down']) {
      assert.ok(scripts[0]!.includes(route), `page never calls ${route}`);
    }
    assert.ok(scripts[0]!.includes('data.active'), 'the live feed uses feed data.active');
    assert.ok(scripts[0]!.includes('"token="'), 'the page forwards ?token= like the other pages');
  });

  it('ach web routes /api/desks through the token gate', async () => {
    const no = await fetch(`${base}/api/desks`);
    assert.equal(no.status, 401);
    await no.text();
    const yes = await fetch(`${base}/api/desks/send?token=tok`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(yes.status, 400, 'authorized request reaches body validation');
    await yes.text();
  });
});
