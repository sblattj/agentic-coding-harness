import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import type { SpawnOptions } from 'node:child_process';
import {
  ClaudeCodeAdapter,
  type ClaudeAdapterOptions,
  capabilities,
  type HarnessChildProcess,
  type SpawnFn,
} from './claude.ts';

const FIXTURE = readFileSync(
  new URL('./fixtures/claude-ndjson-sample.ndjson', import.meta.url),
  'utf8',
);
const FIXTURE_LINES = FIXTURE.trim().split('\n');

class FakeChild extends EventEmitter implements HarnessChildProcess {
  stdout: PassThrough = new PassThrough();
  stderr: PassThrough = new PassThrough();
  pid = 424242;
  killed = false;
  spawnargs: string[];

  constructor(spawnargs: string[]) {
    super();
    this.spawnargs = spawnargs;
  }

  kill(signal?: string): boolean {
    this.killed = true;
    if (signal === 'SIGTERM') {
      // claude traps SIGTERM and exits with code 143
      queueMicrotask(() => this.emit('close', 143, null));
    } else if (signal === 'SIGKILL') {
      queueMicrotask(() => this.emit('close', 137, null));
    }
    return true;
  }

  feed(text: string): void {
    this.stdout.write(text);
  }

  end(code: number | null = 0, signal: string | null = null): void {
    this.stdout.end();
    this.stderr.end();
    this.emit('close', code, signal);
  }
}

interface Captured {
  command: string;
  args: string[];
  options: SpawnOptions;
  child: FakeChild;
}

function makeAdapter(extra: Partial<ClaudeAdapterOptions> = {}): { adapter: ClaudeCodeAdapter; captured: Captured; stateDir: string } {
  const stateDir = mkdtempSync(path.join(tmpdir(), 'agent-harness-test-'));
  const captured = {} as Captured;
  const spawnFn: SpawnFn = (command, args, opts) => {
    const child = new FakeChild([...args]);
    captured.command = command;
    captured.args = child.spawnargs;
    captured.options = opts;
    captured.child = child;
    return child;
  };
  const adapter = new ClaudeCodeAdapter({ stateDir, spawnFn, ...extra });
  return { adapter, captured, stateDir };
}

async function collect(events: AsyncGenerator<unknown>): Promise<unknown[]> {
  const out: unknown[] = [];
  for await (const ev of events) out.push(ev);
  return out;
}

function cleanup(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

describe('ClaudeCodeAdapter.spawn', () => {
  it('passes prompt, stream-json, verbose, and default max-turns; sets per-run CLAUDE_CONFIG_DIR', async () => {
    const { adapter, captured, stateDir } = makeAdapter();
    adapter.spawn({ prompt: 'list files' });
    captured.child.end(0);

    assert.equal(captured.command, 'claude');
    assert.deepEqual(captured.options.stdio, ['ignore', 'pipe', 'pipe']);
    assert.ok(captured.args.includes('-p'));
    assert.equal(captured.args[captured.args.indexOf('-p') + 1], 'list files');
    assert.ok(captured.args.includes('--output-format'));
    assert.equal(captured.args[captured.args.indexOf('--output-format') + 1], 'stream-json');
    assert.ok(captured.args.includes('--verbose'));
    assert.ok(captured.args.includes('--max-turns'));
    assert.equal(captured.args[captured.args.indexOf('--max-turns') + 1], '250');
    assert.ok(!captured.args.includes('--resume'));

    const configDir = captured.options.env?.CLAUDE_CONFIG_DIR;
    assert.ok(configDir, 'CLAUDE_CONFIG_DIR must be set');
    assert.ok(configDir.startsWith(path.join(stateDir, 'claude-runs') + path.sep));
    assert.ok(!configDir.includes('--resume'), 'per-run dir keyed by run id, not argv');
    cleanup(stateDir);
  });

  it('passes --resume <sessionId> when RunSpec.resume is provided', async () => {
    const { adapter, captured, stateDir } = makeAdapter();
    adapter.spawn({ prompt: 'continue work', resume: 'sess-abc-123' });
    captured.child.end(0);

    assert.ok(captured.args.includes('--resume'));
    assert.equal(captured.args[captured.args.indexOf('--resume') + 1], 'sess-abc-123');
    assert.equal(captured.args[captured.args.indexOf('--max-turns') + 1], '250');
    cleanup(stateDir);
  });

  it('useDefaultClaudeConfig option: no per-run CLAUDE_CONFIG_DIR, inherited override dropped, configDir null', async () => {
    const { adapter, captured, stateDir } = makeAdapter({ useDefaultClaudeConfig: true });
    adapter.spawn({ prompt: 'x', env: { CLAUDE_CONFIG_DIR: '/inherited/should/be/dropped' } });
    captured.child.end(0);

    assert.equal(captured.options.env?.CLAUDE_CONFIG_DIR, undefined);
    assert.equal(adapter.configDir, null);
    assert.ok(!existsSync(path.join(stateDir, 'claude-runs')), 'no per-run dir is created');
    cleanup(stateDir);
  });

  it('AGENT_HARNESS_DEFAULT_CLAUDE_CONFIG=1 has the same effect; any other value keeps the per-run dir', async () => {
    const prev = process.env.AGENT_HARNESS_DEFAULT_CLAUDE_CONFIG;
    try {
      process.env.AGENT_HARNESS_DEFAULT_CLAUDE_CONFIG = '1';
      const a = makeAdapter();
      a.adapter.spawn({ prompt: 'x' });
      a.captured.child.end(0);
      assert.equal(a.captured.options.env?.CLAUDE_CONFIG_DIR, undefined);
      cleanup(a.stateDir);

      process.env.AGENT_HARNESS_DEFAULT_CLAUDE_CONFIG = '0';
      const b = makeAdapter();
      b.adapter.spawn({ prompt: 'x' });
      b.captured.child.end(0);
      assert.ok(b.captured.options.env?.CLAUDE_CONFIG_DIR, 'control: per-run dir still set');
      cleanup(b.stateDir);
    } finally {
      if (prev === undefined) delete process.env.AGENT_HARNESS_DEFAULT_CLAUDE_CONFIG;
      else process.env.AGENT_HARNESS_DEFAULT_CLAUDE_CONFIG = prev;
    }
  });

  it('honors explicit maxTurns and env merge', async () => {
    const { adapter, captured, stateDir } = makeAdapter();
    adapter.spawn({ prompt: 'x', maxTurns: 3, env: { FOO: 'bar' } });
    captured.child.end(0);

    assert.equal(captured.args[captured.args.indexOf('--max-turns') + 1], '3');
    assert.equal(captured.options.env?.FOO, 'bar');
    assert.ok(captured.options.env?.CLAUDE_CONFIG_DIR);
    cleanup(stateDir);
  });
});

describe('ClaudeCodeAdapter stream parsing', () => {
  it('parses the recorded NDJSON sample into step/message/usage events matching CanonicalTokenRecord', async () => {
    const { adapter, captured, stateDir } = makeAdapter();
    adapter.spawn({ prompt: 'read the file' });
    // Feed line 2 split across two chunks to prove cross-chunk NDJSON buffering.
    const [line1, line2, line3] = FIXTURE_LINES;
    const mid = Math.floor(line2.length / 2);
    captured.child.feed(line1 + '\n');
    captured.child.feed(line2.slice(0, mid));
    await new Promise((r) => setTimeout(r, 10));
    captured.child.feed(line2.slice(mid) + '\n' + line3 + '\n');
    captured.child.end(0);

    const events = await collect(adapter.attach());

    assert.equal(events.length, 3);

    assert.deepEqual(events[0], {
      type: 'step',
      payload: {
        sessionId: '8f4c2a6e-1111-4e2a-9b3c-000000000001',
        model: 'claude-sonnet-4-5-20250929',
      },
    });

    assert.equal((events[1] as any).type, 'message');
    const msg = (events[1] as any).payload;
    assert.equal(msg.role, 'assistant');
    assert.equal(msg.model, 'claude-sonnet-4-5-20250929');
    assert.equal(msg.text, 'Reading the file now.');
    assert.deepEqual(msg.usage, {
      input: 4,
      output: 118,
      cacheRead: 84,
      cacheWrite: 14629,
      reasoning: 0,
      models: [
        {
          model: 'claude-sonnet-4-5-20250929',
          input: 4,
          output: 118,
          cacheRead: 84,
          cacheWrite: 14629,
          reasoning: 0,
        },
      ],
    });

    assert.equal((events[2] as any).type, 'usage');
    // modelUsage is preferred over the per-message aggregate usage:
    // input 9 (not 4), cacheWrite 15231 (not 14629), output 431 (not 118).
    assert.deepEqual((events[2] as any).payload, {
      input: 9,
      output: 431,
      cacheRead: 92,
      cacheWrite: 15231,
      reasoning: 64,
      costUsd: 0.0771,
      models: [
        {
          model: 'claude-sonnet-4-5-20250929',
          input: 9,
          output: 431,
          cacheRead: 92,
          cacheWrite: 15231,
          reasoning: 64,
          costUsd: 0.0771,
        },
      ],
    });
    cleanup(stateDir);
  });

  it('skips malformed NDJSON lines without killing the stream', async () => {
    const { adapter, captured, stateDir } = makeAdapter();
    adapter.spawn({ prompt: 'x' });
    captured.child.feed('this is not json\n');
    captured.child.feed('{"type":"system","subtype":"init","session_id":"s1","model":"m"}\n');
    captured.child.end(0);

    const events = await collect(adapter.attach());
    assert.equal(events.length, 1);
    assert.deepEqual(events[0], {
      type: 'step',
      payload: { sessionId: 's1', model: 'm' },
    });
    cleanup(stateDir);
  });

  it('ignores unknown line types and non-tool_result user blocks, but keeps tool results', async () => {
    const { adapter, captured, stateDir } = makeAdapter();
    adapter.spawn({ prompt: 'x' });
    // A user line with a tool_result now yields a tool event...
    captured.child.feed(
      '{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_1","content":"ok"}]}}\n',
    );
    // ...while plain user text blocks are ignored,
    captured.child.feed(
      '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"hi"}]}}\n',
    );
    // a malformed user line is dropped WITHOUT counting a parse error,
    captured.child.feed('{"type":"user","message":42}\n');
    // and unknown line types still yield nothing.
    captured.child.feed('{"type":"some_future_type","data":1}\n');
    captured.child.feed(FIXTURE_LINES[2] + '\n');
    captured.child.end(0);

    const events = await collect(adapter.attach());
    assert.equal(events.length, 2);
    assert.deepEqual(events[0], {
      type: 'tool',
      payload: { phase: 'result', toolCallId: 'toolu_1', output: 'ok' },
    });
    assert.equal((events[1] as any).type, 'usage');
    cleanup(stateDir);
  });

  it('emits a message then one tool event per tool_use block on an assistant line', async () => {
    const { adapter, captured, stateDir } = makeAdapter();
    adapter.spawn({ prompt: 'x' });
    captured.child.feed(
      JSON.stringify({
        type: 'assistant',
        message: {
          model: 'claude-sonnet-4-5-20250929',
          content: [
            { type: 'text', text: 'Listing then reading.' },
            { type: 'tool_use', id: 'toolu_01a', name: 'Bash', input: { command: 'ls' } },
            { type: 'tool_use', id: 'toolu_01b', name: 'Read', input: { file_path: '/tmp/x' } },
          ],
        },
      }) + '\n',
    );
    captured.child.end(0);

    const events = await collect(adapter.attach());
    assert.deepEqual(
      events.map((e) => (e as any).type),
      ['message', 'tool', 'tool'],
    );
    assert.equal((events[0] as any).payload.text, 'Listing then reading.');
    assert.deepEqual((events[1] as any).payload, {
      phase: 'start',
      toolCallId: 'toolu_01a',
      name: 'Bash',
      input: { command: 'ls' },
    });
    assert.deepEqual((events[2] as any).payload, {
      phase: 'start',
      toolCallId: 'toolu_01b',
      name: 'Read',
      input: { file_path: '/tmp/x' },
    });
    cleanup(stateDir);
  });

  it('keeps the message event (for its usage) when an assistant line is tool_use only', async () => {
    const { adapter, captured, stateDir } = makeAdapter();
    adapter.spawn({ prompt: 'x' });
    captured.child.feed(
      JSON.stringify({
        type: 'assistant',
        message: {
          model: 'm',
          content: [{ type: 'tool_use', id: 'toolu_z', name: 'Bash', input: { command: 'ls' } }],
          usage: {
            input_tokens: 1,
            output_tokens: 2,
            cache_creation_input_tokens: 3,
            cache_read_input_tokens: 4,
            reasoning_tokens: 0,
          },
        },
      }) + '\n',
    );
    captured.child.end(0);

    const events = await collect(adapter.attach());
    assert.deepEqual(
      events.map((e) => (e as any).type),
      ['message', 'tool'],
    );
    assert.equal((events[0] as any).payload.text, undefined);
    assert.equal((events[0] as any).payload.usage.input, 1);
    cleanup(stateDir);
  });

  it('joins array tool_result content and carries is_error through', async () => {
    const { adapter, captured, stateDir } = makeAdapter();
    adapter.spawn({ prompt: 'x' });
    captured.child.feed(
      JSON.stringify({
        type: 'user',
        message: {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'toolu_s', content: 'plain string' },
            {
              type: 'tool_result',
              tool_use_id: 'toolu_a',
              content: [
                { type: 'text', text: 'line one\n' },
                { type: 'text', text: 'line two' },
              ],
              is_error: true,
            },
            { type: 'tool_result', tool_use_id: 'toolu_e' },
          ],
        },
      }) + '\n',
    );
    captured.child.end(0);

    const events = await collect(adapter.attach());
    assert.deepEqual(events, [
      { type: 'tool', payload: { phase: 'result', toolCallId: 'toolu_s', output: 'plain string' } },
      {
        type: 'tool',
        payload: {
          phase: 'result',
          toolCallId: 'toolu_a',
          output: 'line one\nline two',
          isError: true,
        },
      },
      { type: 'tool', payload: { phase: 'result', toolCallId: 'toolu_e', output: '' } },
    ]);
    cleanup(stateDir);
  });

  it('emits error with stderr tail on nonzero exit without abort', async () => {
    const { adapter, captured, stateDir } = makeAdapter();
    adapter.spawn({ prompt: 'x' });
    captured.child.stderr.write('boom: bad api key\n');
    captured.child.end(1);

    const events = await collect(adapter.attach());
    const err = events.find((e) => (e as any).type === 'error') as any;
    assert.ok(err, 'expected an error event');
    assert.equal(err.payload.exitCode, 1);
    assert.match(err.payload.stderrTail, /bad api key/);
    assert.ok(!events.some((e) => (e as any).type === 'aborted'));
    cleanup(stateDir);
  });
});

describe('ClaudeCodeAdapter.abort', () => {
  it('SIGTERM → exit 143 is treated as a clean aborted event, not an error', async () => {
    const { adapter, captured, stateDir } = makeAdapter();
    adapter.spawn({ prompt: 'long task' });

    adapter.abort();
    const events = await collect(adapter.attach());

    assert.equal((events[0] as any).type, 'aborted');
    assert.equal((events[0] as any).payload.exitCode, 143);
    assert.equal((events[0] as any).payload.signal, null);
    assert.ok(!events.some((e) => (e as any).type === 'error'));
    assert.ok(captured.child.killed);
    cleanup(stateDir);
  });

  it('abort after natural completion is a no-op', async () => {
    const { adapter, captured, stateDir } = makeAdapter();
    adapter.spawn({ prompt: 'quick task' });
    captured.child.end(0);
    await collect(adapter.attach());

    adapter.abort(); // must not throw; child already closed
    cleanup(stateDir);
  });

  it('SIGKILL escalation (claude ignored SIGTERM) still yields aborted, not error, with real signal recorded', async () => {
    const spawnFn: SpawnFn = (command, args, opts) => {
      const child = new FakeChild([...args]);
      // claude ignored SIGTERM; we escalated to SIGKILL → 137
      child.kill = (signal?: string) => {
        if (signal === 'SIGTERM') {
          queueMicrotask(() => child.emit('close', 137, 'SIGKILL'));
        }
        return true;
      };
      queueMicrotask(() => void opts);
      return child;
    };
    const stateDir = mkdtempSync(path.join(tmpdir(), 'agent-harness-test-'));
    const adapter = new ClaudeCodeAdapter({ stateDir, spawnFn });
    adapter.spawn({ prompt: 'stubborn task' });
    adapter.abort();

    const events = await collect(adapter.attach());
    assert.equal((events[0] as any).type, 'aborted');
    assert.equal((events[0] as any).payload.signal, 'SIGKILL');
    assert.equal((events[0] as any).payload.exitCode, 137);
    cleanup(stateDir);
  });
});

describe('capabilities', () => {
  it('matches the harness contract', () => {
    assert.deepEqual(capabilities(), {
      headless: true,
      streaming: true,
      resume: true,
      acp: false,
      tmuxFallback: true,
    });
    assert.deepEqual(new ClaudeCodeAdapter().capabilities, capabilities());
  });
});

describe('ClaudeCodeAdapter.launch (driver contract)', () => {
  it('launch() yields canonical events and wait() resolves success on exit 0', async () => {
    const { adapter, captured, stateDir } = makeAdapter();

    const launchPromise = adapter.launch({ prompt: 'read the file' });
    captured.child.feed(FIXTURE_LINES.join('\n') + '\n');
    captured.child.end(0);
    const handle = await launchPromise;

    const events: { type: string; [key: string]: unknown }[] = [];
    for await (const event of handle.attach()) {
      events.push(event as { type: string; [key: string]: unknown });
    }
    assert.equal(await handle.wait(), 'success');

    assert.equal(handle.sessionId, '8f4c2a6e-1111-4e2a-9b3c-000000000001');
    assert.deepEqual(
      events.map((e) => e.type),
      ['step', 'message', 'usage'],
    );

    assert.equal(events[0]!.type, 'step');
    assert.equal(events[0]!.sessionId, '8f4c2a6e-1111-4e2a-9b3c-000000000001');
    assert.equal(events[0]!.model, 'claude-sonnet-4-5-20250929');

    assert.equal(events[1]!.type, 'message');
    assert.equal(events[1]!.source, 'agent');
    assert.equal(events[1]!.content, 'Reading the file now.');

    const usage = events[2]!.usage as Record<string, number>;
    assert.equal(events[2]!.type, 'usage');
    assert.equal(usage.inputTokens, 9);
    assert.equal(usage.outputTokens, 431);
    assert.equal(usage.cacheReadTokens, 92);
    assert.equal(usage.cacheWriteTokens, 15231);
    assert.equal(usage.reasoningTokens, 64);
    assert.equal(usage.costUsd, 0.0771);
    assert.equal(usage.model, 'claude-sonnet-4-5-20250929');
    cleanup(stateDir);
  });

  it('surfaces tool_use/tool_result blocks as core tool_call/tool_result events', async () => {
    const { adapter, captured, stateDir } = makeAdapter();

    const launchPromise = adapter.launch({ prompt: 'x' });
    captured.child.feed(
      JSON.stringify({
        type: 'assistant',
        message: {
          model: 'm',
          content: [
            { type: 'text', text: 'running it' },
            { type: 'tool_use', id: 'toolu_01', name: 'Bash', input: { command: 'ls' } },
          ],
        },
      }) + '\n',
    );
    captured.child.feed(
      JSON.stringify({
        type: 'user',
        message: {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'toolu_01', content: [{ type: 'text', text: 'a\nb' }] },
          ],
        },
      }) + '\n',
    );
    captured.child.end(0);
    const handle = await launchPromise;

    const events: { type: string; [key: string]: unknown }[] = [];
    for await (const event of handle.attach()) {
      events.push(event as { type: string; [key: string]: unknown });
    }
    assert.deepEqual(
      events.map((e) => e.type),
      ['message', 'tool_call', 'tool_result'],
    );
    assert.equal(events[0]!.content, 'running it');
    assert.equal(events[1]!.agent, 'claude');
    assert.equal(events[1]!.toolCallId, 'toolu_01');
    assert.equal(events[1]!.functionName, 'Bash');
    assert.deepEqual(events[1]!.arguments, { command: 'ls' });
    assert.equal(events[2]!.toolCallId, 'toolu_01');
    assert.equal(events[2]!.content, 'a\nb');
    assert.equal(events[2]!.isError, undefined);
    cleanup(stateDir);
  });

  it('labels a multi-model run by the dominant model (by cost), not the first modelUsage key', async () => {
    const { adapter, captured, stateDir } = makeAdapter();
    // Real opus-5 run shape: haiku (a probe call) sorts first in modelUsage
    // but opus carries ~99% of the cost.
    const resultLine = JSON.stringify({
      type: 'result',
      subtype: 'success',
      session_id: 'sess-multi',
      is_error: false,
      total_cost_usd: 0.102816,
      usage: {
        input_tokens: 954,
        output_tokens: 1671,
        cache_creation_input_tokens: 7544,
        cache_read_input_tokens: 26282,
        reasoning_tokens: 55,
      },
      modelUsage: {
        'claude-haiku-4-5-20251001': { inputTokens: 950, outputTokens: 11, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, reasoningTokens: 0, costUSD: 0.001005 },
        'claude-opus-5[1m]': { inputTokens: 4, outputTokens: 1660, cacheCreationInputTokens: 7544, cacheReadInputTokens: 26282, reasoningTokens: 55, costUSD: 0.101811 },
      },
    });
    const launchPromise = adapter.launch({ prompt: 'x' });
    captured.child.feed(resultLine + '\n');
    captured.child.end(0);
    const handle = await launchPromise;

    const events: { type: string; [key: string]: unknown }[] = [];
    for await (const event of handle.attach()) {
      events.push(event as { type: string; [key: string]: unknown });
    }
    const usageEvent = events.find((e) => e.type === 'usage')!;
    const usage = usageEvent.usage as Record<string, unknown>;
    assert.ok(usage, 'expected a usage event with a canonical record');
    // Dominant BY COST (opus), not first/last in the provider's map order.
    assert.equal(usage.model, 'claude-opus-5[1m]');
    assert.equal(usage.costUsd, 0.102816);
    // Aggregate tokens keep the probe call's tokens; the per-model breakdown
    // rides through for the pricer.
    assert.equal(usage.inputTokens, 954);
    const models = (usage.extra as { raw: { models: { model: string; costUsd?: number }[] } }).raw.models;
    assert.equal(models.length, 2);
    assert.equal(models[0]!.model, 'claude-haiku-4-5-20251001');
    assert.equal(models[0]!.costUsd, 0.001005);
    assert.equal(models[1]!.model, 'claude-opus-5[1m]');
    assert.equal(models[1]!.costUsd, 0.101811);
    cleanup(stateDir);
  });

  it('launch() abort() yields an aborted verdict via wait()', async () => {
    const { adapter, captured, stateDir } = makeAdapter();

    const launchPromise = adapter.launch({ prompt: 'long task' });
    adapter.abort(); // kill the runner the outer adapter last launched
    const handle = await launchPromise;

    const events: { type: string }[] = [];
    for await (const event of handle.attach()) {
      events.push(event as { type: string });
    }
    assert.equal(await handle.wait(), 'aborted');
    assert.equal(events[0]!.type, 'aborted');
    assert.ok(captured.child.killed);
    cleanup(stateDir);
  });
});
