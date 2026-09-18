// Trial-directory loader for `harness report`.
//
// A trial directory holds one `<agent>.json` RunResult per agent plus optional
// `<agent>.secs` (wall-clock seconds) and `<agent>.stderr` (event stream).
// `harness report trials/20260910-091011` reports a single trial;
// `harness report trials/` scans every subdirectory that looks like a trial.
import fs from "node:fs/promises";
import path from "node:path";
import {
  HarnessError,
  UsageAvailabilitySchema,
  type AgentEvent,
  type RunResult,
  type UsageAvailability,
} from "../core/types.ts";

/** Tolerant RunResult view: `harness run --json` writes the full envelope, but
 * hand-trimmed fixtures may omit numeric/cost fields. Everything except
 * sessionId+events defaults at load time. */
export interface LoadedRun {
  /** Agent name: the `.json` basename, or result.agent when set. */
  agent: string;
  /** Trial directory this run came from (absolute). */
  trialDir: string;
  /** Trial label for grouping/headers: basename of the trial directory. */
  trialLabel: string;
  result: RunResult;
  /** Wall-clock seconds from `<agent>.secs`, when present. */
  wallSecs: number | null;
  hasStderr: boolean;

  // ---- derived views (computed once at load) ----
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  /** Sum of per-token-record costUsd when any record defines one; else
   * result.totalCost when defined; else undefined (rendered 'n/a'). */
  costUsd: number | undefined;
  /** Sum of tokens[].extra.credits (kiro metering) when any record has one. */
  credits: number | null;
  /** The run's prompt/task text when recoverable from the event stream. */
  task: string | null;
  /** RunSpec.variant echoed on the result (spec §6.3); absent on legacy runs. */
  variant?: string;
  /** RunResult.usage when the artifact carries one (absent on older runs). */
  usage?: UsageAvailability;
  /** True when the run states its token counts are unknowable (render n/a). */
  tokensUnavailable?: boolean;
  /** True when the run states no USD price is derivable (render n/a). */
  usdUnavailable?: boolean;
}

export interface TrialSet {
  /** Absolute directory the report was generated from (first positional). */
  rootDir: string;
  /** Trial labels (subdirectory basenames, or the dir basename for a single
   * trial), sorted. */
  labels: string[];
  runs: LoadedRun[];
}

/** A JSON file qualifies as a RunResult artifact when it has an `events`
 * array and at least one of `tokens` / `exitStatus` / `durationMs`. */
export function looksLikeRunResult(v: unknown): v is RunResult {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const o = v as Record<string, unknown>;
  return Array.isArray(o.events) && ("tokens" in o || "exitStatus" in o || "durationMs" in o);
}

function toNum(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

function toNumOrUndefined(v: unknown): number | undefined {
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

/** Extract a printable task/prompt: first event's `prompt` field, else the
 * first user message content, else null (caller renders a generic label). */
function extractTask(events: AgentEvent[]): string | null {
  for (const e of events) {
    const prompt = (e as { prompt?: unknown }).prompt;
    if (typeof prompt === "string" && prompt.trim()) return prompt.trim();
  }
  for (const e of events) {
    if (e.type === "message" && (e.source === "user" || (e as { role?: unknown }).role === "user")) {
      const c = typeof e.content === "string" ? e.content : "";
      if (c.trim()) return c.trim();
    }
  }
  return null;
}

/** Normalize one parsed RunResult JSON into the report view. */
export function toLoadedRun(
  agent: string,
  result: RunResult,
  trialDir: string,
  trialLabel: string,
  wallSecs: number | null,
  hasStderr: boolean,
): LoadedRun {
  const tokens = Array.isArray(result.tokens) ? result.tokens : [];
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let reasoning = 0;
  let costSum: number | undefined;
  let hasCost = false;
  let credits: number | null = null;
  let model: string | null = null;
  for (const t of tokens) {
    input += toNum(t.inputTokens);
    output += toNum(t.outputTokens);
    cacheRead += toNum(t.cacheReadTokens);
    cacheWrite += toNum(t.cacheWriteTokens);
    reasoning += toNum(t.reasoningTokens);
    if (typeof t.model === "string" && t.model !== "" && t.model !== "unknown") model = t.model;
    const c = toNumOrUndefined(t.costUsd);
    if (c !== undefined) {
      costSum = (costSum ?? 0) + c;
      hasCost = true;
    }
    const ex = (t.extra ?? {}) as Record<string, unknown>;
    const cr = toNumOrUndefined(ex.credits);
    if (cr !== undefined) credits = (credits ?? 0) + cr;
  }
  const totalCost = toNumOrUndefined(result.totalCost);
  // Truthful usage: parse defensively — a hand-trimmed fixture may carry a
  // partial `usage`, and an artifact written before this landed carries none.
  // `undefined` means "no claim", which renders exactly as it always did.
  const parsedUsage = UsageAvailabilitySchema.safeParse((result as { usage?: unknown }).usage);
  const usage = parsedUsage.success ? (parsedUsage.data as UsageAvailability) : undefined;
  const tokensUnavailable = usage?.tokens.available === false;
  const usdUnavailable = usage?.usd.available === false;
  const costUsd = usdUnavailable ? undefined : hasCost ? (costSum as number) : totalCost;
  const events = Array.isArray(result.events) ? result.events : [];
  return {
    agent: typeof result.agent === "string" && result.agent ? result.agent : agent,
    trialDir,
    trialLabel,
    result: { ...result, tokens, events },
    wallSecs,
    hasStderr,
    model,
    inputTokens: input,
    outputTokens: output,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
    reasoningTokens: reasoning,
    costUsd,
    credits,
    task: extractTask(events),
    ...(typeof result.variant === "string" && result.variant !== "" ? { variant: result.variant } : {}),
    ...(usage !== undefined ? { usage } : {}),
    tokensUnavailable,
    usdUnavailable,
  };
}

async function readJson(file: string): Promise<unknown | null> {
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch {
    return null;
  }
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** Load one trial directory: every `<name>.json` that parses as a RunResult. */
export async function loadTrialDir(dir: string): Promise<LoadedRun[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => {
    throw new HarnessError(`cannot read trials directory '${dir}'`, "IO");
  });
  const label = path.basename(path.resolve(dir));
  const runs: LoadedRun[] = [];
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!e.isFile() || !e.name.endsWith(".json")) continue;
    const parsed = await readJson(path.join(dir, e.name));
    if (!looksLikeRunResult(parsed)) continue;
    const name = e.name.slice(0, -".json".length);
    const secsRaw = await fs
      .readFile(path.join(dir, `${name}.secs`), "utf8")
      .catch(() => null);
    const wallSecs = secsRaw === null ? null : (toNumOrUndefined(secsRaw.trim()) ?? null);
    let hasStderr = false;
    try {
      await fs.access(path.join(dir, `${name}.stderr`));
      hasStderr = true;
    } catch {
      hasStderr = false;
    }
    runs.push(toLoadedRun(name, parsed, dir, label, wallSecs, hasStderr));
  }
  return runs;
}

async function hasRunResults(dir: string): Promise<boolean> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isFile() || !e.name.endsWith(".json")) continue;
      const parsed = await readJson(path.join(dir, e.name));
      if (looksLikeRunResult(parsed)) return true;
    }
  } catch {
    return false;
  }
  return false;
}

/**
 * Resolve one positional argument into trial runs: the directory itself when
 * it contains RunResult JSON files, else every subdirectory that does.
 */
export async function loadTrials(root: string): Promise<TrialSet> {
  const abs = path.resolve(root);
  const stat = await fs.stat(abs).catch(() => {
    throw new HarnessError(`trials directory '${root}' does not exist`, "IO");
  });
  if (!stat.isDirectory()) {
    throw new HarnessError(`'${root}' is not a directory`, "IO");
  }
  const runs: LoadedRun[] = [];
  if (await hasRunResults(abs)) {
    runs.push(...(await loadTrialDir(abs)));
  } else {
    const entries = (await fs.readdir(abs, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      runs.push(...(await loadTrialDir(path.join(abs, e.name))));
    }
  }
  if (runs.length === 0) {
    throw new HarnessError(`no RunResult JSON files found under '${root}'`, "IO");
  }
  const labels = [...new Set(runs.map((r) => r.trialLabel))].sort();
  return { rootDir: abs, labels, runs };
}
