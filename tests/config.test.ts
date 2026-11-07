// Config file (#41): `.ach/config.json` / ~/.config/agentic-coding-harness/
// config.json / --config feed flag defaults into run, stats, web and serve.
// Precedence flag > env > file > default. Every child runs with HOME and cwd
// in a temp dir and with every AGENTIC_CODING_HARNESS_* var stripped, so the
// developer's real config and env never leak in.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { z } from "zod";

import {
  applyConfig,
  captureTables,
  configJsonSchema,
  parseArgs,
  takeConfigFlag,
  type SectionCommands,
} from "../src/cli/config.ts";

const CLI = new URL("../src/cli/ach.ts", import.meta.url).pathname;
const NODE = process.execPath;

// A fake agent CLI: one JSONL turn whose vendor-reported cost is FAKE_COST.
const FAKE_JSONL_CLI = `
const rec = { type: 'turn', text: 'done', sid: 'fake-session-1', model: 'fake-model-1', usage: { in: 100, out: 20 } };
if (process.env.FAKE_COST) rec.cost_usd = Number(process.env.FAKE_COST);
process.stdout.write(JSON.stringify(rec) + '\\n');
`;

let tmp: string;
let home: string;
let fake: string;

function cleanEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith("AGENTIC_CODING_HARNESS_")) env[k] = v;
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
  await fs.writeFile(file, typeof body === "string" ? body : JSON.stringify(body, null, 2));
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
    // Known model, so the driver prices the run (vendor-reported cost wins).
    pricingHints: { "fake-model-1": { input: 1, output: 1 } },
  });
  const configFile = path.join(cwd, ".ach", "config.json");
  if (config !== undefined) await writeJson(configFile, config);
  return { cwd, state, configFile };
}

/**
 * `ach run --agent fakeagent --json` with a 0.25 USD reported cost; returns
 * the USD cap the driver enforced, read from its budget warning
 * ("budget: usd cap $0.1000 exceeded ..."), or "none" when no cap was set
 * or the cap was not crossed. A cap below 0.25 always produces the warning.
 */
function runCap(p: { cwd: string; state: string }, flags: string[] = [], env: Record<string, string> = {}): string {
  const r = runCli(["run", "--agent", "fakeagent", "--json", ...flags, "hello"], {
    cwd: p.cwd,
    env: { AGENTIC_CODING_HARNESS_STATE_DIR: p.state, FAKE_COST: "0.25", ...env },
  });
  const line = r.stdout.trim();
  assert.ok(line.startsWith("{"), `no JSON result (code ${r.code}): ${r.stderr}`);
  const res = JSON.parse(line) as { totalCost: number; warnings: string[] };
  assert.equal(res.totalCost, 0.25, "fake agent cost");
  const m = res.warnings.map((w) => /budget: usd cap \$([\d.]+) exceeded/.exec(w)).find((x) => x !== null);
  return m ? m[1]! : "none";
}

type Shown = { files: Array<{ path: string; kind: string; loaded: boolean }>; values: Record<string, { value: unknown; source: string }> };
function show(p: { cwd: string }, args: string[] = [], env: Record<string, string> = {}): Shown {
  const r = runCli(["config", "--show", "--json", ...args], { cwd: p.cwd, env });
  assert.equal(r.code, 0, r.stderr);
  return JSON.parse(r.stdout) as Shown;
}

before(async () => {
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "ach-config-")));
  home = path.join(tmp, "home");
  await fs.mkdir(home, { recursive: true });
  fake = path.join(tmp, "fake-jsonl.mjs");
  await fs.writeFile(fake, FAKE_JSONL_CLI);
});

after(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

describe("acceptance: a file's run.budgetUsd is honored by `ach run` and shown as file-sourced", () => {
  it("run.budgetUsd 0.1 in .ach/config.json caps the 0.25 USD run with no flag; --show says file:<path>", async () => {
    const control = await project();
    assert.equal(runCap(control), "none", "control: no config, no cap");
    const p = await project({ run: { budgetUsd: 0.1 } });
    assert.equal(runCap(p), "0.1000");
    const s = show(p);
    assert.deepEqual(s.values["run.budgetUsd"], { value: 0.1, source: `file:${p.configFile}`, flag: "--budget-usd" });
  });
});

describe("acceptance: precedence flag > env > file > default", () => {
  it("through `ach run`: each layer beats the one below it", async () => {
    // Distinct caps per layer (all below the 0.25 cost) show exactly which won.
    const none = await project();
    assert.equal(runCap(none), "none", "default: no cap");
    const p = await project({ run: { budgetUsd: 0.1 } });
    const env = { AGENTIC_CODING_HARNESS_BUDGET_USD: "0.15" };
    assert.equal(runCap(p), "0.1000", "file beats default");
    assert.equal(runCap(p, [], env), "0.1500", "env beats file");
    assert.equal(runCap(p, ["--budget-usd", "0.2"], env), "0.2000", "flag beats env");
    assert.equal(runCap(p, ["--budget-usd", "0.2"]), "0.2000", "flag beats file");
  });

  it("through `config --show`: the reported source follows the same order", async () => {
    const p = await project({ run: { budgetUsd: 0.1, maxTurns: 3 } });
    const envVar = { AGENTIC_CODING_HARNESS_BUDGET_USD: "10" };
    assert.deepEqual(show(p).values["run.wallMs"], { value: null, source: "default", flag: "--wall-ms" });
    assert.equal(show(p).values["run.budgetUsd"]!.source, `file:${p.configFile}`);
    assert.deepEqual(show(p, [], envVar).values["run.budgetUsd"], {
      value: "10",
      source: "env:AGENTIC_CODING_HARNESS_BUDGET_USD",
      flag: "--budget-usd",
    });
    const withFlag = show(p, ["run", "--", "--budget-usd", "2"], envVar).values;
    assert.deepEqual(withFlag["run.budgetUsd"], { value: "2", source: "flag", flag: "--budget-usd" });
    assert.equal(withFlag["run.maxTurns"]!.source, `file:${p.configFile}`);
  });

  it("project file overrides the user file per key; the user file still supplies the rest", async () => {
    const userFile = await writeJson(path.join(home, ".config", "agentic-coding-harness", "config.json"), {
      stats: { days: 7, tz: "UTC" },
    });
    try {
      const p = await project({ stats: { days: 3 } });
      const v = show(p).values;
      assert.deepEqual(v["stats.days"], { value: 3, source: `file:${p.configFile}`, flag: "--days" });
      assert.deepEqual(v["stats.tz"], { value: "UTC", source: `file:${userFile}`, flag: "--tz" });
    } finally {
      await fs.rm(userFile);
    }
  });
});

describe("acceptance: unknown keys fail loudly, naming file, section and key", () => {
  it("run.bugdetUsd: `ach run` exits non-zero naming the file, section run and key bugdetUsd", async () => {
    const p = await project({ run: { bugdetUsd: 5 } });
    const r = runCli(["run", "--agent", "fakeagent", "hello"], { cwd: p.cwd, env: { AGENTIC_CODING_HARNESS_STATE_DIR: p.state } });
    assert.notEqual(r.code, 0);
    assert.ok(r.stderr.includes(p.configFile), r.stderr);
    assert.match(r.stderr, /section 'run' has unknown key 'bugdetUsd' \(run\.bugdetUsd\)/);
    assert.match(r.stderr, /did you mean 'budgetUsd'/);
    assert.doesNotMatch(r.stdout, /exitStatus/, "the run must not start");
  });

  it("every command rejects the typo, not only the section's own (a stats call fails too)", async () => {
    const p = await project({ run: { bugdetUsd: 5 } });
    const r = runCli(["stats", "--json"], { cwd: p.cwd, env: { AGENTIC_CODING_HARNESS_STATE_DIR: p.state } });
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /unknown key 'bugdetUsd'/);
  });

  it("unknown section, kebab-case key and type mismatch are rejected the same way", async () => {
    const cases: Array<[unknown, RegExp]> = [
      [{ runn: { budgetUsd: 1 } }, /unknown section 'runn' \(did you mean 'run'\?\)/],
      [{ run: { "budget-usd": 1 } }, /unknown key 'budget-usd'.*did you mean 'budgetUsd'\? keys are camelCase/],
      [{ run: { budgetUsd: true } }, /section 'run' key 'budgetUsd' \(run\.budgetUsd, flag --budget-usd\) expects a string or number, got boolean/],
      [{ web: { noOpen: "yes" } }, /section 'web' key 'noOpen'.*expects a boolean, got string/],
      ["{ not json", /not valid JSON/],
    ];
    for (const [body, re] of cases) {
      const p = await project(body);
      const r = runCli(["config", "--show"], { cwd: p.cwd });
      assert.notEqual(r.code, 0, JSON.stringify(body));
      assert.ok(r.stderr.includes(p.configFile), r.stderr);
      assert.match(r.stderr, re);
    }
  });

  it("an explicit --config / AGENTIC_CODING_HARNESS_CONFIG that does not exist is an error", async () => {
    const p = await project();
    const missing = path.join(p.cwd, "nope.json");
    const a = runCli(["--config", missing, "stats", "--json"], { cwd: p.cwd });
    assert.notEqual(a.code, 0);
    assert.ok(a.stderr.includes(missing), a.stderr);
    const b = runCli(["stats", "--json"], { cwd: p.cwd, env: { AGENTIC_CODING_HARNESS_CONFIG: missing } });
    assert.notEqual(b.code, 0);
    assert.ok(b.stderr.includes(missing), b.stderr);
  });
});

describe("acceptance: the published JSON schema validates configs like an editor would", () => {
  it("docs/config.schema.json is the generated schema (`ach config --schema`)", async () => {
    const p = await project();
    const r = runCli(["config", "--schema"], { cwd: p.cwd });
    assert.equal(r.code, 0, r.stderr);
    const published = JSON.parse(await fs.readFile(new URL("../docs/config.schema.json", import.meta.url), "utf8")) as unknown;
    assert.deepEqual(
      published,
      JSON.parse(r.stdout),
      "docs/config.schema.json is stale: regenerate with `ach config --schema > docs/config.schema.json`",
    );
  });

  it("a sample config with $schema passes the published schema; the bugdetUsd typo fails it", async () => {
    const published = JSON.parse(await fs.readFile(new URL("../docs/config.schema.json", import.meta.url), "utf8")) as Record<string, unknown>;
    const validator = z.fromJSONSchema(published as Parameters<typeof z.fromJSONSchema>[0]);
    const sample = {
      $schema: "https://raw.githubusercontent.com/sblattj/agentic-coding-harness/main/docs/config.schema.json",
      stateDir: "~/.agentic-coding-harness",
      run: { budgetUsd: 5, maxTurns: 40, extraArg: ["-c", "x=y"], hermetic: true },
      stats: { days: 7, by: ["model"], tz: "UTC" },
      web: { port: 8399, noOpen: true },
      serve: { port: "8398", maxJobs: 4 },
    };
    assert.equal(validator.safeParse(sample).success, true, JSON.stringify(validator.safeParse(sample).error?.issues));
    assert.equal(validator.safeParse({ run: { bugdetUsd: 5 } }).success, false, "typo key must fail");
    assert.equal(validator.safeParse({ runn: {} }).success, false, "unknown section must fail");
    assert.equal(validator.safeParse({ run: { budgetUsd: true } }).success, false, "wrong type must fail");
    // The loader agrees on the same sample (it is what `ach` itself accepts).
    const p = await project(sample);
    const r = runCli(["config", "--show", "--json"], { cwd: p.cwd });
    assert.equal(r.code, 0, r.stderr);
  });
});

describe("ach config --set / --unset", () => {
  it("--set run.budgetUsd 5 --dry-run prints the resolved config and writes nothing", async () => {
    const p = await project();
    const r = runCli(["config", "--set", "run.budgetUsd", "5", "--dry-run", "--json"], { cwd: p.cwd });
    assert.equal(r.code, 0, r.stderr);
    const out = JSON.parse(r.stdout) as Shown;
    assert.deepEqual(out.values["run.budgetUsd"], { value: 5, source: `file:${p.configFile}`, flag: "--budget-usd" });
    await assert.rejects(fs.stat(p.configFile), /ENOENT/);
    assert.match(r.stderr, /dry run/);
  });

  it("--set writes ./.ach/config.json (with $schema) and `ach run` then honors it; --unset removes it", async () => {
    const p = await project();
    const set = runCli(["config", "--set", "run.budgetUsd", "0.1"], { cwd: p.cwd });
    assert.equal(set.code, 0, set.stderr);
    const doc = JSON.parse(await fs.readFile(p.configFile, "utf8")) as Record<string, unknown>;
    assert.deepEqual(doc, { $schema: configJsonSchemaUrl(), run: { budgetUsd: 0.1 } });
    assert.equal(runCap(p), "0.1000");
    const unset = runCli(["config", "--unset", "run.budgetUsd"], { cwd: p.cwd });
    assert.equal(unset.code, 0, unset.stderr);
    assert.deepEqual(JSON.parse(await fs.readFile(p.configFile, "utf8")), { $schema: configJsonSchemaUrl() });
    assert.equal(runCap(p), "none");
  });

  it("--set rejects an unknown key and a bad boolean without writing", async () => {
    const p = await project();
    const typo = runCli(["config", "--set", "run.bugdetUsd", "5"], { cwd: p.cwd });
    assert.notEqual(typo.code, 0);
    assert.match(typo.stderr, /unknown key 'bugdetUsd'.*did you mean 'budgetUsd'/);
    const bool = runCli(["config", "--set", "web.noOpen", "yes"], { cwd: p.cwd });
    assert.notEqual(bool.code, 0);
    assert.match(bool.stderr, /expects true or false/);
    await assert.rejects(fs.stat(p.configFile), /ENOENT/);
  });

  it("--config <path> is read and written instead of the default search", async () => {
    const p = await project({ run: { budgetUsd: 10 } });
    const alt = path.join(p.cwd, "alt.json");
    const set = runCli(["--config", alt, "config", "--set", "run.budgetUsd", "0.1"], { cwd: p.cwd });
    assert.equal(set.code, 0, set.stderr);
    assert.deepEqual((JSON.parse(await fs.readFile(alt, "utf8")) as { run: unknown }).run, { budgetUsd: 0.1 });
    assert.equal(runCap(p), "none", "default search: project file's 10 USD cap is not crossed");
    assert.equal(runCap(p, [], { AGENTIC_CODING_HARNESS_CONFIG: alt }), "0.1000", "env-selected file");
    assert.equal(runCap(p, ["--budget-usd", "0.2"], { AGENTIC_CODING_HARNESS_CONFIG: alt }), "0.2000");
  });
});

function configJsonSchemaUrl(): string {
  return "https://raw.githubusercontent.com/sblattj/agentic-coding-harness/main/docs/config.schema.json";
}

describe("stateDir and the parseArgs hook", () => {
  it("stateDir (relative to the config file) is the state root when the env var is unset", async () => {
    const p = await project();
    await writeJson(p.configFile, { stateDir: path.relative(path.dirname(p.configFile), p.state) });
    // fakeagent lives only in p.state/agents.d: the run resolves it only if stateDir took effect.
    const r = runCli(["run", "--agent", "fakeagent", "--json", "hello"], { cwd: p.cwd, env: { FAKE_COST: "0.25" } });
    assert.equal(r.code, 0, r.stderr);
    assert.equal((JSON.parse(r.stdout) as { exitStatus: string }).exitStatus, "success");
    const control = runCli(["run", "--agent", "fakeagent", "--json", "hello"], { cwd: await fs.mkdtemp(path.join(tmp, "bare-")) });
    assert.notEqual(control.code, 0, "control: without the config, fakeagent is unknown");
    assert.deepEqual(show(p).values.stateDir, { value: p.state, source: `file:${p.configFile}` });
    // env still wins over the file
    const other = path.join(tmp, "other-state");
    assert.deepEqual(show(p, [], { AGENTIC_CODING_HARNESS_STATE_DIR: other }).values.stateDir, {
      value: other,
      source: "env:AGENTIC_CODING_HARNESS_STATE_DIR",
    });
  });

  it("a flag added to a command later is configurable with no config edit; tokens see injected values", async () => {
    // A stand-in command with options no section has today: the hook derives
    // its keys from whatever table the command passes to parseArgs.
    const table = { "brand-new": { type: "string" }, "new-list": { type: "string", multiple: true }, loud: { type: "boolean", default: false } } as const;
    let got: { values: Record<string, unknown>; tokens?: Array<{ kind: string; name?: string; value?: string }> } | undefined;
    const fakeRun = async (rest: string[]) => {
      got = parseArgs({ args: rest, options: table, allowPositionals: true, tokens: true }) as never;
      return 0;
    };
    const stub = async (rest: string[]) => {
      parseArgs({ args: rest, options: {}, allowPositionals: true });
      return 0;
    };
    const commands: SectionCommands = { run: fakeRun, stats: stub, web: stub, serve: stub };
    const tables = await captureTables(commands);
    assert.deepEqual(Object.keys(tables.run), ["brand-new", "new-list", "loud"]);
    assert.ok(Object.keys((configJsonSchema(tables).properties as Record<string, { properties?: object }>).run!.properties!).includes("brandNew"));

    const cfg = path.join(tmp, "hook.json");
    await writeJson(cfg, { run: { brandNew: 7, newList: ["a", "b"], loud: true } });
    await applyConfig("run", cfg, commands);
    await fakeRun(["--new-list", "cli"]);
    assert.equal(got!.values["brand-new"], "7");
    assert.deepEqual(got!.values["new-list"], ["cli"], "the flag beats the file");
    assert.equal(got!.values.loud, true);
    assert.deepEqual(
      got!.tokens!.filter((t) => t.kind === "option").map((t) => [t.name, t.value]),
      [["brand-new", "7"], ["loud", undefined], ["new-list", "cli"]],
    );
    // Disarmed after one call: the next parse is plain node:util parseArgs.
    await fakeRun([]);
    assert.equal(got!.values["brand-new"], undefined);
  });

  it("takeConfigFlag peels only leading --config forms", () => {
    assert.deepEqual(takeConfigFlag(["--config", "a.json", "run", "x"]), { argv: ["run", "x"], config: "a.json" });
    assert.deepEqual(takeConfigFlag(["--config=b.json", "stats"]), { argv: ["stats"], config: "b.json" });
    assert.deepEqual(takeConfigFlag(["run", "--config", "c"]), { argv: ["run", "--config", "c"], config: undefined });
    assert.throws(() => takeConfigFlag(["--config"]), /--config requires a path/);
  });

  it("`ach --help` and `ach config --help` document the config command", async () => {
    const p = await project();
    const top = runCli(["--help"], { cwd: p.cwd });
    assert.match(top.stdout, /ach config --show/);
    assert.match(top.stdout, /AGENTIC_CODING_HARNESS_CONFIG/);
    const sub = runCli(["config", "--help"], { cwd: p.cwd });
    assert.equal(sub.code, 0);
    assert.match(sub.stdout, /ach config --set <key> <value> \[--dry-run\]/);
  });
});
