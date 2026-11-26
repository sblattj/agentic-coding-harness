import { fileURLToPath } from 'node:url';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createContext, runInContext } from 'node:vm';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { WebSocket } from 'ws';
import { captureEvent } from '../src/core/capture.ts';
import { writeRunRecord, type RunRecord } from '../src/core/registry.ts';
import type { AgentEvent } from '../src/core/types.ts';
import { startWebServer } from '../src/web/server.ts';

/*
 * #93: the chat-style transcript layout (HarnessFeed.createTranscript in
 * src/web/feed.js). feed.js is a browser IIFE, so it runs in a vm context
 * over a small DOM shim (same approach as tests/web-feed.test.ts) that also
 * dispatches click listeners, so the collapsible tool blocks can be toggled.
 * The end-to-end cases drive the real `startWebServer` /ws run socket with
 * the real `ws` client, through the page's own `HarnessFeed.connect`.
 */

const HERE = fileURLToPath(new URL('.', import.meta.url));
const FEED_SRC = readFileSync(join(HERE, '../src/web/feed.js'), 'utf8');
const INDEX_HTML = readFileSync(join(HERE, '../src/web/index.html'), 'utf8');
const T0 = Date.parse('2026-09-13T12:00:00Z');

type Listener = (e: unknown) => void;

class Node {
  tagName: string;
  className = '';
  children: Node[] = [];
  parentNode: Node | null = null;
  style: Record<string, string> = {};
  attributes: Record<string, string> = {};
  listeners: Record<string, Listener[]> = {};
  hidden = false;
  type = '';
  id = '';
  tabIndex = 0;
  scrollTop = 0;
  scrollHeight = 0;
  clientHeight = 0;
  private own = '';
  [extra: string]: unknown;

  constructor(tagName: string) {
    this.tagName = tagName;
  }

  get textContent(): string {
    if (this.children.length > 0) return this.children.map((c) => c.textContent).join('');
    return this.own;
  }

  set textContent(value: string) {
    for (const c of this.children) c.parentNode = null;
    this.children = [];
    this.own = value === null || value === undefined ? '' : String(value);
  }

  get firstChild(): Node | null {
    return this.children[0] ?? null;
  }

  get childElementCount(): number {
    return this.children.length;
  }

  get classList(): { add: (cls: string) => void; remove: (cls: string) => void } {
    const self = this;
    return {
      add(cls: string): void {
        const tokens = self.className.split(/\s+/).filter((t) => t !== '');
        if (!tokens.includes(cls)) tokens.push(cls);
        self.className = tokens.join(' ');
      },
      remove(cls: string): void {
        self.className = self.className.split(/\s+/).filter((t) => t !== '' && t !== cls).join(' ');
      },
    };
  }

  appendChild(child: Node): Node {
    if (child.parentNode !== null) child.parentNode.removeChild(child);
    this.own = '';
    this.children.push(child);
    child.parentNode = this;
    return child;
  }

  insertBefore(child: Node, ref: Node | null): Node {
    if (ref === null) return this.appendChild(child);
    if (child.parentNode !== null) child.parentNode.removeChild(child);
    const at = this.children.indexOf(ref);
    this.children.splice(at < 0 ? this.children.length : at, 0, child);
    child.parentNode = this;
    return child;
  }

  removeChild(child: Node): Node {
    const at = this.children.indexOf(child);
    if (at >= 0) this.children.splice(at, 1);
    child.parentNode = null;
    return child;
  }

  setAttribute(name: string, value: string): void {
    this.attributes[name] = value;
  }

  getAttribute(name: string): string | null {
    return this.attributes[name] ?? null;
  }

  addEventListener(type: string, fn: Listener): void {
    (this.listeners[type] ??= []).push(fn);
  }

  click(): void {
    for (const fn of this.listeners.click ?? []) fn({ stopPropagation() {}, preventDefault() {} });
  }
}

interface ToolModel {
  name: string;
  summary: string;
  status: string;
  durationMs: number | null;
  args: unknown;
  argsStripped: boolean;
  result: unknown;
  resultStripped: boolean;
}
interface ItemModel {
  kind: string;
  text?: string | null;
  stripped?: boolean;
  ts: number | null;
  tool?: ToolModel;
}
interface TurnModel {
  index: number;
  startedAt: number | null;
  prompt: { text: string | null; stripped: boolean; from: string | null; ts: number | null } | null;
  items: ItemModel[];
}
interface TranscriptHandle {
  append(events: unknown[]): TranscriptHandle;
  reset(): TranscriptHandle;
  setEnded(note?: string): TranscriptHandle;
  setRecord(rec: unknown): TranscriptHandle;
  destroy(): void;
  turns(): TurnModel[];
  count: number;
}
interface FeedGlobal {
  create(container: Node, opts?: Record<string, unknown>): { append(e: unknown[]): unknown; count: number };
  createTranscript(container: Node, opts?: Record<string, unknown>): TranscriptHandle;
  connect(feed: unknown, opts: Record<string, unknown>): { close(): void };
}

function loadFeed(extra: Record<string, unknown> = {}): FeedGlobal {
  const documentShim = {
    createElement: (tag: string) => new Node(tag),
    getElementById: () => null,
    head: new Node('head'),
  };
  const ctx = createContext({ document: documentShim, console, ...extra });
  runInContext('globalThis.window = globalThis;', ctx);
  runInContext(FEED_SRC, ctx);
  const feed = runInContext('window.HarnessFeed', ctx) as FeedGlobal | undefined;
  assert.ok(feed, 'feed.js did not expose window.HarnessFeed');
  return feed;
}

const HF = loadFeed();

function mount(opts?: Record<string, unknown>): { container: Node; tx: TranscriptHandle } {
  const container = new Node('div');
  return { container, tx: HF.createTranscript(container, opts) };
}

function withClass(root: Node, cls: string): Node[] {
  const found: Node[] = [];
  const walk = (n: Node): void => {
    if (n.className.split(/\s+/).includes(cls)) found.push(n);
    for (const c of n.children) walk(c);
  };
  walk(root);
  return found;
}

/** Plain JSON copy: vm-realm objects fail deepEqual's prototype check. */
function plain<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

function deq(actual: unknown, expected: unknown, message?: string): void {
  assert.deepEqual(plain(actual), plain(expected), message);
}

const user = (text: string, ts: number): AgentEvent => ({ type: 'message', source: 'user', content: text, timestamp: ts });
const agent = (text: string, ts: number): AgentEvent => ({ type: 'message', source: 'agent', content: text, timestamp: ts });
const call = (id: string, name: string, args: Record<string, unknown>, ts: number): AgentEvent => ({
  type: 'tool_call',
  toolCallId: id,
  functionName: name,
  arguments: args,
  timestamp: ts,
});
const result = (id: string, content: string, ts: number, isError = false): AgentEvent => ({
  type: 'tool_result',
  toolCallId: id,
  content,
  isError,
  timestamp: ts,
});

/** A two-turn conversation with tools, as the persisted transcript lane writes it. */
function twoTurns(): AgentEvent[] {
  return [
    { type: 'session_start', agent: 'codex', timestamp: T0 },
    user('list the files', T0 + 100),
    agent('Looking at the directory.', T0 + 1_000),
    call('c1', 'shell', { command: 'ls -la' }, T0 + 1_200),
    { type: 'usage', usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 }, timestamp: T0 + 1_300 },
    result('c1', 'a.txt\nb.txt', T0 + 2_700),
    agent('There are two files.', T0 + 3_000),
    user('now count the lines', T0 + 10_000),
    call('c2', 'shell', { command: 'wc -l a.txt' }, T0 + 10_500),
    result('c2', 'wc: a.txt: permission denied', T0 + 10_750, true),
    agent('I could not read a.txt.', T0 + 11_000),
    { type: 'done', exitStatus: 'success', timestamp: T0 + 12_000 },
  ];
}

describe('transcript layout (#93)', () => {
  it('groups the AgentEvent stream into prompt/response turns with tool blocks', () => {
    const { container, tx } = mount();
    tx.append(twoTurns());
    const turns = tx.turns();
    assert.equal(turns.length, 2);
    assert.equal(turns[0]!.prompt?.text, 'list the files');
    deq(turns[0]!.items.map((i) => i.kind), ['message', 'tool', 'message']);
    assert.equal(turns[0]!.items[0]!.text, 'Looking at the directory.');
    assert.equal(turns[0]!.items[2]!.text, 'There are two files.');
    const tool = turns[0]!.items[1]!.tool!;
    assert.equal(tool.name, 'shell');
    assert.equal(tool.summary, 'ls -la');
    assert.equal(tool.status, 'ok');
    assert.equal(tool.durationMs, 1_500);
    assert.equal(turns[1]!.prompt?.text, 'now count the lines');
    assert.equal(turns[1]!.items[0]!.tool!.status, 'error');
    // DOM: two turn sections, a user bubble each, three agent bubbles, two tool blocks
    assert.equal(withClass(container, 'tx-turn').length, 2);
    deq(withClass(container, 'tx-user').map((n) => withClass(n, 'tx-text')[0]!.textContent), [
      'list the files',
      'now count the lines',
    ]);
    assert.equal(withClass(container, 'tx-agent').length, 3);
    assert.equal(withClass(container, 'tx-tool').length, 2);
    // usage rows are feed material: not a chat item
    assert.ok(!container.textContent.includes('10 in'));
  });

  it('tool calls render collapsed (name, summary, duration) and expand to arguments and result', () => {
    const { container, tx } = mount();
    tx.append(twoTurns().slice(0, 6));
    const block = withClass(container, 'tx-tool')[0]!;
    const head = withClass(block, 'hf-head')[0]!;
    const detail = withClass(block, 'hf-detail')[0]!;
    assert.equal(withClass(head, 'hf-fn')[0]!.textContent, 'shell');
    assert.equal(withClass(head, 'hf-args')[0]!.textContent, 'ls -la');
    assert.equal(withClass(head, 'hf-ms')[0]!.textContent, '1.5s');
    assert.equal(detail.hidden, true, 'collapsed by default');
    assert.equal(head.getAttribute('aria-expanded'), 'false');
    head.click();
    assert.equal(detail.hidden, false, 'a click expands it');
    assert.equal(head.getAttribute('aria-expanded'), 'true');
    const pres = withClass(detail, 'hf-pre').map((n) => n.textContent);
    assert.ok(pres[0]!.includes('"command": "ls -la"'), pres[0]);
    assert.equal(pres[1], 'a.txt\nb.txt');
    head.click();
    assert.equal(detail.hidden, true, 'a second click collapses it');
  });

  it('multi-turn runs keep every turn in order with its own timestamps', () => {
    const { container, tx } = mount();
    tx.append(twoTurns());
    const turns = tx.turns();
    deq(turns.map((t) => t.index), [1, 2]);
    deq(turns.map((t) => t.startedAt), [T0 + 100, T0 + 10_000]);
    deq(turns.map((t) => t.prompt?.ts), [T0 + 100, T0 + 10_000]);
    deq(turns[0]!.items.map((i) => i.ts), [T0 + 1_000, T0 + 1_200, T0 + 3_000]);
    // every bubble carries the event's own ISO timestamp, in stream order
    const isoStamps = withClass(container, 'tx-ts')
      .map((n) => n.getAttribute('title'))
      .filter((t): t is string => t !== null);
    const want = [
      T0 + 100, T0 + 100, T0 + 1_000, T0 + 1_200, T0 + 3_000,
      T0 + 10_000, T0 + 10_000, T0 + 10_500, T0 + 11_000,
    ].map((ms) => new Date(ms).toISOString());
    deq(isoStamps, want);
    // headers name the turns in order
    const heads = withClass(container, 'tx-turn-head').map((h) => h.children[0]!.textContent);
    deq(heads, ['turn 1', 'turn 2']);
  });

  it('a headless run (no user message event) opens turn 1 from the record prompt preview, labelled as such', () => {
    const { container, tx } = mount({ record: { runId: 'r', promptPreview: 'fix the build', captureMode: 'full' } });
    tx.append([agent('Done.', T0)]);
    const t = tx.turns()[0]!;
    assert.equal(t.prompt?.from, 'record-preview');
    assert.equal(t.prompt?.text, 'fix the build');
    assert.ok(container.textContent.includes('prompt preview from the run record'));
    const bare = mount();
    bare.tx.append([agent('Done.', T0)]);
    assert.equal(bare.tx.turns()[0]!.prompt?.text, null);
    assert.ok(bare.container.textContent.includes('prompt not in the transcript'));
    // the record can arrive after the backlog (connect order): the block updates
    bare.tx.setRecord({ runId: 'r', promptPreview: 'fix the build' });
    assert.equal(bare.tx.turns()[0]!.prompt?.text, 'fix the build');
  });

  it('streamed chunks coalesce into one reply bubble and a confirming message does not draw it twice', () => {
    const { container, tx } = mount();
    const chunk = (text: string, ts: number): AgentEvent => ({
      type: 'step',
      timestamp: ts,
      data: { kind: 'chunk', text, chunkKind: 'agent_message_chunk' },
    });
    tx.append([user('hi', T0), chunk('Hel', T0 + 1), chunk('lo.', T0 + 2), agent('Hello.', T0 + 3)]);
    deq(withClass(container, 'tx-agent').map((n) => withClass(n, 'tx-text')[0]!.textContent), ['Hello.']);
    assert.equal(tx.turns()[0]!.items.length, 1);
  });

  it('follows the tail at the bottom; scrolled up, new events raise the latest pill instead', () => {
    const { container, tx } = mount();
    const pill = withClass(container, 'hf-pill')[0]!;
    tx.append([user('a', T0)]);
    assert.equal(pill.hidden, true, 'at the bottom: follow');
    container.scrollHeight = 1_000;
    container.clientHeight = 100;
    container.scrollTop = 0;
    tx.append([agent('b', T0 + 1)]);
    assert.equal(pill.hidden, false, 'scrolled up: pause and offer the pill');
    pill.click();
    assert.equal(container.scrollTop, 1_000);
    assert.equal(pill.hidden, true);
  });

  it('the feed renderer is untouched: create() still draws its own rows, not turns', () => {
    const container = new Node('div');
    const feed = HF.create(container);
    feed.append(twoTurns());
    assert.equal(withClass(container, 'tx-turn').length, 0);
    assert.ok(withClass(container, 'hf-row').length > 0);
    assert.ok(withClass(container, 'hf-msg-user').length === 2);
  });
});

describe('transcript honesty under content capture tiers (#72 x #93)', () => {
  it('metadata tier: stripped text renders as a "not captured" note, never as the agent saying [STRIPPED]', () => {
    const stripped = twoTurns().map((e) => captureEvent('metadata', e)).filter((e): e is AgentEvent => e !== null);
    const { container, tx } = mount({ record: { runId: 'r', captureMode: 'metadata' } });
    tx.append(stripped);
    const turns = tx.turns();
    assert.equal(turns.length, 2, 'turn structure survives stripping');
    assert.equal(turns[0]!.prompt?.stripped, true);
    assert.equal(turns[0]!.prompt?.text, null);
    assert.equal(turns[0]!.items[0]!.stripped, true);
    const tool = turns[0]!.items[1]!.tool!;
    assert.equal(tool.name, 'shell', 'tool names are structure and stay');
    assert.equal(tool.argsStripped, true);
    assert.equal(tool.resultStripped, true);
    assert.equal(tool.durationMs, 1_500, 'timings stay');
    assert.equal(turns[1]!.items[0]!.tool!.status, 'error', 'status stays');
    // visible text: no bare marker outside the arguments' recorded-shape dump
    const visible = withClass(container, 'tx-text').map((n) => n.textContent);
    assert.ok(visible.every((t) => !t.includes('[STRIPPED]')), JSON.stringify(visible));
    assert.ok(visible.includes('prompt not captured (capture mode metadata)'), JSON.stringify(visible));
    assert.ok(visible.includes('reply not captured (capture mode metadata)'), JSON.stringify(visible));
    assert.equal(withClass(container, 'hf-args')[0]!.textContent, 'arguments not captured (capture mode metadata)');
    const banner = withClass(container, 'tx-banner')[0]!;
    assert.equal(banner.hidden, false);
    assert.ok(banner.textContent.startsWith('capture mode metadata'), banner.textContent);
  });

  it('metadata tier without the record still never shows the marker as text', () => {
    const { container, tx } = mount();
    tx.append([captureEvent('metadata', user('secret prompt', T0))!, captureEvent('metadata', agent('secret reply', T0 + 1))!]);
    const visible = withClass(container, 'tx-text').map((n) => n.textContent);
    deq(visible, ['prompt not captured (stripped at record time)', 'reply not captured (stripped at record time)']);
  });

  it('off tier: no conversation events, and the banner says why instead of an empty chat', () => {
    const kept = twoTurns().map((e) => captureEvent('off', e)).filter((e): e is AgentEvent => e !== null);
    deq(kept.map((e) => e.type), ['session_start', 'usage', 'done'], 'fixture check: off keeps lifecycle + tokens');
    const { container, tx } = mount({ record: { runId: 'r', captureMode: 'off' } });
    tx.append(kept);
    assert.equal(tx.turns().length, 0);
    const banner = withClass(container, 'tx-banner')[0]!;
    assert.equal(banner.hidden, false);
    assert.ok(banner.textContent.startsWith('capture mode off'), banner.textContent);
    assert.equal(withClass(container, 'tx-empty')[0]!.hidden, true, 'the generic empty note gives way to the banner');
    assert.ok(container.textContent.includes('-- SUCCESS --'));
  });
});

describe('run page wiring (#93)', () => {
  it('index.html offers a feed | transcript toggle, feed by default, transcript via createTranscript', () => {
    assert.match(INDEX_HTML, /<button[^>]*data-view="feed"[^>]*>feed<\/button>/);
    assert.match(INDEX_HTML, /<button[^>]*data-view="transcript"[^>]*>transcript<\/button>/);
    assert.match(INDEX_HTML, /HarnessFeed\.createTranscript\(/);
    // the feed branch is the default and keeps its exact create() call
    assert.match(INDEX_HTML, /var viewMode = [^\n]*: "feed";/);
    assert.ok(INDEX_HTML.includes('window.HarnessFeed.create($("feed"), { keepEvents: false })'));
  });
});

// ------------------------------------------------- end to end: real server

function rec(id: string, over: Partial<RunRecord>): RunRecord {
  return {
    runId: id,
    agent: 'codex',
    pid: process.pid,
    cwd: '/tmp/proj',
    startedAt: T0,
    updatedAt: T0,
    status: 'success',
    exitStatus: 'success',
    totals: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 },
    ...over,
  };
}

async function until(cond: () => boolean, what: string, ms = 8_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe('transcript over the real /ws run socket (#93)', () => {
  let stateDir = '';
  let server: Awaited<ReturnType<typeof startWebServer>> | null = null;
  let hf: FeedGlobal;

  before(async () => {
    stateDir = mkdtempSync(join(tmpdir(), 'ach-web-transcript-'));
    mkdirSync(join(stateDir, 'raw'), { recursive: true });
    const done = join(stateDir, 'raw', 'done.jsonl');
    writeFileSync(done, twoTurns().map((e) => JSON.stringify(e)).join('\n') + '\n');
    writeRunRecord(stateDir, rec('run-done', { rawTranscript: done }));
    const meta = join(stateDir, 'raw', 'meta.jsonl');
    writeFileSync(meta, twoTurns().map((e) => JSON.stringify(captureEvent('metadata', e))).join('\n') + '\n');
    writeRunRecord(stateDir, rec('run-meta', { rawTranscript: meta, captureMode: 'metadata', captureSource: 'flag' }));
    server = await startWebServer({ port: 0, host: '127.0.0.1', token: 't', stateDir });
    hf = loadFeed({ WebSocket, location: { protocol: 'http:', host: `127.0.0.1:${server.port}` } });
  });

  after(async () => {
    await server?.close();
    rmSync(stateDir, { recursive: true, force: true });
  });

  it('a finished run arrives as backlog and renders every turn from the persisted events', async () => {
    const container = new Node('div');
    const tx = hf.createTranscript(container);
    let ended = false;
    const conn = hf.connect(tx, { runId: 'run-done', token: 't', onEnd: () => { ended = true; } });
    try {
      await until(() => ended, 'end');
      assert.equal(tx.turns().length, 2);
      deq(tx.turns().map((t) => t.prompt?.text), ['list the files', 'now count the lines']);
      assert.ok(container.textContent.includes('-- stream ended --'));
    } finally {
      conn.close();
    }
  });

  it('connect() hands the record to the transcript: the capture tier banner comes from the server', async () => {
    const container = new Node('div');
    const tx = hf.createTranscript(container);
    let ended = false;
    const conn = hf.connect(tx, { runId: 'run-meta', token: 't', onEnd: () => { ended = true; } });
    try {
      await until(() => ended, 'end');
      const banner = withClass(container, 'tx-banner')[0]!;
      assert.equal(banner.hidden, false);
      assert.ok(banner.textContent.startsWith('capture mode metadata'), banner.textContent);
      assert.ok(withClass(container, 'tx-text').some((n) => n.textContent === 'reply not captured (capture mode metadata)'));
    } finally {
      conn.close();
    }
  });

  it('a live run updates the transcript as the server tails new events', async () => {
    const live = join(stateDir, 'raw', 'live.jsonl');
    writeFileSync(live, [user('first ask', T0), agent('first answer', T0 + 1)].map((e) => JSON.stringify(e)).join('\n') + '\n');
    writeRunRecord(stateDir, rec('run-live', { rawTranscript: live, status: 'running', exitStatus: undefined, updatedAt: Date.now() }));
    const container = new Node('div');
    const tx = hf.createTranscript(container);
    const conn = hf.connect(tx, { runId: 'run-live', token: 't' });
    try {
      await until(() => tx.turns().length === 1 && tx.turns()[0]!.items.length === 1, 'backlog turn');
      appendFileSync(live, JSON.stringify(user('second ask', T0 + 5_000)) + '\n');
      appendFileSync(live, JSON.stringify(call('k1', 'read_file', { path: 'a.txt' }, T0 + 5_100)) + '\n');
      await until(() => tx.turns().length === 2 && tx.turns()[1]!.items.length === 1, 'tailed second turn');
      assert.equal(tx.turns()[1]!.prompt?.text, 'second ask');
      assert.equal(tx.turns()[1]!.items[0]!.tool!.status, 'pending');
      appendFileSync(live, JSON.stringify(result('k1', 'hello', T0 + 5_400)) + '\n');
      await until(() => tx.turns()[1]!.items[0]!.tool!.status === 'ok', 'tailed tool result');
      assert.equal(tx.turns()[1]!.items[0]!.tool!.durationMs, 300);
    } finally {
      conn.close();
    }
  });
});
