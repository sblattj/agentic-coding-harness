import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { chmodSync, unlinkSync } from 'node:fs';
import { parseClaudeSession } from '../src/monitors/transcripts.ts';
import {
  claudeProjectsRoot,
  eventsFromTranscriptLine,
  findSessionTranscript,
  TranscriptTail,
  usageDelta,
} from '../src/interactive/transcript-tail.ts';
import type { AgentEvent } from '../src/core/types.ts';

// ---------------------------------------------------------------------------
// #195: interactive runs are metered from the Claude session transcript.
// The tail's usage deltas must sum to exactly what parseClaudeSession (the
// `ach watch` parser) reports, including streamed partial lines and
// subagent files.
// ---------------------------------------------------------------------------

const roots: string[] = [];
after(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function tmpRoot(): string {
  const r = mkdtempSync(join(tmpdir(), 'ach-itail-'));
  roots.push(r);
  return r;
}

const SID = '11111111-2222-3333-4444-555555555555';

function assistant(id: string, req: string, usage: Record<string, number>, content: unknown[], model = 'claude-sonnet-4-5'): string {
  return JSON.stringify({ type: 'assistant', sessionId: SID, requestId: req, timestamp: '2026-11-15T10:00:00.000Z', message: { id, model, content, usage } }) + '\n';
}

describe('claudeProjectsRoot / findSessionTranscript', () => {
  it('honours CLAUDE_CONFIG_DIR and finds the session file under any project dir', () => {
    assert.equal(claudeProjectsRoot({ CLAUDE_CONFIG_DIR: '/x/cfg' }), join('/x/cfg', 'projects'));
    const root = tmpRoot();
    mkdirSync(join(root, '-some-encoded-cwd'), { recursive: true });
    writeFileSync(join(root, '-some-encoded-cwd', `${SID}.jsonl`), '');
    assert.equal(findSessionTranscript(root, SID), join(root, '-some-encoded-cwd', `${SID}.jsonl`));
    assert.equal(findSessionTranscript(root, 'nope'), null);
    assert.equal(findSessionTranscript(join(root, 'missing'), SID), null);
  });
});

describe('eventsFromTranscriptLine', () => {
  it('maps assistant text and tool_use, one step per message id', () => {
    const seen = new Set<string>();
    const a = eventsFromTranscriptLine(JSON.parse(assistant('m1', 'r1', { output_tokens: 1 }, [{ type: 'text', text: 'hi' }])), SID, seen);
    assert.equal(a.newMessage, true);
    assert.deepEqual(a.events.map((e) => e.type), ['step', 'message']);
    assert.equal(a.events[1]!.content, 'hi');
    assert.equal(a.events[0]!.sessionId, SID);
    const b = eventsFromTranscriptLine(JSON.parse(assistant('m1', 'r1', { output_tokens: 3 }, [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }])), SID, seen);
    assert.equal(b.newMessage, false, 'second block of the same message is not a new turn');
    assert.deepEqual(b.events.map((e) => e.type), ['tool_call']);
    assert.equal(b.events[0]!.functionName, 'Bash');
  });

  it('maps tool results and typed prompts, skips meta and tagged lines, flags turn ends', () => {
    const seen = new Set<string>();
    const tr = eventsFromTranscriptLine({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok', is_error: true }] } }, SID, seen);
    assert.deepEqual(tr.events.map((e) => [e.type, e.toolCallId, e.isError]), [['tool_result', 't1', true]]);
    const prompt = eventsFromTranscriptLine({ type: 'user', message: { content: 'do it' } }, SID, seen);
    assert.deepEqual(prompt.events.map((e) => [e.type, e.source, e.content]), [['message', 'user', 'do it']]);
    assert.equal(eventsFromTranscriptLine({ type: 'user', isMeta: true, message: { content: 'x' } }, SID, seen).events.length, 0);
    assert.equal(eventsFromTranscriptLine({ type: 'user', message: { content: '<command-name>/exit</command-name>' } }, SID, seen).events.length, 0);
    assert.equal(eventsFromTranscriptLine({ type: 'system', subtype: 'turn_duration' }, SID, seen).turnEnd, true);
    assert.equal(eventsFromTranscriptLine(JSON.parse(assistant('s', 'r', {}, [{ type: 'text', text: 'x' }], '<synthetic>')), SID, seen).events.length, 0);
  });
});

describe('usageDelta', () => {
  it('is the non-negative growth per field, null when nothing grew', () => {
    const before = { input: 1, output: 1, cacheRead: 10, cacheWrite: 5, cacheWrite1h: 0, reasoning: 0 };
    const now = { input: 3, output: 1, cacheRead: 10, cacheWrite: 4, cacheWrite1h: 2, reasoning: 0 };
    const d = usageDelta('m', now, before, SID, 1)!;
    assert.equal(d.inputTokens, 2);
    assert.equal(d.outputTokens, 0);
    assert.equal(d.cacheWriteTokens, 0, 'a shrink never goes negative');
    assert.equal(d.cacheWrite1hTokens, 2);
    assert.equal(d.model, 'm');
    assert.equal(usageDelta('m', before, before, SID, 1), null);
  });
});

describe('TranscriptTail', () => {
  it('emits events once and usage deltas that sum to parseClaudeSession totals (subagents included)', async () => {
    const root = tmpRoot();
    const proj = join(root, '-proj');
    mkdirSync(proj, { recursive: true });
    const file = join(proj, `${SID}.jsonl`);
    writeFileSync(file, '');
    const events: AgentEvent[] = [];
    const turnEnds: number[] = [];
    const tail = new TranscriptTail({ sessionId: SID, root, onEvent: (e) => events.push(e), onTurnEnd: (n) => turnEnds.push(n) });

    await tail.poll();
    assert.equal(events.length, 0);
    // Turn 1, streamed: the first block carries partial usage, the last the final one.
    appendFileSync(file, JSON.stringify({ type: 'user', message: { content: 'go' } }) + '\n');
    appendFileSync(file, assistant('m1', 'r1', { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 100, cache_creation_input_tokens: 40 }, [{ type: 'text', text: 'a' }]));
    await tail.poll();
    appendFileSync(file, assistant('m1', 'r1', { input_tokens: 10, output_tokens: 7, cache_read_input_tokens: 100, cache_creation_input_tokens: 40 }, [{ type: 'tool_use', id: 't', name: 'Read', input: {} }]));
    // A partial line (no newline yet) must wait for its end.
    const partial = JSON.stringify({ type: 'system', subtype: 'turn_duration' });
    appendFileSync(file, partial.slice(0, 10));
    await tail.poll();
    assert.deepEqual(turnEnds, []);
    appendFileSync(file, partial.slice(10) + '\n');
    // Turn 2 on another model plus a subagent file.
    appendFileSync(file, assistant('m2', 'r2', { input_tokens: 2, output_tokens: 3 }, [{ type: 'text', text: 'b' }], 'claude-haiku-4-5'));
    mkdirSync(join(proj, SID, 'subagents'), { recursive: true });
    writeFileSync(join(proj, SID, 'subagents', 'agent-x.jsonl'), assistant('m3', 'r3', { input_tokens: 5, output_tokens: 5 }, [{ type: 'text', text: 'sub' }]));
    await tail.flush();

    assert.deepEqual(turnEnds, [1]);
    assert.equal(tail.turnEnds, 1);
    assert.equal(events.filter((e) => e.type === 'step').length, 2, 'one step per main-transcript message');
    assert.equal(events.filter((e) => e.type === 'message' && e.source === 'user').length, 1);

    const usage = events.filter((e) => e.type === 'usage').map((e) => e.usage as { model: string; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number });
    const sum = usage.reduce((a, u) => ({ input: a.input + u.inputTokens, output: a.output + u.outputTokens, cacheRead: a.cacheRead + u.cacheReadTokens, cacheWrite: a.cacheWrite + u.cacheWriteTokens }), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    const truth = (await parseClaudeSession(proj, SID)).reduce((a, r) => ({ input: a.input + r.input, output: a.output + r.output, cacheRead: a.cacheRead + r.cacheRead, cacheWrite: a.cacheWrite + r.cacheWrite }), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    assert.deepEqual(sum, truth);
    assert.deepEqual(truth, { input: 17, output: 15, cacheRead: 100, cacheWrite: 40 });
    assert.ok(usage.some((u) => u.model === 'claude-haiku-4-5'), 'per-model deltas keep the model for pricing');
  });

  it('reports no file when the session never wrote a transcript', async () => {
    const tail = new TranscriptTail({ sessionId: SID, root: tmpRoot(), onEvent: () => {} });
    await tail.flush();
    assert.equal(tail.file, null);
  });
});

describe('review fixes: UTF-8 boundaries, aux-only deltas, poll errors', () => {
  it('usageDelta emits when only cacheWrite1h or reasoning grew', () => {
    const before = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, reasoning: 0 };
    assert.equal(usageDelta('m', { ...before, cacheWrite1h: 5 }, before, SID, 1)?.cacheWrite1hTokens, 5);
    assert.equal(usageDelta('m', { ...before, reasoning: 3 }, before, SID, 1)?.reasoningTokens, 3);
  });

  it('a multi-byte character split across two polls decodes intact', async () => {
    const root = tmpRoot();
    mkdirSync(join(root, '-p'), { recursive: true });
    const file = join(root, '-p', `${SID}.jsonl`);
    writeFileSync(file, '');
    const events: AgentEvent[] = [];
    const tail = new TranscriptTail({ sessionId: SID, root, onEvent: (e) => events.push(e) });
    const line = Buffer.from(JSON.stringify({ type: 'user', message: { content: 'naïve ✓ 日本' } }) + '\n', 'utf8');
    const cut = line.indexOf(Buffer.from('✓', 'utf8')) + 1; // inside the 3-byte check mark
    appendFileSync(file, line.subarray(0, cut));
    await tail.poll();
    appendFileSync(file, line.subarray(cut));
    await tail.poll();
    await tail.flush();
    const msgs = events.filter((e) => e.type === 'message');
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0]!.content, 'naïve ✓ 日本');
  });

  it('a failing poll reaches onError and polling continues', async () => {
    const root = tmpRoot();
    mkdirSync(join(root, '-p', `${SID}.jsonl`), { recursive: true }); // a directory: open/read fails
    const errors: unknown[] = [];
    const tail = new TranscriptTail({ sessionId: SID, root, onEvent: () => {}, onError: (e) => errors.push(e) });
    await tail.poll();
    await tail.poll(true);
    assert.ok(errors.length >= 1, 'the read failure is reported, not swallowed');
  });
});

describe('sub-agent usage without main-file changes', () => {
  it('a growing sub-agent transcript is metered on a normal poll', async () => {
    const root = tmpRoot();
    const proj = join(root, '-p');
    mkdirSync(join(proj, SID, 'subagents'), { recursive: true });
    writeFileSync(join(proj, `${SID}.jsonl`), assistant('m1', 'r1', { input_tokens: 1, output_tokens: 1 }, [{ type: 'text', text: 'a' }]));
    const usage: AgentEvent[] = [];
    const tail = new TranscriptTail({ sessionId: SID, root, onEvent: (e) => { if (e.type === 'usage') usage.push(e); } });
    await tail.poll();
    assert.equal(usage.length, 1);
    // Only the sub-agent file changes; the main transcript stays untouched.
    writeFileSync(join(proj, SID, 'subagents', 'agent-a.jsonl'), assistant('s1', 'rs1', { input_tokens: 40, output_tokens: 9 }, [{ type: 'text', text: 'sub' }]));
    await tail.poll();
    assert.equal(usage.length, 2, 'sub-agent usage lands without waiting for the exit flush');
    assert.equal((usage[1]!.usage as { inputTokens: number }).inputTokens, 40);
    tail.stop();
  });
});

describe('transcript that disappears after discovery', () => {
  it('reports the stat failure through onError and recovers when it is back', async () => {
    const root = tmpRoot();
    mkdirSync(join(root, '-p'), { recursive: true });
    const file = join(root, '-p', `${SID}.jsonl`);
    writeFileSync(file, '');
    const errors: unknown[] = [];
    const events: AgentEvent[] = [];
    const tail = new TranscriptTail({ sessionId: SID, root, onEvent: (e) => events.push(e), onError: (e) => errors.push(e) });
    await tail.poll();
    unlinkSync(file);
    await tail.poll();
    assert.equal(errors.length, 1, 'the vanished transcript is reported');
    writeFileSync(file, JSON.stringify({ type: 'user', message: { content: 'back' } }) + '\n');
    await tail.poll();
    assert.ok(events.some((e) => e.type === 'message' && e.content === 'back'), 'polling recovers');
  });
});

describe('a failed transcript read is retried', () => {
  const root0 = typeof process.getuid === 'function' && process.getuid() === 0;
  it('lines that could not be read once arrive on the next poll', { skip: root0 || process.platform === 'win32' ? 'needs a non-root POSIX user' : false }, async () => {
    const root = tmpRoot();
    mkdirSync(join(root, '-p'), { recursive: true });
    const file = join(root, '-p', `${SID}.jsonl`);
    writeFileSync(file, '');
    const events: AgentEvent[] = [];
    const errors: unknown[] = [];
    const tail = new TranscriptTail({ sessionId: SID, root, onEvent: (e) => events.push(e), onError: (e) => errors.push(e) });
    await tail.poll();
    appendFileSync(file, JSON.stringify({ type: 'user', message: { content: 'after the glitch' } }) + '\n');
    chmodSync(file, 0o000); // stat still works, open fails
    await tail.poll();
    assert.equal(errors.length, 1, 'the failed read is reported');
    chmodSync(file, 0o644); // file unchanged since the failed poll
    await tail.poll();
    assert.ok(events.some((e) => e.type === 'message' && e.content === 'after the glitch'), 'the next poll retries the read');
  });
});
