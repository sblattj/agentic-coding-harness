// OpenCodeEngine (#204). Owner: opencode engine seat. Implements the Engine contract in ../types.ts.
//
// One `opencode serve` per desk/lane (guide section 2), started detached in its own process
// group from spec.cwd with a per-desk OPENCODE_CONFIG_CONTENT that force-disables every MCP the
// user's opencode configs define except spec.mcps, and adds the `desks` MCP (`ach mcp`).
// Turns go through POST /session/<sid>/prompt_async, silent context through noReply messages,
// events come from the GET /event SSE stream (verified on opencode 1.19.0), reconciled against
// GET /session/<sid>/message at every busy -> idle transition.
import { spawn as nodeSpawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { connect } from "node:net";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { deskPaths } from "../roster.ts";
import { desksMcpDef } from "../self.ts";
import type { Engine, EngineEvent, GoalStatus, HostSpec, McpServerDef } from "../types.ts";
import { readOpencodeGoal, setOpencodeGoal } from "./opencode-goals.ts";

/** What start() needs from a spawned `opencode serve`. The default wraps node:child_process. */
export interface ServeProcess {
  pid: number;
  /** Signal the whole process group (serve + its MCP children). */
  kill(signal: NodeJS.Signals): void;
  /** Resolves with the exit code (or signal name) once the process is gone. */
  exited: Promise<number | string | null>;
}

export type SpawnServe = (o: { bin: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv; logFile: string }) => ServeProcess;

export interface OpenCodeGoalsBridge {
  setOpencodeGoal: typeof setOpencodeGoal;
  readOpencodeGoal: typeof readOpencodeGoal;
}

export interface OpenCodeEngineOptions {
  /** Base env for config lookup, desksMcpDef and the serve child. Default process.env. */
  env?: NodeJS.ProcessEnv;
  /** opencode binary. Default $ACH_OPENCODE_BIN, else "opencode". */
  bin?: string;
  spawn?: SpawnServe;
  goals?: OpenCodeGoalsBridge;
  /** Ready wait for `GET /session` 200. Default 30 s. */
  readyTimeoutMs?: number;
  /** Base delay before re-booting a serve that died on "database is locked". Default 400 ms. */
  lockRetryDelayMs?: number;
  /** TERM -> KILL grace in stop(). Default 5 s. */
  stopGraceMs?: number;
  /** Goal confirmation timeout handed to setOpencodeGoal. Default 40 s. */
  goalTimeoutMs?: number;
}

/** Keys under `mcp` that are config, not server names (opencode config schema). */
/** Re-boots after an opencode serve dies on its shared SQLite lock (see OpenCodeEngine.boot). */
const LOCK_RETRIES = 4;
const MCP_RESERVED = new Set(["timeout", "servers"]);

/** Remove // and /* *\/ comments and trailing commas outside strings (opencode configs are JSONC). */
export function parseJsonc(src: string): unknown {
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
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

/** Every opencode config file that may define MCPs for a serve started in `cwd`: global, $OPENCODE_CONFIG, project (cwd up to /). */
export function opencodeConfigFiles(cwd: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const home = env.HOME && env.HOME !== "" ? env.HOME : homedir();
  const cfgHome = env.XDG_CONFIG_HOME && env.XDG_CONFIG_HOME !== "" ? env.XDG_CONFIG_HOME : join(home, ".config");
  const files = ["config.json", "opencode.json", "opencode.jsonc"].map((f) => join(cfgHome, "opencode", f));
  if (env.OPENCODE_CONFIG && env.OPENCODE_CONFIG !== "") files.push(resolve(env.OPENCODE_CONFIG));
  let dir = resolve(cwd);
  for (;;) {
    for (const f of ["opencode.json", "opencode.jsonc", join(".opencode", "opencode.json"), join(".opencode", "opencode.jsonc")]) {
      files.push(join(dir, f));
    }
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return [...new Set(files)];
}

function mcpNamesOf(cfg: unknown): string[] {
  if (!cfg || typeof cfg !== "object") return [];
  const mcp = (cfg as { mcp?: unknown }).mcp;
  if (!mcp || typeof mcp !== "object") return [];
  const names = Object.keys(mcp).filter((k) => !MCP_RESERVED.has(k));
  const servers = (mcp as { servers?: unknown }).servers;
  if (servers && typeof servers === "object") names.push(...Object.keys(servers));
  return names;
}

/** Names of every MCP server the user's opencode configs define (union over opencodeConfigFiles). Unreadable files are skipped. */
export function configuredMcpNames(cwd: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const names = new Set<string>();
  for (const f of opencodeConfigFiles(cwd, env)) {
    if (!existsSync(f)) continue;
    try {
      for (const n of mcpNamesOf(parseJsonc(readFileSync(f, "utf8")))) names.add(n);
    } catch {
      // A config opencode itself cannot parse fails serve; the /mcp check after ready catches leaks.
    }
  }
  return [...names].sort();
}

/**
 * The per-desk OPENCODE_CONFIG_CONTENT object: every configured MCP not in spec.mcps -> {enabled:false};
 * spec.mcps names opencode knows -> {enabled:true}; unknown ones with a spec.mcpServers def -> local MCP;
 * plus `desks` (ach mcp with the desk identity in env). `extraDisabled` force-disables more names.
 */
export function buildOpencodeConfig(
  spec: Pick<HostSpec, "name" | "stack" | "stateDir" | "mcps" | "mcpServers" | "cwd">,
  o: { configured: string[]; env?: NodeJS.ProcessEnv; extraDisabled?: string[]; base?: Record<string, unknown> } = { configured: [] },
): Record<string, unknown> {
  const want = new Set(spec.mcps);
  const configured = new Set(o.configured);
  const mcp: Record<string, unknown> = {};
  const baseMcp = o.base?.mcp;
  if (baseMcp && typeof baseMcp === "object") Object.assign(mcp, baseMcp);
  for (const n of [...o.configured, ...(o.extraDisabled ?? [])]) {
    if (!want.has(n) && n !== "desks") mcp[n] = { enabled: false };
  }
  for (const n of spec.mcps) {
    if (n === "desks") continue;
    const def: McpServerDef | undefined = spec.mcpServers?.[n];
    if (configured.has(n) || !def) mcp[n] = { enabled: true };
    else mcp[n] = localMcp(def);
  }
  mcp.desks = localMcp(desksMcpDef({ name: spec.name, stack: spec.stack, stateDir: spec.stateDir }, o.env ?? process.env));
  return { ...(o.base ?? {}), mcp };
}

function localMcp(def: McpServerDef): Record<string, unknown> {
  const out: Record<string, unknown> = { type: "local", command: [def.command, ...(def.args ?? [])], enabled: true };
  if (def.env && Object.keys(def.env).length > 0) out.environment = def.env;
  return out;
}

/** "ferry/super-flash" -> {providerID:"ferry", modelID:"super-flash"} (split at the FIRST "/"). */
export function splitModel(model: string | undefined): { providerID: string; modelID: string } | undefined {
  if (!model) return undefined;
  const i = model.indexOf("/");
  if (i <= 0 || i === model.length - 1) throw new Error(`desks: opencode model must be "provider/model", got ${JSON.stringify(model)}`);
  return { providerID: model.slice(0, i), modelID: model.slice(i + 1) };
}

/** Role prompt: the roleFiles' contents joined, $DESK_NAME replaced by the desk name. */
export function rolePrompt(spec: Pick<HostSpec, "roleFiles" | "name">): string {
  return spec.roleFiles
    .map((f) => readFileSync(f, "utf8").trim())
    .filter((s) => s !== "")
    .join("\n\n")
    .replaceAll("$DESK_NAME", spec.name);
}

export function portIsOpen(port: number, host = "127.0.0.1", timeoutMs = 500): Promise<boolean> {
  return new Promise((res) => {
    const s = connect({ port, host });
    const done = (v: boolean) => {
      s.removeAllListeners();
      s.destroy();
      res(v);
    };
    s.setTimeout(timeoutMs, () => done(false));
    s.once("connect", () => done(true));
    s.once("error", () => done(false));
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function tailOf(file: string, max = 2000): string {
  try {
    const s = readFileSync(file, "utf8");
    return s.length > max ? s.slice(-max) : s;
  } catch {
    return "";
  }
}

export const defaultSpawnServe: SpawnServe = ({ bin, args, cwd, env, logFile }) => {
  mkdirSync(dirname(logFile), { recursive: true });
  const fd = openSync(logFile, "a");
  let child;
  try {
    // detached = setsid: serve leads its own process group and outlives the caller's shell.
    child = nodeSpawn(bin, args, { cwd, env, detached: true, stdio: ["ignore", fd, fd] });
  } finally {
    closeSync(fd);
  }
  const exited = new Promise<number | string | null>((res) => {
    child.once("exit", (code, sig) => res(code ?? sig));
    child.once("error", (err) => res(`spawn error: ${err.message}`));
  });
  child.unref();
  return {
    pid: child.pid ?? -1,
    kill(signal) {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, signal);
      } catch {
        try {
          child.kill(signal);
        } catch {
          // already gone
        }
      }
    },
    exited,
  };
};

interface OcPart {
  id?: string;
  type?: string;
  text?: string;
  tool?: string;
  callID?: string;
  messageID?: string;
  sessionID?: string;
  time?: { start?: number; end?: number };
  state?: { status?: string; input?: unknown; title?: string; error?: string };
  cost?: number;
  tokens?: OcTokens;
}
interface OcTokens {
  input?: number;
  output?: number;
  reasoning?: number;
  cache?: { read?: number; write?: number };
}
interface OcInfo {
  id?: string;
  role?: string;
  sessionID?: string;
  modelID?: string;
  providerID?: string;
  time?: { created?: number; completed?: number };
}

function toolSummary(p: OcPart): string {
  if (p.state?.title) return String(p.state.title).slice(0, 200);
  const input = p.state?.input;
  if (input === undefined) return "";
  const s = typeof input === "string" ? input : JSON.stringify(input);
  return s.length > 200 ? `${s.slice(0, 197)}...` : s;
}

export class OpenCodeEngine implements Engine {
  readonly kind = "opencode" as const;

  private readonly env: NodeJS.ProcessEnv;
  private readonly bin: string;
  private readonly spawnServe: SpawnServe;
  private readonly goals: OpenCodeGoalsBridge;
  private readonly readyTimeoutMs: number;
  private readonly lockRetryDelayMs: number;
  private readonly stopGraceMs: number;
  private readonly goalTimeoutMs: number;

  private spec?: HostSpec;
  private port = 0;
  private baseUrl = "";
  private sessionId = "";
  private proc?: ServeProcess;
  private logFile = "";
  private listeners: Array<(e: EngineEvent) => void> = [];
  private sse?: AbortController;
  private stopping = false;
  private stopped?: Promise<void>;
  private objective = "";

  // event state
  private busy = false;
  /** Set by send() until the stream (or status poll) has shown busy for this turn. */
  private pendingTurn = false;
  private pendingSince = 0;
  private roles = new Map<string, string>();
  private emittedText = new Set<string>();
  private emittedTool = new Set<string>();
  private emittedUsage = new Set<string>();
  /** Bus events received on the GET /event stream (diagnostics: proves the stream, not polling, delivered). */
  streamEventCount = 0;

  constructor(o: OpenCodeEngineOptions = {}) {
    this.env = o.env ?? process.env;
    this.bin = o.bin ?? (this.env.ACH_OPENCODE_BIN && this.env.ACH_OPENCODE_BIN !== "" ? this.env.ACH_OPENCODE_BIN : "opencode");
    this.spawnServe = o.spawn ?? defaultSpawnServe;
    this.goals = o.goals ?? { setOpencodeGoal, readOpencodeGoal };
    this.readyTimeoutMs = o.readyTimeoutMs ?? 30_000;
    this.lockRetryDelayMs = o.lockRetryDelayMs ?? 400;
    this.stopGraceMs = o.stopGraceMs ?? 5_000;
    this.goalTimeoutMs = o.goalTimeoutMs ?? 40_000;
  }

  /** The serve log path (`<stateDir>/desks/<stack>/logs/<name>.opencode.log`); "" before start(). */
  get serveLog(): string {
    return this.logFile;
  }

  async start(spec: HostSpec): Promise<{ sessionId?: string; engineUrl?: string; childPid?: number }> {
    if (this.proc) throw new Error("desks: OpenCodeEngine already started");
    this.spec = spec;
    this.stopping = false;
    this.port = spec.enginePort ?? spec.port + 500;
    this.baseUrl = `http://127.0.0.1:${this.port}`;
    this.logFile = join(deskPaths(spec.stateDir, spec.stack).logs, `${spec.name}.opencode.log`);

    const configured = configuredMcpNames(spec.cwd, this.env);
    let base: Record<string, unknown> | undefined;
    const inherited = this.env.OPENCODE_CONFIG_CONTENT;
    if (inherited && inherited !== "") {
      try {
        const p = JSON.parse(inherited) as unknown;
        if (p && typeof p === "object" && !Array.isArray(p)) base = p as Record<string, unknown>;
      } catch {
        // ignore an unparsable inherited value; ours replaces it
      }
    }
    const allowed = new Set([...spec.mcps, "desks"]);

    // Up to two boots: the second force-disables any MCP the first boot's GET /mcp showed leaking
    // (a config file we could not see or parse).
    let extraDisabled: string[] = [];
    for (let attempt = 1; ; attempt++) {
      const config = buildOpencodeConfig(spec, { configured, env: this.env, extraDisabled, base });
      await this.boot(spec, config);
      const leaked = Object.entries(await this.mcpStatus())
        .filter(([n, s]) => !allowed.has(n) && s !== "disabled")
        .map(([n]) => n);
      if (leaked.length === 0) break;
      await this.killServe();
      if (attempt >= 2) throw new Error(`desks: opencode serve still enables MCPs outside ${JSON.stringify([...allowed])}: ${leaked.join(", ")}`);
      extraDisabled = [...extraDisabled, ...leaked];
    }

    try {
      const created = (await this.http("POST", `/session?directory=${encodeURIComponent(spec.cwd)}`, { title: spec.name })) as { id?: string };
      if (!created || typeof created.id !== "string") throw new Error(`desks: opencode POST /session returned no id: ${JSON.stringify(created)}`);
      this.sessionId = created.id;
      this.openEventStream();
      const prompt = rolePrompt(spec);
      if (prompt !== "") await this.note(prompt);
    } catch (err) {
      this.sse?.abort();
      this.sse = undefined;
      await this.killServe();
      throw err;
    }
    const proc = this.proc as ServeProcess | undefined;
    return { sessionId: this.sessionId, engineUrl: this.baseUrl, childPid: proc?.pid };
  }

  /**
   * Boot, retrying a serve that exits with "database is locked": every opencode serve shares one
   * SQLite database, and two serves started in the same instant (desk up starts desks in parallel)
   * can collide on it. Up to LOCK_RETRIES re-boots with a growing, jittered delay.
   */
  private async boot(spec: HostSpec, config: Record<string, unknown>): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.bootOnce(spec, config);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (attempt >= LOCK_RETRIES || !/exited .* before ready/.test(msg) || !/database is locked/i.test(msg)) throw err;
        await sleep(this.lockRetryDelayMs * (attempt + 1) + Math.floor(Math.random() * this.lockRetryDelayMs));
      }
    }
  }

  private async bootOnce(spec: HostSpec, config: Record<string, unknown>): Promise<void> {
    if (await portIsOpen(this.port)) {
      throw new Error(`desks: opencode engine port ${this.port} is already in use (a stale serve?)`);
    }
    const env: NodeJS.ProcessEnv = {
      ...this.env,
      OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
      DESK_NAME: spec.name,
      DESK_ROLE: spec.role,
      ACH_DESK_NAME: spec.name,
      ACH_DESK_STACK: spec.stack,
    };
    const proc = this.spawnServe({
      bin: this.bin,
      args: ["serve", "--hostname", "127.0.0.1", "--port", String(this.port)],
      cwd: spec.cwd,
      env,
      logFile: this.logFile,
    });
    this.proc = proc;
    let exitedWith: number | string | null | undefined;
    let exited = false;
    // An exit before ready is reported by the throw below (and may be retried), not as an engine error event.
    let booting = true;
    void proc.exited.then((c) => {
      exited = true;
      exitedWith = c;
      if (this.proc === proc && !this.stopping && !booting) this.emit({ type: "error", data: { error: `opencode serve exited (${String(c)}); log ${this.logFile}` } });
    });
    const deadline = Date.now() + this.readyTimeoutMs;
    for (;;) {
      if (exited) {
        this.proc = undefined;
        throw new Error(`desks: opencode serve exited (${String(exitedWith)}) before ready on port ${this.port}. Log tail:\n${tailOf(this.logFile)}`);
      }
      try {
        const r = await fetch(`${this.baseUrl}/session`, { signal: AbortSignal.timeout(2000) });
        await r.body?.cancel();
        if (r.status === 200) {
          booting = false;
          return;
        }
      } catch {
        // not up yet
      }
      if (Date.now() > deadline) {
        await this.killServe();
        throw new Error(`desks: opencode serve not ready on port ${this.port} after ${this.readyTimeoutMs} ms. Log tail:\n${tailOf(this.logFile)}`);
      }
      await sleep(250);
    }
  }

  private requireSession(fn: string): void {
    if (!this.sessionId) throw new Error(`desks: OpenCodeEngine.${fn} before start()`);
  }

  private modelBody(): Record<string, unknown> {
    const m = splitModel(this.spec?.model);
    return m ? { model: m } : {};
  }

  async send(text: string): Promise<void> {
    this.requireSession("send");
    // Latch busy before the call: prompt_async returns before /session/status flips.
    this.pendingTurn = true;
    this.pendingSince = Date.now();
    this.markBusy();
    try {
      await this.http("POST", `/session/${this.sessionId}/prompt_async`, { ...this.modelBody(), parts: [{ type: "text", text }] });
    } catch (err) {
      this.pendingTurn = false;
      this.setBusy(false);
      throw err;
    }
  }

  async note(text: string): Promise<void> {
    this.requireSession("note");
    await this.http("POST", `/session/${this.sessionId}/message`, { noReply: true, ...this.modelBody(), parts: [{ type: "text", text }] });
  }

  async state(): Promise<"busy" | "idle"> {
    this.requireSession("state");
    const st = (await this.http("GET", "/session/status")) as Record<string, { type?: string }> | null;
    const mine = st?.[this.sessionId];
    const engineBusy = mine !== undefined && mine.type !== "idle";
    if (engineBusy) {
      this.pendingTurn = false;
      this.markBusy();
      return "busy";
    }
    // Grace: a just-accepted prompt_async that has not flipped status yet still counts as busy (<= 15 s).
    if (this.pendingTurn && Date.now() - this.pendingSince < 15_000) return "busy";
    if (this.pendingTurn || this.busy) {
      this.pendingTurn = false;
      this.onIdle();
    }
    return "idle";
  }

  async setGoal(objective: string): Promise<void> {
    this.requireSession("setGoal");
    this.objective = objective;
    await this.goals.setOpencodeGoal({
      baseUrl: this.baseUrl,
      sessionId: this.sessionId,
      objective,
      model: this.spec?.model,
      timeoutMs: this.goalTimeoutMs,
    });
  }

  async goalStatus(): Promise<GoalStatus> {
    this.requireSession("goalStatus");
    return this.goals.readOpencodeGoal({ dir: this.spec!.cwd, sessionId: this.sessionId, objective: this.objective || undefined });
  }

  async mcpStatus(): Promise<Record<string, string>> {
    const raw = (await this.http("GET", "/mcp")) as Record<string, unknown> | null;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw ?? {})) {
      out[k] = typeof v === "string" ? v : v && typeof v === "object" && typeof (v as { status?: unknown }).status === "string" ? (v as { status: string }).status : JSON.stringify(v);
    }
    return out;
  }

  attachCommand(): string[] {
    this.requireSession("attachCommand");
    return [this.bin, "attach", this.baseUrl, "--session", this.sessionId];
  }

  onEvent(cb: (e: EngineEvent) => void): void {
    this.listeners.push(cb);
  }

  async stop(): Promise<void> {
    if (this.stopped) return this.stopped;
    this.stopped = (async () => {
      this.stopping = true;
      if (this.sessionId && this.proc) {
        try {
          const st = (await this.http("GET", "/session/status", undefined, 2000)) as Record<string, { type?: string }> | null;
          if (st?.[this.sessionId] && st[this.sessionId]!.type !== "idle") {
            await this.http("POST", `/session/${this.sessionId}/abort`, undefined, 3000);
          }
        } catch {
          // serve unresponsive: the signals below handle it
        }
      }
      this.sse?.abort();
      this.sse = undefined;
      await this.killServe();
      if (this.busy) this.setBusy(false);
    })();
    return this.stopped;
  }

  /** TERM the serve group, KILL after the grace, then wait until the port is free (<= 5 s more). */
  private async killServe(): Promise<void> {
    const proc = this.proc;
    this.proc = undefined;
    if (!proc) return;
    proc.kill("SIGTERM");
    const gone = await Promise.race([proc.exited.then(() => true), sleep(this.stopGraceMs).then(() => false)]);
    if (!gone) {
      proc.kill("SIGKILL");
      await Promise.race([proc.exited, sleep(2000)]);
    }
    const deadline = Date.now() + 5000;
    while (this.port && (await portIsOpen(this.port))) {
      if (Date.now() > deadline) throw new Error(`desks: opencode engine port ${this.port} still listening after stop`);
      await sleep(100);
    }
  }

  // ------------------------------------------------------------------ events

  private emit(e: EngineEvent): void {
    for (const cb of this.listeners) {
      try {
        cb(e);
      } catch {
        // a listener's failure must not break the stream
      }
    }
  }

  private setBusy(b: boolean): void {
    if (b === this.busy) return;
    this.busy = b;
    this.emit({ type: b ? "turn_start" : "turn_end", data: { sessionId: this.sessionId } });
  }

  /** A busy signal (send(), stream, status poll). During an in-flight idle transition it becomes turn_end + turn_start. */
  private markBusy(): void {
    if (this.idleInFlight) {
      this.busyAfterIdle = true;
      return;
    }
    this.setBusy(true);
  }

  /**
   * busy -> idle: reconcile against the message list first (missed text/tool/usage), then turn_end.
   * At most ONE transition is in flight: opencode sends several idle signals per turn, and a queued
   * leftover must never end the NEXT turn.
   */
  private onIdle(): void {
    if (!this.busy || this.idleInFlight) return;
    this.busyAfterIdle = false;
    this.idleInFlight = this.reconcile()
      .catch(() => undefined)
      .then(() => {
        this.idleInFlight = undefined;
        this.setBusy(false);
        if (this.busyAfterIdle) {
          this.busyAfterIdle = false;
          this.setBusy(true);
        }
      });
  }
  private idleInFlight?: Promise<void>;
  private busyAfterIdle = false;

  private async reconcile(): Promise<void> {
    if (!this.sessionId || !this.proc) return;
    const msgs = (await this.http("GET", `/session/${this.sessionId}/message`, undefined, 5000)) as Array<{ info?: OcInfo; parts?: OcPart[] }> | null;
    for (const m of msgs ?? []) {
      if (m.info?.id && m.info.role) this.roles.set(m.info.id, m.info.role);
      const done = m.info?.time?.completed !== undefined;
      for (const p of m.parts ?? []) this.handlePart({ ...p, messageID: p.messageID ?? m.info?.id }, m.info, done);
    }
  }

  private handlePart(p: OcPart, info: OcInfo | undefined, final: boolean): void {
    const role = (p.messageID && this.roles.get(p.messageID)) ?? info?.role;
    if (role !== "assistant") return;
    const key = p.id ?? `${p.messageID}:${p.type}:${p.callID ?? ""}`;
    if (p.type === "text") {
      if (this.emittedText.has(key) || !p.text) return;
      if (!final && !p.time?.end) return;
      this.emittedText.add(key);
      this.emit({ type: "text", data: { text: p.text, messageId: p.messageID } });
    } else if (p.type === "tool") {
      const status = p.state?.status;
      if (status !== "completed" && status !== "error") return;
      if (this.emittedTool.has(key)) return;
      this.emittedTool.add(key);
      this.emit({ type: "tool", data: { tool: p.tool ?? "?", summary: toolSummary(p), status, callId: p.callID } });
    } else if (p.type === "step-finish") {
      if (this.emittedUsage.has(key) || !p.tokens) return;
      this.emittedUsage.add(key);
      const t = p.tokens;
      const cost = typeof p.cost === "number" && p.cost > 0 ? p.cost : null;
      const msgInfo = info;
      this.emit({
        type: "usage",
        data: {
          inputTokens: t.input ?? 0,
          outputTokens: t.output ?? 0,
          reasoningTokens: t.reasoning ?? 0,
          cacheReadTokens: t.cache?.read ?? 0,
          cacheWriteTokens: t.cache?.write ?? 0,
          // ferry (and other unpriced providers) report cost 0: null lets the metering seat price it.
          costUsd: cost,
          providerID: msgInfo?.providerID ?? this.modelProvider(),
          modelID: msgInfo?.modelID ?? this.modelId(),
          // One usage event per STEP (a per-step delta). The host meter treats a repeated
          // messageId as a cumulative re-report, so the id must be unique per step: the part id.
          messageId: key,
          ...(msgInfo?.providerID && msgInfo.modelID ? { model: `${msgInfo.providerID}/${msgInfo.modelID}` } : {}),
        },
      });
    }
  }

  private messageInfo = new Map<string, OcInfo>();

  private modelProvider(): string | undefined {
    return splitModel(this.spec?.model)?.providerID;
  }
  private modelId(): string | undefined {
    return splitModel(this.spec?.model)?.modelID;
  }

  /** Handle one opencode bus event ({type, properties}) from GET /event. Exposed for tests. */
  handleEvent(ev: { type?: string; properties?: Record<string, unknown> }): void {
    const props = ev.properties ?? {};
    const sid = (props.sessionID as string | undefined) ?? (props.info as OcInfo | undefined)?.sessionID ?? (props.part as OcPart | undefined)?.sessionID;
    if (sid !== this.sessionId) return;
    switch (ev.type) {
      case "session.status": {
        const t = (props.status as { type?: string } | undefined)?.type;
        if (t === "idle") this.streamIdle();
        else if (t) {
          // The turn send() started is now visible on the engine: drop the latch.
          this.pendingTurn = false;
          this.markBusy();
        }
        break;
      }
      case "session.idle":
        this.streamIdle();
        break;
      case "session.error": {
        const err = props.error as { name?: string; data?: { message?: string } } | undefined;
        // stop() aborts a running turn on purpose: that abort is not an error.
        if (this.stopping && err?.name === "MessageAbortedError") break;
        this.emit({ type: "error", data: { error: err?.data?.message ?? err?.name ?? "opencode session error", name: err?.name } });
        break;
      }
      case "message.updated": {
        const info = props.info as OcInfo | undefined;
        if (info?.id) {
          if (info.role) this.roles.set(info.id, info.role);
          this.messageInfo.set(info.id, info);
        }
        break;
      }
      case "message.part.updated": {
        const part = props.part as OcPart | undefined;
        if (part) this.handlePart(part, part.messageID ? this.messageInfo.get(part.messageID) : undefined, false);
        break;
      }
      default:
        break;
    }
  }
  /** An idle event while send()'s latch is up (and busy not yet seen) is the PREVIOUS turn's: ignore it within the grace. */
  private streamIdle(): void {
    if (this.pendingTurn && Date.now() - this.pendingSince < 15_000) return;
    this.pendingTurn = false;
    this.onIdle();
  }

  private openEventStream(): void {
    const ctl = new AbortController();
    this.sse = ctl;
    const url = `${this.baseUrl}/event?directory=${encodeURIComponent(this.spec!.cwd)}`;
    const run = async () => {
      while (!ctl.signal.aborted) {
        try {
          const r = await fetch(url, { headers: { accept: "text/event-stream" }, signal: ctl.signal });
          if (!r.ok || !r.body) throw new Error(`GET /event -> ${r.status}`);
          // Reconnected: catch up on anything missed while the stream was down.
          void this.state().catch(() => undefined);
          const reader = r.body.getReader();
          const dec = new TextDecoder();
          let buf = "";
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            buf += dec.decode(value, { stream: true });
            let nl: number;
            while ((nl = buf.indexOf("\n")) >= 0) {
              const line = buf.slice(0, nl).replace(/\r$/, "");
              buf = buf.slice(nl + 1);
              if (!line.startsWith("data:")) continue;
              try {
                const ev = JSON.parse(line.slice(5)) as { type?: string; properties?: Record<string, unknown> };
                this.streamEventCount++;
                this.handleEvent(ev);
              } catch {
                // malformed line: skip
              }
            }
          }
        } catch {
          // dropped or aborted: retry below unless stopping
        }
        if (ctl.signal.aborted || this.stopping) return;
        await sleep(1000);
      }
    };
    void run();
  }

  // ------------------------------------------------------------------ http

  private async http(method: "GET" | "POST", path: string, body?: unknown, timeoutMs = 15_000): Promise<unknown> {
    if (!this.baseUrl) throw new Error("desks: OpenCodeEngine used before start()");
    const r = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await r.text();
    if (!r.ok) throw new Error(`desks: opencode ${method} ${path.split("?")[0]} -> HTTP ${r.status}: ${text.slice(0, 300)}`);
    if (text === "") return null;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return text;
    }
  }
}
