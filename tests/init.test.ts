// `ach init` (#80): first-run setup writing the #41 config file. Children run
// with HOME, cwd and the state dir in temp dirs and a PATH that holds only the
// stub agent binaries a case needs, so the developer's real config, env and
// installed agents never leak in.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { after, before, describe, it } from "node:test";

import { parseArgs, type SectionCommands } from "../src/cli/config.ts";
import { cmdInit, detectAgents, type InitIo } from "../src/cli/init.ts";

const CLI = new URL("../src/cli/ach.ts", import.meta.url).pathname;
const NODE = process.execPath;

let tmp: string;

/** A bin dir holding exactly the named stub executables (each answers --version). */
async function binDir(...names: string[]): Promise<string> {
  const dir = await fs.mkdtemp(path.join(tmp, "bin-"));
  for (const n of names) {
    const p = path.join(dir, n);
    await fs.writeFile(p, `#!/bin/sh\necho "${n} 1.2.3"\n`);
    await fs.chmod(p, 0o755);
  }
  return dir;
}

interface Sandbox {
  home: string;
  cwd: string;
  state: string;
  bin: string;
}
async function sandbox(...stubs: string[]): Promise<Sandbox> {
  return {
    home: await fs.mkdtemp(path.join(tmp, "home-")),
    cwd: await fs.mkdtemp(path.join(tmp, "proj-")),
    state: await fs.mkdtemp(path.join(tmp, "state-")),
    bin: await binDir(...stubs),
  };
}
const userFile = (sb: Sandbox) => path.join(sb.home, ".config", "agentic-coding-harness", "config.json");
const projectFile = (sb: Sandbox) => path.join(sb.cwd, ".ach", "config.json");
const readJson = (p: string) => JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;

function ach(sb: Sandbox, args: string[]) {
  const isBun = (process.versions as { bun?: string }).bun !== undefined;
  const p = spawnSync(NODE, isBun ? [CLI, ...args] : ["--import", import.meta.resolve("tsx"), CLI, ...args], {
    env: { HOME: sb.home, PATH: sb.bin, AGENTIC_CODING_HARNESS_STATE_DIR: sb.state },
    cwd: sb.cwd,
    encoding: "utf8",
    input: "", // piped, closed stdin: never a TTY
  });
  return { code: p.status ?? -1, stdout: p.stdout ?? "", stderr: p.stderr ?? "" };
}

// Real flag names for the tables `init` reads its config keys from (captureTables).
const RUN_OPTIONS = { agent: { type: "string" }, model: { type: "string" }, "budget-usd": { type: "string" }, "max-turns": { type: "string" } } as const;
const fakeCommands: SectionCommands = {
  run: async (rest) => (parseArgs({ args: rest, options: RUN_OPTIONS }), 0),
  stats: async (rest) => (parseArgs({ args: rest, options: { days: { type: "string" } } }), 0),
  web: async (rest) => (parseArgs({ args: rest, options: { port: { type: "string" } } }), 0),
  serve: async (rest) => (parseArgs({ args: rest, options: { port: { type: "string" } } }), 0),
};

/** Drive the TTY wizard in-process: answer each prompt in order. */
async function wizard(sb: Sandbox, answers: string[], flags: string[] = []): Promise<{ code: number; out: string }> {
  const stdin = Object.assign(new PassThrough(), { isTTY: true });
  const stdout = Object.assign(new PassThrough(), { isTTY: true });
  let out = "";
  let next = 0;
  let seen = 0;
  stdout.on("data", (b: Buffer) => {
    out += b.toString();
    const prompts = (out.match(/Default agent|Default model|Budget cap|Max turns|Write this config\?/g) ?? []).length;
    while (seen < prompts && next < answers.length) {
      seen++;
      const a = answers[next++]!;
      setTimeout(() => stdin.write(a + "\n"), 5);
    }
  });
  const saved = { PATH: process.env.PATH, HOME: process.env.HOME, STATE: process.env.AGENTIC_CODING_HARNESS_STATE_DIR, CFG: process.env.AGENTIC_CODING_HARNESS_CONFIG };
  process.env.PATH = sb.bin;
  process.env.HOME = sb.home;
  process.env.AGENTIC_CODING_HARNESS_STATE_DIR = sb.state;
  delete process.env.AGENTIC_CODING_HARNESS_CONFIG;
  const cwd = process.cwd();
  process.chdir(sb.cwd);
  const realStderr = process.stderr.write.bind(process.stderr);
  process.stderr.write = (() => true) as typeof process.stderr.write;
  try {
    const code = await cmdInit(flags, undefined, fakeCommands, { stdin, stdout } as InitIo);
    return { code, out };
  } finally {
    process.stderr.write = realStderr;
    process.chdir(cwd);
    for (const [k, v] of [["PATH", saved.PATH], ["HOME", saved.HOME], ["AGENTIC_CODING_HARNESS_STATE_DIR", saved.STATE], ["AGENTIC_CODING_HARNESS_CONFIG", saved.CFG]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

before(async () => {
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "ach-init-")));
});
after(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

describe("acceptance 1: exactly one agent CLI installed, wizard writes a config `ach run` honors without flags", () => {
  it("detectAgents finds exactly the one stub on PATH", async () => {
    const sb = await sandbox("claude");
    const found = detectAgents(sb.bin).filter((d) => d.found !== undefined);
    assert.deepEqual(found.map((d) => d.agent), ["claude"]);
    assert.equal(found[0]!.found, path.join(sb.bin, "claude"));
  });

  it("the wizard lists the detected agent, defaults to it, and writes the answers", async () => {
    const sb = await sandbox("claude");
    // Prompts: agent (blank = detected default), model, budget, max turns, confirm.
    const r = await wizard(sb, ["", "opus", "0.5", "7", "y"]);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /found\s+claude\s+\//, "claude shown as found");
    assert.match(r.out, /missing\s+codex/, "codex shown as missing");
    assert.match(r.out, /Quickstart:[\s\S]*ach run --agent claude[\s\S]*ach dash[\s\S]*ach web/);
    const doc = readJson(userFile(sb));
    assert.deepEqual(doc.run, { agent: "claude", model: "opus", budgetUsd: 0.5, maxTurns: 7 });
  });

  it("a subsequent `ach run` resolves those values from the file with no flags", async () => {
    const sb = await sandbox();
    // Real end state: init (agent null needs no binary) then `ach run` and `config --show` with no flags.
    const i = ach(sb, ["init", "--agent", "null", "--model", "m1", "--budget-usd", "3", "--max-turns", "2", "--yes"]);
    assert.equal(i.code, 0, i.stderr);
    const shown = JSON.parse(ach(sb, ["config", "--show", "run", "--json"]).stdout) as { values: Record<string, { value: unknown; source: string; flag?: string }> };
    for (const [k, v] of [["run.agent", "null"], ["run.model", "m1"], ["run.budgetUsd", 3], ["run.maxTurns", 2]] as const) {
      assert.deepEqual(shown.values[k], { value: v, source: `file:${userFile(sb)}`, flag: shown.values[k]!.flag }, k);
    }
    const run = ach(sb, ["run", "--json", "hi"]);
    assert.equal(run.code, 0, run.stderr);
    assert.match(run.stderr, /turns 50% \(1 of 2\)/, "run.maxTurns=2 applied by `ach run`");
    const res = JSON.parse(run.stdout) as { events: Array<{ type: string; agent?: string }> };
    assert.equal(res.events.find((e) => e.type === "session_start")?.agent, "null", "run.agent applied by `ach run`");
    // Control: without init, `ach run` with no flags has no agent.
    const bare = await sandbox();
    assert.notEqual(ach(bare, ["run", "--json", "hi"]).code, 0);
  });
});

describe("acceptance 2: the doctor step refuses a missing binary, with the install hint", () => {
  it("--agent codex with no codex on PATH: exit 1, hint printed, no file written", async () => {
    const sb = await sandbox("claude");
    const r = ach(sb, ["init", "--agent", "codex", "--yes"]);
    assert.equal(r.code, 1, r.stderr);
    assert.match(r.stderr, /refusing to write/);
    assert.match(r.stderr, /npm i -g @openai\/codex/, "install hint");
    assert.match(r.stdout + r.stderr, /codex\s+binary\s+failed/);
    assert.equal(existsSync(userFile(sb)), false);
  });
  it("kiro: a missing kiro-cli is refused the same way", async () => {
    const sb = await sandbox("claude");
    const r = ach(sb, ["init", "--agent", "kiro", "--yes"]);
    assert.equal(r.code, 1, r.stderr);
    assert.match(r.stderr, /refusing to write/);
    assert.equal(existsSync(userFile(sb)), false);
  });
  it("control: the same command with the codex stub on PATH writes the file", async () => {
    const sb = await sandbox("codex");
    const r = ach(sb, ["init", "--agent", "codex", "--yes"]);
    assert.equal(r.code, 0, r.stderr);
    assert.equal((readJson(userFile(sb)).run as { agent: string }).agent, "codex");
  });
  it("the wizard refuses too", async () => {
    const sb = await sandbox("claude");
    const r = await wizard(sb, ["codex", "", "", "", "y"]);
    assert.equal(r.code, 1);
    assert.equal(existsSync(userFile(sb)), false);
  });
});

describe("acceptance 3: `--agent claude --budget-usd 5 --yes` with piped stdin, same config as the wizard, exit 0", () => {
  it("writes {agent, budgetUsd} and equals the wizard's result for the same choices", async () => {
    const sb = await sandbox("claude");
    const r = ach(sb, ["init", "--agent", "claude", "--budget-usd", "5", "--yes"]);
    assert.equal(r.code, 0, r.stderr);
    const piped = readJson(userFile(sb));
    assert.deepEqual(piped.run, { agent: "claude", budgetUsd: 5 });
    assert.match(String(piped.$schema), /config\.schema\.json$/);
    assert.match(r.stdout, /ach run --agent claude/);
    assert.match(r.stdout, /ach dash/);
    assert.match(r.stdout, /ach web/);

    const sb2 = await sandbox("claude");
    const w = await wizard(sb2, ["claude", "", "5", "", "y"]);
    assert.equal(w.code, 0);
    assert.deepEqual(readJson(userFile(sb2)), piped);
  });
  it("without --yes or --agent and no TTY: prints what it would do, exits non-zero, writes nothing", async () => {
    const sb = await sandbox("claude");
    const r = ach(sb, ["init", "--budget-usd", "5"]);
    assert.equal(r.code, 1, r.stderr);
    assert.match(r.stderr, /pass --yes/);
    assert.match(r.stderr, /run\.agent=claude/);
    assert.equal(existsSync(userFile(sb)), false);
  });
  it("with --yes alone it picks the detected agent", async () => {
    const sb = await sandbox("gemini");
    assert.equal(ach(sb, ["init", "--yes"]).code, 0);
    assert.equal((readJson(userFile(sb)).run as { agent: string }).agent, "gemini");
  });
  it("--yes alone with no agent installed fails with a hint and writes nothing", async () => {
    const sb = await sandbox();
    const r = ach(sb, ["init", "--yes"]);
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /no agent CLI found/);
    assert.equal(existsSync(userFile(sb)), false);
  });
});

describe("acceptance 4: --dry-run prints the config JSON and writes nothing", () => {
  it("stdout is exactly the JSON; no file, no directory", async () => {
    const sb = await sandbox("claude");
    const r = ach(sb, ["init", "--agent", "claude", "--model", "opus", "--budget-usd", "5", "--dry-run"]);
    assert.equal(r.code, 0, r.stderr);
    const doc = JSON.parse(r.stdout) as { run: unknown };
    assert.deepEqual(doc.run, { agent: "claude", model: "opus", budgetUsd: 5 });
    assert.equal(existsSync(userFile(sb)), false);
    assert.equal(existsSync(path.dirname(userFile(sb))), false);
    assert.equal(existsSync(projectFile(sb)), false);
  });
  it("a bare `ach init --dry-run` (piped, one agent installed) prints the detected agent's config", async () => {
    const sb = await sandbox("claude");
    const r = ach(sb, ["init", "--dry-run"]);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual((JSON.parse(r.stdout) as { run: unknown }).run, { agent: "claude" });
    assert.equal(existsSync(path.dirname(userFile(sb))), false);
  });
  it("--dry-run with a missing binary still prints the JSON, exits 1 and writes nothing", async () => {
    const sb = await sandbox();
    const r = ach(sb, ["init", "--agent", "codex", "--dry-run"]);
    assert.equal(r.code, 1);
    assert.equal((JSON.parse(r.stdout) as { run: { agent: string } }).run.agent, "codex");
    assert.equal(existsSync(userFile(sb)), false);
  });
});

describe("acceptance 5: re-running overwrites: no duplicate keys, no stale sections", () => {
  it("flags: second run replaces agent/model/budget; unrelated keys survive", async () => {
    const sb = await sandbox("claude", "codex");
    assert.equal(ach(sb, ["init", "--agent", "claude", "--model", "opus", "--budget-usd", "5", "--max-turns", "10", "--yes"]).code, 0);
    assert.equal(ach(sb, ["--config", userFile(sb), "config", "--set", "web.port", "9000"]).code, 0);
    const r = ach(sb, ["init", "--agent", "codex", "--model", "gpt-5", "--budget-usd", "2", "--yes"]);
    assert.equal(r.code, 0, r.stderr);
    const text = readFileSync(userFile(sb), "utf8");
    assert.deepEqual(JSON.parse(text).run, { agent: "codex", model: "gpt-5", budgetUsd: 2, maxTurns: 10 });
    assert.deepEqual(JSON.parse(text).web, { port: 9000 });
    for (const key of ['"agent"', '"model"', '"budgetUsd"', '"maxTurns"', '"run"', '"$schema"']) {
      assert.equal(text.split(key).length - 1, 1, `${key} appears once`);
    }
    assert.equal(text.includes("claude"), false, "no stale previous agent");
  });
  it("wizard: 'none' clears a previous model and budget; blank keeps the rest", async () => {
    const sb = await sandbox("claude");
    assert.equal((await wizard(sb, ["claude", "opus", "5", "10", "y"])).code, 0);
    assert.equal((await wizard(sb, ["", "none", "none", "", "y"])).code, 0);
    assert.deepEqual(readJson(userFile(sb)).run, { agent: "claude", maxTurns: 10 });
  });
  it("wizard: answering n writes nothing", async () => {
    const sb = await sandbox("claude");
    const r = await wizard(sb, ["", "", "", "", "n"]);
    assert.equal(r.code, 1);
    assert.equal(existsSync(userFile(sb)), false);
  });
});

describe("targets, --show, validation", () => {
  it("--project writes ./.ach/config.json and leaves the user file alone", async () => {
    const sb = await sandbox("claude");
    const r = ach(sb, ["init", "--agent", "claude", "--project", "--yes"]);
    assert.equal(r.code, 0, r.stderr);
    assert.equal((readJson(projectFile(sb)).run as { agent: string }).agent, "claude");
    assert.equal(existsSync(userFile(sb)), false);
  });
  it("--config <file> is the target when given", async () => {
    const sb = await sandbox("claude");
    const f = path.join(sb.cwd, "ci.json");
    assert.equal(ach(sb, ["--config", f, "init", "--agent", "claude", "--yes"]).code, 0);
    assert.equal((readJson(f).run as { agent: string }).agent, "claude");
    assert.equal(existsSync(userFile(sb)), false);
  });
  it("--show prints the current config and exits 0 (also when there is none)", async () => {
    const sb = await sandbox("claude");
    const none = ach(sb, ["init", "--show"]);
    assert.equal(none.code, 0);
    assert.match(none.stdout, /not found/);
    ach(sb, ["init", "--agent", "claude", "--budget-usd", "5", "--yes"]);
    const r = ach(sb, ["init", "--show"]);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /"budgetUsd": 5/);
    assert.match(r.stdout, /"agent": "claude"/);
  });
  it("rejects an unknown agent and a bad number, writing nothing", async () => {
    const sb = await sandbox("claude");
    assert.notEqual(ach(sb, ["init", "--agent", "nope", "--yes"]).code, 0);
    const r = ach(sb, ["init", "--agent", "claude", "--budget-usd", "abc", "--yes"]);
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /--budget-usd expects a positive number/);
    assert.equal(existsSync(userFile(sb)), false);
  });
  it("`ach init --help` is answered from the usage text", async () => {
    const r = ach(await sandbox(), ["init", "--help"]);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /ach init \[--agent A\]/);
  });
});
