import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { createDriver } from '../src/core/driver.ts';
import type { AgentAdapter, AgentEvent, AgentHandle } from '../src/core/types.ts';

// #204: the core driver persists RunSpec.parentRunId / RunSpec.desk onto the RunRecord.

const adapter: AgentAdapter = {
  name: 'lineage',
  async launch(): Promise<AgentHandle> {
    return {
      sessionId: 'lineage-sess',
      async *attach(): AsyncIterable<AgentEvent> {
        yield { type: 'step', sessionId: 'lineage-sess', timestamp: Date.now() } as AgentEvent;
      },
      abort(): void {},
      async wait() {
        return 'success' as const;
      },
    };
  },
};

const made: string[] = [];
function tmpState(): string {
  const d = mkdtempSync(join(tmpdir(), 'ach-lineage-'));
  made.push(d);
  return d;
}
after(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

function recordOnDisk(stateDir: string, runId: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(stateDir, 'runs', `${runId}.json`), 'utf8')) as Record<string, unknown>;
}

describe('run lineage on the RunRecord (#204)', () => {
  it('a run with parentRunId + desk persists both', async () => {
    const stateDir = tmpState();
    const driver = createDriver({ adapters: { lineage: adapter }, stateDir, registry: { stateDir } });
    await driver.run('lineage', {
      prompt: 'hi',
      runId: 'child-1',
      parentRunId: 'desk-run-9',
      desk: { stack: 'default', name: 'PM', kind: 'turn' },
    });
    const rec = recordOnDisk(stateDir, 'child-1');
    assert.equal(rec.parentRunId, 'desk-run-9');
    assert.deepEqual(rec.desk, { stack: 'default', name: 'PM', kind: 'turn' });
    assert.equal(rec.status, 'success', 'final write kept the lineage');
  });

  it('a run without them gets neither key', async () => {
    const stateDir = tmpState();
    const driver = createDriver({ adapters: { lineage: adapter }, stateDir, registry: { stateDir } });
    await driver.run('lineage', { prompt: 'hi', runId: 'plain-1' });
    const rec = recordOnDisk(stateDir, 'plain-1');
    assert.equal(rec.status, 'success');
    assert.ok(!('parentRunId' in rec), 'no parentRunId key');
    assert.ok(!('desk' in rec), 'no desk key');
  });
});
