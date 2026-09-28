// `--dir` means a transcript root for `stats`/`watch` but a state dir for
// `archive`/`audit`/`dash`/`web` (0.11.1 drift item). Each command now also
// accepts the unambiguous spelling (`--transcript-dir` / `--state-dir`);
// `--dir` keeps working unchanged, and giving both with different values is a
// usage error rather than a silent pick.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { after, describe, it } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resolveDirFlag } from "../src/cli/lib.ts";
import { HarnessError } from "../src/core/types.ts";

const CLI = new URL("../src/cli/ach.ts", import.meta.url).pathname;

function runCli(args: string[], env: Record<string, string>): { code: number; stdout: string; stderr: string } {
  const isBun = (process.versions as { bun?: string }).bun !== undefined;
  const base: Record<string, string | undefined> = { ...process.env };
  delete base.AGENTIC_CODING_HARNESS_COST_MODE;
  const p = spawnSync(process.execPath, isBun ? [CLI, ...args] : ["--import", "tsx", CLI, ...args], {
    env: { ...base, AGENTIC_CODING_HARNESS_TZ: "UTC", ...env } as NodeJS.ProcessEnv,
    encoding: "utf8",
    timeout: 60_000,
  });
  return { code: p.status ?? -1, stdout: p.stdout ?? "", stderr: p.stderr ?? "" };
}

function writeJsonl(file: string, rows: unknown[]): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
}

describe("--dir aliases", () => {
  const tmps: string[] = [];
  const mk = (p: string) => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), p));
    tmps.push(d);
    return d;
  };
  after(() => {
    for (const d of tmps) fs.rmSync(d, { recursive: true, force: true });
  });
  /** Isolated env: empty HOME and an empty default state dir. */
  const isolated = () => ({ HOME: mk("ach-alias-home-"), AGENTIC_CODING_HARNESS_STATE_DIR: mk("ach-alias-default-state-") });

  it("resolveDirFlag: alias, --dir, both-equal and conflict", () => {
    assert.equal(resolveDirFlag({}, "state-dir"), undefined);
    assert.equal(resolveDirFlag({ dir: "/a" }, "state-dir"), "/a");
    assert.equal(resolveDirFlag({ "state-dir": "/a" }, "state-dir"), "/a");
    assert.equal(resolveDirFlag({ dir: "/a", "transcript-dir": "/a" }, "transcript-dir"), "/a");
    // Same directory spelled differently is not a conflict.
    assert.equal(resolveDirFlag({ dir: "/a/", "state-dir": "/a" }, "state-dir"), "/a");
    assert.equal(resolveDirFlag({ dir: "/a/b/../b", "state-dir": "/a/b" }, "state-dir"), "/a/b");
    assert.throws(
      () => resolveDirFlag({ dir: "/a", "state-dir": "/b" }, "state-dir"),
      (e: unknown) => e instanceof HarnessError && e.code === "USAGE" && /--state-dir/.test(e.message) && /--dir/.test(e.message),
    );
  });

  it("stats --transcript-dir reads the same home-shaped root as stats --dir", () => {
    const root = mk("ach-alias-root-");
    writeJsonl(path.join(root, ".claude", "projects", "p1", "sess-a.jsonl"), [
      {
        type: "assistant",
        timestamp: new Date(Date.now() - 3_600_000).toISOString(),
        sessionId: "sess-a",
        requestId: "req-1",
        message: { id: "msg_1", model: "claude-sonnet-4-5", usage: { input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
      },
    ]);
    const env = isolated();
    const viaDir = runCli(["stats", "--json", "--dir", root], env);
    const viaAlias = runCli(["stats", "--json", "--transcript-dir", root], env);
    assert.equal(viaDir.code, 0, viaDir.stderr);
    assert.equal(viaAlias.code, 0, viaAlias.stderr);
    const a = JSON.parse(viaAlias.stdout).total;
    assert.equal(a.records, 1, "the alias must actually read the root");
    assert.deepEqual(a, JSON.parse(viaDir.stdout).total);
  });

  it("stats and watch reject --dir and --transcript-dir that disagree", () => {
    const env = isolated();
    const a = mk("ach-alias-a-");
    const b = mk("ach-alias-b-");
    for (const cmd of ["stats", "watch"]) {
      const r = runCli([cmd, "--dir", a, "--transcript-dir", b], env);
      assert.notEqual(r.code, 0, `${cmd} must fail`);
      assert.match(r.stderr, /--transcript-dir/);
    }
  });

  it("audit --state-dir reads the same state dir as audit --dir", () => {
    const state = mk("ach-alias-audit-");
    fs.mkdirSync(path.join(state, "runs"), { recursive: true });
    fs.writeFileSync(
      path.join(state, "runs", "r1.json"),
      JSON.stringify({ runId: "r1", agent: "claude", pid: 1, startedAt: Date.now() - 60_000, updatedAt: Date.now(), status: "success" }),
    );
    const env = isolated();
    const viaDir = runCli(["audit", "--dir", state, "--json"], env);
    const viaAlias = runCli(["audit", "--state-dir", state, "--json"], env);
    assert.equal(viaAlias.stdout, viaDir.stdout);
    assert.equal(viaAlias.code, viaDir.code);
    const other = runCli(["audit", "--json"], env);
    assert.notEqual(viaAlias.stdout, other.stdout, "control: the default state dir must read differently");
  });

  it("dash --state-dir lists the runs of that state dir, like dash --dir", () => {
    const state = mk("ach-alias-dash-");
    fs.mkdirSync(path.join(state, "runs"), { recursive: true });
    fs.writeFileSync(
      path.join(state, "runs", "r-dash.json"),
      JSON.stringify({ runId: "r-dash", agent: "claude", pid: 1, startedAt: Date.now() - 60_000, updatedAt: Date.now(), status: "success" }),
    );
    const env = isolated();
    const viaDir = runCli(["dash", "--json", "--all", "--state-only", "--dir", state], env);
    const viaAlias = runCli(["dash", "--json", "--all", "--state-only", "--state-dir", state], env);
    assert.equal(viaAlias.code, 0, viaAlias.stderr);
    const ids = (s: string) => (JSON.parse(s) as { runId: string }[]).map((r) => r.runId);
    assert.deepEqual(ids(viaAlias.stdout), ["r-dash"]);
    assert.deepEqual(ids(viaAlias.stdout), ids(viaDir.stdout));
  });

  it("archive --state-dir archives out of that state dir, like archive --dir", () => {
    const env = isolated();
    const state = mk("ach-alias-archive-");
    const out = mk("ach-alias-archive-out-");
    const r = runCli(["archive", "--state-dir", state, "--out", out, "--json"], env);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).warehouseDir, out);
    const conflict = runCli(["archive", "--dir", state, "--state-dir", out, "--json"], env);
    assert.notEqual(conflict.code, 0);
    assert.match(conflict.stderr, /--state-dir/);
  });

  it("audit, dash and web reject --dir and --state-dir that disagree", () => {
    const env = isolated();
    const a = mk("ach-alias-a-");
    const b = mk("ach-alias-b-");
    for (const args of [["audit", "--json"], ["dash", "--json"], ["web", "--no-open", "--port", "0"]]) {
      const r = runCli([...args, "--dir", a, "--state-dir", b], env);
      assert.notEqual(r.code, 0, `${args[0]} must fail`);
      assert.match(r.stderr, /--state-dir/);
    }
  });

  it("help says which kind of directory each command's --dir is", () => {
    const r = runCli(["--help"], isolated());
    const text = r.stdout + r.stderr;
    assert.match(text, /ach watch \[--transcript-dir <home-shaped-root>\]/);
    assert.match(text, /\[--transcript-dir <root>\]/);
    assert.match(text, /ach archive .*\[--state-dir <stateDir>\]/);
    assert.match(text, /ach audit .*\[--state-dir <stateDir>\]/);
    assert.match(text, /ach dash .*\[--state-dir <stateDir>\]/);
    assert.match(text, /\[--state-dir <stateDir>\]/);
    assert.match(text, /--dir is an alias/);
  });
});
