// kiro-ide (#110) wiring: every place an agent name is enumerated, plus the
// --kiro-ide-* CLI flags. The adapter itself is covered by kiro-ide.test.ts.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";

import { kiroIdeConfigFromFlags } from "../src/cli/ach.ts";
import { AGENTS, isKnownAgent } from "../src/core/types.ts";
import { defaultAdapters } from "../src/core/driver.ts";
import { KiroIdeAdapter } from "../src/index.ts";
import { RunArgsSchema, KIRO_IDE_INPUT_SCHEMA } from "../src/mcp/tools-run.ts";

const CLI = new URL("../src/cli/ach.ts", import.meta.url).pathname;

function runCli(args: string[]): { code: number; stdout: string; stderr: string } {
  const p = spawnSync(process.execPath, ["--import", "tsx", CLI, ...args], {
    env: { ...process.env, AGENTIC_CODING_HARNESS_TZ: "UTC" },
    encoding: "utf8",
  });
  return { code: p.status ?? -1, stdout: p.stdout ?? "", stderr: p.stderr ?? "" };
}

describe("kiro-ide registration", () => {
  it("AGENTS and isKnownAgent include kiro-ide", () => {
    assert.ok(AGENTS.includes("kiro-ide"));
    assert.ok(isKnownAgent("kiro-ide"));
  });

  it("defaultAdapters() registers a KiroIdeAdapter named kiro-ide", async () => {
    const adapters = await defaultAdapters();
    assert.ok(adapters["kiro-ide"], "kiro-ide adapter registered");
    assert.equal(adapters["kiro-ide"]!.name, "kiro-ide");
    assert.equal(typeof KiroIdeAdapter, "function");
  });

  it("the MCP run schema accepts agent kiro-ide with a kiroIde block and rejects unknown keys", () => {
    const ok = RunArgsSchema.safeParse({ agent: "kiro-ide", prompt: "hi", kiroIde: { cdp: "127.0.0.1:9222", newSession: false } });
    assert.ok(ok.success, JSON.stringify(ok));
    const bad = RunArgsSchema.safeParse({ agent: "kiro-ide", prompt: "hi", kiroIde: { nope: 1 } });
    assert.ok(!bad.success);
    assert.deepEqual(Object.keys(KIRO_IDE_INPUT_SCHEMA.properties).sort(), ["bin", "cdp", "newSession", "port", "userDataDir"]);
  });
});

describe("kiroIdeConfigFromFlags", () => {
  it("is undefined when no flag was given", () => {
    assert.equal(kiroIdeConfigFromFlags({}), undefined);
  });

  it("maps every flag onto KiroIdeConfig", () => {
    assert.deepEqual(
      kiroIdeConfigFromFlags({
        "kiro-ide-cdp": "10.0.0.5:9333",
        "kiro-ide-port": "9444",
        "kiro-ide-bin": "/opt/Kiro",
        "kiro-ide-user-data-dir": "/tmp/prof",
        "kiro-ide-no-new-session": true,
      }),
      { cdp: "10.0.0.5:9333", port: 9444, bin: "/opt/Kiro", userDataDir: "/tmp/prof", newSession: false },
    );
  });

  it("--kiro-ide-no-new-session false leaves newSession unset (default true stays in the adapter)", () => {
    assert.equal(kiroIdeConfigFromFlags({ "kiro-ide-no-new-session": false }), undefined);
  });

  it("rejects a non-positive or non-integer port as USAGE", () => {
    for (const bad of ["abc", "0", "-3", "1.5"]) {
      assert.throws(() => kiroIdeConfigFromFlags({ "kiro-ide-port": bad }), /--kiro-ide-port/, bad);
    }
  });

  it("rejects a port above 65535 via the schema", () => {
    assert.throws(() => kiroIdeConfigFromFlags({ "kiro-ide-port": "70000" }), /invalid --kiro-ide-\* flags/);
  });
});

describe("ach CLI: kiro-ide flags", () => {
  it("usage text names the agent and every flag", () => {
    const r = runCli(["--help"]);
    const text = r.stdout + r.stderr;
    for (const needle of ["kiro-ide", "--kiro-ide-cdp", "--kiro-ide-port", "--kiro-ide-bin", "--kiro-ide-user-data-dir", "--kiro-ide-no-new-session"]) {
      assert.ok(text.includes(needle), `usage mentions ${needle}`);
    }
  });

  it("run --agent kiro-ide parses the flags: a bad port fails cleanly before any launch", () => {
    const r = runCli(["run", "--agent", "kiro-ide", "--kiro-ide-port", "abc", "hi"]);
    assert.notEqual(r.code, 0);
    assert.ok(r.stderr.includes("--kiro-ide-port"), r.stderr);
  });

  it("run accepts --kiro-ide-no-new-session / --kiro-ide-user-data-dir as known options (no parseArgs error)", () => {
    // A bad port short-circuits before launch; reaching that error proves the
    // other flags parsed instead of tripping ERR_PARSE_ARGS_UNKNOWN_OPTION.
    const r = runCli(["run", "--agent", "kiro-ide", "--kiro-ide-no-new-session", "--kiro-ide-user-data-dir", "/tmp/x", "--kiro-ide-bin", "/nonexistent", "--kiro-ide-port", "0", "hi"]);
    assert.ok(!/Unknown option/i.test(r.stderr), r.stderr);
    assert.ok(r.stderr.includes("--kiro-ide-port"), r.stderr);
  });

  it("doctor --agent kiro-ide reports kiro-ide rows against an unreachable CDP endpoint, read-only", () => {
    const r = runCli(["doctor", "--agent", "kiro-ide", "--kiro-ide-cdp", "127.0.0.1:1", "--kiro-ide-bin", "/nonexistent/Kiro", "--json"]);
    assert.equal(r.code, 1, r.stdout + r.stderr);
    const report = JSON.parse(r.stdout) as { promptsSent: number; checks: Array<{ agent: string; name: string; status: string }> };
    assert.equal(report.promptsSent, 0);
    const ide = report.checks.filter((c) => c.agent === "kiro-ide");
    assert.ok(ide.length >= 2, JSON.stringify(report.checks));
    assert.equal(ide.find((c) => c.name === "binary")?.status, "failed");
    assert.equal(ide.find((c) => c.name === "cdp")?.status, "failed");
  });

  it("doctor rejects an invalid --kiro-ide-port", () => {
    const r = runCli(["doctor", "--agent", "kiro-ide", "--kiro-ide-port", "nope"]);
    assert.notEqual(r.code, 0);
    assert.ok(r.stderr.includes("--kiro-ide-port"), r.stderr);
  });

  it("preflight --agent kiro-ide runs the read-only CDP rows (exit 1 when unreachable)", () => {
    const r = runCli(["preflight", "--agent", "kiro-ide", "--kiro-ide-cdp", "127.0.0.1:1", "--kiro-ide-bin", "/nonexistent/Kiro", "--json"]);
    assert.equal(r.code, 1, r.stdout + r.stderr);
    const out = JSON.parse(r.stdout) as { ok: boolean; checks: Array<{ name: string; status: string }> };
    assert.equal(out.ok, false);
    assert.equal(out.checks.find((c) => c.name === "cdp")?.status, "failed");
  });
});
