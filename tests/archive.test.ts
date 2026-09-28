// ach archive (#79): warehouse snapshots of raw transcripts + registry records
// that survive the agent CLIs' own cleanup (Claude Code prunes ~30 days).
//
// Every fixture lives in a temp dir: a fake HOME (machine transcript dirs) and
// a fake state dir. Nothing touches the real ~/.claude or ~/.agentic-coding-harness.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { auditRuns } from "../src/cli/audit.ts";
import { resolveRawTranscript, writeRunRecord, type RunRecord } from "../src/core/registry.ts";
import { archiveTranscripts, restoreBatch } from "../src/core/warehouse.ts";
import { findArchivedRaw, readManifest, warehouseDir } from "../src/core/warehouse-index.ts";
import { scanAll, scanOptionsForRoot } from "../src/monitors/transcripts.ts";
import { RunEventHub } from "../src/web/hub.ts";

const CLI = new URL("../src/cli/ach.ts", import.meta.url).pathname;

function runCli(args: string[], env: Record<string, string> = {}): { code: number; stdout: string; stderr: string } {
  const isBun = (process.versions as { bun?: string }).bun !== undefined;
  const p = spawnSync(process.execPath, isBun ? [CLI, ...args] : ["--import", "tsx", CLI, ...args], {
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
  return { code: p.status ?? -1, stdout: p.stdout ?? "", stderr: p.stderr ?? "" };
}

function tmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function sha256(file: string): string {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function write(file: string, text: string, mtimeMs?: number): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  if (mtimeMs !== undefined) fs.utimesSync(file, mtimeMs / 1000, mtimeMs / 1000);
  return file;
}

const NOW = Date.now();
const DAY = 86_400_000;

function claudeLine(session: string, id: string, ts: string, input: number): string {
  return (
    JSON.stringify({
      type: "assistant",
      timestamp: ts,
      sessionId: session,
      requestId: `req-${id}`,
      message: {
        id: `msg-${id}`,
        model: "claude-sonnet-4-5",
        usage: { input_tokens: input, output_tokens: 5, cache_read_input_tokens: 2, cache_creation_input_tokens: 1 },
      },
    }) + "\n"
  );
}

interface Fixture {
  home: string;
  state: string;
  claudeMain: string;
  claudeSub: string;
  claudeOld: string;
  codex: string;
  gemini: string;
  raw: string;
  rec: RunRecord;
}

/** A home with claude (main + subagent + a 30-day-old session), codex and
 *  gemini transcripts, plus a state dir with one driver run (record + raw). */
function fixture(): Fixture {
  const home = tmp("ach-wh-home-");
  const state = tmp("ach-wh-state-");
  const recent = new Date(NOW - DAY).toISOString();
  const old = new Date(NOW - 30 * DAY).toISOString();
  const proj = path.join(home, ".claude", "projects", "-Users-me-proj");
  const claudeMain = write(path.join(proj, "sess-live.jsonl"), claudeLine("sess-live", "1", recent, 10));
  const claudeSub = write(
    path.join(proj, "sess-live", "subagents", "agent-a1.jsonl"),
    claudeLine("sess-live", "2", recent, 20),
  );
  const claudeOld = write(path.join(proj, "sess-old.jsonl"), claudeLine("sess-old", "3", old, 30), NOW - 30 * DAY);
  const codex = write(
    path.join(home, ".codex", "sessions", "2026", "09", "26", "rollout-2026-09-26T10-00-00-abc.jsonl"),
    JSON.stringify({ type: "session_meta", payload: { id: "codex-sess" } }) +
      "\n" +
      JSON.stringify({
        type: "token_usage_record",
        timestamp: recent,
        payload: { thread_token_usage: { thread_id: "t", input_tokens: 100, cached_input_tokens: 40, output_tokens: 7 } },
      }) +
      "\n",
  );
  const gemini = write(
    path.join(home, ".gemini", "tmp", "hash1", "chats", "chat-1.json"),
    JSON.stringify({ messages: [{ model: "gemini-2.5-pro", timestamp: recent, tokens: { input: 50, output: 3, cached: 10 } }] }),
  );
  const raw = write(
    path.join(state, "raw", "claude-sess-live.jsonl"),
    JSON.stringify({ type: "message", data: "hi", timestamp: NOW - DAY }) + "\n",
  );
  const rec: RunRecord = {
    runId: "run-1",
    agent: "claude",
    sessionId: "sess-live",
    startedAt: NOW - DAY,
    updatedAt: NOW - DAY + 1000,
    status: "success",
    exitStatus: "success",
    totals: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 },
    rawTranscript: raw,
    source: "local",
  };
  writeRunRecord(state, rec);
  return { home, state, claudeMain, claudeSub, claudeOld, codex, gemini, raw, rec };
}

describe("ach archive: warehouse snapshot (#79)", () => {
  it("copies every live transcript + registry record, manifest carries sourcePath, sha256, runId", async () => {
    const f = fixture();
    const res = await archiveTranscripts({ stateDir: f.state, scan: scanOptionsForRoot(f.home), now: () => NOW });
    assert.ok(res.batch, "a batch id is assigned when something was archived");
    assert.ok(res.batch!.startsWith(new Date(NOW).toISOString().slice(0, 10)), "batch id is date-led");
    assert.deepEqual(res.byKind, { native: 5, raw: 1, record: 1 });
    assert.equal(res.archived, 7);
    assert.equal(res.unchanged, 0);

    const lines = readManifest(warehouseDir(f.state));
    assert.equal(lines.length, 7);
    const wh = warehouseDir(f.state);
    for (const src of [f.claudeMain, f.claudeSub, f.claudeOld, f.codex, f.gemini, f.raw]) {
      const line = lines.find((l) => l.sourcePath === src);
      assert.ok(line, `manifest line for ${src}`);
      assert.equal(line!.sha256, sha256(src));
      const copy = path.join(wh, line!.archivePath);
      assert.equal(sha256(copy), line!.sha256, "archived bytes equal the source");
      // utimes carries microseconds at best, so compare at ms resolution.
      assert.equal(Math.floor(fs.statSync(copy).mtimeMs), Math.floor(fs.statSync(src).mtimeMs), "mtime preserved");
    }
    // runId links: the raw transcript + record belong to run-1; the native
    // claude session shares sessionId sess-live, so it is linked too.
    assert.equal(lines.find((l) => l.sourcePath === f.raw)!.runId, "run-1");
    assert.equal(lines.find((l) => l.kind === "record")!.runId, "run-1");
    assert.equal(lines.find((l) => l.sourcePath === f.claudeMain)!.runId, "run-1");
    assert.equal(lines.find((l) => l.sourcePath === f.claudeSub)!.sessionId, "sess-live");
    // A native transcript no harness run produced has no runId: null, not guessed.
    assert.equal(lines.find((l) => l.sourcePath === f.codex)!.runId, null);
    assert.equal(lines.find((l) => l.sourcePath === f.codex)!.sessionId, null);
    assert.equal(lines.find((l) => l.sourcePath === f.gemini)!.sessionId, "chat-1");
    // The per-batch manifest file exists on disk.
    assert.ok(fs.existsSync(path.join(wh, res.batch!, "manifest.jsonl")));
  });

  it("is idempotent: a second run archives nothing and adds no manifest lines", async () => {
    const f = fixture();
    await archiveTranscripts({ stateDir: f.state, scan: scanOptionsForRoot(f.home), now: () => NOW });
    const again = await archiveTranscripts({ stateDir: f.state, scan: scanOptionsForRoot(f.home), now: () => NOW + 1000 });
    assert.equal(again.batch, null);
    assert.equal(again.archived, 0);
    assert.equal(again.unchanged, 7);
    const lines = readManifest(warehouseDir(f.state));
    assert.equal(lines.length, 7);
    const keys = lines.map((l) => `${l.kind}|${l.agent}|${l.relPath}|${l.sha256}`);
    assert.equal(new Set(keys).size, keys.length, "no duplicate manifest lines");
    // Only one batch directory exists (no empty batch for the no-op run).
    const batches = fs.readdirSync(warehouseDir(f.state));
    assert.equal(batches.length, 1);
  });

  it("re-archives only a file whose content changed, never deletes the old copy", async () => {
    const f = fixture();
    const first = await archiveTranscripts({ stateDir: f.state, scan: scanOptionsForRoot(f.home), now: () => NOW });
    fs.appendFileSync(f.claudeMain, claudeLine("sess-live", "9", new Date(NOW).toISOString(), 99));
    // A touched-but-identical file is hashed and skipped (same sha256).
    fs.utimesSync(f.gemini, (NOW + 5000) / 1000, (NOW + 5000) / 1000);
    const second = await archiveTranscripts({ stateDir: f.state, scan: scanOptionsForRoot(f.home), now: () => NOW + 2000 });
    assert.notEqual(second.batch, first.batch);
    assert.equal(second.archived, 1);
    assert.equal(second.entries[0]!.sourcePath, f.claudeMain);
    const lines = readManifest(warehouseDir(f.state)).filter((l) => l.sourcePath === f.claudeMain);
    assert.equal(lines.length, 2);
    for (const l of lines) assert.ok(fs.existsSync(path.join(warehouseDir(f.state), l.archivePath)));
  });

  it("--agent claude --days 7 archives only that agent's transcripts inside the window", async () => {
    const f = fixture();
    const res = await archiveTranscripts({
      stateDir: f.state,
      scan: scanOptionsForRoot(f.home),
      agent: "claude",
      sinceMs: NOW - 7 * DAY,
      now: () => NOW,
    });
    const sources = res.entries.map((e) => e.sourcePath).sort();
    assert.deepEqual(sources, [f.claudeMain, f.claudeSub, f.raw, path.join(f.state, "runs", "run-1.json")].sort());
    assert.ok(res.entries.every((e) => e.agent === "claude"));
  });

  it("an --out warehouse dir is honoured", async () => {
    const f = fixture();
    const out = tmp("ach-wh-out-");
    const res = await archiveTranscripts({ stateDir: f.state, warehouseDir: out, scan: scanOptionsForRoot(f.home), now: () => NOW });
    assert.equal(res.warehouseDir, out);
    assert.equal(readManifest(out).length, 7);
    assert.equal(fs.existsSync(warehouseDir(f.state)), false);
  });
});

describe("warehouse fallback for raw transcripts (audit, web, MCP)", () => {
  it("resolveRawTranscript returns the archived copy when the live file is gone", async () => {
    const f = fixture();
    // Before any archive: missing file resolves to the stored path, unchanged.
    fs.renameSync(f.raw, f.raw + ".bak");
    assert.equal(resolveRawTranscript(f.state, f.rec), f.raw);
    assert.equal(findArchivedRaw(f.state, path.basename(f.raw)), null);
    fs.renameSync(f.raw + ".bak", f.raw);

    await archiveTranscripts({ stateDir: f.state, scan: scanOptionsForRoot(f.home), now: () => NOW });
    assert.equal(resolveRawTranscript(f.state, f.rec), f.raw, "live file still wins");
    fs.rmSync(f.raw);
    const resolved = resolveRawTranscript(f.state, f.rec);
    assert.ok(resolved.startsWith(warehouseDir(f.state) + path.sep), `archived path, got ${resolved}`);
    assert.equal(fs.readFileSync(resolved, "utf8").includes('"hi"'), true);
  });

  it("the newest archived copy wins", async () => {
    const f = fixture();
    await archiveTranscripts({ stateDir: f.state, scan: scanOptionsForRoot(f.home), now: () => NOW });
    fs.appendFileSync(f.raw, JSON.stringify({ type: "message", data: "second", timestamp: NOW }) + "\n");
    await archiveTranscripts({ stateDir: f.state, scan: scanOptionsForRoot(f.home), now: () => NOW + 1000 });
    fs.rmSync(f.raw);
    assert.match(fs.readFileSync(resolveRawTranscript(f.state, f.rec), "utf8"), /second/);
  });

  it("the web hub still opens a pruned run's transcript from the archive", async () => {
    const f = fixture();
    const hub = new RunEventHub(f.state);
    await archiveTranscripts({ stateDir: f.state, scan: scanOptionsForRoot(f.home), now: () => NOW });
    fs.rmSync(f.raw);
    const events = await hub.readTranscript("run-1");
    assert.equal(events.length, 1);
    assert.equal(events[0]!.data, "hi");
    // Control: no warehouse -> the pane is empty.
    const g = fixture();
    fs.rmSync(g.raw);
    assert.deepEqual(await new RunEventHub(g.state).readTranscript("run-1"), []);
  });

  it("ach audit re-derives from the archive copy after the live transcript is pruned", async () => {
    const f = fixture();
    await archiveTranscripts({ stateDir: f.state, scan: scanOptionsForRoot(f.home), now: () => NOW });
    fs.rmSync(f.raw);
    const res = auditRuns({ stateDir: f.state, now: () => NOW });
    const row = res.rows.find((r) => r.runId === "run-1")!;
    assert.notEqual(row.status, "unverifiable", JSON.stringify(row));
    // Control: a state dir with no warehouse reports the transcript missing.
    const g = fixture();
    fs.rmSync(g.raw);
    const ctl = auditRuns({ stateDir: g.state, now: () => NOW }).rows.find((r) => r.runId === "run-1")!;
    assert.equal(ctl.status, "unverifiable");
  });
});

describe("ach archive --restore", () => {
  it("rebuilds a home-shaped tree whose transcripts parse to the same records", async () => {
    const f = fixture();
    const res = await archiveTranscripts({ stateDir: f.state, scan: scanOptionsForRoot(f.home), now: () => NOW });
    const to = tmp("ach-wh-restore-");
    const r = await restoreBatch({ warehouseDir: warehouseDir(f.state), batch: res.batch!, to });
    assert.equal(r.restored, 7);
    assert.ok(fs.existsSync(path.join(to, ".claude", "projects", "-Users-me-proj", "sess-live", "subagents", "agent-a1.jsonl")));
    assert.ok(fs.existsSync(path.join(to, ".agentic-coding-harness", "runs", "run-1.json")));
    assert.ok(fs.existsSync(path.join(to, ".agentic-coding-harness", "raw", "claude-sess-live.jsonl")));

    const collect = async (root: string) => {
      const out: string[] = [];
      for await (const rec of scanAll(scanOptionsForRoot(root))) out.push(JSON.stringify(rec));
      return out.sort();
    };
    assert.deepEqual(await collect(to), await collect(f.home));
  });

  it("'all' restores the newest copy of every file across batches; an unknown batch is an error", async () => {
    const f = fixture();
    await archiveTranscripts({ stateDir: f.state, scan: scanOptionsForRoot(f.home), now: () => NOW });
    fs.appendFileSync(f.claudeMain, claudeLine("sess-live", "9", new Date(NOW).toISOString(), 99));
    await archiveTranscripts({ stateDir: f.state, scan: scanOptionsForRoot(f.home), now: () => NOW + 1000 });
    const to = tmp("ach-wh-restore-all-");
    const r = await restoreBatch({ warehouseDir: warehouseDir(f.state), batch: "all", to });
    assert.equal(r.restored, 7);
    assert.equal(
      fs.readFileSync(path.join(to, ".claude", "projects", "-Users-me-proj", "sess-live.jsonl"), "utf8"),
      fs.readFileSync(f.claudeMain, "utf8"),
    );
    await assert.rejects(restoreBatch({ warehouseDir: warehouseDir(f.state), batch: "nope", to }), /unknown batch/);
  });
});

describe("ach archive / ach stats --with-warehouse (CLI)", () => {
  it("archive --json twice, prune live transcripts, stats --with-warehouse still reports them", () => {
    const f = fixture();
    const env = { AGENTIC_CODING_HARNESS_STATE_DIR: f.state, HOME: f.home };
    const before = runCli(["stats", "--json"], env);
    assert.equal(before.code, 0, before.stderr);
    const totalsBefore = JSON.parse(before.stdout).total;

    const a1 = runCli(["archive", "--json"], env);
    assert.equal(a1.code, 0, a1.stderr);
    const j1 = JSON.parse(a1.stdout);
    assert.equal(j1.archived, 7);
    assert.ok(typeof j1.batch === "string");
    const a2 = runCli(["archive", "--json"], env);
    assert.equal(JSON.parse(a2.stdout).archived, 0);
    assert.equal(JSON.parse(a2.stdout).batch, null);
    const text = runCli(["archive"], env);
    assert.match(text.stdout, /archived 0 files/);

    // Claude Code's cleanup: every machine transcript and the raw file vanish.
    fs.rmSync(path.join(f.home, ".claude"), { recursive: true });
    fs.rmSync(path.join(f.home, ".codex"), { recursive: true });
    fs.rmSync(path.join(f.home, ".gemini"), { recursive: true });

    const pruned = JSON.parse(runCli(["stats", "--json"], env).stdout).total;
    assert.ok(pruned.records < totalsBefore.records, "control: live-only stats lost the pruned runs");
    const withWh = runCli(["stats", "--json", "--with-warehouse"], env);
    assert.equal(withWh.code, 0, withWh.stderr);
    assert.deepEqual(JSON.parse(withWh.stdout).total, totalsBefore);
  });

  it("--with-warehouse does not double count while the live files still exist", () => {
    const f = fixture();
    const env = { AGENTIC_CODING_HARNESS_STATE_DIR: f.state, HOME: f.home };
    runCli(["archive"], env);
    fs.appendFileSync(f.claudeMain, claudeLine("sess-live", "9", new Date(NOW).toISOString(), 99));
    const live = JSON.parse(runCli(["stats", "--json"], env).stdout).total;
    const both = JSON.parse(runCli(["stats", "--json", "--with-warehouse"], env).stdout).total;
    assert.deepEqual(both, live);
  });

  it("stats --dir reads a restored tree with no other flags", async () => {
    const f = fixture();
    const env = { AGENTIC_CODING_HARNESS_STATE_DIR: f.state, HOME: f.home };
    const totalsLive = JSON.parse(runCli(["stats", "--json"], env).stdout).total;
    const j = JSON.parse(runCli(["archive", "--json"], env).stdout);
    const to = tmp("ach-wh-cli-restore-");
    const r = runCli(["archive", "--restore", j.batch, "--to", to, "--json"], env);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).restored, 7);
    // Fresh empty HOME/state so only the restored tree can contribute.
    const empty = { AGENTIC_CODING_HARNESS_STATE_DIR: path.join(to, ".agentic-coding-harness"), HOME: tmp("ach-wh-empty-") };
    const s = runCli(["stats", "--json", "--dir", to], empty);
    assert.equal(s.code, 0, s.stderr);
    assert.deepEqual(JSON.parse(s.stdout).total, totalsLive);
  });

  it("rejects an unknown agent and a bad --days", () => {
    const f = fixture();
    const env = { AGENTIC_CODING_HARNESS_STATE_DIR: f.state, HOME: f.home };
    assert.notEqual(runCli(["archive", "--agent", "nope"], env).code, 0);
    assert.notEqual(runCli(["archive", "--days", "abc"], env).code, 0);
  });
});
