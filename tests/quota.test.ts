// Provider-reported subscription quota headroom (issue #17).
//
// Every number here comes from a recorded vendor payload, never estimated:
//  - codex: `rate_limits` on `token_count` events in ~/.codex/sessions rollouts
//    (fixtures trimmed from real rollouts on disk, ids anonymized)
//  - claude: `rate_limits` on the statusline stdin JSON (fixture trimmed from
//    the documented example; ingested via `ach quota ingest claude`)
// Agents without vendor reporting render `n/a`. No live network, no real CLIs.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import {
  QUOTA_AGENTS,
  collectQuota,
  dashQuotaCell,
  parseClaudeStatusline,
  parseCodexRateLimits,
  quotaRows,
  readClaudeSnapshot,
  readCodexQuota,
  renderQuotaTable,
  writeClaudeSnapshot,
} from "../src/core/quota.ts";
import { frame } from "../src/cli/dash.ts";
import type { RunRecord } from "../src/core/registry.ts";

const FIX = new URL("./fixtures/quota/", import.meta.url).pathname;
const CODEX_DIR = path.join(FIX, "codex-sessions");
const CLAUDE_STATUSLINE = path.join(FIX, "claude-statusline.json");
const CLI = new URL("../src/cli/ach.ts", import.meta.url).pathname;

// 2026-09-03T23:31:00Z — just after the newest codex fixture line, before
// either of its windows resets (5h at 1788496153, 7d at 1788962884).
const CODEX_NOW = Date.UTC(2026, 8, 3, 23, 31, 0);
// 2025-02-01T12:00:00Z — before every window in the docs statusline example.
const CLAUDE_NOW = Date.UTC(2025, 1, 1, 12, 0, 0);

function runCli(args: string[], env: Record<string, string>, input?: string): { code: number; stdout: string; stderr: string } {
  const isBun = (process.versions as { bun?: string }).bun !== undefined;
  const p = spawnSync(process.execPath, isBun ? [CLI, ...args] : ["--import", "tsx", CLI, ...args], {
    env: { ...process.env, ...env },
    encoding: "utf8",
    input,
  });
  return { code: p.status ?? -1, stdout: p.stdout ?? "", stderr: p.stderr ?? "" };
}

describe("quota — codex rollout rate_limits", () => {
  it("parses primary + secondary windows from a token_count line", async () => {
    const text = await fs.readFile(
      path.join(CODEX_DIR, "2026/09/03/rollout-2026-09-03T16-29-27-00000000-0000-7000-8000-000000000002.jsonl"),
      "utf8",
    );
    const line = text.trim().split("\n").at(-1) ?? "";
    const snap = parseCodexRateLimits(line);
    assert.ok(snap);
    assert.equal(snap.agent, "codex");
    assert.equal(snap.plan, "plus");
    assert.equal(snap.observedAt, Date.parse("2026-09-03T23:30:15.444Z"));
    assert.deepEqual(snap.windows, [
      { name: "5h", windowMinutes: 300, usedPercent: 2, resetsAt: 1788496153 },
      { name: "7d", windowMinutes: 10080, usedPercent: 0, resetsAt: 1788962884 },
    ]);
  });

  it("ignores lines without rate_limits and non-JSON lines", () => {
    assert.equal(parseCodexRateLimits('{"type":"event_msg","payload":{"type":"agent_message"}}'), undefined);
    assert.equal(parseCodexRateLimits("not json"), undefined);
    assert.equal(
      parseCodexRateLimits('{"timestamp":"2026-01-01T00:00:00Z","type":"event_msg","payload":{"type":"token_count","rate_limits":{"primary":null,"secondary":null}}}'),
      undefined,
    );
  });

  it("reads the LAST observation of the NEWEST rollout (by rollout filename)", async () => {
    const snap = await readCodexQuota(CODEX_DIR);
    assert.ok(snap);
    assert.equal(snap.windows[0]?.usedPercent, 2); // not 1.0 (earlier line), not 6.0 (older file)
    assert.equal(snap.windows.length, 2);
    assert.match(snap.source, /rollout-2026-09-03T16-29-27/);
  });

  it("returns undefined for a missing sessions dir", async () => {
    assert.equal(await readCodexQuota(path.join(FIX, "does-not-exist")), undefined);
  });
});

describe("quota — claude statusline rate_limits", () => {
  it("parses five_hour, seven_day, spend_limit from the statusline JSON", async () => {
    const json = JSON.parse(await fs.readFile(CLAUDE_STATUSLINE, "utf8"));
    const snap = parseClaudeStatusline(json, 1234);
    assert.ok(snap);
    assert.equal(snap.agent, "claude");
    assert.equal(snap.observedAt, 1234);
    assert.deepEqual(snap.windows, [
      { name: "5h", windowMinutes: 300, usedPercent: 23.5, resetsAt: 1738425600 },
      { name: "7d", windowMinutes: 10080, usedPercent: 41.2, resetsAt: 1738857600 },
      { name: "spend", usedPercent: 62.8, resetsAt: 1740787200 },
    ]);
  });

  it("returns undefined when rate_limits is absent (API-key user, or before the first response)", () => {
    assert.equal(parseClaudeStatusline({ model: { id: "x" } }, 1), undefined);
    assert.equal(parseClaudeStatusline({ rate_limits: {} }, 1), undefined);
    assert.equal(parseClaudeStatusline(null, 1), undefined);
  });

  it("round-trips a snapshot through the state file", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ach-quota-"));
    const file = path.join(dir, "quota", "claude.json");
    const json = JSON.parse(await fs.readFile(CLAUDE_STATUSLINE, "utf8"));
    const snap = parseClaudeStatusline(json, 99);
    assert.ok(snap);
    await writeClaudeSnapshot(file, snap);
    assert.deepEqual(await readClaudeSnapshot(file), snap);
    assert.equal(await readClaudeSnapshot(path.join(dir, "nope.json")), undefined);
  });
});

describe("quota — rows and rendering", () => {
  it("emits one n/a row per agent that has no vendor source, never a number", () => {
    const rows = quotaRows({}, CODEX_NOW);
    assert.deepEqual(rows.map((r) => r.agent), [...QUOTA_AGENTS]);
    for (const r of rows) {
      assert.equal(r.available, false);
      assert.equal(r.usedPercent, undefined);
      assert.ok(r.reason && r.reason.length > 0);
    }
  });

  it("computes % left and time remaining from vendor numbers", async () => {
    const codex = await readCodexQuota(CODEX_DIR);
    assert.ok(codex);
    const rows = quotaRows({ codex }, CODEX_NOW).filter((r) => r.agent === "codex");
    assert.equal(rows.length, 2);
    const five = rows[0];
    assert.equal(five?.available, true);
    assert.equal(five?.window, "5h");
    assert.equal(five?.usedPercent, 2);
    assert.equal(five?.leftPercent, 98);
    assert.equal(five?.resetsInMs, 1788496153 * 1000 - CODEX_NOW);
  });

  it("marks a window n/a once its resets_at has passed (the reported number is for a dead window)", async () => {
    const codex = await readCodexQuota(CODEX_DIR);
    assert.ok(codex);
    const later = 1788496153 * 1000 + 60_000; // 5h window reset, 7d still live
    const rows = quotaRows({ codex }, later).filter((r) => r.agent === "codex");
    assert.equal(rows[0]?.available, false);
    assert.match(rows[0]?.reason ?? "", /reset/);
    assert.equal(rows[0]?.usedPercent, undefined);
    assert.equal(rows[1]?.available, true);
  });

  it("clamps % left at 0 when a spend limit is exceeded (used > 100)", () => {
    const rows = quotaRows(
      { claude: { agent: "claude", source: "t", observedAt: 0, windows: [{ name: "spend", usedPercent: 120, resetsAt: 4102444800 }] } },
      CLAUDE_NOW,
    ).filter((r) => r.agent === "claude");
    assert.equal(rows[0]?.leftPercent, 0);
    assert.equal(rows[0]?.usedPercent, 120);
  });

  it("renders the agent | window | used | remaining | % left table with n/a rows", async () => {
    const codex = await readCodexQuota(CODEX_DIR);
    assert.ok(codex);
    const out = renderQuotaTable(quotaRows({ codex }, CODEX_NOW));
    const lines = out.split("\n");
    assert.match(lines[0] ?? "", /^AGENT\s+WINDOW\s+USED\s+REMAINING\s+% LEFT/);
    const codex5h = lines.find((l) => l.startsWith("codex") && l.includes("5h"));
    assert.ok(codex5h, out);
    assert.ok(codex5h.includes("2.0%") && codex5h.includes("98.0%"), codex5h);
    const gemini = lines.find((l) => l.startsWith("gemini"));
    assert.ok(gemini && gemini.includes("n/a"), out);
  });

  it("dash cell shows the tightest window's % left, n/a without a source", async () => {
    const codex = await readCodexQuota(CODEX_DIR);
    assert.ok(codex);
    const rows = quotaRows({ codex }, CODEX_NOW);
    assert.equal(dashQuotaCell(rows, "codex"), "98%/5h");
    assert.equal(dashQuotaCell(rows, "gemini"), "n/a");
    assert.equal(dashQuotaCell(rows, "unknown-agent"), "n/a");
  });

  it("collectQuota reads both sources from explicit paths", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ach-quota-"));
    const claudeFile = path.join(dir, "claude.json");
    const json = JSON.parse(await fs.readFile(CLAUDE_STATUSLINE, "utf8"));
    const snap = parseClaudeStatusline(json, CLAUDE_NOW);
    assert.ok(snap);
    await writeClaudeSnapshot(claudeFile, snap);
    const rows = await collectQuota({ codexDir: CODEX_DIR, claudeFile, now: CLAUDE_NOW });
    assert.equal(rows.filter((r) => r.agent === "claude" && r.available).length, 3);
    // codex fixture windows reset in 2026 — still live at a 2025 "now"
    assert.equal(rows.filter((r) => r.agent === "codex" && r.available).length, 2);
  });
});

describe("quota — dash column", () => {
  const rec = {
    runId: "codex-run-1",
    agent: "codex",
    status: "success",
    startedAt: Date.now() - 1000,
    updatedAt: Date.now(),
    totals: { inputTokens: 10, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.01 },
  } as unknown as RunRecord;

  it("adds a QUOTA column fed by the same rows when quota is supplied", async () => {
    const codex = await readCodexQuota(CODEX_DIR);
    assert.ok(codex);
    const out = frame([rec], "/tmp/state", true, 220, false, quotaRows({ codex }, CODEX_NOW));
    const lines = out.split("\n");
    assert.ok(lines[1]?.includes("QUOTA"), lines[1]);
    const row = lines.find((l) => l.includes("codex-ru"));
    assert.ok(row?.includes("98%/5h"), row);
  });

  it("omits the QUOTA column when no quota is supplied (unchanged legacy frame)", () => {
    const out = frame([rec], "/tmp/state", true, 220, false);
    assert.ok(!out.includes("QUOTA"), out);
  });
});

describe("quota — cli", () => {
  it("ach quota ingest claude + ach quota --json use the same state file", async () => {
    const state = await fs.mkdtemp(path.join(os.tmpdir(), "ach-quota-state-"));
    const env = {
      AGENTIC_CODING_HARNESS_STATE_DIR: state,
      AGENTIC_CODING_HARNESS_QUOTA_CODEX_DIR: CODEX_DIR,
    };
    const payload = JSON.stringify({
      session_id: "s",
      rate_limits: { five_hour: { used_percentage: 10, resets_at: 4102444800 } },
    });
    const ing = runCli(["quota", "ingest", "claude"], env, payload);
    assert.equal(ing.code, 0, ing.stderr);
    assert.equal(ing.stdout, ""); // silent: safe to call from a statusline script

    const r = runCli(["quota", "--json"], env);
    assert.equal(r.code, 0, r.stderr);
    const rows = JSON.parse(r.stdout) as Array<{ agent: string; available: boolean; window?: string; leftPercent?: number }>;
    const claude = rows.find((x) => x.agent === "claude");
    assert.equal(claude?.available, true);
    assert.equal(claude?.window, "5h");
    assert.equal(claude?.leftPercent, 90);
    assert.ok(rows.some((x) => x.agent === "gemini" && x.available === false));
  });

  it("ingest with no rate_limits leaves the previous snapshot alone and still exits 0", async () => {
    const state = await fs.mkdtemp(path.join(os.tmpdir(), "ach-quota-state-"));
    const env = { AGENTIC_CODING_HARNESS_STATE_DIR: state, AGENTIC_CODING_HARNESS_QUOTA_CODEX_DIR: path.join(FIX, "none") };
    const r = runCli(["quota", "ingest", "claude"], env, JSON.stringify({ session_id: "s" }));
    assert.equal(r.code, 0, r.stderr);
    await assert.rejects(fs.stat(path.join(state, "quota", "claude.json")));
    const t = runCli(["quota"], env);
    assert.equal(t.code, 0, t.stderr);
    assert.match(t.stdout, /^AGENT\s+WINDOW/);
    assert.ok(t.stdout.split("\n").filter((l) => l.includes("n/a")).length >= QUOTA_AGENTS.length, t.stdout);
  });
});
