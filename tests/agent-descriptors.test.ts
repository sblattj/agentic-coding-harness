// Drop-in agent definitions (#38): <cwd>/.ach/agents.d/*.json and
// <stateDir>/agents.d/*.json. Every CLI here is a FAKE node script in a temp
// dir; transcripts are fixtures written by the test.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import {
  AgentDescriptorSchema,
  agentDescriptorJsonSchema,
  descriptorDirs,
  loadAgentDescriptors,
  readDescriptorTap,
} from "../src/core/agent-descriptors.ts";
import { withPricingHints } from "../src/core/pricing-hints.ts";
import { createPricer } from "../src/core/pricing.ts";
import type { CanonicalTokenRecord } from "../src/core/types.ts";

const CLI = new URL("../src/cli/ach.ts", import.meta.url).pathname;
const EXAMPLES = new URL("../examples/agents.d/", import.meta.url).pathname;
const NODE = process.execPath;

const FAKE_JSONL_CLI = `
const args = process.argv.slice(2);
const rec = { type: 'turn', text: 'done: ' + args.join(' '), sid: 'fake-session-1', model: 'fake-model-1', usage: { in: 100, out: 20, cached: 5 } };
if (process.env.FAKE_COST) rec.cost_usd = Number(process.env.FAKE_COST);
process.stdout.write(JSON.stringify(rec) + '\\n');
`;

function runCli(args: string[], env: Record<string, string>, cwd?: string) {
  const isBun = (process.versions as { bun?: string }).bun !== undefined;
  // The loader is resolved from THIS repo: the child may run with a temp cwd.
  const p = spawnSync(NODE, isBun ? [CLI, ...args] : ["--import", import.meta.resolve("tsx"), CLI, ...args], {
    env: { ...process.env, ...env },
    encoding: "utf8",
    ...(cwd !== undefined ? { cwd } : {}),
  });
  return { code: p.status ?? -1, stdout: p.stdout ?? "", stderr: p.stderr ?? "" };
}

let tmp: string;
let fake: string;

before(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ach-agentsd-"));
  fake = path.join(tmp, "fake-jsonl.mjs");
  await fs.writeFile(fake, FAKE_JSONL_CLI);
});

after(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

async function writeDescriptor(dir: string, file: string, body: unknown): Promise<string> {
  await fs.mkdir(dir, { recursive: true });
  const p = path.join(dir, file);
  await fs.writeFile(p, typeof body === "string" ? body : JSON.stringify(body, null, 2));
  return p;
}

function fakeDescriptor(name: string, extra: Record<string, unknown> = {}) {
  return {
    name,
    description: "fake jsonl cli for tests",
    launch: {
      template: `'${NODE}' '${fake}' {prompt}`,
      output: {
        format: "jsonl",
        text: ".text",
        sessionId: ".sid",
        usage: { input: ".usage.in", output: ".usage.out", cacheRead: ".usage.cached", model: ".model", costUsd: ".cost_usd" },
        inputIncludesCache: true,
      },
    },
    usageTap: null,
    ...extra,
  };
}

describe("descriptor schema + loader", () => {
  it("descriptorDirs: project .ach/agents.d first, then <stateDir>/agents.d", () => {
    assert.deepEqual(descriptorDirs({ cwd: "/p", stateDir: "/s" }), ["/p/.ach/agents.d", "/s/agents.d"]);
  });

  it("loads a valid descriptor", async () => {
    const dir = await fs.mkdtemp(path.join(tmp, "d-"));
    await writeDescriptor(dir, "fakeagent.json", fakeDescriptor("fakeagent"));
    const r = loadAgentDescriptors({ dirs: [dir] });
    assert.deepEqual(r.errors, []);
    assert.equal(r.descriptors.length, 1);
    assert.equal(r.descriptors[0]!.descriptor.name, "fakeagent");
    assert.equal(r.descriptors[0]!.file, path.join(dir, "fakeagent.json"));
  });

  it("unknown field -> error names the file and the field; other descriptors still load", async () => {
    const dir = await fs.mkdtemp(path.join(tmp, "d-"));
    const bad = await writeDescriptor(dir, "bad.json", { ...fakeDescriptor("bad"), launch: { template: "x {prompt}", tempalte: "typo" } });
    await writeDescriptor(dir, "good.json", fakeDescriptor("good"));
    const r = loadAgentDescriptors({ dirs: [dir] });
    assert.deepEqual(r.descriptors.map((d) => d.descriptor.name), ["good"]);
    assert.equal(r.errors.length, 1);
    assert.equal(r.errors[0]!.file, bad);
    assert.equal(r.errors[0]!.field, "launch.tempalte");
    assert.match(r.errors[0]!.message, /unknown field/);
  });

  it("bad usageTap path (relative or missing) -> error names file + usageTap.path; others continue", async () => {
    const dir = await fs.mkdtemp(path.join(tmp, "d-"));
    const tap = (p: string) => ({ type: "transcript", path: p, format: "jsonl", fields: { input: ".i", output: ".o" } });
    const rel = await writeDescriptor(dir, "rel.json", { name: "rel", launch: null, usageTap: tap("logs/here") });
    const missing = await writeDescriptor(dir, "missing.json", { name: "missing", launch: null, usageTap: tap(path.join(tmp, "nope")) });
    await writeDescriptor(dir, "ok.json", fakeDescriptor("ok"));
    const r = loadAgentDescriptors({ dirs: [dir] });
    assert.deepEqual(r.descriptors.map((d) => d.descriptor.name), ["ok"]);
    const byFile = new Map(r.errors.map((e) => [e.file, e]));
    assert.equal(byFile.get(rel)?.field, "usageTap.path");
    assert.match(byFile.get(rel)!.message, /absolute/);
    assert.equal(byFile.get(missing)?.field, "usageTap.path");
    assert.match(byFile.get(missing)!.message, /does not exist/);
  });

  it("malformed JSON -> error names the file, never throws", async () => {
    const dir = await fs.mkdtemp(path.join(tmp, "d-"));
    const f = await writeDescriptor(dir, "broken.json", "{ not json");
    const r = loadAgentDescriptors({ dirs: [dir] });
    assert.equal(r.errors[0]?.file, f);
    assert.equal(r.errors[0]?.field, "(file)");
  });

  it("built-in collision: a descriptor named 'claude' is skipped with a warning; the built-in wins", async () => {
    const dir = await fs.mkdtemp(path.join(tmp, "d-"));
    await writeDescriptor(dir, "claude.json", fakeDescriptor("claude"));
    const r = loadAgentDescriptors({ dirs: [dir] });
    assert.equal(r.descriptors.length, 0);
    assert.equal(r.errors.length, 0);
    assert.ok(r.warnings.some((w) => /claude/.test(w) && /built-in wins/.test(w)), r.warnings.join("\n"));
  });

  it("a name defined in both dirs: the project dir wins, with a warning", async () => {
    const project = await fs.mkdtemp(path.join(tmp, "p-"));
    const user = await fs.mkdtemp(path.join(tmp, "u-"));
    const pf = await writeDescriptor(project, "dup.json", fakeDescriptor("dup"));
    await writeDescriptor(user, "dup.json", fakeDescriptor("dup"));
    const r = loadAgentDescriptors({ dirs: [project, user] });
    assert.equal(r.descriptors.length, 1);
    assert.equal(r.descriptors[0]!.file, pf);
    assert.ok(r.warnings.some((w) => /dup/.test(w) && /already defined/.test(w)));
  });

  it("launch and usageTap both null is rejected", () => {
    const res = AgentDescriptorSchema.safeParse({ name: "empty", launch: null, usageTap: null });
    assert.equal(res.success, false);
  });

  it("docs/agent-descriptor.schema.json is the published form of the zod schema", async () => {
    const published = JSON.parse(
      await fs.readFile(new URL("../docs/agent-descriptor.schema.json", import.meta.url), "utf8"),
    ) as unknown;
    assert.deepEqual(published, agentDescriptorJsonSchema());
  });

  it("both shipped examples (goose, aider) validate through the loader", async () => {
    const r = loadAgentDescriptors({ dirs: [EXAMPLES] });
    assert.deepEqual(r.errors, []);
    assert.deepEqual(r.descriptors.map((d) => d.descriptor.name).sort(), ["aider", "goose"]);
  });
});

describe("pricingHints", () => {
  const rec = (over: Partial<CanonicalTokenRecord> = {}): CanonicalTokenRecord => ({
    agent: "fakeagent",
    model: "fake-model-1",
    inputTokens: 95,
    outputTokens: 20,
    cacheReadTokens: 5,
    cacheWriteTokens: 0,
    ...over,
  });
  const hints = { "fake-model-1": { input: 10, output: 20, cacheRead: 1 } };

  it("prices a hinted model and stamps provenance computed + the hint source", () => {
    const p = withPricingHints(createPricer(), hints, "/x/agents.d/fakeagent.json");
    const r = rec();
    const cost = p.price(r);
    assert.ok(Math.abs(cost - (95 * 10 + 5 * 1 + 20 * 20) / 1e6) < 1e-12, String(cost));
    const pricing = (r.extra as Record<string, unknown>).pricing as Record<string, unknown>;
    assert.equal(pricing.provenance, "computed");
    assert.equal(pricing.source, "/x/agents.d/fakeagent.json#pricingHints");
    assert.ok(p.drainWarnings().some((w) => /fake-model-1/.test(w) && /pricingHints/.test(w)));
  });

  it("never replaces a vendor-reported cost: provenance reported, the reported value wins", () => {
    const p = withPricingHints(createPricer(), hints, "/x/agents.d/fakeagent.json");
    const r = rec({ costUsd: 0.5 });
    assert.equal(p.price(r), 0.5);
    assert.equal(((r.extra as Record<string, unknown>).pricing as Record<string, unknown>).provenance, "reported");
  });

  it("an unhinted model falls through to the bundled pricer unchanged", () => {
    const p = withPricingHints(createPricer(), hints, "f");
    assert.ok(Number.isNaN(p.price(rec({ model: "no-such-model" }))));
    const priced = rec({ model: "claude-sonnet-4" });
    assert.ok(p.price(priced) > 0);
  });
});

describe("ach CLI with agents.d", () => {
  it("a dropped descriptor makes `ach run --agent <name>` work; pricingHints show provenance computed", async () => {
    const stateDir = await fs.mkdtemp(path.join(tmp, "state-"));
    const descFile = await writeDescriptor(
      path.join(stateDir, "agents.d"),
      "fakeagent.json",
      fakeDescriptor("fakeagent", { pricingHints: { "fake-model-1": { input: 10, output: 20, cacheRead: 1 } } }),
    );
    const env = { AGENTIC_CODING_HARNESS_STATE_DIR: stateDir };
    const r = runCli(["run", "--agent", "fakeagent", "--json", "hello"], env, tmp);
    assert.equal(r.code, 0, r.stderr);
    const result = JSON.parse(r.stdout) as {
      exitStatus: string;
      sessionId: string;
      totalCost: number;
      tokens: Array<CanonicalTokenRecord>;
      events: Array<Record<string, unknown>>;
    };
    assert.equal(result.exitStatus, "success");
    assert.equal(result.sessionId, "fake-session-1");
    assert.ok(result.events.some((e) => e.type === "message" && e.content === "done: hello"));
    assert.equal(result.tokens.length, 1);
    const pricing = (result.tokens[0]!.extra as Record<string, unknown>).pricing as Record<string, unknown>;
    assert.equal(pricing.provenance, "computed");
    assert.equal(pricing.source, `${descFile}#pricingHints`);
    assert.ok(Math.abs(result.totalCost - 0.001355) < 1e-12, String(result.totalCost));

    // Vendor-reported cost is never replaced by the hint.
    const rep = runCli(["run", "--agent", "fakeagent", "--json", "again"], { ...env, FAKE_COST: "0.25" }, tmp);
    assert.equal(rep.code, 0, rep.stderr);
    const repResult = JSON.parse(rep.stdout) as { totalCost: number; tokens: Array<CanonicalTokenRecord> };
    assert.equal(repResult.totalCost, 0.25);
    assert.equal(((repResult.tokens[0]!.extra as Record<string, unknown>).pricing as Record<string, unknown>).provenance, "reported");

    // Shows up by name in the run registry (what dash reads).
    const dash = runCli(["dash", "--json", "--all", "--dir", stateDir], env);
    assert.equal(dash.code, 0, dash.stderr);
    assert.match(dash.stdout, /"agent": "fakeagent"/);
  });

  it("project-level .ach/agents.d is read from the cwd", async () => {
    const stateDir = await fs.mkdtemp(path.join(tmp, "state-"));
    const project = await fs.mkdtemp(path.join(tmp, "proj-"));
    await writeDescriptor(path.join(project, ".ach", "agents.d"), "projagent.json", fakeDescriptor("projagent"));
    const r = runCli(["run", "--agent", "projagent", "--json", "x"], { AGENTIC_CODING_HARNESS_STATE_DIR: stateDir }, project);
    assert.equal(r.code, 0, r.stderr);
  });

  it("a broken descriptor is reported (file + field) and the good one still runs", async () => {
    const stateDir = await fs.mkdtemp(path.join(tmp, "state-"));
    const dir = path.join(stateDir, "agents.d");
    await writeDescriptor(dir, "broken.json", { ...fakeDescriptor("broken"), bogus: true });
    await writeDescriptor(dir, "fine.json", fakeDescriptor("fine"));
    const env = { AGENTIC_CODING_HARNESS_STATE_DIR: stateDir };
    const r = runCli(["run", "--agent", "fine", "x"], env, tmp);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stderr, /broken\.json: bogus: unknown field/);

    const agents = runCli(["agents", "--json"], env, tmp);
    assert.equal(agents.code, 0, agents.stderr);
    const a = JSON.parse(agents.stdout) as {
      builtins: string[];
      descriptors: Array<{ name: string }>;
      errors: Array<{ file: string; field: string }>;
    };
    assert.ok(a.builtins.includes("claude") && a.builtins.includes("custom"));
    assert.deepEqual(a.descriptors.map((d) => d.name), ["fine"]);
    assert.equal(a.errors[0]?.field, "bogus");
  });

  it("a descriptor named like a built-in prints a warning and the built-in stays in charge", async () => {
    const stateDir = await fs.mkdtemp(path.join(tmp, "state-"));
    await writeDescriptor(path.join(stateDir, "agents.d"), "claude.json", fakeDescriptor("claude"));
    const agents = runCli(["agents"], { AGENTIC_CODING_HARNESS_STATE_DIR: stateDir }, tmp);
    assert.equal(agents.code, 0, agents.stderr);
    assert.match(agents.stderr, /claude.*built-in wins/);
  });

  it("an unknown agent lists built-ins and descriptor names", async () => {
    const stateDir = await fs.mkdtemp(path.join(tmp, "state-"));
    await writeDescriptor(path.join(stateDir, "agents.d"), "fine.json", fakeDescriptor("fine"));
    const r = runCli(["run", "--agent", "nope", "x"], { AGENTIC_CODING_HARNESS_STATE_DIR: stateDir }, tmp);
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /unknown agent 'nope'/);
    assert.match(r.stderr, /fine/);
  });

  it("a meter-only descriptor (usageTap, no launch): stats picks up its transcripts; run refuses", async () => {
    const stateDir = await fs.mkdtemp(path.join(tmp, "state-"));
    const home = await fs.mkdtemp(path.join(tmp, "home-"));
    const logs = await fs.mkdtemp(path.join(tmp, "logs-"));
    const ts = new Date(Date.now() - 3_600_000).toISOString();
    await fs.writeFile(
      path.join(logs, "s1.jsonl"),
      [
        JSON.stringify({ at: ts, m: "fake-model-1", u: { i: 100, o: 10, cr: 0 } }),
        JSON.stringify({ at: ts, note: "no usage on this line" }),
        JSON.stringify({ at: ts, m: "fake-model-1", u: { i: 50, o: 5, cr: 2 } }),
      ].join("\n") + "\n",
    );
    await writeDescriptor(path.join(stateDir, "agents.d"), "meteronly.json", {
      name: "meteronly",
      launch: null,
      usageTap: {
        type: "transcript",
        path: logs,
        format: "jsonl",
        fields: { input: ".u.i", output: ".u.o", cacheRead: ".u.cr", model: ".m", timestamp: ".at" },
      },
      pricingHints: { "fake-model-1": { input: 1, output: 2 } },
    });
    const env = { AGENTIC_CODING_HARNESS_STATE_DIR: stateDir, HOME: home };
    const stats = runCli(["stats", "--json"], env, tmp);
    assert.equal(stats.code, 0, stats.stderr);
    const s = JSON.parse(stats.stdout) as { byAgent: Record<string, { records: number; inputTokens: number; outputTokens: number; costUsd: number }> };
    const b = s.byAgent.meteronly;
    assert.ok(b, stats.stdout);
    assert.equal(b.records, 2);
    assert.equal(b.inputTokens, 150);
    assert.equal(b.outputTokens, 15);
    assert.ok(Math.abs(b.costUsd - (150 * 1 + 15 * 2) / 1e6) < 1e-9, String(b.costUsd));

    const filtered = runCli(["stats", "--json", "--agent", "meteronly"], env, tmp);
    assert.equal(filtered.code, 0, filtered.stderr);
    assert.deepEqual(Object.keys((JSON.parse(filtered.stdout) as { byAgent: object }).byAgent), ["meteronly"]);

    const run = runCli(["run", "--agent", "meteronly", "x"], env, tmp);
    assert.notEqual(run.code, 0);
    assert.match(run.stderr, /meter-only/);
  });

  it("readDescriptorTap: a single-file tap path is read directly", async () => {
    const logs = await fs.mkdtemp(path.join(tmp, "one-"));
    const f = path.join(logs, "only.jsonl");
    await fs.writeFile(f, JSON.stringify({ u: { i: 7, o: 3 } }) + "\n");
    const rows = await readDescriptorTap({
      file: "x.json",
      descriptor: {
        name: "one",
        launch: null,
        usageTap: { type: "transcript", path: f, format: "jsonl", fields: { input: ".u.i", output: ".u.o" } },
      },
    });
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.inputTokens, 7);
    assert.equal(rows[0]!.ts, null);
    assert.equal(rows[0]!.sessionId, "only");
  });
});
