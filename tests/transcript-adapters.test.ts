// Read-only transcript adapters for CLIs ach does not launch (#22):
// Amp, Goose, Qwen Code. Fixture provenance: docs/transcript-adapters.md
// ("Fixtures"). All fixtures are synthetic; no real user transcript was used.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";

import { parseAmpThread } from "../src/monitors/amp.ts";
import { parseGooseDb } from "../src/monitors/goose.ts";
import { parseQwenChat } from "../src/monitors/qwen.ts";
import {
  TRANSCRIPT_SOURCES,
  isTranscriptOnlyAgent,
} from "../src/monitors/transcript-sources.ts";
import { drainTranscriptWarnings } from "../src/monitors/transcript-warnings.ts";
import { scanAll, type CanonicalTokenRecord } from "../src/monitors/transcripts.ts";

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

const hasSqlite3 = spawnSync("sqlite3", ["-version"], { stdio: "ignore" }).status === 0;

function collect(): { warn: (m: string) => void; warnings: string[] } {
  const warnings: string[] = [];
  return { warn: (m) => warnings.push(m), warnings };
}

describe("parseAmpThread", () => {
  it("reads usageLedger events and joins cache tokens from the toMessageId message", async () => {
    const { warn, warnings } = collect();
    const records = await parseAmpThread(path.join(fixtures, "amp", "threads", "T-demo-ledger.json"), warn);
    const expected: CanonicalTokenRecord[] = [
      {
        agent: "amp",
        sessionId: "T-demo-ledger",
        timestamp: "2026-09-20T10:00:05.000Z",
        model: "claude-sonnet-4-5",
        input: 12,
        output: 340,
        cacheRead: 9000,
        cacheWrite: 1500,
        reasoning: 0,
      },
    ];
    assert.deepStrictEqual(records, expected);
    assert.deepStrictEqual(warnings, []);
  });

  it("falls back to assistant message usage when there is no ledger", async () => {
    const records = await parseAmpThread(path.join(fixtures, "amp", "threads", "T-demo-messages.json"), () => {});
    assert.deepStrictEqual(records, [
      {
        agent: "amp",
        sessionId: "T-demo-messages",
        timestamp: "2026-01-19T11:42:10.652Z",
        model: "claude-haiku-4-5-20251001",
        input: 10,
        output: 178,
        cacheRead: 11372,
        cacheWrite: 986,
        reasoning: 0,
      },
      {
        agent: "amp",
        sessionId: "T-demo-messages",
        timestamp: "2026-01-19T11:43:00.000Z",
        model: "claude-haiku-4-5-20251001",
        input: 5,
        output: 42,
        cacheRead: 12000,
        cacheWrite: 0,
        reasoning: 0,
      },
    ]);
  });

  it("malformed thread: skips bad entries with a warning, keeps the good record", async () => {
    const { warn, warnings } = collect();
    const records = await parseAmpThread(path.join(fixtures, "amp-malformed", "threads", "T-malformed.json"), warn);
    assert.equal(records.length, 1);
    assert.equal(records[0]?.input, 10);
    assert.equal(records[0]?.output, 178);
    // "garbage" message entry + the totalTokens-only message (split unknown).
    assert.equal(warnings.length, 2, warnings.join("\n"));
    assert.ok(warnings.some((w) => /totalTokens/.test(w)));
  });

  it("truncated JSON file: returns [] and warns, never throws", async () => {
    const { warn, warnings } = collect();
    const records = await parseAmpThread(path.join(fixtures, "amp-malformed", "threads", "T-truncated.json"), warn);
    assert.deepStrictEqual(records, []);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /amp/);
  });
});

describe("parseQwenChat", () => {
  it("maps usageMetadata: cached is a subset of prompt; thoughts added only when totalTokenCount says so", async () => {
    const { warn, warnings } = collect();
    const records = await parseQwenChat(
      path.join(fixtures, "qwen", "projects", "demo-project", "chats", "sess-qwen-1.jsonl"),
      warn,
    );
    const expected: CanonicalTokenRecord[] = [
      {
        // Gemini-native shape: total 1400 = prompt 1200 + candidates 150 + thoughts 50,
        // so thoughts are additive and folded into output.
        agent: "qwen",
        sessionId: "sess-qwen-1",
        timestamp: "2026-09-21T09:00:04.000Z",
        model: "gemini-2.5-pro",
        input: 400,
        output: 200,
        cacheRead: 800,
        cacheWrite: 0,
        reasoning: 50,
      },
      {
        // OpenAI-converted shape: total 2300 = prompt 2000 + candidates 300,
        // so thoughts (100) are already inside candidates.
        agent: "qwen",
        sessionId: "sess-qwen-1",
        timestamp: "2026-09-21T09:00:09.000Z",
        model: "qwen3-coder-plus",
        input: 500,
        output: 300,
        cacheRead: 1500,
        cacheWrite: 0,
        reasoning: 100,
      },
    ];
    assert.deepStrictEqual(records, expected);
    assert.deepStrictEqual(warnings, []);
  });

  it("malformed chat: bad JSON line and total-only usage are skipped with warnings", async () => {
    const { warn, warnings } = collect();
    const records = await parseQwenChat(
      path.join(fixtures, "qwen-malformed", "projects", "demo-project", "chats", "sess-qwen-bad.jsonl"),
      warn,
    );
    assert.deepStrictEqual(records, [
      {
        agent: "qwen",
        sessionId: "sess-qwen-bad", // no sessionId on the line: file stem
        timestamp: "2026-09-22T08:00:03.000Z",
        model: null, // no model on the line: unknown, never guessed
        input: 100,
        output: 20,
        cacheRead: 0,
        cacheWrite: 0,
        reasoning: 0,
      },
    ]);
    assert.equal(warnings.length, 2, warnings.join("\n"));
    assert.ok(warnings.some((w) => /line 1/.test(w)));
    assert.ok(warnings.some((w) => /totalTokenCount/.test(w)));
  });
});

describe("parseGooseDb", { skip: hasSqlite3 ? false : "sqlite3 CLI not on PATH" }, () => {
  let tmp: string;
  const build = async (sqlFile: string): Promise<string> => {
    const dir = path.join(tmp, path.basename(sqlFile, ".sql"), "sessions");
    await fs.mkdir(dir, { recursive: true });
    const db = path.join(dir, "sessions.db");
    execFileSync("sqlite3", [db], { input: await fs.readFile(path.join(fixtures, "goose", sqlFile), "utf8") });
    return db;
  };

  before(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ach-goose-"));
  });
  after(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it("current schema: one record per usage_ledger row; input is cache-inclusive in Goose, so cache is subtracted", async () => {
    const { warn, warnings } = collect();
    const records = await parseGooseDb(await build("sessions-ledger.sql"), warn);
    assert.deepStrictEqual(records, [
      {
        agent: "goose",
        sessionId: "20260923_1",
        timestamp: "2026-09-23T14:00:05.000Z",
        model: "claude-sonnet-4-5",
        input: 500,
        output: 400,
        cacheRead: 8000,
        cacheWrite: 1500,
        reasoning: 0,
      },
      {
        // carried_forward row: Goose records no model for it; stays null.
        agent: "goose",
        sessionId: "20260923_1",
        timestamp: "2026-09-23T14:10:00.000Z",
        model: null,
        input: 300,
        output: 50,
        cacheRead: 0,
        cacheWrite: 0,
        reasoning: 0,
      },
    ]);
    assert.deepStrictEqual(warnings, []);
  });

  it("legacy schema (no usage_ledger): one record per session from accumulated_* totals", async () => {
    const { warn, warnings } = collect();
    const records = await parseGooseDb(await build("sessions-legacy.sql"), warn);
    assert.deepStrictEqual(records, [
      {
        agent: "goose",
        sessionId: "20250501_1",
        timestamp: "2025-05-01T01:02:03.000Z",
        model: "gpt-4o",
        input: 5000,
        output: 1000,
        cacheRead: 0,
        cacheWrite: 0,
        reasoning: 0,
      },
      {
        agent: "goose",
        sessionId: "20250501_4",
        timestamp: "2025-05-01T04:00:00.000Z",
        model: null,
        input: 10,
        output: 5,
        cacheRead: 0,
        cacheWrite: 0,
        reasoning: 0,
      },
    ]);
    // _2 has no accumulated totals (skipped + warned); _4 has unparseable
    // model_config_json (kept, model null, warned); _3 is all-zero (silent).
    assert.equal(warnings.length, 2, warnings.join("\n"));
    assert.ok(warnings.some((w) => /20250501_2/.test(w)));
    assert.ok(warnings.some((w) => /20250501_4/.test(w)));
  });

  it("malformed: a file that is not a SQLite database returns [] and warns, never throws", async () => {
    const dir = path.join(tmp, "garbage", "sessions");
    await fs.mkdir(dir, { recursive: true });
    const db = path.join(dir, "sessions.db");
    await fs.writeFile(db, "this is not a sqlite database\n");
    const { warn, warnings } = collect();
    assert.deepStrictEqual(await parseGooseDb(db, warn), []);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /goose/);
  });
});

describe("transcript source registry", () => {
  it("lists amp, goose and qwen as read-only transcript sources", () => {
    assert.deepStrictEqual(
      TRANSCRIPT_SOURCES.map((s) => s.agent),
      ["cursor", "amp", "goose", "qwen"],
    );
    assert.ok(isTranscriptOnlyAgent("amp"));
    assert.ok(isTranscriptOnlyAgent("goose"));
    assert.ok(isTranscriptOnlyAgent("qwen"));
    assert.ok(!isTranscriptOnlyAgent("claude"));
    assert.ok(isTranscriptOnlyAgent("cursor"));
  });

  it("default roots are per-OS paths under the given home", () => {
    const home = "/home/u";
    const byAgent = Object.fromEntries(TRANSCRIPT_SOURCES.map((s) => [s.agent, s.defaultRoots(home)]));
    assert.deepStrictEqual(byAgent.amp, ["/home/u/.local/share/amp/threads"]);
    assert.deepStrictEqual(byAgent.qwen, ["/home/u/.qwen/projects"]);
    assert.deepStrictEqual(byAgent.goose, [
      "/home/u/.local/share/goose/sessions",
      "/home/u/Library/Application Support/goose/sessions",
      "/home/u/.local/share/Block/goose/sessions",
    ]);
  });

  it("scanAll yields amp + qwen records from explicit roots and drains warnings for malformed files", async () => {
    drainTranscriptWarnings();
    const records: CanonicalTokenRecord[] = [];
    for await (const r of scanAll({
      claudeDir: path.join(fixtures, "does-not-exist"),
      codexDir: path.join(fixtures, "does-not-exist"),
      geminiDir: path.join(fixtures, "does-not-exist"),
      primeDir: path.join(fixtures, "does-not-exist"),
      sourceRoots: {
        amp: [path.join(fixtures, "amp", "threads"), path.join(fixtures, "amp-malformed", "threads")],
        goose: [],
        qwen: [path.join(fixtures, "qwen", "projects")],
      },
    })) {
      records.push(r);
    }
    const count = (a: string) => records.filter((r) => r.agent === a).length;
    assert.equal(count("amp"), 4); // ledger 1 + messages 2 + malformed 1
    assert.equal(count("qwen"), 2);
    const warnings = drainTranscriptWarnings();
    assert.equal(warnings.length, 3, warnings.join("\n")); // 2 in T-malformed + 1 truncated
  });
});

// ---------------------------------------------------------------- CLI

const CLI = new URL("../src/cli/ach.ts", import.meta.url).pathname;

function runCli(args: string[], env: Record<string, string>) {
  const isBun = (process.versions as { bun?: string }).bun !== undefined;
  const p = spawnSync(process.execPath, isBun ? [CLI, ...args] : ["--import", "tsx", CLI, ...args], {
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
  return { code: p.status ?? -1, stdout: p.stdout ?? "", stderr: p.stderr ?? "" };
}

describe("ach CLI with read-only transcript sources", () => {
  let home: string;
  let state: string;
  before(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), "ach-home-"));
    state = await fs.mkdtemp(path.join(os.tmpdir(), "ach-state-"));
    const threads = path.join(home, ".local", "share", "amp", "threads");
    await fs.mkdir(threads, { recursive: true });
    await fs.copyFile(path.join(fixtures, "amp", "threads", "T-demo-ledger.json"), path.join(threads, "T-demo-ledger.json"));
    await fs.copyFile(
      path.join(fixtures, "amp-malformed", "threads", "T-truncated.json"),
      path.join(threads, "T-truncated.json"),
    );
  });
  after(async () => {
    await fs.rm(home, { recursive: true, force: true });
    await fs.rm(state, { recursive: true, force: true });
  });
  const env = () => ({ HOME: home, AGENTIC_CODING_HARNESS_STATE_DIR: state });

  it("stats --agent amp reads ~/.local/share/amp/threads and warns (not crashes) on a truncated file", () => {
    const r = runCli(["stats", "--json", "--agent", "amp"], env());
    assert.equal(r.code, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.deepStrictEqual(Object.keys(out.byAgent), ["amp"]);
    assert.equal(out.total.records, 1);
    assert.equal(out.total.inputTokens, 12);
    assert.equal(out.total.cacheReadTokens, 9000);
    assert.equal(out.total.cacheWriteTokens, 1500);
    assert.match(r.stderr, /\[warn\] amp: .*T-truncated\.json/);
  });

  it("run --agent amp fails with a read-only-source error, not 'unknown agent'", () => {
    const r = runCli(["run", "--agent", "amp", "hello"], env());
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /read-only transcript source/);
    assert.match(r.stderr, /ach stats --agent amp/);
    assert.doesNotMatch(r.stderr, /unknown agent/);
  });
});
