// Backs the rebuttal of "Surface failed driver turns instead of discarding them" (driver.ts send):
// a failing turn never reaches the .catch in send(); #runTurn reports it as error + turn_end events.
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import type { AgentAdapter, AgentHandle, RunSpec } from '../src/core/types.ts';
import { DriverEngine } from '../src/desks/engines/driver.ts';
import type { EngineEvent, HostSpec } from '../src/desks/types.ts';

const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));

class FailingAdapter implements AgentAdapter {
  readonly name = 'fake';
  launches = 0;
  async launch(_spec: RunSpec): Promise<AgentHandle> {
    this.launches++;
    throw new Error('launch exploded: agent binary missing');
  }
}

function spec(): HostSpec {
  const stateDir = tmp('ach-desks-drv-state-');
  return {
    stack: 'fixb', stateDir, name: 'PM', kind: 'desk', role: 'pm', roleFiles: [], agent: 'fake', engine: 'driver',
    mcps: [], port: 4802, cwd: tmp('ach-desks-drv-cwd-'), runId: 'desk-run-fixb',
  };
}

describe('DriverEngine failed turn surfaces as events', () => {
  it('a turn whose driver run fails emits error then turn_end, and the engine returns to idle', async () => {
    const adapter = new FailingAdapter();
    const engine = new DriverEngine({ adapters: { fake: adapter }, env: { ACH_SELF_ARGV: JSON.stringify(['/bin/ach-test']) } });
    const events: EngineEvent[] = [];
    engine.onEvent((e) => events.push(e));
    await engine.start(spec());
    await engine.send('hello');
    const deadline = Date.now() + 10_000;
    while (!events.some((e) => e.type === 'turn_end')) {
      if (Date.now() > deadline) throw new Error(`no turn_end; events: ${JSON.stringify(events)}`);
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.equal(adapter.launches, 1);
    const types = events.map((e) => e.type);
    assert.deepEqual(types.filter((t) => t !== 'text' && t !== 'tool'), ['turn_start', 'error', 'turn_end'], JSON.stringify(events));
    const err = events.find((e) => e.type === 'error')!;
    assert.match(String(err.data.error), /launch exploded: agent binary missing/, 'error event carries the failure');
    assert.notEqual(events.find((e) => e.type === 'turn_end')!.data.exitStatus, 'success');
    assert.equal(await engine.state(), 'idle');
    await engine.stop();
  });
});
