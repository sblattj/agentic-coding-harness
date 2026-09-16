import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { CodexAdapter, CODEX_CAPABILITIES, parseCodexLine } from '../src/adapters/codex.ts';
import type { CanonicalEvent } from '../src/adapters/types.ts';
import { FakeChild, fakeSpawnFn, splitMidFirstLine, type FakeSpawnCall } from './helpers/fake-child.ts';

const FIXTURE = readFileSync(join(import.meta.dirname, 'fixtures/codex-session.ndjson'), 'utf8');

async function collect(handle: { events: AsyncIterable<CanonicalEvent>; wait(): Promise<number> }) {
  const events: CanonicalEvent[] = [];
  for await (const event of handle.events) events.push(event);
  const code = await handle.wait();
  return { events, code };
}

describe('codex capabilities', () => {
  it('declares headless/streaming/resume with no ACP and tmux fallback', () => {
    assert.deepEqual(new CodexAdapter().capabilities, {
      headless: true,
      streaming: true,
      resume: true,
      acp: false,
      tmuxFallback: true,
    });
    assert.equal(new CodexAdapter().id, 'codex');
    assert.deepEqual(CODEX_CAPABILITIES, new CodexAdapter().capabilities);
  });
});

describe('codex parseCodexLine (recorded NDJSON)', () => {
  const events = FIXTURE.trim().split('\n').flatMap((line) => parseCodexLine(line));

  it('maps thread.started to a session event', () => {
    const session = events[0];
    assert.deepEqual(session, {
      type: 'session',
      sessionId: '0199c0de-7a10-7b20-a1c0-4f9e2d6b8a11',
    });
  });

  it('maps command_execution items to tool start + result with exit-code status', () => {
    const toolEvents = events.filter((e) => e.type === 'tool');
    assert.equal(toolEvents.length, 2);
    const [start, result] = toolEvents as Extract<CanonicalEvent, { type: 'tool' }>[];
    assert.deepEqual(start, {
      type: 'tool',
      toolName: 'shell',
      phase: 'start',
      toolCallId: 'item_0',
      input: 'ls -la',
    });
    assert.equal(result.phase, 'result');
    assert.equal(result.toolName, 'shell');
    assert.equal(result.status, 'success');
    assert.match(String(result.output), /total 0/);
  });

  it('maps reasoning and agent_message items to message events', () => {
    const messages = events.filter((e) => e.type === 'message') as Extract<
      CanonicalEvent,
      { type: 'message' }
    >[];
    assert.equal(messages.length, 2);
    assert.equal(messages[0]!.reasoning, true);
    assert.match(messages[0]!.text, /empty directory/);
    assert.equal(messages[1]!.role, 'assistant');
    assert.equal(messages[1]!.text, 'The directory is empty (no entries besides . and ..).');
    assert.equal(messages[1]!.reasoning, undefined);
  });

  it('extracts a CanonicalTokenRecord from turn.completed usage (input is uncached-only)', () => {
    const usage = events.find((e) => e.type === 'usage') as Extract<CanonicalEvent, { type: 'usage' }>;
    assert.deepEqual(usage.tokens, {
      // 1200 total prompt − 800 cached = 400 uncached input (OpenAI
      // accounting: input_tokens includes cached_input_tokens).
      inputTokens: 400,
      cacheReadTokens: 800,
      cacheWriteTokens: 0,
      outputTokens: 150,
      reasoningTokens: 42,
      totalTokens: null,
      durationMs: null,
      raw: {
        input_tokens: 1200,
        cached_input_tokens: 800,
        output_tokens: 150,
        reasoning_output_tokens: 42,
      },
    });
  });

  it('maps cache_write_input_tokens when the CLI reports it, else zero', () => {
    const [withWrite] = parseCodexLine(
      JSON.stringify({
        type: 'turn.completed',
        usage: {
          input_tokens: 100,
          cached_input_tokens: 40,
          cache_write_input_tokens: 25,
          output_tokens: 10,
        },
      }),
    ) as Extract<CanonicalEvent, { type: 'usage' }>[];
    assert.equal(withWrite.tokens.inputTokens, 60);
    assert.equal(withWrite.tokens.cacheWriteTokens, 25);
    assert.equal(withWrite.tokens.cacheReadTokens, 40);

    const [withoutWrite] = parseCodexLine(
      JSON.stringify({
        type: 'turn.completed',
        usage: { input_tokens: 100, output_tokens: 10 },
      }),
    ) as Extract<CanonicalEvent, { type: 'usage' }>[];
    assert.equal(withoutWrite.tokens.inputTokens, 100);
    assert.equal(withoutWrite.tokens.cacheWriteTokens, 0);
    assert.equal(withoutWrite.tokens.cacheReadTokens, 0);
    assert.equal(withoutWrite.tokens.reasoningTokens, null);
  });

  it('extracts usage from the verbatim live-recorded turn.completed line', () => {
    // Recorded 2026-09-09 from `codex exec --json` on this machine; note
    // cache_write_input_tokens present-and-zero.
    const [usage] = parseCodexLine(
      '{"type":"turn.completed","usage":{"input_tokens":21827,"cached_input_tokens":0,"cache_write_input_tokens":0,"output_tokens":5,"reasoning_output_tokens":0}}',
    ) as Extract<CanonicalEvent, { type: 'usage' }>[];
    assert.deepEqual(usage.tokens, {
      inputTokens: 21827,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 5,
      reasoningTokens: 0,
      totalTokens: null,
      durationMs: null,
      raw: {
        input_tokens: 21827,
        cached_input_tokens: 0,
        cache_write_input_tokens: 0,
        output_tokens: 5,
        reasoning_output_tokens: 0,
      },
    });
  });

  it('accepts both current (`type`) and legacy (`item_type`) item-kind spellings', () => {
    // Live codex emits item.kind as `type`; older builds used `item_type`.
    const modern = parseCodexLine(
      '{"type":"item.completed","item":{"id":"i0","type":"agent_message","text":"ok"}}',
    );
    assert.deepEqual(modern, [{ type: 'message', role: 'assistant', text: 'ok' }]);
    const legacy = parseCodexLine(
      '{"type":"item.completed","item":{"id":"i0","item_type":"agent_message","text":"ok"}}',
    );
    assert.deepEqual(legacy, [{ type: 'message', role: 'assistant', text: 'ok' }]);
  });

  it('ignores unknown event types and surfaces turn.failed as an error', () => {
    assert.deepEqual(parseCodexLine(JSON.stringify({ type: 'something.new', x: 1 })), []);
    const failed = parseCodexLine(
      JSON.stringify({ type: 'turn.failed', error: { message: 'rate limited' } }),
    );
    assert.deepEqual(failed, [{ type: 'error', message: 'rate limited' }]);
    assert.throws(() => parseCodexLine('{not json'));
  });
});

describe('codex spawn integration (fake child, real plumbing)', () => {
  it('runs `codex exec --json <prompt>`, buffers partial lines, forwards stderr as progress', async () => {
    const child = new FakeChild();
    const calls: FakeSpawnCall[] = [];
    const adapter = new CodexAdapter({ spawnFn: fakeSpawnFn(child, calls) });
    const handle = adapter.spawn('list the files');
    assert.equal(calls.length, 1, 'child spawned synchronously by spawn()');

    const collected = collect(handle);

    const [head, tail] = splitMidFirstLine(FIXTURE);
    child.writeStdout(head);
    child.writeStderr('codex: thinking…\n');
    child.writeStdout(tail);
    child.close(0);

    const { events, code } = await collected;
    assert.equal(code, 0);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0]!.args, ['exec', '--json', 'list the files']);
    assert.equal(calls[0]!.command, 'codex');
    // Env handed to spawn is a SNAPSHOT copy of process.env (never a live
    // reference — scrubEnv support, issue #8) carrying the same entries.
    assert.notEqual(calls[0]!.opts.env, process.env);
    assert.deepEqual({ ...calls[0]!.opts.env }, { ...process.env });

    const types = events.map((e) => e.type);
    // stderr was written while the first stdout line was still incomplete, so
    // the progress event legitimately precedes it; the first stdout-derived
    // event must still be thread.started.
    const firstStdoutEvent = events[types.findIndex((t) => t !== 'progress')];
    assert.equal(firstStdoutEvent!.type, 'session', 'thread.started leads stdout-derived events');
    assert.ok(types.includes('progress'));
    const progress = events.find((e) => e.type === 'progress') as Extract<CanonicalEvent, { type: 'progress' }>;
    assert.equal(progress.text, 'codex: thinking…');
    assert.ok(types.includes('usage'), 'usage extracted despite mid-line chunk boundary');
    assert.equal(child.stdinEnded, true);
  });

  it('spawn() passes -m <model> on fresh runs when opts.model is set', async () => {
    const child = new FakeChild();
    const calls: FakeSpawnCall[] = [];
    const adapter = new CodexAdapter({ spawnFn: fakeSpawnFn(child, calls) });
    const handle = adapter.spawn('list the files', { model: 'gpt-5.2-codex' });
    child.close(0);
    await handle.wait();
    assert.deepEqual(calls[0]!.args, ['exec', '--json', '-m', 'gpt-5.2-codex', 'list the files']);
  });

  it('spawn() omits -m when no model is given', async () => {
    const child = new FakeChild();
    const calls: FakeSpawnCall[] = [];
    const adapter = new CodexAdapter({ spawnFn: fakeSpawnFn(child, calls) });
    const handle = adapter.spawn('list the files');
    child.close(0);
    await handle.wait();
    assert.ok(!calls[0]!.args.includes('-m'));
  });

  it('forwards raw stdout chunks to opts.onOutput exactly as received, alongside canonical events', async () => {
    const child = new FakeChild();
    const adapter = new CodexAdapter({ spawnFn: fakeSpawnFn(child) });
    const chunks: string[] = [];
    const handle = adapter.spawn('list the files', {
      onOutput: (chunk) => chunks.push(chunk),
    });
    const collected = collect(handle);
    const [head, tail] = splitMidFirstLine(FIXTURE);
    child.writeStdout(head);
    child.writeStdout(tail);
    child.writeStdout('{"type":"turn.completed"}\n');
    child.close(0);
    const { events, code } = await collected;
    assert.equal(code, 0);
    // Raw tap: exact chunk strings, boundaries preserved (no line assembly).
    assert.deepEqual(chunks, [head, tail, '{"type":"turn.completed"}\n']);
    // Canonical events still parsed from the same chunks.
    assert.ok(events.some((e) => e.type === 'session'), 'session event parsed');
    assert.ok(events.some((e) => e.type === 'usage'), 'usage parsed across the chunk boundary');
  });

  it('a throwing onOutput tap never breaks the run', async () => {
    const child = new FakeChild();
    const adapter = new CodexAdapter({ spawnFn: fakeSpawnFn(child) });
    const handle = adapter.spawn('x', {
      onOutput: () => {
        throw new Error('tap exploded');
      },
    });
    const collected = collect(handle);
    child.writeStdout(FIXTURE);
    child.close(0);
    const { events, code } = await collected;
    assert.equal(code, 0, 'tap exception swallowed, run completes');
    assert.ok(events.some((e) => e.type === 'session'), 'events still parsed');
  });

  it('launch() forwards a RunSpec onOutput tap through the driver contract', async () => {
    const child = new FakeChild();
    const adapter = new CodexAdapter({ spawnFn: fakeSpawnFn(child) });
    const chunks: string[] = [];
    const handle = await adapter.launch({ prompt: 'list the files', onOutput: (c) => chunks.push(c) });
    const collected = (async () => {
      const events: unknown[] = [];
      for await (const event of handle.attach()) events.push(event);
      return { events, exit: await handle.wait() };
    })();
    child.writeStdout(FIXTURE);
    child.close(0);
    const { events, exit } = await collected;
    assert.equal(exit, 'success');
    assert.deepEqual(chunks, [FIXTURE], 'raw passthrough RunSpec tap received the exact chunk');
    assert.ok(events.some((e) => (e as { type: string }).type === 'session'));
  });

  it('launch() ignores a non-function onOutput passthrough value', async () => {
    const child = new FakeChild();
    const adapter = new CodexAdapter({ spawnFn: fakeSpawnFn(child) });
    const handle = await adapter.launch({ prompt: 'x', onOutput: 'not-a-function' } as unknown as import('../src/core/types.js').RunSpec);
    const collected = (async () => {
      for await (const _ of handle.attach()) void _;
      return handle.wait();
    })();
    child.writeStdout(FIXTURE);
    child.close(0);
    assert.equal(await collected, 'success');
  });

  it('resume runs `codex exec resume <sessionId> --json <prompt>`', async () => {
    const child = new FakeChild();
    const calls: FakeSpawnCall[] = [];
    const adapter = new CodexAdapter({ spawnFn: fakeSpawnFn(child, calls) });
    const handle = adapter.resume('0199c0de-7a10', 'continue');
    const collected = collect(handle);
    child.writeStdout(FIXTURE);
    child.close(0);
    await collected;
    assert.deepEqual(calls[0]!.args, ['exec', 'resume', '0199c0de-7a10', '--json', 'continue']);
  });

  it('surfaces a non-zero exit as an error event and resolves wait() with the code', async () => {
    const child = new FakeChild();
    const adapter = new CodexAdapter({ spawnFn: fakeSpawnFn(child) });
    const { events, code } = await collect((() => {
      const h = adapter.spawn('boom');
      child.writeStdout(FIXTURE);
      child.close(3);
      return h;
    })());
    assert.equal(code, 3);
    const error = events.find((e) => e.type === 'error') as Extract<CanonicalEvent, { type: 'error' }>;
    assert.match(error.message, /exited with code 3/);
  });

  it('converts unparseable stdout lines into error events without dying', async () => {
    const child = new FakeChild();
    const adapter = new CodexAdapter({ spawnFn: fakeSpawnFn(child) });
    const { events, code } = await collect((() => {
      const h = adapter.spawn('x');
      child.writeStdout('NOT-JSON\n');
      child.writeStdout(FIXTURE);
      child.close(0);
      return h;
    })());
    assert.equal(code, 0);
    assert.ok(events.some((e) => e.type === 'error' && /unparseable/.test(e.message)));
    assert.ok(events.some((e) => e.type === 'usage'), 'kept parsing after the bad line');
  });

  it('abort kills the child with SIGTERM', async () => {
    const child = new FakeChild();
    const adapter = new CodexAdapter({ spawnFn: fakeSpawnFn(child) });
    const handle = adapter.spawn('long running');
    const collected = collect(handle);
    await new Promise((r) => setTimeout(r, 0));
    adapter.abort();
    assert.deepEqual(child.signals, ['SIGTERM']);
    child.close(null, 'SIGTERM');
    const { code } = await collected;
    assert.equal(code, -1, 'signal-terminated children resolve with -1');
  });

  it('keeps streaming when a line maps to zero events while a consumer is parked (turn.started regression)', async () => {
    // Regression: push() with zero events used to consume the pending wake,
    // which the consumer interpreted as end-of-stream, stranding every later
    // event. Reproduces only when lines arrive across separate ticks with a
    // consumer already awaiting — not when the whole fixture lands in one
    // chunk before iteration starts.
    const child = new FakeChild();
    const adapter = new CodexAdapter({ spawnFn: fakeSpawnFn(child) });
    const handle = adapter.spawn('dribble');
    const collected = collect(handle);
    const lines = FIXTURE.trim().split('\n');
    for (const line of lines) {
      child.writeStdout(`${line}\n`);
      await new Promise((r) => setTimeout(r, 2));
    }
    child.close(0);
    const { events, code } = await collected;
    assert.equal(code, 0);
    const types = events.map((e) => e.type);
    assert.ok(types.includes('session'), 'thread.started survived');
    assert.ok(types.includes('usage'), 'turn.completed survived past the zero-event turn.started line');
    assert.equal(types[types.length - 1], 'usage', 'stream ended on the final fixture event, not early');
  });
});

describe('codex launch (driver contract)', () => {
  it('launch() runs `codex exec --json`, yields canonical events, and wait() resolves success on exit 0', async () => {
    const child = new FakeChild();
    const calls: FakeSpawnCall[] = [];
    const adapter = new CodexAdapter({ spawnFn: fakeSpawnFn(child, calls) });

    const launchPromise = adapter.launch({ prompt: 'list the files' });
    child.writeStdout(FIXTURE);
    child.close(0);
    const handle = await launchPromise;

    const events: { type: string; [key: string]: unknown }[] = [];
    for await (const event of handle.attach()) {
      events.push(event as { type: string; [key: string]: unknown });
    }
    assert.equal(await handle.wait(), 'success');

    assert.equal(calls[0]!.command, 'codex');
    assert.deepEqual(calls[0]!.args, ['exec', '--json', 'list the files']);
    assert.equal(handle.sessionId, '0199c0de-7a10-7b20-a1c0-4f9e2d6b8a11');

    const types = events.map((e) => e.type);
    assert.deepEqual(types[0], 'session');
    assert.ok(types.includes('message'));
    assert.ok(types.includes('tool_call'));
    assert.ok(types.includes('tool_result'));
    assert.ok(types.includes('usage'));

    const session = events[0]!;
    assert.equal(session.sessionId, '0199c0de-7a10-7b20-a1c0-4f9e2d6b8a11');

    const usage = events.find((e) => e.type === 'usage')!.usage as Record<string, number>;
    assert.equal(usage.inputTokens, 400); // 1200 − 800 cached, uncached-only
    assert.equal(usage.cacheReadTokens, 800);
    assert.equal(usage.outputTokens, 150);
    assert.equal(usage.reasoningTokens, 42);
    assert.equal(usage.cacheWriteTokens, 0);
  });

  it('launch() maps model and resume onto argv', async () => {
    const child = new FakeChild();
    const calls: FakeSpawnCall[] = [];
    const adapter = new CodexAdapter({ spawnFn: fakeSpawnFn(child, calls) });

    const launchPromise = adapter.launch({ prompt: 'continue', model: 'gpt-5.2-codex', resume: 'th_123' });
    child.close(0);
    await launchPromise;

    assert.deepEqual(calls[0]!.args, [
      'exec',
      'resume',
      'th_123',
      '--json',
      '-m',
      'gpt-5.2-codex',
      'continue',
    ]);
  });

  it('launch() passes -m <model> on fresh runs (no resume) too', async () => {
    const child = new FakeChild();
    const calls: FakeSpawnCall[] = [];
    const adapter = new CodexAdapter({ spawnFn: fakeSpawnFn(child, calls) });

    const launchPromise = adapter.launch({ prompt: 'fresh start', model: 'gpt-5.2-codex' });
    child.close(0);
    await launchPromise;

    assert.deepEqual(calls[0]!.args, [
      'exec',
      '--json',
      '-m',
      'gpt-5.2-codex',
      'fresh start',
    ]);
  });

  it('launch() wait() resolves error on non-zero exit', async () => {
    const child = new FakeChild();
    const adapter = new CodexAdapter({ spawnFn: fakeSpawnFn(child) });
    const launchPromise = adapter.launch({ prompt: 'boom' });
    child.close(3);
    const handle = await launchPromise;
    for await (const _event of handle.attach()) {
      // drain
    }
    assert.equal(await handle.wait(), 'error');
  });
});
