// Run records must never vanish silently (0.11.1 drift item d6-records).
// A record whose `usage` lacks `credits` is listed with credits unknown
// (available: false, never a fabricated 0), and a record that still fails to
// parse is COUNTED and surfaced by `ach stats` / `ach dash`, not dropped.
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { frame } from "../src/cli/dash.ts";
import { listRunRecords, registryDir, scanRunRecords } from "../src/core/registry.ts";

const CLI = fileURLToPath(new URL("../src/cli/ach.ts", import.meta.url));

function runCli(args: string[], env: Record<string, string>): { code: number; stdout: string; stderr: string } {
  const isBun = (process.versions as { bun?: string }).bun !== undefined;
  const p = spawnSync(process.execPath, isBun ? [CLI, ...args] : ["--import", import.meta.resolve("tsx"), CLI, ...args], {
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
  return { code: p.status ?? -1, stdout: p.stdout ?? "", stderr: p.stderr ?? "" };
}

let root = "";
let home = "";
before(() => {
  root = mkdtempSync(join(tmpdir(), "ach-record-skips-"));
  home = mkdtempSync(join(tmpdir(), "ach-record-skips-home-"));
});
after(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

/** A registry record as an older/foreign writer might leave it: usage has no `credits`. */
function noCreditsRecord(runId: string): Record<string, unknown> {
  return {
    runId,
    agent: "claude",
    startedAt: Date.now() - 60_000,
    updatedAt: Date.now() - 30_000,
    status: "success",
    totals: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.01 },
    usage: {
      tokens: { available: true, source: "native" },
      usd: { available: true, source: "pricer", value: 0.01 },
    },
  };
}

function stateWith(name: string, files: Record<string, string>): string {
  const state = join(root, name);
  mkdirSync(registryDir(state), { recursive: true });
  for (const [file, body] of Object.entries(files)) writeFileSync(join(registryDir(state), file), body);
  return state;
}

describe("run records without usage.credits", () => {
  it("are listed, with credits marked unavailable (unknown), never a silent 0", () => {
    const state = stateWith("no-credits", { "run-nocred.json": JSON.stringify(noCreditsRecord("run-nocred")) });
    const recs = listRunRecords(state);
    assert.deepEqual(recs.map((r) => r.runId), ["run-nocred"]);
    assert.equal(recs[0]!.usage?.credits.available, false);
    assert.equal(recs[0]!.usage?.credits.value, undefined);
    assert.equal(recs[0]!.usage?.tokens.available, true);
  });
});

describe("scanRunRecords", () => {
  it("counts malformed and schema-invalid records instead of dropping them silently", () => {
    const state = stateWith("malformed", {
      "run-good.json": JSON.stringify(noCreditsRecord("run-good")),
      "run-badjson.json": "{ not json",
      "run-noagent.json": JSON.stringify({ runId: "run-noagent", startedAt: 1 }),
      "run-good.json.tmp-123": "{ in-flight atomic write",
    });
    const scan = scanRunRecords(state);
    assert.deepEqual(scan.records.map((r) => r.runId), ["run-good"]);
    assert.deepEqual(scan.skipped.map((s) => s.file).sort(), ["run-badjson.json", "run-noagent.json"]);
    assert.match(scan.skipped.find((s) => s.file === "run-badjson.json")!.reason, /JSON/i);
    assert.match(scan.skipped.find((s) => s.file === "run-noagent.json")!.reason, /agent/);
    // listRunRecords keeps its historical shape.
    assert.deepEqual(listRunRecords(state).map((r) => r.runId), ["run-good"]);
  });

  it("a missing registry dir is empty, not an error", () => {
    assert.deepEqual(scanRunRecords(join(root, "does-not-exist")), { records: [], skipped: [] });
  });
});

describe("ach stats / ach dash surface skipped records", () => {
  it("stats --json reports skippedRunRecords and warns on stderr", () => {
    const state = stateWith("stats-skip", {
      "run-ok.json": JSON.stringify(noCreditsRecord("run-ok")),
      "run-bad.json": "{ not json",
    });
    const r = runCli(["stats", "--json", "--state-only"], { AGENTIC_CODING_HARNESS_STATE_DIR: state, HOME: home });
    assert.equal(r.code, 0, r.stderr);
    const out = JSON.parse(r.stdout) as { skippedRunRecords?: number; runs: Array<{ runId: string }> };
    assert.equal(out.skippedRunRecords, 1);
    assert.ok(out.runs.some((x) => x.runId === "run-ok"), "the no-credits record is counted in runs");
    assert.match(r.stderr, /\[warn\] registry: skipped 1 unreadable run record\(s\).*run-bad\.json/);
  });

  it("stats --json omits skippedRunRecords when every record parses", () => {
    const state = stateWith("stats-clean", { "run-ok.json": JSON.stringify(noCreditsRecord("run-ok")) });
    const r = runCli(["stats", "--json", "--state-only"], { AGENTIC_CODING_HARNESS_STATE_DIR: state, HOME: home });
    assert.equal(r.code, 0, r.stderr);
    assert.equal("skippedRunRecords" in (JSON.parse(r.stdout) as object), false);
    assert.doesNotMatch(r.stderr, /unreadable run record/);
  });

  it("text stats prints the skipped count", () => {
    const state = stateWith("stats-text", { "run-bad.json": "[]" });
    const r = runCli(["stats", "--state-only"], { AGENTIC_CODING_HARNESS_STATE_DIR: state, HOME: home });
    assert.match(r.stdout, /skipped\s+1 unreadable run record\(s\)/);
  });

  it("dash --json keeps the good record and warns on stderr about the bad one", () => {
    const state = stateWith("dash-skip", {
      "run-ok.json": JSON.stringify(noCreditsRecord("run-ok")),
      "run-bad.json": "{ not json",
    });
    const r = runCli(["dash", "--json", "--state-only"], { AGENTIC_CODING_HARNESS_STATE_DIR: state, HOME: home });
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual((JSON.parse(r.stdout) as Array<{ runId: string }>).map((x) => x.runId), ["run-ok"]);
    assert.match(r.stderr, /\[warn\] registry: skipped 1 unreadable run record\(s\).*run-bad\.json/);
  });

  it("the live dash frame shows a skipped line only when records were skipped", () => {
    const withSkip = frame([], "/tmp/state", false, 120, false, { skippedRunRecords: 2 });
    assert.match(withSkip, /skipped 2 unreadable run record\(s\)/);
    assert.doesNotMatch(frame([], "/tmp/state", false, 120, false, { skippedRunRecords: 0 }), /unreadable/);
    assert.doesNotMatch(frame([], "/tmp/state", false, 120, false), /unreadable/);
  });
});
