/**
 * Kiro preflight: prove as much of a run's configuration as can be proven
 * WITHOUT spending a token.
 *
 * It runs `kiro-cli --version`, `kiro-cli whoami`, then a real ACP handshake
 * (initialize -> session/new -> session/set_model) and closes the session. It
 * NEVER sends `session/prompt` — the automated tests assert that against the
 * fake server's stdin log, which is the only evidence that cannot be faked by
 * this comment.
 *
 * HONESTY. Every check is one of `verified` / `failed` / `unproven`, and the
 * receipt always lists what a preflight structurally cannot prove (whether the
 * task will succeed, whether the tools the agent will reach for actually work).
 * A green preflight is a statement about configuration, never about outcome.
 */

import type { KiroConfig } from '../core/types.js';
import {
  buildKiroAcpArgs,
  KiroAcpClient,
  KiroAcpError,
  type AcpMcpServer,
  type AcpModel,
  type AcpMode,
  type HandshakeReceipt,
} from './kiro-acp.ts';
import { parseKiroCliVersion } from './kiro.ts';
import { defaultSpawnFn, LineAssembler, type SpawnFn } from './shared.ts';

export type PreflightCheckName =
  | 'executable'
  | 'version'
  | 'auth'
  | 'agent'
  | 'model'
  | 'modelAck'
  | 'mcp'
  | 'extraArgs';

export type PreflightStatus = 'verified' | 'failed' | 'unproven';

export interface PreflightCheck {
  name: PreflightCheckName;
  status: PreflightStatus;
  detail: string;
  ms: number;
}

export interface PreflightReceipt {
  ok: boolean;
  checks: PreflightCheck[];
  /** What this preflight structurally cannot prove. */
  unproven: string[];
  receipt: {
    cliVersion?: string;
    sessionId?: string;
    availableModes?: AcpMode[];
    availableModels?: AcpModel[];
    modelAck?: HandshakeReceipt['modelAck'];
  };
}

export interface KiroPreflightConfig {
  command?: string;
  spawnFn?: SpawnFn;
  cwd: string;
  kiro?: KiroConfig;
  model?: string;
  /** Gateway allowlist, when the caller runs in gateway mode. */
  gatewayAllowExtraArgs?: string[];
  extraArgs?: string[];
}

const ALWAYS_UNPROVEN = ['task success', 'downstream tool dependencies'];

/** Never let an account identifier out of the CLI into a receipt. */
export function maskIdentity(line: string): string {
  return line.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '***');
}

interface Captured {
  code: number | null;
  stdout: string;
  stderr: string;
}

function capture(
  spawnFn: SpawnFn,
  command: string,
  args: string[],
  cwd: string,
  timeoutMs = 30_000,
): Promise<Captured> {
  return new Promise<Captured>((resolve) => {
    let child;
    try {
      child = spawnFn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      resolve({ code: null, stdout: '', stderr: err instanceof Error ? err.message : String(err) });
      return;
    }
    let stdout = '';
    let stderr = '';
    const outLines = new LineAssembler();
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (c: string) => {
      for (const l of outLines.push(c)) stdout += `${l}\n`;
    });
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (c: string) => {
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
        child?.kill('SIGKILL');
      } catch {
        /* already gone */
      }
      done({ code: null, stdout, stderr: `${stderr}\ntimed out after ${timeoutMs}ms` });
    }, timeoutMs);
    timer.unref?.();
    child.once('error', (err: Error) => done({ code: null, stdout, stderr: `${stderr}${err.message}` }));
    child.once('close', (code: number | null) => {
      stdout += outLines.flush().map((l) => `${l}\n`).join('');
      done({ code, stdout, stderr });
    });
  });
}

/**
 * Run every provable check. Resolves a receipt; it does not throw on a failed
 * check — a failure IS the result.
 */
export async function kiroPreflight(cfg: KiroPreflightConfig): Promise<PreflightReceipt> {
  const command = cfg.command ?? process.env.KIRO_CLI_BIN ?? 'kiro-cli';
  const spawnFn = cfg.spawnFn ?? defaultSpawnFn;
  const kiro: KiroConfig = cfg.kiro ?? {};
  const checks: PreflightCheck[] = [];
  const receipt: PreflightReceipt['receipt'] = {};

  const timed = async <T>(
    name: PreflightCheckName,
    fn: () => Promise<{ status: PreflightStatus; detail: string; value?: T }>,
  ): Promise<{ status: PreflightStatus; detail: string; value?: T }> => {
    const t0 = Date.now();
    const r = await fn();
    checks.push({ name, status: r.status, detail: r.detail, ms: Date.now() - t0 });
    return r;
  };
  const record = (name: PreflightCheckName, status: PreflightStatus, detail: string, ms = 0): void => {
    checks.push({ name, status, detail, ms });
  };

  // --- executable + version (one spawn answers both) ------------------------
  const version = await timed('executable', async () => {
    const r = await capture(spawnFn, command, ['--version'], cfg.cwd);
    if (r.code !== 0) {
      return {
        status: 'failed' as const,
        detail: `'${command} --version' exited ${r.code ?? 'null'}: ${maskIdentity(r.stderr.trim().split('\n').slice(-1)[0] ?? '')}`,
      };
    }
    return { status: 'verified' as const, detail: `'${command}' is executable`, value: r.stdout.trim() };
  });

  if (version.status !== 'verified') {
    record('version', 'unproven', 'not attempted: the binary did not run');
    for (const n of ['auth', 'agent', 'model', 'modelAck', 'mcp'] as const) {
      record(n, 'unproven', 'not attempted: the binary did not run');
    }
    recordExtraArgs(cfg, record);
    return finish(checks, receipt);
  }

  const versionText = String(version.value ?? '');
  const parsed = parseKiroCliVersion(versionText);
  if (parsed) {
    receipt.cliVersion = parsed;
    record('version', 'verified', `kiro-cli ${parsed}`);
  } else {
    record('version', 'unproven', `could not parse a version out of '${versionText.slice(0, 80)}'`);
  }

  // --- auth -----------------------------------------------------------------
  await timed('auth', async () => {
    const r = await capture(spawnFn, command, ['whoami'], cfg.cwd);
    const firstLine = maskIdentity((r.stdout.trim().split('\n')[0] ?? '').slice(0, 200));
    if (r.code === 0 && r.stdout.trim() !== '') {
      return { status: 'verified' as const, detail: `whoami ok: ${firstLine}` };
    }
    return {
      status: 'failed' as const,
      detail: `'${command} whoami' exited ${r.code ?? 'null'}${firstLine ? ` (${firstLine})` : ''}`,
    };
  });

  // --- handshake (no prompt) ------------------------------------------------
  const args = buildKiroAcpArgs({
    ...(kiro.agent !== undefined ? { agent: kiro.agent } : {}),
    ...(cfg.model !== undefined ? { model: cfg.model } : {}),
    ...(kiro.effort !== undefined ? { effort: kiro.effort } : {}),
    ...(kiro.tools !== undefined ? { tools: kiro.tools } : {}),
    ...(kiro.engine !== undefined ? { engine: kiro.engine } : {}),
  });
  const client = new KiroAcpClient({
    command,
    args: [...args, ...(cfg.extraArgs ?? [])],
    cwd: cfg.cwd,
    spawnFn,
    ...(kiro.startupMs !== undefined ? { startupMs: kiro.startupMs } : {}),
  });
  // Drain notifications so the queue never back-pressures the transport.
  const notices: string[] = [];
  const drained = (async () => {
    for await (const n of client.notifications) notices.push(n.method);
  })();

  const t0 = Date.now();
  let hs: HandshakeReceipt | undefined;
  let hsError: unknown;
  try {
    client.start();
    hs = await client.handshake({
      cwd: cfg.cwd,
      mcpServers: (kiro.mcpServers ?? []) as unknown as AcpMcpServer[],
      ...(kiro.agent !== undefined ? { agent: kiro.agent } : {}),
      ...(cfg.model !== undefined ? { model: cfg.model } : {}),
      requireModelAck: kiro.requireModelAck ?? cfg.model !== undefined,
    });
  } catch (err) {
    hsError = err;
  } finally {
    await client.close();
    await drained;
  }
  const hsMs = Date.now() - t0;

  if (hs) {
    receipt.sessionId = hs.sessionId;
    receipt.availableModes = hs.availableModes;
    receipt.availableModels = hs.availableModels;
    receipt.modelAck = hs.modelAck;
    if (hs.cliVersion) receipt.cliVersion = hs.cliVersion;

    record(
      'agent',
      kiro.agent === undefined ? 'unproven' : hs.agentVerified ? 'verified' : 'failed',
      kiro.agent === undefined
        ? `no native agent requested; session mode is '${hs.currentModeId ?? 'none'}'`
        : `requested agent '${kiro.agent}' vs session mode '${hs.currentModeId ?? 'none'}'`,
      hsMs,
    );
    record(
      'model',
      cfg.model === undefined ? 'unproven' : hs.modelVerified ? 'verified' : 'failed',
      cfg.model === undefined
        ? `no model requested; ${hs.availableModels.length} offered`
        : `'${cfg.model}' ${hs.modelVerified ? 'is' : 'is NOT'} in availableModels [${hs.availableModels.map((x) => x.modelId).join(', ')}]`,
    );
    record(
      'modelAck',
      hs.modelAck === 'acknowledged' ? 'verified' : hs.modelAck === 'not-requested' ? 'unproven' : 'failed',
      `session/set_model: ${hs.modelAck}`,
    );
  } else {
    const phase = hsError instanceof KiroAcpError ? hsError.phase : 'unknown';
    const detail = `handshake failed in phase '${phase}': ${hsError instanceof Error ? maskIdentity(hsError.message) : String(hsError)}`;
    record('agent', phase === 'session/new' && kiro.agent !== undefined ? 'failed' : 'unproven', detail, hsMs);
    record('model', phase === 'session/set_model' && cfg.model !== undefined ? 'failed' : 'unproven', detail);
    record('modelAck', phase === 'session/set_model' ? 'failed' : 'unproven', detail);
  }

  // --- mcp ------------------------------------------------------------------
  const mcpFailures = [
    ...new Set([...(hs?.mcpNotices ?? []), ...notices].filter((x) => /^_kiro\.dev\/mcp\//.test(x))),
  ];
  // MEASURED, and it contradicts the naive reading: the REAL recorded 2.21.2
  // handshake (tests/fixtures/kiro/acp-prompt-2.21.2.jsonl:7) emits
  // `_kiro.dev/mcp/governance_disabled {apiFailure:true}` on a session that
  // then ran fine with zero MCP servers configured. So the notice alone is NOT
  // proof that MCP failed to start — it only gates the run when the caller
  // asserted MCP matters (`requireMcpStartup`, or servers actually forwarded).
  const mcpGates = kiro.requireMcpStartup === true || (kiro.mcpServers ?? []).length > 0;
  if (mcpFailures.length > 0 && mcpGates) {
    record('mcp', 'failed', `MCP failure notices: ${mcpFailures.join(', ')}`);
  } else if (mcpFailures.length > 0) {
    record(
      'mcp',
      'unproven',
      `notice(s) ${mcpFailures.join(', ')} observed; no MCP servers were requested and requireMcpStartup is off, so nothing was gated`,
    );
  } else if ((kiro.mcpServers ?? []).length > 0) {
    record(
      'mcp',
      'unproven',
      `${(kiro.mcpServers ?? []).length} MCP server(s) forwarded; no failure notice seen, but startup is not observable without a prompt`,
    );
  } else {
    record('mcp', 'verified', 'no MCP servers requested');
  }

  recordExtraArgs(cfg, record);
  return finish(checks, receipt);
}

function recordExtraArgs(
  cfg: KiroPreflightConfig,
  record: (name: PreflightCheckName, status: PreflightStatus, detail: string, ms?: number) => void,
): void {
  const extra = cfg.extraArgs ?? [];
  if (extra.length === 0) {
    record('extraArgs', 'verified', 'no extraArgs requested');
    return;
  }
  if (cfg.gatewayAllowExtraArgs === undefined) {
    record('extraArgs', 'unproven', `no gateway allowlist; ${extra.length} arg(s) forwarded verbatim`);
    return;
  }
  const allowed = new Set(cfg.gatewayAllowExtraArgs);
  const rejected = extra.filter((a) => !allowed.has(a));
  if (rejected.length === 0) record('extraArgs', 'verified', `all ${extra.length} arg(s) on the gateway allowlist`);
  else record('extraArgs', 'failed', `not on the gateway allowlist: ${rejected.map((r) => `'${r}'`).join(', ')}`);
}

function finish(checks: PreflightCheck[], receipt: PreflightReceipt['receipt']): PreflightReceipt {
  const unproven = [
    ...ALWAYS_UNPROVEN,
    ...checks.filter((c) => c.status === 'unproven').map((c) => `${c.name}: ${c.detail}`),
  ];
  return { ok: checks.every((c) => c.status !== 'failed'), checks, unproven, receipt };
}
