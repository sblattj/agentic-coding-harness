import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { after, before, describe, test } from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { formatSummary } from "../src/cli/lib.ts";

const CLI = new URL("../src/cli/ach.ts", import.meta.url).pathname;

interface RunOut {
  code: number;
  stdout: string;
  stderr: string;
}

function runCli(args: string[], env: Record<string, string>): RunOut {
  // bun runs .ts natively; node needs the tsx loader.
  const isBun = (process.versions as { bun?: string }).bun !== undefined;
  const p = spawnSync(process.execPath, isBun ? [CLI, ...args] : ["--import", "tsx", CLI, ...args], {
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
  return {
    code: p.status ?? -1,
    stdout: p.stdout ?? "",
    stderr: p.stderr ?? "",
  };
}

describe("harness cli", () => {
  test("--version prints the package version and exits 0", () => {
    const r = runCli(["--version"], {});
    assert.equal(r.code, 0, `stderr: ${r.stderr}`);
    assert.match(r.stdout.trim(), /^\d+\.\d+\.\d+$/);
  });

  let stateDir: string;
  let home: string;
  let tmpExtra: string;

  before(async () => {
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "harness-state-"));
    home = await fs.mkdtemp(path.join(os.tmpdir(), "harness-home-"));
    tmpExtra = await fs.mkdtemp(path.join(os.tmpdir(), "harness-tmp-"));

    const now = new Date();
    const recent = new Date(now.getTime() - 2 * 86_400_000).toISOString();
    const old = new Date(now.getTime() - 40 * 86_400_000).toISOString();

    // stateDir/raw: canonical records written by watch/harness runs.
    const a = path.join(stateDir, "raw", "claude", "sess-a.jsonl");
    const b = path.join(stateDir, "raw", "codex", "sess-b.jsonl");
    const dup = path.join(stateDir, "raw", "claude", "sess-aaa.jsonl");
    await fs.mkdir(path.join(stateDir, "raw", "claude"), { recursive: true });
    await fs.mkdir(path.join(stateDir, "raw", "codex"), { recursive: true });
    await fs.writeFile(
      a,
      [
        JSON.stringify({
          ts: recent,
          agent: "claude",
          sessionId: "sess-a",
          model: "claude-sonnet-4-5",
          inputTokens: 100,
          outputTokens: 50,
          cacheReadTokens: 10,
          cacheWriteTokens: 5,
          reasoningTokens: 0,
          costUsd: 0.01,
        }),
        JSON.stringify({
          ts: recent,
          agent: "claude",
          sessionId: "sess-a",
          model: "claude-sonnet-4-5",
          inputTokens: 200,
          outputTokens: 25,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          reasoningTokens: 3,
          costUsd: 0.02,
        }),
        "", // trailing newline tolerance
      ].join("\n"),
    );
    await fs.writeFile(
      b,
      JSON.stringify({
        ts: old,
        agent: "codex",
        sessionId: "sess-b",
        inputTokens: 5,
        outputTokens: 1,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        costUsd: 0,
      }) + "\n",
    );
    // Same logical record as the machine transcript below, but stored in
    // stateDir (legacy watch backfill): stats must count it exactly once.
    await fs.writeFile(
      dup,
      JSON.stringify({
        ts: recent,
        agent: "claude",
        sessionId: "sess-aaa",
        model: "claude-sonnet-4-5",
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: 2,
        cacheWriteTokens: 1,
        reasoningTokens: 1,
        costUsd: 0.000109,
      }) + "\n",
    );

    // Fake HOME with one Claude Code transcript for the scanAll path
    // (~/.claude/projects/<dir>/<session>.jsonl, assistant usage lines).
    const claudeDir = path.join(home, ".claude", "projects", "proj-1");
    await fs.mkdir(claudeDir, { recursive: true });
    await fs.writeFile(
      path.join(claudeDir, "sess-aaa.jsonl"),
      JSON.stringify({
        type: "assistant",
        timestamp: recent,
        sessionId: "sess-aaa",
        requestId: "req-1",
        message: {
          id: "msg_1",
          model: "claude-sonnet-4-5",
          timestamp: recent,
          usage: {
            input_tokens: 10,
            output_tokens: 5,
            cache_read_input_tokens: 2,
            cache_creation_input_tokens: 1,
            output_tokens_details: { thinking_tokens: 1 },
          },
        },
      }) + "\n",
    );
  });

  after(async () => {
    await fs.rm(stateDir, { recursive: true, force: true });
    await fs.rm(home, { recursive: true, force: true });
    await fs.rm(tmpExtra, { recursive: true, force: true });
  });

  // HOME is overridden so scanAll sees only the fake machine transcripts and
  // the opencode store lookup finds nothing.
  const env = () => ({ AGENTIC_CODING_HARNESS_STATE_DIR: stateDir, HOME: home });

  test("stats --json merges scanAll + stateDir, dedupes, and uses {total, byAgent, byDay}", () => {
    const r = runCli(["stats", "--json"], env());
    assert.equal(r.code, 0);
    assert.doesNotMatch(r.stderr, /harness:/);
    const out = JSON.parse(r.stdout);
    assert.deepEqual(Object.keys(out).sort(), ["byAgent", "byDay", "total"]);
    // 3 stateDir records + 1 scanAll record, with the sess-aaa duplicate
    // counted once (dedupe).
    assert.deepEqual(out.total, {
      records: 4,
      inputTokens: 315,
      outputTokens: 81,
      cacheReadTokens: 12,
      cacheWriteTokens: 6,
      reasoningTokens: 4,
      costUsd: 0.030109,
    });
    assert.equal(out.byAgent.claude.records, 3);
    assert.equal(out.byAgent.claude.inputTokens, 310);
    assert.equal(out.byAgent.codex.records, 1);
    assert.equal(Object.keys(out.byDay).length, 2); // recent day + old day
  });

  test("stats --days filters by window", () => {
    const r = runCli(["stats", "--json", "--days", "7"], env());
    assert.equal(r.code, 0);
    const out = JSON.parse(r.stdout);
    assert.equal(out.total.records, 3); // 2 sess-a + scanAll sess-aaa; old codex dropped
    assert.equal(out.total.inputTokens, 310);
    assert.equal(out.byAgent.codex, undefined);
  });

  test("stats --agent filters by agent", () => {
    const r = runCli(["stats", "--json", "--agent", "codex"], env());
    assert.equal(r.code, 0);
    const out = JSON.parse(r.stdout);
    assert.deepEqual(Object.keys(out.byAgent), ["codex"]);
    assert.deepEqual(out.total, {
      records: 1,
      inputTokens: 5,
      outputTokens: 1,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      costUsd: 0,
    });
  });

  test("stats --state-only skips machine transcripts and returns only stateDir records", () => {
    const r = runCli(["stats", "--json", "--state-only"], env());
    assert.equal(r.code, 0);
    assert.doesNotMatch(r.stderr, /harness:/);
    const out = JSON.parse(r.stdout);
    // The 4 seeded stateDir records (sess-a ×2, old codex sess-b, dup
    // sess-aaa); the fake-HOME claude transcript that the full scan would
    // add is NOT present, so no dedupe against it either.
    assert.deepEqual(out.total, {
      records: 4,
      inputTokens: 315,
      outputTokens: 81,
      cacheReadTokens: 12,
      cacheWriteTokens: 6,
      reasoningTokens: 4,
      costUsd: 0.030109,
    });
    assert.equal(out.byAgent.claude.records, 3);
    assert.equal(out.byAgent.claude.inputTokens, 310);
    assert.equal(out.byAgent.codex.records, 1);
  });

  test("run --agent nonexistent exits 1 with a clean message", () => {
    const r = runCli(["run", "--agent", "nonexistent", "hello"], env());
    assert.equal(r.code, 1);
    assert.ok(r.stderr.includes("unknown agent 'nonexistent'"), r.stderr);
    assert.ok(r.stderr.includes("claude, opencode, kiro, codex, gemini"), r.stderr);
    assert.doesNotMatch(r.stderr, /\n\s+at /); // no stack trace
    assert.equal(r.stdout, "");
  });

  test("run --agent kiro auto-taps credits via the MITM proxy and prints the credits summary", async () => {
    const meteringLine = JSON.stringify({
      event: "meteringEvent",
      tokenUsage: {
        uncachedInputTokens: 1200,
        cacheReadInputTokens: 3400,
        cacheWriteInputTokens: 500,
        outputTokens: 210,
        totalTokens: 5310,
      },
      credits: 0.05,
      ts: 1_700_000_000,
    });
    // The fakes hand-shake through a per-port ready marker (see
    // tests/kiro-autotap.test.ts): the run must not finish before the "proxy"
    // has printed its record, which is what real traffic guarantees.
    const fakeMitmdump = path.join(tmpExtra, "fake-mitmdump.sh");
    await fs.writeFile(
      fakeMitmdump,
      `#!/bin/sh\nport="$2"\necho '${meteringLine}'\ntouch "${tmpExtra}/ready.$port"\nsleep 30 &\nchild=$!\ntrap 'rm -f "${tmpExtra}/ready.$port"; kill "$child" 2>/dev/null; exit 0' TERM INT\nwait $!\n`,
    );
    await fs.chmod(fakeMitmdump, 0o755);
    const fakeKiroCli = path.join(tmpExtra, "fake-kiro-cli.sh");
    await fs.writeFile(
      fakeKiroCli,
      `#!/bin/sh\nif [ "$1" = "--version" ]; then echo 'kiro-cli 2.21.2'; exit 0; fi\nport="\${HTTPS_PROXY##*:}"\ni=0\nwhile [ ! -f "${tmpExtra}/ready.$port" ] && [ "$i" -lt 300 ]; do sleep 0.01; i=$((i+1)); done\necho '{"type":"session_start","sessionId":"sess-cli-tap"}'\necho '{"type":"assistant","text":"done"}'\nexit 0\n`,
    );
    await fs.chmod(fakeKiroCli, 0o755);

    const r = runCli(["run", "--agent", "kiro", "hello tap"], {
      ...env(),
      KIRO_CLI_BIN: fakeKiroCli,
      MITMDUMP_BIN: fakeMitmdump,
    });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /^exit       success$/m);
    assert.match(r.stdout, /^credits    0\.05$/m);
  });

  test("run rejects a non-numeric --wall-ms cleanly before launching any agent", () => {
    const r = runCli(["run", "--agent", "claude", "--wall-ms", "abc", "hi"], env());
    assert.equal(r.code, 1);
    assert.ok(r.stderr.includes("--wall-ms expects a non-negative number"), r.stderr);
    assert.doesNotMatch(r.stderr, /\n\s+at /);
    assert.equal(r.stdout, "");
  });

  test("run honors AGENTIC_CODING_HARNESS_* env defaults and CLI flags win over them", async () => {
    // Bad env default surfaces a clean usage error naming the env var...
    let r = runCli(["run", "--agent", "claude", "hi"], { ...env(), AGENTIC_CODING_HARNESS_IDLE_MS: "abc" });
    assert.equal(r.code, 1);
    assert.ok(r.stderr.includes("AGENTIC_CODING_HARNESS_IDLE_MS expects a non-negative number"), r.stderr);
    assert.doesNotMatch(r.stderr, /\n\s+at /);

    // ...and a valid flag suppresses the invalid env default entirely: the
    // run proceeds (fake kiro CLI, tap off) and completes instead of
    // erroring on AGENTIC_CODING_HARNESS_MAX_TURNS=abc.
    const fakeKiroCli = path.join(tmpExtra, "fake-kiro-env-flag.sh");
    await fs.writeFile(
      fakeKiroCli,
      `#!/bin/sh\necho '{"type":"session_start","sessionId":"sess-env-flag"}'\necho '{"type":"assistant","text":"done"}'\nexit 0\n`,
    );
    await fs.chmod(fakeKiroCli, 0o755);
    r = runCli(["run", "--agent", "kiro", "--max-turns", "5", "--wall-ms", "60000", "hi"], {
      ...env(),
      KIRO_CLI_BIN: fakeKiroCli,
      MITMDUMP_BIN: "/nonexistent/mitmdump", // deterministic tap-off degrade
      AGENTIC_CODING_HARNESS_MAX_TURNS: "abc", // would fail if the flag did not win
    });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /^exit       success$/m);
  });

  test("run --agent kiro forwards --kiro-startup-ms/--kiro-require-model-ack/--kiro-mcp-server into result.kiro.requested", async () => {
    const fakeKiroCli = path.join(tmpExtra, "fake-kiro-flags.sh");
    await fs.writeFile(
      fakeKiroCli,
      `#!/bin/sh\necho '{"type":"session_start","sessionId":"sess-flags"}'\necho '{"type":"assistant","text":"done"}'\nexit 0\n`,
    );
    await fs.chmod(fakeKiroCli, 0o755);
    const r = runCli(
      [
        "run",
        "--agent",
        "kiro",
        "--kiro-startup-ms",
        "1234",
        "--kiro-require-model-ack",
        "--kiro-mcp-server",
        '{"name":"a","command":"echo"}',
        "--kiro-mcp-server",
        '{"name":"b","command":"cat","args":["-"]}',
        "--json",
        "hi",
      ],
      { ...env(), KIRO_CLI_BIN: fakeKiroCli, MITMDUMP_BIN: "/nonexistent/mitmdump" },
    );
    assert.equal(r.code, 0, r.stderr);
    const parsed = JSON.parse(r.stdout);
    assert.deepEqual(parsed.kiro.requested, {
      startupMs: 1234,
      requireModelAck: true,
      mcpServers: [
        { name: "a", command: "echo" },
        { name: "b", command: "cat", args: ["-"] },
      ],
    });
  });

  test("run rejects a non-integer --kiro-startup-ms cleanly before launching any agent", () => {
    const r = runCli(["run", "--agent", "kiro", "--kiro-startup-ms", "abc", "hi"], env());
    assert.equal(r.code, 1);
    assert.ok(r.stderr.includes("invalid --kiro-* flags") || r.stderr.includes("--kiro-startup-ms"), r.stderr);
    assert.doesNotMatch(r.stderr, /\n\s+at /);
    assert.equal(r.stdout, "");
  });

  test("run rejects invalid JSON for --kiro-mcp-server, naming the flag and the value", () => {
    const r = runCli(["run", "--agent", "kiro", "--kiro-mcp-server", "not json", "hi"], env());
    assert.equal(r.code, 1);
    assert.ok(r.stderr.includes("--kiro-mcp-server"), r.stderr);
    assert.ok(r.stderr.includes("not json"), r.stderr);
    assert.doesNotMatch(r.stderr, /\n\s+at /);
    assert.equal(r.stdout, "");
  });

  test("emit produces ATIF and OTel documents from an event stream", async () => {
    const eventsFile = path.join(tmpExtra, "events.json");
    await fs.writeFile(
      eventsFile,
      JSON.stringify({
        events: [
          { type: "message", source: "user", content: "hi", timestamp: "2026-09-09T00:00:00Z" },
          {
            type: "tool_call",
            toolCallId: "c1",
            functionName: "Bash",
            arguments: {},
            timestamp: "2026-09-09T00:00:01Z",
          },
        ],
      }),
    );
    const atifOut = path.join(tmpExtra, "trajectory.json");
    let r = runCli(["emit", "--input", eventsFile, "--format", "atif", "--out", atifOut], env());
    assert.equal(r.code, 0, r.stderr);
    const atif = JSON.parse(await fs.readFile(atifOut, "utf8"));
    assert.equal(atif.schema_version, "ATIF-v1.7");
    assert.equal(atif.steps.length, 2);
    assert.equal(atif.steps[1].tool_calls[0].function_name, "Bash");

    await fs.writeFile(
      eventsFile,
      JSON.stringify({
        events: [
          { type: "usage", usage: { promptTokens: 10, completionTokens: 5, cachedTokens: 2 }, timestamp: 1_000 },
          { type: "tool_call", toolCallId: "c1", functionName: "Bash", timestamp: 2_000 },
        ],
      }),
    );
    const otelOut = path.join(tmpExtra, "spans.json");
    r = runCli(["emit", "--input", eventsFile, "--format", "otel", "--out", otelOut], env());
    assert.equal(r.code, 0, r.stderr);
    const otel = JSON.parse(await fs.readFile(otelOut, "utf8"));
    assert.equal(otel.resourceSpans.length, 1);
    const spans = otel.resourceSpans[0].scopeSpans[0].spans;
    assert.equal(spans.length, 3); // root invoke_agent + chat + execute_tool
    assert.equal(spans[2].name, "execute_tool Bash");
    assert.match(spans[0].traceId, /^[0-9a-f]{32}$/);
    assert.ok(
      spans[1].attributes.some((a: { key: string }) => a.key === "gen_ai.usage.input_tokens"),
    );
  });

  test("emit rejects a bad format and a missing input file cleanly", () => {
    let r = runCli(["emit", "--input", "/nope.json", "--format", "atif"], env());
    assert.equal(r.code, 1);
    assert.ok(r.stderr.includes("harness:"), r.stderr);
    assert.doesNotMatch(r.stderr, /\n\s+at /);
    r = runCli(["emit", "--input", "/nope.json", "--format", "bogus"], env());
    assert.equal(r.code, 1);
    assert.ok(r.stderr.includes("--format"), r.stderr);
  });
});

// ---------------------------------------------------------------------------
// `harness run` summary — truthful usage lines (pure formatSummary, no spawn).
// ---------------------------------------------------------------------------

describe("run summary — truthful usage", () => {
  const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 };

  test("prints n/a for tokens and cost, plus a derived context line, for a credits-only run", () => {
    const summary = formatSummary({
      agent: "kiro",
      sessionId: "kiro-abc",
      tokens,
      costUsd: 0,
      durationMs: 1000,
      exitStatus: "success",
      usage: {
        tokens: { available: false },
        credits: { available: true, value: 0.0247448 },
        usd: { available: false },
        context: {
          available: true,
          source: "derived",
          percentage: 5.0080004,
          windowTokens: 200000,
          windowSource: "session-store",
          tokens: 10016,
        },
      },
    });
    assert.match(summary, /tokens {5}input=n\/a output=n\/a cacheRead=n\/a cacheWrite=n\/a reasoning=n\/a/);
    assert.match(summary, /cost {7}n\/a/);
    assert.ok(!summary.includes("$0.0000"), summary);
    assert.match(summary, /context {4}ctx ~= 10,016 tok \(5\.0%\)/);
    assert.ok(!summary.includes("assumed window"), summary);
  });

  test("labels an assumed context window as assumed", () => {
    const summary = formatSummary({
      agent: "kiro",
      sessionId: "s",
      tokens,
      costUsd: 0,
      durationMs: 1,
      exitStatus: "success",
      usage: {
        tokens: { available: false },
        credits: { available: false },
        usd: { available: false },
        context: {
          available: true,
          source: "derived",
          percentage: 10,
          windowTokens: 200000,
          windowSource: "assumed",
          tokens: 20000,
        },
      },
    });
    assert.match(summary, /context {4}ctx ~= 20,000 tok \(10\.0%\) \(assumed window\)/);
  });

  test("a summary WITHOUT a usage block renders exactly as before (no context line)", () => {
    const summary = formatSummary({
      agent: "claude",
      sessionId: "s",
      tokens: { input: 100, output: 20, cacheRead: 1, cacheWrite: 2, reasoning: 3 },
      costUsd: 0.25,
      durationMs: 2000,
      exitStatus: "success",
    });
    assert.match(summary, /tokens {5}input=100 output=20 cacheRead=1 cacheWrite=2 reasoning=3/);
    assert.match(summary, /cost {7}\$0\.2500/);
    assert.ok(!summary.includes("n/a"), summary);
    assert.ok(!summary.includes("context"), summary);
  });
});
