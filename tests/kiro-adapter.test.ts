import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  KiroAdapter,
  KIRO_CAPABILITIES,
  buildKiroArgs,
  buildKiroEnv,
  mapKiroTokens,
  parseKiroLine,
  parseKiroLineRecord,
} from '../src/adapters/kiro.js';
import { FakeChild, fakeSpawnFn, type FakeSpawnCall } from './helpers/fake-child.ts';

describe('kiro adapter', () => {
  it('capabilities', () => {
    assert.deepEqual(KIRO_CAPABILITIES, {
      headless: true,
      streaming: true,
      resume: true,
      acp: true,
      tmuxFallback: true,
    });
    const adapter = new KiroAdapter();
    assert.equal(adapter.id, 'kiro');
    assert.equal(adapter.capabilities, KIRO_CAPABILITIES);
  });

  it('builds chat args with the prompt as the final positional arg', () => {
    assert.deepEqual(buildKiroArgs({ prompt: 'hello world' }), [
      'chat',
      '--no-interactive',
      '--trust-all-tools',
      '--output-format',
      'stream-json',
      '--agent-engine',
      'v2',
      'hello world',
    ]);
  });

  it('maps resume to --resume / --resume-id and keeps the prompt last', () => {
    assert.deepEqual(buildKiroArgs({ prompt: 'p', resume: 'continue' }).slice(7), ['--resume', 'p']);
    assert.deepEqual(buildKiroArgs({ prompt: 'p', resume: { sessionId: 'abc123' } }).slice(7), [
      '--resume-id',
      'abc123',
      'p',
    ]);
  });

  it('passes KIRO_API_KEY through', () => {
    assert.equal(buildKiroEnv({ KIRO_API_KEY: 'sk-test' }).KIRO_API_KEY, 'sk-test');
  });

  it('maps known JSONL events to canonical events', () => {
    assert.deepEqual(parseKiroLine('{"type":"assistant","text":"hello"}'), [
      { type: 'message', role: 'assistant', text: 'hello' },
    ]);
    assert.deepEqual(parseKiroLine('{"type":"tool_use","name":"shell","toolCallId":"t1","input":{"cmd":"ls"}}'), [
      { type: 'tool', toolName: 'shell', phase: 'start', toolCallId: 't1', input: { cmd: 'ls' } },
    ]);
    assert.deepEqual(parseKiroLine('{"type":"error","message":"boom"}'), [{ type: 'error', message: 'boom' }]);
    assert.deepEqual(parseKiroLine('{"type":"session_start","sessionId":"s1"}'), [
      { type: 'session', sessionId: 's1' },
    ]);
  });

  it('maps usage events in both field vocabularies', () => {
    const mitmLine = JSON.stringify({
      type: 'metering',
      tokenUsage: { uncachedInputTokens: 3, cacheReadInputTokens: 4, cacheWriteInputTokens: 5, outputTokens: 6, totalTokens: 18 },
    });
    const [mitmEvent] = parseKiroLine(mitmLine);
    assert.equal(mitmEvent?.type, 'usage');
    if (mitmEvent?.type === 'usage') {
      assert.deepEqual(mitmEvent.tokens, {
        inputTokens: 3,
        cacheReadTokens: 4,
        cacheWriteTokens: 5,
        outputTokens: 6,
        reasoningTokens: null,
        totalTokens: 18,
        durationMs: null,
        raw: JSON.parse(mitmLine),
      });
    }

    const [plainEvent] = parseKiroLine('{"type":"usage","tokenUsage":{"inputTokens":1,"outputTokens":2}}');
    assert.equal(plainEvent?.type, 'usage');
    if (plainEvent?.type === 'usage') {
      assert.equal(plainEvent.tokens.inputTokens, 1);
      assert.equal(plainEvent.tokens.outputTokens, 2);
      assert.equal(plainEvent.tokens.totalTokens, null);
    }
  });

  it('maps unknown typed objects and non-JSON lines tolerantly', () => {
    assert.deepEqual(parseKiroLine('{"type":"weird_thing","stuff":1}'), [
      { type: 'step', payload: { type: 'weird_thing', stuff: 1 } },
    ]);
    assert.deepEqual(parseKiroLine('{"novalue":true}'), [{ type: 'step', payload: { novalue: true } }]);
    assert.deepEqual(parseKiroLine('not json'), []);
    assert.deepEqual(parseKiroLine(''), []);
    assert.deepEqual(parseKiroLine('[1,2,3]'), []);
  });

  it('captures sessionId from any line that carries one', () => {
    assert.equal(parseKiroLineRecord('{"type":"step_start","sessionId":"sid-9"}').sessionId, 'sid-9');
    assert.equal(parseKiroLineRecord('{"type":"assistant","text":"x"}').sessionId, undefined);
  });

  it('mapKiroTokens accepts a bare usage object without a tokenUsage envelope', () => {
    const tokens = mapKiroTokens({ uncachedInputTokens: '7', outputTokens: 2 });
    assert.equal(tokens.inputTokens, 7);
    assert.equal(tokens.outputTokens, 2);
    assert.equal(tokens.totalTokens, null);
  });
});

describe('kiro launch (driver contract)', () => {
  const LINES = [
    '{"type":"session_start","sessionId":"sess-k-1"}',
    '{"type":"assistant","text":"hi there"}',
    '{"type":"metering","tokenUsage":{"inputTokens":3,"outputTokens":4,"cacheReadTokens":5,"cacheWriteTokens":6,"totalTokens":18}}',
    '{"type":"weird_thing","stuff":1}',
  ];

  it('launch() runs kiro-cli chat headless, yields canonical events, and wait() resolves success', async () => {
    const child = new FakeChild();
    const calls: FakeSpawnCall[] = [];
    const adapter = new KiroAdapter({ command: 'kiro-cli', spawnFn: fakeSpawnFn(child, calls) });

    const launchPromise = adapter.launch({ prompt: 'hello kiro' });
    child.writeStdout(LINES.join('\n') + '\n');
    child.close(0);
    const handle = await launchPromise;

    const events: { type: string; [key: string]: unknown }[] = [];
    for await (const event of handle.attach()) {
      events.push(event as { type: string; [key: string]: unknown });
    }
    assert.equal(await handle.wait(), 'success');

    assert.equal(calls[0]!.command, 'kiro-cli');
    assert.deepEqual(calls[0]!.args.slice(0, 7), [
      'chat',
      '--no-interactive',
      '--trust-all-tools',
      '--output-format',
      'stream-json',
      '--agent-engine',
      'v2',
    ]);
    assert.equal(calls[0]!.args.at(-1), 'hello kiro');
    assert.equal(handle.sessionId, 'sess-k-1');

    assert.deepEqual(
      events.map((e) => e.type),
      ['session', 'message', 'usage', 'step'],
    );

    assert.equal(events[1]!.source, 'agent');
    assert.equal(events[1]!.content, 'hi there');

    const usage = events[2]!.usage as Record<string, number>;
    assert.equal(usage.inputTokens, 3);
    assert.equal(usage.outputTokens, 4);
    assert.equal(usage.cacheReadTokens, 5);
    assert.equal(usage.cacheWriteTokens, 6);
    assert.equal(
      (events[2]!.usage as { extra?: { totalTokens?: number } }).extra?.totalTokens,
      18,
    );

    // Unknown stream-json events become opaque step events with the raw payload.
    assert.equal(events[3]!.type, 'step');
    assert.deepEqual(events[3]!.data, { type: 'weird_thing', stuff: 1 });
  });

  it('launch() maps resume onto --resume-id and wait() resolves error on failure', async () => {
    const child = new FakeChild();
    const calls: FakeSpawnCall[] = [];
    const adapter = new KiroAdapter({ command: 'kiro-cli', spawnFn: fakeSpawnFn(child, calls) });

    const launchPromise = adapter.launch({ prompt: 'continue', resume: 'sess-k-1' });
    child.close(1);
    const handle = await launchPromise;

    assert.ok(calls[0]!.args.includes('--resume-id'));
    assert.equal(calls[0]!.args.at(-1), 'continue');
    assert.equal(handle.sessionId, 'sess-k-1');
    for await (const _event of handle.attach()) {
      // drain
    }
    assert.equal(await handle.wait(), 'error');
  });

  it('keeps the namespaced sessionId but stamps usage records with extra.kiroSessionId', async () => {
    // Live-verified kiro shape: no session_start/session event — the native id
    // rides an untyped line, so the driver handle reports the `kiro-` prefixed
    // fallback while the bare on-disk uuid is only captured out-of-band.
    const bare = 'e547cd92-1111-2222-3333-444455556666';
    const lines = [
      `{"type":"step_start","sessionId":"${bare}"}`,
      '{"type":"assistant","text":"hi there"}',
      '{"type":"metering","tokenUsage":{"inputTokens":3,"outputTokens":4,"totalTokens":7}}',
    ];
    const child = new FakeChild();
    const adapter = new KiroAdapter({ command: 'kiro-cli', spawnFn: fakeSpawnFn(child, []) });

    const launchPromise = adapter.launch({ prompt: 'correlate me' });
    child.writeStdout(lines.join('\n') + '\n');
    child.close(0);
    const handle = await launchPromise;
    const events: { type: string; [key: string]: unknown }[] = [];
    for await (const event of handle.attach()) {
      events.push(event as { type: string; [key: string]: unknown });
    }
    assert.equal(await handle.wait(), 'success');

    // The harness sessionId stays namespaced (transcript naming + uniqueness).
    assert.match(handle.sessionId, /^kiro-/);
    assert.notEqual(handle.sessionId, bare);

    // The usage record carries the bare native id in extra (same pattern as
    // extra.credits) — the id ~/.kiro/sessions/cli/<uuid>.jsonl uses.
    const usage = events.find((e) => e.type === 'usage');
    assert.ok(usage, 'no usage event');
    assert.equal((usage!.usage as { extra?: { kiroSessionId?: string } }).extra?.kiroSessionId, bare);
  });

  it('spawn() exposes the captured bare session id via nativeSessionId()', async () => {
    const child = new FakeChild();
    const adapter = new KiroAdapter({ command: 'kiro-cli', spawnFn: fakeSpawnFn(child, []) });
    const runHandle = adapter.spawn({ prompt: 'native id' });
    child.writeStdout('{"type":"step_start","sessionId":"bare-spawn-1"}\n');
    child.writeStdout('{"type":"metering","tokenUsage":{"inputTokens":1,"outputTokens":2}}\n');
    child.close(0);
    await runHandle.wait();
    assert.equal(runHandle.nativeSessionId(), 'bare-spawn-1');
    assert.equal(await runHandle.sessionId(), 'bare-spawn-1');
  });
});
