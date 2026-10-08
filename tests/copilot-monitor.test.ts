// Read-only Copilot CLI transcript monitor (#23): `ach stats` over past
// sessions the harness did not launch. Synthetic fixtures only:
// tests/fixtures/copilot/session-state/<id>/events.jsonl.
//   ...0001  two shutdowns (cumulative: 500 -> 1000 input) plus a malformed line
//   ...0002  no session.shutdown
//   ...0003  shutdown reporting 0 nano-AIU (BYOK / unmetered)
//   ...0004  one shutdown, used as the `ach run`-owned session
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { parseCopilotSession, isCopilotEventsFile } from "../src/monitors/copilot.ts";
import { transcriptSources, scanAll } from "../src/monitors/transcripts.ts";
import { isTranscriptOnlyAgent } from "../src/monitors/transcript-sources.ts";
import { copilotSessionStateRoot } from "../src/monitors/copilot.ts";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "fixtures/copilot/session-state");
const S_MULTI = "11111111-aaaa-4aaa-8aaa-000000000001";
const S_NONE = "22222222-bbbb-4bbb-8bbb-000000000002";
const S_ZERO = "33333333-cccc-4ccc-8ccc-000000000003";
const S_OWNED = "44444444-dddd-4ddd-8ddd-000000000004";
const file = (id: string) => join(ROOT, id, "events.jsonl");

const collect = async (id: string) => {
  const warnings: string[] = [];
  const recs = await parseCopilotSession(file(id), (m) => warnings.push(m));
  return { recs, warnings };
};

test("several shutdowns in one session: the LAST cumulative snapshot, not the sum", async () => {
  const { recs } = await collect(S_MULTI);
  assert.equal(recs.length, 1);
  const r = recs[0]!;
  assert.equal(r.agent, "copilot");
  assert.equal(r.sessionId, S_MULTI);
  assert.equal(r.model, "gpt-5");
  // inputTokens 1000 includes 600 cache reads: uncached input = 400 (a sum would give 700 / 1500)
  assert.equal(r.input, 400);
  assert.equal(r.cacheRead, 600);
  assert.equal(r.cacheWrite, 0);
  assert.equal(r.output, 50);
  assert.equal(r.timestamp, "2026-03-01T11:30:00.000Z");
  // 3e9 nano-AIU = 3 AIU = $0.03 (a sum would be 4 AIU)
  assert.equal(r.costUsd, 0.03);
  assert.equal(r.extra?.credits, 3);
  assert.equal(r.extra?.creditUnit, "copilot");
  assert.equal(r.extra?.vendorMetered, true);
});

test("malformed lines are skipped with a warning and do not lose the session", async () => {
  const { recs, warnings } = await collect(S_MULTI);
  assert.equal(recs.length, 1);
  assert.ok(warnings.some((w) => /skipped line 3 \(invalid JSON\)/.test(w)), warnings.join("\n"));
});

test("an unreadable file warns and yields nothing", async () => {
  const warnings: string[] = [];
  const recs = await parseCopilotSession(join(ROOT, "nope", "events.jsonl"), (m) => warnings.push(m));
  assert.deepEqual(recs, []);
  assert.match(warnings[0] ?? "", /unreadable/);
});

test("a session with no shutdown yields no record and says so (usage is not estimated)", async () => {
  const { recs, warnings } = await collect(S_NONE);
  assert.deepEqual(recs, []);
  assert.ok(warnings.some((w) => /no session\.shutdown/.test(w) && /not estimated/.test(w)), warnings.join("\n"));
});

test("AIU 0: tokens kept, cost null, warning shown, never a token-price estimate", async () => {
  const { recs, warnings } = await collect(S_ZERO);
  assert.equal(recs.length, 1);
  const r = recs[0]!;
  assert.equal(r.input, 150);
  assert.equal(r.output, 10);
  assert.equal(r.costUsd, undefined);
  assert.equal(r.extra?.credits, undefined);
  assert.equal(r.extra?.vendorMetered, true); // no consumer may token-price it
  assert.ok(warnings.some((w) => /0 nano-AIU/.test(w) && /never estimated from tokens/.test(w)), warnings.join("\n"));
});

test("keep() accepts only <...>/session-state/<id>/events.jsonl", () => {
  assert.equal(isCopilotEventsFile(file(S_MULTI)), true);
  assert.equal(isCopilotEventsFile(join(ROOT, S_MULTI, "other.jsonl")), false);
  assert.equal(isCopilotEventsFile(join(ROOT, "events.jsonl")), false);
  assert.equal(isCopilotEventsFile(join(ROOT, S_MULTI, "nested", "events.jsonl")), false);
});

test("copilot is a NATIVE source (like prime), not read-only: `ach run --agent copilot` must stay launchable", () => {
  assert.equal(isTranscriptOnlyAgent("copilot"), false);
  assert.ok(transcriptSources().some((s) => s.agent === "copilot"));
});

const withEnv = <T>(over: Record<string, string | undefined>, fn: () => T): T => {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(over)) saved[k] = process.env[k];
  try {
    for (const [k, v] of Object.entries(over)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
};

test("COPILOT_HOME relocates the default root (real home only); a --transcript-dir root always means <root>/.copilot", () => {
  const dirs = (opts = {}) => transcriptSources(opts).filter((s) => s.agent === "copilot").map((s) => s.dir);
  withEnv({ COPILOT_HOME: "/x/copilot-home" }, () => {
    assert.deepEqual(dirs(), [join("/x/copilot-home", "session-state")]);
    assert.deepEqual(dirs({ copilotDir: "/y" }), ["/y"]);
    assert.equal(copilotSessionStateRoot("/some/root"), join("/some/root", ".copilot", "session-state"));
  });
  withEnv({ COPILOT_HOME: undefined }, () => {
    assert.match(dirs()[0]!, /\.copilot[\\/]session-state$/);
  });
});

test("scanAll over the copilot root yields one record per metered session and skips the no-shutdown one", async () => {
  const recs: Awaited<ReturnType<typeof parseCopilotSession>> = [];
  await withEnvAsync({ COPILOT_HOME: join(ROOT, "..") }, async () => {
    for await (const r of scanAll({ claudeDir: "/nonexistent", codexDir: "/nonexistent", geminiDir: "/nonexistent", primeDir: "/nonexistent", copilotDir: join(ROOT), sourceRoots: { amp: [], goose: [], qwen: [], cursor: [] } })) {
      if (r.agent === "copilot") recs.push(r);
    }
  });
  assert.deepEqual(recs.map((r) => r.sessionId).sort(), [S_MULTI, S_ZERO, S_OWNED].sort());
});

async function withEnvAsync(over: Record<string, string>, fn: () => Promise<void>): Promise<void> {
  const saved = Object.fromEntries(Object.keys(over).map((k) => [k, process.env[k]]));
  Object.assign(process.env, over);
  try { await fn(); } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

// ---------------------------------------------------------------- CLI (real entry point)

const cli = new URL("../src/cli/ach.ts", import.meta.url).pathname;
const loaderArgs = process.versions.bun ? [] : ["--import", import.meta.resolve("tsx")];

function runStats(copilotHome: string, state: string, extra: string[] = []) {
  const home = mkdtempSync(join(tmpdir(), "ach-copilot-home-"));
  const p = spawnSync(process.execPath, [...loaderArgs, cli, "stats", "--json", "--agent", "copilot", "--cost-mode", "auto", "--days", "36500", ...extra], {
    cwd: home,
    env: { ...process.env, HOME: home, COPILOT_HOME: copilotHome, AGENTIC_CODING_HARNESS_STATE_DIR: state },
    encoding: "utf8",
    timeout: 30_000,
  });
  rmSync(home, { recursive: true, force: true });
  return { code: p.status, out: p.stdout, err: p.stderr };
}

test("ach stats --agent copilot (COPILOT_HOME=fixture): AIU cost, no token-price estimate, warnings for the rest", () => {
  const state = mkdtempSync(join(tmpdir(), "ach-copilot-state-"));
  try {
    const r = runStats(join(ROOT, ".."), state);
    assert.equal(r.code, 0, r.err);
    const j = JSON.parse(r.out);
    const total = j.totals ?? j.total ?? j;
    // 3 metered/zero sessions: MULTI + ZERO + OWNED (no run owns them here).
    // cost = 3 AIU ($0.03) + 2 AIU ($0.02); the 0-AIU session adds nothing.
    assert.equal(Number(total.costUsd.toFixed(6)), 0.05, r.out);
    assert.match(r.err, /copilot: .*no session\.shutdown/);
    assert.match(r.err, /0 nano-AIU/);
  } finally {
    rmSync(state, { recursive: true, force: true });
  }
});

test("no double count: a session an `ach run` owns is read from the run, not again from events.jsonl", () => {
  const state = mkdtempSync(join(tmpdir(), "ach-copilot-state-"));
  try {
    mkdirSync(join(state, "runs"), { recursive: true });
    writeFileSync(join(state, "runs", "run-owned.json"), JSON.stringify({
      runId: "run-owned", agent: "copilot", sessionId: S_OWNED, pid: process.pid, cwd: tmpdir(), promptPreview: "hi",
      startedAt: Date.parse("2026-03-04T10:00:00Z"), updatedAt: Date.parse("2026-03-04T10:05:00Z"), status: "success",
      totals: { inputTokens: 300, outputTokens: 40, cacheReadTokens: 100, cacheWriteTokens: 0, costUsd: 0.02 },
      rawTranscript: join(tmpdir(), "raw.jsonl"),
    }));
    const r = runStats(join(ROOT, ".."), state);
    assert.equal(r.code, 0, r.err);
    const total = JSON.parse(r.out).totals ?? JSON.parse(r.out).total;
    assert.equal(Number(total.costUsd.toFixed(6)), 0.03, r.out); // OWNED's $0.02 is not added
  } finally {
    rmSync(state, { recursive: true, force: true });
  }
});
