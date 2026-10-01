import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { runDoctor, formatDoctorTable, type DoctorCheck, type DoctorReport } from "../src/cli/doctor.ts";

// `ach doctor` (issue #35). Every test builds its own world: a temp PATH
// holding fake agent binaries (shell scripts), a temp HOME, a temp state dir.
// No real agent CLI and no network is ever touched.

const CLI = new URL("../src/cli/ach.ts", import.meta.url).pathname;
const REPO_ROOT = path.join(fileURLToPath(new URL('.', import.meta.url)), "..");
const ACP_SERVER = path.join(fileURLToPath(new URL('.', import.meta.url)), "fixtures/kiro/fake-acp-server.ts");
const IS_ROOT = typeof process.getuid === "function" && process.getuid() === 0;

interface World {
  bin: string;
  home: string;
  state: string;
  cwd: string;
  env: Record<string, string>;
}

async function world(): Promise<World> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ach-doctor-"));
  const w = {
    bin: path.join(root, "bin"),
    home: path.join(root, "home"),
    state: path.join(root, "state"),
    cwd: path.join(root, "cwd"),
  };
  for (const d of Object.values(w)) await fs.mkdir(d, { recursive: true });
  // A minimal env: PATH is ONLY the fake-bin dir, so nothing from the host
  // machine can satisfy a binary check.
  return { ...w, env: { PATH: w.bin, HOME: w.home } };
}

async function fakeBin(w: World, name: string, script: string): Promise<string> {
  const p = path.join(w.bin, name);
  await fs.writeFile(p, `#!/bin/sh\n${script}\n`);
  await fs.chmod(p, 0o755);
  return p;
}

async function fakeAllVersions(w: World): Promise<void> {
  await fakeBin(w, "claude", 'echo "2.1.3 (Claude Code)"');
  await fakeBin(w, "codex", 'echo "codex-cli 0.46.0"');
  await fakeBin(w, "gemini", 'echo "0.9.0"');
  await fakeBin(w, "opencode", 'echo "0.15.2"');
}

function check(r: DoctorReport, agent: string, name: string): DoctorCheck {
  const c = r.checks.find((x) => x.agent === agent && x.name === name);
  assert.ok(c, `missing check ${agent}/${name}; have ${r.checks.map((x) => `${x.agent}/${x.name}`).join(", ")}`);
  return c;
}

function runCli(args: string[], env: Record<string, string>, cwd?: string): { code: number; stdout: string; stderr: string } {
  const isBun = (process.versions as { bun?: string }).bun !== undefined;
  // env is the WHOLE child env (no process.env spread) so the host PATH and
  // the host's real credentials cannot leak into the checks. The process cwd
  // stays the repo root (node resolves `--import tsx` from it); the doctor's
  // project dir travels as --cwd.
  const argv = cwd !== undefined ? [...args, "--cwd", cwd] : args;
  const p = spawnSync(process.execPath, isBun ? [CLI, ...argv] : ["--import", "tsx", CLI, ...argv], {
    env,
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  return { code: p.status ?? -1, stdout: p.stdout ?? "", stderr: p.stderr ?? "" };
}

describe("runDoctor — per-agent checks", () => {
  it("claude: binary + version + env auth verified, secret never printed, zero prompts", async () => {
    const w = await world();
    await fakeAllVersions(w);
    const r = await runDoctor({
      agents: ["claude"],
      env: { ...w.env, ANTHROPIC_API_KEY: "sk-ant-SECRET-VALUE" },
      cwd: w.cwd,
      stateDir: w.state,
    });
    assert.equal(r.promptsSent, 0);
    assert.equal(check(r, "claude", "binary").status, "verified");
    assert.match(check(r, "claude", "binary").detail, /claude/);
    const v = check(r, "claude", "version");
    assert.equal(v.status, "verified");
    assert.match(v.detail, /2\.1\.3/);
    const auth = check(r, "claude", "auth");
    assert.equal(auth.status, "verified");
    assert.equal(auth.depth, "shallow");
    assert.match(auth.detail, /ANTHROPIC_API_KEY/);
    assert.doesNotMatch(JSON.stringify(r), /SECRET-VALUE/);
    assert.equal(check(r, "claude", "model").status, "unproven");
    assert.equal(check(r, "claude", "mcp").status, "verified");
    assert.equal(check(r, "harness", "stateDir").status, "verified");
    assert.equal(check(r, "harness", "pricing").status, "verified");
    assert.equal(r.ok, true);
  });

  it("a missing binary fails with a hint while auth/model/mcp still report", async () => {
    const w = await world();
    const r = await runDoctor({
      agents: ["claude"],
      env: { ...w.env, ANTHROPIC_API_KEY: "sk-ant-x" },
      cwd: w.cwd,
      stateDir: w.state,
      model: "claude-sonnet-4",
    });
    const bin = check(r, "claude", "binary");
    assert.equal(bin.status, "failed");
    assert.match(bin.detail, /not found on PATH/);
    assert.ok(bin.hint && bin.hint.length > 0, "binary failure carries a fix hint");
    assert.equal(check(r, "claude", "auth").status, "verified");
    assert.equal(check(r, "claude", "model").status, "verified");
    assert.equal(check(r, "claude", "mcp").status, "verified");
    assert.equal(r.ok, false);
  });

  it("a deliberately broken auth env var fails auth with a hint; binary and model still report", async () => {
    const w = await world();
    await fakeAllVersions(w);
    const r = await runDoctor({
      agents: ["claude"],
      env: { ...w.env, ANTHROPIC_API_KEY: "sk-ant-abc\n" },
      cwd: w.cwd,
      stateDir: w.state,
      model: "claude-sonnet-4",
    });
    const auth = check(r, "claude", "auth");
    assert.equal(auth.status, "failed");
    assert.match(auth.detail, /ANTHROPIC_API_KEY/);
    assert.ok(auth.hint);
    assert.doesNotMatch(JSON.stringify(r), /sk-ant-abc/);
    assert.equal(check(r, "claude", "binary").status, "verified");
    assert.equal(check(r, "claude", "model").status, "verified");
    assert.equal(r.ok, false);
  });

  it("an empty auth env var is broken too", async () => {
    const w = await world();
    await fakeAllVersions(w);
    const r = await runDoctor({ agents: ["codex"], env: { ...w.env, OPENAI_API_KEY: "" }, cwd: w.cwd, stateDir: w.state });
    assert.equal(check(r, "codex", "auth").status, "failed");
    assert.match(check(r, "codex", "auth").detail, /OPENAI_API_KEY.*empty/);
  });

  it("claude without an env credential fails in per-run config mode (keychain login invisible), passes with default config + credentials file", async () => {
    const w = await world();
    await fakeAllVersions(w);
    const perRun = await runDoctor({ agents: ["claude"], env: w.env, cwd: w.cwd, stateDir: w.state });
    const a = check(perRun, "claude", "auth");
    assert.equal(a.status, "failed");
    assert.match(a.hint ?? "", /--claude-default-config|ANTHROPIC_API_KEY/);

    await fs.mkdir(path.join(w.home, ".claude"), { recursive: true });
    await fs.writeFile(path.join(w.home, ".claude", ".credentials.json"), '{"claudeAiOauth":{"accessToken":"TOKEN-XYZ"}}');
    const dflt = await runDoctor({
      agents: ["claude"],
      env: { ...w.env, AGENTIC_CODING_HARNESS_DEFAULT_CLAUDE_CONFIG: "1" },
      cwd: w.cwd,
      stateDir: w.state,
    });
    assert.equal(check(dflt, "claude", "auth").status, "verified");
    assert.doesNotMatch(JSON.stringify(dflt), /TOKEN-XYZ/);

    const noFile = await runDoctor({
      agents: ["claude"],
      env: { PATH: w.bin, HOME: path.join(w.home, "nope"), AGENTIC_CODING_HARNESS_DEFAULT_CLAUDE_CONFIG: "1" },
      cwd: w.cwd,
      stateDir: w.state,
    });
    // A macOS keychain login is not visible offline: unproven, never a guess.
    assert.equal(check(noFile, "claude", "auth").status, "unproven");
  });

  it("codex/gemini/opencode auth material by file presence", async () => {
    const w = await world();
    await fakeAllVersions(w);
    await fs.mkdir(path.join(w.home, ".codex"), { recursive: true });
    await fs.writeFile(path.join(w.home, ".codex", "auth.json"), '{"OPENAI_API_KEY":null,"tokens":{}}');
    await fs.mkdir(path.join(w.home, ".gemini"), { recursive: true });
    await fs.writeFile(path.join(w.home, ".gemini", "oauth_creds.json"), "{}");
    await fs.mkdir(path.join(w.home, ".local", "share", "opencode"), { recursive: true });
    await fs.writeFile(path.join(w.home, ".local", "share", "opencode", "auth.json"), '{"anthropic":{"type":"api","key":"K"}}');
    const r = await runDoctor({ agents: ["codex", "gemini", "opencode"], env: w.env, cwd: w.cwd, stateDir: w.state });
    assert.equal(check(r, "codex", "auth").status, "verified");
    assert.equal(check(r, "gemini", "auth").status, "verified");
    const oc = check(r, "opencode", "auth");
    assert.equal(oc.status, "verified");
    assert.match(oc.detail, /anthropic/);

    const bare = await world();
    await fakeAllVersions(bare);
    const none = await runDoctor({ agents: ["codex", "gemini"], env: bare.env, cwd: bare.cwd, stateDir: bare.state });
    assert.equal(check(none, "codex", "auth").status, "failed");
    assert.match(check(none, "codex", "auth").hint ?? "", /codex login|OPENAI_API_KEY/);
    assert.equal(check(none, "gemini", "auth").status, "failed");

    const badGac = await runDoctor({
      agents: ["gemini"],
      env: { ...bare.env, GOOGLE_APPLICATION_CREDENTIALS: path.join(bare.home, "missing.json") },
      cwd: bare.cwd,
      stateDir: bare.state,
    });
    assert.equal(check(badGac, "gemini", "auth").status, "failed");
    assert.match(check(badGac, "gemini", "auth").detail, /GOOGLE_APPLICATION_CREDENTIALS/);
  });

  it("prime: binary is prime-agent; auth via PRIME_API_KEY, auth.json, or a models.json provider apiKey; MCP from settings.json", async () => {
    const w = await world();
    await fakeBin(w, "prime-agent", 'echo "0.9.8"');
    const base = { agents: ["prime" as const], cwd: w.cwd, stateDir: w.state };
    const none = await runDoctor({ ...base, env: w.env });
    assert.equal(check(none, "prime", "binary").status, "verified");
    assert.match(check(none, "prime", "version").detail, /0\.9\.8/);
    assert.equal(check(none, "prime", "auth").status, "failed");
    assert.match(check(none, "prime", "auth").hint ?? "", /PRIME_API_KEY/);

    const env = await runDoctor({ ...base, env: { ...w.env, PRIME_API_KEY: "pk-SECRET" } });
    assert.equal(check(env, "prime", "auth").status, "verified");
    assert.doesNotMatch(JSON.stringify(env), /pk-SECRET/);

    const dir = path.join(w.home, ".prime", "agent");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "auth.json"), "{}");
    await fs.writeFile(
      path.join(dir, "models.json"),
      '{"providers":{"gw":{"baseUrl":"http://127.0.0.1:1/v1","apiKey":"GW-SECRET","models":[{"id":"flash"}]},"nokey":{"models":[]}}}',
    );
    await fs.writeFile(path.join(dir, "settings.json"), '{"mcpServers":{"probe":{"type":"stdio","command":"definitely-not-on-path"}}}');
    const custom = await runDoctor({ ...base, env: w.env, model: "gw/flash" });
    const auth = check(custom, "prime", "auth");
    assert.equal(auth.status, "verified");
    assert.match(auth.detail, /models\.json.*gw/);
    assert.doesNotMatch(auth.detail, /nokey/);
    assert.doesNotMatch(JSON.stringify(custom), /GW-SECRET/);
    assert.equal(check(custom, "prime", "model").status, "unproven", "an unpriced custom model is unproven, never failed");
    assert.equal(check(custom, "prime", "mcp").status, "failed");
    assert.match(check(custom, "prime", "mcp").detail, /definitely-not-on-path/);

    const missing = await world();
    const nobin = await runDoctor({ ...base, env: missing.env, cwd: missing.cwd, stateDir: missing.state });
    assert.equal(check(nobin, "prime", "binary").status, "failed");
    assert.match(check(nobin, "prime", "binary").hint ?? "", /prime-agent/);
  });

  it("model checks: pricing table, CLI aliases, adapter family, opencode provider/model", async () => {
    const w = await world();
    await fakeAllVersions(w);
    const base = { env: w.env, cwd: w.cwd, stateDir: w.state };
    const m = async (agent: "claude" | "codex" | "gemini" | "opencode", model: string) =>
      check(await runDoctor({ ...base, agents: [agent], model }), agent, "model");
    assert.equal((await m("claude", "claude-sonnet-4-20250514")).status, "verified");
    assert.equal((await m("claude", "sonnet")).status, "verified");
    const wrong = await m("claude", "gpt-5");
    assert.equal(wrong.status, "failed");
    assert.ok(wrong.hint);
    assert.equal((await m("codex", "gpt-5")).status, "verified");
    assert.equal((await m("opencode", "anthropic/claude-sonnet-4")).status, "verified");
    const noSlash = await m("opencode", "claude-sonnet-4");
    assert.equal(noSlash.status, "failed");
    assert.match(noSlash.detail, /provider\/model/);
    const unpriced = await m("gemini", "gemini-99-ultra");
    assert.equal(unpriced.status, "unproven");
    assert.match(unpriced.detail, /pricing/);
  });

  it("MCP config: parse errors and unresolvable stdio commands fail; resolvable ones pass shallow", async () => {
    const w = await world();
    await fakeAllVersions(w);
    await fakeBin(w, "my-mcp", "exit 0");
    await fs.writeFile(
      path.join(w.cwd, ".mcp.json"),
      JSON.stringify({ mcpServers: { good: { command: "my-mcp" }, bad: { command: "no-such-mcp-xyz" }, web: { type: "http", url: "http://x" } } }),
    );
    const r = await runDoctor({ agents: ["claude"], env: { ...w.env, ANTHROPIC_API_KEY: "k" }, cwd: w.cwd, stateDir: w.state });
    const mcp = check(r, "claude", "mcp");
    assert.equal(mcp.status, "failed");
    assert.match(mcp.detail, /bad/);
    assert.match(mcp.detail, /no-such-mcp-xyz/);
    assert.doesNotMatch(mcp.detail, /'good'/);

    await fs.mkdir(path.join(w.home, ".gemini"), { recursive: true });
    await fs.writeFile(path.join(w.home, ".gemini", "settings.json"), "{ not json");
    const g = check(await runDoctor({ agents: ["gemini"], env: w.env, cwd: w.cwd, stateDir: w.state }), "gemini", "mcp");
    assert.equal(g.status, "failed");
    assert.match(g.detail, /settings\.json/);

    await fs.writeFile(path.join(w.home, ".gemini", "settings.json"), JSON.stringify({ mcpServers: { ok: { command: "my-mcp" } } }));
    const g2 = check(await runDoctor({ agents: ["gemini"], env: w.env, cwd: w.cwd, stateDir: w.state }), "gemini", "mcp");
    assert.equal(g2.status, "verified");
    assert.equal(g2.depth, "shallow");
    assert.match(g2.detail, /1 server/);
  });

  it("MCP config: codex config.toml mcp_servers and opencode.json (with comments) are scanned", async () => {
    const w = await world();
    await fakeAllVersions(w);
    await fs.mkdir(path.join(w.home, ".codex"), { recursive: true });
    await fs.writeFile(
      path.join(w.home, ".codex", "config.toml"),
      'model = "gpt-5"\n\n[mcp_servers.docs]\ncommand = "missing-docs-mcp"\nargs = ["-y"]\n',
    );
    await fs.writeFile(
      path.join(w.cwd, "opencode.json"),
      '{\n  // local server\n  "$schema": "https://opencode.ai/config.json",\n  "mcp": { "fs": { "type": "local", "command": ["opencode", "x"] } }\n}\n',
    );
    const r = await runDoctor({ agents: ["codex", "opencode"], env: w.env, cwd: w.cwd, stateDir: w.state });
    const cx = check(r, "codex", "mcp");
    assert.equal(cx.status, "failed");
    assert.match(cx.detail, /docs.*missing-docs-mcp/);
    const oc = check(r, "opencode", "mcp");
    assert.equal(oc.status, "verified", oc.detail);
    assert.match(oc.detail, /1 server/);
  });

  it("kiro reuses the ACP preflight handshake: initialize + session/new, NO session/prompt", async () => {
    const w = await world();
    const log = path.join(w.state, "acp-stdin.log");
    await fakeBin(
      w,
      "kiro-cli",
      [
        'case "$1" in',
        '  --version) echo "kiro-cli 2.21.2" ;;',
        '  whoami) echo "someone@example.com" ;;',
        `  *) cd ${JSON.stringify(REPO_ROOT)} && exec ${JSON.stringify(process.execPath)} ${(process.versions as { bun?: string }).bun ? "" : "--import tsx "}${JSON.stringify(ACP_SERVER)} ;;`,
        "esac",
      ].join("\n"),
    );
    const r = await runDoctor({
      agents: ["kiro"],
      env: { ...w.env, FAKE_ACP_SCENARIO: "ok", FAKE_ACP_STDIN_LOG: log },
      cwd: w.cwd,
      stateDir: w.state,
    });
    assert.equal(check(r, "kiro", "binary").status, "verified");
    const auth = check(r, "kiro", "auth");
    assert.equal(auth.status, "verified");
    assert.equal(auth.depth, "deep");
    assert.doesNotMatch(JSON.stringify(r), /someone@example\.com/);
    assert.ok(existsSync(log), "the fake ACP server saw stdin");
    const methods = readFileSync(log, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => String((JSON.parse(l) as { method?: string }).method ?? "<response>"));
    assert.ok(methods.includes("initialize"), methods.join(","));
    assert.ok(methods.includes("session/new"), methods.join(","));
    assert.ok(!methods.includes("session/prompt"), "doctor must never send a prompt");
    assert.equal(r.promptsSent, 0);
  });
});

describe("runDoctor — harness config", () => {
  it("fails clearly when the state dir is read-only", { skip: IS_ROOT ? "root ignores file modes" : false }, async () => {
    const w = await world();
    const ro = path.join(w.state, "ro");
    await fs.mkdir(ro);
    await fs.chmod(ro, 0o500);
    try {
      const r = await runDoctor({ agents: [], env: w.env, cwd: w.cwd, stateDir: ro });
      const s = check(r, "harness", "stateDir");
      assert.equal(s.status, "failed");
      assert.match(s.detail, /not writable/);
      assert.match(s.hint ?? "", /AGENTIC_CODING_HARNESS_STATE_DIR/);
      assert.equal(r.ok, false);
    } finally {
      await fs.chmod(ro, 0o700);
    }
  });

  it("env sanity: malformed numeric vars fail, unknown AGENTIC_CODING_HARNESS_* names are flagged", async () => {
    const w = await world();
    const r = await runDoctor({
      agents: [],
      env: { ...w.env, AGENTIC_CODING_HARNESS_BUDGET_USD: "lots", AGENTIC_CODING_HARNESS_STAT_DIR: "/x", AGENTIC_CODING_HARNESS_MAX_TURNS: "5" },
      cwd: w.cwd,
      stateDir: w.state,
    });
    const envChecks = r.checks.filter((c) => c.agent === "harness" && c.name === "env");
    const bad = envChecks.find((c) => /BUDGET_USD/.test(c.detail));
    assert.equal(bad?.status, "failed");
    const typo = envChecks.find((c) => /STAT_DIR/.test(c.detail));
    assert.equal(typo?.status, "unproven");
    assert.ok(!envChecks.some((c) => /MAX_TURNS/.test(c.detail) && c.status === "failed"));
  });

  it("formatDoctorTable renders every check with its hint", async () => {
    const w = await world();
    const r = await runDoctor({ agents: ["codex"], env: w.env, cwd: w.cwd, stateDir: w.state });
    const t = formatDoctorTable(r);
    assert.match(t, /codex\s+binary\s+failed/);
    assert.match(t, /hint: /);
    assert.match(t, /prompts sent: 0/);
  });
});

describe("ach doctor (CLI)", () => {
  it("--agent claude --json with no claude binary: structured checks, non-zero exit", async () => {
    const w = await world();
    const r = runCli(["doctor", "--agent", "claude", "--json"], {
      ...w.env,
      ANTHROPIC_API_KEY: "sk-ant-x",
      AGENTIC_CODING_HARNESS_STATE_DIR: w.state,
    }, w.cwd);
    assert.notEqual(r.code, 0, r.stderr);
    const report = JSON.parse(r.stdout) as DoctorReport;
    assert.equal(report.ok, false);
    assert.equal(report.promptsSent, 0);
    assert.equal(check(report, "claude", "binary").status, "failed");
    assert.equal(check(report, "claude", "auth").status, "verified");
    assert.ok(report.checks.every((c) => c.agent === "claude" || c.agent === "harness"));
  });

  it("no --agent: a table covering every adapter with fix hints", async () => {
    const w = await world();
    await fakeAllVersions(w);
    const r = runCli(["doctor"], { ...w.env, AGENTIC_CODING_HARNESS_STATE_DIR: w.state }, w.cwd);
    assert.notEqual(r.code, 0, "kiro-cli is absent, so at least one hard check fails");
    for (const a of ["claude", "opencode", "kiro", "codex", "gemini", "harness"]) {
      assert.match(r.stdout, new RegExp(`^${a}\\s+binary|^${a}\\s+stateDir`, "m"), `row for ${a}`);
    }
    for (const n of ["binary", "auth", "model", "mcp"]) assert.match(r.stdout, new RegExp(`\\s${n}\\s`));
    assert.match(r.stdout, /hint: /);
  });

  it("exits 0 when every check passes or is unproven", async () => {
    const w = await world();
    await fakeAllVersions(w);
    const r = runCli(["doctor", "--agent", "codex", "--json"], {
      ...w.env,
      OPENAI_API_KEY: "sk-x",
      AGENTIC_CODING_HARNESS_STATE_DIR: w.state,
    }, w.cwd);
    assert.equal(r.code, 0, r.stdout + r.stderr);
  });

  it("unknown --agent is a usage error", async () => {
    const w = await world();
    const r = runCli(["doctor", "--agent", "nope"], { ...w.env, AGENTIC_CODING_HARNESS_STATE_DIR: w.state }, w.cwd);
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /unknown agent 'nope'/);
  });

  it("read-only state dir fails the CLI", { skip: IS_ROOT ? "root ignores file modes" : false }, async () => {
    const w = await world();
    const ro = path.join(w.state, "ro");
    await fs.mkdir(ro);
    await fs.chmod(ro, 0o500);
    try {
      const r = runCli(["doctor", "--agent", "codex", "--json"], {
        ...w.env,
        OPENAI_API_KEY: "sk-x",
        AGENTIC_CODING_HARNESS_STATE_DIR: ro,
      }, w.cwd);
      assert.notEqual(r.code, 0);
      const report = JSON.parse(r.stdout) as DoctorReport;
      assert.equal(check(report, "harness", "stateDir").status, "failed");
    } finally {
      await fs.chmod(ro, 0o700);
    }
  });
});

// `ach doctor` also covers agents.d descriptors (#38), not just the five
// built-in AGENTS. Every check below runs through the real CLI (`runCli`) so
// the loader + doctor wiring in cmdDoctor is exercised end to end, with a
// temp PATH holding a fake launch binary and no real agent CLI involved.
describe("ach doctor — agents.d descriptors", () => {
  async function writeDescriptor(w: World, file: string, json: unknown): Promise<void> {
    const dir = path.join(w.state, "agents.d");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, file), JSON.stringify(json));
  }

  it("a valid launch descriptor: descriptor + binary + auth checks all resolve, marked source agents.d", async () => {
    const w = await world();
    await fakeBin(w, "fakeagent", 'echo "fake 1.0.0"');
    await writeDescriptor(w, "valid.json", { name: "descvalid", launch: { template: "fakeagent {prompt}" } });
    const r = runCli(["doctor", "--agent", "descvalid", "--json"], {
      ...w.env,
      AGENTIC_CODING_HARNESS_STATE_DIR: w.state,
    }, w.cwd);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    const report = JSON.parse(r.stdout) as DoctorReport;
    const descriptor = check(report, "descvalid", "descriptor");
    assert.equal(descriptor.status, "verified");
    assert.equal(descriptor.source, "agents.d");
    const binary = check(report, "descvalid", "binary");
    assert.equal(binary.status, "verified");
    assert.equal(binary.source, "agents.d");
    assert.match(binary.detail, /fakeagent/);
    const auth = check(report, "descvalid", "auth");
    assert.equal(auth.status, "unproven");
    assert.equal(auth.source, "agents.d");
    // Built-in checks keep the existing shape: no `source` field at all.
    assert.equal(check(report, "harness", "stateDir").source, undefined);
  });

  it("a launch binary missing from PATH fails with a hint, still marked source agents.d", async () => {
    const w = await world();
    await writeDescriptor(w, "missingbin.json", { name: "descmissing", launch: { template: "no-such-agent-binary {prompt}" } });
    const r = runCli(["doctor", "--agent", "descmissing", "--json"], {
      ...w.env,
      AGENTIC_CODING_HARNESS_STATE_DIR: w.state,
    }, w.cwd);
    assert.notEqual(r.code, 0);
    const report = JSON.parse(r.stdout) as DoctorReport;
    const binary = check(report, "descmissing", "binary");
    assert.equal(binary.status, "failed");
    assert.equal(binary.source, "agents.d");
    assert.ok(binary.hint && binary.hint.length > 0, "binary failure carries a fix hint");
  });

  it("an invalid descriptor becomes a failed harness/descriptor check (zod issue reported), never crashes doctor", async () => {
    const w = await world();
    await writeDescriptor(w, "invalid.json", { name: "descbad", launch: { template: "fakeagent {prompt}" }, notAField: true });
    const r = runCli(["doctor", "--agent", "null", "--json"], { ...w.env, AGENTIC_CODING_HARNESS_STATE_DIR: w.state }, w.cwd);
    assert.notEqual(r.code, 0, r.stdout + r.stderr);
    const report = JSON.parse(r.stdout) as DoctorReport;
    const bad = report.checks.find((c) => c.agent === "harness" && c.name === "descriptor" && c.status === "failed");
    assert.ok(bad, `expected a failed harness/descriptor check; have ${report.checks.map((c) => `${c.agent}/${c.name}:${c.status}`).join(", ")}`);
    assert.equal(bad!.source, "agents.d");
    assert.match(bad!.detail, /notAField/);
    assert.ok(bad!.hint && bad!.hint.length > 0);
    // Doctor kept running past the invalid descriptor instead of aborting.
    assert.equal(check(report, "null", "runtime").status, "verified");
  });

  it("a meter-only descriptor (launch: null) skips binary/auth and reports its transcript dir, marked source agents.d", async () => {
    const w = await world();
    const tapDir = path.join(w.state, "tap");
    await fs.mkdir(tapDir, { recursive: true });
    await writeDescriptor(w, "meter.json", {
      name: "descmeter",
      launch: null,
      usageTap: { type: "transcript", path: tapDir, format: "jsonl", fields: { input: "usage.input_tokens", output: "usage.output_tokens" } },
    });
    const r = runCli(["doctor", "--agent", "descmeter", "--json"], { ...w.env, AGENTIC_CODING_HARNESS_STATE_DIR: w.state }, w.cwd);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    const report = JSON.parse(r.stdout) as DoctorReport;
    const descriptor = check(report, "descmeter", "descriptor");
    assert.equal(descriptor.status, "verified");
    assert.equal(descriptor.source, "agents.d");
    const tap = check(report, "descmeter", "usageTap");
    assert.equal(tap.status, "verified");
    assert.equal(tap.source, "agents.d");
    assert.match(tap.detail, new RegExp(tapDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.ok(!report.checks.some((c) => c.agent === "descmeter" && c.name === "binary"), "meter-only descriptors get no binary check");
    assert.ok(!report.checks.some((c) => c.agent === "descmeter" && c.name === "auth"), "meter-only descriptors get no auth check");
  });
});
