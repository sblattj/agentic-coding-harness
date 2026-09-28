// Issue #28: `ach stats --cost-mode auto|calculate|display`, costSource
// provenance on every cost bucket, and reported-vs-computed disagreements.
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { after, before, describe, test } from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  COST_MODES,
  costDisagreement,
  resolveCostMode,
  selectCost,
} from "../src/cli/cost-mode.ts";
import { createPricer, pricedSources } from "../src/core/pricing.ts";
import type { CanonicalTokenRecord } from "../src/core/types.ts";

const CLI = fileURLToPath(new URL("../src/cli/ach.ts", import.meta.url));

function runCli(args: string[], env: Record<string, string>) {
  const isBun = (process.versions as { bun?: string }).bun !== undefined;
  const base = { ...process.env };
  delete base.AGENTIC_CODING_HARNESS_COST_MODE; // a developer's own env must not leak in
  const p = spawnSync(process.execPath, isBun ? [CLI, ...args] : ["--import", "tsx", CLI, ...args], {
    env: { ...base, ...env },
    encoding: "utf8",
  });
  return { code: p.status ?? -1, stdout: p.stdout ?? "", stderr: p.stderr ?? "" };
}

const round6 = (n: number) => Math.round(n * 1e6) / 1e6;

/** Computed cost via the same bundled pricer the CLI uses (no hardcoded prices). */
function computed(model: string, inputTokens: number, outputTokens = 0): number {
  const c = createPricer().price(
    { model, inputTokens, outputTokens, cacheReadTokens: 0, cacheWriteTokens: 0 },
    { computedOnly: true },
  );
  assert.ok(Number.isFinite(c) && c > 0, `bundled pricer must price ${model}: ${c}`);
  return c;
}

describe("cost-mode helpers", () => {
  test("resolveCostMode: default auto, env honored, flag beats env, empty env = unset", () => {
    assert.equal(resolveCostMode(undefined, undefined), "auto");
    assert.equal(resolveCostMode(undefined, ""), "auto");
    assert.equal(resolveCostMode(undefined, "calculate"), "calculate");
    assert.equal(resolveCostMode("display", "calculate"), "display");
    assert.deepEqual([...COST_MODES], ["auto", "calculate", "display"]);
  });

  test("resolveCostMode: a bad name errors and lists the valid modes", () => {
    assert.throws(() => resolveCostMode("bogus", undefined), (e: Error & { code?: string }) => {
      assert.equal(e.code, "BAD_COST_MODE");
      assert.match(e.message, /'bogus'/);
      assert.match(e.message, /--cost-mode/);
      assert.match(e.message, /auto, calculate, display/);
      return true;
    });
    assert.throws(() => resolveCostMode(undefined, "Nope"), /AGENTIC_CODING_HARNESS_COST_MODE.*auto, calculate, display/);
  });

  test("selectCost: the three modes on reported != computed, and on reported absent", () => {
    assert.deepEqual(selectCost("auto", 2, 1), { costUsd: 2, costSource: "reported" });
    assert.deepEqual(selectCost("calculate", 2, 1), { costUsd: 1, costSource: "computed" });
    assert.deepEqual(selectCost("display", 2, 1), { costUsd: 2, costSource: "reported" });
    assert.deepEqual(selectCost("auto", undefined, 1), { costUsd: 1, costSource: "computed" });
    assert.deepEqual(selectCost("calculate", undefined, 1), { costUsd: 1, costSource: "computed" });
    assert.deepEqual(selectCost("display", undefined, 1), {});
    assert.deepEqual(selectCost("calculate", 2, undefined), {});
  });

  test("costDisagreement boundary: 0.5% is silent, 2% is flagged, both values required", () => {
    assert.equal(costDisagreement(1.005, 1), null);
    assert.equal(costDisagreement(1, 1.005), null);
    const d = costDisagreement(1.02, 1);
    assert.ok(d);
    assert.equal(round6(d.deltaUsd), 0.02);
    assert.ok(d.deltaPct > 1 && d.deltaPct < 2, `deltaPct ${d.deltaPct}`);
    assert.ok(costDisagreement(1, 1.02));
    assert.equal(costDisagreement(undefined, 1), null);
    assert.equal(costDisagreement(1, undefined), null);
    assert.equal(costDisagreement(0, 0), null);
    assert.ok(costDisagreement(0.5, 0), "reported cost against a computed $0 is a disagreement");
  });
});

describe("pricer computedOnly (calculate ignores CLI-reported slice costs)", () => {
  const multi = (withCosts: boolean): CanonicalTokenRecord => ({
    model: "claude-opus-4",
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    extra: {
      raw: {
        models: [
          { model: "claude-opus-4", input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0, ...(withCosts ? { costUsd: 99 } : {}) },
          { model: "claude-sonnet-4", input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0, ...(withCosts ? { costUsd: 1 } : {}) },
        ],
      },
    },
  });

  test("default price sums reported slice costs; computedOnly prices slice tokens", () => {
    const p = createPricer();
    assert.equal(p.price(multi(true)), 100);
    const pure = p.price(multi(true), { computedOnly: true });
    assert.equal(pure, p.price(multi(false)));
    assert.equal(pure, computed("claude-opus-4", 1_000_000) + computed("claude-sonnet-4", 1_000_000));
  });

  test("pricedSources labels which path price() takes", () => {
    assert.deepEqual(pricedSources(multi(true)), { reported: true, computed: false });
    assert.deepEqual(pricedSources(multi(false)), { reported: false, computed: true });
    assert.deepEqual(pricedSources({ model: "gpt-5", inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }), { reported: false, computed: true });
  });
});

describe("ach stats --cost-mode (CLI)", () => {
  let stateDir: string;
  let home: string;
  // claude: two records whose CLI-reported cost is 2% and 0.5% above computed.
  // codex: one record with NO reported cost (computed only).
  const c1 = computed("claude-sonnet-4-5", 1_000_000);
  const c2 = computed("claude-sonnet-4-5", 2_000_000);
  const c3 = computed("gpt-5", 1_000_000, 100_000);
  const r1 = c1 * 1.02;
  const r2 = c2 * 1.005;

  before(async () => {
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "harness-costmode-state-"));
    home = await fs.mkdtemp(path.join(os.tmpdir(), "harness-costmode-home-"));
    const ts = new Date(Date.now() - 86_400_000).toISOString();
    const rec = (agent: string, sessionId: string, model: string, inputTokens: number, outputTokens: number, costUsd?: number) =>
      JSON.stringify({
        ts,
        agent,
        sessionId,
        model,
        inputTokens,
        outputTokens,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        ...(costUsd !== undefined ? { costUsd } : {}),
      });
    await fs.mkdir(path.join(stateDir, "raw", "claude"), { recursive: true });
    await fs.mkdir(path.join(stateDir, "raw", "codex"), { recursive: true });
    await fs.writeFile(
      path.join(stateDir, "raw", "claude", "sess-c.jsonl"),
      [rec("claude", "sess-c", "claude-sonnet-4-5", 1_000_000, 0, r1), rec("claude", "sess-c", "claude-sonnet-4-5", 2_000_000, 0, r2)].join("\n") + "\n",
    );
    await fs.writeFile(path.join(stateDir, "raw", "codex", "sess-x.jsonl"), rec("codex", "sess-x", "gpt-5", 1_000_000, 100_000) + "\n");
  });

  after(async () => {
    await fs.rm(stateDir, { recursive: true, force: true });
    await fs.rm(home, { recursive: true, force: true });
  });

  const env = (extra: Record<string, string> = {}) => ({ AGENTIC_CODING_HARNESS_STATE_DIR: stateDir, HOME: home, ...extra });
  const stats = (args: string[], extra?: Record<string, string>) => {
    const r = runCli(["stats", "--json", ...args], env(extra));
    assert.equal(r.code, 0, r.stderr);
    return { out: JSON.parse(r.stdout), stderr: r.stderr };
  };

  test("auto: reported where present, computed otherwise; mixed total has costSource null + split", () => {
    const { out } = stats([]);
    assert.equal(out.byAgent.claude.costUsd, round6(r1 + r2));
    assert.equal(out.byAgent.claude.costSource, "reported");
    assert.equal(out.byAgent.codex.costUsd, round6(c3));
    assert.equal(out.byAgent.codex.costSource, "computed");
    assert.equal(out.total.costUsd, round6(r1 + r2 + c3));
    assert.equal(out.total.costSource, null);
    assert.deepEqual(out.total.costBySource, { reported: round6(r1 + r2), computed: round6(c3) });
  });

  test("calculate: always token math, even where a reported number exists", () => {
    const { out } = stats(["--cost-mode", "calculate"]);
    assert.equal(out.byAgent.claude.costUsd, round6(c1 + c2));
    assert.equal(out.byAgent.claude.costSource, "computed");
    assert.equal(out.byAgent.codex.costUsd, round6(c3));
    assert.equal(out.total.costUsd, round6(c1 + c2 + c3));
    assert.equal(out.total.costSource, "computed");
    assert.deepEqual(out.total.costBySource, { reported: null, computed: round6(c1 + c2 + c3) });
  });

  test("display: reported verbatim; a bucket with no reported cost is costUsd null + costSource null", () => {
    const { out } = stats(["--cost-mode", "display"]);
    assert.equal(out.byAgent.claude.costUsd, round6(r1 + r2));
    assert.equal(out.byAgent.claude.costSource, "reported");
    assert.equal(out.byAgent.codex.costUsd, null);
    assert.equal(out.byAgent.codex.costSource, null);
    assert.deepEqual(out.byAgent.codex.costBySource, { reported: null, computed: null });
    assert.equal(out.total.costUsd, round6(r1 + r2));
    assert.equal(out.total.costSource, "reported");
  });

  test("disagreement: the 2% record is flagged with both values and the delta; the 0.5% record is not", () => {
    for (const mode of COST_MODES) {
      const { out, stderr } = stats(["--cost-mode", mode]);
      assert.equal(out.total.costDisagreements, 1, `mode ${mode}`);
      const lines = stderr.split("\n").filter((l) => l.includes("cost disagreement:"));
      assert.equal(lines.length, 1, `mode ${mode}: ${stderr}`);
      assert.ok(lines[0]!.includes(`reported=$${r1.toFixed(6)}`), lines[0]);
      assert.ok(lines[0]!.includes(`computed=$${c1.toFixed(6)}`), lines[0]);
      assert.match(lines[0]!, /delta=\+\$\d+\.\d{6} \(1\.9\d%\)/);
    }
  });

  test("text table shows the mode in effect and a disagreement row", () => {
    const r = runCli(["stats", "--cost-mode", "display"], env());
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /^totals .* costMode=display$/m);
    assert.match(r.stdout, /^disagree +1 record\(s\) where reported and computed cost differ by >1%/m);
    assert.match(r.stdout, /^codex .* cost=n\/a cacheHit=/m);
  });

  test("provenance map (#33): transcript tokens reported, priced cost computed, a blend computed, n/a unlabelled", () => {
    const lanes = { inputTokens: "reported", outputTokens: "reported", cacheReadTokens: "reported", cacheWriteTokens: "reported", reasoningTokens: "reported" };
    const auto = stats([]).out;
    assert.deepEqual(auto.byAgent.codex.provenance, { ...lanes, costUsd: "computed" });
    assert.deepEqual(auto.byAgent.claude.provenance, { ...lanes, costUsd: "reported" });
    assert.equal(auto.total.provenance.costUsd, "computed"); // reported + computed blend
    for (const [k, b] of Object.entries(auto.byDay as Record<string, { provenance?: unknown }>)) {
      assert.ok(b.provenance, `byDay.${k} carries a provenance map`);
    }
    const display = stats(["--cost-mode", "display"]).out;
    assert.equal(display.byAgent.codex.costUsd, null);
    assert.deepEqual(display.byAgent.codex.provenance, lanes); // no cost -> no costUsd label
  });

  test("text table marks computed cost with * and prints the legend", () => {
    const r = runCli(["stats"], env());
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /^codex .* cost=\$\d+\.\d{4}\* cacheHit=/m);
    assert.match(r.stdout, /^claude .* cost=\$\d+\.\d{4} cacheHit=/m);
    assert.match(r.stdout, /^legend +\* computed/m);
  });

  test("env default honored; flag overrides env", () => {
    assert.equal(stats([], { AGENTIC_CODING_HARNESS_COST_MODE: "calculate" }).out.total.costSource, "computed");
    const both = stats(["--cost-mode", "display"], { AGENTIC_CODING_HARNESS_COST_MODE: "calculate" }).out;
    assert.equal(both.total.costSource, "reported");
    assert.equal(both.byAgent.codex.costUsd, null);
  });

  test("a bad mode name (flag or env) exits 1 listing the valid modes", () => {
    const bad = runCli(["stats", "--json", "--cost-mode", "bogus"], env());
    assert.equal(bad.code, 1);
    assert.equal(bad.stdout, "");
    assert.match(bad.stderr, /unknown cost mode 'bogus'.*auto, calculate, display/);
    const badEnv = runCli(["stats", "--json"], env({ AGENTIC_CODING_HARNESS_COST_MODE: "cheap" }));
    assert.equal(badEnv.code, 1);
    assert.match(badEnv.stderr, /'cheap' from AGENTIC_CODING_HARNESS_COST_MODE.*auto, calculate, display/);
  });
});
