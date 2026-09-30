// #105 follow-up: `ach watch` bills cache writes per TTL, like `ach stats`.
//
// Real CLI: a claude machine transcript with all writes in the 1h tier is
// replayed by `ach watch --since`; the printed cost must equal the pricer's
// 1h-rate cost. Control: the same tokens with no TTL split price at the 5m rate.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { createPricer } from "../src/core/pricing.ts";

const CLI = new URL("../src/cli/ach.ts", import.meta.url).pathname;
const MODEL = "claude-opus-5-5";
const WRITES = 1_000_000;

async function watchOnce(home: string, stateDir: string): Promise<{ stdout: string; stderr: string; ticked: boolean }> {
  const isBun = (process.versions as { bun?: string }).bun !== undefined;
  const child = spawn(process.execPath, isBun ? [CLI, "watch", "--since", "2026-09-01"] : ["--import", "tsx", CLI, "watch", "--since", "2026-09-01"], {
    env: { ...process.env, HOME: home, AGENTIC_CODING_HARNESS_STATE_DIR: stateDir, AGENTIC_CODING_HARNESS_TZ: "" },
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => (stdout += String(d)));
  child.stderr.on("data", (d) => (stderr += String(d)));
  const offsets = path.join(stateDir, "offsets.json");
  let ticked = false;
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline && child.exitCode === null) {
    try {
      await fs.access(offsets);
      ticked = true;
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  const exited = new Promise((r) => child.once("close", r));
  child.kill("SIGKILL");
  await exited;
  return { stdout, stderr, ticked };
}

function line(sessionId: string, withSplit: boolean): string {
  return (
    JSON.stringify({
      type: "assistant",
      timestamp: "2026-09-05T10:00:00.000Z",
      sessionId,
      requestId: `req-${sessionId}`,
      message: {
        id: `msg_${sessionId}`,
        model: MODEL,
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          cache_creation_input_tokens: WRITES,
          ...(withSplit ? { cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: WRITES } } : {}),
        },
      },
    }) + "\n"
  );
}

describe("ach watch prices 1h cache writes at the 1h rate (#105)", () => {
  let home = "";
  before(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), "watch-1h-"));
    const dir = path.join(home, ".claude", "projects", "proj");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "s1h.jsonl"), line("sess-1h", true));
    await fs.writeFile(path.join(dir, "s5m.jsonl"), line("sess-5m", false));
  });
  after(async () => {
    await fs.rm(home, { recursive: true, force: true });
  });

  it("split -> 1h rate; no split -> 5m rate (control)", async () => {
    const pricer = createPricer();
    const rate1h = pricer.price({ model: MODEL, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: WRITES, cacheWrite1hTokens: WRITES });
    const rate5m = pricer.price({ model: MODEL, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: WRITES });
    assert.ok(rate1h > rate5m, "fixture must distinguish the tiers");

    const r = await watchOnce(home, path.join(home, "state"));
    assert.equal(r.ticked, true, r.stderr);
    const cost = (sid: string): string => {
      const m = new RegExp(`${sid}\\s.*cacheW\\s+\\$(\\d+\\.\\d{4})`).exec(r.stdout);
      assert.ok(m, `no watch line for ${sid}:\n${r.stdout}`);
      return m[1]!;
    };
    assert.equal(cost("sess-1h"), rate1h.toFixed(4));
    assert.equal(cost("sess-5m"), rate5m.toFixed(4));
  });
});
