import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { it } from "node:test";
import { deriveRunObservability } from "../src/web/derive.ts";
import type { AgentEvent } from "../src/core/types.ts";

// Execute the shipped metadata renderer, with a minimal DOM surface. Values
// come from the same observability derivation served by the HTTP endpoint.
it("main web header renders canonical per-model cache ratios and score history", () => {
  const html = readFileSync(new URL("../src/web/index.html", import.meta.url), "utf8");
  const renderer = html.slice(html.indexOf("function renderMeta()"), html.indexOf("/* ===== feed pane ===== */"));
  const events = [
    { type: "usage", usage: { model: "alpha", inputTokens: 20, cacheReadTokens: 80, cacheWriteTokens: 0 } },
    { type: "usage", usage: { model: "beta", inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } },
  ] as AgentEvent[];
  const data = deriveRunObservability(events);
  interface Element { textContent: string; children: Element[]; appendChild(e: Element): void }
  const el = (_tag: string, _class: string, text = ""): Element => ({
    textContent: text, children: [], appendChild(e) { this.children.push(e); },
  });
  const box = el("div", "");
  const r = { runId: "run", agent: "test", startedAt: 1, totals: {},
    verify: { status: "fail", command: "old" },
    regrades: [{ status: "pass", command: "new", at: 1 }] };
  const ctx = { $: () => box, el, findRun: () => r, selectedId: "run", modelCache: { run: { stamp: 1, data } },
    modelCachePending: {}, runCost: () => null, fmtTok: String, fmtCost: String, provMark: () => "", fmtCtx: () => "", fmtAgo: () => "", GLYPH: {} };
  runInNewContext(renderer + "\nrenderMeta();", ctx);
  const text = (e: Element): string => e.textContent + e.children.map(text).join(" ");
  assert.match(text(box), /cache hit \/ alpha 80\.0%/);
  assert.match(text(box), /cache hit \/ beta n\/a/);
  assert.match(text(box), /original verify fail · old/);
  assert.match(text(box), /regrade 1 pass · new/);
  box.children = [];
  ctx.modelCache.run.data = deriveRunObservability([]);
  runInNewContext(renderer + "\nrenderMeta();", ctx);
  assert.match(text(box), /cache hit \/ model n\/a/);
  assert.doesNotMatch(text(box), /NaN|Infinity|cache hit \/ alpha/);
});
