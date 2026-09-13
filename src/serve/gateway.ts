// Gateway deployment profile (PLAN.md §D, seat W4): pure, dependency-light
// policy for running the MCP server behind an untrusted-client gateway.
// No I/O, no process globals — every function takes its config, so tests can
// exercise it without spawning a server.
//
// ── Integration note (src/cli/serve.ts, seat W3) ───────────────────────────
// serve.ts does not exist yet; wire it per PLAN.md §C/§D when it lands:
//
//   import { gatewayConfigFromFlags } from "../serve/gateway.ts";
//   const gateway = gatewayConfigFromFlags({
//     gateway: flags.gateway,
//     root: flags.root,
//     maxJobs: flags.maxJobs,
//     maxOutputBytes: flags.maxOutputBytes,
//     allowExtraArgs: flags.allowExtraArgs, // "pat1,pat2" or string[]
//   }, process.env);
//   if (gateway.enabled && !gateway.root) {
//     throw new HarnessError("--gateway requires --root (or AGENTIC_CODING_HARNESS_ROOT)", "USAGE", 2);
//   }
//   if (gateway.enabled && gateway.root) {
//     // The server's own cwd must be under root — startup-time check:
//     const own = checkCwd(gateway, process.cwd());
//     if (!own.ok) throw new HarnessError(own.error, "USAGE", 2);
//   }
//   registerRunTools(server, { stateDir, gateway });
//   registerInspectTools(server, { stateDir, gateway });
//   registerJobTools(server, { stateDir, gateway }); // seat W2: see below
//
// W2 (tools-jobs.ts) consumes two pieces from here:
//   - gatewayConfigFromFlags / GatewayConfig — same config object threaded
//     through registerJobTools opts as an optional `gateway?: GatewayConfig`.
//   - countLiveJobs(listRunRecords(stateDir)) — reject harness_run_async with
//     Error("max concurrent jobs reached") (→ JSON-RPC -32603) when
//     countLiveJobs >= gateway.maxJobs, gateway mode only.
// W2 also owns clamping harness_run_events output to gateway.maxOutputBytes;
// this module carries the limit, enforcement is the events tool's.
// ───────────────────────────────────────────────────────────────────────────
import path from "node:path";
import { effectiveStatus, type RunRecord } from "../core/registry.ts";

export interface GatewayConfig {
  enabled: boolean;
  /** Resolved absolute path. Required when enabled (checked by checkCwd /
   *  serve startup, which must throw a config error when absent). */
  root?: string;
  /** Max concurrently live async jobs. Default 4. */
  maxJobs: number;
  /** Optional clamp on job output size (bytes); enforced by the events tool. */
  maxOutputBytes?: number;
  /** Exact-match allowlist for run-tool extraArgs. */
  allowExtraArgs: string[];
}

/** CLI flag shape handed to gatewayConfigFromFlags; flags win over env. */
export interface GatewayFlags {
  gateway?: boolean;
  root?: string;
  maxJobs?: number;
  maxOutputBytes?: number;
  /** Comma-separated string (as from --allow-extra-args "a,b") or array. */
  allowExtraArgs?: string | string[];
}

export const DEFAULT_GATEWAY_MAX_JOBS = 4;

function parsePositiveInt(raw: string): number | undefined {
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function parseAllowExtraArgs(raw: string | string[] | undefined): string[] {
  if (raw === undefined) return [];
  const parts = Array.isArray(raw) ? raw : raw.split(",");
  return parts.map((s) => s.trim()).filter((s) => s.length > 0);
}

/** Build the gateway profile from serve flags + env mirrors. Flags win over
 *  env (an explicitly-passed boolean beats the env mirror; an absent flag
 *  defers to it). Env mirrors: AGENTIC_CODING_HARNESS_GATEWAY=1, AGENTIC_CODING_HARNESS_ROOT,
 *  AGENTIC_CODING_HARNESS_MAX_JOBS, AGENTIC_CODING_HARNESS_MAX_OUTPUT_BYTES,
 *  AGENTIC_CODING_HARNESS_ALLOW_EXTRA_ARGS (comma-separated). `env` defaults to
 *  process.env so pure callers can omit it. */
export function gatewayConfigFromFlags(
  flags: GatewayFlags,
  env: NodeJS.ProcessEnv = process.env,
): GatewayConfig {
  const enabled =
    flags.gateway !== undefined ? flags.gateway : env.AGENTIC_CODING_HARNESS_GATEWAY === "1";
  const rootRaw = flags.root ?? env.AGENTIC_CODING_HARNESS_ROOT;
  const maxJobs =
    flags.maxJobs ?? parsePositiveInt(env.AGENTIC_CODING_HARNESS_MAX_JOBS ?? "") ?? DEFAULT_GATEWAY_MAX_JOBS;
  const maxOutputBytes =
    flags.maxOutputBytes ??
    parsePositiveInt(env.AGENTIC_CODING_HARNESS_MAX_OUTPUT_BYTES ?? "");
  const allowExtraArgs = parseAllowExtraArgs(
    flags.allowExtraArgs ?? env.AGENTIC_CODING_HARNESS_ALLOW_EXTRA_ARGS,
  );
  return {
    enabled,
    ...(rootRaw !== undefined ? { root: path.resolve(rootRaw) } : {}),
    maxJobs,
    ...(maxOutputBytes !== undefined ? { maxOutputBytes } : {}),
    allowExtraArgs,
  };
}

/** True when `child` is `parent` itself or resolves under it, guarding the
 *  prefix against sibling dirs (/a/b must not match /a/bc). Both paths are
 *  expected already-resolved; paths are resolved by callers via path.resolve. */
function isUnder(child: string, parent: string): boolean {
  const p = parent.endsWith(path.sep) ? parent : parent + path.sep;
  return child === parent || child.startsWith(p);
}

/** cwd containment policy. Gateway off (or cfg undefined) → ok. On → root is
 *  required (config error, message names the config field); cwd undefined →
 *  ok (the server's own cwd must be under root — validated at serve startup,
 *  not here); cwd must resolve under root, else error naming the `cwd` field. */
export function checkCwd(
  cfg: GatewayConfig | undefined,
  cwd?: string,
): { ok: true } | { ok: false; error: string } {
  if (!cfg?.enabled) return { ok: true };
  if (cfg.root === undefined) {
    return {
      ok: false,
      error: "gateway root: required in gateway mode (pass --root or set AGENTIC_CODING_HARNESS_ROOT)",
    };
  }
  if (cwd === undefined) return { ok: true };
  const resolved = path.resolve(cwd);
  if (!isUnder(resolved, cfg.root)) {
    return {
      ok: false,
      error: `cwd: '${cwd}' must resolve under gateway root '${cfg.root}' (resolved '${resolved}')`,
    };
  }
  return { ok: true };
}

/** extraArgs policy. Gateway off (or cfg undefined) → everything allowed.
 *  On → split by exact string match against allowExtraArgs; stripped args are
 *  reported so callers surface them as a warning, never silently dropped. */
export function filterExtraArgs(
  cfg: GatewayConfig | undefined,
  args?: string[],
): { allowed: string[]; stripped: string[] } {
  if (!cfg?.enabled || args === undefined) {
    return { allowed: args === undefined ? [] : [...args], stripped: [] };
  }
  const allowedSet = new Set(cfg.allowExtraArgs);
  const allowed: string[] = [];
  const stripped: string[] = [];
  for (const arg of args) {
    (allowedSet.has(arg) ? allowed : stripped).push(arg);
  }
  return { allowed, stripped };
}

/** Artifact output policy (report out, emit out). Gateway off (or cfg
 *  undefined) → ok. p undefined → ok. Otherwise p must resolve under
 *  stateDir. (cfg is the trailing optional so the common two-arg form
 *  checkArtifactPath(stateDir, p) reads naturally.) */
export function checkArtifactPath(
  stateDir: string,
  p?: string,
  cfg?: GatewayConfig,
): { ok: true } | { ok: false; error: string } {
  if (!cfg?.enabled) return { ok: true };
  if (p === undefined) return { ok: true };
  const resolved = path.resolve(p);
  const root = path.resolve(stateDir);
  if (!isUnder(resolved, root)) {
    return {
      ok: false,
      error: `out: '${p}' must resolve under state dir '${root}' in gateway mode (resolved '${resolved}')`,
    };
  }
  return { ok: true };
}

/** Live-job count for the async-jobs concurrency cap: records whose
 *  effectiveStatus is 'running' (PLAN.md §A semantics — a running record
 *  with a dead pid/stale heartbeat counts as interrupted, not live). */
export function countLiveJobs(records: RunRecord[]): number {
  let live = 0;
  for (const rec of records) {
    if (effectiveStatus(rec) === "running") live++;
  }
  return live;
}
