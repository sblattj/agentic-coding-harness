// #40: /api/stats must report the same pricing source as `ach stats --json`
// (cost-map when AGENTIC_CODING_HARNESS_PRICING_OVERRIDE names a map).
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { startWebServer } from '../src/web/server.ts';

const ENV = 'AGENTIC_CODING_HARNESS_PRICING_OVERRIDE';

describe('GET /api/stats pricing meta (#40)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ach-stats-pricing-'));
  const saved = process.env[ENV];
  let handle: Awaited<ReturnType<typeof startWebServer>> | null = null;
  before(async () => {
    handle = await startWebServer({ port: 0, host: '127.0.0.1', token: 't', stateDir: dir });
  });
  after(async () => {
    if (saved === undefined) delete process.env[ENV];
    else process.env[ENV] = saved;
    await handle?.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const source = async (): Promise<string> => {
    const res = await fetch(`http://127.0.0.1:${handle!.port}/api/stats`);
    return ((await res.json()) as { pricing: { source: string } }).pricing.source;
  };

  it('bundled by default, cost-map when the override env names a map', async () => {
    delete process.env[ENV];
    assert.equal(await source(), 'bundled');
    const f = join(dir, 'map.json');
    writeFileSync(f, JSON.stringify({ 'my-model': { input_cost_per_token: 1e-6, output_cost_per_token: 2e-6 } }));
    process.env[ENV] = f;
    assert.equal(await source(), 'cost-map');
  });
});
