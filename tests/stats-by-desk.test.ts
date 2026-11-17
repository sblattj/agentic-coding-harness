// #204: `ach stats --by desk`.
import "./support/no-network.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { aggregateDims, deskIndex, deskLabel, NO_DESK, parseByDims, renderDimsText, type DimRecord } from "../src/cli/stats-dims.ts";
import { writeRunRecord } from "../src/core/registry.ts";

function rec(over: Partial<DimRecord>): DimRecord {
  return { ts: "2026-09-01T10:00:00.000Z", agent: "claude", inputTokens: 10, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, costUsd: 0.5, ...over };
}

describe("--by desk (unit)", () => {
  it("parseByDims accepts desk and composes", () => {
    assert.deepEqual([...parseByDims(["desk,model"])].sort(), ["desk", "model"]);
  });

  it("deskLabel formats <stack>/<name> and rejects junk", () => {
    assert.equal(deskLabel({ stack: "default", name: "LISTENER", kind: "desk" }), "default/LISTENER");
    assert.equal(deskLabel(undefined), undefined);
    assert.equal(deskLabel({ stack: "x" }), undefined);
    assert.equal(deskLabel("nope"), undefined);
  });

  it("aggregateDims groups by desk with (none) last; absent without the option", () => {
    const rows = [rec({ desk: "default/A" }), rec({ desk: "default/A" }), rec({}), rec({ desk: "default/B" })];
    const dims = aggregateDims(rows, { byDesk: true });
    assert.deepEqual(Object.keys(dims.byDesk!).sort(), [NO_DESK, "default/A", "default/B"]);
    assert.equal(dims.byDesk!["default/A"]!.records, 2);
    assert.equal(aggregateDims(rows, {}).byDesk, undefined);
    const text = renderDimsText(dims, { model: false, project: false, desk: true });
    assert.equal(text[0], "-- by desk");
    assert.match(text.at(-1)!, /^\(none\) +records=1 /);
  });

  it("deskIndex maps a turn run through parentRunId to its desk, by agent+session", () => {
    const idx = deskIndex([
      { runId: "r-desk", agent: "opencode", sessionId: "s-desk", desk: { stack: "s", name: "ORCH", kind: "desk" } },
      { runId: "r-turn", agent: "claude", sessionId: "s-turn", parentRunId: "r-desk", desk: { stack: "s", name: "turn-7", kind: "turn" } },
      { runId: "r-orphan-turn", agent: "claude", sessionId: "s-orphan", parentRunId: "gone", desk: { stack: "s", name: "LANE", kind: "turn" } },
      { runId: "r-plain", agent: "claude", sessionId: "s-plain" },
    ]);
    assert.equal(idx("opencode", "s-desk"), "s/ORCH");
    assert.equal(idx("claude", "s-turn"), "s/ORCH");
    assert.equal(idx("claude", "s-orphan"), "s/LANE");
    assert.equal(idx("claude", "s-plain"), undefined);
    assert.equal(idx("claude", null), undefined);
  });
});

describe("ach stats --by desk (CLI)", () => {
  const CLI = new URL("../src/cli/ach.ts", import.meta.url).pathname;
  let stateDir: string;
  let home: string;
  const recent = new Date(Date.now() - 86_400_000).toISOString();

  const line = (agent: string, sessionId: string, input: number, extra?: Record<string, unknown>) =>
    JSON.stringify({ ts: recent, agent, sessionId, model: "gpt-5", inputTokens: input, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, costUsd: 0.01, ...(extra ? { extra } : {}) }) + "\n";

  before(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "ach-desk-state-"));
    home = fs.mkdtempSync(path.join(os.tmpdir(), "ach-desk-home-"));
    fs.mkdirSync(path.join(stateDir, "raw", "codex"), { recursive: true });
    fs.mkdirSync(path.join(stateDir, "runs"), { recursive: true });
    // 1: a desk-host record (extra.desk, two lines on the same lane).
    fs.writeFileSync(
      path.join(stateDir, "raw", "codex", "s-lane.jsonl"),
      line("codex", "s-lane", 100, { source: "desk-host", runId: "r-lane", desk: { stack: "default", name: "FIX-LOGIN", kind: "lane" } }) +
        line("codex", "s-lane", 50, { source: "desk-host", runId: "r-lane", desk: { stack: "default", name: "FIX-LOGIN", kind: "lane" } }),
    );
    // 2: a plain record.
    fs.writeFileSync(path.join(stateDir, "raw", "codex", "s-plain.jsonl"), line("codex", "s-plain", 400));
    // 3: a driver-engine turn run: no extra.desk on the record, mapped via the registry child run.
    fs.writeFileSync(path.join(stateDir, "raw", "codex", "s-turn.jsonl"), line("codex", "s-turn", 800));
    writeRunRecord(stateDir, { runId: "r-orch", agent: "claude", startedAt: Date.now(), desk: { stack: "default", name: "ORCHESTRATOR", kind: "desk" } });
    writeRunRecord(stateDir, { runId: "r-turn", agent: "codex", sessionId: "s-turn", startedAt: Date.now(), parentRunId: "r-orch", desk: { stack: "default", name: "ORCHESTRATOR", kind: "turn" } });
    writeRunRecord(stateDir, { runId: "r-plain", agent: "codex", sessionId: "s-plain", startedAt: Date.now() });
  });
  after(() => {
    for (const d of [stateDir, home]) fs.rmSync(d, { recursive: true, force: true });
  });

  const run = (args: string[]) => {
    const p = spawnSync(process.execPath, ["--import", "tsx", CLI, ...args], {
      env: { ...process.env, AGENTIC_CODING_HARNESS_STATE_DIR: stateDir, HOME: home, AGENTIC_CODING_HARNESS_PROJECT_ALIASES: "", AGENTIC_CODING_HARNESS_TZ: "UTC" },
      encoding: "utf8",
    });
    return { code: p.status ?? -1, stdout: p.stdout ?? "", stderr: p.stderr ?? "" };
  };

  it("--json groups desk-host records, turn-run records and plain records; totals unchanged", () => {
    const res = run(["stats", "--json", "--state-only", "--by", "desk"]);
    assert.equal(res.code, 0, res.stderr);
    const out = JSON.parse(res.stdout);
    assert.deepEqual(Object.keys(out.byDesk).sort(), ["(none)", "default/FIX-LOGIN", "default/ORCHESTRATOR"]);
    assert.equal(out.byDesk["default/FIX-LOGIN"].records, 2);
    assert.equal(out.byDesk["default/FIX-LOGIN"].inputTokens, 150);
    assert.equal(out.byDesk["default/ORCHESTRATOR"].inputTokens, 800);
    assert.equal(out.byDesk["(none)"].inputTokens, 400);
    const plain = JSON.parse(run(["stats", "--json", "--state-only"]).stdout);
    assert.equal(plain.byDesk, undefined, "absent without --by desk");
    assert.deepEqual(out.total, plain.total, "totals identical with and without --by desk");
    const sum = Object.values<{ inputTokens: number }>(out.byDesk).reduce((n, b) => n + b.inputTokens, 0);
    assert.equal(sum, out.total.inputTokens);
  });

  it("text output prints a per-desk table and composes with --by model", () => {
    const res = run(["stats", "--state-only", "--by", "desk"]);
    assert.equal(res.code, 0, res.stderr);
    assert.match(res.stdout, /-- by desk/);
    assert.match(res.stdout, /^default\/FIX-LOGIN +records=2 /m);
    assert.match(res.stdout, /^\(none\) +records=1 /m);
    const both = JSON.parse(run(["stats", "--json", "--state-only", "--by", "model,desk"]).stdout);
    assert.ok(both.byModel && both.byDesk);
  });

  it("an unknown --by value lists desk among the choices", () => {
    const res = run(["stats", "--state-only", "--by", "bogus"]);
    assert.notEqual(res.code, 0);
    assert.match(res.stderr, /expected one of:.*\bdesk\b/);
  });
});
