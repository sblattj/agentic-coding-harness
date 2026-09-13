import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createContext, runInContext } from 'node:vm';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

/*
 * src/web/feed.js is a browser IIFE with no module system, so it is loaded into
 * a vm context over a hand-written DOM shim — small enough to stay honest, and
 * it keeps the dashboard's only stateful renderer under test without pulling in
 * a DOM package. connect()/WebSocket/location are never exercised here.
 */

const FEED_SRC = readFileSync(join(import.meta.dirname, '../src/web/feed.js'), 'utf8');
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
