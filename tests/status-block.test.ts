// Integration seam (0.11.0): s11's current 5h block accounting
// (src/core/usage-windows.ts currentBlock) feeds s08's BlockCostProvider, so
// `ach status` and `ach statusline` show a real block cost instead of n/a.
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { after, before, describe, it } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { computeStatusSnapshot, currentBlockCost, type StatusSnapshot } from "../src/cli/status.ts";

const CLI = fileURLToPath(new URL("../src/cli/ach.ts", import.meta.url));
const STATE_ENV = "AGENTIC_CODING_HARNESS_STATE_DIR";
const BUDGET_ENV = "AGENTIC_CODING_HARNESS_BUDGET_USD";
const HOUR = 3_600_000;
const NOW = Date.now();

function cliArgv(args: string[]): string[] {
  const isBun = (process.versions as { bun?: string }).bun !== undefined;
  return isBun ? [CLI, ...args] : ["--import", "tsx", CLI, ...args];
}

function runCli(args: string[], env: Record<string, string | undefined>, input = ""): { code: number; stdout: string; stderr: string } {
  const merged: Record<string, string | undefined> = { ...process.env, ...env };
  for (const [k, v] of Object.entries(env)) if (v === undefined) delete merged[k];
  const p = spawnSync(process.execPath, cliArgv(args), { env: merged as NodeJS.ProcessEnv, encoding: "utf8", input });
  return { code: p.status ?? -1, stdout: p.stdout ?? "", stderr: p.stderr ?? "" };
}

function row(agent: string, tsMs: number, costUsd: number | undefined): Record<string, unknown> {
  return {
    ts: new Date(tsMs).toISOString(),
    agent,
    sessionId: `s-${agent}`,
    model: agent === "claude" ? "claude-sonnet-4-5" : "gpt-5",
    inputTokens: 100,
    outputTokens: 10,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    ...(costUsd === undefined ? {} : { costUsd }),
  };
}

function seed(dir: string, rows: Record<string, unknown>[]): void {
  const byAgent = new Map<string, Record<string, unknown>[]>();
  for (const r of rows) byAgent.set(r.agent as string, [...(byAgent.get(r.agent as string) ?? []), r]);
  for (const [agent, rs] of byAgent) {
    const f = path.join(dir, "raw", agent, `s-${agent}.jsonl`);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, rs.map((r) => JSON.stringify(r)).join("\n") + "\n");
  }
}

async function withState<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const prev = process.env[STATE_ENV];
  process.env[STATE_ENV] = dir;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env[STATE_ENV];
    else process.env[STATE_ENV] = prev;
  }
}

describe("status block cost from currentBlock (#18 x #45/#61 seam)", () => {
  let active: string; // claude records 2h and 1h ago (0.5 + 0.25) + codex (not a block agent)
  let closed: string; // only a claude record 12h ago: its block ended, none is open
  let unpriced: string; // active block whose only record has no price
  let empty: string;
  before(() => {
    active = fs.mkdtempSync(path.join(os.tmpdir(), "ach-blk-active-"));
    seed(active, [row("claude", NOW - 2 * HOUR, 0.5), row("claude", NOW - HOUR, 0.25), row("codex", NOW - HOUR, 4)]);
    closed = fs.mkdtempSync(path.join(os.tmpdir(), "ach-blk-closed-"));
    seed(closed, [row("claude", NOW - 12 * HOUR, 3)]);
    unpriced = fs.mkdtempSync(path.join(os.tmpdir(), "ach-blk-unpriced-"));
    seed(unpriced, [row("claude", NOW - HOUR, undefined)]);
    empty = fs.mkdtempSync(path.join(os.tmpdir(), "ach-blk-empty-"));
  });
  after(() => {
    for (const d of [active, closed, unpriced, empty]) fs.rmSync(d, { recursive: true, force: true });
  });

  it("currentBlockCost: the open claude block's priced cost; codex never counts", async () => {
    const snap = await withState(active, () => computeStatusSnapshot({ now: NOW, blockCost: currentBlockCost }));
    assert.deepEqual(snap.block, { costUsd: 0.75, source: "provider" });
  });

  it("currentBlockCost: null (n/a) when no block is open and on an empty state dir", async () => {
    for (const dir of [closed, empty]) {
      const snap = await withState(dir, () => computeStatusSnapshot({ now: NOW, blockCost: currentBlockCost }));
      assert.deepEqual(snap.block, { costUsd: null, source: "unavailable" }, dir);
    }
  });

  it("currentBlockCost: null when the open block has no priced record (e.g. an unknown model via --transcripts)", () => {
    // The state store defaults a missing costUsd to 0 on read, so an unpriced
    // block is only reachable through transcript records; feed them directly.
    const recs = [{ ...row("claude", NOW - HOUR, undefined), costUsd: undefined }] as never[];
    assert.equal(currentBlockCost({ now: NOW, stateDir: unpriced, records: recs }), null);
    const priced = [row("claude", NOW - HOUR, 0.4)] as never[];
    assert.equal(currentBlockCost({ now: NOW, stateDir: unpriced, records: priced }), 0.4);
  });

  it("the provider sees the snapshot's own records (no second scan)", async () => {
    let seen: number | undefined;
    await withState(active, () =>
      computeStatusSnapshot({
        now: NOW,
        blockCost: (ctx) => {
          seen = ctx.records?.length;
          return null;
        },
      }),
    );
    assert.equal(seen, 3);
  });

  it("CLI: `ach status --json` and the human block line carry the block cost", () => {
    const j = runCli(["status", "--json"], { [STATE_ENV]: active, [BUDGET_ENV]: undefined });
    assert.equal(j.code, 0, j.stderr);
    assert.deepEqual((JSON.parse(j.stdout) as StatusSnapshot).block, { costUsd: 0.75, source: "provider" });
    const h = runCli(["status"], { [STATE_ENV]: active, [BUDGET_ENV]: undefined });
    assert.match(h.stdout, /^block\s+\$0\.7500$/m);
    const none = runCli(["status"], { [STATE_ENV]: closed, [BUDGET_ENV]: undefined });
    assert.match(none.stdout, /^block\s+n\/a$/m);
  });

  it("CLI: `ach statusline` shows the block cost", () => {
    const r = runCli(["statusline", "--no-cache"], { [STATE_ENV]: active, [BUDGET_ENV]: undefined }, "");
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout, "n/a · session n/a · today $4.7500 · block $0.7500\n");
  });
});
