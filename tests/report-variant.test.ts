// Variant grouping in `harness report` (spec §6.3): when trials carry a
// variant label the comparison table groups by variant (matching the live
// /compare view's default experiment×variant rollup); legacy trials keep the
// by-agent grouping. Also covers the source side: RunSpec.variant is echoed
// onto RunResult by the driver, so trial JSONs can carry it at all.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { after, before, describe, test } from "node:test";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDriver } from "../src/core/driver.ts";
import { RunResultSchema, RunSpecSchema } from "../src/core/types.ts";
import type { AgentEvent, AgentHandle, RunSpec } from "../src/core/types.ts";
import { loadTrials } from "../src/report/model.ts";
import { renderReport } from "../src/report/html.ts";

const CLI = new URL("../src/cli/ach.ts", import.meta.url).pathname;

function runCli(args: string[]): { code: number; stdout: string; stderr: string } {
  // bun runs .ts natively; node needs the tsx loader.
  const isBun = (process.versions as { bun?: string }).bun !== undefined;
  const p = spawnSync(process.execPath, isBun ? [CLI, ...args] : ["--import", "tsx", CLI, ...args], {
    encoding: "utf8",
  });
  return { code: p.status ?? -1, stdout: p.stdout ?? "", stderr: p.stderr ?? "" };
}

/** Minimal RunResult JSON that passes looksLikeRunResult. */
function resultJson(over: Record<string, unknown>): string {
  return JSON.stringify({
    runId: "r",
    sessionId: "s",
    events: [{ type: "session", timestamp: 1 }],
    tokens: [
      {
        agent: "a",
        model: "test-model",
        inputTokens: 100,
        outputTokens: 20,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        costUsd: 0.001,
        timestamp: 1,
      },
    ],
    totalCost: 0.001,
    durationMs: 1000,
    exitStatus: "success",
    warnings: [],
    ...over,
  });
}

async function writeTrial(
  root: string,
  label: string,
  name: string,
  over: Record<string, unknown>,
): Promise<void> {
  const dir = path.join(root, label);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${name}.json`), resultJson(over));
}

describe("report variant grouping (spec §6.3)", () => {
  let tmp: string;

  before(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "harness-report-variant-"));
    // Mixed: one run carries a variant, the other predates it.
    await writeTrial(tmp, "20260912-000001", "claude", { agent: "claude", variant: "ptr-prompt" });
    await writeTrial(tmp, "20260912-000001", "codex", { agent: "codex" });
    // All-legacy control: no variant anywhere.
    await writeTrial(tmp, "legacy", "claude", { agent: "claude" });
    await writeTrial(tmp, "legacy", "codex", { agent: "codex" });
  });
  after(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  test("any run carrying variant -> comparison groups by variant", async () => {
    const out = path.join(tmp, "mixed.html");
    const r = runCli(["report", path.join(tmp, "20260912-000001"), "--out", out]);
    assert.equal(r.code, 0, r.stderr);
    const html = await fs.readFile(out, "utf8");
    assert.match(html, /<th data-k="variant" data-t="s">variant<\/th>/);
    assert.ok(html.includes(">ptr-prompt</td>"), "variant value in the identity column");
    // the legacy identity header must be gone, not merely joined by it
    assert.doesNotMatch(html, /data-k="agent"/);
    // the variant-less run renders an empty cell, not a made-up label
    const tbody = html.slice(html.indexOf("<tbody"), html.indexOf("</tbody>"));
    assert.ok(/<td data-v="" class="agent-cell"><span class="muted">—<\/span><\/td>/.test(tbody));
    // per-agent detail sections are unchanged (identity stays per-run)
    assert.match(html, /<summary>claude /);
    assert.match(html, /<summary>codex /);
  });

  test("all-legacy fixture keeps the by-agent grouping exactly as before", async () => {
    const out = path.join(tmp, "legacy.html");
    const r = runCli(["report", path.join(tmp, "legacy"), "--out", out]);
    assert.equal(r.code, 0, r.stderr);
    const html = await fs.readFile(out, "utf8");
    assert.match(html, /<th data-k="agent" data-t="s">agent<\/th>/);
    assert.doesNotMatch(html, /data-k="variant"/);
    assert.ok(!html.includes(">variant</th>"), "no variant header");
    assert.ok(html.includes('>claude</td>'), "agent value in the identity column");
  });

  test("loadTrials lifts result.variant onto LoadedRun (absent stays absent)", async () => {
    const set = await loadTrials(path.join(tmp, "20260912-000001"));
    assert.equal(set.runs.length, 2);
    const labeled = set.runs.find((r) => r.agent === "claude");
    const plain = set.runs.find((r) => r.agent === "codex");
    assert.equal(labeled?.variant, "ptr-prompt");
    assert.equal(plain?.variant, undefined);
  });

  test("RunSpecSchema accepts a non-empty variant and rejects an empty one", () => {
    assert.equal(RunSpecSchema.parse({ prompt: "x", variant: "ptr-prompt" }).variant, "ptr-prompt");
    assert.throws(() => RunSpecSchema.parse({ prompt: "x", variant: "" }));
    assert.equal(RunSpecSchema.parse({ prompt: "x" }).variant, undefined);
  });

  test("RunResultSchema round-trips the echoed variant", () => {
    const parsed = RunResultSchema.parse(JSON.parse(resultJson({ variant: "ptr-prompt" })));
    assert.equal(parsed.variant, "ptr-prompt");
    assert.equal(RunResultSchema.parse(JSON.parse(resultJson({}))).variant, undefined);
    assert.throws(() => RunResultSchema.parse(JSON.parse(resultJson({ variant: "" }))));
  });
});

// ---------------------------------------------------------------------------
// Source side: the driver echoes spec.variant onto the RunResult so trial
// JSONs written from real runs can carry a variant at all.
// ---------------------------------------------------------------------------

class EchoHandle implements AgentHandle {
  sessionId = "echo-session";
  async *attach(): AsyncIterable<AgentEvent> {
    yield { type: "step", sessionId: this.sessionId, timestamp: Date.now() };
  }
  abort(): void {}
  async wait() {
    return "success" as const;
  }
}

describe("driver echoes spec.variant onto RunResult", () => {
  function tmpStateDir(): string {
    return fsSync.mkdtempSync(path.join(os.tmpdir(), "harness-driver-variant-"));
  }
  function driver() {
    return createDriver({ adapters: { mock: { name: "mock", launch: async () => new EchoHandle() } }, stateDir: tmpStateDir() });
  }

  test("spec.variant is echoed back", async () => {
    const spec: RunSpec = { prompt: "hi", variant: "ptr-prompt" };
    const result = await driver().run("mock", spec);
    assert.equal(result.variant, "ptr-prompt");
  });

  test("no variant in the spec -> none on the result (no invented data)", async () => {
    const result = await driver().run("mock", { prompt: "hi" });
    assert.equal(result.variant, undefined);
  });
});
