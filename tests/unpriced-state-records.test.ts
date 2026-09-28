// Unpriced state-store records (0.11.1 drift item): a harness-state usage
// record whose model is not in the pricing tables and that carries no
// CLI-reported cost must never read as "$0". It is counted as unpriced
// (`unpricedRecords`) exactly the way a transcript record is, and `ach status`
// prices state records the same way `ach stats` does (parity), while a state
// record that stored an explicit costUsd 0 stays a genuine, reported $0.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { after, before, describe, it } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { StatusSnapshot } from "../src/cli/status.ts";
import { StatusSnapshotSchema } from "../src/cli/status.ts";
import { aggregate } from "../src/cli/lib.ts";

const CLI = new URL("../src/cli/ach.ts", import.meta.url).pathname;
const STATE_ENV = "AGENTIC_CODING_HARNESS_STATE_DIR";

function runCli(args: string[], env: Record<string, string>): { code: number; stdout: string; stderr: string } {
  const isBun = (process.versions as { bun?: string }).bun !== undefined;
  const base: Record<string, string | undefined> = { ...process.env };
  delete base.AGENTIC_CODING_HARNESS_COST_MODE;
  delete base.AGENTIC_CODING_HARNESS_BUDGET_USD;
  const p = spawnSync(process.execPath, isBun ? [CLI, ...args] : ["--import", "tsx", CLI, ...args], {
    env: { ...base, AGENTIC_CODING_HARNESS_TZ: "UTC", ...env } as NodeJS.ProcessEnv,
    encoding: "utf8",
  });
  return { code: p.status ?? -1, stdout: p.stdout ?? "", stderr: p.stderr ?? "" };
}

function writeJsonl(file: string, rows: unknown[]): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
}

const recentIso = new Date(Date.now() - 10 * 60_000).toISOString();
const tokens = { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 };

type Bucket = { costUsd: number | null; records: number; unpricedRecords: number; costSource: string | null };

describe("unpriced state-store records", () => {
  const tmps: string[] = [];
  const mk = (p: string) => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), p));
    tmps.push(d);
    return d;
  };
  let env: Record<string, string>;
  let freeEnv: Record<string, string>;

  before(() => {
    // One unpriceable record (unknown model, no reported cost) and one
    // priceable record that stored no cost (computed at read time).
    const state = mk("ach-unpriced-state-");
    writeJsonl(path.join(state, "raw", "claude", "s1.jsonl"), [
      { ts: recentIso, agent: "claude", sessionId: "s1", model: "mystery-model-9", ...tokens },
    ]);
    writeJsonl(path.join(state, "raw", "claude", "s2.jsonl"), [
      { ts: recentIso, agent: "claude", sessionId: "s2", model: "claude-sonnet-4-5", ...tokens },
    ]);
    env = { [STATE_ENV]: state, HOME: mk("ach-unpriced-home-") };

    // A genuinely free run: the producer stored costUsd 0 for a priced model.
    const free = mk("ach-free-state-");
    writeJsonl(path.join(free, "raw", "claude", "f1.jsonl"), [
      { ts: recentIso, agent: "claude", sessionId: "f1", model: "claude-sonnet-4-5", ...tokens, costUsd: 0 },
    ]);
    freeEnv = { [STATE_ENV]: free, HOME: mk("ach-free-home-") };
  });

  after(() => {
    for (const d of tmps) fs.rmSync(d, { recursive: true, force: true });
  });

  it("aggregate counts records with no cost as unpriced, never as priced $0", () => {
    const row = { ts: recentIso, agent: "a", ...tokens };
    const agg = aggregate([{ ...row, costUsd: 0.25 }, { ...row }, { ...row, costUsd: 0 }]);
    assert.equal(agg.totals.records, 3);
    assert.equal(agg.totals.unpricedRecords, 1);
    assert.equal(agg.totals.costUsd, 0.25);
    assert.equal(agg.byAgent.a!.unpricedRecords, 1);
  });

  it("stats --json counts the unpriced state record in every bucket", () => {
    const r = runCli(["stats", "--json", "--state-only"], env);
    assert.equal(r.code, 0, r.stderr);
    const j = JSON.parse(r.stdout) as { total: Bucket; byAgent: Record<string, Bucket>; byDay: Record<string, Bucket>; byModel: Record<string, Bucket>; unpricedModels: string[] };
    assert.equal(j.total.records, 2);
    assert.equal(j.total.unpricedRecords, 1);
    assert.ok(j.total.costUsd !== null && j.total.costUsd > 0, "the priceable record still prices");
    assert.equal(j.byAgent.claude!.unpricedRecords, 1);
    for (const b of Object.values(j.byDay)) assert.equal(b.unpricedRecords, 1);
    assert.equal(j.byModel["claude/mystery-model-9"]!.costUsd, null);
    assert.equal(j.byModel["claude/mystery-model-9"]!.unpricedRecords, 1);
    assert.equal(j.byModel["claude/claude-sonnet-4-5"]!.unpricedRecords, 0);
    assert.deepEqual(j.unpricedModels, ["claude/mystery-model-9"]);
  });

  it("stats text marks the unpriced records instead of a bare total", () => {
    const r = runCli(["stats", "--state-only"], env);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /^totals .* unpriced=1/m);
  });

  it("status prices state records exactly like stats (parity) and counts the unpriced one", () => {
    const stats = JSON.parse(runCli(["stats", "--days", "1", "--json", "--state-only"], env).stdout) as { total: Bucket };
    const r = runCli(["status", "--json"], env);
    assert.equal(r.code, 0, r.stderr);
    const s = JSON.parse(r.stdout) as StatusSnapshot & { today: { unpricedRecords: number; byAgent: Record<string, { unpricedRecords: number }> } };
    assert.ok(StatusSnapshotSchema.strict().safeParse(s).success);
    assert.equal(s.today.costUsd, stats.total.costUsd);
    assert.ok(s.today.costUsd > 0);
    assert.equal(s.today.records, 2);
    assert.equal(s.today.unpricedRecords, 1);
    assert.equal(s.today.byAgent.claude!.unpricedRecords, 1);
    // The open 5h block holds the priced record, so its cost is known.
    assert.equal(s.block.costUsd, stats.total.costUsd);
    assert.equal(r.stderr, "", "status stays quiet on stderr (statusline safety)");
  });

  it("status human and compact renders say how many records are unpriced", () => {
    const h = runCli(["status"], env);
    assert.equal(h.code, 0, h.stderr);
    assert.match(h.stdout, /^today .*\(\+1 unpriced\)/m);
    const c = runCli(["status", "--compact"], env);
    assert.equal(c.code, 0, c.stderr);
    assert.match(c.stdout, / unpriced=1$/m);
  });

  it("statusline marks today's spend as a lower bound when records are unpriced", () => {
    const r = runCli(["statusline", "--no-cache"], env);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, / · today \$\d+\.\d{4} \(\+1 unpriced\) · block /);
    const free = runCli(["statusline", "--no-cache"], freeEnv);
    assert.doesNotMatch(free.stdout, /unpriced/);
  });

  it("an explicit stored costUsd 0 on a priced model stays a reported $0, not unpriced", () => {
    const st = JSON.parse(runCli(["stats", "--json", "--state-only"], freeEnv).stdout) as { total: Bucket };
    assert.equal(st.total.costUsd, 0);
    assert.equal(st.total.unpricedRecords, 0);
    assert.equal(st.total.costSource, "reported");
    const s = JSON.parse(runCli(["status", "--json"], freeEnv).stdout) as StatusSnapshot & { today: { unpricedRecords: number } };
    assert.equal(s.today.costUsd, 0);
    assert.equal(s.today.unpricedRecords, 0);
    const c = runCli(["status", "--compact"], freeEnv);
    assert.doesNotMatch(c.stdout, /unpriced=/);
  });
});
