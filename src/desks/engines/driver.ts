// DriverEngine (#204). Owner: driver engine seat. Implements the Engine contract in ../types.ts.
//
// Every non-opencode agent (claude first) runs as a desk through the core
// driver: each turn is ONE `driver.run(agent, runSpec)` that resumes the
// previous turn's session. Each turn's RunSpec carries parentRunId = the
// desk's own run id and desk = {stack, name, kind: "turn"}, so the per-turn
// child registry record (written because the driver gets `registry`) holds
// that turn's metering; stats sum children by parentRunId.
//
// Context handling:
// - Role files (spec.roleFiles, `$DESK_NAME` -> spec.name) are the desk's
//   system context. claude gets them as `--append-system-prompt` on EVERY
//   turn (a resumed `claude -p` rebuilds its system prompt per invocation, so
//   passing it once would drop it from turn 2 on). Other agents have no such
//   flag: the role text is prefixed to the first prompt of the session, and
//   after a `desk reload` whose role files changed, to the next turn once more
//   (marked as a refresh; see ../role-sent.ts).
// - note(text): no agent CLI has a silent-context API for a headless resumed
//   session, so notes are buffered and prepended to the NEXT turn's prompt
//   inside a "[context notes]" block. A note never starts a turn.
//
// MCP: the `desks` server (desksMcpDef) plus spec.mcpServers entries for the
// names in spec.mcps are written to <stateDir>/desks/<stack>/mcp/<name>.json
// and handed to the adapter as sandbox.mcpConfig (claude/gemini: --mcp-config).
// claude also gets `--strict-mcp-config` so the user's global MCPs never load
// into a desk turn, and runs on the DEFAULT claude config (see claudeAdapter
// below) so keychain logins work and `--resume` finds the previous turn.
// permissionMode "dontAsk" (claude bypassPermissions, gemini yolo, codex
// never): a headless desk turn has nobody to answer a permission prompt.
import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ClaudeCodeAdapter } from "../../adapters/claude.ts";
import { createDriver, defaultAdapters, type Driver } from "../../core/driver.ts";
import type { AgentAdapter, AgentEvent, RunResult, RunSpec } from "../../core/types.ts";
import { roleNeedsRefresh, roleRefreshNote, writeRoleSent } from "../role-sent.ts";
import { achSelfArgv, desksMcpDef } from "../self.ts";
import type { Engine, EngineEvent, GoalStatus, HostSpec, McpServerDef } from "../types.ts";
import { startGoalLoop as realStartGoalLoop, type GoalLoopHandle, type GoalLoopOptions } from "./goal-loop.ts";

export interface DriverEngineDeps {
  /** Adapter map handed to createDriver. Default: defaultAdapters() with claude on the default config. */
  adapters?: Record<string, AgentAdapter>;
  /** Goal loop (goal-loop seat). Injected in tests. */
  startGoalLoop?: (o: GoalLoopOptions) => GoalLoopHandle;
  /** Env for achSelfArgv/desksMcpDef. Default process.env. */
  env?: NodeJS.ProcessEnv;
  /** Per-turn wall-clock cap (RunSpec.timeoutMs). Default none. */
  turnTimeoutMs?: number;
  /** How long stop() waits for an aborted turn to settle. Default 15000. */
  stopWaitMs?: number;
  /** Portable permission mode for every turn. Default "dontAsk"; null = adapter default. */
  permissionMode?: string | null;
  /** Raw agent stdout tap (DriverOptions.onOutput); diagnostics and the live test. */
  onOutput?: (chunk: string) => void;
}

/** One settled turn, as the goal loop and tests see it. */
export interface DriverTurnResult {
  runId: string;
  finalText: string;
  sessionId?: string;
  exitStatus?: string;
  error?: string;
}

/** Text of an assistant message event, or "" when the event is not one. */
export function assistantText(e: AgentEvent): string {
  if (e.type !== "message") return "";
  const m = e as { source?: string; role?: string; content?: unknown; text?: unknown; reasoning?: unknown };
  if (m.reasoning === true) return "";
  const who = m.role ?? m.source;
  if (who !== undefined && who !== "agent" && who !== "assistant") return "";
  if (typeof m.content === "string" && m.content !== "") return m.content;
  if (typeof m.text === "string") return m.text;
  return "";
}

function summarize(v: unknown, max = 200): string {
  if (v === undefined || v === null || v === "") return "";
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** AgentEvent -> EngineEvent (text/tool/error only; turn_* and usage are emitted by the turn itself). */
export function mapAgentEvent(e: AgentEvent): EngineEvent | null {
  const text = assistantText(e);
  if (text !== "") return { type: "text", data: { text } };
  if (e.type === "tool_call") {
    const t = e as { functionName?: string; title?: string; arguments?: unknown };
    return { type: "tool", data: { tool: t.functionName ?? t.title ?? "tool", summary: summarize(t.arguments) } };
  }
  if (e.type === "tool") {
    const t = e as { toolName: string; phase: string; input?: unknown };
    if (t.phase !== "start") return null;
    return { type: "tool", data: { tool: t.toolName, summary: summarize(t.input) } };
  }
  if (e.type === "error") {
    const m = (e as { message?: string }).message;
    return { type: "error", data: { error: m ?? "agent error" } };
  }
  return null;
}

/** Role context: role files concatenated, `$DESK_NAME` replaced. */
export function roleContext(spec: Pick<HostSpec, "roleFiles" | "name">): string {
  return spec.roleFiles
    .map((f) => readFileSync(f, "utf8").replaceAll("$DESK_NAME", spec.name).trim())
    .filter((s) => s !== "")
    .join("\n\n");
}

/** The prompt one turn sends: optional role prefix, buffered notes, then the message. */
export function composeTurnPrompt(o: { role?: string; notes: string[]; text: string }): string {
  const parts: string[] = [];
  if (o.role) parts.push(o.role, "---");
  if (o.notes.length > 0) parts.push(`[context notes, not a message; no reply needed]\n${o.notes.join("\n")}\n[end of context notes]`);
  parts.push(o.text);
  return parts.join("\n\n");
}

/** MCP config object for a desk: `desks` first, then the named servers that have definitions. */
export function deskMcpConfig(spec: HostSpec, env: NodeJS.ProcessEnv = process.env): { mcpServers: Record<string, McpServerDef> } {
  const servers: Record<string, McpServerDef> = {
    desks: desksMcpDef({ name: spec.name, stack: spec.stack, stateDir: spec.stateDir }, env),
  };
  for (const name of spec.mcps) {
    if (name === "desks") continue;
    const def = spec.mcpServers?.[name];
    if (def) servers[name] = def;
  }
  return { mcpServers: servers };
}

/** claude on the default config: keychain login works and `--resume` finds the prior turn's session. */
function claudeAdapter(stateDir: string): AgentAdapter {
  const probe = new ClaudeCodeAdapter({ stateDir, useDefaultClaudeConfig: true });
  return {
    name: "claude",
    enforcesBudget: true,
    validateProfile: (s: RunSpec) => probe.validateProfile(s),
    launch: (s: RunSpec) => new ClaudeCodeAdapter({ stateDir, useDefaultClaudeConfig: true }).launch(s),
  };
}

export class DriverEngine implements Engine {
  readonly kind = "driver" as const;
  readonly #deps: DriverEngineDeps;
  #spec: HostSpec | null = null;
  #driver: Driver | null = null;
  #role = "";
  /** Non-claude resumed session whose role files changed since it got them: the next turn carries the current role once (role-sent.ts). */
  #roleRefresh = false;
  #mcpConfigPath = "";
  #sessionId: string | undefined;
  #notes: string[] = [];
  #listeners: ((e: EngineEvent) => void)[] = [];
  #chain: Promise<unknown> = Promise.resolve();
  #pending = 0;
  #currentRunId: string | null = null;
  #currentText: string[] = [];
  #stopped = false;
  #goal: GoalLoopHandle | null = null;
  #goalObjective = "";
  /** Bumped per setGoal: a loop that is no longer current must not speak through onStatus. */
  #goalGen = 0;
  /** Every turn's run id, oldest first (tests, host diagnostics). */
  readonly turnRunIds: string[] = [];

  constructor(deps: DriverEngineDeps = {}) {
    this.#deps = deps;
  }

  /** Agent session id (known after the first turn reports it). */
  get sessionId(): string | undefined {
    return this.#sessionId;
  }

  async start(spec: HostSpec): Promise<{ sessionId?: string; engineUrl?: string; childPid?: number }> {
    if (this.#driver) throw new Error("desks: DriverEngine.start called twice");
    const env = this.#deps.env ?? process.env;
    let adapters = this.#deps.adapters;
    if (!adapters) {
      adapters = { ...(await defaultAdapters()), claude: claudeAdapter(spec.stateDir) };
    }
    if (!adapters[spec.agent]) {
      throw new Error(`desks: agent "${spec.agent}" has no driver adapter; registered: ${Object.keys(adapters).join(", ")}`);
    }
    this.#role = roleContext(spec);
    const dir = path.join(spec.stateDir, "desks", spec.stack, "mcp");
    mkdirSync(dir, { recursive: true });
    this.#mcpConfigPath = path.join(dir, `${spec.name}.json`);
    // The config can carry env tokens for the named MCP servers: owner-only, even over an older wider file.
    writeFileSync(this.#mcpConfigPath, `${JSON.stringify(deskMcpConfig(spec, env), null, 2)}\n`, { mode: 0o600 });
    chmodSync(this.#mcpConfigPath, 0o600);
    this.#spec = spec;
    this.#driver = createDriver({
      adapters,
      stateDir: spec.stateDir,
      registry: { stateDir: spec.stateDir },
      onEvent: (e) => this.#onAgentEvent(e),
      ...(this.#deps.onOutput ? { onOutput: this.#deps.onOutput } : {}),
    });
    // `desk reload`: continue the previous session. Every turn already resumes #sessionId, so seeding
    // it is the whole resume. claude rebuilds its system prompt (the current role) every turn; other
    // agents got the role prefixed to their first prompt, so when the role files changed since, the
    // next turn carries the current role once. An adapter whose CLI cannot resume starts fresh, and
    // the host reports no session id, so reload says so.
    const resume = spec.resumeSessionId;
    if (resume !== undefined && resume !== "" && adapters[spec.agent]!.capabilities?.resume !== false) {
      this.#sessionId = resume;
      this.#roleRefresh = spec.agent !== "claude" && roleNeedsRefresh(spec, resume, this.#role);
      return { sessionId: resume };
    }
    return {};
  }

  async send(text: string): Promise<void> {
    this.#requireStarted("send");
    if (this.#stopped) throw new Error("desks: DriverEngine stopped");
    // Accepted = queued on the turn chain with busy already set; the turn's
    // outcome arrives as events (turn_end/error), never as a rejection here.
    this.#enqueueTurn(text).catch(() => undefined);
  }

  async note(text: string): Promise<void> {
    this.#requireStarted("note");
    this.#notes.push(text);
  }

  async state(): Promise<"busy" | "idle"> {
    return this.#pending > 0 ? "busy" : "idle";
  }

  async setGoal(objective: string): Promise<void> {
    this.#requireStarted("setGoal");
    this.#goal?.stop("replaced by a new goal");
    const gen = ++this.#goalGen;
    const start = this.#deps.startGoalLoop ?? realStartGoalLoop;
    this.#goalObjective = objective;
    this.#goal = start({
      objective,
      runTurn: async (t, ctx) => {
        const r = await this.#enqueueTurn(t, ctx?.timeoutMs);
        if (r.error !== undefined && r.finalText === "") throw new Error(r.error);
        return r.finalText;
      },
      onStatus: (s) => {
        if (gen !== this.#goalGen) return;
        this.#emit({ type: "goal", data: { goal: s } });
      },
    });
  }

  async goalStatus(): Promise<GoalStatus> {
    if (this.#goal) return this.#goal.status();
    return { state: "none", source: "ach-loop", objective: this.#goalObjective, updatedAt: Date.now() };
  }

  async mcpStatus(): Promise<Record<string, string>> {
    const spec = this.#requireStarted("mcpStatus");
    const out: Record<string, string> = { desks: "configured" };
    for (const name of spec.mcps) {
      if (name === "desks") continue;
      out[name] = spec.mcpServers?.[name] ? "configured" : "missing definition";
    }
    return out;
  }

  attachCommand(): string[] {
    const spec = this.#requireStarted("attachCommand");
    return ["env", `ACH_DESK_STACK=${spec.stack}`, ...achSelfArgv(this.#deps.env ?? process.env), "desk", "chat", spec.name];
  }

  onEvent(cb: (e: EngineEvent) => void): void {
    this.#listeners.push(cb);
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    this.#goal?.stop("engine stopped");
    const id = this.#currentRunId;
    if (id !== null) this.#driver?.abort(id);
    const wait = this.#deps.stopWaitMs ?? 15_000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      this.#chain.catch(() => undefined),
      new Promise<void>((r) => {
        timer = setTimeout(r, wait);
        timer.unref?.();
      }),
    ]);
    if (timer) clearTimeout(timer);
  }

  // ------------------------------------------------------------------ internals

  #requireStarted(fn: string): HostSpec {
    if (!this.#spec || !this.#driver) throw new Error(`desks: DriverEngine.${fn} before start()`);
    return this.#spec;
  }

  #emit(e: EngineEvent): void {
    for (const cb of this.#listeners) {
      try {
        cb(e);
      } catch {
        /* a listener never breaks a turn */
      }
    }
  }

  #onAgentEvent(e: AgentEvent): void {
    if (this.#currentRunId === null) return;
    if (this.#stopped) {
      // stop() can land before the driver registered the run for abort(): abort on the first event.
      this.#driver?.abort(this.#currentRunId);
      return;
    }
    const sid = (e as { sessionId?: unknown }).sessionId;
    if (typeof sid === "string" && sid !== "") this.#sessionId = sid;
    const mapped = mapAgentEvent(e);
    if (!mapped) return;
    if (mapped.type === "text") this.#currentText.push(mapped.data.text as string);
    this.#emit(mapped);
  }

  /** Serializes turns (send() and the goal loop share one session). Busy is set synchronously. */
  #enqueueTurn(text: string, timeoutMs?: number): Promise<DriverTurnResult> {
    if (this.#stopped) return Promise.reject(new Error("desks: DriverEngine stopped"));
    this.#pending += 1;
    const turn = this.#chain.then(() => this.#runTurn(text, timeoutMs));
    this.#chain = turn.catch(() => undefined);
    return turn;
  }

  async #runTurn(text: string, goalTimeoutMs?: number): Promise<DriverTurnResult> {
    const spec = this.#spec as HostSpec;
    const driver = this.#driver as Driver;
    const runId = randomUUID();
    if (this.#stopped) {
      this.#pending -= 1;
      return { runId, finalText: "", error: "stopped" };
    }
    const isClaude = spec.agent === "claude";
    const firstTurn = this.#sessionId === undefined;
    const notes = this.#notes;
    this.#notes = [];
    const refresh = !isClaude && !firstTurn && this.#roleRefresh;
    const role = !isClaude && firstTurn ? this.#role : refresh ? roleRefreshNote(this.#role) : undefined;
    const prompt = composeTurnPrompt({ role, notes, text });
    const extraArgs = isClaude
      ? ["--strict-mcp-config", ...(this.#role !== "" ? ["--append-system-prompt", this.#role] : [])]
      : undefined;
    const permissionMode = this.#deps.permissionMode === undefined ? "dontAsk" : this.#deps.permissionMode;
    const caps = [this.#deps.turnTimeoutMs, goalTimeoutMs].filter((n): n is number => n !== undefined);
    const turnTimeoutMs = caps.length > 0 ? Math.min(...caps) : undefined;
    const runSpec: RunSpec = {
      prompt,
      runId,
      cwd: spec.cwd,
      stateDir: spec.stateDir,
      ...(spec.model !== undefined ? { model: spec.model } : {}),
      ...(this.#sessionId !== undefined ? { resume: this.#sessionId } : {}),
      parentRunId: spec.runId,
      desk: { stack: spec.stack, name: spec.name, kind: "turn" },
      sandbox: { mcpConfig: this.#mcpConfigPath, ...(permissionMode !== null ? { permissionMode } : {}) },
      ...(extraArgs ? { extraArgs } : {}),
      ...(turnTimeoutMs !== undefined ? { timeoutMs: turnTimeoutMs } : {}),
    };
    this.#currentRunId = runId;
    this.#currentText = [];
    this.turnRunIds.push(runId);
    this.#emit({ type: "turn_start", data: { runId } });
    let result: RunResult | undefined;
    let error: string | undefined;
    try {
      result = await driver.run(spec.agent, runSpec);
      if (result.sessionId) this.#sessionId = result.sessionId;
      // The role rode this turn's prompt (first turn or refresh): record it, so a reload resends it only after a change.
      if (role !== undefined && this.#role !== "" && this.#sessionId !== undefined && result.exitStatus === "success") {
        writeRoleSent(spec, this.#sessionId, this.#role);
        if (refresh) this.#roleRefresh = false;
      }
      const u = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
      for (const t of result.tokens) {
        u.inputTokens += t.inputTokens;
        u.outputTokens += t.outputTokens;
        u.cacheReadTokens += t.cacheReadTokens;
        u.cacheWriteTokens += t.cacheWriteTokens;
      }
      if (result.tokens.length > 0) {
        this.#emit({
          type: "usage",
          data: {
            ...u,
            costUsd: result.totalCost,
            messageId: runId,
            // The turn's own run already wrote these token records (see UsageSample.recorded).
            recorded: true,
            ...(spec.model !== undefined ? { model: spec.model } : {}),
          },
        });
      }
      if (result.exitStatus !== "success") error = `turn ended ${result.exitStatus}`;
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      // Turn 1 never reported a session: keep notes for the retry.
      if (firstTurn && this.#sessionId === undefined) this.#notes = [...notes, ...this.#notes];
    }
    // The turn's FINAL assistant text (goal-loop contract), not every message joined.
    const finalText = this.#currentText.at(-1) ?? "";
    this.#currentRunId = null;
    this.#pending -= 1;
    if (error !== undefined && !(this.#stopped && result?.exitStatus === "aborted")) {
      this.#emit({ type: "error", data: { error, runId } });
    }
    this.#emit({
      type: "turn_end",
      data: { runId, exitStatus: result?.exitStatus ?? "error", ...(this.#sessionId ? { sessionId: this.#sessionId } : {}) },
    });
    return {
      runId,
      finalText,
      ...(this.#sessionId !== undefined ? { sessionId: this.#sessionId } : {}),
      ...(result ? { exitStatus: result.exitStatus } : {}),
      ...(error !== undefined ? { error } : {}),
    };
  }
}
