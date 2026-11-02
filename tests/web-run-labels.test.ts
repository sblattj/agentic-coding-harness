import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';

const html = readFileSync(new URL('../src/web/index.html', import.meta.url), 'utf8');
const block = /\/\* runlabel:begin \*\/([\s\S]*?)\/\* runlabel:end \*\//.exec(html);
const ctx = createContext({});
const j = <T>(v: unknown) => JSON.parse(JSON.stringify(v)) as T; // vm values are cross-realm

describe('web run labels (index.html)', () => {
  it('embeds the runlabel block', () => {
    assert.ok(block, 'index.html must carry the runlabel block');
    runInContext(block![1]!, ctx);
  });
  const label = (r: unknown) => ctx.runLabel(r) as string;
  const chip = (r: unknown) => ctx.runChip(r) as string;

  it('14 runs sharing agent and cwd get 14 distinct labels from variant', () => {
    const rs = Array.from({ length: 14 }, (_, i) => ({ agent: 'claude', cwd: '/w/proj', variant: `v${i}`, runId: `r${i}` }));
    assert.equal(new Set(rs.map(label)).size, 14);
    assert.equal(chip(rs[0]), 'claude');
  });
  it('no variant uses the cwd basename, across separators', () => {
    assert.equal(label({ agent: 'x', cwd: '/a/b' }), 'b');
    assert.equal(label({ agent: 'x', cwd: '/a/b/' }), 'b');
    assert.equal(label({ agent: 'x', cwd: 'C:\\a\\b' }), 'b');
    assert.equal(label({ agent: 'x', cwd: 'C:\\a\\b\\' }), 'b');
  });
  it('no cwd uses the agent and shows no redundant chip', () => {
    assert.equal(label({ agent: 'codex' }), 'codex');
    assert.equal(chip({ agent: 'codex' }), '');
    assert.equal(label({ agent: 'codex', cwd: '/' }), 'codex');
  });
  it('the row CSS keeps the label and lets the chip give way', () => {
    // A live check caught the label collapsing to "v..." beside a fixed-width chip.
    assert.match(html, /\.row \.name \.lbl \{ flex: 0 0 auto;/);
    assert.match(html, /\.row \.name \.chip \{ flex: 0 1 auto; min-width: 0;/);
  });
  it('a passive row with none of the fields does not throw', () => {
    const r = { runId: 'abc', source: 'external' };
    assert.equal(label(r), 'unknown');
    assert.equal(chip(r), '');
    assert.equal(ctx.runTooltip(r), 'abc');
    assert.equal(ctx.runTooltip({ runId: 'abc', promptPreview: 'full prompt' }), 'full prompt');
    assert.equal(label(null), 'unknown');
  });
  it('experiment filter returns only that experiment, counts, and resets when it vanishes', () => {
    const rs = [{ runId: '1', experiment: 'e1' }, { runId: '2', experiment: 'e1' }, { runId: '3', experiment: 'e2' }, { runId: '4' }];
    assert.deepEqual(j(ctx.experimentOptions(rs)), [{ value: 'e1', count: 2 }, { value: 'e2', count: 1 }]);
    assert.deepEqual(j<Array<{ runId: string }>>(ctx.filterByExperiment(rs, 'e1')).map((r) => r.runId), ['1', '2']);
    assert.equal(ctx.filterByExperiment(rs, '').length, 4);
    assert.equal(ctx.reconcileExperiment(rs, 'e2'), 'e2');
    assert.equal(ctx.reconcileExperiment(rs.filter((r) => r.experiment !== 'e2'), 'e2'), '');
    assert.deepEqual(j(ctx.experimentOptions([{ runId: '4' }])), []);
  });
});
