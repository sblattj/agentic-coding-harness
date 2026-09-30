// ach audit (#34): re-derive RunRecord totals from raw transcripts.
//
// Fixtures are produced by the REAL driver (createDriver + a scripted adapter)
// so "untouched state dir" means exactly what `ach run` would have written;
// drift is injected either through the adapter (a misparse the driver records
// faithfully) or by editing the recorded totals afterwards.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { auditRuns, extractRawTokens } from "../src/cli/audit.ts";
import { createDriver } from "../src/core/driver.ts";
import { createPricer } from "../src/core/pricing.ts";
import { listRunRecords, readRunRecord, writeRunRecord, type RunRecord } from "../src/core/registry.ts";
import type { AgentAdapter, AgentEvent, AgentHandle } from "../src/core/types.ts";

const CLI = new URL("../src/cli/ach.ts", import.meta.url).pathname;

function runCli(args: string[], env: Record<string, string> = {}): { code: number; stdout: string; stderr: string } {
  const isBun = (process.versions as { bun?: string }).bun !== undefined;
  const p = spawnSync(process.execPath, isBun ? [CLI, ...args] : ["--import", "tsx", CLI, ...args], {
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
  return { code: p.status ?? -1, stdout: p.stdout ?? "", stderr: p.stderr ?? "" };
}

function tmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

type Scripted = Record<string, unknown>;

class ScriptedHandle implements AgentHandle {
  constructor(
    readonly sessionId: string,
    private readonly events: Scripted[],
  ) {}
  async *attach(): AsyncIterable<AgentEvent> {
    for (const e of this.events) {
      yield { ...e, sessionId: this.sessionId, timestamp: Date.now() } as AgentEvent;
    }
  }
  abort(): void {}
  async wait(): Promise<"success"> {
    return "success";
  }
}

class ScriptedAdapter implements AgentAdapter {
  constructor(
    readonly name: string,
    private readonly events: Scripted[],
    private readonly sessionId: string,
  ) {}
  async launch(): Promise<AgentHandle> {
    return new ScriptedHandle(this.sessionId, this.events);
  }
}

const SONNET = "claude-sonnet-4-5-20250929";

/** The claude adapter's wire: {type:'usage', usage:<pre-normalized>, data:<raw>}
 *  (houseEventToCore in src/adapters/shared.ts). `usageOverride` lets a test
 *  make the adapter's pre-normalized record disagree with its own raw payload. */
function claudeUsage(
  raw: { input: number; output: number; cacheRead: number; cacheWrite: number },
  usageOverride: Partial<Record<"inputTokens" | "outputTokens" | "cacheReadTokens" | "cacheWriteTokens", number>> = {},
): Scripted {
  const data = { ...raw, reasoning: 0, models: [{ model: SONNET, ...raw, reasoning: 0 }] };
  return {
    type: "usage",
    agent: "claude",
    usage: {
      agent: "claude",
      model: SONNET,
      inputTokens: raw.input,
      outputTokens: raw.output,
      cacheReadTokens: raw.cacheRead,
      cacheWriteTokens: raw.cacheWrite,
      ...usageOverride,
      extra: { totalTokens: null, durationMs: null, raw: data },
    },
    data,
  };
}

/** codex native turn.completed usage on the usage_raw lane. */
function codexRaw(): Scripted {
  return {
    type: "usage_raw",
    agent: "codex",
    data: { input_tokens: 1200, cached_input_tokens: 200, output_tokens: 300, reasoning_output_tokens: 40 },
  };
}

async function driverRun(stateDir: string, agent: string, sessionId: string, events: Scripted[]): Promise<RunRecord> {
  const driver = createDriver({
    adapters: { [agent]: new ScriptedAdapter(agent, events, sessionId) },
    stateDir,
    registry: { stateDir },
  });
  const res = await driver.run(agent, { prompt: `audit fixture ${sessionId}` });
  const rec = readRunRecord(stateDir, res.runId);
  assert.ok(rec, "driver wrote a RunRecord");
  return rec;
}

/** An untouched state dir: two claude runs and one codex run, as the driver wrote them. */
async function untouchedStateDir(): Promise<{ dir: string; claude: RunRecord; claude2: RunRecord; codex: RunRecord }> {
  const dir = tmp("ach-audit-");
  const claude = await driverRun(dir, "claude", "s-claude-1", [
    { type: "step" },
    claudeUsage({ input: 1000, output: 500, cacheRead: 20000, cacheWrite: 3000 }),
    claudeUsage({ input: 40, output: 90, cacheRead: 23000, cacheWrite: 0 }),
  ]);
  const claude2 = await driverRun(dir, "claude", "s-claude-2", [
    claudeUsage({ input: 7, output: 11, cacheRead: 0, cacheWrite: 1500 }),
  ]);
  const codex = await driverRun(dir, "codex", "s-codex-1", [{ type: "step" }, codexRaw()]);
  return { dir, claude, claude2, codex };
}

function editTotals(dir: string, runId: string, patch: Partial<NonNullable<RunRecord["totals"]>>): void {
  const file = path.join(dir, "runs", `${runId}.json`);
  const doc = JSON.parse(fs.readFileSync(file, "utf8")) as RunRecord;
  doc.totals = { ...doc.totals!, ...patch };
  fs.writeFileSync(file, JSON.stringify(doc, null, 2));
}

describe("ach audit — acceptance criteria (#34)", () => {
  it("AC1: an untouched state dir exits 0 with zero token deltas", async () => {
    const { dir } = await untouchedStateDir();
    const r = runCli(["audit", "--dir", dir, "--json"]);
    assert.equal(r.code, 0, `stdout: ${r.stdout}\nstderr: ${r.stderr}`);
    const out = JSON.parse(r.stdout) as ReturnType<typeof auditRuns>;
    assert.equal(out.rows.length, 3);
    for (const row of out.rows) {
      assert.equal(row.status, "ok", JSON.stringify(row));
      for (const f of ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens"] as const) {
        assert.equal(row.delta![f], 0, `${row.agent} ${f}`);
      }
    }
    // Claude events were re-derived from the raw payload, not the pre-normalized record.
    const claudeRows = out.rows.filter((x) => x.agent === "claude");
    assert.ok(claudeRows.every((x) => x.derivation.raw > 0 && x.derivation.event === 0));
    // codex turn.completed names no model: its cost is unpriceable, reported distinctly.
    const codexRow = out.rows.find((x) => x.agent === "codex")!;
    assert.equal(codexRow.fieldStatus!.costUsd, "unpriceable");
    assert.equal(codexRow.recomputed!.costUsd, null);
    assert.equal(out.summary.drift, 0);

    const text = runCli(["audit", "--dir", dir]);
    assert.equal(text.code, 0, text.stderr);
    assert.match(text.stdout, /audited 3 run\(s\) at tolerance 0%: ok=3 drift=0 unverifiable=0 cost-unpriceable=1 → PASS/);
  });

  it("AC2: double-counted cache-read tokens (adapter misparse) are reported and exit non-zero", async () => {
    const { dir } = await untouchedStateDir();
    // The adapter's pre-normalized record counts cache reads twice; its raw
    // payload is correct. The driver records the doubled number faithfully.
    const bad = await driverRun(dir, "claude", "s-claude-bad", [
      claudeUsage({ input: 100, output: 50, cacheRead: 8000, cacheWrite: 0 }, { cacheReadTokens: 16000 }),
    ]);
    assert.equal(bad.totals!.cacheReadTokens, 16000, "fixture: the driver recorded the double count");

    const r = runCli(["audit", "--dir", dir, "--json"]);
    assert.equal(r.code, 1, r.stderr);
    const out = JSON.parse(r.stdout) as ReturnType<typeof auditRuns>;
    const row = out.rows.find((x) => x.runId === bad.runId)!;
    assert.equal(row.status, "drift");
    assert.equal(row.recorded!.cacheReadTokens, 16000);
    assert.equal(row.recomputed!.cacheReadTokens, 8000);
    assert.equal(row.delta!.cacheReadTokens, 8000);
    assert.equal(row.fieldStatus!.cacheReadTokens, "drift");
    assert.equal(row.fieldStatus!.costUsd, "drift", "the doubled tokens were priced too");
    assert.equal(row.fieldStatus!.inputTokens, "ok");
    // Only the corrupted run drifts.
    assert.deepEqual(
      out.rows.filter((x) => x.status === "drift").map((x) => x.runId),
      [bad.runId],
    );

    const text = runCli(["audit", "--dir", dir]);
    assert.equal(text.code, 1);
    assert.match(text.stdout, new RegExp(`${bad.runId}\\s+claude .* DRIFT`));
    assert.match(text.stdout, /cacheReadTokens: 16000 vs 8000 \(Δ \+8000, \+100\.00%\)/);
    assert.match(text.stdout, /→ FAIL/);
  });

  it("AC3: --tolerance-pct 1 passes a 0.5% cost drift and fails a 2% drift", async () => {
    const { dir, claude } = await untouchedStateDir();
    // Expected cost from the pricer itself, never a hand-typed USD figure.
    const truth = claude.totals!.costUsd;
    assert.ok(truth > 0 && Number.isFinite(truth));

    editTotals(dir, claude.runId, { costUsd: truth * 1.005 });
    const exact = runCli(["audit", "--dir", dir]);
    assert.equal(exact.code, 1, "default tolerance is epsilon-only: 0.5% is drift");
    const loose = runCli(["audit", "--dir", dir, "--tolerance-pct", "1", "--json"]);
    assert.equal(loose.code, 0, loose.stdout);
    const row = (JSON.parse(loose.stdout) as ReturnType<typeof auditRuns>).rows.find((x) => x.runId === claude.runId)!;
    assert.equal(row.fieldStatus!.costUsd, "ok");
    assert.ok(Math.abs(row.deltaPct!.costUsd! - 0.5) < 1e-6, `deltaPct ${row.deltaPct!.costUsd}`);

    editTotals(dir, claude.runId, { costUsd: truth * 1.02 });
    const tight = runCli(["audit", "--dir", dir, "--tolerance-pct", "1"]);
    assert.equal(tight.code, 1, tight.stdout);
    assert.match(tight.stdout, /costUsd: \$\d+\.\d{6} vs \$\d+\.\d{6} \(Δ \+\$\d+\.\d{6}, \+2\.00%\)/);
  });

  it("AC4: --fix rewrites the drifted aggregates and records the correction in the RunRecord", async () => {
    const { dir } = await untouchedStateDir();
    const bad = await driverRun(dir, "claude", "s-claude-fix", [
      claudeUsage({ input: 100, output: 50, cacheRead: 8000, cacheWrite: 0 }, { cacheReadTokens: 16000 }),
    ]);
    const before = readRunRecord(dir, bad.runId)!;

    const fix = runCli(["audit", "--dir", dir, "--fix", "--json"]);
    assert.equal(fix.code, 0, `every drift was fixed: ${fix.stdout}`);
    const out = JSON.parse(fix.stdout) as ReturnType<typeof auditRuns>;
    const row = out.rows.find((x) => x.runId === bad.runId)!;
    assert.deepEqual(row.fixed, ["cacheReadTokens", "costUsd"]);
    assert.equal(out.summary.fixed, 1);

    const after = readRunRecord(dir, bad.runId)!; // parses through RunRecordSchema
    assert.equal(after.totals!.cacheReadTokens, 8000);
    assert.equal(after.totals!.costUsd, row.recomputed!.costUsd);
    const fields = after.corrections!.map((c) => c.field);
    assert.deepEqual(fields, ["totals.cacheReadTokens", "totals.costUsd", "usage.usd.value"]);
    const cr = after.corrections![0]!;
    assert.equal(cr.from, 16000);
    assert.equal(cr.to, 8000);
    assert.equal(cr.by, "ach audit --fix");
    assert.ok(cr.at > 0);
    assert.equal(after.corrections![1]!.from, before.totals!.costUsd);
    assert.equal(after.usage!.usd.value, after.totals!.costUsd, "usd mirror kept in step");
    // Untouched fields and records are not rewritten.
    assert.equal(after.totals!.inputTokens, before.totals!.inputTokens);
    assert.equal(after.source, "local");
    const raw = JSON.parse(fs.readFileSync(path.join(dir, "runs", `${bad.runId}.json`), "utf8")) as Record<string, unknown>;
    assert.equal("source" in raw, false, "fix patches the on-disk JSON; no zod default is written");
    for (const r of listRunRecords(dir).filter((x) => x.runId !== bad.runId)) {
      assert.equal(r.corrections, undefined);
    }

    const again = runCli(["audit", "--dir", dir]);
    assert.equal(again.code, 0, again.stdout);
  });

  it("AC5: --json rows are machine-comparable with `ach stats --json`", async () => {
    const { dir } = await untouchedStateDir();
    const home = tmp("ach-audit-home-");
    const env = { AGENTIC_CODING_HARNESS_STATE_DIR: dir, HOME: home, PATH: process.env.PATH ?? "" };
    const audit = runCli(["audit", "--json"], env);
    assert.equal(audit.code, 0, audit.stderr);
    const stats = runCli(["stats", "--json", "--state-only"], env);
    assert.equal(stats.code, 0, stats.stderr);
    const a = JSON.parse(audit.stdout) as ReturnType<typeof auditRuns>;
    const s = JSON.parse(stats.stdout) as { total: Record<string, number>; byAgent: Record<string, Record<string, number>> };

    for (const f of ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens"] as const) {
      assert.equal(a.total.recomputed[f], s.total[f], `total ${f}`);
      for (const agent of Object.keys(s.byAgent)) {
        const sum = a.rows.filter((r) => r.agent === agent).reduce((acc, r) => acc + (r.recomputed![f] ?? 0), 0);
        assert.equal(sum, s.byAgent[agent]![f], `${agent} ${f}`);
      }
    }
    for (const row of a.rows) {
      assert.match(row.day, /^\d{4}-\d{2}-\d{2}$/);
      assert.deepEqual(Object.keys(row.recorded!).sort(), Object.keys(row.recomputed!).sort());
      assert.deepEqual(Object.keys(row.delta!).sort(), Object.keys(row.recorded!).sort());
    }
  });
});

describe("ach audit — honesty rules", () => {
  it("records with no totals, no transcript path, or a missing transcript are unverifiable, not passing", async () => {
    const { dir, claude2 } = await untouchedStateDir();
    writeRunRecord(dir, { runId: "ext-1", agent: "claude", startedAt: Date.now(), source: "external", totals: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 } });
    writeRunRecord(dir, { runId: "no-totals", agent: "claude", startedAt: Date.now(), rawTranscript: "/nonexistent/x.jsonl" });
    fs.rmSync(claude2.rawTranscript!);

    const res = auditRuns({ stateDir: dir });
    const by = new Map(res.rows.map((r) => [r.runId, r]));
    assert.equal(by.get("ext-1")!.status, "unverifiable");
    assert.match(by.get("ext-1")!.reason!, /no raw transcript path/);
    assert.equal(by.get("no-totals")!.status, "unverifiable");
    assert.match(by.get("no-totals")!.reason!, /no recorded totals/);
    assert.equal(by.get(claude2.runId)!.status, "unverifiable");
    assert.match(by.get(claude2.runId)!.reason!, /raw transcript missing/);
    assert.equal(res.summary.unverifiable, 3);
    assert.equal(res.summary.ok, 2);

    const text = runCli(["audit", "--dir", dir]);
    assert.equal(text.code, 0, "unverifiable is reported, not failed");
    assert.match(text.stdout, /ext-1 .* UNVERIFIABLE/);
    assert.match(text.stdout, /unverifiable=3/);
  });

  it("an imported record (#25) is unverifiable with its own reason, not 'external record'", () => {
    const dir = tmp("ach-audit-imp-");
    writeRunRecord(dir, { runId: "imp-1", agent: "claude", startedAt: Date.now(), source: "imported", totals: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 } });
    writeRunRecord(dir, { runId: "ext-2", agent: "claude", startedAt: Date.now(), source: "external", totals: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 } });

    const by = new Map(auditRuns({ stateDir: dir }).rows.map((r) => [r.runId, r]));
    assert.equal(by.get("imp-1")!.status, "unverifiable");
    assert.equal(by.get("imp-1")!.reason, "imported record (transcript history, not an ach run)");
    assert.doesNotMatch(by.get("imp-1")!.reason!, /external/);
    assert.match(by.get("ext-2")!.reason!, /no raw transcript path \(external record\)/);
  });

  it("an unpriceable model is reported as n/a, never as a delta", async () => {
    const dir = tmp("ach-audit-np-");
    const rec = await driverRun(dir, "claude", "s-np", [
      { ...claudeUsage({ input: 5, output: 5, cacheRead: 0, cacheWrite: 0 }), usage: { agent: "claude", model: "no-such-model-xyz", inputTokens: 5, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 } },
    ]);
    const pricer = createPricer();
    const res = auditRuns({ stateDir: dir, pricer });
    const row = res.rows.find((r) => r.runId === rec.runId)!;
    assert.equal(row.status, "ok");
    assert.equal(row.fieldStatus!.costUsd, "unpriceable");
    assert.equal(row.delta!.costUsd, null);
    assert.equal(res.summary.costUnpriceable, 1);
    assert.ok(pricer.drainWarnings().some((w) => w.includes("no-such-model-xyz")));
  });

  it("two runs sharing one resumed-session transcript are each audited over their own window", async () => {
    const dir = tmp("ach-audit-shared-");
    const first = await driverRun(dir, "claude", "s-shared", [claudeUsage({ input: 10, output: 10, cacheRead: 0, cacheWrite: 0 })]);
    await new Promise((r) => setTimeout(r, 5));
    const second = await driverRun(dir, "claude", "s-shared", [claudeUsage({ input: 30, output: 30, cacheRead: 0, cacheWrite: 0 })]);
    assert.equal(first.rawTranscript, second.rawTranscript, "fixture: one transcript, appended twice");
    const res = auditRuns({ stateDir: dir });
    assert.equal(res.summary.drift, 0, JSON.stringify(res.rows, null, 2));
    assert.equal(res.rows.find((r) => r.runId === first.runId)!.recomputed!.inputTokens, 10);
    assert.equal(res.rows.find((r) => r.runId === second.runId)!.recomputed!.inputTokens, 30);
  });

  it("kiro placeholder-zero records are neither summed nor priced (driver rule mirrored)", async () => {
    const dir = tmp("ach-audit-kiro-");
    await driverRun(dir, "kiro", "s-kiro", [
      {
        type: "usage",
        agent: "kiro",
        usage: { agent: "kiro", model: "unknown", inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, extra: { credits: 0.05, source: "native", tokensAvailable: false } },
        data: { meteringUsage: [{ value: 0.05, unit: "credit" }] },
      },
    ]);
    const res = auditRuns({ stateDir: dir });
    assert.equal(res.summary.drift, 0);
    assert.equal(res.rows[0]!.recomputed!.costUsd, 0);
  });

  it("--fix never rewrites a live run", async () => {
    const { dir, claude } = await untouchedStateDir();
    const doc = readRunRecord(dir, claude.runId)!;
    writeRunRecord(dir, { ...doc, status: "running", pid: process.pid, updatedAt: Date.now(), totals: { ...doc.totals!, inputTokens: doc.totals!.inputTokens + 1 } });
    const res = auditRuns({ stateDir: dir, fix: true });
    const row = res.rows.find((r) => r.runId === claude.runId)!;
    assert.equal(row.status, "drift");
    assert.match(row.fixSkipped!, /live/);
    assert.equal(res.summary.unresolvedDrift, 1);
    assert.equal(readRunRecord(dir, claude.runId)!.corrections, undefined);
  });

  it("--agent and --days filter the audited runs; bad flags are usage errors", async () => {
    const { dir } = await untouchedStateDir();
    assert.deepEqual(new Set(auditRuns({ stateDir: dir, agent: "codex" }).rows.map((r) => r.agent)), new Set(["codex"]));
    assert.equal(auditRuns({ stateDir: dir, sinceTs: Date.now() + 60_000 }).rows.length, 0);
    const bad = runCli(["audit", "--dir", dir, "--tolerance-pct", "abc"]);
    assert.notEqual(bad.code, 0);
    assert.match(bad.stderr, /--tolerance-pct expects a non-negative number/);
    const unknown = runCli(["audit", "--dir", dir, "--agent", "nope"]);
    assert.notEqual(unknown.code, 0);
    assert.match(unknown.stderr, /unknown agent 'nope'/);
  });
});

describe("audit raw extractors", () => {
  it("prefer the per-model breakdown and apply each vendor's cache convention", () => {
    const claude = extractRawTokens("claude", {
      input: 999, output: 999, cacheRead: 999, cacheWrite: 999,
      models: [
        { model: "a", input: 1, output: 2, cacheRead: 3, cacheWrite: 4 },
        { model: "b", input: 10, output: 20, cacheRead: 30, cacheWrite: 40 },
      ],
    });
    assert.deepEqual(claude!.tok, { inputTokens: 11, outputTokens: 22, cacheReadTokens: 33, cacheWriteTokens: 44 });
    const codex = extractRawTokens("codex", { input_tokens: 1200, cached_input_tokens: 200, output_tokens: 300 });
    assert.deepEqual(codex!.tok, { inputTokens: 1000, outputTokens: 300, cacheReadTokens: 200, cacheWriteTokens: 0 });
    const gemini = extractRawTokens("gemini", {
      input_tokens: 61605, input: 29017, cached: 32588, output_tokens: 463,
      models: {
        m1: { input_tokens: 1674, output_tokens: 49, cached: 0, input: 1674 },
        m2: { input_tokens: 59931, output_tokens: 414, cached: 32588, input: 27343 },
      },
    });
    assert.deepEqual(gemini!.tok, { inputTokens: 29017, outputTokens: 463, cacheReadTokens: 32588, cacheWriteTokens: 0 });
    const opencode = extractRawTokens("opencode", { tokens: { input: 5, output: 6, cache: { read: 7, write: 8 } }, cost: 0 });
    assert.deepEqual(opencode!.tok, { inputTokens: 5, outputTokens: 6, cacheReadTokens: 7, cacheWriteTokens: 8 });
    const kiro = extractRawTokens("kiro", { tokenUsage: { uncachedInputTokens: 3, cacheReadInputTokens: 4, cacheWriteInputTokens: 5, outputTokens: 6 } });
    assert.deepEqual(kiro!.tok, { inputTokens: 3, outputTokens: 6, cacheReadTokens: 4, cacheWriteTokens: 5 });
    assert.equal(extractRawTokens("claude", { meteringUsage: [] }), null);
  });
});
