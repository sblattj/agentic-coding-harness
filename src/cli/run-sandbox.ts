// `ach run` sandbox flags (#13 gap 1) and the metrics-only evidence sidecar
// (#13 gap 3). Pure helpers; src/cli/ach.ts wires them into cmdRun.
//
// Sandbox flags build the SandboxPolicy that adapters already consume
// (src/core/types.ts SandboxPolicy; claudeSandboxArgs, codexSandboxArgs,
// geminiSandboxArgs, primeSandboxArgs, applySandboxToKiroSpec). Nothing here
// translates to CLI flags itself.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { countsAsTurn } from "../core/driver.ts";
import { HarnessError, type RunResult, type SandboxPolicy, SandboxPolicySchema } from "../core/types.ts";
import { describeSandbox } from "../core/sandbox-policy.ts";
import { VERSION } from "../version.ts";

/** Raw option values parseArgs hands over (all optional, tool lists repeatable). */
export interface SandboxFlagValues {
  "permission-mode"?: string;
  "allowed-tools"?: string[];
  "disallowed-tools"?: string[];
  "mcp-config"?: string[];
}

/**
 * Split a tool-list flag value on commas, but not inside parentheses, so a
 * claude tool pattern such as `Bash(git log:*)` or `Bash(a,b)` stays whole.
 * Whitespace around items is trimmed; empty items are dropped.
 */
export function splitToolList(value: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of value) {
    if (ch === "(") depth++;
    else if (ch === ")" && depth > 0) depth--;
    if (ch === "," && depth === 0) {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter((s) => s !== "");
}

function toolList(flag: string, values: string[] | undefined): string[] | undefined {
  if (values === undefined) return undefined;
  const items = values.flatMap(splitToolList);
  if (items.length === 0) throw new HarnessError(`${flag} needs at least one tool name`, "USAGE");
  return items;
}

/**
 * Flags → SandboxPolicy, or undefined when none of the four were given.
 * --allowed-tools / --disallowed-tools: repeatable AND comma-separated (the
 * occurrences concatenate in command-line order). --permission-mode: one
 * value, "ask"/"dontAsk" portable or any adapter-native spelling.
 * --mcp-config: one value; a leading `{` is parsed as inline JSON, anything
 * else is a file path passed verbatim.
 */
export function sandboxFromFlags(v: SandboxFlagValues): SandboxPolicy | undefined {
  const policy: SandboxPolicy = {};
  if (v["permission-mode"] !== undefined) {
    const mode = v["permission-mode"].trim();
    if (mode === "") throw new HarnessError("--permission-mode needs a value", "USAGE");
    policy.permissionMode = mode;
  }
  const allowed = toolList("--allowed-tools", v["allowed-tools"]);
  if (allowed) policy.allowedTools = allowed;
  const disallowed = toolList("--disallowed-tools", v["disallowed-tools"]);
  if (disallowed) policy.disallowedTools = disallowed;
  const mcp = v["mcp-config"];
  if (mcp !== undefined) {
    if (mcp.length > 1) throw new HarnessError("--mcp-config may be given once (merge servers into one file or JSON object)", "USAGE");
    const raw = mcp[0]!.trim();
    if (raw === "") throw new HarnessError("--mcp-config needs a file path or inline JSON", "USAGE");
    if (raw.startsWith("{")) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch (err) {
        throw new HarnessError(`--mcp-config looks like inline JSON but does not parse: ${(err as Error).message}`, "USAGE");
      }
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new HarnessError("--mcp-config inline JSON must be an object", "USAGE");
      }
      policy.mcpConfig = parsed as Record<string, unknown>;
    } else {
      policy.mcpConfig = raw;
    }
  }
  if (Object.keys(policy).length === 0) return undefined;
  return SandboxPolicySchema.parse(policy) as SandboxPolicy;
}

// The dropped-field table, warning text and redacted display form are shared with
// the matrix and MCP surfaces (src/core/sandbox-policy.ts); re-exported here so
// `ach run` callers and tests keep their import path.
export { describeSandbox, formatSandboxHeader, sandboxDroppedFields, sandboxDropWarnings } from "../core/sandbox-policy.ts";

// ------------------------------------------------------------ evidence sidecar

export interface RunMetrics {
  schema: "ach.metrics/1";
  achVersion: string;
  agent: string;
  model: string | null;
  runId: string;
  exitStatus: string;
  wallSeconds: number;
  turns: number;
  cost: { usd: number; provenance: string };
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; reasoning: number };
  sandbox: Record<string, unknown> | null;
  verify: string | null;
  startedAt: string;
  endedAt: string;
}

/**
 * Metrics-only summary of a settled run. Copies numbers and fixed vocabulary
 * only: no prompt, no event or message text, no tool inputs, no warnings, no
 * file contents. (model/agent are caller-supplied names, not model output.)
 */
export function buildRunMetrics(input: {
  agent: string;
  modelFlag?: string;
  result: RunResult;
  sandbox?: SandboxPolicy;
  verifyStatus?: string;
  endedAtMs?: number;
}): RunMetrics {
  const { result } = input;
  const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 };
  let lastModel: string | undefined;
  for (const t of result.tokens) {
    tokens.input += t.inputTokens;
    tokens.output += t.outputTokens;
    tokens.cacheRead += t.cacheReadTokens;
    tokens.cacheWrite += t.cacheWriteTokens;
    tokens.reasoning += t.reasoningTokens ?? 0;
    if (t.model) lastModel = t.model;
  }
  const endedAt = input.endedAtMs ?? Date.now();
  const u = result.usage;
  const provenance = u === undefined ? "unknown" : u.usd.available ? `usd:${u.usd.source ?? "unknown"}; tokens:${u.tokens.available ? (u.tokens.source ?? "unknown") : "unavailable"}` : `usd:unavailable; tokens:${u.tokens.available ? (u.tokens.source ?? "unknown") : "unavailable"}`;
  return {
    schema: "ach.metrics/1",
    achVersion: VERSION,
    agent: input.agent,
    model: input.modelFlag ?? lastModel ?? null,
    runId: result.runId,
    exitStatus: result.exitStatus,
    wallSeconds: Math.round(result.durationMs) / 1000,
    turns: result.events.filter((e) => e.type === "step" && countsAsTurn(input.agent, e)).length,
    cost: { usd: result.totalCost, provenance },
    tokens,
    sandbox: input.sandbox ? describeSandbox(input.sandbox) : null,
    verify: input.verifyStatus ?? null,
    startedAt: new Date(endedAt - result.durationMs).toISOString(),
    endedAt: new Date(endedAt).toISOString(),
  };
}

/** Write `<dir>/<file>` (creating dir); returns the path. */
export function writeMetricsSidecar(dir: string, metrics: RunMetrics, file = "metrics.json"): string {
  try {
    mkdirSync(dir, { recursive: true });
    const p = path.join(dir, file);
    writeFileSync(p, JSON.stringify(metrics, null, 2) + "\n");
    return p;
  } catch (err) {
    throw new HarnessError(`--evidence-dir: cannot write ${path.join(dir, file)}: ${(err as Error).message}`, "RUN_FAILED");
  }
}
