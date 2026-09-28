import { fileURLToPath } from "node:url";
// Issue #33: provenance labels (reported | computed | estimated) on every
// displayed number — the core map, the dash/report/web markers, and the
// stats bucket maps. The stats CLI end-to-end assertions live next to the
// cost-mode fixture in tests/cost-mode.test.ts.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createContext, runInContext } from "node:vm";
import { describe, it } from "node:test";

import {
  PROVENANCE_CLASSES,
  PROVENANCE_LEGEND,
  markerFor,
  provenanceOf,
  runTotalsProvenance,
} from "../src/core/provenance.ts";
import { RunRecordSchema, type RunRecord } from "../src/core/registry.ts";
import { statsProvenance } from "../src/cli/stats-provenance.ts";
import { aggregate } from "../src/cli/lib.ts";
import { frame } from "../src/cli/dash.ts";
import { renderReport } from "../src/report/html.ts";
import { toLoadedRun } from "../src/report/model.ts";
import type { RunResult, UsageAvailability } from "../src/core/types.ts";

const zeroTotals = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 };
const tokenTotals = { inputTokens: 100, outputTokens: 20, cacheReadTokens: 5, cacheWriteTokens: 1, costUsd: 0.25 };

const CREDITS_ONLY: UsageAvailability = {
  tokens: { available: false },
  credits: { available: true, source: "reconciled", value: 0.02, scope: "run", cumulative: true },
  usd: { available: false },
  context: { available: true, source: "derived", percentage: 5, windowTokens: 200000, windowSource: "session-store", tokens: 10000 },
} as UsageAvailability;

describe("provenance classes and markers", () => {
  it("has exactly three classes; computed = *, estimated = ≈, reported unmarked", () => {
    assert.deepEqual([...PROVENANCE_CLASSES], ["reported", "computed", "estimated"]);
    assert.equal(markerFor("computed"), "*");
    assert.equal(markerFor("estimated"), "≈");
    assert.equal(markerFor("reported"), "");
    assert.equal(markerFor(undefined), "");
    assert.match(PROVENANCE_LEGEND, /\* computed/);
    assert.match(PROVENANCE_LEGEND, /≈ estimated/);
    assert.match(PROVENANCE_LEGEND, /reported/);
    assert.match(PROVENANCE_LEGEND, /n\/a/);
  });
});

describe("runTotalsProvenance", () => {
  it("token lanes are reported, pricer cost is computed", () => {
    assert.deepEqual(runTotalsProvenance({ ...tokenTotals, costSource: "computed" }), {
      inputTokens: "reported",
      outputTokens: "reported",
      cacheReadTokens: "reported",
      cacheWriteTokens: "reported",
      costUsd: "computed",
    });
  });

  it("a CLI-reported cost stays reported; a mixed cost (no costSource, > 0) is computed", () => {
    assert.equal(runTotalsProvenance({ ...tokenTotals, costSource: "reported" }).costUsd, "reported");
    assert.equal(runTotalsProvenance(tokenTotals).costUsd, "computed");
  });

  it("an agent with no token lanes tags them ABSENT (not reported); credits reported, context estimated", () => {
    const p = runTotalsProvenance({ ...zeroTotals, credits: 0.02, contextTokens: 10000 }, CREDITS_ONLY);
    assert.deepEqual(p, { credits: "reported", contextTokens: "estimated" });
    for (const lane of ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "costUsd"]) {
      assert.equal(Object.hasOwn(p, lane), false, lane);
    }
  });

  it("no usage verdict yet and nothing counted: nothing is labelled", () => {
    assert.deepEqual(runTotalsProvenance(zeroTotals), {});
  });
});

describe("provenanceOf(RunRecord)", () => {
  const base: RunRecord = { runId: "r1", agent: "claude", startedAt: 1, status: "success", totals: { ...tokenTotals } };

  it("prefers the stored map", () => {
    const rec: RunRecord = { ...base, totals: { ...tokenTotals, provenance: { costUsd: "reported" } } };
    assert.deepEqual(provenanceOf(rec), { costUsd: "reported" });
  });

  it("derives it for a local record written before provenance existed", () => {
    assert.equal(provenanceOf(base).costUsd, "computed");
    assert.equal(provenanceOf(base).inputTokens, "reported");
  });

  it("never guesses for an external record without a map", () => {
    assert.deepEqual(provenanceOf({ ...base, source: "external" }), {});
  });

  it("RunRecordSchema accepts the additive map and rejects an unknown class", () => {
    const ok = RunRecordSchema.safeParse({ ...base, totals: { ...tokenTotals, provenance: { costUsd: "computed", contextTokens: "estimated" } } });
    assert.equal(ok.success, true);
    const bad = RunRecordSchema.safeParse({ ...base, totals: { ...tokenTotals, provenance: { costUsd: "guessed" } } });
    assert.equal(bad.success, false);
  });
});

describe("statsProvenance (per-bucket maps)", () => {
  const recs = [
    { ts: "2026-09-01T00:00:00Z", agent: "claude", inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, costUsd: 1, costSource: "reported" as const },
    { ts: "2026-09-01T01:00:00Z", agent: "codex", inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, costUsd: 1, costSource: "computed" as const },
    { ts: null, agent: "kiro", inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, tokensAvailable: false },
  ];

  it("keys match aggregate()'s bucket keys exactly", () => {
    const agg = aggregate(recs);
    const prov = statsProvenance(recs);
    assert.deepEqual(Object.keys(prov.byAgent).sort(), Object.keys(agg.byAgent).sort());
    assert.deepEqual(Object.keys(prov.byDay).sort(), Object.keys(agg.byDay).sort());
  });

  it("tokens reported when any record carried them; cost by source; mixed = computed; none = absent", () => {
    const prov = statsProvenance(recs);
    assert.equal(prov.byAgent.claude!.costUsd, "reported");
    assert.equal(prov.byAgent.claude!.inputTokens, "reported");
    assert.equal(prov.byAgent.codex!.costUsd, "computed");
    assert.equal(prov.byDay["2026-09-01"]!.costUsd, "computed"); // reported + computed blend
    assert.equal(prov.total.costUsd, "computed");
    assert.deepEqual(prov.byAgent.kiro, {}); // no token lanes, no cost
    assert.deepEqual(prov.byDay.unknown, {});
  });
});

describe("dash markers", () => {
  it("marks computed cost with * and the derived context with ≈, and prints the legend", () => {
    const rec: RunRecord = {
      runId: "run-prov-1",
      agent: "claude",
      startedAt: Date.now() - 1000,
      updatedAt: Date.now(),
      status: "success",
      totals: { ...tokenTotals, contextTokens: 10000, provenance: { inputTokens: "reported", costUsd: "computed", contextTokens: "estimated" } },
      usage: { ...CREDITS_ONLY, tokens: { available: true }, usd: { available: true } } as UsageAvailability,
    };
    const out = frame([rec], "/tmp/state", true, 200, false);
    const row = out.split("\n").find((l) => l.includes("run-prov"))!;
    assert.ok(row.includes("$0.2500*"), row);
    assert.ok(row.includes("≈10.0k (5.0%)"), row);
    assert.ok(out.includes(PROVENANCE_LEGEND), out);
  });

  it("keeps the * on a three-digit computed cost (the cell must not truncate the marker)", () => {
    const rec: RunRecord = {
      runId: "run-prov-3",
      agent: "claude",
      startedAt: Date.now() - 1000,
      updatedAt: Date.now(),
      status: "success",
      totals: { ...tokenTotals, costUsd: 123.4567, provenance: { costUsd: "computed" } },
    };
    const row = frame([rec], "/tmp/state", true, 200, false).split("\n").find((l) => l.includes("run-prov"))!;
    assert.ok(row.includes("$123.4567*"), row);
  });

  it("a reported cost is unmarked", () => {
    const rec: RunRecord = {
      runId: "run-prov-2",
      agent: "claude",
      startedAt: Date.now() - 1000,
      updatedAt: Date.now(),
      status: "success",
      totals: { ...tokenTotals, provenance: { costUsd: "reported" } },
    };
    const row = frame([rec], "/tmp/state", true, 200, false).split("\n").find((l) => l.includes("run-prov"))!;
    assert.ok(row.includes("$0.2500") && !row.includes("$0.2500*"), row);
  });
});

describe("report markers", () => {
  const result = (over: Partial<RunResult>): RunResult =>
    ({ sessionId: "s", events: [], tokens: [], totalCost: 0, durationMs: 1, exitStatus: "success", warnings: [], ...over }) as RunResult;

  it("per-record provider costs are reported; the driver totalCost fallback is computed (*)", () => {
    const reported = toLoadedRun(
      "claude",
      result({ tokens: [{ model: "m", inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.5 }] }),
      "/t",
      "t",
      null,
      false,
    );
    assert.equal(reported.costProvenance, "reported");
    const computed = toLoadedRun(
      "codex",
      result({ tokens: [{ model: "m", inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }], totalCost: 0.25 }),
      "/t",
      "t",
      null,
      false,
    );
    assert.equal(computed.costProvenance, "computed");
    const html = renderReport({ rootDir: "/t", labels: ["t"], runs: [reported, computed] }, { version: "0.0.0", generatedAt: new Date(0) });
    assert.ok(html.includes("$0.2500*"), "computed cost is marked");
    assert.ok(html.includes("$0.5000<"), "reported cost is unmarked");
    assert.ok(html.includes(PROVENANCE_LEGEND), "legend rendered");
  });
});

describe("web dashboard markers (index.html)", () => {
  const html = readFileSync(join(fileURLToPath(new URL('.', import.meta.url)), "../src/web/index.html"), "utf8");
  const m = /\/\* provenance:begin \*\/([\s\S]*?)\/\* provenance:end \*\//.exec(html);

  it("embeds the provenance helpers and the legend", () => {
    assert.ok(m, "index.html must carry a /* provenance:begin */ … /* provenance:end */ block");
    assert.ok(html.includes(PROVENANCE_LEGEND), "legend text matches the core legend");
  });

  it("marks computed cost with *, estimated context with ≈, and never guesses for external records", () => {
    const ctx = createContext({});
    runInContext(m![1]!, ctx);
    const provMark = ctx.provMark as (r: unknown, field: string) => string;
    const fmtCtx = ctx.fmtCtx as (r: unknown) => string;
    const local = { totals: { ...tokenTotals, contextTokens: 10000 } };
    assert.equal(provMark(local, "costUsd"), "*");
    assert.equal(provMark({ totals: { ...tokenTotals, provenance: { costUsd: "reported" } } }, "costUsd"), "");
    assert.equal(provMark({ source: "external", totals: tokenTotals }, "costUsd"), "");
    assert.equal(fmtCtx(local), "≈10,000 tok");
    assert.equal(fmtCtx({ totals: tokenTotals }), "");
  });
});
