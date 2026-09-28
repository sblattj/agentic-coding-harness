// `ach statusline` — a Claude Code `statusLine.command` (#61).
//
// Claude Code pipes a JSON session payload on stdin on every status refresh
// (documented at https://code.claude.com/docs/en/statusline; captured in
// tests/fixtures/claude-statusline/status-input.json). We read only:
//   session_id, model.id, model.display_name, cost.total_cost_usd,
//   workspace.current_dir (falling back to cwd)
// and print ONE line:
//   <model> · session $X · today $Y[ (+N unpriced)] · block $Z|n/a[ · budget $B left[ [NEAR LIMIT]|[OVER BUDGET]]]
//
// - session cost is Claude Code's own client-side estimate from stdin;
// - today / block / budget come from the shared status snapshot (status.ts),
//   read from a cache file when it is fresh so a refresh stays well inside
//   Claude Code's 300 ms debounce (no network, ever);
// - `--chain "<cmd>"` runs the user's existing statusline command with the
//   SAME stdin and prepends its output, so ach appends instead of replacing;
//   a failing / missing / slow chained command degrades to ach's segment.
// Malformed or empty stdin never throws: fields render as n/a and exit is 0.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { parseArgs } from "node:util";
import { HarnessError } from "../core/types.ts";
import { stateDir } from "../core/store.ts";
import { fmtUsd } from "./lib.ts";
import {
  StatusSnapshotSchema,
  budgetFromEnv,
  computeStatusSnapshot,
  currentBlockCost,
  deriveBudget,
  writeStateFile,
  type BlockCostProvider,
  type StatusSnapshot,
} from "./status.ts";

/** Claude Code's statusline refresh debounce (docs); our warm-cache render target. */
export const STATUSLINE_REFRESH_BUDGET_MS = 300;
export const DEFAULT_CACHE_MAX_AGE_MS = 30_000;
export const DEFAULT_CHAIN_TIMEOUT_MS = 1_500;
export const DEFAULT_SEPARATOR = " | ";
export const CACHE_BASENAME = "status-snapshot.json";

export interface ClaudeStatusInput {
  sessionId?: string;
  modelId?: string;
  modelName?: string;
  sessionCostUsd?: number;
  cwd?: string;
}

function obj(v: unknown): Record<string, unknown> | undefined {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}
const str = (v: unknown) => (typeof v === "string" && v !== "" ? v : undefined);

/** Tolerant parse of Claude Code's statusline stdin; unknown/malformed => {}. */
export function parseClaudeStatusInput(text: string): ClaudeStatusInput {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return {};
  }
  const root = obj(json);
  if (!root) return {};
  const out: ClaudeStatusInput = {};
  const sessionId = str(root.session_id);
  if (sessionId) out.sessionId = sessionId;
  const model = obj(root.model);
  const modelId = str(model?.id);
  if (modelId) out.modelId = modelId;
  const modelName = str(model?.display_name);
  if (modelName) out.modelName = modelName;
  const cost = obj(root.cost)?.total_cost_usd;
  if (typeof cost === "number" && Number.isFinite(cost)) out.sessionCostUsd = cost;
  const cwd = str(obj(root.workspace)?.current_dir) ?? str(root.cwd);
  if (cwd) out.cwd = cwd;
  return out;
}

export interface StatuslineOptions {
  stdinText: string;
  chain?: string;
  separator?: string;
  chainTimeoutMs?: number;
  /** Snapshot cache file; default <stateDir>/status-snapshot.json. */
  cachePath?: string;
  maxAgeMs?: number;
  noCache?: boolean;
  includeTranscripts?: boolean;
  budgetUsd?: number;
  blockCost?: BlockCostProvider;
}

export interface StatuslineResult {
  /** Full output without the trailing newline. */
  line: string;
  warnings: string[];
}

function signedUsd(n: number): string {
  return n < 0 ? `-${fmtUsd(-n)}` : fmtUsd(n);
}

function readFreshCache(file: string, maxAgeMs: number, includeTranscripts: boolean, now: number): StatusSnapshot | undefined {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
  let parsed;
  try {
    parsed = StatusSnapshotSchema.safeParse(JSON.parse(text));
  } catch {
    return undefined;
  }
  if (!parsed.success) return undefined;
  const age = now - Date.parse(parsed.data.generatedAt);
  if (!Number.isFinite(age) || age < 0 || age > maxAgeMs) return undefined;
  if (parsed.data.sources.includes("transcripts") !== includeTranscripts) return undefined;
  return parsed.data;
}

async function snapshotFor(o: StatuslineOptions, warnings: string[]): Promise<StatusSnapshot | undefined> {
  const includeTranscripts = o.includeTranscripts === true;
  const now = Date.now();
  const cache = o.cachePath ?? path.join(stateDir(), CACHE_BASENAME);
  if (!o.noCache) {
    const hit = readFreshCache(cache, o.maxAgeMs ?? DEFAULT_CACHE_MAX_AGE_MS, includeTranscripts, now);
    if (hit) return hit;
  }
  let snap: StatusSnapshot;
  try {
    snap = await computeStatusSnapshot({ now, includeTranscripts, ...(o.blockCost ? { blockCost: o.blockCost } : {}) });
  } catch (e) {
    warnings.push(`snapshot failed: ${e instanceof Error ? e.message : String(e)}`);
    return undefined;
  }
  if (!o.noCache) {
    try {
      writeStateFile(cache, snap);
    } catch (e) {
      warnings.push(`cache write failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return snap;
}

function runChain(cmd: string, input: string, timeoutMs: number, warnings: string[]): string | undefined {
  const r = spawnSync("/bin/sh", ["-c", cmd], { input, encoding: "utf8", timeout: timeoutMs });
  if (r.error || r.status !== 0) {
    const why = r.error ? r.error.message : r.signal ? `killed by ${r.signal}` : `exit ${r.status}`;
    const err = (r.stderr ?? "").trim().split("\n").pop() ?? "";
    warnings.push(`chained statusline failed (${why})${err ? `: ${err}` : ""}`);
    return undefined;
  }
  const out = (r.stdout ?? "").replace(/\s+$/, "");
  return out === "" ? undefined : out;
}

export async function renderStatusline(o: StatuslineOptions): Promise<StatuslineResult> {
  const warnings: string[] = [];
  const input = parseClaudeStatusInput(o.stdinText);
  const snap = await snapshotFor(o, warnings);

  let budgetUsd = o.budgetUsd;
  if (budgetUsd === undefined) {
    const env = budgetFromEnv();
    if (env.warning) warnings.push(env.warning);
    budgetUsd = env.usd;
  }

  const parts = [
    input.modelName ?? input.modelId ?? "n/a",
    `session ${input.sessionCostUsd === undefined ? "n/a" : fmtUsd(input.sessionCostUsd)}`,
    `today ${snap ? fmtUsd(snap.today.costUsd) + ((snap.today.unpricedRecords ?? 0) > 0 ? ` (+${snap.today.unpricedRecords} unpriced)` : "") : "n/a"}`,
    `block ${snap && snap.block.costUsd !== null ? fmtUsd(snap.block.costUsd) : "n/a"}`,
  ];
  // Budget is re-derived from the CURRENT env against the (possibly cached)
  // spend, so changing the budget takes effect on the next refresh.
  if (snap) {
    const b = deriveBudget(snap.today.costUsd, budgetUsd);
    if (b.configured) {
      const marker = b.state === "exceeded" ? " [OVER BUDGET]" : b.state === "near" ? " [NEAR LIMIT]" : "";
      parts.push(`budget ${signedUsd(b.remainingUsd)} left${marker}`);
    }
  }
  const segment = parts.join(" · ");

  let line = segment;
  if (o.chain !== undefined && o.chain.trim() !== "") {
    const chained = runChain(o.chain, o.stdinText, o.chainTimeoutMs ?? DEFAULT_CHAIN_TIMEOUT_MS, warnings);
    if (chained !== undefined) line = `${chained}${o.separator ?? DEFAULT_SEPARATOR}${segment}`;
  }
  return { line, warnings };
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(typeof c === "string" ? Buffer.from(c) : (c as Buffer));
  return Buffer.concat(chunks).toString("utf8");
}

function posInt(v: string | undefined, flag: string): number | undefined {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new HarnessError(`${flag} expects a positive integer, got '${v}'`, "USAGE");
  return n;
}

export async function cmdStatusline(rest: string[]): Promise<number> {
  const args = parseArgs({
    args: rest,
    options: {
      chain: { type: "string" },
      separator: { type: "string" },
      "chain-timeout-ms": { type: "string" },
      cache: { type: "string" },
      "max-age-ms": { type: "string" },
      "no-cache": { type: "boolean", default: false },
      transcripts: { type: "boolean", default: false },
    },
    allowPositionals: false,
  });
  const v = args.values;
  const chainTimeoutMs = posInt(v["chain-timeout-ms"], "--chain-timeout-ms");
  const maxAgeMs = posInt(v["max-age-ms"], "--max-age-ms");
  let stdinText = "";
  try {
    stdinText = await readStdin();
  } catch {
    stdinText = "";
  }
  const res = await renderStatusline({
    stdinText,
    ...(v.chain !== undefined ? { chain: v.chain } : {}),
    ...(v.separator !== undefined ? { separator: v.separator } : {}),
    ...(chainTimeoutMs !== undefined ? { chainTimeoutMs } : {}),
    ...(v.cache !== undefined ? { cachePath: v.cache } : {}),
    ...(maxAgeMs !== undefined ? { maxAgeMs } : {}),
    noCache: v["no-cache"],
    includeTranscripts: v.transcripts,
    // #18 seam: the open Claude 5h block over the snapshot records.
    blockCost: currentBlockCost,
  });
  for (const w of res.warnings) process.stderr.write(`ach statusline: ${w}\n`);
  process.stdout.write(res.line + "\n");
  return 0;
}
