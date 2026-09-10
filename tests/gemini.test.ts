import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { GeminiAdapter, GEMINI_CAPABILITIES, parseGeminiLine } from '../src/adapters/gemini.ts';
import type { CanonicalEvent } from '../src/adapters/types.ts';
import { FakeChild, fakeSpawnFn, splitMidFirstLine, type FakeSpawnCall } from './helpers/fake-child.ts';

const FIXTURE = readFileSync(join(import.meta.dirname, 'fixtures/gemini-session.ndjson'), 'utf8');

async function collect(handle: { events: AsyncIterable<CanonicalEvent>; wait(): Promise<number> }) {
  const events: CanonicalEvent[] = [];
  for await (const event of handle.events) events.push(event);
  const code = await handle.wait();
  return { events, code };
}

describe('gemini capabilities', () => {
  it('declares headless/streaming/resume with ACP and tmux fallback', () => {
    assert.deepEqual(new GeminiAdapter().capabilities, {
      headless: true,
      streaming: true,
      resume: true,
      acp: true,
      tmuxFallback: true,
    });
    assert.equal(new GeminiAdapter().id, 'gemini');
    assert.deepEqual(GEMINI_CAPABILITIES, new GeminiAdapter().capabilities);
  });
});

describe('gemini parseGeminiLine (recorded NDJSON)', () => {
  const events = FIXTURE.trim().split('\n').flatMap((line) => parseGeminiLine(line));

  it('maps init to a session event', () => {
    assert.deepEqual(events[0], { type: 'session', sessionId: 'sess-g-9f31c2' });
  });

  it('maps tool_use/tool_result to tool start + result events', () => {
    const toolEvents = events.filter((e) => e.type === 'tool') as Extract<
      CanonicalEvent,
      { type: 'tool' }
    >[];
    assert.equal(toolEvents.length, 2);
    assert.deepEqual(toolEvents[0], {
      type: 'tool',
      toolName: 'read_file',
      phase: 'start',
      toolCallId: 'toolu_1',
      input: { path: 'notes.txt' },
    });
    assert.deepEqual(toolEvents[1], {
      type: 'tool',
      toolName: 'read_file',
      phase: 'result',
      toolCallId: 'toolu_1',
      output: 'hello world',
      status: 'success',
    });
  });

  it('maps message content blocks to a message event', () => {
    const message = events.find((e) => e.type === 'message' && !('response' in e)) as Extract<
      CanonicalEvent,
      { type: 'message' }
    >;
    assert.deepEqual(message, { type: 'message', role: 'assistant', text: "Done: notes.txt contains 'hello world'." });
  });

  it('extracts a CanonicalTokenRecord from result.stats with stats.input winning over the derived fallback', () => {
    // Fixture: input_tokens=2000, cached=700 → derived fallback would be 1300,
    // but the CLI's explicit input slice is 1250 and MUST win.
    const usage = events.find((e) => e.type === 'usage') as Extract<CanonicalEvent, { type: 'usage' }>;
    assert.deepEqual(usage.tokens, {
      inputTokens: 1250,
      cacheReadTokens: 700,
      cacheWriteTokens: 0,
      outputTokens: 300,
      reasoningTokens: 100,
      totalTokens: 3105,
      durationMs: 5432,
      raw: {
        total_tokens: 3105,
        input_tokens: 2000,
        output_tokens: 300,
        cached: 700,
        input: 1250,
        thoughts: 100,
        duration_ms: 5432,
      },
    });
  });

  it('derives uncached input as input_tokens − cached when stats.input is absent', () => {
    const [usage] = parseGeminiLine(
      JSON.stringify({
        type: 'result',
        status: 'success',
        stats: { total_tokens: 2200, input_tokens: 2000, output_tokens: 200, cached: 700 },
      }),
    ) as Extract<CanonicalEvent, { type: 'usage' }>[];
    assert.equal(usage.tokens.inputTokens, 1300);
    assert.equal(usage.tokens.cacheReadTokens, 700);
    assert.equal(usage.tokens.cacheWriteTokens, 0);
    assert.equal(usage.tokens.outputTokens, 200);
    assert.equal(usage.tokens.reasoningTokens, null);
    assert.equal(usage.tokens.durationMs, null);
  });

  it('emits result.response as a message and non-success status as an error', () => {
    const events = parseGeminiLine(
      JSON.stringify({ type: 'result', status: 'error', error: { message: 'quota exceeded' }, stats: undefined }),
    );
    assert.deepEqual(events, [{ type: 'error', message: 'quota exceeded' }]);
  });

  it('ignores unknown event types and throws on malformed JSON', () => {
    assert.deepEqual(parseGeminiLine(JSON.stringify({ type: 'totally_new', x: 1 })), []);
    assert.throws(() => parseGeminiLine('{{'));
  });
});

describe('gemini spawn integration (fake child, real plumbing)', () => {
  it('runs `gemini -p <prompt> --output-format stream-json --approval-mode yolo`', async () => {
    const child = new FakeChild();
    const calls: FakeSpawnCall[] = [];
    const adapter = new GeminiAdapter({ spawnFn: fakeSpawnFn(child, calls) });
    const handle = adapter.spawn('read notes.txt');
    const collected = collect(handle);

    const [head, tail] = splitMidFirstLine(FIXTURE);
    child.writeStdout(head);
    child.writeStderr('gemini: loading extensions…\n');
    child.writeStdout(tail);
    child.close(0);

    const { events, code } = await collected;
    assert.equal(code, 0);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.command, 'gemini');
    assert.deepEqual(calls[0]!.args, [
      '-p',
      'read notes.txt',
      '--output-format',
      'stream-json',
      '--approval-mode',
      'yolo',
    ]);

    const types = events.map((e) => e.type);
    // stderr preceded the first complete stdout line; init still leads all
    // stdout-derived events.
    const firstStdoutEvent = events[types.findIndex((t) => t !== 'progress')];
    assert.equal(firstStdoutEvent!.type, 'session', 'init leads stdout-derived events');
    assert.ok(types.includes('progress'));
    assert.ok(types.includes('usage'), 'usage extracted despite mid-line chunk boundary');
    assert.equal(child.stdinEnded, true);
  });

  it('resume runs `gemini -r <sessionId> -p <prompt> …`', async () => {
    const child = new FakeChild();
    const calls: FakeSpawnCall[] = [];
    const adapter = new GeminiAdapter({ spawnFn: fakeSpawnFn(child, calls) });
    const handle = adapter.resume('sess-g-9f31c2', 'continue');
    const collected = collect(handle);
    child.writeStdout(FIXTURE);
    child.close(0);
    await collected;
    assert.deepEqual(calls[0]!.args, [
      '-r',
      'sess-g-9f31c2',
      '-p',
      'continue',
      '--output-format',
      'stream-json',
      '--approval-mode',
      'yolo',
    ]);
  });

  it('surfaces a non-zero exit as an error event and resolves wait() with the code', async () => {
    const child = new FakeChild();
    const adapter = new GeminiAdapter({ spawnFn: fakeSpawnFn(child) });
    const { events, code } = await collect((() => {
      const h = adapter.spawn('boom');
      child.writeStdout(FIXTURE);
      child.close(2);
      return h;
    })());
    assert.equal(code, 2);
    const error = events.find((e) => e.type === 'error') as Extract<CanonicalEvent, { type: 'error' }>;
    assert.match(error.message, /exited with code 2/);
  });

  it('abort kills the child with SIGTERM', async () => {
    const child = new FakeChild();
    const adapter = new GeminiAdapter({ spawnFn: fakeSpawnFn(child) });
    const handle = adapter.spawn('long running');
    const collected = collect(handle);
    await new Promise((r) => setTimeout(r, 0));
    adapter.abort();
    assert.deepEqual(child.signals, ['SIGTERM']);
    child.close(null, 'SIGTERM');
    const { code } = await collected;
    assert.equal(code, -1);
  });
});

describe('gemini launch (driver contract)', () => {
  it('launch() yields canonical events and wait() resolves success on exit 0', async () => {
    const child = new FakeChild();
    const calls: FakeSpawnCall[] = [];
    const adapter = new GeminiAdapter({ spawnFn: fakeSpawnFn(child, calls) });

    const launchPromise = adapter.launch({ prompt: 'read notes.txt', model: 'gemini-3-pro' });
    child.writeStdout(FIXTURE);
    child.close(0);
    const handle = await launchPromise;

    const events: { type: string; [key: string]: unknown }[] = [];
    for await (const event of handle.attach()) {
      events.push(event as { type: string; [key: string]: unknown });
    }
    assert.equal(await handle.wait(), 'success');

    assert.deepEqual(calls[0]!.args, [
      '-p',
      'read notes.txt',
      '--output-format',
      'stream-json',
      '--approval-mode',
      'yolo',
      '-m',
      'gemini-3-pro',
    ]);
    assert.equal(handle.sessionId, 'sess-g-9f31c2');

    const types = events.map((e) => e.type);
    assert.equal(types[0], 'session');
    assert.ok(types.includes('message'));
    assert.ok(types.includes('tool_call'));
    assert.ok(types.includes('tool_result'));
    assert.ok(types.includes('usage'));

    const usage = events.find((e) => e.type === 'usage')!.usage as Record<string, number>;
    // stats.input (1250) is the uncached slice; cached (700) is cacheRead.
    assert.equal(usage.inputTokens, 1250);
    assert.equal(usage.cacheReadTokens, 700);
    assert.equal(usage.cacheWriteTokens, 0);
    assert.equal(usage.outputTokens, 300);
    assert.equal(usage.reasoningTokens, 100);
  });

  it('launch() maps resume onto `-r <id>` and wait() resolves error on non-zero exit', async () => {
    const child = new FakeChild();
    const calls: FakeSpawnCall[] = [];
    const adapter = new GeminiAdapter({ spawnFn: fakeSpawnFn(child, calls) });

    const launchPromise = adapter.launch({ prompt: 'continue', resume: 'sess-g-9f31c2' });
    child.close(2);
    const handle = await launchPromise;
    assert.deepEqual(calls[0]!.args.slice(0, 2), ['-r', 'sess-g-9f31c2']);
    assert.equal(await handle.wait(), 'error');
  });
});
