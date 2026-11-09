// #186: the trio page marks its headline cost with the same provenance marker
// as the grid, and surfaces a disagreeing usage-event total instead of
// dropping it. #187: the per-tool table shows a fixed number of rows plus an
// explicit "+K more" toggle, never a half-cut row in a hidden-scrollbar box.
//
// trio.html is a static page with inline script, so the pure blocks are
// pulled out by their begin/end markers and run in a vm context.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createContext, runInContext } from "node:vm";
import { describe, it } from "node:test";

import { PROVENANCE_LEGEND } from "../src/core/provenance.ts";

const here = fileURLToPath(new URL(".", import.meta.url));
const trio = readFileSync(join(here, "../src/web/trio.html"), "utf8");
const index = readFileSync(join(here, "../src/web/index.html"), "utf8");

function block(html: string, name: string): string {
  const re = new RegExp(`/\\* ${name}:begin \\*/([\\s\\S]*?)/\\* ${name}:end \\*/`);
  const m = re.exec(html);
  assert.ok(m, `missing /* ${name}:begin */ … /* ${name}:end */ block`);
  return m[1]!;
}

type CostView = { value: number | null; text: string; mark: string; title: string; alt: number | null };

function costCtx(): (r: unknown, o: unknown) => CostView {
  const ctx = createContext({});
  runInContext(block(trio, "provenance") + block(trio, "trio-cost"), ctx);
  return ctx.costView as (r: unknown, o: unknown) => CostView;
}

const totals = { inputTokens: 100, outputTokens: 20, cacheReadTokens: 5, cacheWriteTokens: 1 };
const priced = { tokens: { available: true }, usd: { available: true, source: "pricer", value: 9.0628685 } };

describe("trio cost provenance (#186)", () => {
  it("carries the grid's provenance helpers byte for byte, and the legend", () => {
    assert.equal(block(trio, "provenance"), block(index, "provenance"));
    assert.ok(trio.includes(PROVENANCE_LEGEND), "trio renders the core legend text");
  });

  it("marks an ach-priced record cost with * and surfaces the disagreeing usage-event total", () => {
    const costView = costCtx();
    // The issue's failure case: a local record with no costSource (priced by
    // ach at $9.0629) while the run's usage events total $10.2443.
    const v = costView({ source: "local", totals: { ...totals, costUsd: 9.0628685 }, usage: priced }, { totalCostUsd: 10.2442685 });
    assert.equal(v.text, "$9.063*");
    assert.equal(v.alt, 10.2442685);
    assert.match(v.title, /computed by ach/);
    assert.match(v.title, /usage events total \$10\.244/);
  });

  it("leaves a reported cost unmarked, and shows no alt when the totals agree", () => {
    const costView = costCtx();
    const v = costView(
      { source: "local", totals: { ...totals, costUsd: 0.5, costSource: "reported" }, usage: priced },
      { totalCostUsd: 0.5001 },
    );
    assert.equal(v.text, "$0.500");
    assert.equal(v.mark, "");
    assert.equal(v.alt, null);
    assert.match(v.title, /reported by the agent CLI/);
  });

  it("stored totals.provenance wins over costSource", () => {
    const costView = costCtx();
    const v = costView(
      { source: "local", totals: { ...totals, costUsd: 1, costSource: "reported", provenance: { costUsd: "computed" } }, usage: priced },
      { totalCostUsd: 1 },
    );
    assert.equal(v.text, "$1.000*");
  });

  it("never guesses for an external record, and falls back to the usage events with no record", () => {
    const costView = costCtx();
    assert.equal(costView({ source: "external", totals: { ...totals, costUsd: 2 }, usage: priced }, { totalCostUsd: 2 }).text, "$2.000");
    const noRec = costView(null, { totalCostUsd: 3 });
    assert.equal(noRec.text, "$3.000");
    assert.equal(noRec.alt, null);
    assert.match(noRec.title, /usage events/);
  });

  it("renders n/a when usd is unavailable or metering is none, and a dash before data", () => {
    const costView = costCtx();
    assert.equal(costView({ totals: { ...totals, costUsd: 0 }, usage: { usd: { available: false } } }, { totalCostUsd: 4 }).text, "n/a");
    assert.equal(costView({ metering: "none", totals: { ...totals, costUsd: 0 } }, { totalCostUsd: 4 }).text, "n/a");
    assert.equal(costView(null, null).text, "\u2013");
  });

  it("the header and COST card both render through costView", () => {
    assert.ok(!/observedCost\(/.test(trio), "the unmarked observedCost() path is gone");
    assert.match(trio, /\$\("totalCost"\)\.textContent = cv\.text/);
    assert.match(trio, /\["cost", cv\.text, "c-cost"/);
  });
});

describe("trio per-tool table rows (#187)", () => {
  const ctx = createContext({});
  runInContext(block(trio, "tool-rows"), ctx);
  const view = ctx.toolRowsView as (rows: unknown[], open: boolean, cap: number) => { shown: unknown[]; hidden: number; toggle: string };
  const cap = ctx.TOOL_ROWS_CAP as number;
  const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ name: `t${i}` }));

  it("shows every row and no toggle at or under the cap", () => {
    const v = view(rows(cap), false, cap);
    assert.equal(v.shown.length, cap);
    assert.equal(v.toggle, "");
  });

  it("collapsed: the first cap rows plus a '+K more' toggle; expanded: every row", () => {
    const collapsed = view(rows(10), false, cap);
    assert.equal(collapsed.shown.length, cap);
    assert.equal(collapsed.hidden, 10 - cap);
    assert.equal(collapsed.toggle, `+${10 - cap} more \u25be`);
    const open = view(rows(10), true, cap);
    assert.equal(open.shown.length, 10);
    assert.match(open.toggle, /show fewer/);
  });

  it("the collapsed table has no fixed-height scroll box (the half-cut row came from max-height: 7.5em)", () => {
    assert.ok(!/\.toollat \{[^}]*max-height/.test(trio), ".toollat must not cap its height when collapsed");
    assert.match(trio, /\.toollat\.open \{[^}]*overflow-y: auto/);
  });
});
