import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable, Writable } from 'node:stream';
import { execFileSync, execSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  OPENCODE_CAPABILITIES,
  OpenCodeAdapter,
  buildRunArgs,
  defaultOpencodeDbPath,
  parseOpencodeLine,
  parseOpencodeLineRecord,
  splitModelId,
  statsFromDb,
  statsViaCli,
  type OpencodeEvent,
  type OpencodeRunSpec,
} from './opencode.ts';
import type { SpawnFn } from './shared.ts';

// Recorded from a live `opencode run "Reply with exactly: hello world" --format
// json -m anthropic/claude-haiku-4-5` (opencode 1.18.30). Exactly the three
// event lines the parser must understand.
const FIXTURE_LINES = [
  '{"type":"step_start","timestamp":1789014419196,"sessionID":"ses_f766e6ed7ffeuv7ZvrUEbvFFhL","part":{"id":"prt_08991a6f800166yo2RsXMlkBoZ","messageID":"msg_089919202001Ve2AhNJzxeaL77","sessionID":"ses_f766e6ed7ffeuv7ZvrUEbvFFhL","type":"step-start"}}',
  '{"type":"text","timestamp":1789014419196,"sessionID":"ses_f766e6ed7ffeuv7ZvrUEbvFFhL","part":{"id":"prt_08991a6fa001hHx5LUJcwb69kw","messageID":"msg_089919202001Ve2AhNJzxeaL77","sessionID":"ses_f766e6ed7ffeuv7ZvrUEbvFFhL","type":"text","text":"hello world","time":{"start":1789014419194,"end":1789014419195}}}',
  '{"type":"step_finish","timestamp":1789014419224,"sessionID":"ses_f766e6ed7ffeuv7ZvrUEbvFFhL","part":{"id":"prt_08991a712001lcW2r11bX2XaYJ","reason":"stop","messageID":"msg_089919202001Ve2AhNJzxeaL77","sessionID":"ses_f766e6ed7ffeuv7ZvrUEbvFFhL","type":"step-finish","tokens":{"total":67632,"input":3,"output":5,"reasoning":0,"cache":{"write":67624,"read":0}},"cost":0.084558}}',
] as const;

const SESSION_ID = 'ses_f766e6ed7ffeuv7ZvrUEbvFFhL';

// Recorded from a live POST /session/:id/message against `opencode serve`.
const SERVER_MESSAGE_RESPONSE = {
  info: { sessionID: 'ses_srv_recorded_1', cost: 0.08506175 },
  parts: [
    { type: 'step-start', id: 'prt_s1', sessionID: 'ses_srv_recorded_1', messageID: 'msg_s1' },
    { type: 'text', text: 'hi', id: 'prt_s2', sessionID: 'ses_srv_recorded_1', messageID: 'msg_s1' },
    {
      reason: 'stop',
      type: 'step-finish',
      tokens: { total: 68038, input: 3, output: 4, reasoning: 0, cache: { write: 68031, read: 0 } },
      cost: 0.08506175,
      id: 'prt_s3',
      sessionID: 'ses_srv_recorded_1',
      messageID: 'msg_s1',
    },
  ],
};

async function collect(events: AsyncIterable<OpencodeEvent>): Promise<OpencodeEvent[]> {
  const out: OpencodeEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

interface FakeChildOptions {
  /** Keep stdout open after replaying lines; close only fires on kill(). */
  holdStdout?: boolean;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  stderrText?: string;
}

/**
 * SpawnFn stub that replays recorded NDJSON through the exact production
 * plumbing (runJsonlCli's spawn -> stdout 'data' -> LineAssembler -> parse).
 * Fires 'close' automatically unless holdStdout is set (abort testing).
 */
function fakeChild(
  lines: readonly string[],
  captured: { args?: string[] } = {},
  opts: FakeChildOptions = {},
): SpawnFn {
  return (command, args) => {
    captured.args = [command, ...args];
    const listeners = new Map<string, Array<(...a: unknown[]) => void>>();
    const on = (event: string, fn: (...a: unknown[]) => void) => {
      const list = listeners.get(event) ?? [];
      list.push(fn);
      listeners.set(event, list);
    };
    const fire = (event: string, ...a: unknown[]) => {
      for (const fn of listeners.get(event) ?? []) fn(...a);
    };
    const stdout = new Readable({ read() {} });
    const stderr = new Readable({ read() {} });
    const stdin = new Writable({ write(_c, _e, cb) { cb(); } });
    let stdoutEnded = false;
    let closed = false;
    const endStreams = () => {
      if (!stdoutEnded) {
        stdout.push(null);
        stdoutEnded = true;
      }
      stderr.push(null);
    };
    const close = (code: number | null, signal: NodeJS.Signals | null) => {
      if (closed) return;
      closed = true;
      endStreams();
      // setImmediate, not queueMicrotask: real streams deliver 'data' on
      // nextTick, which runs after all microtasks — a microtask close would
      // fire before any stdout chunk and race the run loop.
      setImmediate(() => fire('close', code, signal));
    };
    const proc = {
      stdout,
      stderr,
      stdin,
      kill(_signal?: NodeJS.Signals | number): boolean {
        close(opts.holdStdout ? (opts.exitCode ?? null) : (opts.exitCode ?? 0), opts.holdStdout ? 'SIGTERM' : (opts.signal ?? null));
        return true;
      },
      once(event: string, fn: (...a: unknown[]) => void) {
        on(event, fn);
        return proc;
      },
    };
    setImmediate(() => {
      for (const line of lines) stdout.push(line + '\n');
      if (opts.stderrText) stderr.push(opts.stderrText);
      if (!opts.holdStdout) setImmediate(() => close(opts.exitCode ?? 0, opts.signal ?? null));
    });
    return proc as never;
  };
}

describe('opencode adapter', () => {
  describe('parseOpencodeLineRecord (recorded NDJSON fixture)', () => {
    test('captures sessionID from every event line', () => {
      for (const line of FIXTURE_LINES) {
        assert.equal(parseOpencodeLineRecord(line).sessionId, SESSION_ID);
      }
    });

    test('step_start -> session + step; text -> assistant message', () => {
      const events = FIXTURE_LINES.flatMap((line) => parseOpencodeLine(line));
      assert.deepEqual(
        events.map((e) => e.type),
        ['session', 'step', 'message', 'usage'],
      );
      assert.deepEqual(events[2], { type: 'message', role: 'assistant', text: 'hello world' });
    });

    test('CanonicalTokenRecord from part.tokens, cost from part.cost', () => {
      const usage = parseOpencodeLine(FIXTURE_LINES[2])[0];
      if (!usage || usage.type !== 'usage') throw new Error(`expected usage event, got ${String(usage?.type)}`);
      assert.deepEqual(usage.tokens, {
        inputTokens: 3,
        cacheReadTokens: 0,
        cacheWriteTokens: 67624,
        outputTokens: 5,
        reasoningTokens: 0,
        totalTokens: 67632,
        durationMs: null,
        raw: {
          tokens: { total: 67632, input: 3, output: 5, reasoning: 0, cache: { write: 67624, read: 0 } },
          cost: 0.084558,
        },
      });
      assert.equal(usage.cost, 0.084558);
    });

    test('unknown event types are skipped but still yield their sessionID', () => {
      const line =
        '{"type":"tool","sessionID":"ses_other","part":{"type":"tool","tool":"bash","state":{"status":"pending"}}}';
      const parsed = parseOpencodeLineRecord(line);
      assert.deepEqual(parsed.events, []);
      assert.equal(parsed.sessionId, 'ses_other');
    });

    test('malformed JSON throws (run loop surfaces it as an error event)', () => {
      assert.throws(() => parseOpencodeLine('not json at all'));
    });
  });

  test('capabilities', () => {
    const adapter = new OpenCodeAdapter();
    assert.equal(adapter.id, 'opencode');
    assert.deepEqual(adapter.capabilities, {
      headless: true,
      streaming: true,
      resume: true,
      acp: true,
      tmuxFallback: true,
    });
    assert.deepEqual(OPENCODE_CAPABILITIES, adapter.capabilities);
  });

  describe('buildRunArgs', () => {
    test('prompt + --format json, model optional', () => {
      assert.deepEqual(buildRunArgs({ prompt: 'do a thing' }), ['run', 'do a thing', '--format', 'json']);
      assert.deepEqual(buildRunArgs({ prompt: 'p', model: 'anthropic/claude-haiku-4-5' }), [
        'run',
        'p',
        '--format',
        'json',
        '--model',
        'anthropic/claude-haiku-4-5',
      ]);
    });

    test('resume maps to -s/--session or -c/--continue', () => {
      assert.deepEqual(buildRunArgs({ prompt: 'p', resume: { sessionId: 'ses_abc' } }), [
        'run',
        'p',
        '--format',
        'json',
        '--session',
        'ses_abc',
      ]);
      assert.deepEqual(buildRunArgs({ prompt: 'p', resume: 'continue' }), [
        'run',
        'p',
        '--format',
        'json',
        '--continue',
      ]);
    });
  });

  test('splitModelId splits at the first slash', () => {
    assert.deepEqual(splitModelId('anthropic/claude-haiku-4-5'), {
      providerID: 'anthropic',
      modelID: 'claude-haiku-4-5',
    });
    assert.deepEqual(splitModelId('openrouter/openai/gpt-4o'), {
      providerID: 'openrouter',
      modelID: 'openai/gpt-4o',
    });
    assert.equal(splitModelId('claude-haiku-4-5'), undefined);
  });

  describe('spawn (headless, fake child through production plumbing)', () => {
    test('streams canonical events and captures sessionId/usage/cost', async () => {
      const captured: { args?: string[] } = {};
      const adapter = new OpenCodeAdapter({ command: 'opencode-test', spawnFn: fakeChild(FIXTURE_LINES, captured) });
      const handle = adapter.spawn({ prompt: 'Reply with exactly: hello world', model: 'anthropic/claude-haiku-4-5' });
      const events = await collect(handle.events);
      assert.deepEqual(
        events.map((e) => e.type),
        ['session', 'step', 'message', 'usage'],
      );
      assert.equal(await handle.wait(), 0);
      const result = await handle.result();
      assert.equal(result.exitCode, 0);
      assert.equal(result.sessionId, SESSION_ID);
      assert.equal(result.usage?.totalTokens, 67632);
      assert.equal(result.usage?.outputTokens, 5);
      assert.equal(result.cost, 0.084558);
      assert.equal(captured.args?.[0], 'opencode-test');
      assert.ok(captured.args.includes('--format') && captured.args.includes('json'));
      assert.ok(captured.args.includes('Reply with exactly: hello world'));
      assert.ok(captured.args.includes('--model'));
      assert.deepEqual(captured.args.slice(0, 3), ['opencode-test', 'run', 'Reply with exactly: hello world']);
    });

    test('resume() house signature uses -s/--session and captures sessionId mid-run', async () => {
      const captured: { args?: string[] } = {};
      const adapter = new OpenCodeAdapter({ command: 'opencode-test', spawnFn: fakeChild(FIXTURE_LINES, captured) });
      const handle = adapter.resume(SESSION_ID, 'next turn');
      assert.equal(await handle.wait(), 0);
      assert.ok(captured.args?.includes('--session'));
      assert.ok(captured.args?.includes(SESSION_ID));
      assert.equal(await handle.sessionId(), SESSION_ID);
    });

    test('resume: "continue" uses -c/--continue', async () => {
      const captured: { args?: string[] } = {};
      const adapter = new OpenCodeAdapter({ command: 'opencode-test', spawnFn: fakeChild(FIXTURE_LINES, captured) });
      const spec: OpencodeRunSpec = { prompt: 'p', resume: 'continue' };
      const handle = adapter.spawn(spec);
      assert.equal(await handle.wait(), 0);
      assert.ok(captured.args?.includes('--continue'));
      assert.ok(!captured.args?.includes('--session'));
    });

    test('abort kills the child; the stream ends and wait reports the signal', { timeout: 5000 }, async () => {
      const adapter = new OpenCodeAdapter({
        command: 'opencode-test',
        spawnFn: fakeChild(FIXTURE_LINES, {}, { holdStdout: true }),
      });
      const handle = adapter.spawn('long running task');
      const iterator = handle.events[Symbol.asyncIterator]();
      const first: OpencodeEvent[] = [];
      for (let i = 0; i < 4; i++) {
        const next = await iterator.next();
        assert.equal(next.done, false);
        first.push(next.value as OpencodeEvent);
      }
      assert.deepEqual(
        first.map((e) => e.type),
        ['session', 'step', 'message', 'usage'],
      );
      handle.abort();
      const done = await iterator.next();
      assert.equal(done.done, true);
      assert.equal(await handle.wait(), -1);
      assert.equal(await handle.result().then((r) => r.exitCode), -1);
    });

    test('non-zero exit surfaces an error event and the exit code', async () => {
      const adapter = new OpenCodeAdapter({
        command: 'opencode-test',
        spawnFn: fakeChild(
          ['{"type":"step_start","sessionID":"ses_x","part":{"type":"step-start"}}'],
          {},
          { exitCode: 2, stderrText: 'boom\n' },
        ),
      });
      const handle = adapter.spawn('p');
      const events = await collect(handle.events);
      assert.equal(events.at(-1)?.type, 'error');
      assert.equal(await handle.wait(), 2);
    });
  });

  describe('spawn (preferServer path, injected fetch)', () => {
    test('creates a session, posts the message, maps parts to canonical events', { timeout: 5000 }, async () => {
      const calls: Array<{ url: string; body?: unknown; method?: string }> = [];
      const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
        const urlStr = String(url);
        calls.push({ url: urlStr, method: init?.method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
        const isCreate = urlStr.endsWith('/session') && !urlStr.includes('/message');
        const json = isCreate ? { id: 'ses_srv_recorded_1' } : SERVER_MESSAGE_RESPONSE;
        return { ok: true, json: async () => json } as Response;
      }) as typeof fetch;

      const adapter = new OpenCodeAdapter({ fetchImpl, serverUrl: 'http://127.0.0.1:4399/' });
      const handle = adapter.spawn({
        prompt: 'Reply with exactly: hi',
        model: 'anthropic/claude-haiku-4-5',
        preferServer: true,
      });
      const events = await collect(handle.events);
      assert.equal(calls.length, 2);
      assert.equal(calls[0]?.url, 'http://127.0.0.1:4399/session');
      assert.equal(calls[0]?.method, 'POST');
      assert.equal(calls[1]?.url, 'http://127.0.0.1:4399/session/ses_srv_recorded_1/message');
      assert.deepEqual(calls[1]?.body, {
        parts: [{ type: 'text', text: 'Reply with exactly: hi' }],
        model: { providerID: 'anthropic', modelID: 'claude-haiku-4-5' },
      });
      assert.deepEqual(
        events.map((e) => e.type),
        ['session', 'step', 'message', 'usage'],
      );
      assert.equal(await handle.wait(), 0);
      const result = await handle.result();
      assert.equal(result.sessionId, 'ses_srv_recorded_1');
      assert.equal(result.cost, 0.08506175);
      assert.equal(result.usage?.cacheWriteTokens, 68031);
    });

    test('HTTP failure surfaces as an error event and non-zero exit', { timeout: 5000 }, async () => {
      const fetchImpl = (async () => ({ ok: false, status: 500, json: async () => ({}) }) as Response) as unknown as typeof fetch;
      const adapter = new OpenCodeAdapter({ fetchImpl });
      const handle = adapter.spawn({ prompt: 'p', preferServer: true });
      const events = await collect(handle.events);
      assert.equal(events.at(-1)?.type, 'error');
      assert.equal(await handle.wait(), 1);
    });
  });

  describe('attach', () => {
    test('async generator over parsed events from a foreign stream', async () => {
      const adapter = new OpenCodeAdapter();
      const events = await collect(adapter.attach(Readable.from(FIXTURE_LINES.map((l) => l + '\n'))));
      assert.deepEqual(
        events.map((e) => e.type),
        ['session', 'step', 'message', 'usage'],
      );
    });

    test('malformed lines become error events instead of crashing the stream', async () => {
      const adapter = new OpenCodeAdapter();
      const events = await collect(
        adapter.attach(Readable.from(['garbage line\n', ...FIXTURE_LINES.map((l) => l + '\n')])),
      );
      assert.equal(events[0]?.type, 'error');
      assert.deepEqual(
        events.slice(1).map((e) => e.type),
        ['session', 'step', 'message', 'usage'],
      );
    });
  });

  describe('launch (driver contract)', () => {
    test('launch() yields canonical events and wait() resolves success on exit 0', async () => {
      const captured: { args?: string[] } = {};
      const adapter = new OpenCodeAdapter({
        command: 'opencode-test',
        spawnFn: fakeChild(FIXTURE_LINES, captured),
      });

      const handle = await adapter.launch({ prompt: 'hi', model: 'anthropic/claude-haiku-4-5' });
      const events: { type: string; [key: string]: unknown }[] = [];
      for await (const event of handle.attach()) {
        events.push(event as { type: string; [key: string]: unknown });
      }
      assert.equal(await handle.wait(), 'success');

      assert.ok(captured.args?.includes('--model'));
      assert.ok(captured.args?.includes('anthropic/claude-haiku-4-5'));
      assert.equal(handle.sessionId, SESSION_ID);

      assert.deepEqual(
        events.map((e) => e.type),
        ['session', 'step', 'message', 'usage'],
      );

      const usage = events.find((e) => e.type === 'usage')!.usage as Record<string, number>;
      assert.equal(usage.inputTokens, 3);
      assert.equal(usage.outputTokens, 5);
      assert.equal(usage.cacheReadTokens, 0);
      assert.equal(usage.cacheWriteTokens, 67624);
      assert.equal(usage.reasoningTokens, 0);
      assert.equal(usage.costUsd, 0.084558);
    });

    test('launch() maps resume onto --session and wait() resolves error on failure', async () => {
      const captured: { args?: string[] } = {};
      const adapter = new OpenCodeAdapter({
        command: 'opencode-test',
        spawnFn: fakeChild(
          ['{"type":"step_start","sessionID":"ses_x","part":{"type":"step-start"}}'],
          captured,
          { exitCode: 2, stderrText: 'boom\n' },
        ),
      });

      const handle = await adapter.launch({ prompt: 'p', resume: SESSION_ID });
      const events: { type: string }[] = [];
      for await (const event of handle.attach()) {
        events.push(event as { type: string });
      }
      assert.ok(captured.args?.includes('--session'));
      assert.ok(captured.args?.includes(SESSION_ID));
      assert.equal(await handle.wait(), 'error');
      assert.equal(events.at(-1)?.type, 'error');
    });
  });

  describe('statsFromDb (read-only session stats)', () => {
    test('returns rows newest-first with a working limit', { timeout: 10000 }, async () => {
      const dir = mkdtempSync(join(tmpdir(), 'opencode-stats-'));
      const dbPath = join(dir, 'opencode.db');
      try {
        execFileSync(
          'sqlite3',
          [
            dbPath,
            'CREATE TABLE session (id text PRIMARY KEY, cost real DEFAULT 0 NOT NULL,' +
              ' tokens_input integer DEFAULT 0 NOT NULL, tokens_output integer DEFAULT 0 NOT NULL,' +
              ' tokens_reasoning integer DEFAULT 0 NOT NULL, tokens_cache_read integer DEFAULT 0 NOT NULL,' +
              ' tokens_cache_write integer DEFAULT 0 NOT NULL, time_created integer NOT NULL);' +
              "INSERT INTO session (id, cost, tokens_input, tokens_output, tokens_reasoning," +
              " tokens_cache_read, tokens_cache_write, time_created) VALUES" +
              " ('ses_a', 0.10, 10, 20, 1, 30, 40, 100)," +
              " ('ses_b', 0.20, 11, 21, 2, 31, 41, 300)," +
              " ('ses_c', 0.30, 12, 22, 3, 32, 42, 200);",
          ],
          { stdio: 'pipe' },
        );
        const rows = statsViaCli(dbPath, 2);
        assert.deepEqual(
          rows.map((r) => r.id),
          ['ses_b', 'ses_c'],
        );
        assert.deepEqual(rows[0], {
          id: 'ses_b', cost: 0.2, tokens_input: 11, tokens_output: 21,
          tokens_reasoning: 2, tokens_cache_read: 31, tokens_cache_write: 41, time_created: 300,
        });

        const rows1 = await statsFromDb(dbPath, 1);
        assert.equal(rows1.length, 1);
        assert.equal(rows1[0]?.id, 'ses_b');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    test('default db path points at the real store', () => {
      assert.equal(defaultOpencodeDbPath('/home/x'), '/home/x/.local/share/opencode/opencode.db');
      assert.match(defaultOpencodeDbPath(), /\.local\/share\/opencode\/opencode\.db$/);
    });
  });
});
