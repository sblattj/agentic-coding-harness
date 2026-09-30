import { fileURLToPath } from "node:url";
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createContext, runInContext } from 'node:vm';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createFrameAnnotator } from '../src/web/context-frames.ts';
import type { AgentEvent } from '../src/core/types.ts';

/*
 * src/web/feed.js is a browser IIFE with no module system, so it is loaded into
 * a vm context over a hand-written DOM shim — small enough to stay honest, and
 * it keeps the dashboard's only stateful renderer under test without pulling in
 * a DOM package. connect()/WebSocket/location are never exercised here.
 */

const FEED_SRC = readFileSync(join(fileURLToPath(new URL('.', import.meta.url)), '../src/web/feed.js'), 'utf8');
const T0 = Date.parse('2026-09-13T12:00:00Z');

/** The subset of Element that feed.js actually touches. */
class Node {
  tagName: string;
  className = '';
  children: Node[] = [];
  parentNode: Node | null = null;
  style: Record<string, string> = {};
  attributes: Record<string, string> = {};
  hidden = false;
  type = '';
  id = '';
  tabIndex = 0;
  scrollTop = 0;
  scrollHeight = 0;
  clientHeight = 0;
  private own = '';

  constructor(tagName: string) {
    this.tagName = tagName;
  }

  get textContent(): string {
    if (this.children.length > 0) return this.children.map((c) => c.textContent).join('');
    return this.own;
  }

  /** Matches the real setter: assigning text drops every child node. */
  set textContent(value: string) {
    this.children = [];
    this.own = value === null || value === undefined ? '' : String(value);
  }

  get firstChild(): Node | null {
    return this.children.length > 0 ? this.children[0]! : null;
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
        self.className = self.className
          .split(/\s+/)
          .filter((t) => t !== '' && t !== cls)
          .join(' ');
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

  removeChild(child: Node): Node {
    const at = this.children.indexOf(child);
    if (at >= 0) this.children.splice(at, 1);
    child.parentNode = null;
    return child;
  }

  setAttribute(name: string, value: string): void {
    this.attributes[name] = value;
  }

  addEventListener(): void {
    /* the feed only registers scroll/click handlers; nothing dispatches here */
  }
}

interface FeedHandle {
  append(events: unknown[]): FeedHandle;
  reset(): FeedHandle;
  setEnded(note?: string): FeedHandle;
  destroy(): void;
  count: number;
}

interface HarnessFeedGlobal {
  create(container: Node, opts?: Record<string, unknown>): FeedHandle;
  version: number;
}

function loadFeed(): HarnessFeedGlobal {
  const documentShim = {
    createElement(tag: string): Node {
      return new Node(tag);
    },
    getElementById(): null {
      return null;
    },
    head: new Node('head'),
  };
  const ctx = createContext({ document: documentShim, console });
  runInContext('globalThis.window = globalThis;', ctx);
  runInContext(FEED_SRC, ctx);
  const feed = runInContext('window.HarnessFeed', ctx) as HarnessFeedGlobal | undefined;
  assert.ok(feed, 'feed.js did not expose window.HarnessFeed');
  return feed;
}

const HarnessFeed = loadFeed();

function mount(): { container: Node; feed: FeedHandle } {
  const container = new Node('div');
  return { container, feed: HarnessFeed.create(container) };
}

/** Every node in the tree carrying `cls` as one of its class tokens. */
function withClass(root: Node, cls: string): Node[] {
  const found: Node[] = [];
  const walk = (n: Node): void => {
    if (n.className.split(/\s+/).includes(cls)) found.push(n);
    for (const child of n.children) walk(child);
  };
  walk(root);
  return found;
}

function texts(root: Node, cls: string): string[] {
  return withClass(root, cls).map((n) => n.textContent);
}

/** A persisted Kiro chunk step, field for field (see the raw/*.jsonl rows). */
function chunk(text: string, chunkKind: string, ts: number): Record<string, unknown> {
  return {
    type: 'step',
    agent: 'kiro',
    data: {
      kind: 'chunk',
      transport: 'acp',
      countsAsTurn: false,
      text,
      chunkKind,
      raw: { sessionUpdate: chunkKind, content: { type: 'text', text } },
    },
    timestamp: ts,
  };
}

function msgChunk(text: string, ts: number): Record<string, unknown> {
  return chunk(text, 'agent_message_chunk', ts);
}

function thoughtChunk(text: string, ts: number): Record<string, unknown> {
  return chunk(text, 'agent_thought_chunk', ts);
}

describe('HarnessFeed chunk streaming', () => {
  it('coalesces consecutive message chunks into one agent row', () => {
    const { container, feed } = mount();
    feed.append([msgChunk('I have in', T0), msgChunk('spected the ret', T0 + 1), msgChunk('ained receipt.', T0 + 2)]);

    const rows = withClass(container, 'hf-msg-agent');
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.textContent, 'I have inspected the retained receipt.');
  });

  it('renders thought chunks as a dim reasoning row, separate from the message row', () => {
    const { container, feed } = mount();
    feed.append([
      thoughtChunk('Let me check ', T0),
      thoughtChunk('the receipt.', T0 + 1),
      msgChunk('The receipt ', T0 + 2),
      msgChunk('is retained.', T0 + 3),
    ]);

    assert.deepEqual(texts(container, 'hf-reason'), ['Let me check the receipt.']);
    assert.deepEqual(texts(container, 'hf-msg-agent'), ['The receipt is retained.']);
    // two rows, reasoning first, each with the standard time gutter
    const feedRows = withClass(container, 'hf-row');
    assert.equal(feedRows.length, 2);
    assert.equal(withClass(feedRows[0]!, 'hf-reason').length, 1);
    assert.equal(withClass(feedRows[1]!, 'hf-msg-agent').length, 1);
    for (const row of feedRows) assert.equal(withClass(row, 'hf-gutter').length, 1);
  });

  it('a progress heartbeat mid-stream does not split the message row', () => {
    const { container, feed } = mount();
    feed.append([
      msgChunk('I have in', T0),
      { type: 'progress', text: 'heartbeat', timestamp: T0 + 1 },
      msgChunk('spected the ret', T0 + 2),
      msgChunk('ained receipt.', T0 + 3),
    ]);

    assert.deepEqual(texts(container, 'hf-msg-agent'), ['I have inspected the retained receipt.']);
    assert.deepEqual(texts(container, 'hf-dim'), ['heartbeat']);
  });

  it('modelAck and stderrNotice rows do not split the message row either', () => {
    const { container, feed } = mount();
    feed.append([
      msgChunk('I have in', T0),
      { type: 'step', agent: 'kiro', data: { kind: 'modelAck', raw: 'model: sonnet-4' }, timestamp: T0 + 1 },
      msgChunk('spected the ret', T0 + 2),
      {
        type: 'step',
        agent: 'kiro',
        data: { kind: 'stderrNotice', warning: 'acp: noisy stderr' },
        timestamp: T0 + 3,
      },
      msgChunk('ained receipt.', T0 + 4),
    ]);

    assert.deepEqual(texts(container, 'hf-msg-agent'), ['I have inspected the retained receipt.']);
    assert.deepEqual(texts(container, 'hf-warn'), ['model: sonnet-4', 'acp: noisy stderr']);
  });

  it('a confirming message event replaces the streamed block in place', () => {
    const { container, feed } = mount();
    feed.append([
      msgChunk('Sunlight contains ', T0),
      msgChunk('all colors.', T0 + 1),
      { type: 'message', agent: 'kiro', source: 'agent', content: 'Sunlight contains all colors.', timestamp: T0 + 2 },
    ]);

    assert.deepEqual(texts(container, 'hf-msg-agent'), ['Sunlight contains all colors.']);
    assert.equal(withClass(container, 'hf-row').length, 1);
  });

  it('a message event after thought chunks lands as its own row and leaves the reasoning intact', () => {
    const { container, feed } = mount();
    feed.append([
      thoughtChunk('The user asks ', T0),
      thoughtChunk('about Rayleigh scattering.', T0 + 1),
      { type: 'message', agent: 'kiro', source: 'agent', content: 'Sunlight contains all colors.', timestamp: T0 + 2 },
    ]);

    assert.deepEqual(texts(container, 'hf-reason'), ['The user asks about Rayleigh scattering.']);
    assert.deepEqual(texts(container, 'hf-msg-agent'), ['Sunlight contains all colors.']);
    assert.equal(withClass(container, 'hf-row').length, 2);
  });

  it('a tool_call between chunks still splits the stream', () => {
    const { container, feed } = mount();
    feed.append([
      msgChunk('Reading the file.', T0),
      {
        type: 'tool_call',
        toolCallId: 'call_1',
        functionName: 'read_file',
        arguments: { path: 'README.md' },
        timestamp: T0 + 1,
      },
      msgChunk('It is a readme.', T0 + 2),
    ]);

    assert.deepEqual(texts(container, 'hf-msg-agent'), ['Reading the file.', 'It is a readme.']);
    assert.equal(withClass(container, 'hf-card').length, 1);
  });
});

/*
 * Context gauge. Events are stamped by the REAL server-side annotator
 * (createFrameAnnotator, the same call server.ts makes per run socket), so these
 * tests pin the wire contract between src/web/context-frames.ts and feed.js.
 */
describe('HarnessFeed context gauge', () => {
  const MODEL = 'claude-sonnet-4-5'; // 200k window in the bundled table
  const u = (input: number, cacheRead: number, cacheWrite: number) => ({
    agent: 'claude', model: MODEL, inputTokens: input, outputTokens: 7, cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite,
  });

  function stamped(agent: string, events: Record<string, unknown>[]): Record<string, unknown>[] {
    const a = createFrameAnnotator({ agent });
    return events.map((e) => {
      const ctx = a?.annotate(e as unknown as AgentEvent);
      return ctx === undefined ? e : { ...e, ctx };
    });
  }

  const claudeRun = (): Record<string, unknown>[] => [
    { type: 'step', agent: 'claude', data: { model: MODEL }, timestamp: T0 },
    // claude's empty first content block: same call, never drawn as a row
    { type: 'message', agent: 'claude', source: 'agent', model: MODEL, content: '', usage: u(2, 0, 18_398), timestamp: T0 + 1 },
    { type: 'message', agent: 'claude', source: 'agent', model: MODEL, content: 'Reading.', usage: u(2, 0, 18_398), timestamp: T0 + 2 },
    { type: 'tool_call', agent: 'claude', toolCallId: 't1', functionName: 'Bash', arguments: { command: 'ls -la' }, timestamp: T0 + 3 },
    { type: 'tool_result', agent: 'claude', toolCallId: 't1', content: 'ok', timestamp: T0 + 415 },
    { type: 'message', agent: 'claude', source: 'agent', model: MODEL, content: 'Grew.', usage: u(6, 18_398, 107_596), timestamp: T0 + 500 },
    { type: 'message', agent: 'claude', source: 'agent', model: MODEL, content: 'Same call, 2nd block.', usage: u(6, 18_398, 107_596), timestamp: T0 + 501 },
  ];

  it('a tool card gets the carried-forward gauge, dimmed stale, after the duration', () => {
    const { container, feed } = mount();
    feed.append(stamped('claude', claudeRun()));
    const card = withClass(container, 'hf-card')[0]!;
    const head = withClass(card, 'hf-head')[0]!;
    const gauges = withClass(head, 'hf-ctx');
    assert.equal(gauges.length, 1);
    const g = gauges[0]!;
    assert.ok(g.className.split(/\s+/).includes('stale'), g.className);
    assert.ok(g.className.split(/\s+/).includes('hf-lv0'), 'teal below 50%');
    assert.equal(texts(g, 'hf-ctx-t')[0], '18.4k 9%');
    assert.equal(withClass(g, 'hf-ctx-d').length, 0, 'seq 1 already drew its +Δ on "Reading."');
    // the gauge sits after the duration in the header
    const order = head.children.map((c) => c.className.split(/\s+/)[0]);
    assert.deepEqual(order, ['hf-tri', 'hf-fn', 'hf-args', 'hf-chip', 'hf-ms', 'hf-ctx']);
    assert.equal(texts(head, 'hf-ms')[0], '412ms');
    // fill at the percentage, warn tick at CONTEXT_WARN_FRACTION
    const bar = withClass(g, 'hf-ctx-g')[0]!;
    assert.equal(bar.children[0]!.style.width, '9.2%');
    assert.equal(bar.children[1]!.style.left, '85%');
    assert.match(g.attributes.title!, /carried from last model call/);
  });

  it('a model-call row shows +Δ once, on its first drawn row, with a fresh gauge and breakdown tooltip', () => {
    const { container, feed } = mount();
    feed.append(stamped('claude', claudeRun()));
    const rows = withClass(container, 'hf-row');
    assert.equal(rows.length, 4, 'Reading. / Bash card / Grew. / 2nd block');
    assert.deepEqual(
      texts(container, 'hf-ctx-d'),
      ['+18.4k', '+107.6k'],
      'one +Δ per model call, never on the undrawn empty block',
    );
    const grew = rows[2]!;
    const g = withClass(grew, 'hf-ctx')[0]!;
    assert.ok(!g.className.split(/\s+/).includes('stale'), 'a model-call row is fresh');
    assert.equal(texts(g, 'hf-ctx-t')[0], '126.0k 63%');
    assert.ok(g.className.split(/\s+/).includes('hf-lv1'), 'yellow from 50%');
    const title = g.attributes.title!;
    assert.match(title, /context 126\.0k \/ 200\.0k \(63\.0%\)/);
    assert.match(title, /input 6 · cache-read 18\.4k · cache-write 107\.6k/);
    assert.match(title, /Δ \+107\.6k this call/);
    assert.match(title, /44\.0k until the 85% threshold/);
    // the right-aligned wrapper appears only on rows that carry a gauge
    assert.equal(withClass(grew, 'hf-body-ctx').length, 1);
    assert.equal(withClass(rows[3]!, 'hf-ctx-d').length, 0, '2nd block of the same call: no repeated +Δ');
  });

  it('a tool-only model call (empty text block) draws its +Δ on the tool card, still stale', () => {
    const { container, feed } = mount();
    feed.append(stamped('claude', [
      { type: 'message', agent: 'claude', source: 'agent', model: MODEL, content: 'Start.', usage: u(2, 0, 43_498), timestamp: T0 },
      { type: 'message', agent: 'claude', source: 'agent', model: MODEL, content: '', usage: u(4, 43_498, 3_898), timestamp: T0 + 1 },
      { type: 'tool_call', agent: 'claude', toolCallId: 's1', functionName: 'Skill', arguments: { command: 'x' }, timestamp: T0 + 2 },
      { type: 'tool_call', agent: 'claude', toolCallId: 's2', functionName: 'Read', arguments: { path: 'y' }, timestamp: T0 + 3 },
    ]));
    const cards = withClass(container, 'hf-card');
    assert.equal(cards.length, 2);
    const g = withClass(cards[0]!, 'hf-ctx')[0]!;
    assert.ok(g.className.split(/\s+/).includes('stale'));
    assert.deepEqual(texts(g, 'hf-ctx-d'), ['+3.9k']);
    assert.equal(texts(g, 'hf-ctx-t')[0], '47.4k 24%');
    assert.equal(withClass(cards[1]!, 'hf-ctx-d').length, 0, 'one +Δ per reading');
    assert.deepEqual(texts(container, 'hf-ctx-d'), ['+43.5k', '+3.9k']);
  });

  it('tolerates #59 chain-framed rows and draws nothing for the ach.seal record', () => {
    const { container, feed } = mount();
    const chain = { v: 1, seq: 0, prev: 'p', hash: 'h' };
    const framed: Record<string, unknown>[] = claudeRun().map((e, i) => ({ ach_chain: { ...chain, seq: i }, ...e }));
    framed.push({ ach_chain: { ...chain, seq: 7 }, type: 'ach.seal', runId: 'r', eventCount: 7, lastHash: 'x', totals: null, totalsHash: null, timestamp: T0 + 600 });
    feed.append(stamped('claude', framed));
    assert.equal(withClass(container, 'hf-row').length, 4, 'same rows as unframed; the seal adds none');
    assert.deepEqual(texts(container, 'hf-ctx-d'), ['+18.4k', '+107.6k']);
  });

  it('no ctx (unmetered agent, older server) renders no gauge and no wrapper', () => {
    const { container, feed } = mount();
    const plain = claudeRun().map((e) => ({ ...e, agent: 'kiro' }));
    feed.append(stamped('kiro', plain));
    assert.equal(withClass(container, 'hf-ctx').length, 0);
    assert.equal(withClass(container, 'hf-body-ctx').length, 0);
    assert.equal(withClass(container, 'hf-card').length, 1);
    assert.equal(withClass(container, 'hf-row').length, 4);
  });

  it('unknown window: tokens only, no bar and no percent', () => {
    const { container, feed } = mount();
    feed.append(stamped('claude', [
      {
        type: 'message', agent: 'claude', source: 'agent', model: 'claude-nonesuch-9', content: 'hi',
        usage: { ...u(18_000, 0, 400), model: 'claude-nonesuch-9' }, timestamp: T0,
      },
    ]));
    const g = withClass(container, 'hf-ctx')[0]!;
    assert.equal(withClass(g, 'hf-ctx-g').length, 0);
    assert.equal(texts(g, 'hf-ctx-t')[0], '18.4k');
    assert.ok(!/hf-lv/.test(g.className), g.className);
  });

  it('a turn-total reading is marked as an upper bound and draws no +Δ', () => {
    const { container, feed } = mount();
    const a = createFrameAnnotator({ agent: 'codex', requestedModel: 'gpt-5-codex' })!;
    const ev = {
      type: 'usage', agent: 'codex', timestamp: T0,
      usage: { agent: 'codex', model: 'unknown', inputTokens: 30_000, outputTokens: 10 },
    };
    feed.append([{ ...ev, ctx: a.annotate(ev as unknown as AgentEvent) }]);
    const g = withClass(container, 'hf-ctx')[0]!;
    assert.match(texts(g, 'hf-ctx-t')[0]!, /^≤30\.0k /);
    assert.equal(withClass(g, 'hf-ctx-d').length, 0);
  });
});
