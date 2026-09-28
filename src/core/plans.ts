// Subscription plan presets (#36): frame usage as "% of my plan window".
//
// Anthropic does not publish per-window token/$/message allowances for its
// Claude plans. The built-in numbers are COMMUNITY ESTIMATES copied verbatim
// from Claude-Code-Usage-Monitor's PLAN_LIMITS (which labels them
// confidence="local_estimate"); every row carries `source` + `asOf` and
// `estimate: true`, and the rendering says "estimate". For real limits use
// `--plan custom --plan-window-tokens N --plan-window-usd N`.
//
// The pinned-table test (tests/usage-windows.test.ts) makes every change here
// a deliberate diff.
import { HarnessError } from "./types.ts";
import type { UsageBlock } from "./usage-windows.ts";

export interface PlanPreset {
  name: string;
  displayName: string;
  /** Tokens allowed per 5h window, counted as input + output (cache excluded). */
  windowTokens: number;
  /** $ (API-equivalent cost) allowed per 5h window. */
  windowUsd: number;
  /** Messages allowed per 5h window; undefined when not configured. */
  windowMessages?: number;
  /** Where the numbers come from. */
  source: string;
  /** Date (YYYY-MM-DD) the numbers were checked against the source. */
  asOf: string;
  /** true for built-in community numbers; false for user-supplied custom. */
  estimate: boolean;
}

const MONITOR_SOURCE =
  "Claude-Code-Usage-Monitor src/claude_monitor/core/plans.py PLAN_LIMITS @3357236 (confidence=local_estimate; Anthropic publishes no per-window numbers)";
const AS_OF = "2026-09-27";

export const PLAN_PRESETS: Readonly<Record<"pro" | "max5" | "max20", PlanPreset>> = {
  pro: {
    name: "pro",
    displayName: "Claude Pro",
    windowTokens: 19_000,
    windowUsd: 18,
    windowMessages: 250,
    source: MONITOR_SOURCE,
    asOf: AS_OF,
    estimate: true,
  },
  max5: {
    name: "max5",
    displayName: "Claude Max 5x",
    windowTokens: 88_000,
    windowUsd: 35,
    windowMessages: 1_000,
    source: MONITOR_SOURCE,
    asOf: AS_OF,
    estimate: true,
  },
  max20: {
    name: "max20",
    displayName: "Claude Max 20x",
    windowTokens: 220_000,
    windowUsd: 140,
    windowMessages: 2_000,
    source: MONITOR_SOURCE,
    asOf: AS_OF,
    estimate: true,
  },
};

export const PLAN_NAMES: readonly string[] = [...Object.keys(PLAN_PRESETS), "custom"];

export interface CustomAllowance {
  windowTokens?: number;
  windowUsd?: number;
  windowMessages?: number;
}

/**
 * Resolve a plan name. undefined → undefined (no framing). Unknown names fail
 * loud with the valid list (no fuzzy match). `custom` requires explicit
 * --plan-window-tokens and --plan-window-usd, and the error names exactly the
 * missing ones.
 */
export function resolvePlan(name: string | undefined, custom: CustomAllowance): PlanPreset | undefined {
  if (name === undefined || name === "") return undefined;
  if (name === "custom") {
    const missing: string[] = [];
    if (custom.windowTokens === undefined) missing.push("--plan-window-tokens");
    if (custom.windowUsd === undefined) missing.push("--plan-window-usd");
    if (missing.length > 0) {
      throw new HarnessError(`--plan custom requires ${missing.join(", ")} (nothing is guessed)`, "USAGE");
    }
    return {
      name: "custom",
      displayName: "custom",
      windowTokens: custom.windowTokens!,
      windowUsd: custom.windowUsd!,
      ...(custom.windowMessages !== undefined ? { windowMessages: custom.windowMessages } : {}),
      source: "user-supplied (--plan-window-* flags / env)",
      asOf: new Date().toISOString().slice(0, 10),
      estimate: false,
    };
  }
  const preset = (PLAN_PRESETS as Record<string, PlanPreset>)[name];
  if (!preset) {
    throw new HarnessError(`unknown plan '${name}' (valid: ${PLAN_NAMES.join(", ")})`, "USAGE");
  }
  return preset;
}

export interface PlanUsage {
  plan: string;
  estimate: boolean;
  /** input + output tokens in the window (the basis the allowance is expressed in). */
  windowTokensUsed: number;
  tokensPct: number;
  usdPct: number;
  /** null when the plan has no message allowance. */
  messagesPct: number | null;
}

const pct = (used: number, limit: number): number => Math.round((used / limit) * 100 * 1e4) / 1e4;

/** Frame one 5h block as a percentage of the plan's window allowance. */
export function planUsage(block: UsageBlock, plan: PlanPreset): PlanUsage {
  const used = block.inputTokens + block.outputTokens;
  return {
    plan: plan.name,
    estimate: plan.estimate,
    windowTokensUsed: used,
    tokensPct: pct(used, plan.windowTokens),
    usdPct: pct(block.costUsd, plan.windowUsd),
    messagesPct: plan.windowMessages === undefined ? null : pct(block.records, plan.windowMessages),
  };
}
