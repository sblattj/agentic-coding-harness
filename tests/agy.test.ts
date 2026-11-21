import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { AgyAdapter, AGY_CAPABILITIES, AgyStreamParser, agySandboxArgs, agyTranscriptModel } from '../src/adapters/agy.ts';
import { parseAgyTranscript } from '../src/monitors/transcripts.ts';
import { normalizeUsage } from '../src/core/normalize.ts';
import { extractRawTokens } from '../src/cli/audit.ts';
import type { CanonicalEvent } from '../src/adapters/types.ts';
import { FakeChild, fakeSpawnFn, type FakeSpawnCall } from './helpers/fake-child.ts';

// Every fixture is a real `agy -p … --output-format stream-json` recording
// (agy 1.5.6, issue #231); only init.tools was trimmed and long errors cut to
// their first line.
const HERE = fileURLToPath(new URL('.', import.meta.url));
const fixture = (name: string): string => readFileSync(join(HERE, 'fixtures/agy', name), 'utf8');

function parseAll(text: string): CanonicalEvent[] {
  const parser = new AgyStreamParser();
  return text.trim().split('\n').flatMap((line) => parser.parse(line));
}

type Of<T extends CanonicalEvent['type']> = Extract<CanonicalEvent, { type: T }>;
const ofType = <T extends CanonicalEvent['type']>(events: CanonicalEvent[], type: T): Of<T>[] =>
  events.filter((e) => e.type === type) as Of<T>[];

describe('agy capabilities', () => {
  it('declares headless/streaming/resume with ACP', () => {
    const adapter = new AgyAdapter();
    assert.equal(adapter.id, 'agy');
    assert.deepEqual(adapter.capabilities, AGY_CAPABILITIES);
    assert.deepEqual(AGY_CAPABILITIES, { headless: true, streaming: true, resume: true, acp: true, tmuxFallback: true });
  });
});

describe('agy stream-json parser (recorded runs)', () => {
  it('text run: session, one coalesced message, one per-call usage, one bracketed model call', () => {
    const events = parseAll(fixture('stream-text.ndjson'));
    assert.deepEqual(events[0], { type: 'session', sessionId: '34bd9980-6fcc-4ded-9320-729925161abc' });
    assert.deepEqual(ofType(events, 'message'), [{ type: 'message', role: 'assistant', text: 'pong\n' }]);
    const usage = ofType(events, 'usage');
    assert.equal(usage.length, 1);
    assert.equal(usage[0]!.tokens.inputTokens, 16512);
    assert.equal(usage[0]!.tokens.cacheReadTokens, 0);
    assert.equal(usage[0]!.tokens.cacheWriteTokens, 0);
    assert.equal(usage[0]!.tokens.outputTokens, 218);
    assert.equal(usage[0]!.tokens.reasoningTokens, 213);
    assert.equal(usage[0]!.tokens.totalTokens, 16730);
    const calls = ofType(events, 'model_call');
    assert.deepEqual(calls.map((c) => [c.phase, c.callId]), [['start', 'call-1'], ['end', 'call-1']]);
    assert.equal(calls[1]!.outputTokens, 218);
    assert.deepEqual(ofType(events, 'error'), []);
  });

  it('tool run: per-call usage sums to result.usage exactly (no double count)', () => {
    const events = parseAll(fixture('stream-tools.ndjson'));
    const usage = ofType(events, 'usage');
    assert.equal(usage.length, 2, 'one usage per agent_response DONE, no residual from result');
    const sum = (k: 'inputTokens' | 'cacheReadTokens' | 'outputTokens') =>
      usage.reduce((acc, u) => acc + u.tokens[k], 0);
    assert.equal(sum('inputTokens'), 18564);
    assert.equal(sum('cacheReadTokens'), 13712);
    assert.equal(sum('outputTokens'), 1005);
    // Final text is emitted once, not again from result.response.
    const messages = ofType(events, 'message');
    assert.equal(messages.length, 1);
    assert.equal(messages[0]!.text, '[a.txt](file:///tmp/agyprobe/a.txt): `hello` | `echo hi`: `hi`\n');
  });

  it('tool run: tool steps map to start/result pairs keyed by step index', () => {
    const tools = ofType(parseAll(fixture('stream-tools.ndjson')), 'tool');
    assert.deepEqual(tools, [
      { type: 'tool', toolName: 'read_file', phase: 'start', toolCallId: 'step-2', input: { Path: '/tmp/agyprobe/a.txt' } },
      { type: 'tool', toolName: 'read_file', phase: 'result', toolCallId: 'step-2', output: '1 lines, 6 bytes', status: 'success' },
      { type: 'tool', toolName: 'run_command', phase: 'start', toolCallId: 'step-3', input: { CommandLine: 'echo hi' } },
      {
        type: 'tool',
        toolName: 'run_command',
        phase: 'result',
        toolCallId: 'step-3',
        output:
          'Created At: 2026-11-20T17:03:22-08:00\nCompleted At: 2026-11-20T17:03:23-08:00\nCommand exited with code 0.\n\nCommand output:\nhi\r\n',
        status: 'success',
      },
    ]);
  });

  it('tool run: two model calls, the first ends with no text (tool-calling response)', () => {
    const events = parseAll(fixture('stream-tools.ndjson'));
    const calls = ofType(events, 'model_call');
    assert.deepEqual(
      calls.map((c) => [c.phase, c.callId, c.outputTokens]),
      [['start', 'call-1', undefined], ['end', 'call-1', 563], ['start', 'call-2', undefined], ['end', 'call-2', 442]],
    );
    // The second call starts only after both tool results.
    const order = events.map((e) => (e.type === 'tool' ? `tool:${e.phase}` : e.type === 'model_call' ? `call:${e.phase}` : e.type));
    assert.ok(order.lastIndexOf('tool:result') < order.lastIndexOf('call:start'));
  });

  it('tool ERROR state maps to an error tool result carrying the error payload', () => {
    const tools = ofType(parseAll(fixture('stream-tool-error.ndjson')), 'tool');
    const failed = tools.find((t) => t.phase === 'result' && t.toolName === 'read_file')!;
    assert.equal(failed.status, 'error');
    assert.deepEqual(failed.output, { type: 'TOOL_ERROR', message: 'file does not exist' });
    // A non-zero shell exit is still a DONE tool step: success at the tool level.
    const shell = tools.find((t) => t.phase === 'result' && t.toolName === 'run_command')!;
    assert.equal(shell.status, 'success');
  });

  it('bad model: no session from an empty conversation id, one error, no usage', () => {
    const events = parseAll(fixture('stream-bad-model.ndjson'));
    assert.deepEqual(ofType(events, 'session'), []);
    const errors = ofType(events, 'error');
    assert.equal(errors.length, 1);
    assert.match(errors[0]!.message, /invalid model selection/);
    assert.deepEqual(ofType(events, 'usage'), []);
  });

  it('print timeout: session, error with the reason, no zero usage', () => {
    const events = parseAll(fixture('stream-print-timeout.ndjson'));
    assert.equal(ofType(events, 'session')[0]!.sessionId, '4e83a45f-14c9-42c3-9366-acf466b557eb');
    assert.match(ofType(events, 'error')[0]!.message, /print timeout after 3s/);
    assert.deepEqual(ofType(events, 'usage'), []);
  });

  it('result usage above the per-call sum is emitted as one residual usage event', () => {
    const parser = new AgyStreamParser();
    const lines = [
      '{"event":"init","conversation_id":"c1","init":{"cwd":"/tmp/x"}}',
      '{"event":"result","result":{"conversation_id":"c1","status":"SUCCESS","response":"ok","usage":{"input_tokens":10,"output_tokens":4,"thinking_tokens":1,"cache_read_tokens":2,"total_tokens":14}}}',
    ];
    const events = lines.flatMap((l) => parser.parse(l));
    assert.deepEqual(ofType(events, 'message'), [{ type: 'message', role: 'assistant', text: 'ok' }]);
    const usage = ofType(events, 'usage');
    assert.equal(usage.length, 1);
    assert.equal(usage[0]!.tokens.inputTokens, 10);
    assert.equal(usage[0]!.tokens.cacheReadTokens, 2);
    assert.equal(usage[0]!.tokens.outputTokens, 4);
  });

  it('ignores unknown events and throws on malformed JSON', () => {
    const parser = new AgyStreamParser();
    assert.deepEqual(parser.parse('{"event":"something_new","x":1}'), []);
    assert.throws(() => parser.parse('{not json'));
  });
});

describe('agySandboxArgs', () => {
  it('maps dontAsk to --dangerously-skip-permissions, ask to nothing, native modes to --mode', () => {
    assert.deepEqual(agySandboxArgs({ permissionMode: 'dontAsk' }), ['--dangerously-skip-permissions']);
    assert.deepEqual(agySandboxArgs({ permissionMode: 'ask' }), []);
    assert.deepEqual(agySandboxArgs({ permissionMode: 'plan' }), ['--mode', 'plan']);
    assert.deepEqual(agySandboxArgs({ permissionMode: 'accept-edits' }), ['--mode', 'accept-edits']);
  });
  it('emits nothing for fields agy has no flag for (dropped and reported by the policy layer)', () => {
    assert.deepEqual(agySandboxArgs({ allowedTools: ['read_file'], disallowedTools: ['run_command'], mcpConfig: '/tmp/m.json' }), []);
  });
});

describe('agy launch (driver contract)', () => {
  it('argv, session id, canonical events, and model_call_start stamped at the request', async () => {
    const child = new FakeChild();
    const calls: FakeSpawnCall[] = [];
    const adapter = new AgyAdapter({ spawnFn: fakeSpawnFn(child, calls) });
    const launchPromise = adapter.launch({ prompt: 'read a.txt', model: 'gemini-3.8-flash-low' });
    child.writeStdout(fixture('stream-tools.ndjson'));
    child.close(0);
    const handle = await launchPromise;
    const events: { type: string; [key: string]: unknown }[] = [];
    for await (const event of handle.attach()) events.push(event as { type: string; [key: string]: unknown });
    assert.equal(await handle.wait(), 'success');
    assert.equal(calls[0]!.command, 'agy');
    assert.deepEqual(calls[0]!.args, [
      '-p',
      'read a.txt',
      '--output-format',
      'stream-json',
      '--dangerously-skip-permissions',
      '--model',
      'gemini-3.8-flash-low',
    ]);
    assert.equal(handle.sessionId, '622ca06c-6ec8-40da-852b-ffa9db027d87');
    const types = events.map((e) => e.type);
    for (const t of ['session', 'message', 'tool_call', 'tool_result', 'usage', 'model_call_start', 'model_call_end']) {
      assert.ok(types.includes(t), `missing ${t}`);
    }
    const usage = events.filter((e) => e.type === 'usage').map((e) => e.usage as Record<string, unknown>);
    assert.equal(usage[0]!.model, 'gemini-3.8-flash-low', 'usage carries the requested model');
    const ends = events.filter((e) => e.type === 'model_call_end');
    assert.deepEqual(ends.map((e) => e.outputTokens), [563, 442]);
    for (const e of events) assert.equal(typeof e.timestamp, 'number');
  });

  it('resume maps to --conversation; a sandbox permissionMode replaces the default skip flag', async () => {
    const child = new FakeChild();
    const calls: FakeSpawnCall[] = [];
    const adapter = new AgyAdapter({ spawnFn: fakeSpawnFn(child, calls) });
    const launchPromise = adapter.launch({ prompt: 'continue', resume: 'c-123', sandbox: { permissionMode: 'ask' } });
    child.close(1);
    const handle = await launchPromise;
    assert.deepEqual(calls[0]!.args, ['--conversation', 'c-123', '-p', 'continue', '--output-format', 'stream-json']);
    assert.equal(await handle.wait(), 'error');
  });
});

describe('agy on-disk transcript (brain/<id>/.system_generated/logs/transcript.jsonl)', () => {
  it('yields one record per PLANNER_RESPONSE with model, uncached input and cache reads', async () => {
    const file = join(HERE, 'fixtures/agy/brain/622ca06c-6ec8-40da-852b-ffa9db027d87/.system_generated/logs/transcript.jsonl');
    const records = await parseAgyTranscript(file);
    assert.deepEqual(
      records.map((r) => [r.agent, r.sessionId, r.model, r.input, r.cacheRead, r.output, r.timestamp]),
      [
        ['agy', '622ca06c-6ec8-40da-852b-ffa9db027d87', 'gemini-4-carbon-high', 15766, 0, 563, '2026-11-21T01:03:14Z'],
        ['agy', '622ca06c-6ec8-40da-852b-ffa9db027d87', 'gemini-4-carbon-high', 2798, 13712, 442, '2026-11-21T01:03:23Z'],
      ],
    );
  });
});

describe('agy usage payload extractors (normalize + audit)', () => {
  const raw = { input_tokens: 2798, cache_read_tokens: 13712, output_tokens: 442, thinking_tokens: 120, total_tokens: 3240 };
  it('normalizeUsage keeps input uncached and cache reads separate', () => {
    const r = normalizeUsage('agy', raw, 0)!;
    assert.deepEqual([r.inputTokens, r.cacheReadTokens, r.outputTokens, r.cacheWriteTokens, r.reasoningTokens], [2798, 13712, 442, 0, 120]);
  });
  it('audit extractRawTokens does not read the payload as codex (cached input subtracted)', () => {
    assert.deepEqual(extractRawTokens('agy', raw)?.tok, { inputTokens: 2798, outputTokens: 442, cacheReadTokens: 13712, cacheWriteTokens: 0 });
  });
  it('a codex payload is not taken by the agy extractor', () => {
    assert.equal(normalizeUsage('agy', { input_tokens: 10, cached_input_tokens: 4, output_tokens: 1 }, 0), null);
  });
});

describe('agy model backfill without --model (init names no model)', () => {
  it('agyTranscriptModel reads the PLANNER_RESPONSE row of the same step_index', () => {
    const home = mkdtempSync(join(tmpdir(), 'ach-agy-home-'));
    const id = '622ca06c-6ec8-40da-852b-ffa9db027d87';
    const dir = join(home, '.gemini', 'antigravity-cli', 'brain', id, '.system_generated', 'logs');
    mkdirSync(dir, { recursive: true });
    cpSync(join(HERE, 'fixtures/agy/brain', id, '.system_generated/logs/transcript.jsonl'), join(dir, 'transcript.jsonl'));
    assert.equal(agyTranscriptModel(home, id, 1), 'gemini-4-carbon-high');
    assert.equal(agyTranscriptModel(home, id, 4), 'gemini-4-carbon-high');
    assert.equal(agyTranscriptModel(home, id, 2), undefined, 'a tool step has no model');
    assert.equal(agyTranscriptModel(home, 'missing-id', 1), undefined);
    assert.equal(agyTranscriptModel(home, '../etc', 1), undefined, 'ids are not paths');
  });

  it('the parser stamps the looked-up model on each usage and model_call end', () => {
    const asked: Array<[string, number]> = [];
    const parser = new AgyStreamParser((cid, step) => {
      asked.push([cid, step]);
      return `m-step-${step}`;
    });
    const events = fixture('stream-tools.ndjson').split('\n').filter(Boolean).flatMap((l) => parser.parse(l));
    const usage = ofType(events, 'usage');
    assert.deepEqual(usage.map((u) => parser.modelOf(u)), ['m-step-1', 'm-step-4']);
    assert.deepEqual(ofType(events, 'model_call').filter((m) => m.phase === 'end').map((m) => m.model), ['m-step-1', 'm-step-4']);
    assert.ok(asked.every(([cid]) => cid === '622ca06c-6ec8-40da-852b-ffa9db027d87'));
  });
});
