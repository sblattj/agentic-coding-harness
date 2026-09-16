/**
 * Kiro ACP transport client.
 *
 * `kiro-cli acp` speaks newline-delimited JSON-RPC 2.0 on stdio — NOT the
 * Content-Length framing used by LSP. Measured against kiro-cli 2.21.2
 * (2026-09-12); the recorded traffic lives in
 * `tests/fixtures/kiro/acp-handshake-2.21.2.jsonl` and `…/acp-prompt-2.21.2.jsonl`.
 *
 * Two facts drive the shape of this module:
 *   1. `initialize` returns NOTHING unless `params` carries `clientInfo` AND
 *      `clientCapabilities.terminal`. Without them the agent is silent forever,
 *      so every startup phase needs a deadline that names itself.
 *   2. `-v` makes the binary write log lines to STDOUT, which would corrupt the
 *      JSON-RPC stream. This module never passes it.
 *
 * This file is transport only: it does not normalize events and it does not
 * know about `KiroAdapter`.
 */

import { VERSION } from '../version.ts';
import {
  defaultSpawnFn,
  EventQueue,
  LineAssembler,
  scrubEnvVars,
  type ChildProcessLike,
  type SpawnFn,
} from './shared.ts';

// ---------------------------------------------------------------------------
// Arg building
// ---------------------------------------------------------------------------

export type KiroAcpEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export type KiroAcpEngine = 'v1' | 'v2' | 'v3';
export type KiroAcpTools = 'all' | 'none' | string[];

export interface KiroAcpArgsConfig {
  agent?: string;
  model?: string;
  effort?: KiroAcpEffort;
  /**
   * Trust policy. `undefined` emits NO trust flag at all so the native agent
   * config decides — an implicit `--trust-all-tools` is never correct.
   */
  tools?: KiroAcpTools;
  engine?: KiroAcpEngine;
}

/** Pure argv builder for `kiro-cli acp`. Never emits `-v`. */
export function buildKiroAcpArgs(cfg: KiroAcpArgsConfig = {}): string[] {
  const args = ['acp'];
  if (cfg.agent) args.push('--agent', cfg.agent);
  if (cfg.model) args.push('--model', cfg.model);
  if (cfg.effort) args.push('--effort', cfg.effort);
  if (cfg.tools === 'all') {
    args.push('--trust-all-tools');
  } else if (cfg.tools === 'none') {
    args.push('--trust-tools=');
  } else if (Array.isArray(cfg.tools)) {
    args.push(`--trust-tools=${cfg.tools.join(',')}`);
  }
  if (cfg.engine) args.push('--agent-engine', cfg.engine);
  return args;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type KiroAcpPhase =
  | 'spawn'
  | 'initialize'
  | 'session/new'
  | 'session/set_model'
  | 'session/prompt'
  /** Not a request phase: the MCP-startup gate in kiro-acp-launch.ts (PLAN § ACP client). */
  | 'mcp';

export class KiroAcpError extends Error {
  readonly phase: KiroAcpPhase;
  readonly stderrTail: string;
  readonly cause?: unknown;

  constructor(phase: KiroAcpPhase, message: string, stderrTail = '', cause?: unknown) {
    super(`kiro acp [${phase}]: ${message}`);
    this.name = 'KiroAcpError';
    this.phase = phase;
    this.stderrTail = stderrTail;
    this.cause = cause;
  }
}

// ---------------------------------------------------------------------------
// Protocol shapes (structural; the agent adds vendor fields we pass through)
// ---------------------------------------------------------------------------

export interface AcpMcpServer {
  name: string;
  [k: string]: unknown;
}

export interface AcpMode {
  id: string;
  name?: string;
  description?: string;
  [k: string]: unknown;
}

export interface AcpModel {
  modelId: string;
  name?: string;
  description?: string;
  [k: string]: unknown;
}

export interface AcpNewSessionResult {
  sessionId: string;
  modes?: { currentModeId?: string; availableModes?: AcpMode[] };
  models?: { currentModelId?: string; availableModels?: AcpModel[] };
  [k: string]: unknown;
}

export interface AcpInitializeResult {
  protocolVersion?: number;
  agentCapabilities?: { loadSession?: boolean; [k: string]: unknown };
  agentInfo?: { name?: string; version?: string; [k: string]: unknown };
  [k: string]: unknown;
}

export interface AcpPromptResult {
  stopReason?: string;
  [k: string]: unknown;
}

/** Anything the agent pushes at us without an id, plus our own `__client_request` records. */
export interface AcpNotification {
  method: string;
  params: unknown;
}

export interface AcpPermissionOutcome {
  outcome: { outcome: 'selected'; optionId: string } | { outcome: 'cancelled' };
}

export type OnPermissionFn = (params: unknown) => Promise<AcpPermissionOutcome>;

/**
 * Default permission policy: DENY. We never auto-select an allow option — a
 * transport that silently broadens tool access defeats the point of the
 * `tools` trust policy.
 */
export const denyAllPermissions: OnPermissionFn = async () => ({ outcome: { outcome: 'cancelled' } });

export interface HandshakeReceipt {
  cliVersion: string | null;
  sessionId: string;
  currentModeId: string | null;
  availableModes: AcpMode[];
  currentModelId: string | null;
  availableModels: AcpModel[];
  modelAck: 'acknowledged' | 'rejected' | 'not-requested';
  agentVerified: boolean;
  modelVerified: boolean;
  /** Methods of `_kiro.dev/mcp/*` and `_kiro.dev/webTools/*` notices seen during the handshake. */
  mcpNotices: string[];
  durationsMs: { initialize: number; newSession: number; setModel: number; total: number };
}

export interface HandshakeOptions {
  cwd: string;
  mcpServers?: AcpMcpServer[];
  agent?: string;
  model?: string;
  requireModelAck?: boolean;
}

export interface KiroAcpClientOptions {
  command?: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
  /**
   * SandboxPolicy.scrubEnv (issue #8): scrub provider credential/config-dir
   * env vars from the merged child env before spawn (`true` = known set,
   * string array = exactly those names).
   */
  scrubEnv?: boolean | string[];
  spawnFn?: SpawnFn;
  /** Per-phase deadline for initialize/session/new/session/set_model. Measured initialize ≈ 15 s. */
  startupMs?: number;
  clientInfo?: { name: string; version: string };
  onPermission?: OnPermissionFn;
  /** stdin-end → SIGTERM grace. */
  termGraceMs?: number;
  /** SIGTERM → SIGKILL grace. */
  killGraceMs?: number;
  /** Bounded stderr ring buffer size, in lines. */
  stderrLines?: number;
}

const FS_TERMINAL_METHODS = /^(fs\/|terminal\/)/;
const MCP_NOTICE_METHODS = /^_kiro\.dev\/(mcp|webTools)\//;

interface Pending {
  phase: KiroAcpPhase;
  method: string;
  resolve: (value: unknown) => void;
  reject: (err: unknown) => void;
  timer: NodeJS.Timeout | null;
}

export class KiroAcpClient {
  readonly #command: string;
  readonly #args: string[];
  readonly #cwd: string | undefined;
  readonly #env: Record<string, string> | undefined;
  readonly #scrubEnv: boolean | string[] | undefined;
  readonly #spawnFn: SpawnFn;
  readonly #startupMs: number;
  readonly #clientInfo: { name: string; version: string };
  readonly #onPermission: OnPermissionFn;
  readonly #termGraceMs: number;
  readonly #killGraceMs: number;
  readonly #stderrLines: number;

  #child: (ChildProcessLike & { pid?: number }) | null = null;
  #nextId = 0;
  #pending = new Map<number, Pending>();
  #stderrRing: string[] = [];
  #exited = false;
  #closePromise: Promise<number | null> | null = null;
  #exitWaiters: Array<(code: number | null) => void> = [];

  pid: number | undefined;
  exitCode: number | null = null;
  /** Every agent→client message that is not a response: notifications and `__client_request` records. */
  readonly notifications = new EventQueue<AcpNotification>();

  constructor(opts: KiroAcpClientOptions) {
    this.#command = opts.command ?? 'kiro-cli';
    this.#args = opts.args;
    this.#cwd = opts.cwd;
    this.#env = opts.env;
    this.#scrubEnv = opts.scrubEnv;
    this.#spawnFn = opts.spawnFn ?? defaultSpawnFn;
    this.#startupMs = opts.startupMs ?? 60_000;
    this.#clientInfo = opts.clientInfo ?? { name: 'agentic-coding-harness', version: VERSION };
    this.#onPermission = opts.onPermission ?? denyAllPermissions;
    this.#termGraceMs = opts.termGraceMs ?? 2_000;
    this.#killGraceMs = opts.killGraceMs ?? 3_000;
    this.#stderrLines = opts.stderrLines ?? 200;
  }

  /** Last lines the child wrote to stderr (bounded ring buffer). */
  stderrTail(lines = 20): string {
    return this.#stderrRing.slice(-lines).join('\n');
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  start(): void {
    if (this.#child) return;
    let child: ChildProcessLike & { pid?: number };
    try {
      child = this.#spawnFn(this.#command, this.#args, {
        cwd: this.#cwd,
        env: scrubEnvVars(
          this.#env ? { ...process.env, ...this.#env } : process.env,
          this.#scrubEnv,
        ),
        stdio: ['pipe', 'pipe', 'pipe'],
      }) as ChildProcessLike & { pid?: number };
    } catch (err) {
      throw new KiroAcpError('spawn', `failed to spawn ${this.#command}`, '', err);
    }
    this.#child = child;
    this.pid = child.pid;

    const stdout = new LineAssembler();
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      for (const line of stdout.push(chunk)) this.#onLine(line);
    });
    child.stdout?.on('end', () => {
      for (const line of stdout.flush()) this.#onLine(line);
    });

    const stderr = new LineAssembler();
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      for (const line of stderr.push(chunk)) this.#pushStderr(line);
    });

    child.once('error', (err: Error) => {
      this.#pushStderr(`spawn error: ${err.message}`);
      this.#onExit(null);
    });
    child.once('close', (code: number | null) => {
      this.#onExit(code);
    });
  }

  #pushStderr(line: string): void {
    this.#stderrRing.push(line);
    if (this.#stderrRing.length > this.#stderrLines) {
      this.#stderrRing.splice(0, this.#stderrRing.length - this.#stderrLines);
    }
  }

  #onExit(code: number | null): void {
    if (this.#exited) return;
    this.#exited = true;
    this.exitCode = code;
    for (const [, p] of this.#pending) {
      if (p.timer) clearTimeout(p.timer);
      p.reject(
        new KiroAcpError(
          p.phase,
          `child exited (code ${code ?? 'null'}) with ${p.method} in flight`,
          this.stderrTail(),
        ),
      );
    }
    this.#pending.clear();
    this.notifications.close();
    const waiters = this.#exitWaiters;
    this.#exitWaiters = [];
    for (const w of waiters) w(code);
  }

  #waitForExit(): Promise<number | null> {
    if (this.#exited) return Promise.resolve(this.exitCode);
    return new Promise((resolve) => this.#exitWaiters.push(resolve));
  }

  /**
   * stdin end → wait `termGraceMs` → SIGTERM → wait `killGraceMs` → SIGKILL.
   * Resolves once the child has exited. Idempotent.
   */
  close(): Promise<number | null> {
    if (this.#closePromise) return this.#closePromise;
    this.#closePromise = this.#doClose();
    return this.#closePromise;
  }

  async #doClose(): Promise<number | null> {
    const child = this.#child;
    if (!child) return this.exitCode;
    if (this.#exited) return this.exitCode;
    try {
      child.stdin?.end();
    } catch {
      /* already closed */
    }
    if (await this.#raceExit(this.#termGraceMs)) return this.exitCode;
    try {
      child.kill('SIGTERM');
    } catch {
      /* already gone */
    }
    if (await this.#raceExit(this.#killGraceMs)) return this.exitCode;
    try {
      child.kill('SIGKILL');
    } catch {
      /* already gone */
    }
    return await this.#waitForExit();
  }

  /** Resolves true if the child exited within `ms`. */
  #raceExit(ms: number): Promise<boolean> {
    if (this.#exited) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(this.#exited), ms);
      timer.unref?.();
      void this.#waitForExit().then(() => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }

  // -------------------------------------------------------------------------
  // Wire
  // -------------------------------------------------------------------------

  #write(msg: unknown): void {
    const child = this.#child;
    if (!child || this.#exited) return;
    child.stdin?.write(`${JSON.stringify(msg)}\n`);
  }

  #onLine(line: string): void {
    const text = line.trim();
    if (!text) return;
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(text) as Record<string, unknown>;
    } catch {
      // Not JSON-RPC. `-v` would put log lines here; we never pass it, but a
      // stray line must not kill the transport — keep it as diagnostics.
      this.#pushStderr(`non-json stdout: ${text.slice(0, 400)}`);
      return;
    }
    const hasId = msg.id !== undefined && msg.id !== null;
    if (hasId && typeof msg.method === 'string') {
      void this.#onClientRequest(msg.id as number | string, msg.method, msg.params);
      return;
    }
    if (hasId) {
      this.#onResponse(msg);
      return;
    }
    if (typeof msg.method === 'string') {
      this.notifications.push({ method: msg.method, params: msg.params });
    }
  }

  #onResponse(msg: Record<string, unknown>): void {
    const id = Number(msg.id);
    const pending = this.#pending.get(id);
    if (!pending) return;
    this.#pending.delete(id);
    if (pending.timer) clearTimeout(pending.timer);
    const err = msg.error as { code?: number; message?: string } | undefined;
    if (err) {
      pending.reject(
        new KiroAcpError(
          pending.phase,
          `${pending.method} failed: ${err.message ?? 'unknown error'} (code ${err.code ?? '?'})`,
          this.stderrTail(),
          err,
        ),
      );
      return;
    }
    pending.resolve(msg.result);
  }

  /**
   * Agent→client requests. We advertise `fs:false` and `terminal:false`, so
   * those are answered `-32601`; permission requests go through the injected
   * policy, whose default denies. Everything is surfaced on `notifications` as
   * `__client_request` so the run evidence shows what was asked and answered.
   */
  async #onClientRequest(id: number | string, method: string, params: unknown): Promise<void> {
    let answered: unknown;
    if (method === 'session/request_permission') {
      let outcome: AcpPermissionOutcome;
      try {
        outcome = await this.#onPermission(params);
      } catch {
        outcome = { outcome: { outcome: 'cancelled' } };
      }
      answered = outcome;
      this.#write({ jsonrpc: '2.0', id, result: outcome });
    } else if (FS_TERMINAL_METHODS.test(method)) {
      const error = {
        code: -32601,
        message: `Method not found: ${method} (client advertises fs:false, terminal:false)`,
      };
      answered = { error };
      this.#write({ jsonrpc: '2.0', id, error });
    } else {
      const error = { code: -32601, message: `Method not found: ${method}` };
      answered = { error };
      this.#write({ jsonrpc: '2.0', id, error });
    }
    this.notifications.push({ method: '__client_request', params: { method, params, answered } });
  }

  #request<T>(method: string, params: unknown, phase: KiroAcpPhase, deadlineMs: number | null): Promise<T> {
    if (!this.#child) this.start();
    if (this.#exited) {
      return Promise.reject(
        new KiroAcpError(phase, `child already exited (code ${this.exitCode ?? 'null'})`, this.stderrTail()),
      );
    }
    const id = this.#nextId++;
    return new Promise<T>((resolve, reject) => {
      const entry: Pending = {
        phase,
        method,
        resolve: resolve as (v: unknown) => void,
        reject,
        timer: null,
      };
      if (deadlineMs !== null) {
        const timer = setTimeout(() => {
          this.#pending.delete(id);
          // A stalled startup phase owns the child: tear it down before we
          // report, so a timeout can never leak a live kiro-cli.
          void this.close().then(() => {
            reject(
              new KiroAcpError(
                phase,
                `${method} did not respond within ${deadlineMs}ms`,
                this.stderrTail(),
              ),
            );
          });
        }, deadlineMs);
        timer.unref?.();
        entry.timer = timer;
      }
      this.#pending.set(id, entry);
      this.#write({ jsonrpc: '2.0', id, method, params });
    });
  }

  // -------------------------------------------------------------------------
  // Protocol methods
  // -------------------------------------------------------------------------

  /**
   * `initialize` — `clientInfo` and `clientCapabilities.terminal` are MANDATORY
   * on 2.21.2: omit either and the agent never answers.
   */
  initialize(): Promise<AcpInitializeResult> {
    return this.#request<AcpInitializeResult>(
      'initialize',
      {
        protocolVersion: 1,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
        },
        clientInfo: this.#clientInfo,
      },
      'initialize',
      this.#startupMs,
    );
  }

  newSession(opts: { cwd: string; mcpServers?: AcpMcpServer[] }): Promise<AcpNewSessionResult> {
    return this.#request<AcpNewSessionResult>(
      'session/new',
      { cwd: opts.cwd, mcpServers: opts.mcpServers ?? [] },
      'session/new',
      this.#startupMs,
    );
  }

  /** The agent advertises `agentCapabilities.loadSession:true`. */
  loadSession(
    sessionId: string,
    opts: { cwd?: string; mcpServers?: AcpMcpServer[] } = {},
  ): Promise<unknown> {
    return this.#request<unknown>(
      'session/load',
      { sessionId, cwd: opts.cwd ?? this.#cwd, mcpServers: opts.mcpServers ?? [] },
      'session/new',
      this.#startupMs,
    );
  }

  setModel(sessionId: string, modelId: string): Promise<unknown> {
    return this.#request<unknown>(
      'session/set_model',
      { sessionId, modelId },
      'session/set_model',
      this.#startupMs,
    );
  }

  /**
   * No deadline: the driver's wall/idle budgets own prompt duration. A prompt
   * that never returns is a driver timeout, not a transport one.
   */
  prompt(sessionId: string, text: string): Promise<AcpPromptResult> {
    return this.#request<AcpPromptResult>(
      'session/prompt',
      { sessionId, prompt: [{ type: 'text', text }] },
      'session/prompt',
      null,
    );
  }

  /** Cancellation is a notification, not a request — there is no response. */
  cancel(sessionId: string): void {
    this.#write({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId } });
  }

  // -------------------------------------------------------------------------
  // Handshake
  // -------------------------------------------------------------------------

  /**
   * initialize → session/new → (session/set_model). Returns a receipt proving
   * what the agent actually acknowledged. Throws BEFORE any prompt when a
   * requested agent or model was not honoured.
   */
  async handshake(opts: HandshakeOptions): Promise<HandshakeReceipt> {
    const mcpNotices: string[] = [];
    const watch = (n: AcpNotification): void => {
      if (MCP_NOTICE_METHODS.test(n.method)) mcpNotices.push(n.method);
    };
    const unwatch = this.#watchNotifications(watch);
    const t0 = Date.now();
    try {
      const initStart = Date.now();
      const init = await this.initialize();
      const initializeMs = Date.now() - initStart;

      const newStart = Date.now();
      const session = await this.newSession({ cwd: opts.cwd, mcpServers: opts.mcpServers });
      const newSessionMs = Date.now() - newStart;

      const currentModeId = session.modes?.currentModeId ?? null;
      const availableModes = session.modes?.availableModes ?? [];
      const currentModelId = session.models?.currentModelId ?? null;
      const availableModels = session.models?.availableModels ?? [];

      if (opts.agent && currentModeId !== opts.agent) {
        throw new KiroAcpError(
          'session/new',
          `requested agent '${opts.agent}' is not the session mode (current '${currentModeId ?? 'none'}'); available: ${availableModes.map((m) => m.id).join(', ') || 'none'}`,
          this.stderrTail(),
        );
      }

      const modelVerified = opts.model
        ? availableModels.some((m) => m.modelId === opts.model)
        : false;

      let modelAck: HandshakeReceipt['modelAck'] = 'not-requested';
      let setModelMs = 0;
      if (opts.model) {
        if (opts.requireModelAck && !modelVerified) {
          throw new KiroAcpError(
            'session/set_model',
            `model '${opts.model}' is not offered by this session; available: ${availableModels.map((m) => m.modelId).join(', ') || 'none'}`,
            this.stderrTail(),
          );
        }
        const setStart = Date.now();
        try {
          await this.setModel(session.sessionId, opts.model);
          modelAck = 'acknowledged';
        } catch (err) {
          if (opts.requireModelAck) throw err;
          modelAck = 'rejected';
        }
        setModelMs = Date.now() - setStart;
      }

      return {
        cliVersion: init.agentInfo?.version ?? null,
        sessionId: session.sessionId,
        currentModeId,
        availableModes,
        currentModelId,
        availableModels,
        modelAck,
        agentVerified: opts.agent !== undefined && currentModeId === opts.agent,
        modelVerified,
        mcpNotices,
        durationsMs: {
          initialize: initializeMs,
          newSession: newSessionMs,
          setModel: setModelMs,
          total: Date.now() - t0,
        },
      };
    } finally {
      unwatch();
    }
  }

  /**
   * Tee the notification stream without consuming it: the EventQueue has a
   * single consumer (the driver), so the handshake observes via a side channel
   * installed around `push`.
   */
  #watchNotifications(fn: (n: AcpNotification) => void): () => void {
    const queue = this.notifications as unknown as { push(...events: AcpNotification[]): void };
    const original = queue.push.bind(queue);
    queue.push = (...events: AcpNotification[]): void => {
      for (const e of events) fn(e);
      original(...events);
    };
    return () => {
      queue.push = original as typeof queue.push;
    };
  }
}
