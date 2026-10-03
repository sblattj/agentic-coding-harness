// Provider-reported subscription quota headroom (issue #17).
//
// Recorded provider payloads and a documented edge-case example:
//  - codex: `rate_limits` on `token_count` events in ~/.codex/sessions rollouts
//    (fixtures trimmed from real rollouts on disk, ids anonymized)
//  - claude: real statusline rate_limits captured from Claude Code 2.1.283
//    after /usage on 2026-09-28 UTC, with zero model tokens or API cost.
//    The separate documented example covers the optional spend_limit field.
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
  quotaWaitDecision,
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
  it("preserves a recorded live Claude quota and renders the tightest window", async () => {
    const json = JSON.parse(await fs.readFile(path.join(FIX, "claude-statusline-recorded.json"), "utf8"));
    const now = Date.UTC(2026, 8, 28, 6, 38);
    const snap = parseClaudeStatusline(json, now);
    assert.ok(snap);
    assert.deepEqual(snap.windows, [
      { name: "5h", windowMinutes: 300, usedPercent: 0, resetsAt: 1790595000 },
      { name: "7d", windowMinutes: 10080, usedPercent: 34, resetsAt: 1791039600 },
    ]);
    const rows = quotaRows({ claude: snap }, now).filter((row) => row.agent === "claude");
    assert.deepEqual(rows.map((row) => [row.available, row.usedPercent, row.leftPercent]), [
      [true, 0, 100], [true, 34, 66],
    ]);
    assert.equal(dashQuotaCell(rows, "claude"), "66%/7d");
  });

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
    const out = frame([rec], "/tmp/state", true, 220, false, { quota: quotaRows({ codex }, CODEX_NOW) });
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

  it("a payload without the 5h window keeps the earlier 5h reading, so wait --window 5h sees the reset", async () => {
    const state = await fs.mkdtemp(path.join(os.tmpdir(), "ach-quota-state-"));
    const env = { AGENTIC_CODING_HARNESS_STATE_DIR: state, AGENTIC_CODING_HARNESS_QUOTA_CODEX_DIR: path.join(FIX, "none") };
    const passed = Math.floor(Date.now() / 1000) - 60;
    const before = { rate_limits: { five_hour: { used_percentage: 86, resets_at: passed }, seven_day: { used_percentage: 20, resets_at: 4102444800 } } };
    assert.equal(runCli(["quota", "ingest", "claude"], env, JSON.stringify(before)).code, 0);
    const after = { rate_limits: { seven_day: { used_percentage: 27, resets_at: 4102444800 } } };
    assert.equal(runCli(["quota", "ingest", "claude"], env, JSON.stringify(after)).code, 0);
    const rows = JSON.parse(runCli(["quota", "--json"], env).stdout) as Array<{ agent: string; window?: string; usedPercent?: number }>;
    assert.deepEqual(rows.filter((x) => x.agent === "claude").map((x) => x.window).sort(), ["5h", "7d"]);
    assert.equal(rows.find((x) => x.agent === "claude" && x.window === "7d")?.usedPercent, 27);
    const w = runCli(["quota", "wait", "--window", "5h", "--max-used", "10"], env);
    assert.equal(w.code, 0, w.stderr);
    assert.match(w.stderr, /ready: claude: 1 window\(s\) reset since last observation/);
  });
});

describe("quota: wait decision", () => {
  const NOW = Date.UTC(2026, 9, 2, 12, 0, 0);
  const sec = (ms: number): number => Math.floor(ms / 1000);
  const claude = (windows: Array<{ name: string; used: number; resetsInMs?: number }>) =>
    quotaRows(
      {
        claude: {
          agent: "claude",
          source: "statusline",
          observedAt: NOW - 60_000,
          windows: windows.map((w) => ({
            name: w.name,
            usedPercent: w.used,
            ...(w.resetsInMs === undefined ? {} : { resetsAt: sec(NOW + w.resetsInMs) }),
          })),
        },
      },
      NOW,
    );

  it("is ready when every window is under the limit", () => {
    const d = quotaWaitDecision(claude([{ name: "5h", used: 40, resetsInMs: 3_600_000 }]), { agent: "claude" });
    assert.equal(d.state, "ready");
    assert.match(d.reason, /5h 40\.0% used \(limit 95%\)/);
  });

  it("waits until the latest blocking window resets", () => {
    const rows = claude([
      { name: "5h", used: 99, resetsInMs: 2 * 3_600_000 },
      { name: "7d", used: 96, resetsInMs: 5 * 3_600_000 },
    ]);
    const d = quotaWaitDecision(rows, { agent: "claude" });
    assert.equal(d.state, "wait");
    assert.ok(d.state === "wait" && d.waitMs !== undefined && Math.abs(d.waitMs - 5 * 3_600_000) < 1000);
  });

  it("--window narrows which windows count", () => {
    const rows = claude([
      { name: "5h", used: 10, resetsInMs: 3_600_000 },
      { name: "7d", used: 99, resetsInMs: 3 * 86_400_000 },
    ]);
    assert.equal(quotaWaitDecision(rows, { agent: "claude", windows: ["5h"] }).state, "ready");
    assert.equal(quotaWaitDecision(rows, { agent: "claude" }).state, "wait");
  });

  it("--max-used moves the bar", () => {
    const rows = claude([{ name: "5h", used: 80, resetsInMs: 3_600_000 }]);
    assert.equal(quotaWaitDecision(rows, { agent: "claude", maxUsed: 75 }).state, "wait");
    assert.equal(quotaWaitDecision(rows, { agent: "claude", maxUsed: 90 }).state, "ready");
  });

  it("a window that reset since it was observed counts as ready", () => {
    const rows = claude([{ name: "5h", used: 100, resetsInMs: -60_000 }]);
    const d = quotaWaitDecision(rows, { agent: "claude" });
    assert.equal(d.state, "ready");
    assert.match(d.reason, /reset since last observation/);
  });

  it("a blocker with no resets_at waits with no known end", () => {
    const d = quotaWaitDecision(claude([{ name: "spend", used: 120 }]), { agent: "claude" });
    assert.equal(d.state, "wait");
    assert.ok(d.state === "wait" && d.waitMs === undefined);
  });

  it("an agent with no vendor number is unknown, never ready", () => {
    const d = quotaWaitDecision(quotaRows({}, NOW), { agent: "gemini" });
    assert.equal(d.state, "unknown");
    assert.match(d.reason, /no vendor quota source wired/);
  });
});

describe("quota: wait cli", () => {
  const snapshotEnv = async (used: number, resetsAt: number): Promise<Record<string, string>> => {
    const state = await fs.mkdtemp(path.join(os.tmpdir(), "ach-quota-wait-"));
    await writeClaudeSnapshot(path.join(state, "quota", "claude.json"), {
      agent: "claude",
      source: "statusline",
      observedAt: Date.now(),
      windows: [{ name: "5h", windowMinutes: 300, usedPercent: used, resetsAt }],
    });
    return { AGENTIC_CODING_HARNESS_STATE_DIR: state, AGENTIC_CODING_HARNESS_QUOTA_CODEX_DIR: path.join(FIX, "none") };
  };

  it("with headroom it runs the command at once and exits with its code", async () => {
    const env = await snapshotEnv(20, 4102444800);
    const r = runCli(["quota", "wait", "--", process.execPath, "-e", "process.exit(3)"], env);
    assert.equal(r.code, 3, r.stderr);
    assert.match(r.stderr, /ready: claude: 5h 20\.0% used/);
  });

  it("at the limit it waits for the reset, then runs", async () => {
    const env = await snapshotEnv(99, Math.ceil(Date.now() / 1000) + 2);
    const t0 = Date.now();
    const r = runCli(["quota", "wait", "--poll-s", "1", "--grace-s", "0", "--", process.execPath, "-e", "process.exit(0)"], env);
    assert.equal(r.code, 0, r.stderr);
    assert.ok(Date.now() - t0 >= 1000, "returned before the reset");
    assert.match(r.stderr, /waiting: claude: 5h 99\.0% used/);
  });

  it("--timeout-s gives up with exit 1 and does not run the command", async () => {
    const env = await snapshotEnv(99, 4102444800);
    const r = runCli(["quota", "wait", "--poll-s", "1", "--timeout-s", "1", "--", process.execPath, "-e", "process.exit(0)"], env);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /timed out after/);
  });

  it("no vendor number exits 1 unless --allow-unknown", async () => {
    const state = await fs.mkdtemp(path.join(os.tmpdir(), "ach-quota-wait-"));
    const env = { AGENTIC_CODING_HARNESS_STATE_DIR: state, AGENTIC_CODING_HARNESS_QUOTA_CODEX_DIR: path.join(FIX, "none") };
    const r = runCli(["quota", "wait"], env);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /--allow-unknown/);
    assert.equal(runCli(["quota", "wait", "--allow-unknown"], env).code, 0);
  });

  it("rejects a bad --max-used and an empty command after --", async () => {
    const env = await snapshotEnv(20, 4102444800);
    assert.equal(runCli(["quota", "wait", "--max-used", "abc"], env).code, 1);
    assert.equal(runCli(["quota", "wait", "--"], env).code, 1);
  });
});
