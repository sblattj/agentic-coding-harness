// Generic custom-agent adapter (#37): run any CLI through a command template
// with {prompt}/{model}/{workspace} placeholders. Every test drives a FAKE CLI
// (a node script written into a temp dir) — no real agent CLI, no network.
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import {
  CUSTOM_AGENT,
  createCustomAdapter,
  getPath,
  parseCustomLine,
  resolveCommand,
  splitTemplate,
} from "../src/adapters/custom.ts";
import { createDriver } from "../src/core/driver.ts";
import { listRunRecords } from "../src/core/registry.ts";

const CLI = fileURLToPath(new URL("../src/cli/ach.ts", import.meta.url));
const NODE = process.execPath;
// --template-shell is POSIX-only (cmd.exe cannot expand the values safely): #39.
const SHELL_SKIP = process.platform === "win32" && "--template-shell is POSIX-only";

/** Fake CLI: echoes its argv/stdin/cwd as one JSON line; FAKE_MODE=fail exits 3 with stderr. */
const FAKE_CLI = `
import fs from 'node:fs';
const args = process.argv.slice(2);
let stdin = '';
try { stdin = fs.readFileSync(0, 'utf8'); } catch {}
if (process.env.FAKE_MODE === 'fail') {
  process.stdout.write('partial output before failing\\n');
  process.stderr.write('boom: the fake cli broke\\n');
  process.exit(3);
}
process.stdout.write(JSON.stringify({
  type: 'result',
  argv: args,
  stdin,
  cwd: process.cwd(),
  envPrompt: process.env.ACH_PROMPT ?? null,
  model: 'fake-model-1',
  usage: { in: 100, out: 20, cached: 5 },
}) + '\\n');
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

/** Last stdout JSON line the fake CLI printed, from the run's message events. */
function echoed(events: Array<Record<string, unknown>>): Record<string, unknown> {
  const msgs = events.filter((e) => e.type === "message" && typeof e.content === "string");
  for (let i = msgs.length - 1; i >= 0; i -= 1) {
    const text = msgs[i]!.content as string;
    try {
      const obj = JSON.parse(text) as Record<string, unknown>;
      if (obj.type === "result") return obj;
    } catch {
      /* not the echo line */
    }
  }
  throw new Error(`no echo line among events: ${JSON.stringify(events)}`);
}

let tmp: string;
let fake: string;
let workspace: string;

before(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ach-custom-"));
  fake = path.join(tmp, "fake-cli.mjs");
  await fs.writeFile(fake, FAKE_CLI);
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "ach-custom-ws-"));
});

after(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
  await fs.rm(workspace, { recursive: true, force: true });
});

describe("splitTemplate (argv-style, never a shell)", () => {
  it("splits on whitespace and honours single/double quotes and backslashes", () => {
    assert.deepEqual(splitTemplate(`mycli -p {prompt}`), ["mycli", "-p", "{prompt}"]);
    assert.deepEqual(splitTemplate(`a 'b c' "d e" f\\ g`), ["a", "b c", "d e", "f g"]);
    assert.deepEqual(splitTemplate(`x "say \\"hi\\"" '$(nope)'`), ["x", 'say "hi"', "$(nope)"]);
    assert.deepEqual(splitTemplate(`  lead   trail  `), ["lead", "trail"]);
    assert.deepEqual(splitTemplate(`--prompt={prompt}`), ["--prompt={prompt}"]);
  });

  it("rejects an unterminated quote and an empty template", () => {
    assert.throws(() => splitTemplate(`mycli 'oops`), /unterminated/);
    assert.throws(() => splitTemplate(`   `), /empty/);
  });
});

describe("resolveCommand", () => {
  it("substitutes all three placeholders per argv element, including embedded ones", () => {
    const r = resolveCommand(
      { name: "custom", template: `mycli --model {model} --cwd={workspace} {prompt}` },
      { prompt: "hi there", model: "m1", workspace: "/w" },
    );
    assert.equal(r.command, "mycli");
    assert.deepEqual(r.args, ["--model", "m1", "--cwd=/w", "hi there"]);
    assert.deepEqual(r.redacted, ["mycli", "--model", "m1", "--cwd=/w", "<prompt:8 chars>"]);
    assert.equal(r.stdin, undefined);
  });

  it("argv mode without a {prompt} placeholder is a usage error; stdin mode needs none", () => {
    assert.throws(() => resolveCommand({ name: "custom", template: "mycli -q" }, { prompt: "p", workspace: "/w" }), /\{prompt\}/);
    const r = resolveCommand(
      { name: "custom", template: "mycli -q", promptVia: "stdin" },
      { prompt: "p", workspace: "/w" },
    );
    assert.deepEqual(r.args, ["-q"]);
    assert.equal(r.stdin, "p");
  });

  it("{model} without a model is an error, never a silent empty argument", () => {
    assert.throws(
      () => resolveCommand({ name: "custom", template: "mycli -m {model} {prompt}" }, { prompt: "p", workspace: "/w" }),
      /\{model\}/,
    );
  });

  it("shell mode passes values as env vars, never pasted into the shell text", { skip: SHELL_SKIP }, () => {
    const r = resolveCommand(
      { name: "custom", template: "mycli {prompt} | tee out.txt", shell: true },
      { prompt: "$(rm -rf /)", workspace: "/w" },
    );
    assert.equal(r.command, "/bin/sh");
    assert.deepEqual(r.args, ["-c", `mycli "$ACH_PROMPT" | tee out.txt`]);
    assert.equal(r.env.ACH_PROMPT, "$(rm -rf /)");
    assert.ok(!r.redacted.join(" ").includes("rm -rf"));
  });

  it("shell mode is a USAGE error on Windows, naming the argv-mode alternative", { skip: process.platform !== "win32" && "Windows-only behavior" }, () => {
    assert.throws(
      () => resolveCommand({ name: "custom", template: "mycli {prompt}", shell: true }, { prompt: "p", workspace: "/w" }),
      /--template-shell needs a POSIX \/bin\/sh and is not supported on Windows/,
    );
  });
});

describe("output parsing", () => {
  it("getPath reads jq-like dotted paths with array indexes", () => {
    const obj = { a: { b: [{ c: 7 }] }, d: 1 };
    assert.equal(getPath(obj, ".a.b[0].c"), 7);
    assert.equal(getPath(obj, "a.b.0.c"), 7);
    assert.equal(getPath(obj, "d"), 1);
    assert.equal(getPath(obj, ".a.x.y"), undefined);
  });

  it("text mode turns each stdout line into an assistant message, no usage", () => {
    const ev = parseCustomLine({ format: "text" }, "hello world");
    assert.deepEqual(ev, [{ type: "message", role: "assistant", text: "hello world" }]);
  });

  it("jsonl mode extracts usage from configured field paths", () => {
    const ev = parseCustomLine(
      {
        format: "jsonl",
        usage: { input: ".usage.in", output: ".usage.out", cacheRead: ".usage.cached", model: ".model" },
        inputIncludesCache: true,
      },
      JSON.stringify({ usage: { in: 100, out: 20, cached: 5 }, model: "m-x" }),
    );
    const usage = ev.find((e) => e.type === "usage") as { tokens: Record<string, unknown> } | undefined;
    assert.ok(usage, JSON.stringify(ev));
    assert.equal(usage.tokens.inputTokens, 95);
    assert.equal(usage.tokens.outputTokens, 20);
    assert.equal(usage.tokens.cacheReadTokens, 5);
    assert.equal((usage.tokens.extra as Record<string, unknown>).model, "m-x");
  });

  it("jsonl mode: a line with no configured usage field yields no usage event; non-JSON is kept as text", () => {
    const spec = { format: "jsonl" as const, usage: { input: ".u.i" } };
    assert.equal(parseCustomLine(spec, JSON.stringify({ other: 1 })).filter((e) => e.type === "usage").length, 0);
    assert.deepEqual(parseCustomLine(spec, "banner line"), [{ type: "message", role: "assistant", text: "banner line" }]);
  });
});

describe("custom adapter through the driver (fake CLI)", () => {
  it("substitutes {prompt}/{model}/{workspace}, completes, and records the resolved command with metering none", async () => {
    const stateDir = await fs.mkdtemp(path.join(tmp, "state-"));
    const adapter = createCustomAdapter({
      name: CUSTOM_AGENT,
      template: `'${NODE}' '${fake}' --model {model} --cwd {workspace} {prompt}`,
    });
    const driver = createDriver({ adapters: { custom: adapter }, stateDir, registry: { stateDir } });
    const prompt = "write a haiku";
    const res = await driver.run("custom", { prompt, model: "m-42", cwd: workspace });
    assert.equal(res.exitStatus, "success", res.warnings.join("\n"));
    const out = echoed(res.events as Array<Record<string, unknown>>);
    assert.deepEqual(out.argv, ["--model", "m-42", "--cwd", workspace, prompt]);
    assert.equal(await fs.realpath(out.cwd as string), await fs.realpath(workspace));
    assert.equal(res.usage?.tokens.available, false);
    assert.equal(res.tokens.length, 0);

    const [rec] = listRunRecords(stateDir);
    assert.ok(rec, "RunRecord exists");
    assert.equal(rec.agent, "custom");
    assert.equal(rec.status, "success");
    assert.equal(rec.metering, "none");
    assert.deepEqual(rec.command, [NODE, fake, "--model", "m-42", "--cwd", workspace, `<prompt:${prompt.length} chars>`]);
  });

  it("nonzero exit -> error status; stderr tail present in events", async () => {
    const stateDir = await fs.mkdtemp(path.join(tmp, "state-"));
    const adapter = createCustomAdapter({ name: CUSTOM_AGENT, template: `'${NODE}' '${fake}' {prompt}` });
    const driver = createDriver({ adapters: { custom: adapter }, stateDir, registry: { stateDir } });
    const res = await driver.run("custom", { prompt: "go", cwd: workspace, env: { FAKE_MODE: "fail" } });
    assert.equal(res.exitStatus, "error");
    const progress = res.events.filter((e) => e.type === "progress").map((e) => String(e.text));
    assert.ok(progress.some((t) => t.includes("boom: the fake cli broke")), JSON.stringify(res.events));
    const errors = res.events.filter((e) => e.type === "error").map((e) => String(e.message));
    assert.ok(errors.some((m) => /exited with code 3/.test(m)), JSON.stringify(errors));
    const [rec] = listRunRecords(stateDir);
    assert.equal(rec?.status, "error");
    assert.equal(rec?.exitStatus, "error");
  });

  it("injection: a prompt with spaces, quotes and $() is passed as ONE literal argv element", async () => {
    const stateDir = await fs.mkdtemp(path.join(tmp, "state-"));
    const marker = path.join(tmp, "pwned-argv");
    const prompt = `it's "quoted" and $(touch ${marker}) \`touch ${marker}\` ; touch ${marker}`;
    const adapter = createCustomAdapter({ name: CUSTOM_AGENT, template: `'${NODE}' '${fake}' -p {prompt}` });
    const driver = createDriver({ adapters: { custom: adapter }, stateDir });
    const res = await driver.run("custom", { prompt, cwd: workspace });
    assert.equal(res.exitStatus, "success");
    assert.deepEqual(echoed(res.events as Array<Record<string, unknown>>).argv, ["-p", prompt]);
    assert.equal(existsSync(marker), false, "the prompt must never be shell-evaluated");
  });

  it("--template-shell mode still never evaluates the prompt (env-var substitution)", { skip: SHELL_SKIP }, async () => {
    const stateDir = await fs.mkdtemp(path.join(tmp, "state-"));
    const marker = path.join(tmp, "pwned-shell");
    const prompt = `$(touch ${marker}) "q" 'q'`;
    const adapter = createCustomAdapter({ name: CUSTOM_AGENT, template: `'${NODE}' '${fake}' {prompt}`, shell: true });
    const driver = createDriver({ adapters: { custom: adapter }, stateDir });
    const res = await driver.run("custom", { prompt, cwd: workspace });
    assert.equal(res.exitStatus, "success", JSON.stringify(res.events));
    assert.deepEqual(echoed(res.events as Array<Record<string, unknown>>).argv, [prompt]);
    assert.equal(existsSync(marker), false);
  });

  it("--template-shell refuses extraArgs instead of silently turning them into $0/$1", { skip: SHELL_SKIP }, async () => {
    const stateDir = await fs.mkdtemp(path.join(tmp, "state-"));
    const adapter = createCustomAdapter({ name: CUSTOM_AGENT, template: `'${NODE}' '${fake}' {prompt}`, shell: true });
    const driver = createDriver({ adapters: { custom: adapter }, stateDir });
    await assert.rejects(driver.run("custom", { prompt: "p", cwd: workspace, extraArgs: ["--foo"] }), /extraArgs are not supported/);
  });

  it("argv mode appends extraArgs after the template (and records them)", async () => {
    const stateDir = await fs.mkdtemp(path.join(tmp, "state-"));
    const adapter = createCustomAdapter({ name: CUSTOM_AGENT, template: `'${NODE}' '${fake}' {prompt}` });
    const driver = createDriver({ adapters: { custom: adapter }, stateDir, registry: { stateDir } });
    const res = await driver.run("custom", { prompt: "p", cwd: workspace, extraArgs: ["--foo"] });
    assert.deepEqual(echoed(res.events as Array<Record<string, unknown>>).argv, ["p", "--foo"]);
    assert.deepEqual(listRunRecords(stateDir)[0]?.command, [NODE, fake, "<prompt:1 chars>", "--foo"]);
  });

  it("stdin mode delivers the prompt with no argv placeholder", async () => {
    const stateDir = await fs.mkdtemp(path.join(tmp, "state-"));
    const adapter = createCustomAdapter({ name: CUSTOM_AGENT, template: `'${NODE}' '${fake}' --quiet`, promptVia: "stdin" });
    const driver = createDriver({ adapters: { custom: adapter }, stateDir, registry: { stateDir } });
    const prompt = "multi\nline $(prompt) 'x'";
    const res = await driver.run("custom", { prompt, cwd: workspace });
    assert.equal(res.exitStatus, "success");
    const out = echoed(res.events as Array<Record<string, unknown>>);
    assert.deepEqual(out.argv, ["--quiet"]);
    assert.equal(out.stdin, prompt);
    const [rec] = listRunRecords(stateDir);
    assert.deepEqual(rec?.command, [NODE, fake, "--quiet"]);
  });

  it("a {model} template makes the adapter require a pinned model (fail-fast INVALID_SPEC)", async () => {
    const stateDir = await fs.mkdtemp(path.join(tmp, "state-"));
    const adapter = createCustomAdapter({ name: CUSTOM_AGENT, template: `'${NODE}' '${fake}' -m {model} {prompt}` });
    assert.equal(adapter.requiresModel, true);
    const driver = createDriver({ adapters: { custom: adapter }, stateDir });
    await assert.rejects(driver.run("custom", { prompt: "p", cwd: workspace }), /requires a pinned model/);
  });

  it("jsonl usage tap: records tokens and marks the run metering 'tap'", async () => {
    const stateDir = await fs.mkdtemp(path.join(tmp, "state-"));
    const adapter = createCustomAdapter({
      name: "fakejson",
      template: `'${NODE}' '${fake}' {prompt}`,
      output: {
        format: "jsonl",
        usage: { input: ".usage.in", output: ".usage.out", cacheRead: ".usage.cached", model: ".model" },
        inputIncludesCache: true,
      },
    });
    const driver = createDriver({ adapters: { fakejson: adapter }, stateDir, registry: { stateDir } });
    const res = await driver.run("fakejson", { prompt: "go", cwd: workspace });
    assert.equal(res.exitStatus, "success");
    assert.equal(res.tokens.length, 1);
    assert.equal(res.tokens[0]!.inputTokens, 95);
    assert.equal(res.tokens[0]!.outputTokens, 20);
    assert.equal(res.tokens[0]!.cacheReadTokens, 5);
    assert.equal(res.tokens[0]!.model, "fake-model-1");
    assert.equal(res.usage?.tokens.available, true);
    const [rec] = listRunRecords(stateDir);
    assert.equal(rec?.metering, "tap");
    assert.equal(rec?.totals?.inputTokens, 95);
  });
});

describe("ach CLI: run --agent custom + stats unmetered group", () => {
  it("runs a template end to end and stats shows it in a separate unmetered group", async () => {
    const stateDir = await fs.mkdtemp(path.join(tmp, "cli-state-"));
    const env = { AGENTIC_CODING_HARNESS_STATE_DIR: stateDir };
    const run = runCli(
      ["run", "--agent", "custom", "--template", `'${NODE}' '${fake}' --cwd {workspace} {prompt}`, "--json", "hello from cli"],
      env,
      workspace,
    );
    assert.equal(run.code, 0, run.stderr);
    const result = JSON.parse(run.stdout) as { exitStatus: string; events: Array<Record<string, unknown>> };
    assert.equal(result.exitStatus, "success");
    assert.deepEqual((echoed(result.events).argv as string[]).slice(-1), ["hello from cli"]);

    const human = runCli(["run", "--agent", "custom", "--template", `'${NODE}' '${fake}' {prompt}`, "again"], env, workspace);
    assert.equal(human.code, 0, human.stderr);
    assert.match(human.stdout, /tokens {5}input=n\/a/);
    assert.match(human.stdout, /cost {7}n\/a/);

    const stats = runCli(["stats", "--json", "--state-only"], env);
    assert.equal(stats.code, 0, stats.stderr);
    const s = JSON.parse(stats.stdout) as { total: { records: number }; unmetered: { runs: number; byAgent: Record<string, { runs: number }> } };
    assert.equal(s.total.records, 0, "unmetered runs never add fabricated zero-token records to the metered totals");
    assert.equal(s.unmetered.runs, 2);
    assert.equal(s.unmetered.byAgent.custom?.runs, 2);

    const text = runCli(["stats", "--state-only"], env);
    assert.equal(text.code, 0, text.stderr);
    assert.match(text.stdout, /^unmetered runs=2 tokens=n\/a cost=n\/a$/m);

    const filtered = runCli(["stats", "--json", "--state-only", "--agent", "custom"], env);
    assert.equal(filtered.code, 0, filtered.stderr);
    assert.equal((JSON.parse(filtered.stdout) as { unmetered: { runs: number } }).unmetered.runs, 2);
  });

  it("run --agent custom without --template is a usage error", () => {
    const r = runCli(["run", "--agent", "custom", "hi"], { AGENTIC_CODING_HARNESS_STATE_DIR: tmp });
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /--template/);
  });

  it("--help documents the --template-shell risk inline", () => {
    const r = runCli(["--help"], {});
    assert.equal(r.code, 0);
    assert.match(r.stdout, /--template-shell/);
    assert.match(r.stdout, /--prompt-stdin/);
    assert.match(r.stdout, /RISK: the template itself is shell\s+code/);
  });
});
