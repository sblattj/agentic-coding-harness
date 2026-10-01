/**
 * `ach doctor` (issue #35): diagnose every adapter's environment WITHOUT
 * spending a token. Generalizes `ach preflight --agent kiro`
 * (src/adapters/kiro-preflight.ts) to all five agents plus the harness's own
 * config.
 *
 * Per agent: binary on PATH (+ `--version`), auth material, the requested
 * model, and MCP config. Kiro reuses the real ACP preflight handshake
 * (initialize -> session/new [-> session/set_model], never session/prompt), so
 * its checks are DEEP. The other four CLIs have no prompt-free handshake the
 * harness can drive, so their checks are SHALLOW: the binary ran, credential
 * material is present and well-formed, config files parse, MCP stdio commands
 * resolve on PATH. A shallow `verified` never claims the vendor accepted the
 * credential or that an MCP server starts — the detail text says which.
 *
 * HONESTY. Every check is `verified` / `failed` / `unproven` (the preflight
 * vocabulary). What the doctor cannot see offline (a macOS keychain login, an
 * unpriced model's cost) is `unproven`, never guessed. Secrets are never
 * printed: credential checks name the variable or file, never its value.
 */

import { constants as fsConstants, accessSync, statSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { kiroPreflight, maskIdentity, type PreflightReceipt } from "../adapters/kiro-preflight.ts";
import { defaultSpawnFn, type SpawnFn } from "../adapters/shared.ts";
import { createPricer, resolveAlias } from "../core/pricing.ts";
import { stateDir as defaultStateDir } from "../core/store.ts";
import { descriptorDirs, loadAgentDescriptors } from "../core/agent-descriptors.ts";
import { splitTemplate } from "../adapters/custom.ts";
import { AGENTS, HarnessError, isKnownAgent, type AgentName, type CanonicalTokenRecord } from "../core/types.ts";

export type DoctorStatus = "verified" | "failed" | "unproven";
/** deep = observed over a real protocol exchange (kiro ACP); shallow = local evidence only. */
export type DoctorDepth = "deep" | "shallow";

export interface DoctorCheck {
  /** Agent name, or 'harness' for the harness's own config checks. */
  agent: string;
  name: string;
  status: DoctorStatus;
  depth: DoctorDepth;
  detail: string;
  /** Fix hint; present on every failed check. */
  hint?: string;
  ms: number;
  /** Present (and always "agents.d") when the check came from a #38 drop-in descriptor rather than a built-in AGENT. */
  source?: "agents.d";
}

export interface DoctorReport {
  /** False when any check failed (unproven does not fail). */
  ok: boolean;
  /** Always 0: the doctor never sends a prompt. Present so scripts can assert it. */
  promptsSent: 0;
  checks: DoctorCheck[];
}

export interface DoctorOptions {
  agents: readonly AgentName[];
  /** The environment to diagnose (PATH, HOME, credentials). Default process.env. */
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  /** Harness state dir to probe. Default: env AGENTIC_CODING_HARNESS_STATE_DIR or ~/.agentic-coding-harness. */
  stateDir?: string;
  /** Model to validate for every requested agent. */
  model?: string;
  /** Per-spawn timeout for `<bin> --version`. */
  versionTimeoutMs?: number;
  /** Test seam for the kiro handshake. */
  kiroPreflightFn?: typeof kiroPreflight;
}

const INSTALL_HINT: Record<AgentName, string> = {
  claude: "install Claude Code (npm i -g @anthropic-ai/claude-code) or put `claude` on PATH",
  codex: "install the Codex CLI (npm i -g @openai/codex) or put `codex` on PATH",
  gemini: "install the Gemini CLI (npm i -g @google/gemini-cli) or put `gemini` on PATH",
  opencode: "install opencode (npm i -g opencode-ai) or put `opencode` on PATH",
  null: "built-in offline adapter; no installation needed",
  kiro: "install kiro-cli or point KIRO_CLI_BIN at it",
  prime: "install Prime Agent (curl -fsSL https://app.primeintellect.ai/prime-agent/install.sh | sh; releases: https://github.com/PrimeIntellect-ai/prime-agent/releases/latest) or put `prime-agent` on PATH",
};

/** The binary each agent's adapter spawns, when it differs from the agent name. */
const AGENT_BINARY: Partial<Record<AgentName, string>> = {
  prime: "prime-agent",
};

/** Credential env vars each adapter's CLI reads (mirrors PROVIDER_CREDENTIAL_ENV_VARS in adapters/shared.ts). */
const AUTH_ENV: Record<AgentName, string[]> = {
  claude: ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"],
  codex: ["OPENAI_API_KEY"],
  gemini: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
  opencode: ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY", "OPENROUTER_API_KEY"],
  kiro: ["KIRO_API_KEY"],
  prime: ["PRIME_API_KEY"],
  null: [],
};

/** Claude Code's own model aliases, resolved by the CLI at run time. */
const CLAUDE_CLI_ALIASES = new Set(["opus", "sonnet", "haiku", "opusplan", "default"]);

const MODEL_FAMILY: Partial<Record<AgentName, { re: RegExp; label: string }>> = {
  claude: { re: /^claude-/, label: "claude-*" },
  codex: { re: /^(gpt-|o\d|codex-)/, label: "gpt-* / o* / codex-*" },
  gemini: { re: /^gemini-/, label: "gemini-*" },
};

// ------------------------------------------------------------------ helpers

function homeOf(env: NodeJS.ProcessEnv): string {
  return env.HOME && env.HOME !== "" ? env.HOME : os.homedir();
}

function isExecutableFile(p: string): boolean {
  try {
    if (!statSync(p).isFile()) return false;
    accessSync(p, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** `which`: the absolute path `cmd` resolves to on `pathVar`, or undefined. */
export function resolveOnPath(cmd: string, pathVar: string | undefined): string | undefined {
  if (cmd.includes("/")) return isExecutableFile(cmd) ? path.resolve(cmd) : undefined;
  for (const dir of (pathVar ?? "").split(path.delimiter)) {
    if (dir === "") continue;
    const p = path.join(dir, cmd);
    if (isExecutableFile(p)) return p;
  }
  return undefined;
}

function envSpawnFn(env: NodeJS.ProcessEnv): SpawnFn {
  return (command, args, opts) => defaultSpawnFn(command, args, { ...opts, env });
}

interface Captured {
  code: number | null;
  stdout: string;
  stderr: string;
}

function captureVersion(spawnFn: SpawnFn, command: string, cwd: string, timeoutMs: number): Promise<Captured> {
  return new Promise<Captured>((resolve) => {
    let child;
    try {
      child = spawnFn(command, ["--version"], { cwd, stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      resolve({ code: null, stdout: "", stderr: err instanceof Error ? err.message : String(err) });
      return;
    }
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (c: string) => {
      stdout += c;
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (c: string) => {
      stderr += c;
    });
    let settled = false;
    const done = (r: Captured): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    const timer = setTimeout(() => {
      try {
        child?.kill("SIGKILL");
      } catch {
        /* already gone */
      }
      done({ code: null, stdout, stderr: `${stderr}\ntimed out after ${timeoutMs}ms` });
    }, timeoutMs);
    timer.unref?.();
    child.once("error", (err: Error) => done({ code: null, stdout, stderr: `${stderr}${err.message}` }));
    child.once("close", (code: number | null) => done({ code, stdout, stderr }));
  });
}

export function parseVersion(text: string): string | undefined {
  return /(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/.exec(text)?.[1];
}

/** Why a credential env var is unusable, or undefined when it looks well-formed. Never echoes the value. */
function envVarProblem(value: string): string | undefined {
  if (value === "") return "is set but empty";
  if (/\s/.test(value)) return "contains whitespace (a stray newline or space from a paste?)";
  if (/^["'].*["']$/.test(value)) return "is wrapped in quotes";
  return undefined;
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function readJson(p: string): Promise<{ ok: true; value: unknown } | { ok: false; error: string } | undefined> {
  let raw: string;
  try {
    raw = await fs.readFile(p, "utf8");
  } catch {
    return undefined;
  }
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch {
    try {
      return { ok: true, value: JSON.parse(stripJsonComments(raw)) };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}

/** Remove // and /* *\/ comments outside strings (opencode.json allows JSONC). */
export function stripJsonComments(src: string): string {
  let out = "";
  let i = 0;
  let inStr = false;
  while (i < src.length) {
    const c = src[i]!;
    if (inStr) {
      out += c;
      if (c === "\\") {
        out += src[i + 1] ?? "";
        i += 2;
        continue;
      }
      if (c === '"') inStr = false;
      i++;
      continue;
    }
    if (c === '"') {
      inStr = true;
      out += c;
      i++;
      continue;
    }
    if (c === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

// ------------------------------------------------------------------ binary

async function checkBinary(
  agent: AgentName,
  command: string,
  env: NodeJS.ProcessEnv,
  cwd: string,
  timeoutMs: number,
): Promise<{ checks: DoctorCheck[]; resolved?: string }> {
  const t0 = Date.now();
  const resolved = resolveOnPath(command, env.PATH);
  if (!resolved) {
    return {
      checks: [
        {
          agent,
          name: "binary",
          status: "failed",
          depth: "shallow",
          detail: `'${command}' not found on PATH`,
          hint: INSTALL_HINT[agent],
          ms: Date.now() - t0,
        },
        { agent, name: "version", status: "unproven", depth: "shallow", detail: "not attempted: no binary", ms: 0 },
      ],
    };
  }
  const r = await captureVersion(envSpawnFn(env), resolved, cwd, timeoutMs);
  const ms = Date.now() - t0;
  if (r.code !== 0) {
    const tail = maskIdentity((r.stderr.trim().split("\n").slice(-1)[0] ?? "").slice(0, 200));
    return {
      checks: [
        {
          agent,
          name: "binary",
          status: "failed",
          depth: "shallow",
          detail: `'${resolved} --version' exited ${r.code ?? "null"}${tail ? `: ${tail}` : ""}`,
          hint: `reinstall or repair the ${agent} CLI; ${INSTALL_HINT[agent]}`,
          ms,
        },
        { agent, name: "version", status: "unproven", depth: "shallow", detail: "not attempted: the binary did not run", ms: 0 },
      ],
      resolved,
    };
  }
  const v = parseVersion(r.stdout) ?? parseVersion(r.stderr);
  return {
    checks: [
      { agent, name: "binary", status: "verified", depth: "shallow", detail: `${resolved} (--version exited 0)`, ms },
      v
        ? { agent, name: "version", status: "verified", depth: "shallow", detail: v, ms: 0 }
        : {
            agent,
            name: "version",
            status: "unproven",
            depth: "shallow",
            detail: `could not parse a version out of '${maskIdentity(r.stdout.trim().slice(0, 80))}'`,
            ms: 0,
          },
    ],
    resolved,
  };
}

// ------------------------------------------------------------------ auth

async function checkAuth(agent: AgentName, env: NodeJS.ProcessEnv): Promise<DoctorCheck> {
  const t0 = Date.now();
  const mk = (status: DoctorStatus, detail: string, hint?: string): DoctorCheck => ({
    agent,
    name: "auth",
    status,
    depth: "shallow",
    detail,
    ...(hint !== undefined ? { hint } : {}),
    ms: Date.now() - t0,
  });
  if (agent === "null") return mk("verified", "built-in offline adapter; no credentials required");
  const names = AUTH_ENV[agent];
  const broken: string[] = [];
  const good: string[] = [];
  for (const n of names) {
    const v = env[n];
    if (v === undefined) continue;
    const problem = envVarProblem(v);
    if (problem) broken.push(`${n} ${problem}`);
    else good.push(n);
  }
  if (broken.length > 0) {
    return mk("failed", broken.join("; "), `fix or unset ${broken.map((b) => b.split(" ")[0]).join(", ")}; the CLI would send the malformed value`);
  }
  const offline = "value not printed; acceptance by the vendor is not provable offline";
  if (good.length > 0) return mk("verified", `${good.join(", ")} present (${offline})`);

  const home = homeOf(env);
  switch (agent) {
    case "claude": {
      const defaultConfig = env.AGENTIC_CODING_HARNESS_DEFAULT_CLAUDE_CONFIG === "1";
      if (!defaultConfig) {
        return mk(
          "failed",
          `no ${names.join(" / ")} in env, and runs use a fresh per-run CLAUDE_CONFIG_DIR that cannot see a /login session`,
          "set CLAUDE_CODE_OAUTH_TOKEN (from `claude setup-token`) or ANTHROPIC_API_KEY, or run with --claude-default-config (env AGENTIC_CODING_HARNESS_DEFAULT_CLAUDE_CONFIG=1)",
        );
      }
      const creds = path.join(home, ".claude", ".credentials.json");
      if (await exists(creds)) return mk("verified", `${creds} present (${offline})`);
      const cfg = await readJson(path.join(home, ".claude.json"));
      if (cfg?.ok && isObj(cfg.value) && cfg.value.oauthAccount !== undefined) {
        return mk("unproven", `~/.claude.json records an OAuth account; the token itself is in the OS keychain, which is not checkable offline`);
      }
      return mk(
        "unproven",
        "no env credential and no ~/.claude/.credentials.json; a macOS keychain login is not checkable offline",
        "if runs report 'Not logged in', run `claude` and /login, or set ANTHROPIC_API_KEY",
      );
    }
    case "codex": {
      const codexHome = env.CODEX_HOME && env.CODEX_HOME !== "" ? env.CODEX_HOME : path.join(home, ".codex");
      const p = path.join(codexHome, "auth.json");
      const r = await readJson(p);
      if (r === undefined) return mk("failed", `no OPENAI_API_KEY in env and no ${p}`, "run `codex login`, or set OPENAI_API_KEY");
      if (!r.ok) return mk("failed", `${p} does not parse: ${r.error}`, "re-run `codex login` to rewrite it");
      return mk("verified", `${p} present and parses (${offline})`);
    }
    case "gemini": {
      const gac = env.GOOGLE_APPLICATION_CREDENTIALS;
      if (gac !== undefined && gac !== "") {
        if (await exists(gac)) return mk("verified", `GOOGLE_APPLICATION_CREDENTIALS file present (${offline})`);
        return mk("failed", `GOOGLE_APPLICATION_CREDENTIALS points at a missing file`, "fix the path or unset GOOGLE_APPLICATION_CREDENTIALS");
      }
      const oauth = path.join(home, ".gemini", "oauth_creds.json");
      if (await exists(oauth)) return mk("verified", `${oauth} present (${offline})`);
      const adc = path.join(home, ".config", "gcloud", "application_default_credentials.json");
      if (await exists(adc)) return mk("verified", `gcloud application-default credentials present (${offline})`);
      return mk("failed", `no ${names.join(" / ")} in env, no GOOGLE_APPLICATION_CREDENTIALS, no ${oauth}`, "run `gemini` once and sign in, or set GEMINI_API_KEY");
    }
    case "opencode": {
      const dataHome = env.XDG_DATA_HOME && env.XDG_DATA_HOME !== "" ? env.XDG_DATA_HOME : path.join(home, ".local", "share");
      const p = path.join(dataHome, "opencode", "auth.json");
      const r = await readJson(p);
      if (r === undefined) {
        return mk("unproven", `no provider key in env and no ${p}; opencode may still use a keyless/local provider`, "run `opencode auth login` if runs fail to authenticate");
      }
      if (!r.ok) return mk("failed", `${p} does not parse: ${r.error}`, "re-run `opencode auth login`");
      const providers = isObj(r.value) ? Object.keys(r.value) : [];
      if (providers.length === 0) return mk("unproven", `${p} lists no providers`, "run `opencode auth login`");
      return mk("verified", `${p} lists provider(s) ${providers.join(", ")} (${offline})`);
    }
    case "prime": {
      // prime-agent authenticates via PRIME_API_KEY (handled above), a
      // `/login` record (interactive prime-agent) in ~/.prime/agent/auth.json, or a custom
      // provider with its own apiKey in ~/.prime/agent/models.json (e.g. a
      // local gateway). Values are never printed — only names.
      const dir = path.join(home, ".prime", "agent");
      const authFile = path.join(dir, "auth.json");
      const auth = await readJson(authFile);
      if (auth !== undefined && !auth.ok) return mk("failed", `${authFile} does not parse: ${auth.error}`, "run `prime-agent` and /login again to rewrite it");
      if (auth?.ok && isObj(auth.value) && Object.keys(auth.value).length > 0) {
        return mk("verified", `${authFile} holds credential(s) for ${Object.keys(auth.value).join(", ")} (${offline})`);
      }
      const modelsFile = path.join(dir, "models.json");
      const models = await readJson(modelsFile);
      if (models !== undefined && !models.ok) return mk("failed", `${modelsFile} does not parse: ${models.error}`, "fix the JSON in models.json");
      const providers = models?.ok && isObj(models.value) && isObj(models.value.providers) ? models.value.providers : {};
      const keyed = Object.entries(providers)
        .filter(([, v]) => isObj(v) && typeof v.apiKey === "string" && v.apiKey !== "")
        .map(([name]) => name);
      if (keyed.length > 0) return mk("verified", `${modelsFile} defines provider(s) with an apiKey: ${keyed.join(", ")} (${offline})`);
      return mk(
        "failed",
        `no PRIME_API_KEY in env, no credentials in ${authFile}, no provider apiKey in ${modelsFile}`,
        "run `prime-agent` and use /login, set PRIME_API_KEY, or add a provider with an apiKey to ~/.prime/agent/models.json",
      );
    }
    case "kiro":
      // Kiro's real auth check is the preflight's `kiro-cli whoami`; this path
      // only runs when the binary is missing.
      return mk("unproven", "not attempted: `kiro-cli whoami` needs the binary");
  }
}

// ------------------------------------------------------------------ model

function isPriced(model: string): boolean {
  const pricer = createPricer();
  const rec: CanonicalTokenRecord = { model, inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  const usd = pricer.price(rec);
  pricer.drainWarnings();
  return Number.isFinite(usd);
}

function checkModel(agent: AgentName, model: string | undefined): DoctorCheck {
  const base = { agent, name: "model", depth: "shallow" as const, ms: 0 };
  if (model === undefined) {
    return { ...base, status: "unproven", detail: "no --model given; the CLI's own default model is used (not checkable offline)" };
  }
  if (agent === "claude" && CLAUDE_CLI_ALIASES.has(model.toLowerCase())) {
    return { ...base, status: "verified", detail: `'${model}' is a Claude Code alias, resolved by the CLI; cost is priced from the transcript's concrete model id` };
  }
  if (agent === "opencode" && !model.includes("/")) {
    return { ...base, status: "failed", detail: `'${model}' is not provider/model`, hint: "opencode models are 'provider/model', e.g. anthropic/claude-sonnet-4" };
  }
  const alias = resolveAlias(model);
  const family = MODEL_FAMILY[agent];
  if (family && !family.re.test(alias)) {
    return { ...base, status: "failed", detail: `'${model}' is not a ${agent} model (expected ${family.label})`, hint: `pass a ${family.label} model, or use the adapter that serves '${model}'` };
  }
  if (isPriced(model)) return { ...base, status: "verified", detail: `'${model}' (alias '${alias}') is in the pricing table` };
  return {
    ...base,
    status: "unproven",
    detail: `'${model}' (alias '${alias}') is not in the pricing table: the CLI may accept it, but run cost would be n/a`,
    hint: "add the model to src/core/pricing-data.json, or check the spelling",
  };
}

// ------------------------------------------------------------------ mcp

interface McpServerDecl {
  name: string;
  command?: string;
  remote?: boolean;
}

interface McpScan {
  files: string[];
  problems: string[];
  servers: Array<McpServerDecl & { file: string }>;
}

function serversFromJsonMap(map: unknown): McpServerDecl[] {
  if (!isObj(map)) return [];
  return Object.entries(map).map(([name, v]) => {
    if (!isObj(v)) return { name };
    if (typeof v.command === "string") return { name, command: v.command };
    if (Array.isArray(v.command) && typeof v.command[0] === "string") return { name, command: v.command[0] };
    if (typeof v.url === "string" || typeof v.httpUrl === "string" || v.type === "remote") return { name, remote: true };
    return { name };
  });
}

/** Minimal `[mcp_servers.<name>]` / `command = "..."` scan of codex config.toml — not a TOML parser. */
export function scanCodexToml(src: string): McpServerDecl[] {
  const out: McpServerDecl[] = [];
  let current: McpServerDecl | undefined;
  for (const line of src.split("\n")) {
    const header = /^\s*\[([^\]]+)\]\s*$/.exec(line);
    if (header) {
      const m = /^mcp_servers\.("?)([^".]+)\1$/.exec(header[1]!.trim());
      current = m ? { name: m[2]! } : undefined;
      if (current) out.push(current);
      continue;
    }
    if (!current) continue;
    const cmd = /^\s*command\s*=\s*"([^"]*)"/.exec(line) ?? /^\s*command\s*=\s*'([^']*)'/.exec(line);
    if (cmd) current.command = cmd[1];
    if (/^\s*url\s*=/.test(line)) current.remote = true;
  }
  return out;
}

async function scanMcp(agent: AgentName, env: NodeJS.ProcessEnv, cwd: string): Promise<McpScan> {
  const home = homeOf(env);
  const scan: McpScan = { files: [], problems: [], servers: [] };
  const jsonSource = async (file: string, key: string): Promise<void> => {
    const r = await readJson(file);
    if (r === undefined) return;
    scan.files.push(file);
    if (!r.ok) {
      scan.problems.push(`${file} does not parse: ${r.error}`);
      return;
    }
    const map = isObj(r.value) ? r.value[key] : undefined;
    for (const s of serversFromJsonMap(map)) scan.servers.push({ ...s, file });
  };
  switch (agent) {
    case "claude":
      await jsonSource(path.join(cwd, ".mcp.json"), "mcpServers");
      // User-scope servers are only visible to runs that use the default config.
      if (env.AGENTIC_CODING_HARNESS_DEFAULT_CLAUDE_CONFIG === "1") await jsonSource(path.join(home, ".claude.json"), "mcpServers");
      break;
    case "gemini":
      await jsonSource(path.join(home, ".gemini", "settings.json"), "mcpServers");
      await jsonSource(path.join(cwd, ".gemini", "settings.json"), "mcpServers");
      break;
    case "prime":
      // `prime-agent mcp add` writes user servers to settings.json mcpServers
      // (observed, prime-agent 0.9.8).
      await jsonSource(path.join(home, ".prime", "agent", "settings.json"), "mcpServers");
      break;
    case "opencode": {
      const cfgHome = env.XDG_CONFIG_HOME && env.XDG_CONFIG_HOME !== "" ? env.XDG_CONFIG_HOME : path.join(home, ".config");
      for (const f of [
        path.join(cfgHome, "opencode", "opencode.json"),
        path.join(cfgHome, "opencode", "opencode.jsonc"),
        path.join(cwd, "opencode.json"),
        path.join(cwd, "opencode.jsonc"),
      ]) {
        await jsonSource(f, "mcp");
      }
      break;
    }
    case "codex": {
      const codexHome = env.CODEX_HOME && env.CODEX_HOME !== "" ? env.CODEX_HOME : path.join(home, ".codex");
      const file = path.join(codexHome, "config.toml");
      let raw: string | undefined;
      try {
        raw = await fs.readFile(file, "utf8");
      } catch {
        raw = undefined;
      }
      if (raw !== undefined) {
        scan.files.push(file);
        for (const s of scanCodexToml(raw)) scan.servers.push({ ...s, file });
      }
      break;
    }
    case "kiro":
      break;
  }
  for (const s of scan.servers) {
    if (s.remote) continue;
    if (s.command === undefined) {
      scan.problems.push(`server '${s.name}' in ${s.file} has no command or url`);
      continue;
    }
    if (!resolveOnPath(s.command, env.PATH)) {
      scan.problems.push(`server '${s.name}' in ${s.file}: command '${s.command}' not found on PATH`);
    }
  }
  return scan;
}

async function checkMcp(agent: AgentName, env: NodeJS.ProcessEnv, cwd: string): Promise<DoctorCheck> {
  const t0 = Date.now();
  const scan = await scanMcp(agent, env, cwd);
  const base = { agent, name: "mcp", depth: "shallow" as const };
  if (scan.problems.length > 0) {
    return {
      ...base,
      status: "failed",
      detail: scan.problems.join("; "),
      hint: "fix the config file, or install the MCP server command / put it on PATH",
      ms: Date.now() - t0,
    };
  }
  if (scan.servers.length === 0) {
    const where = scan.files.length > 0 ? scan.files.join(", ") : "no MCP config file found";
    return { ...base, status: "verified", detail: `no MCP servers configured (${where})`, ms: Date.now() - t0 };
  }
  const remote = scan.servers.filter((s) => s.remote).length;
  return {
    ...base,
    status: "verified",
    detail:
      `${scan.servers.length} server(s) in ${[...new Set(scan.servers.map((s) => s.file))].join(", ")}: config parses, ` +
      `stdio commands resolve on PATH${remote > 0 ? `, ${remote} remote url(s) not contacted` : ""}; startup not proven (no handshake)`,
    ms: Date.now() - t0,
  };
}

// ------------------------------------------------------------------ kiro

const KIRO_HINTS: Record<string, string> = {
  auth: "run `kiro-cli login`, or set KIRO_API_KEY",
  agent: "pass a --kiro-agent that exists (see availableModes)",
  model: "pass a --model from the handshake's availableModels",
  modelAck: "the CLI did not acknowledge session/set_model; pick an offered model",
  mcp: "an MCP server failed to start; check its command and env",
  extraArgs: "remove the extra args that are not on the gateway allowlist",
};

async function checkKiro(opts: Required<Pick<DoctorOptions, "env" | "cwd" | "versionTimeoutMs">> & DoctorOptions): Promise<DoctorCheck[]> {
  const env = opts.env;
  const command = env.KIRO_CLI_BIN && env.KIRO_CLI_BIN !== "" ? env.KIRO_CLI_BIN : "kiro-cli";
  const t0 = Date.now();
  const resolved = resolveOnPath(command, env.PATH);
  if (!resolved) {
    const out: DoctorCheck[] = [
      { agent: "kiro", name: "binary", status: "failed", depth: "shallow", detail: `'${command}' not found on PATH`, hint: INSTALL_HINT.kiro, ms: Date.now() - t0 },
      { agent: "kiro", name: "version", status: "unproven", depth: "shallow", detail: "not attempted: no binary", ms: 0 },
    ];
    const envAuth = await checkAuth("kiro", env);
    out.push(envAuth);
    const m = checkModel("kiro", opts.model);
    out.push(opts.model === undefined ? m : { ...m, status: "unproven", detail: "not attempted: kiro models are proven by the ACP handshake, which needs the binary", ms: 0 });
    out.push({ agent: "kiro", name: "mcp", status: "unproven", depth: "shallow", detail: "not attempted: MCP startup is observed over the ACP handshake", ms: 0 });
    return out;
  }
  const preflight = opts.kiroPreflightFn ?? kiroPreflight;
  const receipt: PreflightReceipt = await preflight({
    command: resolved,
    spawnFn: envSpawnFn(env),
    cwd: opts.cwd,
    kiro: { transport: "acp" },
    ...(opts.model !== undefined ? { model: opts.model } : {}),
  });
  const out: DoctorCheck[] = [];
  for (const c of receipt.checks) {
    if (c.name === "extraArgs") continue; // doctor forwards none
    const name = c.name === "executable" ? "binary" : c.name;
    const check: DoctorCheck = { agent: "kiro", name, status: c.status, depth: "deep", detail: c.detail, ms: c.ms };
    if (c.status === "failed") check.hint = name === "binary" ? INSTALL_HINT.kiro : (KIRO_HINTS[name] ?? "see `ach preflight --agent kiro`");
    out.push(check);
  }
  // A malformed KIRO_API_KEY is worth flagging even if whoami passed via another profile.
  const envAuth = await checkAuth("kiro", env);
  if (envAuth.status === "failed") out.push({ ...envAuth, name: "authEnv" });
  return out;
}

// ------------------------------------------------------------------ harness

async function checkStateDir(dir: string): Promise<DoctorCheck> {
  const t0 = Date.now();
  const probe = path.join(dir, `.doctor-probe-${process.pid}-${Math.random().toString(36).slice(2)}`);
  try {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(probe, "ok");
    await fs.unlink(probe);
    return { agent: "harness", name: "stateDir", status: "verified", depth: "shallow", detail: `${dir} is writable`, ms: Date.now() - t0 };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? (err instanceof Error ? err.message : String(err));
    return {
      agent: "harness",
      name: "stateDir",
      status: "failed",
      depth: "shallow",
      detail: `${dir} is not writable (${code})`,
      hint: "fix its permissions, or set AGENTIC_CODING_HARNESS_STATE_DIR to a writable directory",
      ms: Date.now() - t0,
    };
  }
}

function checkPricing(): DoctorCheck {
  const t0 = Date.now();
  const base = { agent: "harness" as const, name: "pricing", depth: "shallow" as const };
  try {
    const flagships = ["claude-sonnet-4", "gpt-5", "gemini-2.5-pro"];
    const missing = flagships.filter((m) => !isPriced(m));
    if (missing.length > 0) {
      return { ...base, status: "failed", detail: `pricing table cannot price ${missing.join(", ")}`, hint: "the embedded price table is damaged; reinstall the harness", ms: Date.now() - t0 };
    }
    // claude-3-haiku prices ONLY via the bundled LiteLLM extract
    // (src/core/pricing-data.json), so it tells extract from fallback.
    if (!isPriced("claude-3-haiku")) {
      return { ...base, status: "failed", detail: "bundled LiteLLM extract is unavailable", hint: "reinstall the harness", ms: Date.now() - t0 };
    }
    return {
      ...base,
      status: "verified",
      detail: "pricing table loads (embedded fallback + bundled LiteLLM extract)",
      ms: Date.now() - t0,
    };
  } catch (err) {
    return { ...base, status: "failed", detail: `pricing table failed to load: ${err instanceof Error ? err.message : String(err)}`, hint: "reinstall the harness", ms: Date.now() - t0 };
  }
}

type EnvRule = "num" | "int" | "posint" | "flag" | "string" | "secret" | readonly string[];
const HARNESS_ENV: Record<string, EnvRule> = {
  COST_MODE: ["auto", "calculate", "display"],
  TZ: "string",
  PROJECT_ALIASES: "string",
  BUDGET_ALERTS: "string",
  WARN_THRESHOLDS: "string",
  WARN_COOLDOWN_H: "num",
  PLAN: ["pro", "max5", "max20", "custom"],
  PLAN_WINDOW_TOKENS: "num",
  PLAN_WINDOW_USD: "num",
  PLAN_WINDOW_MESSAGES: "num",
  QUOTA_CLAUDE_FILE: "string",
  QUOTA_CODEX_DIR: "string",
  NULL_EXIT: ["error", "timeout", "budget_exceeded"],
  NULL_TURNS: "posint",
  STATE_DIR: "string",
  HTTP_TOKEN: "secret",
  BUDGET_USD: "num",
  MAX_TURNS: "int",
  WALL_MS: "num",
  IDLE_MS: "num",
  DEFAULT_CLAUDE_CONFIG: "flag",
  GATEWAY: "flag",
  ROOT: "string",
  MAX_JOBS: "posint",
  MAX_OUTPUT_BYTES: "posint",
  ALLOW_EXTRA_ARGS: "string",
  SOURCE: "string",
  SOURCE_TOKEN: "secret",
  SOURCE_MODE: ["poll", "sse", "ws"],
  SOURCE_POLL_MS: "posint",
  SOURCE_MERGE: ["state", "only"],
};
const PREFIX = "AGENTIC_CODING_HARNESS_";

export function checkHarnessEnv(env: NodeJS.ProcessEnv): DoctorCheck[] {
  const base = { agent: "harness" as const, name: "env", depth: "shallow" as const, ms: 0 };
  const out: DoctorCheck[] = [];
  const ok: string[] = [];
  for (const key of Object.keys(env).filter((k) => k.startsWith(PREFIX)).sort()) {
    const short = key.slice(PREFIX.length);
    const value = env[key] ?? "";
    const rule = HARNESS_ENV[short];
    if (rule === undefined) {
      out.push({ ...base, status: "unproven", detail: `${key} is not a variable the harness reads (typo?)`, hint: `known: ${Object.keys(HARNESS_ENV).map((k) => PREFIX + k).join(", ")}` });
      continue;
    }
    const n = Number(value);
    let problem: string | undefined;
    if (rule === "num" && !(value.trim() !== "" && Number.isFinite(n) && n >= 0)) problem = `expects a non-negative number, got '${value}'`;
    else if (rule === "int" && !(value.trim() !== "" && Number.isInteger(n) && n >= 0)) problem = `expects a non-negative integer, got '${value}'`;
    else if (rule === "posint" && !(Number.isInteger(n) && n > 0)) problem = `expects a positive integer, got '${value}'`;
    else if (Array.isArray(rule) && !rule.includes(value)) problem = `expects one of ${rule.join("|")}, got '${value}'`;
    else if ((rule === "string" || rule === "secret") && value.trim() === "") problem = "is set but empty";
    if (problem) {
      out.push({ ...base, status: "failed", detail: `${key} ${problem}`, hint: `fix or unset ${key}` });
    } else if (rule === "flag" && value !== "1") {
      out.push({ ...base, status: "unproven", detail: `${key} is '${value}'; only '1' turns it on, so it is OFF` });
    } else {
      ok.push(key);
    }
  }
  if (ok.length > 0 || out.length === 0) {
    out.unshift({ ...base, status: "verified", detail: ok.length > 0 ? `well-formed: ${ok.join(", ")}` : `no ${PREFIX}* overrides set` });
  }
  return out;
}

// ------------------------------------------------------------------ entry

export async function runDoctor(options: DoctorOptions): Promise<DoctorReport> {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const versionTimeoutMs = options.versionTimeoutMs ?? 10_000;
  const state =
    options.stateDir ??
    (env.AGENTIC_CODING_HARNESS_STATE_DIR && env.AGENTIC_CODING_HARNESS_STATE_DIR !== ""
      ? env.AGENTIC_CODING_HARNESS_STATE_DIR
      : path.join(homeOf(env), ".agentic-coding-harness"));

  const checks: DoctorCheck[] = [await checkStateDir(state), checkPricing(), ...checkHarnessEnv(env)];

  // Agents run concurrently; the report keeps the requested order.
  const perAgent = await Promise.all(
    options.agents.map(async (agent): Promise<DoctorCheck[]> => {
      if (agent === "null") return [{ agent, name: "runtime", status: "verified", depth: "shallow", detail: "built-in offline adapter; no binary, auth or MCP required", ms: 0 }];
      if (agent === "kiro") return checkKiro({ ...options, env, cwd, versionTimeoutMs });
      const bin = await checkBinary(agent, AGENT_BINARY[agent] ?? agent, env, cwd, versionTimeoutMs);
      return [...bin.checks, await checkAuth(agent, env), checkModel(agent, options.model), await checkMcp(agent, env, cwd)];
    }),
  );
  for (const list of perAgent) checks.push(...list);
  return { ok: checks.every((c) => c.status !== "failed"), promptsSent: 0, checks };
}

export function formatDoctorTable(report: DoctorReport): string {
  const rows = report.checks;
  const w = {
    agent: Math.max(5, ...rows.map((r) => r.agent.length)) + 2,
    name: Math.max(5, ...rows.map((r) => r.name.length)) + 2,
    status: 10,
    depth: 9,
  };
  const indent = " ".repeat(w.agent + w.name + w.status + w.depth);
  const lines = [`${"AGENT".padEnd(w.agent)}${"CHECK".padEnd(w.name)}${"STATUS".padEnd(w.status)}${"DEPTH".padEnd(w.depth)}DETAIL`];
  for (const r of rows) {
    lines.push(`${r.agent.padEnd(w.agent)}${r.name.padEnd(w.name)}${r.status.padEnd(w.status)}${r.depth.padEnd(w.depth)}${r.detail}`);
    if (r.hint) lines.push(`${indent}hint: ${r.hint}`);
  }
  const failed = rows.filter((r) => r.status === "failed").length;
  const unproven = rows.filter((r) => r.status === "unproven").length;
  lines.push("");
  lines.push(`ok ${String(report.ok)} · ${failed} failed · ${unproven} unproven · prompts sent: ${report.promptsSent}`);
  lines.push("depth: deep = observed over a real handshake (kiro ACP); shallow = local evidence only (binary ran, credential present, config parses)");
  return lines.join("\n");
}

/** `ach doctor [--agent A] [--model M] [--cwd DIR] [--claude-default-config] [--json]`. Exit 0 iff no check failed. */
export async function cmdDoctor(rest: string[]): Promise<number> {
  const args = parseArgs({
    args: rest,
    options: {
      agent: { type: "string" },
      model: { type: "string" },
      cwd: { type: "string" },
      "claude-default-config": { type: "boolean", default: false },
      json: { type: "boolean", default: false },
    },
    allowPositionals: false,
  });
  const agent = args.values.agent;
  const catalog = loadAgentDescriptors({ dirs: descriptorDirs({ cwd: args.values.cwd ?? process.cwd(), stateDir: defaultStateDir() }) });
  if (agent !== undefined && !isKnownAgent(agent) && !catalog.descriptors.some((d) => d.descriptor.name === agent)) {
    throw new HarnessError(`unknown agent '${agent}' (expected one of: ${[...AGENTS, ...catalog.descriptors.map((d) => d.descriptor.name)].join(", ")})`, "UNKNOWN_AGENT");
  }
  if (args.values.model !== undefined && agent === undefined) {
    throw new HarnessError("doctor --model needs --agent (a model belongs to one adapter)", "USAGE");
  }
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (args.values["claude-default-config"]) env.AGENTIC_CODING_HARNESS_DEFAULT_CLAUDE_CONFIG = "1";
  const report = await runDoctor({
    agents: agent !== undefined ? (isKnownAgent(agent) ? [agent] : []) : AGENTS.filter((a) => a !== "null"),
    env,
    cwd: args.values.cwd ?? process.cwd(),
    stateDir: defaultStateDir(),
    ...(args.values.model !== undefined ? { model: args.values.model } : {}),
  });
  for (const { descriptor: d, file } of catalog.descriptors) {
    if (agent !== undefined && agent !== d.name) continue;
    report.checks.push({ agent: d.name, name: "descriptor", status: "verified", depth: "shallow", detail: `${file}: validated descriptor`, ms: 0, source: "agents.d" });
    if (d.launch) {
      let command: string | undefined;
      try { command = d.launch.shell ? "/bin/sh" : splitTemplate(d.launch.template)[0]; } catch { /* reported below */ }
      const resolved = command ? resolveOnPath(command, env.PATH) : undefined;
      report.checks.push({ agent: d.name, name: "binary", status: resolved ? "verified" : "failed", depth: "shallow", detail: resolved ? `${resolved}: executable present; not launched` : `template command '${command ?? "unknown"}' is not executable`, ...(resolved ? {} : { hint: "install the descriptor command or correct launch.template" }), ms: 0, source: "agents.d" });
      report.checks.push({ agent: d.name, name: "auth", status: "unproven", depth: "shallow", detail: "descriptor supplies no offline authentication probe", ms: 0, source: "agents.d" });
    }
    if (d.usageTap) {
      const tapPath = d.usageTap.path.replace(/^~(?=\/|$)/, homeOf(env));
      const present = await exists(tapPath);
      report.checks.push({ agent: d.name, name: "usageTap", status: present ? "verified" : "unproven", depth: "shallow", detail: present ? `${tapPath}: usage source present` : `${tapPath}: usage source not present yet`, ms: 0, source: "agents.d" });
    }
  }
  for (const issue of catalog.errors) report.checks.push({ agent: "harness", name: "descriptor", status: "failed", depth: "shallow", detail: JSON.stringify(issue), hint: "correct the invalid agents.d descriptor", ms: 0, source: "agents.d" });
  report.ok = report.checks.every((c) => c.status !== "failed");
  process.stdout.write((args.values.json ? JSON.stringify(report, null, 2) : formatDoctorTable(report)) + "\n");
  return report.ok ? 0 : 1;
}
