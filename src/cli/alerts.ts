// `ach run` threshold-alert flags (#20) -> RunBudget alert fields.
//
//   --budget-alerts F,F,..   fractions of --budget-usd   env AGENTIC_CODING_HARNESS_BUDGET_ALERTS
//                            default 0.5,0.8,1.0 when --budget-usd is set
//   --warn-at F,F,..         fractions of --max-turns / --wall-ms
//                            env AGENTIC_CODING_HARNESS_WARN_THRESHOLDS
//                            default 0.5,0.8,0.95 when either cap is set
//   --on-budget abort|warn   what exceeding --budget-usd does (default warn; abort is explicit opt-in)
//   AGENTIC_CODING_HARNESS_WARN_COOLDOWN_H   cooldown hours (default 24)
//
// CLI flags win over env; 'off' / 'none' disable a family.
import { HarnessError, type RunBudget } from "../core/types.ts";
import { cooldownMsFromEnv, parseThresholds } from "../core/budget-alerts.ts";

export const DEFAULT_BUDGET_ALERTS = [0.5, 0.8, 1];
export const DEFAULT_WARN_THRESHOLDS = [0.5, 0.8, 0.95];

function thresholdsWithEnv(
  flagVal: string | undefined,
  flag: string,
  envName: string,
  env: Record<string, string | undefined>,
): number[] | undefined {
  if (flagVal !== undefined) return parseThresholds(flagVal, flag);
  const envVal = env[envName];
  if (envVal === undefined || envVal === "") return undefined;
  return parseThresholds(envVal, envName);
}

export function alertFlagsToBudget(
  values: { "budget-alerts"?: string; "warn-at"?: string; "on-budget"?: string },
  caps: { usd?: number; maxTurns?: number; wallMs?: number },
  env: Record<string, string | undefined> = process.env,
): Pick<RunBudget, "alerts" | "warnAt" | "onExceed" | "alertCooldownMs"> {
  const out: Pick<RunBudget, "alerts" | "warnAt" | "onExceed" | "alertCooldownMs"> = {};

  const onBudget = values["on-budget"];
  if (onBudget !== undefined) {
    if (onBudget !== "abort" && onBudget !== "warn") {
      throw new HarnessError(`--on-budget expects abort|warn, got '${onBudget}'`, "USAGE");
    }
    out.onExceed = onBudget;
  }

  // Validate every value that was given, even when its cap is absent, so a
  // typo never hides until the day the cap is set.
  const alerts = thresholdsWithEnv(values["budget-alerts"], "--budget-alerts", "AGENTIC_CODING_HARNESS_BUDGET_ALERTS", env);
  const warnAt = thresholdsWithEnv(values["warn-at"], "--warn-at", "AGENTIC_CODING_HARNESS_WARN_THRESHOLDS", env);
  const cooldownMs = cooldownMsFromEnv(env);

  if (caps.usd !== undefined) {
    const a = alerts ?? DEFAULT_BUDGET_ALERTS;
    if (a.length > 0) out.alerts = a;
  }
  if (caps.maxTurns !== undefined || caps.wallMs !== undefined) {
    const w = warnAt ?? DEFAULT_WARN_THRESHOLDS;
    if (w.length > 0) out.warnAt = w;
  }
  if (out.alerts !== undefined || out.warnAt !== undefined) out.alertCooldownMs = cooldownMs;
  return out;
}
