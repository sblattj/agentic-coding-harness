// extra.credits / totals.credits hold two different vendor units: kiro credits
// and Copilot AIU (#23). Totals must keep them apart.
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { frame } from "../src/cli/dash.ts";
import { CreditTotals, creditUnitOfAgent } from "../src/core/credit-units.ts";
import type { RunRecord } from "../src/core/registry.ts";

const run = (runId: string, agent: string, credits: number | undefined): RunRecord =>
  ({
    runId, agent, pid: process.ppid, cwd: tmpdir(), promptPreview: "hi", startedAt: 0, updatedAt: Date.now(), status: "success",
    totals: { inputTokens: 10, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.01, ...(credits !== undefined ? { credits } : {}) },
    rawTranscript: join(tmpdir(), "raw.jsonl"),
  }) as unknown as RunRecord;

const footerOf = (runs: RunRecord[]): string => frame(runs, "/tmp/state", true, 200, false).split("\n").at(-1) ?? "";

test("mixed kiro + copilot footer keeps the units apart", () => {
  const f = footerOf([run("k1", "kiro", 10), run("k2", "kiro", 2.3), run("c1", "copilot", 3), run("c2", "copilot", 1)]);
  assert.ok(f.includes("credits (kiro) 12.30cr · AI credits (copilot) 4.00cr"), f);
  assert.ok(!/\bcredits 16\.30/.test(f), `units were added together: ${f}`);
});

test("kiro-only footer is unchanged: `credits N`, no vendor tag", () => {
  const f = footerOf([run("k1", "kiro", 10), run("k2", "kiro", 2.3)]);
  assert.ok(f.includes("credits 12.30cr"), f);
  assert.ok(!f.includes("(kiro)"), f);
  assert.ok(!f.includes("AI credits"), f);
});

test("copilot-only footer names its unit", () => {
  const f = footerOf([run("c1", "copilot", 3)]);
  assert.ok(f.includes("AI credits (copilot) 3.00cr"), f);
});

test("no credits anywhere: footer has no credits phrase", () => {
  assert.ok(!footerOf([run("a", "claude", undefined)]).includes("credits"));
});

test("CreditTotals / creditUnitOfAgent", () => {
  assert.equal(creditUnitOfAgent("copilot"), "copilot");
  assert.equal(creditUnitOfAgent("kiro"), "kiro");
  assert.equal(creditUnitOfAgent("kiro-ide"), "kiro");
  const t = new CreditTotals();
  assert.equal(t.isEmpty, true);
  t.add("copilot", 1.5);
  t.add("kiro", 2);
  t.add("copilot", 0.5);
  assert.equal(t.format((n) => n.toFixed(1)), "credits (kiro) 2.0 · AI credits (copilot) 2.0");
});

test("mcp stats totals: copilot AIU never joins kiro credits", async () => {
  const { statCredits } = await import("../src/mcp/tools-inspect.ts");
  const r = statCredits([
    { agent: "kiro", extra: { credits: 5 } },
    { agent: "copilot", extra: { credits: 3, creditUnit: "copilot" } },
    { agent: "copilot", extra: { credits: 1 } },
    { agent: "claude" },
  ]);
  assert.deepEqual(r.total, { credits: 5, aiu: 4 });
  assert.deepEqual(r.byAgent.get("kiro"), { credits: 5 });
  assert.deepEqual(r.byAgent.get("copilot"), { aiu: 4 });
});
