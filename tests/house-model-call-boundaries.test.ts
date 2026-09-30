// Issue #32: codex and gemini driver runs emit model-call boundaries where
// their streams show a request start, so deriveLatency can report TTFT.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { CodexAdapter, createCodexLineParser, parseCodexLine } from '../src/adapters/codex.ts';
import { GeminiAdapter } from '../src/adapters/gemini.ts';
import { deriveLatency } from '../src/core/latency.ts';
import type { AgentEvent } from '../src/core/types.ts';
import { FakeChild, fakeSpawnFn } from './helpers/fake-child.ts';

const here = fileURLToPath(new URL('.', import.meta.url));
const lines = (f: string) => readFileSync(join(here, 'fixtures', f), 'utf8').trim().split('\n');
const CODEX = lines('codex-session.ndjson');
const GEMINI = lines('gemini-session.ndjson');
const GAP_MS = 25;

/** Replay `ls` one line per GAP_MS through a FakeChild, then exit 0. */
function paced(ls: string[]): FakeChild {
  const child = new FakeChild();
  void (async () => {
    for (const l of ls) {
      await new Promise((r) => setTimeout(r, GAP_MS));
      child.writeStdout(l + '\n');
    }
    child.close(0);
  })();
  return child;
}

type Ev = AgentEvent & { [k: string]: unknown };

async function drain(adapter: { launch(spec: { prompt: string }): Promise<{ attach(): AsyncIterable<AgentEvent>; wait(): Promise<unknown> }> }): Promise<Ev[]> {
  const handle = await adapter.launch({ prompt: 'x' });
  const out: Ev[] = [];
  for await (const e of handle.attach()) out.push(e as Ev);
  await handle.wait();
  return out;
}

const bounds = (evs: Ev[]) => evs.filter((e) => e.type.startsWith('model_call_')).map((e) => `${e.type}:${String(e.callId)}`);

describe('codex model-call boundaries (#32)', () => {
  it('parser: brackets the first request of the turn, ending after the first tool start', () => {
    const parse = createCodexLineParser();
    const types = CODEX.flatMap((l) => parse(l)).map((e) => (e.type === 'model_call' ? `${e.type}:${e.phase}:${e.callId}` : e.type));
    assert.deepEqual(types, [
      'session',
      'model_call:start:turn-1',
      'tool', // item_0 start (the response asked for `ls`)
      'model_call:end:turn-1',
      'tool',
      'message',
      'message',
      'usage',
    ]);
  });

  it('parser: a tool-free turn ends at turn.completed; a second turn gets its own id', () => {
    const parse = createCodexLineParser();
    const turn = [
      '{"type":"turn.started"}',
      '{"type":"item.completed","item":{"id":"i","type":"agent_message","text":"ok"}}',
      '{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}',
    ];
    const out = [...turn, ...turn].flatMap((l) => parse(l)).filter((e) => e.type === 'model_call');
    assert.deepEqual(
      out.map((e) => e.type === 'model_call' && `${e.phase}:${e.callId}`),
      ['start:turn-1', 'end:turn-1', 'start:turn-2', 'end:turn-2'],
    );
    assert.ok(out.every((e) => e.type === 'model_call' && e.outputTokens === undefined), 'turn usage is never a per-call count');
  });

  it('parseCodexLine (stateless) is unchanged: no boundaries', () => {
    assert.equal(CODEX.flatMap((l) => parseCodexLine(l)).filter((e) => e.type === 'model_call').length, 0);
  });

  it('launch(): TTFT is measured, usage totals are untouched', async () => {
    const evs = await drain(new CodexAdapter({ spawnFn: fakeSpawnFn(paced(CODEX)) }));
    assert.deepEqual(bounds(evs), ['model_call_start:turn-1', 'model_call_end:turn-1']);
    const lat = deriveLatency(evs);
    assert.equal(lat.ttft?.count, 1);
    assert.ok(lat.ttft!.p50Ms >= GAP_MS - 5, `ttft ${lat.ttft!.p50Ms}`);
    assert.equal(lat.outputTokensPerSec, null, 'codex throughput stays null');
    assert.equal(evs.filter((e) => e.type === 'usage').length, 1);
    assert.ok(evs.filter((e) => e.type.startsWith('model_call_')).every((e) => e.usage === undefined));
  });
});

describe('gemini model-call boundaries (#32)', () => {
  it('launch(): start at init, end at the last output before the tool_result', async () => {
    const evs = await drain(new GeminiAdapter({ spawnFn: fakeSpawnFn(paced(GEMINI)) }));
    assert.deepEqual(
      evs.map((e) => e.type),
      [
        'session',
        'model_call_start', // call-1 at the init line
        'tool_call',
        'model_call_end',
        'tool_result',
        'model_call_start', // call-2 at the tool_result
        'message',
        'model_call_end', // closed by the result line
        'message', // the result line's response echo, outside any call
        'usage',
      ],
    );
    assert.deepEqual(bounds(evs), [
      'model_call_start:call-1',
      'model_call_end:call-1',
      'model_call_start:call-2',
      'model_call_end:call-2',
    ]);
    const ts = evs.map((e) => e.timestamp as number);
    assert.equal(ts[1], ts[0], 'start = init arrival');
    assert.equal(ts[3], ts[2], 'end = last output (tool_use) arrival, not the tool_result');
    assert.equal(ts[5], ts[4], 'second start = tool_result arrival');
    assert.equal(ts[7], ts[6]);
    const lat = deriveLatency(evs);
    assert.equal(lat.ttft?.count, 2);
    assert.ok(lat.ttft!.p50Ms >= GAP_MS - 5);
    assert.equal(lat.outputTokensPerSec, null, 'gemini throughput stays null');
  });

  it('output with no observed request start gets no boundaries', async () => {
    const evs = await drain(new GeminiAdapter({ spawnFn: fakeSpawnFn(paced(GEMINI.slice(1))) }));
    // No init: the first tool_use is unbracketed; the post-tool_result call is.
    assert.deepEqual(bounds(evs), ['model_call_start:call-1', 'model_call_end:call-1']);
  });
});
