// Integration seam (0.11.0): s07's automation exit-code ladder (#31) reaches
// `ach status` (#45): nothing to report => 30 under `--exit-codes ladder`,
// exactly like `ach stats`; the default stays 0.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { after, before, describe, it } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CLI = new URL("../src/cli/ach.ts", import.meta.url).pathname;
const STATE_ENV = "AGENTIC_CODING_HARNESS_STATE_DIR";
const BUDGET_ENV = "AGENTIC_CODING_HARNESS_BUDGET_USD";

function cliArgv(args: string[]): string[] {
  const isBun = (process.versions as { bun?: string }).bun !== undefined;
  return isBun ? [CLI, ...args] : ["--import", "tsx", CLI, ...args];
}

function runCli(args: string[], state: string): { code: number; stdout: string; stderr: string } {
  const env: Record<string, string | undefined> = { ...process.env, [STATE_ENV]: state };
  delete env[BUDGET_ENV];
  const p = spawnSync(process.execPath, cliArgv(args), { env: env as NodeJS.ProcessEnv, encoding: "utf8" });
  return { code: p.status ?? -1, stdout: p.stdout ?? "", stderr: p.stderr ?? "" };
}

describe("ach status --exit-codes (#31 x #45)", () => {
  let empty: string;
  let withRun: string;
  let withSpend: string;
  before(() => {
    empty = fs.mkdtempSync(path.join(os.tmpdir(), "ach-stx-empty-"));
    withRun = fs.mkdtempSync(path.join(os.tmpdir(), "ach-stx-run-"));
    fs.mkdirSync(path.join(withRun, "runs"), { recursive: true });
    fs.writeFileSync(
      path.join(withRun, "runs", "r1.json"),
      JSON.stringify({ runId: "r1", agent: "codex", pid: 1, startedAt: Date.now() - 60_000, status: "success" }),
    );
    withSpend = fs.mkdtempSync(path.join(os.tmpdir(), "ach-stx-spend-"));
    const f = path.join(withSpend, "raw", "codex", "s.jsonl");
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(
      f,
      JSON.stringify({
        ts: new Date(Date.now() - 3_600_000).toISOString(),
        agent: "codex",
        sessionId: "s",
        model: "gpt-5",
        inputTokens: 1,
        outputTokens: 1,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        costUsd: 0.1,
      }) + "\n",
    );
  });
  after(() => {
    for (const d of [empty, withRun, withSpend]) fs.rmSync(d, { recursive: true, force: true });
  });

  it("ladder: zero runs and zero usage records exits 30 (every output mode, and --write-state --once)", () => {
    for (const extra of [[], ["--compact"], ["--json"]]) {
      const r = runCli(["status", ...extra, "--exit-codes", "ladder"], empty);
      assert.equal(r.code, 30, `${extra.join(" ")}: ${r.stderr}`);
      assert.notEqual(r.stdout, "", "the snapshot is still printed");
    }
    const target = path.join(empty, "snap.json");
    const w = runCli(["status", "--write-state", target, "--once", "--exit-codes", "ladder"], empty);
    assert.equal(w.code, 30, w.stderr);
    assert.ok(fs.existsSync(target));
  });

  it("ladder: a run or a usage record in the window is something to report => 0", () => {
    for (const dir of [withRun, withSpend]) {
      const r = runCli(["status", "--compact", "--exit-codes", "ladder"], dir);
      assert.equal(r.code, 0, r.stderr);
    }
  });

  it("default and explicit binary mode stay 0 on an empty state dir", () => {
    assert.equal(runCli(["status", "--compact"], empty).code, 0);
    assert.equal(runCli(["status", "--compact", "--exit-codes", "binary"], empty).code, 0);
  });

  it("an unknown --exit-codes value is a usage error (exit 1)", () => {
    const r = runCli(["status", "--exit-codes", "rainbow"], empty);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /--exit-codes expects 'ladder' or 'binary'/);
  });
});
