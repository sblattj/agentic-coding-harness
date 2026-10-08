// Provider-reported subscription quota headroom (issue #17).
//
// Honesty contract: every number here is one the VENDOR reported. ach never
// estimates headroom from its own token math. An agent with no vendor source
// gets an explicit `n/a` row with a reason, and a window whose `resets_at`
// has passed since it was observed is also `n/a`, because the reported
// percentage belongs to a window that no longer exists.
//
// Sources, and the field path each parser reads:
//
//  codex  — Codex CLI rollouts, ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl.
//           Line: {"timestamp", "type":"event_msg", "payload":{"type":"token_count",
//           "rate_limits":{"primary":{used_percent, window_minutes, resets_at},
//           "secondary":{...}|null, "plan_type"}}}. resets_at is epoch SECONDS.
//           Observed on disk 2026-07..09 (7d-only and 5h+7d variants).
//           Override the dir with AGENTIC_CODING_HARNESS_QUOTA_CODEX_DIR.
//
//  claude — Claude Code's statusline stdin JSON: rate_limits.five_hour /
//           .seven_day / .spend_limit, each {used_percentage, resets_at}
//           (epoch seconds). Present only for claude.ai Pro/Max subscribers
//           (or behind a gateway spend limit) and only after the first API
//           response. `claude -p --output-format stream-json` does NOT carry
//           it, so ach cannot read it from a run: the statusline script pipes
//           its stdin into `ach quota ingest claude`, which snapshots it to
//           <stateDir>/quota/claude.json (override:
//           AGENTIC_CODING_HARNESS_QUOTA_CLAUDE_FILE).
//
//  gemini, opencode, kiro, prime — no vendor quota source is wired: n/a.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { stateDir } from "./store.ts";
import { AGENTS, type AgentName } from "./types.ts";

/** One quota row set per harness agent — kept in lockstep with core AGENTS. */
export const QUOTA_AGENTS = AGENTS;
export type QuotaAgent = AgentName;

export interface QuotaWindow {
  /** Short label: "5h", "7d", "spend", or `<N>m` for an unrecognized length. */
  name: string;
  /** Window length in minutes when the vendor states it (spend limits have none). */
  windowMinutes?: number;
  /** Vendor-reported percent of the window consumed (may exceed 100 for spend limits). */
  usedPercent: number;
  /** Epoch SECONDS when the window resets, as reported. */
  resetsAt?: number;
}

export interface QuotaSnapshot {
  agent: QuotaAgent;
  /** Where the numbers came from (file path or `statusline`). */
  source: string;
  /** Epoch ms when the vendor reported these numbers. */
  observedAt: number;
  plan?: string;
  windows: QuotaWindow[];
}

export interface QuotaRow {
  agent: string;
  available: boolean;
  window?: string;
  windowMinutes?: number;
  usedPercent?: number;
  leftPercent?: number;
  /** Epoch seconds. */
  resetsAt?: number;
  /** ms until the window resets, relative to the `now` the rows were built at. */
  resetsInMs?: number;
  observedAt?: number;
  plan?: string;
  source?: string;
  /** Why the row is n/a. */
  reason?: string;
}

const NO_SOURCE: Record<QuotaAgent, string> = {
  claude: "no snapshot — pipe the statusline JSON into `ach quota ingest claude`",
  codex: "no rate_limits in any Codex rollout",
  gemini: "no vendor quota source wired",
  opencode: "no vendor quota source wired",
  kiro: "no vendor quota source wired",
  prime: "no vendor quota source wired",
  "kiro-ide": "no vendor quota source wired",
  copilot: "no vendor quota source wired",
  null: "offline adapter; no vendor quota",
};

function windowName(minutes: number | undefined): string {
  if (minutes === 300) return "5h";
  if (minutes === 10080) return "7d";
  if (minutes === undefined) return "?";
  if (minutes % 1440 === 0) return `${minutes / 1440}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

// ---------------------------------------------------------------- codex

function codexWindow(v: unknown): QuotaWindow | undefined {
  if (!isObj(v)) return undefined;
  const used = num(v.used_percent);
  if (used === undefined) return undefined;
  const minutes = num(v.window_minutes);
  const resetsAt = num(v.resets_at);
  const w: QuotaWindow = { name: windowName(minutes), usedPercent: used };
  if (minutes !== undefined) w.windowMinutes = minutes;
  if (resetsAt !== undefined) w.resetsAt = resetsAt;
  return w;
}

/** Parse one rollout line; undefined unless it is a token_count carrying rate_limits windows. */
export function parseCodexRateLimits(line: string, source = "codex"): QuotaSnapshot | undefined {
  if (!line.includes('"rate_limits"')) return undefined;
  let ev: unknown;
  try {
    ev = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!isObj(ev) || !isObj(ev.payload)) return undefined;
  const p = ev.payload;
  if (p.type !== "token_count" || !isObj(p.rate_limits)) return undefined;
  const rl = p.rate_limits;
  const windows = [codexWindow(rl.primary), codexWindow(rl.secondary)].filter(
    (w): w is QuotaWindow => w !== undefined,
  );
  if (windows.length === 0) return undefined;
  const ts = typeof ev.timestamp === "string" ? Date.parse(ev.timestamp) : NaN;
  const snap: QuotaSnapshot = {
    agent: "codex",
    source,
    observedAt: Number.isFinite(ts) ? ts : 0,
    windows,
  };
  if (typeof rl.plan_type === "string") snap.plan = rl.plan_type;
  return snap;
}

async function listRollouts(dir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (d: string): Promise<void> => {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.isFile() && e.name.startsWith("rollout-") && e.name.endsWith(".jsonl")) out.push(p);
    }
  };
  await walk(dir);
  // rollout-YYYY-MM-DDTHH-MM-SS-<id>.jsonl: the basename sorts chronologically.
  return out.sort((a, b) => path.basename(b).localeCompare(path.basename(a)));
}

/** Cap on rollouts opened looking for a rate_limits line (newest first). */
const MAX_ROLLOUTS_SCANNED = 50;

/** Latest vendor-reported Codex rate limits: last observation in the newest rollout that has one. */
export async function readCodexQuota(sessionsDir: string): Promise<QuotaSnapshot | undefined> {
  const files = (await listRollouts(sessionsDir)).slice(0, MAX_ROLLOUTS_SCANNED);
  for (const file of files) {
    let text: string;
    try {
      text = await fs.readFile(file, "utf8");
    } catch {
      continue;
    }
    const lines = text.split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      const snap = parseCodexRateLimits(lines[i] ?? "", file);
      if (snap) return snap;
    }
  }
  return undefined;
}

// ---------------------------------------------------------------- claude

const CLAUDE_WINDOWS: Array<[key: string, name: string, minutes: number | undefined]> = [
  ["five_hour", "5h", 300],
  ["seven_day", "7d", 10080],
  ["spend_limit", "spend", undefined],
];

/** Parse Claude Code statusline stdin JSON; undefined when it carries no rate_limits windows. */
export function parseClaudeStatusline(json: unknown, capturedAt: number): QuotaSnapshot | undefined {
  if (!isObj(json) || !isObj(json.rate_limits)) return undefined;
  const rl = json.rate_limits;
  const windows: QuotaWindow[] = [];
  for (const [key, name, minutes] of CLAUDE_WINDOWS) {
    const w = rl[key];
    if (!isObj(w)) continue;
    const used = num(w.used_percentage);
    if (used === undefined) continue;
    const out: QuotaWindow = { name, usedPercent: used };
    if (minutes !== undefined) out.windowMinutes = minutes;
    const resetsAt = num(w.resets_at);
    if (resetsAt !== undefined) out.resetsAt = resetsAt;
    windows.push(out);
  }
  if (windows.length === 0) return undefined;
  return { agent: "claude", source: "statusline", observedAt: capturedAt, windows };
}

export function claudeSnapshotPath(stateDir: string): string {
  return process.env.AGENTIC_CODING_HARNESS_QUOTA_CLAUDE_FILE || path.join(stateDir, "quota", "claude.json");
}

export function codexSessionsDir(): string {
  return process.env.AGENTIC_CODING_HARNESS_QUOTA_CODEX_DIR || path.join(os.homedir(), ".codex", "sessions");
}

/** Atomic write (tmp + rename) so a concurrent `ach quota` never reads a torn file. */
export async function writeClaudeSnapshot(file: string, snap: QuotaSnapshot): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify({ v: 1, ...snap }) + "\n");
  await fs.rename(tmp, file);
}

export async function readClaudeSnapshot(file: string): Promise<QuotaSnapshot | undefined> {
  let raw: unknown;
  try {
    raw = JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    return undefined;
  }
  if (!isObj(raw) || raw.v !== 1 || raw.agent !== "claude" || !Array.isArray(raw.windows)) return undefined;
  const windows = raw.windows.filter(
    (w): w is QuotaWindow => isObj(w) && typeof w.name === "string" && num(w.usedPercent) !== undefined,
  );
  const snap: QuotaSnapshot = {
    agent: "claude",
    source: typeof raw.source === "string" ? raw.source : "statusline",
    observedAt: num(raw.observedAt) ?? 0,
    windows,
  };
  if (typeof raw.plan === "string") snap.plan = raw.plan;
  return snap;
}

// ---------------------------------------------------------------- rows

/** One row per window per agent; agents without a snapshot get one n/a row. */
export function quotaRows(snapshots: Partial<Record<QuotaAgent, QuotaSnapshot>>, now: number): QuotaRow[] {
  const rows: QuotaRow[] = [];
  for (const agent of QUOTA_AGENTS) {
    const snap = snapshots[agent];
    if (!snap || snap.windows.length === 0) {
      rows.push({ agent, available: false, reason: NO_SOURCE[agent] });
      continue;
    }
    for (const w of snap.windows) {
      const base: QuotaRow = { agent, available: true, window: w.name, observedAt: snap.observedAt, source: snap.source };
      if (w.windowMinutes !== undefined) base.windowMinutes = w.windowMinutes;
      if (snap.plan !== undefined) base.plan = snap.plan;
      if (w.resetsAt !== undefined) base.resetsAt = w.resetsAt;
      if (w.resetsAt !== undefined && w.resetsAt * 1000 <= now) {
        rows.push({
          ...base,
          available: false,
          reason: `window reset at ${new Date(w.resetsAt * 1000).toISOString()} since last observation`,
        });
        continue;
      }
      base.usedPercent = w.usedPercent;
      base.leftPercent = Math.max(0, 100 - w.usedPercent);
      if (w.resetsAt !== undefined) base.resetsInMs = w.resetsAt * 1000 - now;
      rows.push(base);
    }
  }
  return rows;
}

export interface CollectQuotaOptions {
  codexDir?: string;
  claudeFile?: string;
  stateDir?: string;
  now?: number;
}

/** Read every wired vendor source and build rows. Missing sources become n/a rows. */
export async function collectQuota(opts: CollectQuotaOptions = {}): Promise<QuotaRow[]> {
  const claudeFile = opts.claudeFile ?? claudeSnapshotPath(opts.stateDir ?? stateDir());
  const [claude, codex] = await Promise.all([
    readClaudeSnapshot(claudeFile),
    readCodexQuota(opts.codexDir ?? codexSessionsDir()),
  ]);
  const snaps: Partial<Record<QuotaAgent, QuotaSnapshot>> = {};
  if (claude) snaps.claude = claude;
  if (codex) snaps.codex = codex;
  return quotaRows(snaps, opts.now ?? Date.now());
}

// ---------------------------------------------------------------- render

function fmtPct(v: number | undefined): string {
  return v === undefined ? "n/a" : `${v.toFixed(1)}%`;
}

export function fmtDuration(ms: number | undefined): string {
  if (ms === undefined) return "n/a";
  const m = Math.max(0, Math.floor(ms / 60_000));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h${m % 60}m`;
  return `${Math.floor(h / 24)}d${h % 24}h`;
}

/**
 * Table: AGENT | WINDOW | USED | REMAINING | % LEFT | AS OF | SOURCE.
 * Vendors report percentages, not absolute allowances, so USED is % of the
 * window consumed and REMAINING is the time left until the window resets.
 */
export function renderQuotaTable(rows: QuotaRow[], now = Date.now()): string {
  const header = ["AGENT", "WINDOW", "USED", "REMAINING", "% LEFT", "AS OF", "SOURCE"];
  const body = rows.map((r) => [
    r.agent,
    r.window ?? "n/a",
    r.available ? fmtPct(r.usedPercent) : "n/a",
    r.available ? fmtDuration(r.resetsInMs) : "n/a",
    r.available ? fmtPct(r.leftPercent) : "n/a",
    r.observedAt === undefined || r.observedAt === 0 ? "n/a" : `${fmtDuration(now - r.observedAt)} ago`,
    r.available ? (r.source ?? "") : (r.reason ?? ""),
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...body.map((row) => (row[i] ?? "").length)));
  const fmt = (cells: string[]): string =>
    cells.map((c, i) => (i === cells.length - 1 ? c : c.padEnd(widths[i] ?? 0))).join("  ").trimEnd();
  return [fmt(header), ...body.map(fmt)].join("\n");
}

/** Dash cell: the tightest live window's % left, e.g. `98%/5h`; `n/a` without a vendor number. */
export function dashQuotaCell(rows: QuotaRow[], agent: string): string {
  let best: QuotaRow | undefined;
  for (const r of rows) {
    if (r.agent !== agent || !r.available || r.leftPercent === undefined) continue;
    if (best === undefined || r.leftPercent < (best.leftPercent ?? Infinity)) best = r;
  }
  if (!best || best.leftPercent === undefined) return "n/a";
  return `${Math.floor(best.leftPercent)}%/${best.window ?? "?"}`;
}

// ---------------------------------------------------------------- wait

export interface QuotaWaitOptions {
  agent: string;
  /** A live window at or above this used percent blocks (default 95). */
  maxUsed?: number;
  /** Only these window names count (e.g. ["5h"]); default every window. */
  windows?: string[];
}

export type QuotaWaitDecision =
  | { state: "ready"; reason: string }
  /** waitMs is the time until the last blocking window resets; undefined when a blocker has no resets_at. */
  | { state: "wait"; waitMs?: number; reason: string }
  | { state: "unknown"; reason: string };

/**
 * Should a job that spends this agent's quota start now? Uses only vendor rows:
 * ready when every counted live window is under `maxUsed` or has reset since it
 * was observed; wait (until the latest blocking reset) when one is at or over;
 * unknown when the agent has no vendor number at all.
 */
export function quotaWaitDecision(rows: QuotaRow[], opts: QuotaWaitOptions): QuotaWaitDecision {
  const maxUsed = opts.maxUsed ?? 95;
  const counted = rows.filter(
    (r) => r.agent === opts.agent && r.window !== undefined && (!opts.windows || opts.windows.includes(r.window)),
  );
  if (counted.length === 0) {
    const reason = rows.find((r) => r.agent === opts.agent && !r.available)?.reason;
    return { state: "unknown", reason: reason ?? `no vendor quota for ${opts.agent}` };
  }
  const blocking = counted.filter((r) => r.available && (r.usedPercent ?? 0) >= maxUsed);
  if (blocking.length === 0) {
    const live = counted.filter((r) => r.available);
    const parts = live.map((r) => `${r.window} ${fmtPct(r.usedPercent)} used`);
    const reset = counted.length - live.length;
    if (reset > 0) parts.push(`${reset} window(s) reset since last observation`);
    return { state: "ready", reason: `${opts.agent}: ${parts.join(", ")} (limit ${maxUsed}%)` };
  }
  const waits = blocking.map((r) => r.resetsInMs);
  const waitMs = waits.some((w) => w === undefined) ? undefined : Math.max(...(waits as number[]));
  const names = blocking.map((r) => `${r.window} ${fmtPct(r.usedPercent)} used`).join(", ");
  return {
    state: "wait",
    ...(waitMs === undefined ? {} : { waitMs }),
    reason: `${opts.agent}: ${names} (limit ${maxUsed}%), resets in ${fmtDuration(waitMs)}`,
  };
}
