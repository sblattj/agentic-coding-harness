// #13 gap 1: the sandbox policy on `ach trial --matrix` plans and the MCP
// harness_run / harness_run_async tools (shared logic: src/core/sandbox-policy.ts).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { claudeSandboxArgs } from "../src/adapters/claude.ts";
import { expandMatrix, matrixSandboxWarnings, parseMatrixPlan, readLedger, runMatrix } from "../src/cli/trial-matrix.ts";
import type { Driver } from "../src/core/driver.ts";
import { SandboxInputSchema, sandboxDropWarnings } from "../src/core/sandbox-policy.ts";
import type { RunResult, RunSpec } from "../src/core/types.ts";
import { toSpec } from "../src/mcp/tools-jobs.ts";
import { registerRunTools, RunArgsSchema, toRunSpec } from "../src/mcp/tools-run.ts";
import type { McpToolDef } from "../src/mcp/contract.ts";

const CLI = new URL("../src/cli/ach.ts", import.meta.url).pathname;
let root: string;
before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "ach-sandbox-surfaces-"));
});
after(() => fs.rmSync(root, { recursive: true, force: true }));

const planWith = (extra: Record<string, unknown>) =>
  parseMatrixPlan({
    experiment: "sb",
    agents: ["claude"],
    tasks: [{ id: "t1", prompt: "p", workspace: "fresh" }],
    ...extra,
  });

describe("matrix plan sandbox", () => {
  it("plan-level sandbox reaches every cell; task override wins field-wise", () => {
    const plan = planWith({
      sandbox: { permissionMode: "acceptEdits", allowedTools: ["Read"] },
      tasks: [
        { id: "t1", prompt: "p", workspace: "fresh" },
        { id: "t2", prompt: "p", workspace: "fresh", sandbox: { permissionMode: "bypassPermissions" } },
      ],
    });
    const cells = expandMatrix(plan, root);
    assert.deepEqual(cells[0]!.sandbox, { permissionMode: "acceptEdits", allowedTools: ["Read"] });
    assert.deepEqual(cells[1]!.sandbox, { permissionMode: "bypassPermissions", allowedTools: ["Read"] });
  });

  it("agent-entry sandbox beats plan, task beats agent", () => {
    const plan = planWith({
      sandbox: { permissionMode: "ask" },
      agents: [{ agent: "claude", sandbox: { permissionMode: "acceptEdits" } }, "codex"],
      tasks: [{ id: "t1", prompt: "p", workspace: "fresh" }, { id: "t2", prompt: "p", workspace: "fresh", sandbox: { permissionMode: "bypassPermissions" } }],
    });
    const modes = expandMatrix(plan, root).map((c) => `${c.agent}:${c.task.id}=${c.sandbox?.permissionMode}`);
    assert.deepEqual(modes, ["claude:t1=acceptEdits", "claude:t2=bypassPermissions", "codex:t1=ask", "codex:t2=bypassPermissions"]);
  });

  it("the cell override becomes a TaskSpec whose sandbox gives claude --permission-mode, and the ledger records it redacted", async () => {
    const plan = planWith({
      sandbox: { permissionMode: "acceptEdits", mcpConfig: { mcpServers: { s: { env: { TOKEN: "secret-token" } } } } },
      tasks: [{ id: "t1", prompt: "p", workspace: "fresh", sandbox: { permissionMode: "bypassPermissions", allowedTools: ["Bash"] } }],
    });
    const cells = expandMatrix(plan, root);
    const seen: RunSpec[] = [];
    const driver: Pick<Driver, "run"> = {
      run: async (_agent: string, spec: RunSpec) => {
        seen.push(spec);
        return { runId: "r1", exitStatus: "success", events: [], tokens: [], warnings: [], totalCost: 0, durationMs: 1 } as unknown as RunResult;
      },
    };
    const dir = path.join(root, "led");
    fs.mkdirSync(dir, { recursive: true });
    const ledgerPath = path.join(dir, "l.ledger.jsonl");
    await runMatrix({ cells, ledgerPath, driver, stateDir: dir, workRoot: path.join(dir, "w") });
    assert.equal(seen.length, 1);
    const args = claudeSandboxArgs(seen[0]!.sandbox!);
    assert.equal(args[args.indexOf("--permission-mode") + 1], "bypassPermissions");
    assert.ok(args.includes("--allowedTools"));
    const row = readLedger(ledgerPath).rows[0]!;
    assert.equal(row.sandbox?.permissionMode, "bypassPermissions");
    assert.match(String(row.sandbox?.mcpConfig), /^<inline JSON, \d+ bytes>$/);
    assert.ok(!fs.readFileSync(ledgerPath, "utf8").includes("secret-token"));
  });

  it("warns once per agent and field the agent drops", () => {
    const plan = planWith({
      agents: ["claude", "codex", "opencode"],
      sandbox: { permissionMode: "acceptEdits", allowedTools: ["Read"] },
      tasks: [{ id: "t1", prompt: "p", workspace: "fresh" }, { id: "t2", prompt: "p", workspace: "fresh" }],
    });
    const w = matrixSandboxWarnings(expandMatrix(plan, root));
    assert.equal(w.filter((x) => x.includes("'claude'")).length, 0);
    assert.equal(w.filter((x) => x.includes("'codex'")).length, 1);
    assert.match(w.find((x) => x.includes("'codex'"))!, /sandbox\.allowedTools is not supported by agent 'codex'/);
    assert.equal(w.filter((x) => x.includes("'opencode'")).length, 2);
  });

  it("ach trial --matrix --dry-run prints the warning and lists the resolved sandbox", () => {
    const file = path.join(root, "plan.json");
    fs.writeFileSync(
      file,
      JSON.stringify({
        experiment: "sb",
        agents: ["codex"],
        sandbox: { allowedTools: ["Read"] },
        tasks: [{ id: "t1", prompt: "p", workspace: "fresh" }],
      }),
    );
    const isBun = (process.versions as { bun?: string }).bun !== undefined;
    const p = spawnSync(process.execPath, isBun ? [CLI, "trial", "--matrix", file, "--dry-run", "--json"] : ["--import", import.meta.resolve("tsx"), CLI, "trial", "--matrix", file, "--dry-run", "--json"], {
      env: { ...process.env, AGENTIC_CODING_HARNESS_STATE_DIR: path.join(root, "st"), HOME: root },
      encoding: "utf8",
    });
    assert.equal(p.status, 0, p.stderr);
    assert.match(p.stderr, /\[warn\] sandbox\.allowedTools is not supported by agent 'codex'/);
    const out = JSON.parse(p.stdout) as { cells: { sandbox?: unknown }[]; sandboxWarnings: string[] };
    assert.deepEqual(out.cells[0]!.sandbox, { allowedTools: ["Read"] });
    assert.equal(out.sandboxWarnings.length, 1);
  });

  it("rejects an invalid sandbox in the plan", () => {
    for (const bad of [{ permissionMode: "" }, { allowedTools: [] }, { allowedTools: "Bash" }, { bogus: 1 }, { scrubEnv: true }, { mcpConfig: "{not json" }]) {
      assert.throws(() => planWith({ sandbox: bad }), /invalid matrix plan: .*sandbox/, JSON.stringify(bad));
    }
    assert.throws(() => planWith({ agents: [{ agent: "claude", sandbox: { nope: 1 } }] }), /sandbox/);
  });
});

describe("MCP harness_run sandbox", () => {
  const base = { agent: "claude", prompt: "hi" };

  it("converts input into a RunSpec with a sandbox (both harness_run and harness_run_async)", () => {
    const a = RunArgsSchema.parse({ ...base, sandbox: { permissionMode: "bypassPermissions", allowedTools: ["Bash", "Read"], mcpConfig: '{"mcpServers":{}}' } });
    const spec = toRunSpec(a, []);
    assert.deepEqual(spec.sandbox, { permissionMode: "bypassPermissions", allowedTools: ["Bash", "Read"], mcpConfig: { mcpServers: {} } });
    assert.deepEqual(toSpec(a, "rid").sandbox, spec.sandbox);
    assert.ok(claudeSandboxArgs(spec.sandbox!).includes("--permission-mode"));
    assert.equal(toRunSpec(RunArgsSchema.parse(base), []).sandbox, undefined);
  });

  it("rejects invalid input", () => {
    for (const bad of [{ permissionMode: "  " }, { allowedTools: [] }, { allowedTools: "Bash" }, { extra: 1 }, { scrubEnv: true }, { mcpConfig: "{oops" }, { mcpConfig: "" }]) {
      assert.equal(RunArgsSchema.safeParse({ ...base, sandbox: bad }).success, false, JSON.stringify(bad));
    }
  });

  it("returns dropped-field warnings in the result and echoes the policy redacted", async () => {
    const tools = new Map<string, McpToolDef>();
    registerRunTools({ registerTool: (d: McpToolDef) => void tools.set(d.name, d) } as never, { stateDir: path.join(root, "mcp-state") });
    const run = tools.get("harness_run")!;
    assert.ok("sandbox" in (run.inputSchema as { properties: object }).properties);
    assert.match(run.description, /sandbox/);
    const res = (await run.handler({
      agent: "null",
      prompt: "hi",
      sandbox: { allowedTools: ["Read"], mcpConfig: { mcpServers: { s: { env: { T: "secret-token" } } } } },
    })) as { warnings: string[]; sandbox: Record<string, unknown> };
    assert.ok(res.warnings.some((w) => w.includes("sandbox.allowedTools is not supported by agent 'null'")));
    assert.ok(res.warnings.some((w) => w.includes("sandbox.mcpConfig")));
    assert.match(String(res.sandbox.mcpConfig), /^<inline JSON, \d+ bytes>$/);
    assert.ok(!JSON.stringify(res).includes("secret-token"));
    await assert.rejects(() => run.handler({ agent: "null", prompt: "hi", sandbox: { allowedTools: [] } }), /bad field 'sandbox/);
  });
});

describe("shared helpers", () => {
  it("field-style and flag-style warnings differ; flag style unchanged", () => {
    const p = SandboxInputSchema.parse({ allowedTools: ["Read"] });
    assert.match(sandboxDropWarnings("codex", p)[0]!, /^--allowed-tools is not supported by agent 'codex'/);
    assert.match(sandboxDropWarnings("codex", p, { style: "field" })[0]!, /^sandbox\.allowedTools is not supported/);
  });
});
