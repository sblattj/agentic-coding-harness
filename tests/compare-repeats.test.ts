// /compare pass-rate + repeat statistics (#29, #30): groups whose records
// carry a `verify` verdict gain `passRate` and a `repeats` object; groups
// without any verdict stay byte-identical to the pre-0.11 row shape.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { writeRunRecord, type RunRecord } from "../src/core/registry.ts";
import type { VerifyResult } from "../src/core/verify.ts";
import { computeCompareRows } from "../src/web/compare.ts";
import { startWebServer } from "../src/web/server.ts";

const T0 = 1_700_000_000_000;

function verdict(status: VerifyResult["status"]): VerifyResult {
  return {
    command: "npm test",
    exitCode: status === "pass" ? 0 : status === "fail" ? 1 : null,
    status,
    durationMs: 10,
    timedOut: status === "error",
  };
}

function rec(over: Partial<RunRecord>): RunRecord {
  return { runId: "r", agent: "claude", startedAt: T0, endedAt: T0 + 1000, status: "success", ...over };
}

// Fixture: cell A = 3 scored repeats with one flaky fail; cell B = 1 scored
// run; cell C = 2 runs, none scored.
function fixture(): RunRecord[] {
  return [
    rec({ runId: "a1", experiment: "e", variant: "A", verify: verdict("pass") }),
    rec({ runId: "a2", experiment: "e", variant: "A", verify: verdict("fail") }),
    rec({ runId: "a3", experiment: "e", variant: "A", verify: verdict("pass") }),
    rec({ runId: "b1", experiment: "e", variant: "B", verify: verdict("pass") }),
    rec({ runId: "c1", experiment: "e", variant: "C" }),
    rec({ runId: "c2", experiment: "e", variant: "C", status: "error" }),
  ];
}

describe("computeCompareRows — passRate + repeats", () => {
  it("k=3 cell with one flaky fail: pass@1 2/3, pass^k 0, any-pass@k 1, Wilson bounds", () => {
    const rows = computeCompareRows(fixture(), ["experiment", "variant"]);
    const a = rows.find((r) => r.variant === "A")!;
    assert.equal(a.passRate, 2 / 3);
    assert.equal(a.successRate, 1); // agent exit status is a separate axis
    const rep = a.repeats!;
    assert.equal(rep.k, 3);
    assert.equal(rep.passes, 2);
    assert.equal(rep.passAt1, 2 / 3);
    assert.equal(rep.passHatK, 0);
    assert.equal(rep.anyPassAtK, 1);
    assert.ok(rep.wilsonLo! > 0.2 && rep.wilsonLo! < 0.21, String(rep.wilsonLo)); // 0.2077
    assert.ok(rep.wilsonHi! > 0.93 && rep.wilsonHi! < 0.94, String(rep.wilsonHi)); // 0.9385
  });

  it("k=1 cell omits CI and k-draw fields instead of a degenerate interval", () => {
    const rows = computeCompareRows(fixture(), ["experiment", "variant"]);
    const b = rows.find((r) => r.variant === "B")!;
    assert.equal(b.passRate, 1);
    assert.deepEqual(b.repeats, { k: 1, passes: 1, passAt1: 1 });
  });

  it("a cell with no verdicts has no passRate / repeats keys at all (n/a, not 0)", () => {
    const rows = computeCompareRows(fixture(), ["experiment", "variant"]);
    const c = rows.find((r) => r.variant === "C")!;
    assert.equal("passRate" in c, false);
    assert.equal("repeats" in c, false);
  });

  it("verifier errors count as not-passed (scored), never silently dropped", () => {
    const rows = computeCompareRows(
      [
        rec({ runId: "x1", experiment: "e", variant: "X", verify: verdict("pass") }),
        rec({ runId: "x2", experiment: "e", variant: "X", verify: verdict("error") }),
      ],
      ["experiment", "variant"],
    );
    assert.equal(rows[0]!.passRate, 0.5);
    assert.equal((rows[0]!.repeats as { k: number }).k, 2);
  });

  it("a later regrade does not change the run-time pass rate", () => {
    const rows = computeCompareRows(
      [rec({ runId: "g1", experiment: "e", variant: "G", verify: verdict("fail"), regrades: [verdict("pass")] })],
      ["experiment", "variant"],
    );
    assert.equal(rows[0]!.passRate, 0);
  });
});

describe("compare.html outcome columns", () => {
  it("declares the outcome columns and its inline script still parses", () => {
    const html = readFileSync(new URL("../src/web/compare.html", import.meta.url), "utf8");
    assert.ok(html.includes('var OUTCOME_COLS = ["passRate", "passCi", "passHatK", "anyPassAtK"]'));
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]!);
    assert.ok(scripts.length > 0);
    for (const src of scripts) assert.doesNotThrow(() => new Function(src));
  });
});

describe("GET /api/compare returns repeats per group", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "harness-compare-rep-"));
  let handle: Awaited<ReturnType<typeof startWebServer>> | null = null;
  before(async () => {
    for (const r of fixture()) writeRunRecord(stateDir, r);
    handle = await startWebServer({ port: 0, host: "127.0.0.1", token: "t", stateDir });
  });
  after(async () => {
    await handle?.close();
    rmSync(stateDir, { recursive: true, force: true });
  });

  it("by=experiment,variant carries passRate + repeats through the registry round trip", async () => {
    const res = await fetch(`http://127.0.0.1:${handle!.port}/api/compare?by=experiment,variant`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { rows: Array<Record<string, unknown>> };
    const a = body.rows.find((r) => r.variant === "A")!;
    assert.equal(a.passRate, 2 / 3);
    assert.equal((a.repeats as { k: number }).k, 3);
    const b = body.rows.find((r) => r.variant === "B")!;
    assert.equal("wilsonLo" in (b.repeats as object), false);
    const c = body.rows.find((r) => r.variant === "C")!;
    assert.equal("repeats" in c, false);
  });
});
