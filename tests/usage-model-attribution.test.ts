// #170: usage.model must be populated for passive transcript rows and for
// harness runs so `ach stats` byModel is not almost all `unknown`.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { transcriptView } from '../src/cli/transcript-view.ts';
import { scanOptionsForRoot } from '../src/monitors/transcripts.ts';
import { createDriver } from '../src/core/driver.ts';
import { listRunRecords } from '../src/core/registry.ts';
import { runModel } from '../src/web/stats.ts';
import type { AgentAdapter, AgentEvent, AgentHandle, CanonicalTokenRecord, RunSpec } from '../src/core/types.ts';

describe('transcript rows carry usage.model', () => {
  it('a claude transcript with model claude-x yields observed ["claude-x"] and runModel returns it', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ach-umodel-'));
    const proj = join(root, '.claude', 'projects', 'p');
    mkdirSync(proj, { recursive: true });
    const line = (id: string, model: string) =>
      JSON.stringify({ type: 'assistant', sessionId: 's1', requestId: `r${id}`, timestamp: '2026-01-01T00:00:00Z',
        message: { id, model, usage: { input_tokens: 10, output_tokens: 5 } } });
    writeFileSync(join(proj, 's1.jsonl'), [line('a', 'claude-x'), line('b', 'claude-x')].join('\n') + '\n');
    writeFileSync(join(proj, 's2.jsonl'), JSON.stringify({ type: 'assistant', sessionId: 's2', requestId: 'r', timestamp: '2026-01-01T00:00:00Z',
      message: { id: 'z', usage: { input_tokens: 1, output_tokens: 1 } } }) + '\n');
    const rows = await transcriptView(mkdtempSync(join(tmpdir(), 'ach-umodel-state-')), [], scanOptionsForRoot(root));
    const withModel = rows.find((r) => r.sessionId === 's1');
    assert.deepEqual(withModel?.usage?.model, { source: 'native', observed: ['claude-x'] });
    assert.equal(runModel(withModel!), 'claude-x');
    const none = rows.find((r) => r.sessionId === 's2');
    assert.ok(none);
    assert.equal(none.usage?.model, undefined);
  });
});

class H implements AgentHandle {
  readonly sessionId = `m-${Math.random().toString(36).slice(2, 8)}`;
  constructor(private readonly usage: CanonicalTokenRecord[]) {}
  async *attach(): AsyncIterable<AgentEvent> {
    for (const usage of this.usage) yield { type: 'usage', usage, sessionId: this.sessionId, timestamp: Date.now() };
  }
  abort(): void {}
  async wait(): Promise<'success'> { return 'success'; }
}
class A implements AgentAdapter {
  readonly name = 'mock';
  constructor(private readonly usage: CanonicalTokenRecord[]) {}
  async launch(_spec: RunSpec): Promise<AgentHandle> { return new H(this.usage); }
}
const rec = (model?: string): CanonicalTokenRecord => ({ inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, ...(model !== undefined ? { model } : {}) });

async function runOnce(usage: CanonicalTokenRecord[], model?: string) {
  const stateDir = mkdtempSync(join(tmpdir(), 'ach-umodel-run-'));
  const driver = createDriver({ adapters: { mock: new A(usage) }, stateDir, registry: { stateDir } });
  const result = await driver.run('mock', { prompt: 'hi', ...(model !== undefined ? { model } : {}) });
  const written = listRunRecords(stateDir).find((r) => r.runId === result.runId);
  assert.ok(written);
  return { result, written };
}

describe('driver records usage.model', () => {
  it('observed model from usage events lands in the written RunRecord and result', async () => {
    const { result, written } = await runOnce([rec('gpt-5'), rec('unknown')]);
    assert.deepEqual(written.usage?.model, { source: 'native', observed: ['gpt-5'] });
    assert.deepEqual(result.usage?.model, { source: 'native', observed: ['gpt-5'] });
    assert.equal(runModel(written), 'gpt-5');
  });
  it('observed plus requested records both', async () => {
    const { written } = await runOnce([rec('gpt-5')], 'gpt-5-alias');
    assert.deepEqual(written.usage?.model, { source: 'native', observed: ['gpt-5'], requested: 'gpt-5-alias' });
  });
  it('only a requested model records source "requested"', async () => {
    const { written } = await runOnce([rec()], 'gpt-5');
    assert.deepEqual(written.usage?.model, { source: 'requested', requested: 'gpt-5' });
    assert.equal(runModel(written), 'gpt-5');
  });
  it('neither observed nor requested leaves usage.model unset', async () => {
    const { written } = await runOnce([rec('unknown')]);
    assert.equal(written.usage?.model, undefined);
    assert.equal(runModel(written), 'unknown');
  });
});
