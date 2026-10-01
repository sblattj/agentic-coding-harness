import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  PrimeAdapter,
  PRIME_CAPABILITIES,
  createPrimeLineParser,
  parsePrimeLine,
  primeArgs,
  primeUsageEvent,
  primeChildUsageEvents,
} from '../src/adapters/prime.ts';
import { normalizePrime, normalizeUsage } from '../src/core/normalize.ts';
import type { CanonicalEvent } from '../src/adapters/types.ts';
import type { AgentEvent } from '../src/core/types.ts';
import { FakeChild, fakeSpawnFn, splitMidFirstLine, type FakeSpawnCall } from './helpers/fake-child.ts';

// Real `prime-agent --provider ferry --model flash -nc -p --mode json` output
// (prime-agent 0.9.8; harness_digest content trimmed).
const FIXTURE = readFileSync(join(fileURLToPath(new URL('.', import.meta.url)), 'fixtures/prime-session.ndjson'), 'utf8');
const LINES = FIXTURE.trim().split('\n');
const SESSION_ID = '01a0f5c1-58b0-7452-a3c9-dfe75f77b6e9';
// Home-shaped prime state dir (sessions/, session-artifacts/) holding one
// parent session 01a0f5bd… whose subagent transcript sits under sub-61b507e2/.
const AGENT_DIR = join(fileURLToPath(new URL('.', import.meta.url)), 'fixtures/prime');
const PARENT_ID = '01a0f5bd-e279-7384-a414-0852a851db8d';
const TOOL_CALL_ID = 'call_63e6cfc7c3c54ddbb8af7f7e';

type Usage = Extract<CanonicalEvent, { type: 'usage' }>;
type Tool = Extract<CanonicalEvent, { type: 'tool' }>;

function sumUsage(events: CanonicalEvent[]) {
  const usage = events.filter((e): e is Usage => e.type === 'usage');
  return {
    count: usage.length,
    input: usage.reduce((s, u) => s + u.tokens.inputTokens, 0),
    output: usage.reduce((s, u) => s + u.tokens.outputTokens, 0),
    cacheRead: usage.reduce((s, u) => s + u.tokens.cacheReadTokens, 0),
    cacheWrite: usage.reduce((s, u) => s + u.tokens.cacheWriteTokens, 0),
    total: usage.reduce((s, u) => s + (u.tokens.totalTokens ?? 0), 0),
  };
}

async function collect(handle: { events: AsyncIterable<CanonicalEvent>; wait(): Promise<number> }) {
  const events: CanonicalEvent[] = [];
  for await (const event of handle.events) events.push(event);
  const code = await handle.wait();
  return { events, code };
}

describe('prime capabilities', () => {
  it('declares headless/streaming/resume, no ACP lane, tmux fallback', () => {
    assert.deepEqual(new PrimeAdapter().capabilities, {
      headless: true,
      streaming: true,
      resume: true,
      acp: false,
      tmuxFallback: true,
    });
    assert.equal(new PrimeAdapter().id, 'prime');
    assert.equal(new PrimeAdapter().name, 'prime');
    assert.deepEqual(PRIME_CAPABILITIES, new PrimeAdapter().capabilities);
  });
});

describe('prime parsePrimeLine (recorded JSON stream)', () => {
  const events = LINES.flatMap((line) => parsePrimeLine(line));

  it('the fixture has the recorded event mix (61 lines)', () => {
    assert.equal(LINES.length, 61);
    const counts: Record<string, number> = {};
    for (const l of LINES) {
      const t = (JSON.parse(l) as { type: string }).type;
      counts[t] = (counts[t] ?? 0) + 1;
    }
    assert.equal(counts.message_update, 40);
    assert.equal(counts.message_end, 5);
    assert.equal(counts.turn_end, 2);
    assert.equal(counts.agent_end, 1);
  });

  it('maps the session line to the session id', () => {
    assert.deepEqual(events[0], { type: 'session', sessionId: SESSION_ID });
    assert.equal(events.filter((e) => e.type === 'session').length, 1);
  });

  it('sums exactly the two assistant message_end usages (input 23952, output 58, total 24010)', () => {
    assert.deepEqual(sumUsage(events), { count: 2, input: 23952, output: 58, cacheRead: 0, cacheWrite: 0, total: 24010 });
  });

  it('turn_end, agent_end, message_start and message_update never add usage', () => {
    for (const type of ['turn_end', 'agent_end', 'message_start', 'message_update', 'turn_start', 'agent_start']) {
      const evs = LINES.filter((l) => (JSON.parse(l) as { type: string }).type === type).flatMap((l) => parsePrimeLine(l));
      assert.equal(evs.filter((e) => e.type === 'usage').length, 0, type);
    }
    // turn_end repeats the assistant message verbatim: still nothing.
    const turnEnd = LINES.find((l) => l.startsWith('{"type":"turn_end"'))!;
    assert.match(turnEnd, /"usage":\{"input":/);
    assert.deepEqual(parsePrimeLine(turnEnd), []);
  });

  it('maps tool_execution_start/end to one tool start + result pair', () => {
    const tools = events.filter((e): e is Tool => e.type === 'tool');
    assert.equal(tools.length, 2);
    const [start, result] = tools;
    assert.deepEqual(start, {
      type: 'tool',
      toolName: 'ipython',
      phase: 'start',
      toolCallId: TOOL_CALL_ID,
      input: { code: "result = await bash('echo hi')\nprint(result.output)" },
    });
    assert.equal(result!.phase, 'result');
    assert.equal(result!.toolCallId, TOOL_CALL_ID);
    assert.equal(result!.status, 'success');
    assert.match(JSON.stringify(result!.output), /hi/);
  });

  it('emits assistant text and reasoning once (at message_end), never user/custom/toolResult messages', () => {
    const msgs = events.filter((e): e is Extract<CanonicalEvent, { type: 'message' }> => e.type === 'message');
    assert.deepEqual(
      msgs.map((m) => [m.role, m.reasoning === true]),
      [
        ['assistant', true],
        ['assistant', false],
      ],
    );
    assert.equal(msgs[1]!.text, 'DONE');
    assert.match(msgs[0]!.text, /echo hi/);
  });

  it('a provider cost of 0 is not reported as $0 (unpriced → cost unavailable)', () => {
    for (const u of events.filter((e): e is Usage => e.type === 'usage')) {
      assert.equal(u.cost, undefined);
      assert.equal((u as { model?: string }).model, 'flash');
      assert.deepEqual((u.tokens as { extra?: unknown }).extra, { provider: 'ferry', responseModel: 'international.flash' });
    }
    const priced = primeUsageEvent({ input: 10, output: 5, cacheRead: 2, cacheWrite: 1, totalTokens: 18, cost: { total: 0.0042 } });
    assert.equal(priced?.cost, 0.0042);
  });

  it('skips all-zero usage and surfaces stopReason error', () => {
    const zero = JSON.stringify({
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [],
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 } },
        stopReason: 'error',
        errorMessage: 'Connection error.',
      },
    });
    assert.deepEqual(parsePrimeLine(zero), [{ type: 'error', message: 'Connection error.' }]);
  });

  it('ignores unknown event types (child updates are progressive snapshots, never summed)', () => {
    assert.deepEqual(parsePrimeLine('{"type":"rlm_child_update","child":{"id":"sub-1","tokenCount":500}}'), []);
    assert.deepEqual(parsePrimeLine('{"type":"brand_new_event"}'), []);
    assert.throws(() => parsePrimeLine('{not json'));
  });
});

describe('prime createPrimeLineParser (model-call boundaries, dedupe)', () => {
  it('brackets each turn as one model call ending at the assistant message_end with its output tokens', () => {
    const parse = createPrimeLineParser();
    const events = LINES.flatMap((l) => parse(l));
    const calls = events.filter((e): e is Extract<CanonicalEvent, { type: 'model_call' }> => e.type === 'model_call');
    assert.deepEqual(calls, [
      { type: 'model_call', phase: 'start', callId: 'call-1' },
      { type: 'model_call', phase: 'end', callId: 'call-1', model: 'flash', outputTokens: 57 },
      { type: 'model_call', phase: 'start', callId: 'call-2' },
      { type: 'model_call', phase: 'end', callId: 'call-2', model: 'flash', outputTokens: 1 },
    ]);
    // One first-output marker per call, between its start and its end.
    const chunks = events.filter((e) => e.type === 'step');
    assert.equal(chunks.length, 2);
    assert.deepEqual(sumUsage(events), { count: 2, input: 23952, output: 58, cacheRead: 0, cacheWrite: 0, total: 24010 });
  });

  it('a repeated assistant message_end is accounted once', () => {
    const parse = createPrimeLineParser();
    const ends = LINES.filter((l) => l.startsWith('{"type":"message_end"') && l.includes('"role":"assistant"'));
    const events = [...LINES, ...ends].flatMap((l) => parse(l));
    assert.equal(sumUsage(events).count, 2);
    assert.equal(sumUsage(events).input, 23952);
  });
});

describe('prime argv', () => {
  it('builds `-p --mode json [--model M] [-r SID] [-t csv] … -- <prompt>`', () => {
    assert.deepEqual(primeArgs('hi'), ['-p', '--mode', 'json', '--', 'hi']);
    assert.deepEqual(
      primeArgs('-starts with a dash', {
        model: 'ferry/flash',
        resume: SESSION_ID,
        sandbox: { allowedTools: ['ipython', 'read'] },
        extraArgs: ['--thinking', 'low'],
      }),
      ['-p', '--mode', 'json', '--model', 'ferry/flash', '-r', SESSION_ID, '-t', 'ipython,read', '--thinking', 'low', '--', '-starts with a dash'],
    );
  });

  it('passes a provider/model id through unsplit (prime-agent resolves it)', () => {
    assert.deepEqual(primeArgs('x', { model: 'ferry/flash' }).slice(3, 5), ['--model', 'ferry/flash']);
    assert.deepEqual(primeArgs('x', { model: 'flash' }).slice(3, 5), ['--model', 'flash']);
  });

  it('validateProfile warns for every sandbox field prime-agent cannot honour', () => {
    const adapter = new PrimeAdapter();
    const check = adapter.validateProfile({
      prompt: 'x',
      model: 'ferry/flash',
      sandbox: { allowedTools: ['ipython'], disallowedTools: ['bash'], permissionMode: 'ask', mcpConfig: '/tmp/mcp.json' },
    });
    assert.equal(check.ok, true);
    assert.deepEqual(
      check.warnings.map((w) => w.field),
      ['sandbox.disallowedTools', 'sandbox.permissionMode', 'sandbox.mcpConfig'],
    );
    assert.equal(adapter.validateProfile({ prompt: 'x', resume: '-bad' }).ok, false);
  });
});

describe('prime spawn integration (fake child, real plumbing)', () => {
  it('spawns `prime-agent -p --mode json …`, buffers split lines, forwards stderr as progress', async () => {
    const child = new FakeChild();
    const calls: FakeSpawnCall[] = [];
    const adapter = new PrimeAdapter({ spawnFn: fakeSpawnFn(child, calls), agentDir: AGENT_DIR });
    const handle = adapter.spawn('do it', { model: 'ferry/flash', cwd: '/tmp' });
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.command, 'prime-agent');
    assert.deepEqual(calls[0]!.args, ['-p', '--mode', 'json', '--model', 'ferry/flash', '--', 'do it']);
    assert.equal(calls[0]!.opts.cwd, '/tmp');
    const collected = collect(handle);
    const [head, tail] = splitMidFirstLine(FIXTURE);
    child.writeStdout(head);
    child.writeStderr('Daemon worker client closed\n');
    child.writeStdout(tail);
    child.close(0);
    const { events, code } = await collected;
    assert.equal(code, 0);
    assert.deepEqual(events.filter((e) => e.type === 'session'), [{ type: 'session', sessionId: SESSION_ID }]);
    assert.ok(events.some((e) => e.type === 'progress' && e.text === 'Daemon worker client closed'));
    assert.equal(sumUsage(events).input, 23952);
  });

  it('resume() passes -r <sessionId>', async () => {
    const child = new FakeChild();
    const calls: FakeSpawnCall[] = [];
    const adapter = new PrimeAdapter({ spawnFn: fakeSpawnFn(child, calls), agentDir: AGENT_DIR });
    const handle = adapter.resume(SESSION_ID, 'again');
    child.close(0);
    await collect(handle);
    assert.deepEqual(calls[0]!.args, ['-p', '--mode', 'json', '-r', SESSION_ID, '--', 'again']);
  });

  it('launch() bridges to core events: session id, usage stamped with the model, no fabricated cost', async () => {
    const child = new FakeChild();
    const calls: FakeSpawnCall[] = [];
    const adapter = new PrimeAdapter({ spawnFn: fakeSpawnFn(child, calls), agentDir: AGENT_DIR });
    const launching = adapter.launch({ prompt: 'p', model: 'ferry/flash', resume: SESSION_ID, extraArgs: ['-nc'] });
    child.writeStdout(FIXTURE);
    child.close(0);
    const handle = await launching;
    const events: AgentEvent[] = [];
    for await (const e of handle.attach()) events.push(e);
    assert.equal(await handle.wait(), 'success');
    assert.equal(handle.sessionId, SESSION_ID);
    assert.deepEqual(calls[0]!.args, ['-p', '--mode', 'json', '--model', 'ferry/flash', '-r', SESSION_ID, '-nc', '--', 'p']);
    const usage = events.filter((e) => e.type === 'usage');
    assert.equal(usage.length, 2);
    for (const u of usage) {
      assert.equal(u.usage?.model, 'flash');
      assert.equal(u.usage?.costUsd, undefined);
    }
    assert.equal(usage.reduce((s, u) => s + (u.usage?.inputTokens ?? 0), 0), 23952);
    assert.equal(events.filter((e) => e.type === 'model_call_start').length, 2);
    assert.equal(events.filter((e) => e.type === 'model_call_end').length, 2);
    assert.equal(events.filter((e) => e.type === 'tool_call').length, 1);
    assert.equal(events.filter((e) => e.type === 'tool_result').length, 1);
  });

  it('abort() SIGTERMs the child and the driver handle reports aborted', async () => {
    const child = new FakeChild();
    const adapter = new PrimeAdapter({ spawnFn: fakeSpawnFn(child), agentDir: AGENT_DIR });
    const handle = adapter.spawn('long running');
    const collected = collect(handle);
    await new Promise((r) => setTimeout(r, 0));
    adapter.abort();
    assert.deepEqual(child.signals, ['SIGTERM']);
    child.close(null, 'SIGTERM');
    assert.equal((await collected).code, -1);

    const child2 = new FakeChild();
    const launching = new PrimeAdapter({ spawnFn: fakeSpawnFn(child2), agentDir: AGENT_DIR }).launch({ prompt: 'x' });
    child2.writeStdout(LINES[0] + '\n');
    const h = await launching;
    h.abort();
    assert.deepEqual(child2.signals, ['SIGTERM']);
    child2.close(null, 'SIGTERM');
    assert.equal(await h.wait(), 'aborted');
  });

  it('appends subagent usage from the child session files at agent_end, once', async () => {
    const child = new FakeChild();
    const adapter = new PrimeAdapter({ spawnFn: fakeSpawnFn(child), agentDir: AGENT_DIR });
    const launching = adapter.launch({ prompt: 'p' });
    // Same recorded stream, re-keyed to the parent session that has a child.
    child.writeStdout(FIXTURE.split(SESSION_ID).join(PARENT_ID));
    child.close(0);
    const handle = await launching;
    const events: AgentEvent[] = [];
    for await (const e of handle.attach()) events.push(e);
    assert.equal(await handle.wait(), 'success');
    const usage = events.filter((e) => e.type === 'usage');
    // 2 parent calls from the stream + 7 child calls from sub-61b507e2/*.jsonl.
    assert.equal(usage.length, 9);
    assert.equal(usage.reduce((s, u) => s + (u.usage?.inputTokens ?? 0), 0), 23952 + 93710);
    assert.equal(usage.reduce((s, u) => s + (u.usage?.outputTokens ?? 0), 0), 58 + 1360);
  });

  it('primeChildUsageEvents ignores semantic-edges.jsonl and missing sessions', () => {
    const events = primeChildUsageEvents(AGENT_DIR, PARENT_ID);
    assert.deepEqual(sumUsage(events), { count: 7, input: 93710, output: 1360, cacheRead: 0, cacheWrite: 0, total: 95070 });
    assert.deepEqual(primeChildUsageEvents(AGENT_DIR, SESSION_ID), []);
  });

  it('a non-zero exit becomes an error event', async () => {
    const child = new FakeChild();
    const adapter = new PrimeAdapter({ spawnFn: fakeSpawnFn(child), agentDir: AGENT_DIR });
    const handle = adapter.spawn('x');
    child.close(2);
    const { events, code } = await collect(handle);
    assert.equal(code, 2);
    assert.ok(events.some((e) => e.type === 'error' && /exited with code 2/.test(e.message)));
  });
});

describe('normalizePrime', () => {
  it('normalizes a pi usage block; zero usage → null; positive cost kept', () => {
    const rec = normalizePrime('prime', { input: 12016, output: 1, cacheRead: 3, cacheWrite: 4, totalTokens: 12024, cost: { total: 0 } }, 1);
    assert.deepEqual(rec, { agent: 'prime', model: 'unknown', inputTokens: 12016, outputTokens: 1, cacheReadTokens: 3, cacheWriteTokens: 4, timestamp: 1 });
    assert.equal(normalizePrime('prime', { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }), null);
    assert.equal(normalizePrime('prime', { input: 1, output: 1 }), null, 'cacheRead/cacheWrite required');
    assert.equal(normalizeUsage('prime', { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, cost: { total: 0.5 } })?.costUsd, 0.5);
  });
});
