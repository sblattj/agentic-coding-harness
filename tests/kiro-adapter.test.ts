import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  KiroAdapter,
  KIRO_CAPABILITIES,
  KIRO_DEFAULT_ENGINE,
  buildKiroArgs,
  buildKiroEnv,
  kiroTrustFlag,
  mapKiroTokens,
  mitmRecordToUsageEvent,
  parseKiroLine,
  parseKiroLineRecord,
  tapTokensAvailable,
} from '../src/adapters/kiro.js';
import type { KiroEffective } from '../src/core/types.js';
import type { SpawnFn } from '../src/adapters/shared.ts';
import type { ChildProcess } from 'node:child_process';
import { FakeChild, runCall, versionProbeSpawnFn, type FakeSpawnCall } from './helpers/fake-child.ts';

const BASE_ARGS = ['chat', '--no-interactive', '--output-format', 'stream-json', '--agent-engine', 'v2'];

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

  it('builds chat args with the prompt last and NO trust flag by default', () => {
    const args = buildKiroArgs({ prompt: 'hello world' });
    assert.deepEqual(args, [...BASE_ARGS, 'hello world']);
    // The implicit --trust-all-tools is gone (issue #2): an unspecified trust
    // policy must leave the decision to kiro's own native agent config.
    assert.equal(args.includes('--trust-all-tools'), false);
    assert.equal(args.some((a) => a.startsWith('--trust-tools')), false);
    assert.equal(KIRO_DEFAULT_ENGINE, 'v2');
  });

  it('kiroTrustFlag maps every trust policy, and undefined means no flag', () => {
    assert.equal(kiroTrustFlag(undefined), null);
    assert.equal(kiroTrustFlag('all'), '--trust-all-tools');
    assert.equal(kiroTrustFlag('none'), '--trust-tools=');
    assert.equal(kiroTrustFlag(['fs_read', 'execute_bash']), '--trust-tools=fs_read,execute_bash');
    assert.equal(kiroTrustFlag([]), '--trust-tools=');
  });

  it('forwards every config field into argv, in flag order, prompt last', () => {
    assert.deepEqual(
      buildKiroArgs({
        prompt: 'go',
        model: 'claude-haiku-4.5',
        kiro: {
          agent: 'my-agent',
          engine: 'v3',
          effort: 'high',
          tools: ['fs_read', 'execute_bash'],
          requireMcpStartup: true,
        },
      }),
      [
        'chat',
        '--no-interactive',
        '--output-format',
        'stream-json',
        '--agent-engine',
        'v3',
        '--model',
        'claude-haiku-4.5',
        '--agent',
        'my-agent',
        '--effort',
        'high',
        '--require-mcp-startup',
        '--trust-tools=fs_read,execute_bash',
        'go',
      ],
    );
    assert.deepEqual(buildKiroArgs({ prompt: 'go', kiro: { tools: 'all' } }), [
      ...BASE_ARGS,
      '--trust-all-tools',
      'go',
    ]);
    assert.deepEqual(buildKiroArgs({ prompt: 'go', kiro: { tools: 'none' } }), [
      ...BASE_ARGS,
      '--trust-tools=',
      'go',
    ]);
    // --require-mcp-startup is a flag, not a value: false must emit nothing.
    assert.deepEqual(buildKiroArgs({ prompt: 'go', kiro: { requireMcpStartup: false } }), [...BASE_ARGS, 'go']);
  });

  it('appends extraArgs verbatim AFTER every flag and BEFORE the prompt', () => {
    const args = buildKiroArgs({
      prompt: 'p',
      model: 'm',
      kiro: { tools: 'all' },
      extraArgs: ['--experimental', '--flag=x y'],
    });
    assert.deepEqual(args, [...BASE_ARGS, '--model', 'm', '--trust-all-tools', '--experimental', '--flag=x y', 'p']);
    assert.equal(args.at(-1), 'p');
    assert.equal(args.indexOf('--experimental'), args.indexOf('--trust-all-tools') + 1);
  });

  it('maps resume to --resume / --resume-id, before extraArgs, prompt last', () => {
    assert.deepEqual(buildKiroArgs({ prompt: 'p', resume: 'continue' }).slice(BASE_ARGS.length), ['--resume', 'p']);
    assert.deepEqual(buildKiroArgs({ prompt: 'p', resume: { sessionId: 'abc123' } }).slice(BASE_ARGS.length), [
      '--resume-id',
      'abc123',
      'p',
    ]);
    assert.deepEqual(
      buildKiroArgs({ prompt: 'p', resume: 'continue', extraArgs: ['--x'] }).slice(BASE_ARGS.length),
      ['--resume', '--x', 'p'],
    );
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
    const adapter = new KiroAdapter({ command: 'kiro-cli', spawnFn: versionProbeSpawnFn(child, calls) });

    const launchPromise = adapter.launch({ prompt: 'hello kiro' });
    child.writeStdout(LINES.join('\n') + '\n');
    child.close(0);
    const handle = await launchPromise;

    const events: { type: string; [key: string]: unknown }[] = [];
    for await (const event of handle.attach()) {
      events.push(event as { type: string; [key: string]: unknown });
    }
    assert.equal(await handle.wait(), 'success');

    const call = runCall(calls);
    assert.equal(call.command, 'kiro-cli');
    assert.deepEqual(call.args.slice(0, BASE_ARGS.length), BASE_ARGS);
    assert.equal(call.args.at(-1), 'hello kiro');
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

    // Unknown stream-json events become opaque, non-turn vendor steps that
    // carry the raw payload (createKiroNormalizer's vendorStep shape).
    assert.equal(events[3]!.type, 'step');
    assert.deepEqual(events[3]!.data, {
      kind: 'vendor',
      transport: 'headless',
      countsAsTurn: false,
      raw: { type: 'weird_thing', stuff: 1 },
    });
  });

  it('launch() maps resume onto --resume-id and wait() resolves error on failure', async () => {
    const child = new FakeChild();
    const calls: FakeSpawnCall[] = [];
    const adapter = new KiroAdapter({ command: 'kiro-cli', spawnFn: versionProbeSpawnFn(child, calls) });

    const launchPromise = adapter.launch({ prompt: 'continue', resume: 'sess-k-1' });
    child.close(1);
    const handle = await launchPromise;

    assert.ok(runCall(calls).args.includes('--resume-id'));
    assert.equal(runCall(calls).args.at(-1), 'continue');
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
    const adapter = new KiroAdapter({ command: 'kiro-cli', spawnFn: versionProbeSpawnFn(child, []) });

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
    const adapter = new KiroAdapter({ command: 'kiro-cli', spawnFn: versionProbeSpawnFn(child, []) });
    const runHandle = adapter.spawn({ prompt: 'native id' });
    child.writeStdout('{"type":"step_start","sessionId":"bare-spawn-1"}\n');
    child.writeStdout('{"type":"metering","tokenUsage":{"inputTokens":1,"outputTokens":2}}\n');
    child.close(0);
    await runHandle.wait();
    assert.equal(runHandle.nativeSessionId(), 'bare-spawn-1');
    assert.equal(await runHandle.sessionId(), 'bare-spawn-1');
  });

  it('launch() forwards model, kiro config and extraArgs from the RunSpec to argv', async () => {
    const child = new FakeChild();
    const calls: FakeSpawnCall[] = [];
    const adapter = new KiroAdapter({ command: 'kiro-cli', spawnFn: versionProbeSpawnFn(child, calls) });

    const launchPromise = adapter.launch({
      prompt: 'configured',
      model: 'claude-haiku-4.5',
      kiro: { agent: 'reviewer', engine: 'v3', effort: 'xhigh', tools: 'none', requireMcpStartup: true },
      extraArgs: ['--zzz'],
    });
    child.close(0);
    await launchPromise;

    assert.deepEqual(runCall(calls).args, [
      'chat',
      '--no-interactive',
      '--output-format',
      'stream-json',
      '--agent-engine',
      'v3',
      '--model',
      'claude-haiku-4.5',
      '--agent',
      'reviewer',
      '--effort',
      'xhigh',
      '--require-mcp-startup',
      '--trust-tools=',
      '--zzz',
      'configured',
    ]);
  });

  it('probes kiro-cli --version ONCE per adapter instance and caches it', async () => {
    const calls: FakeSpawnCall[] = [];
    const child1 = new FakeChild();
    const spawnFn = versionProbeSpawnFn(child1, calls);
    const adapter = new KiroAdapter({ command: 'kiro-cli', spawnFn });

    const first = adapter.launch({ prompt: 'a' });
    child1.close(0);
    const handle1 = await first;
    assert.equal(handle1.kiro?.()?.cliVersion, 'kiro-cli 2.21.2');

    const second = adapter.launch({ prompt: 'b' });
    child1.close(0);
    await second;

    const versionCalls = calls.filter((c) => c.args[0] === '--version');
    assert.equal(versionCalls.length, 1, 'the --version probe must be cached per adapter instance');
    assert.equal(versionCalls[0]!.command, 'kiro-cli');
  });

  it('a hung `--version` probe never holds launch()/wait() open: cliVersion falls back to unknown', async () => {
    // A binary that ignores --version (or a stub that never closes) used to
    // pin wait() forever because version.settle() awaited the probe.
    const calls: FakeSpawnCall[] = [];
    const child = new FakeChild();
    const hungProbe = new FakeChild();
    const spawnFn: SpawnFn = (command, args, opts) => {
      calls.push({ command, args, opts });
      if (args[0] === '--version') return hungProbe as unknown as ChildProcess;
      queueMicrotask(() => child.emit('spawn'));
      return child as unknown as ChildProcess;
    };
    const adapter = new KiroAdapter({ command: 'kiro-cli', spawnFn, versionProbeMs: 40 });

    const launchPromise = adapter.launch({ prompt: 'ping' });
    child.writeStdout('{"type":"runFinished","data":{"sessionId":"sid-hung","status":"success"}}\n');
    child.close(0);
    const handle = await launchPromise;
    for await (const _ of handle.attach()) {
      /* drain */
    }
    assert.equal(await handle.wait(), 'success');
    assert.equal(handle.kiro?.()?.cliVersion, 'unknown');
    assert.deepEqual(hungProbe.signals, ['SIGKILL'], 'the ceiling must reap the hung probe');
    assert.equal(calls.filter((c) => c.args[0] === '--version').length, 1);
  });

  it('a `failed to set model` stderr warning sets modelAck:unsupported and emits a step', async () => {
    const child = new FakeChild();
    const adapter = new KiroAdapter({ command: 'kiro-cli', spawnFn: versionProbeSpawnFn(child, []) });

    const launchPromise = adapter.launch({ prompt: 'ack me', model: 'claude-haiku-4.5' });
    child.writeStderr("[warn] failed to set model 'claude-haiku-4.5': Method not found\n");
    child.writeStdout('{"type":"runFinished","data":{"sessionId":"sid-ack","status":"success"}}\n');
    child.close(0);
    const handle = await launchPromise;

    const events: { type: string; data?: unknown }[] = [];
    for await (const event of handle.attach()) events.push(event as { type: string; data?: unknown });
    assert.equal(await handle.wait(), 'success');

    const ackStep = events.find(
      (e) => e.type === 'step' && (e.data as { kind?: string } | undefined)?.kind === 'modelAck',
    );
    assert.ok(ackStep, `no modelAck step: ${JSON.stringify(events.map((e) => e.type))}`);
    assert.deepEqual(ackStep!.data, {
      kind: 'modelAck',
      transport: 'headless',
      countsAsTurn: false,
      modelAck: 'unsupported',
      model: 'claude-haiku-4.5',
      raw: "[warn] failed to set model 'claude-haiku-4.5': Method not found",
    });

    const effective = handle.kiro?.();
    assert.ok(effective, 'launch() did not expose the effective config');
    assert.equal(effective!.modelAck, 'unsupported');
    // A refused model is NOT effective.
    assert.equal(effective!.effective.model, undefined);
    assert.equal(effective!.requested.transport, undefined);
  });

  it('a model with no warning is unverified (headless never acknowledges); no model is not-requested', async () => {
    const childA = new FakeChild();
    const a = new KiroAdapter({ command: 'kiro-cli', spawnFn: versionProbeSpawnFn(childA, []) });
    const pa = a.launch({ prompt: 'p', model: 'claude-haiku-4.5' });
    childA.close(0);
    const ha = await pa;
    assert.equal(ha.kiro?.()?.modelAck, 'unverified');
    assert.equal(ha.kiro?.()?.effective.model, 'claude-haiku-4.5');

    const childB = new FakeChild();
    const b = new KiroAdapter({ command: 'kiro-cli', spawnFn: versionProbeSpawnFn(childB, []) });
    const pb = b.launch({ prompt: 'p' });
    childB.close(0);
    const hb = await pb;
    assert.equal(hb.kiro?.()?.modelAck, 'not-requested');
    assert.equal(hb.kiro?.()?.effective.model, undefined);
  });

  it('effective config: argv minus the prompt, trust flag, engine, agent, hash is prompt-stable', async () => {
    const run = async (prompt: string): Promise<KiroEffective | undefined> => {
      const child = new FakeChild();
      const adapter = new KiroAdapter({ command: 'kiro-cli', spawnFn: versionProbeSpawnFn(child, []) });
      const p = adapter.launch({
        prompt,
        kiro: { agent: 'reviewer', tools: ['fs_read'] },
      });
      child.writeStdout('{"type":"runFinished","data":{"sessionId":"sid-eff","status":"success"}}\n');
      child.close(0);
      const h = await p;
      for await (const _e of h.attach()) {
        /* drain */
      }
      await h.wait();
      return h.kiro?.();
    };
    const first = await run('prompt one');
    assert.ok(first);
    assert.equal(first!.transport, 'headless');
    assert.equal(first!.cliVersion, 'kiro-cli 2.21.2');
    assert.equal(first!.nativeSessionId, 'sid-eff');
    assert.deepEqual(first!.requested, { agent: 'reviewer', tools: ['fs_read'] });
    assert.deepEqual(first!.effective, {
      argv: [...BASE_ARGS, '--agent', 'reviewer', '--trust-tools=fs_read'],
      trustFlag: '--trust-tools=fs_read',
      engine: 'v2',
      agent: 'reviewer',
    });
    // The prompt is run input, not config: it is out of argv AND out of the hash.
    assert.equal((first!.effective.argv as string[]).includes('prompt one'), false);
    assert.match(first!.configHash, /^[0-9a-f]{64}$/);

    const second = await run('a completely different prompt');
    assert.equal(second!.configHash, first!.configHash);
  });

  it('replays the real 2.21.2 stream-json fixture through launch(): session, message, usage, no fabricated tokens', async () => {
    const fixture = readFileSync(
      fileURLToPath(new URL('./fixtures/kiro/headless-stream-json-2.21.2.jsonl', import.meta.url)),
      'utf8',
    );
    const child = new FakeChild();
    const adapter = new KiroAdapter({ command: 'kiro-cli', spawnFn: versionProbeSpawnFn(child, []) });

    const launchPromise = adapter.launch({ prompt: 'ping' });
    child.writeStdout(fixture);
    child.close(0);
    const handle = await launchPromise;

    const events: { type: string; [k: string]: unknown }[] = [];
    for await (const event of handle.attach()) events.push(event as { type: string; [k: string]: unknown });
    assert.equal(await handle.wait(), 'success');

    const NATIVE = 'd031eff1-edd7-46d2-9838-3520ad69cd1c';
    const session = events.filter((e) => e.type === 'session');
    assert.equal(session.length, 1, 'the session id must be emitted exactly once');
    assert.equal(session[0]!.sessionId, NATIVE);

    // Chunks coalesce into exactly ONE message per turn.
    const messages = events.filter((e) => e.type === 'message');
    assert.equal(messages.length, 1, `expected one coalesced message, got ${messages.length}`);
    assert.equal(messages[0]!.content, 'PONG');

    const usage = events.filter((e) => e.type === 'usage');
    assert.equal(usage.length, 1, 'exactly one metering-bearing metadata frame in the fixture');
    const record = usage[0]!.usage as Record<string, unknown>;
    // kiro 2.21.2 reports NO token counts: the placeholders must stay 0 and
    // nothing may invent a cost from the credits.
    assert.equal(record.inputTokens, 0);
    assert.equal(record.outputTokens, 0);
    assert.equal(record.cacheReadTokens, 0);
    assert.equal(record.cacheWriteTokens, 0);
    assert.equal(record.costUsd, undefined);

    // The run's terminal evidence rides a step (CanonicalEvent has no terminal).
    const finished = events.find(
      (e) => e.type === 'step' && (e.data as { kind?: string } | undefined)?.kind === 'runFinished',
    );
    assert.ok(finished, 'no runFinished step');
    assert.equal((finished!.data as { stopReason?: string }).stopReason, 'end_turn');

    assert.equal(handle.kiro?.()?.nativeSessionId, NATIVE);
    assert.equal(handle.kiro?.()?.modelAck, 'not-requested');
  });
});

describe('kiro tap token honesty', () => {
  const base = { agent: 'kiro', inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

  it('an all-zero tap record is credits-only: tokensAvailable false, credits kept', () => {
    const event = mitmRecordToUsageEvent({ ...base, extra: { credits: 0.042, event: 'meteringEvent' } });
    assert.equal(tapTokensAvailable({ ...base }), false);
    assert.equal(event.mitmRecord.extra?.tokensAvailable, false);
    assert.equal(event.mitmRecord.extra?.source, 'tap');
    assert.equal(event.mitmRecord.extra?.credits, 0.042);
    assert.equal(event.tokens.inputTokens, 0);
  });

  it('any non-zero token field flips tokensAvailable true and the counts survive', () => {
    const rec = { ...base, inputTokens: 12, extra: { credits: 0.5 } };
    assert.equal(tapTokensAvailable(rec), true);
    const event = mitmRecordToUsageEvent(rec);
    assert.equal(event.mitmRecord.extra?.tokensAvailable, true);
    assert.equal(event.tokens.inputTokens, 12);
    assert.equal(event.mitmRecord.extra?.credits, 0.5);
  });
});
