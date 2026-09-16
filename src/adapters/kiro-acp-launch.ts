/**
 * Kiro ACP launch path: RunSpec -> AgentHandle over `kiro-cli acp`.
 *
 * Wiring only. The transport lives in `./kiro-acp.ts` (KiroAcpClient) and the
 * event vocabulary in `./kiro-events.ts` (createKiroNormalizer); this module
 * owns the ORDER of operations and the terminal-artifact contract:
 *
 *   spawn -> initialize -> session/new [-> session/set_model]
 *         -> [mcp gate] -> [session/load on resume] -> session/prompt -> close
 *
 * TERMINAL ARTIFACT RULE. `launch()` never throws for a protocol failure: the
 * driver must always receive a handle it can attach to and wait on. A failed
 * handshake yields exactly ONE `error` event naming the phase plus a stderr
 * tail, and `wait()` resolves `'error'`. A failure is therefore observable in
 * the run record, not only in a rejected promise.
 *
 * NO PROMPT BEFORE THE ACKS. `session/prompt` is sent only after the handshake
 * verified the requested agent/model and (when `requireMcpStartup`) after the
 * MCP notices came back clean. Tests assert this against the fake server's
 * stdin log, not against this comment.
 */

import { createHash } from 'node:crypto';
import type {
  AgentEvent as CoreAgentEvent,
  AgentHandle as CoreAgentHandle,
  KiroConfig,
  KiroEffective,
  RunSpec as CoreRunSpec,
} from '../core/types.js';
import {
  buildKiroAcpArgs,
  KiroAcpClient,
  KiroAcpError,
  type AcpMcpServer,
  type AcpNotification,
  type HandshakeReceipt,
  type OnPermissionFn,
} from './kiro-acp.ts';
import { createKiroNormalizer } from './kiro-events.ts';
import { EventQueue, houseEventToCore, launchDriverHandle, type SpawnFn } from './shared.ts';

export interface KiroAcpLaunchOptions {
  command?: string;
  spawnFn?: SpawnFn;
  /** Agent->client permission policy. Defaults to the client's deny-all. */
  onPermission?: OnPermissionFn;
}

/**
 * The handle the ACP path returns: the core contract plus the effective-config
 * evidence.
 *
 * NOTE FOR THE INTEGRATOR: the parallel `kiro-headless` seat introduces its own
 * carrier for `KiroEffective` (PLAN heading "Handle -> driver hand-off", which
 * does not exist at this commit). The two must be reconciled to ONE accessor
 * name before the driver reads it; `kiro()` here is deliberately optional so a
 * consumer can feature-detect it in the meantime.
 */
export interface KiroAcpHandle extends CoreAgentHandle {
  kiro(): KiroEffective | undefined;
}

/** ACP stop reasons that are NOT a failure of the run. */
const NON_ERROR_STOP_REASONS = new Set([
  'end_turn',
  'max_tokens',
  'max_turn_requests',
  'refusal',
]);

const MCP_FAILURE_METHOD = /^_kiro\.dev\/mcp\//;

const delay = (ms: number): Promise<void> =>
  new Promise((r) => {
    const t = setTimeout(r, ms);
    t.unref?.();
  });

function sha256(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function errorMessage(err: unknown): string {
  if (err instanceof KiroAcpError) {
    const tail = err.stderrTail.trim();
    return tail === '' ? err.message : `${err.message}\nstderr: ${tail}`;
  }
  return err instanceof Error ? err.message : String(err);
}

function phaseOf(err: unknown): string {
  return err instanceof KiroAcpError ? err.phase : 'unknown';
}

/**
 * Launch one Kiro run over ACP.
 *
 * `spec.extraArgs` is appended VERBATIM after the built flags — it is the
 * documented escape hatch, so it is never filtered here (the gateway does that
 * upstream, in tools-run.ts).
 */
export async function launchKiroAcp(
  spec: CoreRunSpec,
  opts: KiroAcpLaunchOptions,
): Promise<CoreAgentHandle> {
  const kiro: KiroConfig = spec.kiro ?? {};
  const args = [
    ...buildKiroAcpArgs({
      ...(kiro.agent !== undefined ? { agent: kiro.agent } : {}),
      ...(spec.model !== undefined ? { model: spec.model } : {}),
      ...(kiro.effort !== undefined ? { effort: kiro.effort } : {}),
      ...(kiro.tools !== undefined ? { tools: kiro.tools } : {}),
      ...(kiro.engine !== undefined ? { engine: kiro.engine } : {}),
    }),
    ...(spec.extraArgs ?? []),
  ];

  const client = new KiroAcpClient({
    ...(opts.command !== undefined ? { command: opts.command } : {}),
    args,
    ...(spec.cwd !== undefined ? { cwd: spec.cwd } : {}),
    ...(spec.env !== undefined ? { env: spec.env } : {}),
    ...(spec.sandbox?.scrubEnv !== undefined ? { scrubEnv: spec.sandbox.scrubEnv } : {}),
    ...(opts.spawnFn !== undefined ? { spawnFn: opts.spawnFn } : {}),
    ...(kiro.startupMs !== undefined ? { startupMs: kiro.startupMs } : {}),
    ...(opts.onPermission !== undefined ? { onPermission: opts.onPermission } : {}),
  });

  const normalizer = createKiroNormalizer({ transport: 'acp' });
  const queue = new EventQueue<CoreAgentEvent>();
  const mcpFailures: string[] = [];
  const allNotices: string[] = [];

  let resolveExit: (code: number) => void = () => {};
  const exit = new Promise<number>((resolve) => {
    resolveExit = resolve;
  });

  let aborted = false;
  let sessionId: string | undefined;
  let receipt: HandshakeReceipt | undefined;
  let effective: KiroEffective | undefined;

  const emit = (events: CoreAgentEvent[]): void => {
    for (const e of events) queue.push(e);
  };
  const emitHouse = (house: Parameters<typeof houseEventToCore>[1]): void => {
    const core = houseEventToCore('kiro', house);
    if (core) queue.push(core);
  };
  const emitNormalized = (msg: unknown): void => {
    const out: CoreAgentEvent[] = [];
    for (const house of normalizer.pushAcpMessage(msg)) {
      const core = houseEventToCore('kiro', house);
      if (!core) continue;
      // `houseEventToCore` REBUILDS `extra` from scratch on a usage event and
      // therefore drops `tokens.extra` — which is where kiro's credits and its
      // `tokensAvailable:false` honesty flag live (kiro-events.ts header,
      // "NOTE for wave 2"). Merge them back or the credits never reach the
      // registry. The `usage-truth` seat owns the permanent fix in shared.ts;
      // this merge is local and must be removed once that lands.
      if (house.type === 'usage' && core.type === 'usage') {
        const extra = (house as { tokens?: { extra?: Record<string, unknown> } }).tokens?.extra;
        if (extra) {
          const rec = core.usage as { extra?: Record<string, unknown> };
          rec.extra = { ...(rec.extra ?? {}), ...extra };
        }
      }
      out.push(core);
    }
    emit(out);
  };

  // Pump the transport's notification stream. It is a single-consumer queue,
  // so this is the ONLY consumer: everything the agent pushes is routed here.
  const pump = (async () => {
    for await (const n of client.notifications as AsyncIterable<AcpNotification>) {
      if (n.method === '__client_request') {
        // An agent->client request (permission / fs / terminal) and the answer
        // the transport policy gave it. Surfaced so a denial is auditable.
        const p = (n.params ?? {}) as Record<string, unknown>;
        emitHouse({
          type: 'step',
          payload: { kind: 'clientRequest', transport: 'acp', countsAsTurn: false, ...p },
        });
        continue;
      }
      allNotices.push(n.method);
      if (MCP_FAILURE_METHOD.test(n.method)) mcpFailures.push(n.method);
      emitNormalized(n);
    }
  })();

  void (async () => {
    let exitCode = 1;
    try {
      client.start();
      receipt = await client.handshake({
        cwd: spec.cwd ?? process.cwd(),
        mcpServers: (kiro.mcpServers ?? []) as unknown as AcpMcpServer[],
        ...(kiro.agent !== undefined ? { agent: kiro.agent } : {}),
        ...(spec.model !== undefined ? { model: spec.model } : {}),
        requireModelAck: kiro.requireModelAck ?? spec.model !== undefined,
      });
      sessionId = receipt.sessionId;
      // Feed the session id through the normalizer so its state and the
      // emitted `session` event agree with the handshake receipt.
      emitNormalized({ jsonrpc: '2.0', result: { sessionId: receipt.sessionId } });

      if (kiro.requireMcpStartup === true) {
        // The governance notice is pushed right after the session/new result,
        // so it can land a tick after the handshake resolves: give the pump one
        // bounded chance to see it before deciding.
        if (mcpFailures.length === 0) await delay(50);
        const failures = [
          ...new Set([...mcpFailures, ...receipt.mcpNotices.filter((m) => MCP_FAILURE_METHOD.test(m))]),
        ];
        if (failures.length > 0) {
          throw new KiroAcpError(
            'mcp',
            `requireMcpStartup: MCP failed to start (${failures.join(', ')}); no prompt was sent`,
            client.stderrTail(),
          );
        }
      }

      if (spec.resume !== undefined && spec.resume !== '') {
        try {
          await client.loadSession(spec.resume, { ...(spec.cwd !== undefined ? { cwd: spec.cwd } : {}) });
          sessionId = spec.resume;
        } catch (err) {
          // Not fatal: the handshake already created a fresh session, so the
          // run continues there with the failure recorded.
          emitHouse({
            type: 'progress',
            text: `[warn] kiro acp: session/load '${spec.resume}' failed (${errorMessage(err)}); continuing on the new session ${receipt.sessionId}`,
          });
          sessionId = receipt.sessionId;
        }
      }

      const result = await client.prompt(sessionId, spec.prompt);
      emitNormalized({ kind: 'promptResult', result });
      const stop = typeof result.stopReason === 'string' ? result.stopReason : '';
      exitCode = stop === '' || NON_ERROR_STOP_REASONS.has(stop) ? 0 : 1;
      if (stop === 'cancelled') aborted = true;
    } catch (err) {
      emitHouse({
        type: 'error',
        message: `kiro acp failed in phase '${phaseOf(err)}': ${errorMessage(err)}`,
      });
      exitCode = 1;
    } finally {
      effective = buildEffective({ kiro, spec, receipt, args, notices: allNotices, sessionId });
      await client.close();
      await pump;
      queue.close();
      resolveExit(exitCode);
    }
  })();

  const handle = (await launchDriverHandle<CoreAgentEvent>({
    agent: 'kiro',
    events: queue,
    mapEvent: (e) => e,
    exit,
    abort: () => {
      aborted = true;
      if (sessionId !== undefined) client.cancel(sessionId);
      void client.close();
    },
    isAborted: () => aborted,
    ...(spec.resume !== undefined ? { fallbackSessionId: spec.resume } : {}),
    sessionIdWaitMs: 0,
  })) as KiroAcpHandle;

  handle.kiro = (): KiroEffective | undefined => effective;
  return handle;
}

function buildEffective(input: {
  kiro: KiroConfig;
  spec: CoreRunSpec;
  receipt: HandshakeReceipt | undefined;
  args: string[];
  notices: string[];
  sessionId: string | undefined;
}): KiroEffective {
  const { kiro, spec, receipt, args } = input;
  const requested: KiroConfig = { ...kiro, transport: 'acp' };
  const effective = {
    argv: args,
    sessionId: input.sessionId ?? null,
    currentModeId: receipt?.currentModeId ?? null,
    currentModelId: receipt?.currentModelId ?? null,
    modelVerified: receipt?.modelVerified ?? false,
    agentVerified: receipt?.agentVerified ?? false,
    mcpNotices: [...new Set([...(receipt?.mcpNotices ?? []), ...input.notices])],
    ...(spec.model !== undefined ? { requestedModel: spec.model } : {}),
  };
  return {
    cliVersion: receipt?.cliVersion ?? 'unknown',
    transport: 'acp',
    requested,
    effective,
    ...(input.sessionId !== undefined ? { nativeSessionId: input.sessionId } : {}),
    modelAck: receipt?.modelAck ?? (spec.model === undefined ? 'not-requested' : 'rejected'),
    configHash: sha256({ requested, effective }),
  };
}
