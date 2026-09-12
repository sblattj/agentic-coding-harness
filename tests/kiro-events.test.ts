import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  createKiroNormalizer,
  parseKiroStderrLine,
  sumMeteringUsage,
  type KiroUsageExtra,
} from '../src/adapters/kiro-events.js';
import type { CanonicalEvent } from '../src/core/types.js';

const fixture = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`./fixtures/kiro/${name}`, import.meta.url)), 'utf8');

/** Non-empty lines of a fixture. ACP fixtures prefix client->agent lines with '>> '. */
function lines(name: string): string[] {
  return fixture(name)
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '');
}

/** Server->client lines only (drop the '>> ' client sends). */
function serverLines(name: string): string[] {
  return lines(name).filter((l) => !l.startsWith('>>'));
}

function usageExtra(ev: CanonicalEvent): KiroUsageExtra {
  assert.equal(ev.type, 'usage');
  const tokens = (ev as Extract<CanonicalEvent, { type: 'usage' }>).tokens as unknown as {
    extra: KiroUsageExtra;
  };
  return tokens.extra;
}

function stepKind(ev: CanonicalEvent): string {
  assert.equal(ev.type, 'step');
  const payload = (ev as Extract<CanonicalEvent, { type: 'step' }>).payload as { kind?: string };
  return payload.kind ?? '';
}

describe('kiro-events: headless stream-json fixture', () => {
  const replay = (): { events: CanonicalEvent[]; norm: ReturnType<typeof createKiroNormalizer> } => {
    const norm = createKiroNormalizer({ transport: 'headless' });
    const events: CanonicalEvent[] = [];
    for (const line of lines('headless-stream-json-2.21.2.jsonl')) events.push(...norm.pushHeadlessLine(line));
    return { events, norm };
  };

  it('normalizes the whole fixture into the exact event sequence', () => {
    const { events } = replay();
    assert.deepEqual(
      events.map((e) => (e.type === 'step' ? `step:${stepKind(e)}` : e.type)),
      [
        'step:runStarted',
        'session',
        'step:metadata',
        'step:chunk',
        'step:chunk',
        'step:metadata',
        'message',
        'usage',
        'step:runFinished',
      ],
    );
  });

  it('coalesces agent_message_chunk into ONE message per turn', () => {
    const { events, norm } = replay();
    const messages = events.filter((e) => e.type === 'message');
    assert.equal(messages.length, 1);
    assert.deepEqual(messages[0], { type: 'message', role: 'assistant', text: 'PONG' });
    assert.equal(norm.state().messageText, 'PONG');
  });

  it('chunks are exposed as steps that never count as turns', () => {
    const { events, norm } = replay();
    const chunks = events.filter((e) => e.type === 'step' && stepKind(e) === 'chunk');
    assert.equal(chunks.length, 2);
    for (const ev of events) {
      if (ev.type !== 'step') continue;
      const payload = (ev as Extract<CanonicalEvent, { type: 'step' }>).payload as {
        countsAsTurn?: boolean;
        raw?: unknown;
      };
      assert.equal(payload.countsAsTurn, false);
      assert.notEqual(payload.raw, undefined, 'every step keeps the raw native object');
    }
    assert.equal(norm.state().turns, 1);
  });

  it('captures the session id exactly once', () => {
    const { events, norm } = replay();
    const sessions = events.filter((e) => e.type === 'session');
    assert.equal(sessions.length, 1);
    assert.deepEqual(sessions[0], { type: 'session', sessionId: 'd031eff1-edd7-46d2-9838-3520ad69cd1c' });
    assert.equal(norm.state().nativeSessionId, 'd031eff1-edd7-46d2-9838-3520ad69cd1c');
  });

  it('emits one credits-only usage event with no fabricated token counts', () => {
    const { events, norm } = replay();
    const usages = events.filter((e) => e.type === 'usage');
    assert.equal(usages.length, 1);
    const meteringLine = lines('headless-stream-json-2.21.2.jsonl')
      .map((l) => JSON.parse(l) as { type: string; data: Record<string, unknown> })
      .find((o) => o.type === 'metadata' && Array.isArray(o.data.meteringUsage));
    assert.ok(meteringLine);
    const expected = sumMeteringUsage(meteringLine.data.meteringUsage);
    assert.equal(expected, 0.04248789137645108);

    const extra = usageExtra(usages[0]!);
    assert.equal(extra.credits, expected);
    assert.equal(extra.creditsCumulative, expected);
    assert.equal(extra.source, 'native');
    assert.equal(extra.tokensAvailable, false);
    assert.equal(extra.turnDurationMs, 1616);

    const tokens = (usages[0] as Extract<CanonicalEvent, { type: 'usage' }>).tokens;
    assert.equal(tokens.inputTokens, 0);
    assert.equal(tokens.outputTokens, 0);
    assert.equal(tokens.cacheReadTokens, 0);
    assert.equal(tokens.cacheWriteTokens, 0);
    assert.equal(tokens.totalTokens, null);
    assert.equal((tokens.raw as Record<string, unknown>).sessionId, 'd031eff1-edd7-46d2-9838-3520ad69cd1c');

    assert.equal(norm.state().credits.latest, expected);
    assert.equal(norm.state().credits.snapshots, 1);
    assert.equal(norm.state().contextUsagePercentage, 1.3314000368118286);
  });

  it('records the native status and stopReason on the terminal step', () => {
    const { events, norm } = replay();
    const last = events.at(-1)!;
    assert.equal(stepKind(last), 'runFinished');
    const payload = (last as Extract<CanonicalEvent, { type: 'step' }>).payload as Record<string, unknown>;
    assert.equal(payload.status, 'success');
    assert.equal(payload.stopReason, 'end_turn');
    assert.equal(payload.turn, 1);
    assert.equal(norm.state().stopReason, 'end_turn');
    assert.equal(norm.state().status, 'success');
  });
});

describe('kiro-events: ACP prompt fixture', () => {
  const replay = (): { events: CanonicalEvent[]; norm: ReturnType<typeof createKiroNormalizer> } => {
    const norm = createKiroNormalizer({ transport: 'acp' });
    const events: CanonicalEvent[] = [];
    for (const line of serverLines('acp-prompt-2.21.2.jsonl')) {
      const msg = JSON.parse(line) as Record<string, unknown>;
      const result = msg.result as Record<string, unknown> | undefined;
      if (result && typeof result.stopReason === 'string') {
        events.push(...norm.pushAcpMessage({ kind: 'promptResult', result }));
      } else {
        events.push(...norm.pushAcpMessage(msg));
      }
    }
    return { events, norm };
  };

  it('normalizes the whole fixture into the exact event sequence', () => {
    const { events } = replay();
    assert.deepEqual(
      events.map((e) => (e.type === 'step' ? `step:${stepKind(e)}` : e.type)),
      [
        'step:vendor',
        'step:vendor',
        'session',
        'step:vendor',
        'step:vendor',
        'step:vendor',
        'step:vendor',
        'step:metadata',
        'step:vendor',
        'tool',
        'step:metadata',
        'step:toolCallDuplicate',
        'tool',
        'step:chunk',
        'step:metadata',
        'message',
        'usage',
        'step:runFinished',
      ],
    );
  });

  it('dedupes tool starts by toolCallId and names the tool from _meta.kiro.toolName', () => {
    const { events, norm } = replay();
    const tools = events.filter((e): e is Extract<CanonicalEvent, { type: 'tool' }> => e.type === 'tool');
    assert.equal(tools.length, 2);
    const [start, result] = tools;
    assert.equal(start!.phase, 'start');
    assert.equal(start!.toolCallId, 'tooluse_AVuZnydMpvWtehzXWRN3Pb');
    assert.equal(start!.toolName, 'read');
    assert.equal(result!.phase, 'result');
    assert.equal(result!.status, 'success');
    assert.deepEqual(result!.output, { items: [{ Text: 'hello from probe' }] });

    const st = norm.state().toolCalls.get('tooluse_AVuZnydMpvWtehzXWRN3Pb');
    assert.deepEqual(st, { name: 'read', status: 'completed', startedSeen: true, resultSeen: true });
  });

  it('credits sum the LATEST metering array (two model calls in one turn)', () => {
    const { events, norm } = replay();
    const usages = events.filter((e) => e.type === 'usage');
    assert.equal(usages.length, 1);
    const meteringLine = serverLines('acp-prompt-2.21.2.jsonl')
      .map((l) => JSON.parse(l) as { params?: Record<string, unknown> })
      .find((o) => Array.isArray(o.params?.meteringUsage));
    assert.ok(meteringLine);
    const expected = sumMeteringUsage(meteringLine.params!.meteringUsage);
    assert.equal(expected, 0.0171051864013267 + 0.007639614063018242);
    const extra = usageExtra(usages[0]!);
    assert.equal(extra.credits, expected);
    assert.equal(extra.creditsCumulative, expected);
    assert.equal(extra.contextUsagePercentage, 5.008000373840332);
    assert.equal(norm.state().credits.latest, expected);
    assert.equal(norm.state().credits.snapshots, 1);
    assert.equal(norm.state().turns, 1);
    assert.equal(norm.state().stopReason, 'end_turn');
    assert.equal(norm.state().messageText, 'PONG');
  });

  it('captures the session id once across the handshake fixture', () => {
    const norm = createKiroNormalizer({ transport: 'acp' });
    const events: CanonicalEvent[] = [];
    for (const line of serverLines('acp-handshake-2.21.2.jsonl')) {
      events.push(...norm.pushAcpMessage(JSON.parse(line)));
    }
    const sessions = events.filter((e) => e.type === 'session');
    assert.equal(sessions.length, 1);
    assert.equal(norm.state().nativeSessionId, 'dae64fd4-0631-419f-9a6d-27aebfbf298e');
    assert.equal(norm.state().contextUsagePercentage, 2.4214999675750732);
    assert.equal(norm.state().turns, 0);
    assert.equal(norm.state().credits.latest, null);
    assert.equal(norm.state().toolCalls.size, 0);
  });
});

describe('kiro-events: usage truth', () => {
  const meta = (metering: Array<{ value: number }>): Record<string, unknown> => ({
    jsonrpc: '2.0',
    method: '_kiro.dev/metadata',
    params: { sessionId: 's1', contextUsagePercentage: 1, meteringUsage: metering },
  });

  it('re-pushing the same cumulative snapshot emits no second usage event', () => {
    const norm = createKiroNormalizer({ transport: 'acp' });
    const snapshot = meta([{ value: 0.25 }]);
    const first = norm.pushAcpMessage(snapshot);
    const second = norm.pushAcpMessage(snapshot);
    assert.equal(first.filter((e) => e.type === 'usage').length, 1);
    assert.equal(second.filter((e) => e.type === 'usage').length, 0);
    assert.equal(stepKind(second[0]!), 'metadata');
    assert.equal(norm.state().credits.latest, 0.25);
    assert.equal(norm.state().credits.snapshots, 1);
  });

  it('cumulative snapshots yield deltas, and the deltas sum to the cumulative total', () => {
    const norm = createKiroNormalizer({ transport: 'acp' });
    const a = 0.0171051864013267;
    const b = 0.007639614063018242;
    const c = 0.5;
    const deltas: number[] = [];
    for (const snap of [[{ value: a }], [{ value: a }, { value: b }], [{ value: a }, { value: b }, { value: c }]]) {
      for (const ev of norm.pushAcpMessage(meta(snap))) {
        if (ev.type === 'usage') deltas.push(usageExtra(ev).credits);
      }
    }
    assert.equal(deltas.length, 3);
    const total = deltas.reduce((s, d) => s + d, 0);
    assert.equal(norm.state().credits.latest, a + b + c);
    assert.ok(Math.abs(total - (a + b + c)) < 1e-12, `deltas ${total} != cumulative ${a + b + c}`);
    assert.equal(norm.state().credits.snapshots, 3);
  });

  it('a metadata frame without meteringUsage is a step, never a usage event', () => {
    const norm = createKiroNormalizer({ transport: 'headless' });
    const out = norm.pushHeadlessLine(
      JSON.stringify({ type: 'metadata', data: { sessionId: 's1', contextUsagePercentage: 3.5 } }),
    );
    assert.equal(out.filter((e) => e.type === 'usage').length, 0);
    assert.equal(norm.state().credits.latest, null);
    assert.equal(norm.state().contextUsagePercentage, 3.5);
  });
});

describe('kiro-events: tolerance and legacy shapes', () => {
  it('non-JSON and junk lines yield no events and never throw', () => {
    const norm = createKiroNormalizer();
    for (const junk of ['', '   ', 'not json at all', '[1,2,3]', '"a string"', 'null']) {
      assert.deepEqual(norm.pushHeadlessLine(junk), []);
    }
    assert.deepEqual(norm.pushAcpMessage(undefined), []);
    assert.deepEqual(norm.pushAcpMessage('nope'), []);
    assert.deepEqual(norm.pushAcpMessage(42), []);
  });

  it('unknown envelopes become vendor steps with the raw object preserved', () => {
    const norm = createKiroNormalizer();
    const out = norm.pushHeadlessLine(JSON.stringify({ type: 'somethingNew', data: { a: 1 } }));
    assert.equal(out.length, 1);
    assert.equal(stepKind(out[0]!), 'vendor');
    const payload = (out[0] as Extract<CanonicalEvent, { type: 'step' }>).payload as { raw: unknown };
    assert.deepEqual(payload.raw, { type: 'somethingNew', data: { a: 1 } });
  });

  it('every _kiro.dev/* notification becomes a vendor step carrying the method', () => {
    const norm = createKiroNormalizer({ transport: 'acp' });
    const msg = { jsonrpc: '2.0', method: '_kiro.dev/subagent/list_update', params: { subagents: [] } };
    const out = norm.pushAcpMessage(msg);
    assert.equal(out.length, 1);
    const payload = (out[0] as Extract<CanonicalEvent, { type: 'step' }>).payload as Record<string, unknown>;
    assert.equal(payload.kind, 'vendor');
    assert.equal(payload.method, '_kiro.dev/subagent/list_update');
    assert.deepEqual(payload.raw, msg);
  });

  it('legacy top-level shapes still normalize', () => {
    const norm = createKiroNormalizer();
    assert.deepEqual(norm.pushHeadlessLine(JSON.stringify({ type: 'session', sessionId: 'legacy-1' })), [
      { type: 'session', sessionId: 'legacy-1' },
    ]);
    assert.deepEqual(norm.pushHeadlessLine(JSON.stringify({ type: 'assistant', text: 'hi' })), [
      { type: 'message', role: 'assistant', text: 'hi' },
    ]);
    assert.deepEqual(
      norm.pushHeadlessLine(JSON.stringify({ type: 'tool_use', name: 'fs_read', id: 't1', input: { path: 'a' } })),
      [{ type: 'tool', toolName: 'fs_read', phase: 'start', toolCallId: 't1', input: { path: 'a' } }],
    );
    assert.deepEqual(
      norm.pushHeadlessLine(
        JSON.stringify({ type: 'tool_result', name: 'fs_read', id: 't1', output: 'ok', isError: false }),
      ),
      [{ type: 'tool', toolName: 'fs_read', phase: 'result', toolCallId: 't1', output: 'ok', status: 'success' }],
    );
    assert.deepEqual(norm.pushHeadlessLine(JSON.stringify({ type: 'error', message: 'boom' })), [
      { type: 'error', message: 'boom' },
    ]);
    const usage = norm.pushHeadlessLine(
      JSON.stringify({ type: 'usage', inputTokens: 10, outputTokens: 4, totalTokens: 14 }),
    );
    assert.equal(usage.length, 1);
    const tokens = (usage[0] as Extract<CanonicalEvent, { type: 'usage' }>).tokens;
    assert.equal(tokens.inputTokens, 10);
    assert.equal(tokens.outputTokens, 4);
    assert.equal(tokens.totalTokens, 14);
  });

  it('a tool result for an unknown toolCallId is emitted, never dropped', () => {
    const norm = createKiroNormalizer({ transport: 'acp' });
    const out = norm.pushAcpMessage({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: 's1',
        update: { sessionUpdate: 'tool_call_update', toolCallId: 'ghost', status: 'failed', rawOutput: { err: 1 } },
      },
    });
    const tools = out.filter((e): e is Extract<CanonicalEvent, { type: 'tool' }> => e.type === 'tool');
    assert.equal(tools.length, 1);
    assert.equal(tools[0]!.toolName, 'unknown');
    assert.equal(tools[0]!.status, 'error');
    assert.deepEqual(tools[0]!.output, { err: 1 });
  });

  it('in_progress tool updates are steps only', () => {
    const norm = createKiroNormalizer({ transport: 'acp' });
    norm.pushAcpMessage({
      method: 'session/update',
      params: { sessionId: 's1', update: { sessionUpdate: 'tool_call', toolCallId: 'x', kind: 'read', rawInput: {} } },
    });
    const out = norm.pushAcpMessage({
      method: 'session/update',
      params: { sessionId: 's1', update: { sessionUpdate: 'tool_call_update', toolCallId: 'x', status: 'in_progress' } },
    });
    assert.equal(out.filter((e) => e.type === 'tool').length, 0);
    assert.equal(stepKind(out[0]!), 'toolCallUpdate');
    assert.equal(norm.state().toolCalls.get('x')!.status, 'in_progress');
    assert.equal(norm.state().toolCalls.get('x')!.resultSeen, false);
  });

  it('rawInput is preserved verbatim, batched operations[] included', () => {
    const norm = createKiroNormalizer({ transport: 'acp' });
    const rawInput = {
      operations: [
        { mode: 'Line', path: '/a' },
        { mode: 'Line', path: '/b' },
      ],
      __tool_use_purpose: 'x',
    };
    const out = norm.pushAcpMessage({
      method: 'session/update',
      params: { sessionId: 's1', update: { sessionUpdate: 'tool_call', toolCallId: 'b1', kind: 'read', rawInput } },
    });
    const tool = out.find((e) => e.type === 'tool') as Extract<CanonicalEvent, { type: 'tool' }>;
    assert.deepEqual(tool.input, rawInput);
  });
});

describe('kiro-events: stderr model-ack helper', () => {
  it('parses the real 2.21.2 stderr line from the fixture', () => {
    const line = fixture('headless-stream-json-2.21.2.stderr').trim();
    assert.deepEqual(parseKiroStderrLine(line), {
      kind: 'modelAckUnsupported',
      model: 'claude-haiku-4.5',
    });
  });

  it('returns null for anything else', () => {
    assert.equal(parseKiroStderrLine('[warn] something else'), null);
    assert.equal(parseKiroStderrLine(''), null);
    assert.equal(parseKiroStderrLine('failed to set model'), null);
  });
});
