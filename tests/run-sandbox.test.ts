// #13: `ach run` sandbox flags → SandboxPolicy → adapter args, dropped-field
// warnings, and the metrics-only --evidence-dir sidecar.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, test } from "node:test";

import { claudeSandboxArgs } from "../src/adapters/claude.ts";
import { codexSandboxArgs } from "../src/adapters/codex.ts";
import {
  buildRunMetrics,
  describeSandbox,
  formatSandboxHeader,
  sandboxDroppedFields,
  sandboxFromFlags,
  splitToolList,
  writeMetricsSidecar,
} from "../src/cli/run-sandbox.ts";
import { HarnessError, type RunResult, type UsageAvailability } from "../src/core/types.ts";

const CLI = new URL("../src/cli/ach.ts", import.meta.url).pathname;
const tmps: string[] = [];
after(() => {
  for (const d of tmps) rmSync(d, { recursive: true, force: true });
});
function tmp(): string {
  const d = mkdtempSync(path.join(tmpdir(), "ach-run-sandbox-"));
  tmps.push(d);
  return d;
}

function runCli(args: string[], stateDir: string) {
  const isBun = (process.versions as { bun?: string }).bun !== undefined;
  const p = spawnSync(process.execPath, isBun ? [CLI, ...args] : ["--import", "tsx", CLI, ...args], {
    env: { ...process.env, AGENTIC_CODING_HARNESS_STATE_DIR: stateDir, HOME: stateDir },
    encoding: "utf8",
  });
  return { code: p.status ?? -1, stdout: p.stdout ?? "", stderr: p.stderr ?? "" };
}

function usage(fn: () => unknown, needle: string): void {
  assert.throws(fn, (e: unknown) => e instanceof HarnessError && e.code === "USAGE" && e.message.includes(needle));
}

describe("sandboxFromFlags", () => {
  test("no flags -> undefined", () => {
    assert.equal(sandboxFromFlags({}), undefined);
  });

  test("flags -> SandboxPolicy -> claude args", () => {
    const policy = sandboxFromFlags({
      "permission-mode": "bypassPermissions",
      "allowed-tools": ["Bash,Read", "Edit"],
      "disallowed-tools": ["WebFetch"],
      "mcp-config": ["./mcp.json"],
    });
    assert.deepEqual(policy, {
      permissionMode: "bypassPermissions",
      allowedTools: ["Bash", "Read", "Edit"],
      disallowedTools: ["WebFetch"],
      mcpConfig: "./mcp.json",
    });
    const args = claudeSandboxArgs(policy!);
    const i = args.indexOf("--permission-mode");
    assert.equal(args[i + 1], "bypassPermissions");
    assert.equal(args[args.indexOf("--allowedTools") + 1], "Bash,Read,Edit");
    assert.equal(args[args.indexOf("--disallowedTools") + 1], "WebFetch");
    assert.equal(args[args.indexOf("--mcp-config") + 1], "./mcp.json");
  });

  test("portable mode spellings flow through to the adapter mapping", () => {
    assert.deepEqual(codexSandboxArgs(sandboxFromFlags({ "permission-mode": "dontAsk" })!), ["--ask-for-approval", "never"]);
  });

  test("tool lists split on commas outside parentheses only", () => {
    assert.deepEqual(splitToolList("Bash(git log:*), Read,,Bash(a,b)"), ["Bash(git log:*)", "Read", "Bash(a,b)"]);
  });

  test("inline JSON mcp-config parses to an object; bad JSON and repeats are USAGE errors", () => {
    assert.deepEqual(sandboxFromFlags({ "mcp-config": ['{"mcpServers":{}}'] })!.mcpConfig, { mcpServers: {} });
    usage(() => sandboxFromFlags({ "mcp-config": ["{nope"] }), "does not parse");
    usage(() => sandboxFromFlags({ "mcp-config": ["a.json", "b.json"] }), "once");
    usage(() => sandboxFromFlags({ "allowed-tools": [" , "] }), "at least one");
    usage(() => sandboxFromFlags({ "permission-mode": " " }), "needs a value");
  });

  test("describe/header redact inline MCP JSON but keep paths", () => {
    const inline = { mcpServers: { s: { env: { TOKEN: "sekrit-value" } } } };
    assert.ok(!JSON.stringify(describeSandbox({ mcpConfig: inline })).includes("sekrit-value"));
    assert.ok(!formatSandboxHeader({ mcpConfig: inline }).includes("sekrit-value"));
    assert.equal(formatSandboxHeader({ permissionMode: "acceptEdits", allowedTools: ["Bash", "Read"], mcpConfig: "m.json" }), "[sandbox] permissionMode=acceptEdits allowedTools=Bash,Read mcpConfig=m.json");
  });
});

describe("sandboxDroppedFields (per-adapter honor table)", () => {
  const all = { permissionMode: "ask", allowedTools: ["Bash"], disallowedTools: ["Edit"], mcpConfig: "m.json" };
  test("claude and gemini honor everything", () => {
    assert.deepEqual(sandboxDroppedFields("claude", all), []);
    assert.deepEqual(sandboxDroppedFields("gemini", all), []);
    assert.deepEqual(sandboxDroppedFields("copilot", all), []);
    // cursor: its adapter validateProfile names each dropped field itself (no double warning).
    assert.deepEqual(sandboxDroppedFields("cursor", all), []);
  });
  test("codex keeps only permissionMode", () => {
    assert.deepEqual(sandboxDroppedFields("codex", all), ["allowedTools", "disallowedTools", "mcpConfig"]);
  });
  test("kiro keeps allowedTools unless --kiro-tools is set; prime defers to its own validateProfile", () => {
    assert.deepEqual(sandboxDroppedFields("kiro", all), ["permissionMode", "disallowedTools", "mcpConfig"]);
    assert.ok(sandboxDroppedFields("kiro", all, { kiroToolsSet: true }).includes("allowedTools"));
    assert.deepEqual(sandboxDroppedFields("prime", all), []);
  });
  test("opencode, null and unknown (agents.d) agents drop all four", () => {
    for (const a of ["opencode", "null", "my-descriptor"]) assert.equal(sandboxDroppedFields(a, all).length, 4, a);
  });
});

describe("ach run CLI", () => {
  test("null adapter: header printed, one warning per dropped field naming it, policy in --json", () => {
    const dir = tmp();
    const r = runCli(["run", "--agent", "null", "--permission-mode", "bypassPermissions", "--allowed-tools", "Bash,Read", "--json", "hello"], dir);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stderr, /\[sandbox\] permissionMode=bypassPermissions allowedTools=Bash,Read/);
    assert.match(r.stderr, /\[warn\] --permission-mode is not supported by agent 'null'/);
    assert.match(r.stderr, /\[warn\] --allowed-tools is not supported by agent 'null'/);
    assert.ok(!/--mcp-config is not supported/.test(r.stderr), "unset fields must not warn");
    const out = JSON.parse(r.stdout);
    assert.deepEqual(out.sandbox, { permissionMode: "bypassPermissions", allowedTools: ["Bash", "Read"] });
  });

  test("--allowed-tools is repeatable on the command line", () => {
    const dir = tmp();
    const r = runCli(["run", "--agent", "null", "--allowed-tools", "A", "--allowed-tools", "B", "--json", "x"], dir);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout).sandbox.allowedTools, ["A", "B"]);
  });

  test("bad --mcp-config JSON exits non-zero with a usage message", () => {
    const r = runCli(["run", "--agent", "null", "--mcp-config", "{bad", "x"], tmp());
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /does not parse/);
  });

  test("--help documents the new flags", () => {
    const r = runCli(["--help"], tmp());
    for (const f of ["--permission-mode", "--allowed-tools", "--disallowed-tools", "--mcp-config", "--evidence-dir"]) {
      assert.ok((r.stdout + r.stderr).includes(f), `${f} missing from help`);
    }
  });
});

describe("--evidence-dir metrics sidecar", () => {
  const SECRET = "ZEBRA-PROMPT-7f3a9c-do-not-leak";

  test("sidecar parses, has the metric fields, and never contains the prompt", () => {
    const dir = tmp();
    const ev = path.join(dir, "evidence", "arm-b");
    const r = runCli(["run", "--agent", "null", "--json", "--model", "m-1", "--permission-mode", "acceptEdits", "--evidence-dir", ev, SECRET], dir);
    assert.equal(r.code, 0, r.stderr);
    // control: the same run's own --json output DOES contain the prompt, so the probe can fail
    assert.ok(r.stdout.includes(SECRET), "control: prompt should appear in the raw run output");
    const raw = readFileSync(path.join(ev, "metrics.json"), "utf8");
    const m = JSON.parse(raw);
    assert.equal(m.schema, "ach.metrics/1");
    assert.equal(m.agent, "null");
    assert.equal(m.model, "m-1");
    assert.equal(m.exitStatus, "success");
    assert.equal(typeof m.wallSeconds, "number");
    assert.equal(m.turns, 1);
    assert.equal(typeof m.cost.usd, "number");
    assert.equal(typeof m.cost.provenance, "string");
    assert.equal(m.tokens.input, 12);
    assert.equal(m.tokens.output, 8);
    assert.deepEqual(m.sandbox, { permissionMode: "acceptEdits" });
    assert.match(m.achVersion, /^\d+\.\d+\.\d+/);
    assert.ok(!Number.isNaN(Date.parse(m.startedAt)) && !Number.isNaN(Date.parse(m.endedAt)));
    assert.ok(!raw.includes(SECRET), "prompt text leaked into the sidecar");
    assert.equal(readdirSync(ev).join(), "metrics.json");
  });

  test("buildRunMetrics ignores event and warning text (control: a leaky result would show it)", () => {
    const leak = "LEAKY-EVENT-TEXT";
    const m = buildRunMetrics({
      agent: "claude",
      result: {
        runId: "r1",
        sessionId: "s1",
        events: [{ type: "message", payload: { text: leak } } as never],
        tokens: [],
        totalCost: 0.5,
        durationMs: 1500,
        exitStatus: "success",
        warnings: [leak],
      },
    });
    assert.ok(!JSON.stringify(m).includes(leak));
    assert.equal(m.wallSeconds, 1.5);
    assert.equal(m.cost.usd, 0.5);
    assert.ok(JSON.stringify({ leak }).includes(leak)); // the probe itself can see the string
  });

  describe("usage availability in the sidecar (issue 159)", () => {
    const base: RunResult = {
      runId: "r159",
      sessionId: "s159",
      events: [],
      tokens: [],
      totalCost: 0,
      durationMs: 2000,
      exitStatus: "success",
      warnings: [],
    };
    // Written through writeMetricsSidecar and parsed back: what a reader sees.
    function readBack(agent: string, result: RunResult): Record<string, any> {
      const dir = tmp();
      const p = writeMetricsSidecar(dir, buildRunMetrics({ agent, result }));
      return JSON.parse(readFileSync(p, "utf8"));
    }

    test("kiro-shaped result (credits only): credits carried, usd and tokens null", () => {
      const usageKiro: UsageAvailability = {
        tokens: { available: false },
        credits: { available: true, source: "native", scope: "run", complete: true, value: 0.08098 },
        usd: { available: false },
      };
      const m = readBack("kiro", { ...base, usage: usageKiro });
      assert.equal(m.credits.value, usageKiro.credits.value);
      assert.equal(m.credits.source, "native");
      assert.equal(m.credits.complete, true);
      assert.equal(m.cost.usd, null);
      assert.equal(m.tokens, null);
      assert.equal(m.cost.provenance, "usd:unavailable; tokens:unavailable");
    });

    test("claude-shaped result: numeric usd and tokens kept, a priced 0 stays 0, credits null", () => {
      const usageClaude: UsageAvailability = {
        tokens: { available: true, source: "native" },
        credits: { available: false },
        usd: { available: true, source: "vendor", value: 0 },
      };
      const m = readBack("claude", {
        ...base,
        totalCost: 0,
        tokens: [{ inputTokens: 5, outputTokens: 3, cacheReadTokens: 1, cacheWriteTokens: 2 }] as never,
        usage: usageClaude,
      });
      assert.equal(m.cost.usd, 0);
      assert.deepEqual(m.tokens, { input: 5, output: 3, cacheRead: 1, cacheWrite: 2, reasoning: 0 });
      assert.equal(m.credits, null);
    });

    test("no-usage result: numeric output unchanged, credits null", () => {
      const m = readBack("other", { ...base, totalCost: 0.25 });
      assert.equal(m.cost.usd, 0.25);
      assert.equal(m.cost.provenance, "unknown");
      assert.deepEqual(m.tokens, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 });
      assert.equal(m.credits, null);
    });
  });

  test("--repeat writes one metrics-<i>.json per child", () => {
    const dir = tmp();
    const ev = path.join(dir, "ev");
    const r = runCli(["run", "--agent", "null", "--repeat", "2", "--evidence-dir", ev, "p"], dir);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(readdirSync(ev).filter((f) => /^metrics-\d+\.json$/.test(f)).length, 2);
  });
});
