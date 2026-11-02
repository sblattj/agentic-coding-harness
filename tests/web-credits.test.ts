import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createContext, runInContext } from 'node:vm';
import { after, before, describe, it } from 'node:test';
import { writeRunRecord, type RunRecord } from '../src/core/registry.ts';
import { startWebServer } from '../src/web/server.ts';

// #169: the dashboard showed the tap-derived totals.credits (0.00643) on kiro
// V3 instead of the reconciled usage.credits.value (47.14).

const html = readFileSync(new URL('../src/web/index.html', import.meta.url), 'utf8');
const block = /\/\* creditsview:begin \*\/([\s\S]*?)\/\* creditsview:end \*\//.exec(html);
const ctx = createContext({});

type View = { text: string; title: string } | null;
const view = (r: unknown): View => {
  const v = (ctx.creditsView as (r: unknown) => View)(r);
  return v === null ? null : { text: v.text, title: v.title };
};

const reconciled = (over: Record<string, unknown> = {}) => ({
  source: 'reconciled',
  complete: true,
  value: 47.141763553963514,
  available: true,
  sources: { 'session-store': 47.14, tap: 0.00643 },
  disagreement: { ratio: 7330.1, note: 'sources disagree' },
  incompleteSources: ['tap'],
  ...over,
});

describe('creditsView (index.html)', () => {
  it('embeds the helper', () => {
    assert.ok(block, 'index.html must carry the creditsview block');
    runInContext(block![1]!, ctx);
  });
  it('shows the reconciled value, never the tap figure, with tap and ratio in the title', () => {
    const v = view({ totals: { credits: 0.00643 }, usage: { credits: reconciled() } })!;
    assert.equal(v.text, '47.142 (reconciled) · per-event series partial');
    assert.ok(!v.text.includes('0.006'));
    assert.match(v.title, /tap: 0\.00643/);
    assert.match(v.title, /7330/);
    assert.match(v.title, /incomplete sources: tap/);
  });
  it('no partial mark when the tap is complete', () => {
    const v = view({ totals: { credits: 1 }, usage: { credits: reconciled({ incompleteSources: [] }) } })!;
    assert.equal(v.text, '47.142 (reconciled)');
  });
  it('null ratio renders without "null"', () => {
    const v = view({ totals: { credits: 1 }, usage: { credits: reconciled({ disagreement: { ratio: null, note: 'n' } }) } })!;
    assert.equal(v.text, '47.142 (reconciled) · per-event series partial');
    assert.ok(!v.title.includes('null'));
    assert.ok(!v.text.includes('null'));
  });
  it('falls back to totals.credits when usage.credits is unavailable', () => {
    assert.equal(view({ totals: { credits: 0.00643 }, usage: { credits: { available: false } } })!.text, '0.00643');
    assert.equal(view({ totals: { credits: 2 } })!.text, '2');
  });
  it('value 0 is real', () => {
    const v = view({ totals: { credits: 5 }, usage: { credits: { available: true, source: 'native', value: 0 } } })!;
    assert.equal(v.text, '0.000 (native)');
  });
  it('null when neither exists', () => {
    assert.equal(view({ totals: {}, usage: { credits: { available: false } } }), null);
  });
});

describe('GET /api/runs/:id/observability credits', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'ach-credits-169-'));
  let handle: Awaited<ReturnType<typeof startWebServer>> | null = null;
  const rec = (runId: string, usage: unknown): RunRecord =>
    ({ runId, agent: 'kiro', startedAt: 1_700_000_000_000, status: 'success', totals: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, credits: 0.00643 }, usage: { tokens: { available: true }, usd: { available: false }, ...(usage as object) } }) as unknown as RunRecord;
  before(async () => {
    writeRunRecord(stateDir, rec('v3', { credits: reconciled() }));
    writeRunRecord(stateDir, rec('whole', { credits: reconciled({ incompleteSources: [] }) }));
    writeRunRecord(stateDir, rec('none', { credits: { available: false } }));
    handle = await startWebServer({ port: 0, host: '127.0.0.1', token: 't', stateDir });
  });
  after(async () => {
    await handle?.close();
    rmSync(stateDir, { recursive: true, force: true });
  });
  const get = async (id: string) =>
    (await (await fetch(`http://127.0.0.1:${handle!.port}/api/runs/${id}/observability`)).json()) as Record<string, unknown>;

  it('reports the reconciled total and flags the series partial when tap is incomplete', async () => {
    const b = await get('v3');
    assert.equal(b.totalCredits, 47.141763553963514);
    assert.equal(b.creditsPartial, true);
  });
  it('no partial flag when tap is not listed incomplete', async () => {
    const b = await get('whole');
    assert.equal(b.totalCredits, 47.141763553963514);
    assert.equal(b.creditsPartial, undefined);
  });
  it('unavailable usage.credits leaves the event-derived total alone', async () => {
    const b = await get('none');
    assert.equal(b.totalCredits, undefined);
    assert.equal(b.creditsPartial, undefined);
  });
});
