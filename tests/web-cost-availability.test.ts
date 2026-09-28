import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { it } from 'node:test';
import { computeCompareRows } from '../src/web/compare.ts';
import { deriveRunObservability } from '../src/web/derive.ts';
import type { RunRecord } from '../src/core/registry.ts';
import type { AgentEvent } from '../src/core/types.ts';

function source(page: string, name: string): string {
  const html = readFileSync(new URL(`../src/web/${page}.html`, import.meta.url), 'utf8');
  const start = html.indexOf(`function ${name}(`);
  assert.ok(start >= 0, name);
  let depth = 0;
  for (let i = html.indexOf('{', start); i < html.length; i++) {
    if (html[i] === '{') depth++;
    if (html[i] === '}' && --depth === 0) return html.slice(start, i + 1);
  }
  throw new Error(`unclosed ${name}`);
}
function record(cost: number, unknown = false): RunRecord {
  return { runId: 'r', agent: 'test', startedAt: 1,
    totals: { inputTokens: 10, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: cost },
    ...(unknown ? { usage: { tokens: { available: true }, usd: { available: false }, credits: { available: false }, context: { available: false, source: 'derived' } } as RunRecord['usage'] } : {}) };
}
it('main and grid shipped aggregators distinguish unknown, known zero, and partial sums', () => {
  for (const page of ['index', 'grid']) {
    const out = { textContent: '' };
    const ctx = { runs: [] as unknown, $: () => out, elRuns: {}, elTok: {}, elCost: out,
      isLive: () => false, tokensOf: () => 10, fmtTok: String, provMark: () => '', PROV_MARK: { computed: '~' } };
    const fn = page === 'index' ? 'renderAggregate' : 'updateAggregates';
    const code = source(page, 'runCost') + (page === 'index' ? source(page, 'fmtCost') : '') + source(page, fn);
    for (const [records, expected] of [
      [[record(0, true)], /n\/a.*1 unpriced/],
      [[record(0)], /\$0\.00/],
      [[record(2), record(0, true)], /\$2\.00.*1 unpriced/],
    ] as const) {
      ctx.runs = page === 'index' ? records : new Map(records.map((rec, i) => [i, { rec }]));
      runInNewContext(code + `\n${fn}();`, ctx);
      assert.match(out.textContent, expected, page);
    }
    const value = runInNewContext(source(page, 'runCost') + '\nrunCost(r)', { r: { ...record(0), metering: 'none' } });
    assert.equal(value, null);
  }
});
it('compare costs stay null if any member is unpriced, and preserve explicit zero', () => {
  const [partial] = computeCompareRows([record(3), record(0, true)], ['agent']);
  assert.equal(partial!.avgCostUsd, null);
  assert.equal(partial!.unpricedRuns, 1);
  assert.equal(computeCompareRows([record(0)], ['agent'])[0]!.avgCostUsd, 0);
  assert.equal(computeCompareRows([record(0, true)], ['agent'])[0]!.avgCostUsd, null);
  assert.equal(runInNewContext(source('compare', 'fmtCost') + '\nfmtCost(null)'), 'n/a');
  assert.equal(runInNewContext(source('compare', 'fmtCost') + '\nfmtCost(0)'), '$0.0000');
});
it('trio uses explicit canonical costs, never guessed rates or partial sums', () => {
  const event = (cost?: number): AgentEvent => ({ type: 'usage', timestamp: 1, usage: { model: 'unpriced-model', inputTokens: 100, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, ...(cost === undefined ? {} : { costUsd: cost }) } });
  assert.equal(deriveRunObservability([]).totalCostUsd, undefined);
  assert.equal(deriveRunObservability([event()]).totalCostUsd, undefined);
  assert.equal(deriveRunObservability([event(0)]).totalCostUsd, 0);
  assert.equal(deriveRunObservability([event(2), event()]).totalCostUsd, undefined);
  assert.equal(deriveRunObservability([event(2), event(3)]).totalCostUsd, 5);
  assert.equal(runInNewContext(source('trio', 'USD') + '\nUSD(undefined)'), 'n/a');
  assert.equal(runInNewContext(source('trio', 'USD') + '\nUSD(0)'), '$0.000');
  const code = source('trio', 'costUnavailable') + source('trio', 'observedCost') + '\nobservedCost()';
  assert.equal(runInNewContext(code, { rec: record(0, true), obs: { totalCostUsd: 0 } }), null);
  const zero = record(0, true);
  zero.usage!.usd.available = true;
  assert.equal(runInNewContext(code, { rec: zero, obs: {} }), 0);
});
it('trio shipped loader preserves unknown cost and cache model data', async () => {
  const ctx = { RUN_ID: 'r', obs: null as unknown, api: async () => ({ json: async () => ({ metrics: [], byModel: [{ model: 'a', cacheHitRatio: 0.8 }], cacheHitRatio: 0.8 }) }) };
  await runInNewContext(source('trio', 'fetchObs') + '\nfetchObs()', ctx);
  const obs = ctx.obs as { totalCostUsd?: number; byModel: unknown[]; cacheHitRatio: number };
  assert.equal(obs.totalCostUsd, undefined);
  assert.equal(obs.byModel.length, 1);
  assert.equal(obs.cacheHitRatio, 0.8);
});
it('main run rows and grid tiles render unknown as n/a and known zero as dollars', () => {
  type Node = { textContent: string; children: Node[]; appendChild(n: Node): void; addEventListener(): void; setAttribute(): void };
  const el = (_tag = '', _cls = '', text = ''): Node => ({ textContent: text, children: [], appendChild(n) { this.children.push(n); }, addEventListener() {}, setAttribute() {} });
  const text = (n: Node): string => n.textContent + n.children.map(text).join(' ');
  for (const unknown of [true, false]) {
    const r = record(0, unknown);
    const main = runInNewContext(source('index', 'runCost') + source('index', 'fmtCost') + source('index', 'buildRow') + '\nbuildRow(r)',
      { r, el, GLYPH: {}, fmtDur: String, elapsed: () => 0, provMark: () => '' }) as Node;
    assert.match(text(main), unknown ? /n\/a/ : /\$0\.0000/);
    const st = { rec: r, live: false, dom: { dot: el(), name: el(), model: el(), tok: el(), cost: el(), tile: el() } };
    runInNewContext(source('grid', 'runCost') + source('grid', 'updateHeader') + '\nupdateHeader(st)',
      { st, document: { createElement: el, createTextNode: (t: string) => el('', '', t) }, tokensOf: () => 10, fmtTok: String, statusLabel: () => 'success' });
    assert.match(text(st.dom.cost), unknown ? /n\/a/ : /\$0\.00/);
  }
});
