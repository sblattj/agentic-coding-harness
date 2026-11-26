// Agent profiles (#77): `profiles.<name>` in the config file, expanded by
// `ach run --profile <name>` in the config choke point (src/cli/config.ts).
// Precedence flag > env > profile > file `run` > default. Every child runs
// with HOME and cwd in a temp dir and every AGENTIC_CODING_HARNESS_* var
// stripped, so the developer's real config and env never leak in.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { z } from "zod";

import { listRunRecords, readRunRecord, registryDir } from "../src/core/registry.ts";

const CLI = new URL("../src/cli/ach.ts", import.meta.url).pathname;
const NODE = process.execPath;

// A fake agent CLI (agents.d descriptor): one JSONL turn costing FAKE_COST USD.
const FAKE_JSONL_CLI = `
const rec = { type: 'turn', text: 'done', sid: 'fake-session-1', model: 'fake-model-1', usage: { in: 100, out: 20 } };
if (process.env.FAKE_COST) rec.cost_usd = Number(process.env.FAKE_COST);
process.stdout.write(JSON.stringify(rec) + '\\n');
`;

// A fake kiro-cli: appends its argv (one word per line) and the PROFILE_ENV_PROBE
// env var to $KIRO_ARGV_LOG, then emits a minimal successful stream.
const FAKE_KIRO = `#!/bin/sh
if [ "$1" = "--version" ]; then echo "kiro-cli 1.0.0"; exit 0; fi
for a in "$@"; do printf 'arg %s\\n' "$a" >> "$KIRO_ARGV_LOG"; done
printf 'env PROFILE_ENV_PROBE=%s\\n' "$PROFILE_ENV_PROBE" >> "$KIRO_ARGV_LOG"
echo '{"type":"session_start","sessionId":"sess-profile"}'
echo '{"type":"assistant","text":"done"}'
exit 0
`;

let tmp: string;
let home: string;
let fake: string;
let fakeKiro: string;

function cleanEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!k.startsWith("AGENTIC_CODING_HARNESS_") && k !== "PROFILE_ENV_PROBE") env[k] = v;
  }
  return { ...env, HOME: home, ...extra };
}

function runCli(args: string[], opts: { cwd: string; env?: Record<string, string> }) {
  const isBun = (process.versions as { bun?: string }).bun !== undefined;
  const p = spawnSync(NODE, isBun ? [CLI, ...args] : ["--import", import.meta.resolve("tsx"), CLI, ...args], {
    env: cleanEnv(opts.env ?? {}),
    cwd: opts.cwd,
    encoding: "utf8",
  });
  return { code: p.status ?? -1, stdout: p.stdout ?? "", stderr: p.stderr ?? "" };
}

async function writeJson(file: string, body: unknown): Promise<string> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(body, null, 2));
  return file;
}

/** A fresh project dir (cwd) and state dir holding the fake agent descriptor. */
async function project(config?: unknown): Promise<{ cwd: string; state: string; configFile: string }> {
  const cwd = await fs.mkdtemp(path.join(tmp, "proj-"));
  const state = await fs.mkdtemp(path.join(tmp, "state-"));
  await writeJson(path.join(state, "agents.d", "fakeagent.json"), {
    name: "fakeagent",
    launch: {
      template: `'${NODE}' '${fake}' {prompt}`,
      output: {
        format: "jsonl",
        text: ".text",
        sessionId: ".sid",
        usage: { input: ".usage.in", output: ".usage.out", model: ".model", costUsd: ".cost_usd" },
      },
    },
    usageTap: null,
    pricingHints: { "fake-model-1": { input: 1, output: 1 } },
  });
  const configFile = path.join(cwd, ".ach", "config.json");
  if (config !== undefined) await writeJson(configFile, config);
  return { cwd, state, configFile };
}

/** The USD cap `ach run --agent fakeagent` enforced (0.25 USD run), or "none". */
function runCap(p: { cwd: string; state: string }, flags: string[], env: Record<string, string> = {}): string {
  const r = runCli(["run", "--json", ...flags, "hello"], {
    cwd: p.cwd,
    env: { AGENTIC_CODING_HARNESS_STATE_DIR: p.state, FAKE_COST: "0.25", ...env },
  });
  const line = r.stdout.trim();
  assert.ok(line.startsWith("{"), `no JSON result (code ${r.code}): ${r.stderr}`);
  const res = JSON.parse(line) as { warnings: string[] };
  const m = res.warnings.map((w) => /budget: usd cap \$([\d.]+) exceeded/.exec(w)).find((x) => x !== null);
  return m ? m[1]! : "none";
}

function onlyRecord(state: string) {
  const recs = listRunRecords(state);
  assert.equal(recs.length, 1, `expected one run record in ${state}`);
  return recs[0]!;
}

/** `ach run --agent kiro ...` against the fake kiro-cli; returns the argv/env log and the --json result. */
async function kiroRun(p: { cwd: string; state: string }, flags: string[], env: Record<string, string> = {}) {
  const log = path.join(p.state, `kiro-argv-${Math.random().toString(36).slice(2)}.log`);
  const r = runCli(["run", "--json", ...flags, "same prompt"], {
    cwd: p.cwd,
    env: { AGENTIC_CODING_HARNESS_STATE_DIR: p.state, KIRO_CLI_BIN: fakeKiro, MITMDUMP_BIN: "/nonexistent/mitmdump", KIRO_ARGV_LOG: log, ...env },
  });
  assert.equal(r.code, 0, r.stderr);
  return { log: await fs.readFile(log, "utf8"), result: JSON.parse(r.stdout) as Record<string, unknown> & { runId: string } };
}

before(async () => {
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "ach-profiles-")));
  home = path.join(tmp, "home");
  await fs.mkdir(home, { recursive: true });
  fake = path.join(tmp, "fake-jsonl.mjs");
  await fs.writeFile(fake, FAKE_JSONL_CLI);
  fakeKiro = path.join(tmp, "fake-kiro.sh");
  await fs.writeFile(fakeKiro, FAKE_KIRO);
  await fs.chmod(fakeKiro, 0o755);
});

after(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

const KIRO_PROFILE = {
  agent: "kiro",
  model: "m-1",
  maxTurns: 5,
  wallMs: 60000,
  kiroAgent: "dev",
  kiroTools: "all",
  extraArg: ["--trust-all-tools"],
  env: { PROFILE_ENV_PROBE: "from-profile" },
};
const KIRO_FLAGS = ["--agent", "kiro", "--model", "m-1", "--max-turns", "5", "--wall-ms", "60000", "--kiro-agent", "dev", "--kiro-tools", "all", "--extra-arg", "--trust-all-tools"];

describe("acceptance 1: `ach run --profile <name>` is the same invocation as typing the flags", () => {
  it("the agent CLI gets the same argv and env, and the run the same resolved kiro config", async () => {
    const p = await project({ profiles: { fastkiro: KIRO_PROFILE } });
    const profiled = await kiroRun(p, ["--profile", "fastkiro"]);
    const byHand = await kiroRun(p, KIRO_FLAGS, { PROFILE_ENV_PROBE: "from-profile" });
    // control: the probe distinguishes runs (no env, no profile flags = a different log)
    const control = await kiroRun(p, ["--agent", "kiro"]);
    assert.notEqual(control.log, byHand.log, "control: a bare run must log a different invocation");
    assert.match(profiled.log, /^arg dev$/m, "the profile's --kiro-agent reached kiro-cli");
    assert.match(profiled.log, /^env PROFILE_ENV_PROBE=from-profile$/m, "the profile's env reached the agent process");
    assert.equal(profiled.log, byHand.log, "kiro-cli argv + env");
    assert.deepEqual((profiled.result.kiro as { requested: unknown }).requested, (byHand.result.kiro as { requested: unknown }).requested);
  });

  it("an unknown profile name is a usage error that lists the available profiles", async () => {
    const p = await project({ profiles: { a: { agent: "null" }, b: { agent: "null" } } });
    const r = runCli(["run", "--profile", "zzz", "hi"], { cwd: p.cwd, env: { AGENTIC_CODING_HARNESS_STATE_DIR: p.state } });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /unknown profile 'zzz' \(available: a, b\)/);
  });

  it("--profile with no config file at all is an unknown-profile error, not silently ignored", async () => {
    const p = await project();
    const r = runCli(["run", "--profile", "fast", "--agent", "null", "hi"], { cwd: p.cwd, env: { AGENTIC_CODING_HARNESS_STATE_DIR: p.state } });
    assert.equal(r.code, 1, r.stdout);
    assert.match(r.stderr, /unknown profile 'fast' \(no profiles are defined/);
  });
});

describe("acceptance 2: an explicit flag overrides the profile; the RunRecord shows name and effective value", () => {
  it("--budget-usd 0.2 beats the profile's 0.1 (enforced cap), and profile.expanded says 0.2 from flag", async () => {
    const p = await project({ profiles: { capped: { agent: "fakeagent", budgetUsd: 0.1 } } });
    assert.equal(runCap(p, ["--profile", "capped"]), "0.1000", "the profile's cap applies");
    const p2 = await project({ profiles: { capped: { agent: "fakeagent", budgetUsd: 0.1 } } });
    assert.equal(runCap(p2, ["--profile", "capped", "--budget-usd", "0.2"]), "0.2000", "the flag beats the profile");
    const rec = onlyRecord(p2.state);
    assert.equal(rec.profile?.name, "capped");
    assert.equal(rec.profile?.expanded["budget-usd"], "0.2");
    assert.equal(rec.profile?.sources["budget-usd"], "flag");
    assert.deepEqual(rec.profile?.overridden, { "budget-usd": 0.1 });
    assert.equal(rec.profile?.sources.agent, "profile:capped");
  });

  it("precedence: flag > env > profile > file run section > default", async () => {
    const cfg = { run: { budgetUsd: 0.05 }, profiles: { capped: { agent: "fakeagent", budgetUsd: 0.1 } } };
    assert.equal(runCap(await project(cfg), ["--agent", "fakeagent"]), "0.0500", "no profile: the file's run section");
    assert.equal(runCap(await project(cfg), ["--profile", "capped"]), "0.1000", "profile beats the file's run section");
    const env = { AGENTIC_CODING_HARNESS_BUDGET_USD: "0.15" };
    assert.equal(runCap(await project(cfg), ["--profile", "capped"], env), "0.1500", "env beats profile");
    assert.equal(runCap(await project(cfg), ["--profile", "capped", "--budget-usd", "0.2"], env), "0.2000", "flag beats env");
  });

  it("run.profile in the file selects a default profile; --profile on the command line wins over it", async () => {
    const cfg = { run: { profile: "low" }, profiles: { low: { agent: "fakeagent", budgetUsd: 0.1 }, high: { agent: "fakeagent", budgetUsd: 0.2 } } };
    assert.equal(runCap(await project(cfg), []), "0.1000");
    assert.equal(runCap(await project(cfg), ["--profile", "high"]), "0.2000");
  });
});

describe("acceptance 3: `ach profiles list` prints every profile with its flag expansion", () => {
  it("text and --json list each profile's argv; env values are never printed", async () => {
    const p = await project({ profiles: { fastkiro: KIRO_PROFILE, cheap: { agent: "claude", model: "sonnet", budgetUsd: 1, claudeDefaultConfig: true } } });
    const r = runCli(["profiles", "list"], { cwd: p.cwd });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /^cheap\s+ach run --agent=claude --model=sonnet --budget-usd=1 --claude-default-config$/m);
    assert.match(r.stdout, /^fastkiro\s+ach run --agent=kiro --model=m-1 --max-turns=5 --wall-ms=60000 --extra-arg=--trust-all-tools --kiro-agent=dev --kiro-tools=all$/m);
    assert.match(r.stdout, /env \(agent process only\): PROFILE_ENV_PROBE/);
    assert.ok(!r.stdout.includes("from-profile"), "env value must not be printed");
    const j = runCli(["profiles", "list", "--json"], { cwd: p.cwd });
    assert.equal(j.code, 0, j.stderr);
    const out = JSON.parse(j.stdout) as { profiles: Array<{ name: string; argv: string[]; envKeys: string[]; flags: Record<string, unknown> }> };
    assert.deepEqual(out.profiles.map((x) => x.name), ["cheap", "fastkiro"]);
    assert.deepEqual(out.profiles[1]!.envKeys, ["PROFILE_ENV_PROBE"]);
    assert.ok(!j.stdout.includes("from-profile"));
  });

  it("no profiles: a hint, exit 0", async () => {
    const p = await project();
    const r = runCli(["profiles", "list"], { cwd: p.cwd });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /no profiles defined/);
  });

  it("`ach profiles --help` prints its own usage lines", async () => {
    const p = await project();
    const r = runCli(["profiles", "--help"], { cwd: p.cwd });
    assert.equal(r.code, 0);
    assert.match(r.stdout, /^usage:\n  ach profiles list \[--json\]/);
  });
});

describe("acceptance 4: an illegal adapter flag combination is rejected when the profile is saved", () => {
  const dupA = JSON.stringify({ name: "a", command: "echo" });
  const dupB = JSON.stringify({ name: "a", command: "cat" });

  it("config --set rejects it with the run-time validateProfile message, and writes nothing", async () => {
    const p = await project();
    // The run-time message, from typing the same flags by hand.
    const runTime = runCli(["run", "--agent", "kiro", "--kiro-mcp-server", dupA, "--kiro-mcp-server", dupB, "hi"], {
      cwd: p.cwd,
      env: { AGENTIC_CODING_HARNESS_STATE_DIR: p.state, KIRO_CLI_BIN: fakeKiro, MITMDUMP_BIN: "/nonexistent/mitmdump" },
    });
    assert.equal(runTime.code, 1);
    const msg = /harness: (agent "kiro" profile validation failed: .*)$/m.exec(runTime.stderr)?.[1];
    assert.ok(msg !== undefined, runTime.stderr);
    assert.match(msg!, /duplicate MCP server name 'a'/);

    const ok = runCli(["config", "--set", "profiles.k.agent", "kiro"], { cwd: p.cwd });
    assert.equal(ok.code, 0, ok.stderr);
    const before = await fs.readFile(p.configFile, "utf8");
    const bad = runCli(["config", "--set", "profiles.k.kiroMcpServer", JSON.stringify([dupA, dupB])], { cwd: p.cwd });
    assert.equal(bad.code, 1, bad.stdout);
    assert.ok(bad.stderr.includes(msg!), `save-time message must contain the run-time one:\n${bad.stderr}`);
    assert.match(bad.stderr, /profile 'k' not saved/);
    assert.equal(await fs.readFile(p.configFile, "utf8"), before, "file unchanged");

    // A legal value for the same key is saved (the check is not a blanket refusal).
    const good = runCli(["config", "--set", "profiles.k.kiroMcpServer", JSON.stringify([dupA])], { cwd: p.cwd });
    assert.equal(good.code, 0, good.stderr);
  });

  it("the check covers the whole merged profile: setting the agent last is rejected too, also under --dry-run", async () => {
    const p = await project({ profiles: { k: { kiroMcpServer: [dupA, dupB] } } });
    const r = runCli(["config", "--set", "profiles.k.agent=kiro", "--dry-run"], { cwd: p.cwd });
    assert.equal(r.code, 1, r.stdout);
    assert.match(r.stderr, /agent "kiro" profile validation failed: kiro\.mcpServers\.1\.name: duplicate MCP server name 'a'/);
  });

  it("a bad model on a claude profile is rejected with claude's own validateProfile message", async () => {
    const p = await project({ profiles: { c: { agent: "claude" } } });
    const r = runCli(["config", "--set", "profiles.c.resume", "has space"], { cwd: p.cwd });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /agent "claude" profile validation failed: resume: session id 'has space' must not contain whitespace or path separators/);
  });
});

describe("acceptance 5: a profiled RunRecord is enough to re-run the same invocation", () => {
  it("record.profile.argv, run with no profile and no config, reproduces the agent invocation byte for byte", async () => {
    const p = await project({ profiles: { fastkiro: KIRO_PROFILE } });
    const first = await kiroRun(p, ["--profile", "fastkiro"]);
    const rec = readRunRecord(p.state, first.result.runId);
    assert.ok(rec?.profile, "the record carries the profile");
    assert.equal(rec!.profile!.name, "fastkiro");
    assert.deepEqual(rec!.profile!.envKeys, ["PROFILE_ENV_PROBE"]);
    // Re-run from the record alone: a fresh project with NO config file.
    const bare = await project();
    const env: Record<string, string> = Object.fromEntries(rec!.profile!.envKeys!.map((k) => [k, "from-profile"]));
    const again = await kiroRun(bare, rec!.profile!.argv, env);
    assert.equal(again.log, first.log);
    assert.deepEqual((again.result.kiro as { requested: unknown }).requested, (first.result.kiro as { requested: unknown }).requested);
  });

  it("env values and inline MCP JSON never reach the registry file; old records without `profile` still load", async () => {
    const secretEnv = "SECRET-ENV-VALUE-1b2c";
    const secretMcp = JSON.stringify({ mcpServers: { s: { command: "x", env: { TOKEN: "SECRET-MCP-TOKEN-9z" } } } });
    const p = await project({ profiles: { s: { agent: "null", mcpConfig: secretMcp, env: { API_TOKEN: secretEnv } } } });
    const r = runCli(["run", "--profile", "s", "--json", "hi"], { cwd: p.cwd, env: { AGENTIC_CODING_HARNESS_STATE_DIR: p.state } });
    assert.equal(r.code, 0, r.stderr);
    const files = await fs.readdir(registryDir(p.state));
    const raw = await fs.readFile(path.join(registryDir(p.state), files.find((f) => f.endsWith(".json"))!), "utf8");
    assert.ok(raw.includes('"API_TOKEN"'), "control: the env key name is recorded");
    assert.ok(!raw.includes(secretEnv), "env value leaked into the RunRecord");
    assert.ok(!raw.includes("SECRET-MCP-TOKEN-9z"), "inline MCP JSON leaked into the RunRecord");
    const rec = onlyRecord(p.state);
    assert.deepEqual(rec.profile?.redacted, ["mcp-config"]);
    assert.match(String(rec.profile?.expanded["mcp-config"]), /^<inline JSON, \d+ bytes>$/);

    // An old record (no profile field) is still read.
    const old = { runId: "old-run-1", agent: "null", sessionId: "s", pid: 1, startedAt: 1, status: "success" };
    await fs.writeFile(path.join(registryDir(p.state), "old-run-1.json"), JSON.stringify(old));
    const back = readRunRecord(p.state, "old-run-1");
    assert.ok(back !== null);
    assert.equal(back!.profile, undefined);
  });
});

describe("profiled runs: every path keeps the profile and no secret", () => {
  it("--repeat 2: every record carries the profile and every agent child sees the profile env", async () => {
    const p = await project({ profiles: { fastkiro: KIRO_PROFILE } });
    const { log } = await kiroRun(p, ["--profile", "fastkiro", "--repeat", "2"]);
    assert.equal(log.match(/^env PROFILE_ENV_PROBE=from-profile$/gm)?.length, 2, log);
    const recs = listRunRecords(p.state);
    assert.equal(recs.length, 2);
    for (const rec of recs) {
      assert.equal(rec.profile?.name, "fastkiro");
      assert.equal(rec.profile?.expanded["kiro-agent"], "dev");
    }
  });

  it("a profile env value reaches the kiro child but no file under the state dir", async () => {
    const secret = "SECRET-ENV-VALUE-7q8w";
    const p = await project({ profiles: { s: { agent: "kiro", env: { PROFILE_ENV_PROBE: secret } } } });
    const { log, result } = await kiroRun(p, ["--profile", "s"]);
    assert.match(log, new RegExp(`^env PROFILE_ENV_PROBE=${secret}$`, "m"), "control: the child got the value");
    assert.ok(!JSON.stringify(result).includes(secret), "--json output leaked the env value");
    const leaks: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      for (const ent of await fs.readdir(dir, { withFileTypes: true })) {
        const f = path.join(dir, ent.name);
        if (ent.isDirectory()) await walk(f);
        else if (!ent.name.startsWith("kiro-argv-") && (await fs.readFile(f, "utf8")).includes(secret)) leaks.push(f);
      }
    };
    await walk(p.state);
    assert.deepEqual(leaks, []);
  });

  it("a profile's inline MCP JSON beaten by a flag is masked in `overridden` too", async () => {
    const token = "SECRET-MCP-TOKEN-4r5t";
    const profMcp = JSON.stringify({ mcpServers: { s: { command: "x", env: { TOKEN: token } } } });
    const flagMcp = JSON.stringify({ mcpServers: { other: { command: "y" } } });
    const p = await project({ profiles: { s: { agent: "null", mcpConfig: profMcp } } });
    const r = runCli(["run", "--profile", "s", "--mcp-config", flagMcp, "--json", "hi"], { cwd: p.cwd, env: { AGENTIC_CODING_HARNESS_STATE_DIR: p.state } });
    assert.equal(r.code, 0, r.stderr);
    assert.ok(!r.stdout.includes(token), "--json output leaked the profile's MCP JSON");
    const rec = onlyRecord(p.state);
    assert.equal(rec.profile?.sources["mcp-config"], "flag");
    assert.match(String(rec.profile?.overridden?.["mcp-config"]), /^<inline JSON, \d+ bytes>$/);
    const files = await fs.readdir(registryDir(p.state));
    for (const f of files) assert.ok(!(await fs.readFile(path.join(registryDir(p.state), f), "utf8")).includes(token), f);
  });
});

describe("profiles in the config file", () => {
  it("every `run` flag is a profile key (derived from the flag table, no hand list); `profile` itself is not", async () => {
    const p = await project();
    const r = runCli(["config", "--schema"], { cwd: p.cwd });
    assert.equal(r.code, 0, r.stderr);
    const schema = JSON.parse(r.stdout) as { properties: Record<string, { properties?: Record<string, unknown>; additionalProperties?: { properties: Record<string, unknown> } }> };
    const runKeys = Object.keys(schema.properties.run!.properties!);
    const profKeys = Object.keys(schema.properties.profiles!.additionalProperties!.properties);
    assert.ok(runKeys.includes("profile"), "control: run.profile is a run key");
    assert.deepEqual(profKeys.sort(), [...runKeys.filter((k) => k !== "profile"), "env"].sort());
    // The loader agrees with the schema.
    const bad = await project({ profiles: { x: { profile: "y" } } });
    const rb = runCli(["profiles", "list"], { cwd: bad.cwd });
    assert.equal(rb.code, 1);
    assert.match(rb.stderr, /profile 'x' has unknown key 'profile' .*a profile cannot select another profile/);
  });

  it("the published schema accepts a sample with profiles and rejects a typo key, a dotted name and a non-string env value", async () => {
    const published = JSON.parse(await fs.readFile(new URL("../docs/config.schema.json", import.meta.url), "utf8")) as Record<string, unknown>;
    const validator = z.fromJSONSchema(published as Parameters<typeof z.fromJSONSchema>[0]);
    const sample = { profiles: { fast: { agent: "claude", model: "sonnet", budgetUsd: 5, extraArg: ["-c", "x"], env: { FOO: "1" } } } };
    assert.equal(validator.safeParse(sample).success, true, JSON.stringify(validator.safeParse(sample).error?.issues));
    assert.equal(validator.safeParse({ profiles: { fast: { bugdetUsd: 5 } } }).success, false, "typo key");
    assert.equal(validator.safeParse({ profiles: { "a.b": { agent: "claude" } } }).success, false, "dotted name");
    assert.equal(validator.safeParse({ profiles: { fast: { env: { FOO: 1 } } } }).success, false, "env value type");
    const p = await project(sample);
    assert.equal(runCli(["profiles", "list"], { cwd: p.cwd }).code, 0, "the loader accepts the same sample");
  });

  it("the loader rejects a bad profile with a message naming the file, profile and key", async () => {
    const p = await project({ profiles: { fast: { bugdetUsd: 5 } } });
    const r = runCli(["run", "--agent", "null", "hi"], { cwd: p.cwd, env: { AGENTIC_CODING_HARNESS_STATE_DIR: p.state } });
    assert.equal(r.code, 1);
    assert.ok(r.stderr.includes(`config ${p.configFile}: profile 'fast' has unknown key 'bugdetUsd' (profiles.fast.bugdetUsd) (did you mean 'budgetUsd'?)`), r.stderr);
  });

  it("user and project files merge per profile key (project wins); relative paths resolve against the file", async () => {
    const p = await project({ profiles: { fast: { model: "project-model", evidenceDir: "ev" } } });
    await writeJson(path.join(home, ".config", "agentic-coding-harness", "config.json"), { profiles: { fast: { agent: "null", model: "user-model" } } });
    try {
      const r = runCli(["profiles", "list", "--json"], { cwd: p.cwd });
      assert.equal(r.code, 0, r.stderr);
      const prof = (JSON.parse(r.stdout) as { profiles: Array<{ flags: Record<string, unknown> }> }).profiles[0]!;
      assert.deepEqual(prof.flags, { agent: "null", model: "project-model", evidenceDir: path.join(p.cwd, ".ach", "ev") });
    } finally {
      await fs.rm(path.join(home, ".config"), { recursive: true, force: true });
    }
  });

  it("config --set / --unset edit profile keys and env entries; --show run -- --profile names the profile as the source", async () => {
    const p = await project();
    assert.equal(runCli(["config", "--set", "profiles.fast.agent", "null"], { cwd: p.cwd }).code, 0);
    assert.equal(runCli(["config", "--set", "profiles.fast.maxTurns=3"], { cwd: p.cwd }).code, 0);
    assert.equal(runCli(["config", "--set", "profiles.fast.env.FOO", "bar"], { cwd: p.cwd }).code, 0);
    let doc = JSON.parse(await fs.readFile(p.configFile, "utf8")) as Record<string, unknown>;
    assert.deepEqual(doc.profiles, { fast: { agent: "null", maxTurns: 3, env: { FOO: "bar" } } });
    const typo = runCli(["config", "--set", "profiles.fast.maxTurn", "3"], { cwd: p.cwd });
    assert.equal(typo.code, 1);
    assert.match(typo.stderr, /unknown key 'maxTurn' .*did you mean 'maxTurns'/);
    assert.equal(runCli(["config", "--set", "profiles.a.b.agent", "null"], { cwd: p.cwd }).code, 1, "dotted profile name");

    const shown = runCli(["config", "--show", "run", "--json", "--", "--profile", "fast"], { cwd: p.cwd });
    assert.equal(shown.code, 0, shown.stderr);
    const values = (JSON.parse(shown.stdout) as { values: Record<string, { value: unknown; source: string }> }).values;
    assert.deepEqual(values["run.maxTurns"], { value: 3, source: "profile:fast", flag: "--max-turns" });

    assert.equal(runCli(["config", "--unset", "profiles.fast.env.FOO"], { cwd: p.cwd }).code, 0);
    doc = JSON.parse(await fs.readFile(p.configFile, "utf8")) as Record<string, unknown>;
    assert.deepEqual(doc.profiles, { fast: { agent: "null", maxTurns: 3 } }, "empty env map dropped");
    assert.equal(runCli(["config", "--unset", "profiles.fast"], { cwd: p.cwd }).code, 0);
    doc = JSON.parse(await fs.readFile(p.configFile, "utf8")) as Record<string, unknown>;
    assert.equal(doc.profiles, undefined, "whole profile removed");
  });
});

describe("profiles carry --effort (#77 with #54)", () => {
  it("a profile's effort reaches the agent CLI like a typed --effort, and the record says requested high", async () => {
    const p = await project({ profiles: { deep: { agent: "kiro", effort: "high" } } });
    const profiled = await kiroRun(p, ["--profile", "deep"]);
    const byHand = await kiroRun(p, ["--agent", "kiro", "--effort", "high"]);
    // control: a bare kiro run passes no --effort, so the probe can tell them apart.
    const control = await kiroRun(p, ["--agent", "kiro"]);
    assert.doesNotMatch(control.log, /^arg --effort$/m, "control: no --effort without the flag or profile");
    assert.match(profiled.log, /^arg --effort\narg high$/m, "the profile's effort reached kiro-cli");
    assert.equal(profiled.log, byHand.log, "kiro-cli argv + env");
    const rec = readRunRecord(p.state, profiled.result.runId) as { effort?: { requested?: string } } | null;
    assert.equal(rec?.effort?.requested, "high");
  });
});
