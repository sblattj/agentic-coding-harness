// #106: hermetic runs (src/core/hermetic.ts) and the ancestor-instruction
// warning/record, unit-level and end to end through the real `ach run` entry
// point with a PATH-shimmed fake `claude` that records its cwd, writes a
// file, and deletes one.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { createDriver } from "../src/core/driver.ts";
import {
  disposeHermeticWorkspace,
  prepareHermeticWorkspace,
  runHermetic,
  syncBackHermeticWorkspace,
} from "../src/core/hermetic.ts";
import type { Driver } from "../src/core/driver.ts";
import type { RunResult, RunSpec } from "../src/core/types.ts";

const CLI = new URL("../src/cli/ach.ts", import.meta.url).pathname;

let root: string;
let cleanRoot: string;
before(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ach-hermetic-test-")));
  cleanRoot = path.join(root, "clean-tmp");
  fs.mkdirSync(cleanRoot);
});
after(() => fs.rmSync(root, { recursive: true, force: true }));

let seq = 0;
/** A fake $HOME holding CLAUDE.md, with a workspace under it. */
function homeWithWorkspace(): { home: string; ws: string; memory: string } {
  const home = path.join(root, `home-${++seq}`);
  const ws = path.join(home, "code", "proj");
  fs.mkdirSync(path.join(ws, "src"), { recursive: true });
  const memory = path.join(home, "CLAUDE.md");
  fs.writeFileSync(memory, "ALWAYS SAY PINEAPPLE\n");
  fs.writeFileSync(path.join(ws, "keep.txt"), "keep\n");
  fs.writeFileSync(path.join(ws, "delete-me.txt"), "bye\n");
  fs.writeFileSync(path.join(ws, "src", "edit.txt"), "v1\n");
  return { home, ws, memory };
}

function ls(dir: string): string[] {
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => n.startsWith("ach-hermetic-")) : [];
}

/** A fake driver that "edits" its cwd the way an agent would. */
function editingDriver(onRun?: (cwd: string) => void): Pick<Driver, "run"> & { cwds: string[] } {
  const cwds: string[] = [];
  return {
    cwds,
    run: async (_agent: string, spec: RunSpec): Promise<RunResult> => {
      const cwd = spec.cwd!;
      cwds.push(cwd);
      fs.writeFileSync(path.join(cwd, "touched.txt"), cwd);
      fs.writeFileSync(path.join(cwd, "src", "edit.txt"), "v2 longer\n");
      fs.rmSync(path.join(cwd, "delete-me.txt"));
      fs.mkdirSync(path.join(cwd, "new-dir", "deep"), { recursive: true });
      fs.writeFileSync(path.join(cwd, "new-dir", "deep", "f.txt"), "x");
      onRun?.(cwd);
      return { runId: "r1", sessionId: "s1", events: [], tokens: [], totalCost: 0, durationMs: 1, exitStatus: "success", warnings: [] };
    },
  };
}

describe("hermetic workspace (#106) — unit", () => {
  it("the agent runs in a copy OUTSIDE the original tree; edits and deletions sync back; temp dir removed", async () => {
    const { ws, memory } = homeWithWorkspace();
    const driver = editingDriver();
    const result = await runHermetic(driver, "claude", { prompt: "p", cwd: ws }, { tempRoot: cleanRoot });
    const ran = driver.cwds[0]!;
    assert.ok(!ran.startsWith(path.dirname(path.dirname(ws))), `agent cwd ${ran} must be outside the fake home`);
    assert.ok(ran.startsWith(cleanRoot + path.sep), ran);
    assert.equal(path.basename(ran), "proj", "the copy keeps the workspace basename");
    assert.equal(fs.readFileSync(path.join(ws, "touched.txt"), "utf8"), ran, "new file synced back");
    assert.equal(fs.readFileSync(path.join(ws, "src", "edit.txt"), "utf8"), "v2 longer\n", "edit synced back");
    assert.equal(fs.existsSync(path.join(ws, "delete-me.txt")), false, "deletion propagated");
    assert.equal(fs.readFileSync(path.join(ws, "keep.txt"), "utf8"), "keep\n", "untouched file kept");
    assert.equal(fs.readFileSync(path.join(ws, "new-dir", "deep", "f.txt"), "utf8"), "x", "new nested dir synced");
    assert.deepEqual(ls(cleanRoot), [], "temp dir cleaned up");
    assert.equal(result.hermetic?.source, ws);
    assert.equal(result.hermetic?.tempDir, ran);
    assert.deepEqual(result.hermetic?.avoided, [memory]);
    assert.deepEqual(result.hermetic?.synced, { copied: 3, deleted: 1 });
  });

  it("deletions only touch paths that existed in the copy: a file created in the original mid-run survives", async () => {
    const { ws } = homeWithWorkspace();
    const driver = editingDriver(() => fs.writeFileSync(path.join(ws, "user-made.txt"), "mine"));
    await runHermetic(driver, "claude", { prompt: "p", cwd: ws }, { tempRoot: cleanRoot });
    assert.equal(fs.readFileSync(path.join(ws, "user-made.txt"), "utf8"), "mine");
  });

  it("fails loudly (HERMETIC_UNSAFE) when the temp root itself has ancestor instruction files; nothing runs", async () => {
    const { home, ws } = homeWithWorkspace();
    const leakyRoot = path.join(home, "tmp");
    fs.mkdirSync(leakyRoot);
    const driver = editingDriver();
    await assert.rejects(
      runHermetic(driver, "claude", { prompt: "p", cwd: ws }, { tempRoot: leakyRoot }),
      (err: Error & { code?: string }) => err.code === "HERMETIC_UNSAFE" && err.message.includes(path.join(home, "CLAUDE.md")),
    );
    assert.equal(driver.cwds.length, 0, "the agent never launched");
    assert.deepEqual(ls(leakyRoot), [], "the rejected temp dir is removed");
    assert.equal(fs.existsSync(path.join(ws, "delete-me.txt")), true);
  });

  it("refuses a temp root inside the workspace", () => {
    const { ws } = homeWithWorkspace();
    const inner = path.join(ws, "tmp");
    fs.mkdirSync(inner);
    assert.throws(() => prepareHermeticWorkspace("null", ws, { tempRoot: inner }), /inside the workspace/);
  });

  it("the agent throwing still syncs back and cleans up, then rethrows", async () => {
    const { ws } = homeWithWorkspace();
    const driver: Pick<Driver, "run"> = {
      run: async (_a, spec) => {
        fs.writeFileSync(path.join(spec.cwd!, "partial.txt"), "half");
        throw new Error("boom");
      },
    };
    await assert.rejects(runHermetic(driver, "claude", { prompt: "p", cwd: ws }, { tempRoot: cleanRoot }), /boom/);
    assert.equal(fs.readFileSync(path.join(ws, "partial.txt"), "utf8"), "half");
    assert.deepEqual(ls(cleanRoot), []);
  });

  it("a failed sync-back KEEPS the temp dir and names it", async () => {
    const { ws } = homeWithWorkspace();
    const driver: Pick<Driver, "run"> = {
      run: async (_a, spec) => {
        fs.writeFileSync(path.join(spec.cwd!, "src", "edit.txt"), "agent edit");
        // Make the original's target unwritable for the sync (a file where a dir is needed).
        fs.rmSync(path.join(ws, "src"), { recursive: true });
        fs.writeFileSync(path.join(ws, "src"), "not a dir");
        fs.chmodSync(ws, 0o555);
        return { runId: "r", sessionId: "s", events: [], tokens: [], totalCost: 0, durationMs: 1, exitStatus: "success", warnings: [] };
      },
    };
    try {
      await assert.rejects(
        runHermetic(driver, "claude", { prompt: "p", cwd: ws }, { tempRoot: cleanRoot }),
        (err: Error & { code?: string }) => err.code === "HERMETIC_SYNC_FAILED" && /KEPT at/.test(err.message),
      );
      const kept = ls(cleanRoot);
      assert.equal(kept.length, 1, "temp dir kept");
      assert.equal(fs.readFileSync(path.join(cleanRoot, kept[0]!, "proj", "src", "edit.txt"), "utf8"), "agent edit");
      fs.rmSync(path.join(cleanRoot, kept[0]!), { recursive: true, force: true });
    } finally {
      fs.chmodSync(ws, 0o755);
    }
  });

  it("syncBack is a no-op for an untouched copy", () => {
    const { ws } = homeWithWorkspace();
    const prepared = prepareHermeticWorkspace("claude", ws, { tempRoot: cleanRoot });
    assert.deepEqual(syncBackHermeticWorkspace(prepared), { copied: 0, deleted: 0 });
    disposeHermeticWorkspace(prepared);
    assert.deepEqual(ls(cleanRoot), []);
  });

  it("a driver confined to the ORIGINAL workspace refuses the temp copy (WORKSPACE_ESCAPE), loudly", async () => {
    const { ws } = homeWithWorkspace();
    const state = path.join(root, `confine-state-${++seq}`);
    const { NullAdapter } = await import("../src/adapters/null.ts");
    const driver = createDriver({
      adapters: { null: new NullAdapter() as never },
      stateDir: state,
      confineToWorkspace: true,
      workspaceRoot: ws,
    });
    await assert.rejects(
      runHermetic(driver, "null", { prompt: "p", cwd: ws }, { tempRoot: cleanRoot }),
      (err: Error & { code?: string }) => err.code === "WORKSPACE_ESCAPE",
    );
    assert.deepEqual(ls(cleanRoot), [], "cleaned up after the refusal");
  });
});

// ------------------------------------------------------------- end to end

const SESSION = "hermetic-e2e-0001";
function fakeClaude(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  const init = `{"type":"system","subtype":"init","cwd":"/x","session_id":"${SESSION}","tools":[],"model":"claude-sonnet-4-5-20250929","permissionMode":"default","version":"2.0.14","output_style":"default"}`;
  const res = `{"type":"result","subtype":"success","is_error":false,"duration_ms":12,"duration_api_ms":11,"num_turns":1,"result":"hi","session_id":"${SESSION}","total_cost_usd":0.0077,"usage":{"input_tokens":9,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"output_tokens":4,"service_tier":"standard"},"modelUsage":{"claude-sonnet-4-5-20250929":{"inputTokens":9,"cacheCreationInputTokens":0,"cacheReadInputTokens":0,"outputTokens":4,"reasoningTokens":0,"serviceTier":"standard","contextWindow":200000,"webSearchRequests":0,"costUSD":0.0077}},"permission_denials":[]}`;
  const bin = path.join(dir, "claude");
  fs.writeFileSync(
    bin,
    ["#!/bin/sh", 'if [ "$1" = "--version" ]; then echo "2.0.14 (Claude Code)"; exit 0; fi', "pwd -P > touched.txt", "rm -f delete-me.txt", `echo '${init}'`, `echo '${res}'`, ""].join("\n"),
  );
  fs.chmodSync(bin, 0o755);
  return dir;
}

function runCli(args: string[], env: Record<string, string>, cwd: string): { code: number; stdout: string; stderr: string } {
  const p = spawnSync(process.execPath, ["--import", import.meta.resolve("tsx"), CLI, ...args], {
    env: { ...process.env, ...env },
    encoding: "utf8",
    cwd,
  });
  return { code: p.status ?? -1, stdout: p.stdout ?? "", stderr: p.stderr ?? "" };
}

function records(state: string): Array<Record<string, unknown>> {
  const dir = path.join(state, "runs");
  return fs.readdirSync(dir).filter((n) => n.endsWith(".json")).map((n) => JSON.parse(fs.readFileSync(path.join(dir, n), "utf8")));
}

describe("ach run: ancestor instructions + --hermetic (#106) — end to end", () => {
  let shim: string;
  before(() => {
    shim = fakeClaude(path.join(root, "shim"));
  });
  const envFor = (home: string, state: string, extra: Record<string, string> = {}): Record<string, string> => ({
    HOME: home,
    PATH: `${shim}:${process.env.PATH ?? ""}`,
    AGENTIC_CODING_HARNESS_STATE_DIR: state,
    AGENTIC_CODING_HARNESS_HERMETIC_ROOT: cleanRoot,
    ...extra,
  });

  it("without --hermetic: warns before launch, records ancestorInstructions, shows them in the summary", () => {
    const { home, ws, memory } = homeWithWorkspace();
    const state = path.join(root, `state-${++seq}`);
    const r = runCli(["run", "--agent", "claude", "hi"], envFor(home, state), ws);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stderr, /will load 1 instruction file from ANCESTOR directories/);
    assert.ok(r.stderr.includes(memory), r.stderr);
    assert.match(r.stdout, /^ancestors {2}1 instruction file from ancestor dirs: /m);
    assert.equal(fs.readFileSync(path.join(ws, "touched.txt"), "utf8").trim(), ws, "the agent ran in the workspace itself");
    const [rec] = records(state);
    assert.deepEqual(rec!.ancestorInstructions, [memory]);
    assert.equal(rec!.hermetic, undefined);
  });

  it("--hermetic: the agent runs outside $HOME, edits come back before --verify, the record says so", () => {
    const { home, ws, memory } = homeWithWorkspace();
    const state = path.join(root, `state-${++seq}`);
    const r = runCli(["run", "--agent", "claude", "--hermetic", "--verify", "test -f touched.txt && test ! -f delete-me.txt", "--json", "hi"], envFor(home, state), ws);
    assert.equal(r.code, 0, r.stderr);
    assert.doesNotMatch(r.stderr, /ANCESTOR directories/);
    assert.match(r.stderr, /\[hermetic\] running in /);
    const ranIn = fs.readFileSync(path.join(ws, "touched.txt"), "utf8").trim();
    assert.ok(ranIn.startsWith(cleanRoot + path.sep), `agent cwd ${ranIn} must be under the clean temp root`);
    assert.ok(!ranIn.startsWith(home), "agent cwd must be outside the fake $HOME");
    assert.equal(fs.existsSync(path.join(ws, "delete-me.txt")), false, "deletion synced back");
    assert.equal(fs.existsSync(ranIn), false, "temp copy removed");
    const out = JSON.parse(r.stdout);
    assert.equal(out.verify.status, "pass", "verify saw the synced tree");
    assert.equal(out.hermetic.tempDir, ranIn);
    assert.equal(out.ancestorInstructions, undefined);
    const [rec] = records(state);
    assert.equal(rec!.cwd, ws, "record cwd is the original workspace, not the deleted temp copy");
    assert.deepEqual(rec!.hermetic, { tempDir: ranIn, source: ws, avoided: [memory], synced: { copied: 1, deleted: 1 } });
    assert.equal(rec!.ancestorInstructions, undefined);
    assert.equal((rec!.verify as { status: string }).status, "pass");
  });

  it("--hermetic summary line (text mode)", () => {
    const { home, ws } = homeWithWorkspace();
    const r = runCli(["run", "--agent", "claude", "--hermetic", "hi"], envFor(home, path.join(root, `state-${++seq}`)), ws);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /^hermetic {3}\S+ · synced back 1 written, 1 deleted · avoided 1 ancestor instruction file$/m);
  });

  it("--hermetic with a temp root that has ancestor instruction files exits non-zero and never launches", () => {
    const { home, ws } = homeWithWorkspace();
    const leaky = path.join(home, "tmp");
    fs.mkdirSync(leaky);
    const r = runCli(["run", "--agent", "claude", "--hermetic", "hi"], envFor(home, path.join(root, `state-${++seq}`), { AGENTIC_CODING_HARNESS_HERMETIC_ROOT: leaky }), ws);
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /refusing to run non-hermetically/);
    assert.equal(fs.existsSync(path.join(ws, "touched.txt")), false, "the agent never ran");
    assert.deepEqual(ls(leaky), []);
  });

  it("--hermetic refuses --resume and --parallel > 1", () => {
    const { home, ws } = homeWithWorkspace();
    const env = envFor(home, path.join(root, `state-${++seq}`));
    const a = runCli(["run", "--agent", "claude", "--hermetic", "--resume", "abc", "hi"], env, ws);
    assert.notEqual(a.code, 0);
    assert.match(a.stderr, /cannot be combined with --resume/);
    const b = runCli(["run", "--agent", "claude", "--hermetic", "--repeat", "2", "--parallel", "2", "hi"], env, ws);
    assert.notEqual(b.code, 0);
    assert.match(b.stderr, /cannot be combined with --parallel > 1/);
  });
});

describe("--hermetic on the other launch paths (#106)", () => {
  it("runMatrix({ hermetic: true }): the cell's agent runs in a clean copy; its verify sees the synced edits", async () => {
    const { expandMatrix, parseMatrixPlan, runMatrix } = await import("../src/cli/trial-matrix.ts");
    const { ws } = homeWithWorkspace();
    const state = path.join(root, `matrix-state-${++seq}`);
    const cells = expandMatrix(
      parseMatrixPlan({ experiment: "herm", agents: ["claude"], tasks: [{ id: "t", prompt: "p", cwd: ws, verify: "test -f touched.txt && test ! -f delete-me.txt" }] }),
      root,
    );
    const driver = editingDriver();
    const prev = process.env.AGENTIC_CODING_HARNESS_HERMETIC_ROOT;
    process.env.AGENTIC_CODING_HARNESS_HERMETIC_ROOT = cleanRoot;
    try {
      const s = await runMatrix({ cells, ledgerPath: path.join(root, `m-${seq}.ledger.jsonl`), driver, stateDir: state, hermetic: true });
      assert.equal(s.passed, 1, JSON.stringify(s.cells));
    } finally {
      if (prev === undefined) delete process.env.AGENTIC_CODING_HARNESS_HERMETIC_ROOT;
      else process.env.AGENTIC_CODING_HARNESS_HERMETIC_ROOT = prev;
    }
    assert.ok(driver.cwds[0]!.startsWith(cleanRoot + path.sep), driver.cwds[0]);
    assert.equal(fs.existsSync(path.join(ws, "touched.txt")), true);
  });

  it("MCP harness_run { hermetic: true } runs in a clean copy and syncs back; without it the result warns", async () => {
    const { createMcpServer } = await import("../src/mcp/server.ts");
    const { registerRunTools } = await import("../src/mcp/tools-run.ts");
    const { ws, memory } = homeWithWorkspace();
    const shimDir = fakeClaude(path.join(root, `mcp-shim-${++seq}`));
    const state = path.join(root, `mcp-state-${seq}`);
    const saved = { PATH: process.env.PATH, ROOT: process.env.AGENTIC_CODING_HARNESS_HERMETIC_ROOT };
    process.env.PATH = `${shimDir}:${saved.PATH ?? ""}`;
    process.env.AGENTIC_CODING_HARNESS_HERMETIC_ROOT = cleanRoot;
    try {
      const server = createMcpServer({ name: "t", version: "0" });
      registerRunTools(server, { stateDir: state });
      const call = async (args: Record<string, unknown>): Promise<RunResult> => {
        const res = await server.dispatch({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "harness_run", arguments: args } });
        const content = (res!.result as { content: Array<{ text: string }> }).content;
        return JSON.parse(content[0]!.text) as RunResult;
      };
      const plain = await call({ agent: "claude", prompt: "hi", cwd: ws });
      assert.deepEqual(plain.ancestorInstructions, [memory]);
      assert.ok(plain.warnings.some((w) => w.startsWith("ancestor instructions:")), JSON.stringify(plain.warnings));
      fs.writeFileSync(path.join(ws, "delete-me.txt"), "again");
      const herm = await call({ agent: "claude", prompt: "hi", cwd: ws, hermetic: true });
      assert.equal(herm.ancestorInstructions, undefined);
      assert.ok(herm.hermetic!.tempDir.startsWith(cleanRoot + path.sep));
      assert.equal(fs.readFileSync(path.join(ws, "touched.txt"), "utf8").trim(), herm.hermetic!.tempDir);
      assert.equal(fs.existsSync(path.join(ws, "delete-me.txt")), false);
    } finally {
      process.env.PATH = saved.PATH;
      if (saved.ROOT === undefined) delete process.env.AGENTIC_CODING_HARNESS_HERMETIC_ROOT;
      else process.env.AGENTIC_CODING_HARNESS_HERMETIC_ROOT = saved.ROOT;
    }
  });
});
