// `ach stats` + Cursor dashboard imports: replacement rules (pure) and a CLI run.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { after, describe, it } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { dashboardSpan, reconcileDashboardWithState, inDashboardSpan } from "../src/cli/cursor-dashboard-merge.ts";
import type { CanonicalTokenRecord } from "../src/monitors/transcripts.ts";

const MIN = 60_000;
const T0 = Date.parse("2026-10-09T18:58:39.000Z");
const iso = (ms: number) => new Date(ms).toISOString();

function dash(over: Partial<CanonicalTokenRecord> = {}): CanonicalTokenRecord {
  return {
    agent: "cursor", sessionId: null, timestamp: iso(T0), model: null,
    input: 12182, output: 289, cacheRead: 19328, cacheWrite: 0, reasoning: 0,
    costUsd: 0.0218, extra: { source: "cursor-dashboard", costBasis: "cursor-dashboard-charged" },
    ...over,
  } as CanonicalTokenRecord;
}
function st(id: string, over: Record<string, unknown> = {}) {
  return {
    id, agent: "cursor", sessionId: "s-" + id, ts: iso(T0 + MIN),
    inputTokens: 12182, outputTokens: 289, cacheReadTokens: 19328, cacheWriteTokens: 0, ...over,
  };
}

describe("reconcileDashboardWithState", () => {
  it("JSON row (sessionId) replaces every state record of that session and inherits nothing new", () => {
    const a = st("a", { sessionId: "conv-1", inputTokens: 1 });
    const b = st("b", { sessionId: "conv-1", ts: iso(T0 + 3 * 60 * MIN) });
    const other = st("c", { sessionId: "conv-2" });
    const r = reconcileDashboardWithState([dash({ sessionId: "conv-1" })], [a, b, other]);
    assert.deepEqual([...r.dropped].map((x) => x.id).sort(), ["a", "b"]);
    assert.equal(r.matches.length, 1);
    assert.equal(r.matches[0]!.sessionId, "conv-1");
    assert.equal(r.matches[0]!.replaced[0]!.id, "a");
  });

  it("CSV row replaces a state record with identical tokens within 10 minutes and inherits its session", () => {
    const a = st("a", { ts: iso(T0 + 9 * MIN) });
    const r = reconcileDashboardWithState([dash()], [a]);
    assert.deepEqual([...r.dropped].map((x) => x.id), ["a"]);
    assert.equal(r.matches[0]!.sessionId, "s-a");
    assert.equal(r.matches[0]!.replaced[0], a);
  });

  it("control: identical tokens 11 minutes away are not replaced", () => {
    const a = st("a", { ts: iso(T0 + 11 * MIN) });
    const r = reconcileDashboardWithState([dash()], [a]);
    assert.equal(r.dropped.size, 0);
    assert.equal(r.matches[0]!.sessionId, null);
  });

  it("control: different tokens are not replaced; non-cursor agents are ignored", () => {
    const r = reconcileDashboardWithState([dash()], [st("a", { outputTokens: 290 }), st("b", { agent: "claude" })]);
    assert.equal(r.dropped.size, 0);
  });

  it("one CSV row consumes at most one of two identical state records", () => {
    const a = st("a");
    const b = st("b", { ts: iso(T0 + 2 * MIN) });
    const r = reconcileDashboardWithState([dash()], [a, b]);
    assert.equal(r.dropped.size, 1);
    assert.equal(r.matches[0]!.replaced.length, 1);
  });

  it("two CSV rows consume the two identical state records, one each", () => {
    const a = st("a");
    const b = st("b", { ts: iso(T0 + 2 * MIN) });
    const r = reconcileDashboardWithState([dash(), dash({ timestamp: iso(T0 + 4 * MIN) })], [a, b]);
    assert.equal(r.dropped.size, 2);
    assert.notEqual(r.matches[0]!.sessionId, r.matches[1]!.sessionId);
  });

  it("IDE rows inside the dashboard span are dropped, outside kept", () => {
    const span = dashboardSpan([dash(), dash({ timestamp: iso(T0 + 60 * MIN) })]);
    assert.ok(span);
    assert.equal(inDashboardSpan(span, T0 + 30 * MIN), true);
    assert.equal(inDashboardSpan(span, T0), true);
    assert.equal(inDashboardSpan(span, T0 + 60 * MIN), true);
    assert.equal(inDashboardSpan(span, T0 - MIN), false);
    assert.equal(inDashboardSpan(span, T0 + 61 * MIN), false);
    assert.equal(inDashboardSpan(null, T0), false);
    assert.equal(dashboardSpan([]), null);
  });
});

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const CLI = new URL("../src/cli/ach.ts", import.meta.url).pathname;
const FIX = new URL("./fixtures/cursor-dashboard/", import.meta.url).pathname;
const SESSION = "2270cfa6-400b-442f-bc88-11ff110d7192";

function runCli(args: string[], env: Record<string, string>) {
  const isBun = (process.versions as { bun?: string }).bun !== undefined;
  const p = spawnSync(process.execPath, isBun ? [CLI, ...args] : ["--import", "tsx", CLI, ...args], {
    env: { ...process.env, AGENTIC_CODING_HARNESS_PROJECT_ALIASES: "", AGENTIC_CODING_HARNESS_TZ: "UTC", ...env },
    encoding: "utf8",
  });
  return { code: p.status ?? -1, stdout: p.stdout ?? "", stderr: p.stderr ?? "" };
}

describe("ach stats counts imported Cursor dashboard exports (CLI)", () => {
  const dirs: string[] = [];
  after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

  function setup(withDashboard: boolean): Record<string, string> {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "ach-cdash-state-"));
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "ach-cdash-home-"));
    dirs.push(stateDir, home);
    fs.mkdirSync(path.join(stateDir, "raw", "cursor"), { recursive: true });
    fs.writeFileSync(
      path.join(stateDir, "raw", "cursor", `${SESSION}.jsonl`),
      JSON.stringify({
        ts: "2026-10-09T19:03:08.000Z", agent: "cursor", sessionId: SESSION, model: "claude-sonnet-4-5",
        inputTokens: 12182, outputTokens: 289, cacheReadTokens: 19328, cacheWriteTokens: 0, reasoningTokens: 0,
      }) + "\n",
    );
    if (withDashboard) {
      fs.mkdirSync(path.join(stateDir, "cursor-dashboard"), { recursive: true });
      fs.copyFileSync(path.join(FIX, "usage-live-2026-10-09.json"), path.join(stateDir, "cursor-dashboard", "a.json"));
    }
    return { AGENTIC_CODING_HARNESS_STATE_DIR: stateDir, HOME: home };
  }
  const args = ["stats", "--json", "--since", "2026-10-09", "--until", "2026-10-10", "--state-only"];

  it("the dashboard replaces the matching ach run record: billed cost, tokens counted once", () => {
    const res = runCli(args, setup(true));
    assert.equal(res.code, 0, res.stderr);
    const out = JSON.parse(res.stdout);
    const j = JSON.parse(fs.readFileSync(path.join(FIX, "usage-live-2026-10-09.json"), "utf8"));
    const cents = (j.usageEventsDisplay as { chargedCents: number }[]).map((e) => e.chargedCents);
    assert.equal(cents.length, 3);
    assert.equal(out.byAgent.cursor.records, 3);
    assert.equal(out.byAgent.cursor.inputTokens, 12175 + 12171 + 12182);
    assert.ok(Math.abs(out.byAgent.cursor.costUsd - cents.reduce((a, b) => a + b, 0) / 100) < 1e-6, String(out.byAgent.cursor.costUsd));
    assert.ok(Math.abs(out.byAgent.cursor.costUsd - 0.06504) < 1e-4);
  });

  it("control: without the dashboard file the state record and its computed cost appear", () => {
    const res = runCli(args, setup(false));
    assert.equal(res.code, 0, res.stderr);
    const out = JSON.parse(res.stdout);
    assert.equal(out.byAgent.cursor.records, 1);
    assert.equal(out.byAgent.cursor.inputTokens, 12182);
    assert.ok(out.byAgent.cursor.costUsd > 0);
  });
});
