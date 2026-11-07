import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { createContext, runInContext } from 'node:vm';
import type { AgentEvent } from '../src/core/types.ts';
import { deriveRunObservability, deriveSpans } from '../src/web/derive.ts';
import { buildSpanTree, type SpanTreeNode } from '../src/web/span-tree.ts';
import { startWebServer, type WebServerHandle } from '../src/web/server.ts';

// ---------------------------------------------------------------------------
// #65 span tree (derive.ts + span-tree.ts + /trio) and #66 raw JSON inspector
// (feed.js, shared by feed / trio waterfall / trio tree).
// ---------------------------------------------------------------------------

const T0 = 1_700_000_000_000;

/** model call -> Task (sub-agent) -> sub-agent model call -> sub-agent tool; then a main tool. */
const NESTED: AgentEvent[] = [
  { type: 'session_start', agent: 'claude', timestamp: T0 },
  { type: 'model_call_start', callId: 'm1', model: 'opus', timestamp: T0 + 100 },
  { type: 'tool_call', toolCallId: 'task1', functionName: 'Task', arguments: { prompt: 'dig' }, timestamp: T0 + 200 },
  { type: 'model_call_end', callId: 'm1', model: 'opus', timestamp: T0 + 210 },
  { type: 'model_call_start', callId: 'sub-m', model: 'sonnet', timestamp: T0 + 300 },
  { type: 'tool_call', toolCallId: 'sub-t', functionName: 'Read', arguments: { file_path: '/a' }, timestamp: T0 + 400 },
  { type: 'tool_result', toolCallId: 'sub-t', content: 'contents', timestamp: T0 + 500 },
  { type: 'model_call_end', callId: 'sub-m', model: 'sonnet', timestamp: T0 + 600 },
  { type: 'tool_result', toolCallId: 'task1', content: 'done', timestamp: T0 + 700 },
  { type: 'model_call_start', callId: 'm2', model: 'opus', timestamp: T0 + 800 },
  { type: 'tool_call', toolCallId: 't2', functionName: 'bash', arguments: 'ls', timestamp: T0 + 850 },
  { type: 'tool_result', toolCallId: 't2', content: 'x', timestamp: T0 + 900 },
  { type: 'model_call_end', callId: 'm2', model: 'opus', timestamp: T0 + 950 },
  { type: 'done', exitStatus: 'success', timestamp: T0 + 1_000 },
];

function names(nodes: SpanTreeNode[], byId: Map<string, string>, depth = 0): string[] {
  return nodes.flatMap((n) => [`${'  '.repeat(depth)}${byId.get(n.id)}`, ...names(n.children, byId, depth + 1)]);
}

describe('#65 span tree derivation', () => {
  it('nests sub-agent model and tool calls under the agent span, with durations', () => {
    const spans = deriveSpans(NESTED);
    const byName = (n: string) => spans.find((s) => s.name === n)!;
    const agent = byName('Task');
    assert.equal(agent.kind, 'agent');
    assert.equal(agent.durationMs, 500);
    const subModel = byName('llm sonnet');
    const subTool = byName('Read');
    assert.equal(subModel.parentId, agent.id);
    assert.equal(subTool.parentId, subModel.id);
    assert.equal(subTool.depth, subModel.depth + 1);
    assert.equal(subModel.depth, agent.depth + 1);
    // main-lane work after the agent closes is back under the session root / its own model
    assert.equal(byName('bash').parentId, spans.find((s) => s.name === 'llm opus' && s.startMs === 800)!.id);
    assert.equal(subModel.durationMs, 300);
    assert.equal(subTool.durationMs, 100);
  });

  it('buildSpanTree yields the hierarchy with descendant counts from the same spans', () => {
    const spans = deriveSpans(NESTED);
    const label = new Map(spans.map((s) => [s.id, s.name]));
    const roots = buildSpanTree(spans);
    assert.equal(roots.length, 1);
    assert.deepEqual(names(roots, label), [
      'session',
      '  llm opus',
      '    Task',
      '      llm sonnet',
      '        Read',
      '  llm opus',
      '    bash',
    ]);
    assert.equal(roots[0]!.descendants, spans.length - 1);
    // every span id appears exactly once in the tree (waterfall and tree share spans)
    const ids: string[] = [];
    const walk = (ns: SpanTreeNode[]): void => ns.forEach((n) => { ids.push(n.id); walk(n.children); });
    walk(roots);
    assert.deepEqual(ids.sort(), spans.map((s) => s.id).sort());
  });

  it('parallel agents are not guessed apart: nothing is re-parented while 2 are open', () => {
    const ev: AgentEvent[] = [
      { type: 'tool_call', toolCallId: 'a', functionName: 'Task', timestamp: T0 },
      { type: 'tool_call', toolCallId: 'b', functionName: 'Task', timestamp: T0 + 10 },
      { type: 'tool_call', toolCallId: 'x', functionName: 'Read', timestamp: T0 + 20 },
      { type: 'tool_result', toolCallId: 'x', content: '', timestamp: T0 + 30 },
      { type: 'tool_result', toolCallId: 'a', content: '', timestamp: T0 + 40 },
      { type: 'tool_result', toolCallId: 'b', content: '', timestamp: T0 + 50 },
    ];
    const spans = deriveSpans(ev);
    const agents = spans.filter((s) => s.kind === 'agent');
    assert.equal(agents.length, 2);
    // the second Task starts while exactly one is open, so it nests (documented); the Read does not
    const read = spans.find((s) => s.name === 'Read')!;
    assert.equal(read.parentId, 's0');
  });

  it('spans record the original event indexes that opened and closed them', () => {
    const spans = deriveSpans(NESTED);
    const sub = spans.find((s) => s.name === 'Read')!;
    assert.equal(NESTED[sub.startIdx!]!.type, 'tool_call');
    assert.equal(NESTED[sub.endIdx!]!.type, 'tool_result');
    assert.equal((NESTED[sub.startIdx!] as { toolCallId?: string }).toolCallId, 'sub-t');
  });

  it('deriveRunObservability ships spanTree next to spans (no new capture fields)', () => {
    const obs = deriveRunObservability(NESTED);
    assert.equal(obs.spanTree.length, 1);
    assert.equal(obs.spanTree[0]!.id, obs.spans[0]!.id);
    assert.deepEqual(deriveRunObservability([]).spanTree, []);
  });
});

// ------------------------------------------------------ served web assets

let handle: WebServerHandle;
let base: string;
before(async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'harness-span-tree-'));
  handle = await startWebServer({ port: 0, host: '127.0.0.1', token: 't', stateDir });
  base = `http://127.0.0.1:${handle.port}`;
});
after(async () => {
  await handle.close();
});

describe('served assets carry the tree container and inspector hooks', () => {
  it('/trio has the tree view, toggle, expand depth and inspector wiring', async () => {
    const body = await (await fetch(`${base}/trio`, { headers: { authorization: 'Bearer t' } })).text();
    for (const marker of ['id="spanTree"', 'id="viewTree"', 'id="viewWaterfall"', 'TREE_OPEN_DEPTH = 2', 'inspectSpan', 'HarnessFeed.inspect', 'spanTree']) {
      assert.ok(body.includes(marker), `trio.html missing ${marker}`);
    }
  });

  it('/feed.js exposes the inspector and the per-row raw button', async () => {
    const body = await (await fetch(`${base}/feed.js`, { headers: { authorization: 'Bearer t' } })).text();
    for (const marker of ['inspect: inspect', 'copyText: copyText', 'hf-raw', 'hf-insp', 'navigator.clipboard', 'JSON.stringify(value, null, 2)']) {
      assert.ok(body.includes(marker), `feed.js missing ${marker}`);
    }
  });
});

// ------------------------------------------------------ inspector behavior

interface FakeNode {
  tagName: string;
  className: string;
  children: FakeNode[];
  parentNode: FakeNode | null;
  textContent: string;
  listeners: Record<string, Array<(e: unknown) => void>>;
  [k: string]: unknown;
}

function makeDom() {
  const mk = (tagName: string): FakeNode => {
    const n: FakeNode = {
      tagName,
      className: '',
      children: [],
      parentNode: null,
      textContent: '',
      listeners: {},
      style: {},
      attributes: {},
      classList: {
        add(c: string) { n.className = `${n.className} ${c}`.trim(); },
        remove(c: string) { n.className = n.className.split(' ').filter((x) => x !== c).join(' '); },
      },
      setAttribute(k: string, v: string) { (n.attributes as Record<string, string>)[k] = v; },
      addEventListener(t: string, fn: (e: unknown) => void) { (n.listeners[t] ??= []).push(fn); },
      appendChild(c: FakeNode) { c.parentNode = n; n.children.push(c); return c; },
      removeChild(c: FakeNode) { n.children = n.children.filter((x) => x !== c); c.parentNode = null; return c; },
      focus() {},
      select() {},
      get firstChild() { return n.children[0] ?? null; },
      get childElementCount() { return n.children.length; },
    };
    return n;
  };
  const body = mk('body');
  const copied: string[] = [];
  const docListeners: Record<string, Array<(e: unknown) => void>> = {};
  const doc = {
    createElement: mk,
    getElementById: () => null,
    querySelector: () => null,
    head: mk('head'),
    body,
    addEventListener(t: string, fn: (e: unknown) => void) { (docListeners[t] ??= []).push(fn); },
    removeEventListener() {},
    execCommand: () => true,
  };
  const ctx = createContext({
    document: doc,
    console,
    setTimeout,
    Promise,
    navigator: { clipboard: { writeText: (t: string) => { copied.push(t); return Promise.resolve(); } } },
  });
  runInContext('globalThis.window = globalThis;', ctx);
  runInContext(readFileSync(new URL('../src/web/feed.js', import.meta.url), 'utf8'), ctx);
  return { ctx, body, copied, mk, hf: runInContext('window.HarnessFeed', ctx) as Record<string, (...a: unknown[]) => any> };
}

function walkNodes(n: FakeNode, out: FakeNode[] = []): FakeNode[] {
  out.push(n);
  n.children.forEach((c) => walkNodes(c, out));
  return out;
}

describe('#66 raw JSON inspector (feed.js)', () => {
  const LONG = 'line one\n'.repeat(400);
  const EV: AgentEvent[] = [
    { type: 'tool_call', toolCallId: 'c1', functionName: 'bash', arguments: { command: 'echo' }, timestamp: T0 },
    { type: 'tool_result', toolCallId: 'c1', content: LONG, timestamp: T0 + 5 },
    { type: 'message', source: 'agent', content: 'hello world', timestamp: T0 + 9, extra: { deep: 1 } } as AgentEvent,
  ];

  it('every feed row keeps its original event(s); the {} button opens the full pretty JSON, untruncated', () => {
    const { hf, mk, body } = makeDom();
    const container = mk('div');
    const feed = hf.create!(container) as { append(e: unknown): void; events(): unknown[] };
    feed.append(EV);
    assert.equal(feed.events().length, 3);
    assert.equal(feed.events()[1], EV[1], 'events() returns the original objects');
    const rows = walkNodes(container).filter((n) => n.className === 'hf-row');
    assert.equal(rows.length, 2, 'call+result share one card row; message is the other');
    const raws = rows.map((r) => r.children.find((c) => c.className === 'hf-raw'));
    assert.ok(raws.every((r) => r !== undefined), 'each row has a raw button');
    // card row: call + result events
    raws[0]!.listeners.click![0]!({ stopPropagation() {} });
    const pre = walkNodes(body).find((n) => n.className === 'hf-insp-pre')!;
    assert.equal(pre.textContent, JSON.stringify([EV[0], EV[1]], null, 2));
    assert.ok(pre.textContent.includes(JSON.stringify(LONG).slice(1, -1)), 'long result is not truncated');
    // message row: single object, not wrapped
    raws[1]!.listeners.click![0]!({ stopPropagation() {} });
    const pres = walkNodes(body).filter((n) => n.className === 'hf-insp-pre');
    assert.equal(pres[pres.length - 1]!.textContent, JSON.stringify(EV[2], null, 2));
  });

  it('long string fields get their own scrollable block with a per-field copy, full copy uses the clipboard', async () => {
    const { hf, body, copied } = makeDom();
    const h = hf.inspect!(EV[1], { title: 'x' }) as { json: string };
    assert.equal(h.json, JSON.stringify(EV[1], null, 2));
    const all = walkNodes(body);
    const field = all.find((n) => n.className === 'hf-insp-fpre')!;
    assert.equal(field.textContent, LONG, 'field shown verbatim, newlines intact');
    const buttons = all.filter((n) => n.className === 'hf-insp-btn');
    const copyAll = buttons.find((b) => b.textContent === 'copy JSON')!;
    const copyField = buttons.find((b) => b.textContent === 'copy field')!;
    copyAll.listeners.click![0]!({});
    copyField.listeners.click![0]!({});
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(copied, [JSON.stringify(EV[1], null, 2), LONG]);
  });
});
