import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { aggregate } from "../src/cli/lib.ts";
import {
  aggregateDims,
  loadProjectAliases,
  parseByDims,
  projectOf,
  projectRoot,
  UNATTRIBUTED,
  type DimRecord,
} from "../src/cli/stats-dims.ts";
import { cacheHitRatio, fmtCacheHit } from "../src/core/cache-ratio.ts";
import { normalizeAuto } from "../src/core/normalize.ts";
import { createPricer } from "../src/core/pricing.ts";
import { deriveRunObservability } from "../src/web/derive.ts";
import { parseClaudeTranscript, parseCodexRollout } from "../src/monitors/transcripts.ts";
import type { AgentEvent } from "../src/core/types.ts";

// ---------------------------------------------------------------------------
// #27 per-model breakdown, #43 project grouping, #69 cache-hit ratio.
// ---------------------------------------------------------------------------

const DAY1 = "2026-09-01T10:00:00.000Z";
const DAY2 = "2026-09-02T10:00:00.000Z";

function r(over: Partial<DimRecord>): DimRecord {
  return {
    ts: DAY1,
    agent: "claude",
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    ...over,
  };
}

/** One claude run that mixed opus (main turns) and haiku (probe turns); the
 * adapter carries both slices under extra.raw.models with CLI-reported cost. */
const MIXED = r({
  sessionId: "s-mixed",
  model: "claude-opus-4-8", // dominant-by-cost label from the adapter
  inputTokens: 1_050,
  outputTokens: 210,
  cacheReadTokens: 5_000,
  cacheWriteTokens: 300,
  reasoningTokens: 7,
  costUsd: 0.102,
  extra: {
    raw: {
      models: [
        { model: "claude-opus-4-8", input: 1_000, output: 200, cacheRead: 5_000, cacheWrite: 300, reasoning: 7, costUsd: 0.1 },
        { model: "claude-haiku-4-5", input: 50, output: 10, cacheRead: 0, cacheWrite: 0, reasoning: 0, costUsd: 0.002 },
      ],
    },
  },
});

const close = (a: number | null | undefined, b: number) =>
  assert.ok(a !== null && a !== undefined && Math.abs(a - b) < 1e-9, `expected ${b}, got ${a}`);

describe("cache-hit ratio (#69)", () => {
  it("is cacheRead / (input + cacheRead + cacheWrite) on canonical (uncached-input) records", () => {
    close(cacheHitRatio({ inputTokens: 100, cacheReadTokens: 800, cacheWriteTokens: 100 }), 0.8);
  });

  it("zero prompt tokens and absent cache fields give null, never NaN", () => {
    assert.equal(cacheHitRatio({ inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }), null);
    assert.equal(cacheHitRatio({}), null);
    assert.equal(cacheHitRatio({ inputTokens: Number.NaN, cacheReadTokens: 5 }), 1);
    assert.equal(fmtCacheHit(null), "n/a");
    assert.equal(fmtCacheHit(0.8), "80.0%");
    // A provider without caching support: input only -> a real 0%, not n/a.
    assert.equal(cacheHitRatio({ inputTokens: 500 }), 0);
  });

  it("Anthropic vs OpenAI semantics agree once normalized (OpenAI prompt includes cached)", () => {
    // OpenAI/codex: input_tokens INCLUDES cached_input_tokens -> 800/1000.
    const openai = normalizeAuto("codex", { input_tokens: 1_000, cached_input_tokens: 800, output_tokens: 10 }, 0);
    assert.ok(openai);
    close(cacheHitRatio(openai), 0.8);
    // Anthropic: input_tokens is UNCACHED; reads and writes are separate. The
    // cache write is prompt that missed the cache, so it counts as a miss.
    const anthropic = normalizeAuto(
      "claude",
      {
        model: "claude-sonnet-4",
        usage: { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 800, cache_creation_input_tokens: 100 },
      },
      0,
    );
    assert.ok(anthropic);
    close(cacheHitRatio(anthropic), 0.8);
  });
});

describe("per-model breakdown (#27)", () => {
  it("conservation: a mixed-model run's per-model rows sum to the run's token and cost totals", () => {
    const dims = aggregateDims([MIXED], { pricer: createPricer() });
    const rows = Object.values(dims.byModel);
    assert.deepEqual(Object.keys(dims.byModel).sort(), ["claude/claude-haiku-4-5", "claude/claude-opus-4-8"]);
    const totals = aggregate([MIXED]).totals;
    const sum = (k: "inputTokens" | "outputTokens" | "cacheReadTokens" | "cacheWriteTokens" | "reasoningTokens") =>
      rows.reduce((a, b) => a + b[k], 0);
    assert.equal(sum("inputTokens"), totals.inputTokens);
    assert.equal(sum("outputTokens"), totals.outputTokens);
    assert.equal(sum("cacheReadTokens"), totals.cacheReadTokens);
    assert.equal(sum("cacheWriteTokens"), totals.cacheWriteTokens);
    assert.equal(sum("reasoningTokens"), totals.reasoningTokens);
    close(
      rows.reduce((a, b) => a + (b.costUsd ?? Number.NaN), 0),
      totals.costUsd,
    );
    close(dims.byModel["claude/claude-opus-4-8"]!.costUsd, 0.1);
    close(dims.byModel["claude/claude-haiku-4-5"]!.costUsd, 0.002);
    close(dims.byModel["claude/claude-opus-4-8"]!.cacheHitRatio, 5_000 / 6_300);
    assert.equal(dims.byModel["claude/claude-haiku-4-5"]!.cacheHitRatio, 0);
    assert.deepEqual(dims.unpricedModels, []);
  });

  it("a slice with no reported cost is priced from its own model's rates", () => {
    const rec = r({
      inputTokens: 1_000_000,
      extra: { raw: { models: [{ model: "claude-sonnet-4", input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 }] } },
    });
    const dims = aggregateDims([rec], { pricer: createPricer() });
    close(dims.byModel["claude/claude-sonnet-4"]!.costUsd, 3);
  });

  it("unpriced model: listed, cost null, tokens intact; aggregate totals exclude it", () => {
    const unpriced = r({ model: "mystery-model-9", inputTokens: 100, outputTokens: 10 }); // no costUsd
    const priced = r({ model: "claude-sonnet-4", inputTokens: 10, costUsd: 0.5 });
    const dims = aggregateDims([unpriced, priced], { pricer: createPricer() });
    const row = dims.byModel["claude/mystery-model-9"]!;
    assert.equal(row.costUsd, null);
    assert.equal(row.inputTokens, 100);
    assert.equal(row.outputTokens, 10);
    assert.deepEqual(dims.unpricedModels, ["claude/mystery-model-9"]);
    assert.equal(aggregate([unpriced, priced]).totals.costUsd, 0.5);

    // Same for an unpriceable slice inside a multi-model record.
    const slice = r({
      inputTokens: 30,
      extra: {
        raw: {
          models: [
            { model: "claude-sonnet-4", input: 10, output: 0, cacheRead: 0, cacheWrite: 0 },
            { model: "nope-model", input: 20, output: 0, cacheRead: 0, cacheWrite: 0 },
          ],
        },
      },
    });
    const d2 = aggregateDims([slice], { pricer: createPricer() });
    assert.equal(d2.byModel["claude/nope-model"]!.costUsd, null);
    assert.equal(d2.byModel["claude/nope-model"]!.inputTokens, 20);
    assert.deepEqual(d2.unpricedModels, ["claude/nope-model"]);
  });

  it("same model from two agents stays two scoped rows; --merge-models merges via the alias map", () => {
    const a = r({ agent: "claude", model: "gpt-5", inputTokens: 1, costUsd: 0.1 });
    const b = r({ agent: "codex", model: "gpt-5-codex", inputTokens: 2, costUsd: 0.2 });
    const c = r({ agent: "opencode", model: "gpt-5", inputTokens: 4, costUsd: 0.4 });
    const scoped = aggregateDims([a, b, c], { pricer: createPricer() });
    assert.deepEqual(Object.keys(scoped.byModel).sort(), ["claude/gpt-5", "codex/gpt-5-codex", "opencode/gpt-5"]);

    const merged = aggregateDims([a, b, c], {
      pricer: createPricer(),
      mergeModels: true,
      modelAliases: { "gpt-5-codex": "gpt-5" },
    });
    assert.deepEqual(Object.keys(merged.byModel), ["gpt-5"]);
    assert.equal(merged.byModel["gpt-5"]!.inputTokens, 7);
    assert.equal(merged.byModel["gpt-5"]!.records, 3);
    close(merged.byModel["gpt-5"]!.costUsd, 0.7);
  });

  it("records without per-model slices and with a composite/absent label go to unattributed", () => {
    const joined = r({ model: "claude-opus-4-8+claude-haiku-4-5", inputTokens: 5, costUsd: 0.01 }); // usage_raw lane
    const multi = r({ model: "multi", inputTokens: 6 });
    const none = r({ agent: "codex", inputTokens: 7 });
    const dims = aggregateDims([joined, multi, none], { pricer: createPricer() });
    assert.deepEqual(Object.keys(dims.byModel).sort(), [`claude/${UNATTRIBUTED}`, `codex/${UNATTRIBUTED}`]);
    assert.equal(dims.byModel[`claude/${UNATTRIBUTED}`]!.inputTokens, 11);
    // Never folded into the dominant model, and not an "unpriced model".
    assert.deepEqual(dims.unpricedModels, []);
  });

  it("model x day: per-cell sums compose with the day window", () => {
    const recs = [
      r({ ts: DAY1, model: "claude-sonnet-4", inputTokens: 10, costUsd: 0.1 }),
      r({ ts: DAY1, model: "claude-sonnet-4", inputTokens: 5, costUsd: 0.05 }),
      r({ ts: DAY2, model: "claude-sonnet-4", inputTokens: 1, costUsd: 0.01 }),
      r({ ts: DAY2, model: "claude-haiku-4-5", inputTokens: 2, costUsd: 0.02 }),
    ];
    const dims = aggregateDims(recs, { pricer: createPricer(), byModelDay: true });
    assert.ok(dims.byModelDay);
    assert.equal(dims.byModelDay["2026-09-01"]!["claude/claude-sonnet-4"]!.inputTokens, 15);
    close(dims.byModelDay["2026-09-01"]!["claude/claude-sonnet-4"]!.costUsd, 0.15);
    assert.equal(dims.byModelDay["2026-09-02"]!["claude/claude-sonnet-4"]!.inputTokens, 1);
    assert.equal(dims.byModelDay["2026-09-02"]!["claude/claude-haiku-4-5"]!.inputTokens, 2);
    assert.equal(dims.byModelDay["2026-09-01"]!["claude/claude-haiku-4-5"], undefined);
    // Without the flag the table is not built.
    assert.equal(aggregateDims(recs, { pricer: createPricer() }).byModelDay, undefined);
  });
});

describe("project grouping (#43)", () => {
  let tmp: string;
  let repo: string;
  let plain: string;
  before(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ach-proj-")));
    repo = path.join(tmp, "api");
    fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
    fs.mkdirSync(path.join(repo, "sub", "inner", ".git"), { recursive: true }); // nested repo (worktree-like)
    plain = path.join(tmp, "notes");
    fs.mkdirSync(plain, { recursive: true });
  });
  after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it("projectRoot: shortest enclosing git toplevel; non-git dirs and missing paths key on the cwd", () => {
    assert.equal(projectRoot(path.join(repo, "sub")), repo);
    assert.equal(projectRoot(path.join(repo, "sub", "inner")), repo);
    assert.equal(projectRoot(plain), plain);
    assert.equal(projectRoot(path.join(tmp, "gone", "dir")), path.join(tmp, "gone", "dir"));
  });

  it("aliases: env JSON, file, and name=path pairs; ~ expands; later sources win", () => {
    const file = path.join(tmp, "aliases.json");
    fs.writeFileSync(file, JSON.stringify({ [plain]: "notes-file" }));
    const aliases = loadProjectAliases({
      envJson: JSON.stringify({ "~/code/web": "web", [plain]: "notes-env" }),
      file,
      pairs: [`${repo}=api`],
    });
    assert.equal(aliases[path.join(os.homedir(), "code", "web")], "web");
    assert.equal(aliases[plain], "notes-file");
    assert.equal(aliases[repo], "api");
    assert.throws(() => loadProjectAliases({ pairs: ["no-equals-sign"] }), /--project-alias/);
    assert.throws(() => loadProjectAliases({ envJson: "{not json" }), /PROJECT_ALIASES/);
  });

  it("projectOf applies the alias to the root; missing cwd is 'unknown'", () => {
    const aliases = { [repo]: "api" };
    assert.deepEqual(projectOf(path.join(repo, "sub"), aliases), { name: "api", root: repo });
    assert.deepEqual(projectOf(plain, aliases), { name: plain, root: plain });
    assert.deepEqual(projectOf(undefined, aliases), { name: "unknown", root: null });
  });

  it("aggregateDims byProject rolls up by aliased root", () => {
    const recs = [
      r({ cwd: path.join(repo, "sub"), inputTokens: 10, cacheReadTokens: 90, costUsd: 1 }),
      r({ cwd: repo, inputTokens: 5, costUsd: 2 }),
      r({ cwd: plain, inputTokens: 1 }),
      r({ inputTokens: 3 }),
    ];
    const dims = aggregateDims(recs, { pricer: createPricer(), byProject: true, projectAliases: { [repo]: "api" } });
    assert.ok(dims.byProject);
    assert.deepEqual(Object.keys(dims.byProject).sort(), ["api", plain, "unknown"].sort());
    assert.equal(dims.byProject.api!.records, 2);
    assert.equal(dims.byProject.api!.inputTokens, 15);
    assert.equal(dims.byProject.api!.costUsd, 3);
    close(dims.byProject.api!.cacheHitRatio, 90 / 105);
    assert.equal(dims.byProject.unknown!.inputTokens, 3);
  });

  it("machine transcripts carry cwd: claude line `cwd`, codex session_meta cwd", async () => {
    const claudeFile = path.join(tmp, "claude.jsonl");
    fs.writeFileSync(
      claudeFile,
      JSON.stringify({
        type: "assistant",
        timestamp: DAY1,
        sessionId: "s1",
        cwd: repo,
        message: { id: "m1", model: "claude-sonnet-4", usage: { input_tokens: 1, output_tokens: 1 } },
      }) + "\n",
    );
    const [c] = await parseClaudeTranscript(claudeFile);
    assert.equal(c!.cwd, repo);
    const codexFile = path.join(tmp, "codex.jsonl");
    fs.writeFileSync(
      codexFile,
      [
        JSON.stringify({ type: "session_meta", payload: { id: "cx", cwd: plain } }),
        JSON.stringify({ type: "token_usage_record", timestamp: DAY1, payload: { thread_token_usage: { input_tokens: 3, output_tokens: 1 } } }),
      ].join("\n") + "\n",
    );
    const [x] = await parseCodexRollout(codexFile);
    assert.equal(x!.cwd, plain);
  });

  it("parseByDims accepts repeated and comma-joined values, rejects unknown ones", () => {
    assert.deepEqual([...parseByDims(["model", "project"])].sort(), ["model", "project"]);
    assert.deepEqual([...parseByDims(["model,project"])].sort(), ["model", "project"]);
    assert.deepEqual([...parseByDims(undefined)], []);
    assert.throws(() => parseByDims(["bogus"]), /--by/);
  });
});

describe("web run observability cache-hit + per-model (#69)", () => {
  it("adds cacheHitRatio and byModel rows when usage exists; empty input shape unchanged", () => {
    const events: AgentEvent[] = [
      { type: "session_start", agent: "claude", timestamp: 1_000 },
      {
        type: "usage",
        usage: { model: "claude-sonnet-4", inputTokens: 100, outputTokens: 5, cacheReadTokens: 800, cacheWriteTokens: 100 },
        timestamp: 1_100,
      },
      {
        type: "usage",
        usage: {
          model: "claude-opus-4-8",
          inputTokens: 60,
          outputTokens: 5,
          cacheReadTokens: 40,
          cacheWriteTokens: 0,
          extra: {
            raw: {
              models: [
                { model: "claude-opus-4-8", input: 50, output: 4, cacheRead: 40, cacheWrite: 0 },
                { model: "claude-haiku-4-5", input: 10, output: 1, cacheRead: 0, cacheWrite: 0 },
              ],
            },
          },
        },
        timestamp: 1_200,
      },
      { type: "done", exitStatus: "success", timestamp: 1_300 },
    ];
    const obs = deriveRunObservability(events);
    close(obs.cacheHitRatio, 840 / 1_100);
    assert.ok(obs.byModel);
    const byName = Object.fromEntries(obs.byModel.map((m) => [m.model, m]));
    assert.deepEqual(Object.keys(byName).sort(), ["claude-haiku-4-5", "claude-opus-4-8", "claude-sonnet-4"]);
    close(byName["claude-sonnet-4"]!.cacheHitRatio, 0.8);
    close(byName["claude-opus-4-8"]!.cacheHitRatio, 40 / 90);
    assert.equal(byName["claude-haiku-4-5"]!.cacheHitRatio, 0);
    assert.equal(byName["claude-haiku-4-5"]!.inputTokens, 10);
  });
});

// ---------------------------------------------------------------------------
// CLI (subprocess, same shape as tests/cli.test.ts)
// ---------------------------------------------------------------------------

const CLI = new URL("../src/cli/ach.ts", import.meta.url).pathname;

function runCli(args: string[], env: Record<string, string>): { code: number; stdout: string; stderr: string } {
  const isBun = (process.versions as { bun?: string }).bun !== undefined;
  const p = spawnSync(process.execPath, isBun ? [CLI, ...args] : ["--import", "tsx", CLI, ...args], {
    env: { ...process.env, AGENTIC_CODING_HARNESS_PROJECT_ALIASES: "", ...env },
    encoding: "utf8",
  });
  return { code: p.status ?? -1, stdout: p.stdout ?? "", stderr: p.stderr ?? "" };
}

describe("ach stats --by model|project (CLI)", () => {
  let stateDir: string;
  let home: string;
  let repo: string;
  const recent = new Date(Date.now() - 86_400_000).toISOString();
  const recentDay = recent.slice(0, 10);

  before(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "ach-dims-state-"));
    home = fs.mkdtempSync(path.join(os.tmpdir(), "ach-dims-home-"));
    repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ach-dims-repo-")));
    fs.mkdirSync(path.join(repo, ".git"));
    fs.mkdirSync(path.join(stateDir, "raw", "claude"), { recursive: true });
    fs.mkdirSync(path.join(stateDir, "raw", "codex"), { recursive: true });
    fs.mkdirSync(path.join(stateDir, "runs"), { recursive: true });
    fs.writeFileSync(
      path.join(stateDir, "raw", "claude", "s-mixed.jsonl"),
      JSON.stringify({ ...MIXED, ts: recent, sessionId: "s-mixed" }) + "\n",
    );
    fs.writeFileSync(
      path.join(stateDir, "raw", "codex", "s-codex.jsonl"),
      JSON.stringify({
        ts: recent,
        agent: "codex",
        sessionId: "s-codex",
        model: "gpt-5",
        inputTokens: 200,
        outputTokens: 20,
        cacheReadTokens: 800,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        costUsd: 0.05,
      }) + "\n",
    );
    // The driver's run registry is the cwd source for stateDir records.
    fs.writeFileSync(
      path.join(stateDir, "runs", "run-1.json"),
      JSON.stringify({ runId: "run-1", agent: "claude", sessionId: "s-mixed", cwd: path.join(repo), startedAt: Date.now() }),
    );
  });
  after(() => {
    for (const d of [stateDir, home, repo]) fs.rmSync(d, { recursive: true, force: true });
  });

  const env = () => ({ AGENTIC_CODING_HARNESS_STATE_DIR: stateDir, HOME: home });

  it("default --json keeps total/byAgent/byDay and adds byModel + cacheHitRatio + unpricedModels", () => {
    const res = runCli(["stats", "--json"], env());
    assert.equal(res.code, 0, res.stderr);
    const out = JSON.parse(res.stdout);
    for (const k of ["total", "byAgent", "byDay", "byModel", "cacheHitRatio", "unpricedModels"]) assert.ok(k in out, k);
    assert.equal(out.byModelDay, undefined);
    assert.equal(out.byProject, undefined);
    assert.deepEqual(Object.keys(out.byModel).sort(), [
      "claude/claude-haiku-4-5",
      "claude/claude-opus-4-8",
      "codex/gpt-5",
    ]);
    assert.equal(out.total.records, 2);
    close(out.cacheHitRatio.byAgent.codex, 0.8);
    close(out.byModel["codex/gpt-5"].cacheHitRatio, 0.8);
  });

  it("--by model adds the model x day table and prints it", () => {
    const res = runCli(["stats", "--json", "--by", "model"], env());
    assert.equal(res.code, 0, res.stderr);
    const out = JSON.parse(res.stdout);
    assert.equal(out.byModelDay[recentDay]["claude/claude-opus-4-8"].inputTokens, 1_000);
    const text = runCli(["stats", "--by", "model"], env());
    assert.equal(text.code, 0, text.stderr);
    assert.match(text.stdout, /claude\/claude-haiku-4-5 .*cost=\$0\.0020/);
    assert.match(text.stdout, /model x day/);
    assert.match(text.stdout, /cacheHit=80\.0%/);
  });

  it("--merge-models echoes the alias map in effect", () => {
    const res = runCli(
      ["stats", "--json", "--merge-models", "--model-alias", "claude-haiku-4-5=claude-opus-4-8"],
      env(),
    );
    assert.equal(res.code, 0, res.stderr);
    const out = JSON.parse(res.stdout);
    assert.deepEqual(Object.keys(out.byModel).sort(), ["claude-opus-4-8", "gpt-5"]);
    assert.deepEqual(out.modelAliases, { "claude-haiku-4-5": "claude-opus-4-8" });
    assert.equal(out.mergedModels, true);
  });

  it("--by project groups by repo root via the run registry, with aliases and 'unknown'", () => {
    const res = runCli(["stats", "--json", "--by", "project", "--project-alias", `${repo}=api`], env());
    assert.equal(res.code, 0, res.stderr);
    const out = JSON.parse(res.stdout);
    assert.deepEqual(Object.keys(out.byProject).sort(), ["api", "unknown"]);
    assert.equal(out.byProject.api.inputTokens, 1_050);
    assert.equal(out.byProject.unknown.inputTokens, 200);
    assert.deepEqual(out.projectAliases, { [repo]: "api" });
    const text = runCli(["stats", "--by", "project", "--project-alias", `${repo}=api`], env());
    assert.match(text.stdout, /^api +records=1 /m);
  });

  it("--project filters before aggregating and composes with --agent/--days; env alias map works", () => {
    const res = runCli(["stats", "--json", "--project", "api", "--days", "7", "--agent", "claude"], {
      ...env(),
      AGENTIC_CODING_HARNESS_PROJECT_ALIASES: JSON.stringify({ [repo]: "api" }),
    });
    assert.equal(res.code, 0, res.stderr);
    const out = JSON.parse(res.stdout);
    assert.equal(out.total.records, 1);
    assert.equal(out.total.inputTokens, 1_050);
    assert.deepEqual(Object.keys(out.byProject), ["api"]);
    const none = runCli(["stats", "--json", "--project", "api", "--agent", "codex"], {
      ...env(),
      AGENTIC_CODING_HARNESS_PROJECT_ALIASES: JSON.stringify({ [repo]: "api" }),
    });
    assert.equal(JSON.parse(none.stdout).total.records, 0);
  });

  it("unknown --by value is a usage error", () => {
    const res = runCli(["stats", "--by", "bogus"], env());
    assert.equal(res.code, 1);
    assert.match(res.stderr, /--by/);
  });

  it("--by mixes #44 time granularities with #27/#43 dimensions (integration)", () => {
    const res = runCli(["stats", "--json", "--by", "week,model", "--by", "project"], env());
    assert.equal(res.code, 0, res.stderr);
    const out = JSON.parse(res.stdout);
    assert.ok(out.byWeek, "byWeek present from --by week");
    assert.equal(out.byDay, undefined, "--by week without day drops byDay");
    assert.ok(out.byModelDay, "byModelDay present from --by model");
    assert.ok(out.byProject, "byProject present from --by project");
    const bad = runCli(["stats", "--by", "week,bogus"], env());
    assert.equal(bad.code, 1);
    assert.match(bad.stderr, /--by: unknown value 'bogus'.*day, week, month, model, project/);
  });
});
