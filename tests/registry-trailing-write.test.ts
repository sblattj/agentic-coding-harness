import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { createDriver } from '../src/core/driver.ts';
import { listRunRecords } from '../src/core/registry.ts';
import type { AgentAdapter, AgentEvent, AgentHandle } from '../src/core/types.ts';

// #195: interactive runs sit idle between turns. A usage event that lands
// inside the 500ms heartbeat throttle must still reach the RunRecord while
// the run is running, not only at the final write.

const dirs: string[] = [];
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'ach-trailing-'));
  dirs.push(d);
  return d;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class QuietHandle implements AgentHandle {
  readonly sessionId = 'quiet-1';
  private release!: () => void;
  private readonly done = new Promise<void>((r) => (this.release = r));
  async *attach(): AsyncIterable<AgentEvent> {
    const now = Date.now();
    yield { type: 'step', timestamp: now };
    yield { type: 'usage', usage: { inputTokens: 7, outputTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 0 }, timestamp: now + 1 };
    // then nothing for a while, like a TUI waiting for the next prompt
    await this.done;
  }
  finish(): void {
    this.release();
  }
  abort(): void {
    this.release();
  }
  async wait(): Promise<'success'> {
    await this.done;
    return 'success';
  }
}

class QuietAdapter implements AgentAdapter {
  readonly name = 'quiet';
  handle = new QuietHandle();
  async launch(): Promise<AgentHandle> {
    return this.handle;
  }
}

describe('RunRecord heartbeat trailing write', () => {
  it('writes the throttled last event while the run is still going', async () => {
    const regDir = tmp();
    const adapter = new QuietAdapter();
    const driver = createDriver({ adapters: { quiet: adapter }, stateDir: tmp(), registry: { stateDir: regDir } });
    const running = driver.run('quiet', { prompt: 'x' });
    await sleep(900);
    const mid = listRunRecords(regDir);
    assert.equal(mid.length, 1);
    assert.equal(mid[0]!.status, 'running');
    assert.equal(mid[0]!.totals?.inputTokens, 7, 'usage inside the throttle window still lands');
    assert.equal(mid[0]!.totals?.outputTokens, 3);
    adapter.handle.finish();
    const result = await running;
    assert.equal(result.exitStatus, 'success');
    const end = listRunRecords(regDir)[0]!;
    assert.notEqual(end.status, 'running', 'the trailing write never overwrites the final record');
    assert.equal(end.totals?.inputTokens, 7);
  });
});

describe('RunRecord keepalive (registryKeepaliveMs)', () => {
  it('keeps a quiet run live past the 15s staleness window only when the adapter asks', async () => {
    const regDir = tmp();
    const adapter = new QuietAdapter();
    (adapter as QuietAdapter & { registryKeepaliveMs?: number }).registryKeepaliveMs = 300;
    const driver = createDriver({ adapters: { quiet: adapter }, stateDir: tmp(), registry: { stateDir: regDir } });
    const running = driver.run('quiet', { prompt: 'x' });
    await sleep(700);
    const first = listRunRecords(regDir)[0]!.updatedAt!;
    await sleep(700);
    const second = listRunRecords(regDir)[0]!.updatedAt!;
    assert.ok(second > first, `keepalive rewrote the record (${first} -> ${second})`);
    adapter.handle.finish();
    await running;
    const end = listRunRecords(regDir)[0]!;
    assert.notEqual(end.status, 'running');
    await sleep(500);
    assert.equal(listRunRecords(regDir)[0]!.updatedAt, end.updatedAt, 'no writes after the final record');
  });
});
