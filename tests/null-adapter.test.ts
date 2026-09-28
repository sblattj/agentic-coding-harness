// Negative-control "null" adapter (issue #55): a fake agent that needs no
// CLI binary and no auth, so `ach run --agent null "<prompt>"` exercises the
// whole pipeline (driver, registry RunRecord, artifacts, stats) for free.
// Prior art cited in the issue: openbench's obench/adapters/__init__.py.
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { createDriver } from "../src/core/driver.ts";
import { NullAdapter, NULL_EXIT_ENV, NULL_TURNS_ENV } from "../src/adapters/null.ts";
import { listRunRecords } from "../src/core/registry.ts";
import type { RunResult } from "../src/core/types.ts";

async function tmpStateDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "harness-null-"));
}

function mockDriver(stateDir: string, adapter: NullAdapter = new NullAdapter()) {
  return createDriver({
    adapters: { null: adapter },
    stateDir,
    registry: { stateDir },
  });
}

describe("NullAdapter (unit, via driver)", () => {
  it("completes with exitStatus success and no adapter credentials/network", async () => {
    const stateDir = await tmpStateDir();
    const driver = mockDriver(stateDir);
    const result: RunResult = await driver.run("null", { prompt: "hello world" });
    assert.equal(result.exitStatus, "success");
    assert.equal(result.warnings.length, 0, `unexpected warnings: ${result.warnings.join("; ")}`);
    assert.ok(result.tokens.length >= 1, "null adapter should emit at least one usage record");
    assert.equal(result.totalCost, 0, "null adapter must be zero-cost (no invented price)");
  });

  it("emits a bit-identical usage record (numeric fields + cost) across two identical runs", async () => {
    const stateDir = await tmpStateDir();
    const runOnce = async () => {
      const driver = mockDriver(stateDir, new NullAdapter());
      return driver.run("null", { prompt: "same prompt" });
    };
    const a = await runOnce();
    const b = await runOnce();
    assert.equal(a.tokens.length, b.tokens.length);
    for (let i = 0; i < a.tokens.length; i++) {
      const ta = a.tokens[i]!;
      const tb = b.tokens[i]!;
      assert.equal(ta.inputTokens, tb.inputTokens);
      assert.equal(ta.outputTokens, tb.outputTokens);
      assert.equal(ta.cacheReadTokens, tb.cacheReadTokens);
      assert.equal(ta.cacheWriteTokens, tb.cacheWriteTokens);
      assert.equal(ta.costUsd, tb.costUsd);
      assert.equal(ta.model, tb.model);
    }
    assert.equal(a.totalCost, b.totalCost);
  });

  it("AGENTIC_CODING_HARNESS_NULL_TURNS controls the number of usage records emitted", async () => {
    const stateDir = await tmpStateDir();
    const adapter = new NullAdapter({ turns: 3 });
    const driver = mockDriver(stateDir, adapter);
    const result = await driver.run("null", { prompt: "hi" });
    assert.equal(result.tokens.length, 3);
  });

  it("forceExit option 'error' reports exitStatus error", async () => {
    const stateDir = await tmpStateDir();
    const adapter = new NullAdapter({ forceExit: "error" });
    const driver = mockDriver(stateDir, adapter);
    const result = await driver.run("null", { prompt: "hi" });
    assert.equal(result.exitStatus, "error");
  });

  it("forceExit option 'timeout' reports exitStatus timeout", async () => {
    const stateDir = await tmpStateDir();
    const adapter = new NullAdapter({ forceExit: "timeout" });
    const driver = mockDriver(stateDir, adapter);
    const result = await driver.run("null", { prompt: "hi" });
    assert.equal(result.exitStatus, "timeout");
  });

  it("forceExit option 'budget_exceeded' reports exitStatus budget_exceeded", async () => {
    const stateDir = await tmpStateDir();
    const adapter = new NullAdapter({ forceExit: "budget_exceeded" });
    const driver = mockDriver(stateDir, adapter);
    const result = await driver.run("null", { prompt: "hi" });
    assert.equal(result.exitStatus, "budget_exceeded");
  });

  it("rejects an unknown AGENTIC_CODING_HARNESS_NULL_EXIT value instead of silently succeeding", async () => {
    const stateDir = await tmpStateDir();
    const adapter = new NullAdapter({ forceExit: "not-a-real-status" });
    const driver = mockDriver(stateDir, adapter);
    await assert.rejects(driver.run("null", { prompt: "hi" }));
  });

  it("writes a running-then-final RunRecord to the registry", async () => {
    const stateDir = await tmpStateDir();
    const driver = mockDriver(stateDir);
    const result = await driver.run("null", { prompt: "registry check" });
    const records = listRunRecords(stateDir);
    const rec = records.find((r) => r.runId === result.runId);
    assert.ok(rec, "expected a RunRecord for this run");
    assert.equal(rec!.agent, "null");
    assert.equal(rec!.exitStatus, "success");
    assert.equal(rec!.status, "success");
  });
});

// ---------------------------------------------------------------------------
// End-to-end through the real CLI entry (AC: "ach run --agent null ... writes
// a RunRecord with exitStatus success"); scrubbed env proves no credentials
// are required.
// ---------------------------------------------------------------------------

const CLI = fileURLToPath(new URL("../src/cli/ach.ts", import.meta.url));

interface RunOut {
  code: number;
  stdout: string;
  stderr: string;
}

function runCli(args: string[], env: Record<string, string>): RunOut {
  const isBun = (process.versions as { bun?: string }).bun !== undefined;
  const p = spawnSync(process.execPath, isBun ? [CLI, ...args] : ["--import", "tsx", CLI, ...args], {
    env,
    encoding: "utf8",
  });
  return { code: p.status ?? -1, stdout: p.stdout ?? "", stderr: p.stderr ?? "" };
}

describe("harness cli: ach run --agent null (e2e, scrubbed env)", () => {
  it("completes successfully with no adapter credentials on PATH-only env and writes a success RunRecord", async () => {
    const stateDir = await tmpStateDir();
    // Scrubbed env: PATH (to find node/tsx) plus the state-dir override only —
    // no ANTHROPIC_API_KEY / OPENAI_API_KEY / etc. A real adapter would fail
    // fast without credentials; the null adapter must not need any.
    const scrubbedEnv: Record<string, string> = {
      PATH: process.env.PATH ?? "",
      AGENTIC_CODING_HARNESS_STATE_DIR: stateDir,
    };
    if (process.env.NODE_PATH) scrubbedEnv.NODE_PATH = process.env.NODE_PATH;
    const r = runCli(["run", "--agent", "null", "--json", "smoke test prompt"], scrubbedEnv);
    assert.equal(r.code, 0, `stderr: ${r.stderr}`);
    const parsed = JSON.parse(r.stdout) as RunResult;
    assert.equal(parsed.exitStatus, "success");

    const records = listRunRecords(stateDir);
    const rec = records.find((rr) => rr.runId === parsed.runId);
    assert.ok(rec, "expected the CLI run to have written a RunRecord");
    assert.equal(rec!.exitStatus, "success");
    assert.equal(rec!.agent, "null");
  });

  it(`AGENTIC_CODING_HARNESS_NULL_EXIT=timeout via the real CLI reports exitStatus timeout`, async () => {
    const stateDir = await tmpStateDir();
    const scrubbedEnv: Record<string, string> = {
      PATH: process.env.PATH ?? "",
      AGENTIC_CODING_HARNESS_STATE_DIR: stateDir,
      [NULL_EXIT_ENV]: "timeout",
    };
    if (process.env.NODE_PATH) scrubbedEnv.NODE_PATH = process.env.NODE_PATH;
    const r = runCli(["run", "--agent", "null", "--json", "prompt"], scrubbedEnv);
    // cmdRun returns exit code 1 for any non-success exitStatus.
    assert.equal(r.code, 1, `stderr: ${r.stderr}`);
    const parsed = JSON.parse(r.stdout) as RunResult;
    assert.equal(parsed.exitStatus, "timeout");
  });

  it("ach --help / USAGE lists null as a known agent", () => {
    const r = runCli(["--help"], { PATH: process.env.PATH ?? "" });
    assert.match(r.stdout, /null/);
  });

  it(`${NULL_TURNS_ENV} via the real CLI controls the emitted usage-record count`, async () => {
    const stateDir = await tmpStateDir();
    const scrubbedEnv: Record<string, string> = {
      PATH: process.env.PATH ?? "",
      AGENTIC_CODING_HARNESS_STATE_DIR: stateDir,
      [NULL_TURNS_ENV]: "4",
    };
    if (process.env.NODE_PATH) scrubbedEnv.NODE_PATH = process.env.NODE_PATH;
    const r = runCli(["run", "--agent", "null", "--json", "prompt"], scrubbedEnv);
    assert.equal(r.code, 0, `stderr: ${r.stderr}`);
    const parsed = JSON.parse(r.stdout) as RunResult;
    assert.equal(parsed.tokens.length, 4);
  });
});
