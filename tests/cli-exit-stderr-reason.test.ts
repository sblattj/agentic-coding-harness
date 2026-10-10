// A CLI child that exits nonzero usually says why on stderr (kiro-cli prints
// `Error: ... The monthly usage limit has been reached ...` and exits 1). The
// exit error event must carry that reason, not just `<cmd> exited with code N`,
// so a quota stop is distinguishable from a crash.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { pickStderrReason, runJsonlCli } from '../src/adapters/shared.ts';
import type { CanonicalEvent } from '../src/adapters/types.ts';

async function collect(script: string): Promise<{ events: CanonicalEvent[]; code: number }> {
  const run = runJsonlCli({
    spec: { command: 'sh', args: ['-c', script] },
    parseLine: () => [],
  });
  const events: CanonicalEvent[] = [];
  for await (const ev of run.events) events.push(ev);
  return { events, code: await run.wait() };
}

function exitErrors(events: CanonicalEvent[]): string[] {
  return events
    .filter((e): e is Extract<CanonicalEvent, { type: 'error' }> => e.type === 'error')
    .map((e) => e.message)
    .filter((m) => m.startsWith('sh exited with code'));
}

describe('nonzero CLI exit surfaces the stderr reason', () => {
  it('appends the stderr error line to the exit message', async () => {
    const { events, code } = await collect(
      'echo "starting up" >&2; echo "Error: Internal error (code -32603): The monthly usage limit has been reached" >&2; echo "bye" >&2; exit 1',
    );
    assert.equal(code, 1);
    assert.deepEqual(exitErrors(events), [
      'sh exited with code 1: Error: Internal error (code -32603): The monthly usage limit has been reached',
    ]);
  });

  it('falls back to the last non-empty stderr line and strips ANSI codes', async () => {
    const { events } = await collect('printf "first\\n\\033[31mboom happened\\033[0m\\n\\n" >&2; exit 3');
    assert.deepEqual(exitErrors(events), ['sh exited with code 3: boom happened']);
  });

  it('keeps the bare message when stderr is empty', async () => {
    const { events } = await collect('exit 2');
    assert.deepEqual(exitErrors(events), ['sh exited with code 2']);
  });

  it('emits no exit error on exit 0', async () => {
    const { events } = await collect('echo "Error: harmless" >&2; exit 0');
    assert.equal(events.some((e) => e.type === 'error'), false);
  });

  it('keeps the bare message when an adapter stderr hook already raised the error', async () => {
    const run = runJsonlCli({
      spec: { command: 'sh', args: ['-c', 'echo "Error: specific" >&2; exit 1'] },
      parseLine: () => [],
      onStderrLine: (line) => (/^Error:/.test(line) ? [{ type: 'error', message: `adapter: ${line}` }] : undefined),
    });
    const events: CanonicalEvent[] = [];
    for await (const ev of run.events) events.push(ev);
    assert.deepEqual(exitErrors(events), ['sh exited with code 1']);
  });

  it('pickStderrReason prefers the last error line', () => {
    assert.equal(pickStderrReason(['a', 'Error: one', 'b', 'fatal error: two', 'c']), 'fatal error: two');
    assert.equal(pickStderrReason(['a', '  ', 'last']), 'last');
    assert.equal(pickStderrReason([]), undefined);
  });
});
