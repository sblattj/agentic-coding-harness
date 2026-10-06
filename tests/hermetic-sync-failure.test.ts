// #113 (matrix + MCP): a failed hermetic sync-back must not drop the settled
// run on any path. Technique (same as tests/hermetic.test.ts): during the run
// the ORIGINAL workspace's src/ is replaced by a plain file, so syncing the
// agent's src/edit.txt back throws HERMETIC_SYNC_FAILED and keeps the copy.
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { createMatrixDriver, expandMatrix, parseMatrixPlan, readLedger, runMatrix } from "../src/cli/trial-matrix.ts";
import type { Driver } from "../src/core/driver.ts";
import { HERMETIC_ROOT_ENV } from "../src/core/hermetic.ts";
import { readRunRecord } from "../src/core/registry.ts";
import type { McpServer, McpToolDef } from "../src/mcp/contract.ts";
import { registerJobTools } from "../src/mcp/tools-jobs.ts";
import { registerRunTools } from "../src/mcp/tools-run.ts";

let root: string;
let cleanRoot: string;
const savedPath = process.env.PATH;
const savedRoot = process.env[HERMETIC_ROOT_ENV];
let seq = 0;

before(() => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "ach-hermetic-113-")));
  cleanRoot = path.join(root, "clean-tmp");
  mkdirSync(cleanRoot);
  process.env[HERMETIC_ROOT_ENV] = cleanRoot;
});
after(() => {
  process.env.PATH = savedPath;
  if (savedRoot === undefined) delete process.env[HERMETIC_ROOT_ENV];
  else process.env[HERMETIC_ROOT_ENV] = savedRoot;
  rmSync(root, { recursive: true, force: true });
});

function workspace(name: string): string {
  const ws = path.join(root, `${name}-${++seq}`, "proj");
  mkdirSync(path.join(ws, "src"), { recursive: true });
  writeFileSync(path.join(ws, "src", "edit.txt"), "v1\n");
  return ws;
}
const breakOriginal = (ws: string): void => {
  rmSync(path.join(ws, "src"), { recursive: true, force: true });
  writeFileSync(path.join(ws, "src"), "not a dir\n");
};

describe("#113: ach trial --matrix keeps a cell whose hermetic sync-back failed", () => {
  it("2 cells: cell A sync fails, cell B succeeds; both are in ledger/summary/artifacts, A carries the error and a kept-copy verify", async () => {
    const wsA = workspace("a");
    const wsB = workspace("b");
    const state = path.join(root, `state-${++seq}`);
    mkdirSync(state, { recursive: true });
    const ledgerPath = path.join(root, `plan-${seq}.ledger.jsonl`);
    const plan = parseMatrixPlan({
      experiment: "exp-113",
      agents: ["null"],
      models: ["m1"],
      tasks: [
        { id: "ta", prompt: "a", cwd: wsA, workspace: "shared", verify: "grep -q agent-edit src/edit.txt" },
        { id: "tb", prompt: "b", cwd: wsB, workspace: "shared", verify: "grep -q agent-edit src/edit.txt" },
      ],
    });
    const cells = expandMatrix(plan, root);
    const real = await createMatrixDriver(["null"], state);
    const driver: Pick<Driver, "run"> = {
      run: async (agent, spec) => {
        const r = await real.run(agent, spec);
        writeFileSync(path.join(spec.cwd!, "src", "edit.txt"), "agent-edit\n");
        if (spec.prompt === "a") breakOriginal(wsA);
        return r;
      },
    };
    const seen: string[] = [];
    const s = await runMatrix({
      cells,
      ledgerPath,
      driver,
      stateDir: state,
      hermetic: true,
      onOutcome: (c, o) => seen.push(`${c.cellId}:${o.result?.runId ?? "none"}:${o.syncError?.code ?? "-"}`),
    });

    assert.equal(s.cells.length, 2, "both cells present");
    const [a, b] = s.cells;
    assert.equal(a!.outcome, "error");
    assert.ok(typeof a!.runId === "string" && a!.runId.length > 0, "failed cell keeps its runId");
    assert.equal(a!.exitStatus, "success");
    assert.equal(a!.verify, "pass", "verify graded on the kept copy");
    assert.equal(a!.errorInfo?.code, "HERMETIC_SYNC_FAILED");
    assert.ok(a!.errorInfo!.keptDir.startsWith(cleanRoot + path.sep));
    assert.equal(a!.errorInfo!.source, wsA);
    assert.equal(readFileSync(path.join(a!.errorInfo!.keptDir, "src", "edit.txt"), "utf8"), "agent-edit\n", "kept copy holds the edits");
    assert.equal(b!.outcome, "passed", "the other cell is not aborted");
    assert.equal(b!.errorInfo, undefined);
    assert.deepEqual([s.passed, s.error, s.ran], [1, 1, 2]);
    assert.equal(seen.length, 2, "onOutcome (artifacts) fired for both");
    assert.match(seen[0]!, /HERMETIC_SYNC_FAILED/);

    const { rows } = readLedger(ledgerPath);
    assert.equal(rows.length, 2);
    assert.equal(rows[0]!.runId, a!.runId);
    assert.equal(rows[0]!.status, "error");
    assert.equal(rows[0]!.errorInfo?.code, "HERMETIC_SYNC_FAILED");
    const rec = readRunRecord(state, a!.runId!);
    assert.ok(rec, "registry record exists for the failed cell");
    assert.equal(rec!.cellId, cells[0]!.cellId, "labels annotated");
    assert.equal(rec!.verify?.status, "pass");
    assert.equal(rec!.status, "error", "registry marks the run failed");
    assert.ok(existsSync(rows[0]!.errorInfo!.keptDir));
  });
});

// ---------------------------------------------------------------- MCP tools

const SESSION = "hermetic-113-mcp-0001";
function claudeShim(dir: string, src: string): void {
  mkdirSync(dir, { recursive: true });
  const init = `{"type":"system","subtype":"init","cwd":"/x","session_id":"${SESSION}","tools":[],"model":"claude-sonnet-4-5-20250929","permissionMode":"default","version":"2.0.14","output_style":"default"}`;
  const res = `{"type":"result","subtype":"success","is_error":false,"duration_ms":12,"duration_api_ms":11,"num_turns":1,"result":"hi","session_id":"${SESSION}","total_cost_usd":0.0077,"usage":{"input_tokens":9,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"output_tokens":4,"service_tier":"standard"},"modelUsage":{"claude-sonnet-4-5-20250929":{"inputTokens":9,"cacheCreationInputTokens":0,"cacheReadInputTokens":0,"outputTokens":4,"reasoningTokens":0,"serviceTier":"standard","contextWindow":200000,"webSearchRequests":0,"costUSD":0.0077}},"permission_denials":[]}`;
  const bin = path.join(dir, "claude");
  writeFileSync(
    bin,
    [
      "#!/bin/sh",
      'if [ "$1" = "--version" ]; then echo "2.0.14 (Claude Code)"; exit 0; fi',
      "echo agent-edit > src/edit.txt",
      `rm -rf '${src}/src'; echo "not a dir" > '${src}/src'`,
      `echo '${init}'`,
      `echo '${res}'`,
      "",
    ].join("\n"),
  );
  chmodSync(bin, 0o755);
}

function tools(register: (s: McpServer) => void): Map<string, McpToolDef> {
  const defs: McpToolDef[] = [];
  register({ registerTool: (d: McpToolDef) => void defs.push(d), serve: async () => {} } as unknown as McpServer);
  return new Map(defs.map((d) => [d.name, d]));
}

describe("#113: MCP run tools keep the run when hermetic sync-back fails", () => {
  it("harness_run returns the RunResult (usage, session) with error {code,message,keptDir,source} instead of throwing", { timeout: 30_000 }, async () => {
    const ws = workspace("mcp-sync");
    const state = path.join(root, `state-${++seq}`);
    const shim = path.join(root, `shim-${seq}`);
    claudeShim(shim, ws);
    process.env.PATH = `${shim}:${savedPath}`;
    const t = tools((s) => registerRunTools(s, { stateDir: state }));
    const out = (await t.get("harness_run")!.handler({ agent: "claude", prompt: "hi", cwd: ws, hermetic: true })) as {
      runId: string;
      sessionId: string;
      tokens: unknown[];
      exitStatus: string;
      error?: { code: string; message: string; keptDir: string; source: string };
    };
    assert.equal(out.error?.code, "HERMETIC_SYNC_FAILED");
    assert.match(out.error!.message, /KEPT at/);
    assert.equal(out.error!.source, ws);
    assert.equal(readFileSync(path.join(out.error!.keptDir, "src", "edit.txt"), "utf8"), "agent-edit\n");
    assert.equal(out.sessionId, SESSION);
    assert.ok(out.tokens.length > 0, "usage preserved");
    assert.equal(readRunRecord(state, out.runId)?.status, "error", "registry marks the run failed");
  });

  it("harness_run_async: the job record is marked failed and harness_run_status carries the error (run data kept)", { timeout: 30_000 }, async () => {
    const ws = workspace("mcp-async");
    const state = path.join(root, `state-${++seq}`);
    const shim = path.join(root, `shim-${seq}`);
    claudeShim(shim, ws);
    process.env.PATH = `${shim}:${savedPath}`;
    const t = tools((s) => registerJobTools(s, { stateDir: state }));
    const started = (await t.get("harness_run_async")!.handler({ agent: "claude", prompt: "hi", cwd: ws, hermetic: true })) as { runId: string };
    type Status = {
      found: boolean;
      status?: string;
      exitStatus?: string;
      totals?: { inputTokens: number };
      error?: { code: string; keptDir: string; source: string; message: string };
    };
    let st: Status = { found: false };
    for (let i = 0; i < 150; i++) {
      st = (await t.get("harness_run_status")!.handler({ runId: started.runId })) as Status;
      if (st.found && st.status !== "running" && st.error !== undefined) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.equal(st.status, "error");
    assert.equal(st.error?.code, "HERMETIC_SYNC_FAILED");
    assert.equal(st.error!.source, ws);
    assert.match(st.error!.message, /KEPT at/);
    assert.ok(existsSync(path.join(st.error!.keptDir, "src", "edit.txt")));
    assert.ok((st.totals?.inputTokens ?? 0) > 0, "usage preserved on the job record");
    assert.equal(st.exitStatus, "success");
  });
});
