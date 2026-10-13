// What a token counter includes, and whether anything is missing (#142), and
// which model actually ran versus which was requested (#140): one wording for
// every surface (ach run summary, dash, web, report, stats).
//
// Pure: no I/O. Returns undefined when the usage verdict makes no claim, so
// records written before these fields existed render exactly as before.
import type { UsageAvailability } from "./types.ts";

export interface UsageScopeBadge {
  /** 'complete' only when source coverage proved it; 'partial' otherwise. */
  status: "complete" | "partial";
  /** 'session' | 'parent-only' | 'child-inclusive' when established. */
  coverage?: NonNullable<UsageAvailability["tokens"]["coverage"]>;
  /** One-line text, e.g. `partial · parent-only (2 child sessions, 1 missing)`. */
  text: string;
  /** Why the counters are partial, in plain words (may be empty). */
  reasons: string[];
}

/**
 * The completeness/scope badge for a run's token counters, or undefined when
 * the verdict states nothing (tokens unavailable, or no `complete` claim).
 */
export function usageScopeBadge(usage: UsageAvailability | undefined): UsageScopeBadge | undefined {
  const t = usage?.tokens;
  if (t === undefined || t.available !== true || (t.complete === undefined && t.coverage === undefined)) return undefined;
  const status: UsageScopeBadge["status"] = t.complete === true ? "complete" : "partial";
  const children = t.childSessionIds?.length ?? 0;
  const missing = t.missingChildSessionIds?.length ?? 0;
  const detail =
    children > 0 ? ` (${children} child session${children === 1 ? "" : "s"}${missing > 0 ? `, ${missing} missing` : ""})` : "";
  const parts: string[] = [status];
  if (t.coverage !== undefined) parts.push(`${t.coverage}${detail}`);
  else if (status === "partial") parts.push("completeness not established");
  const reasons = [...(t.incompleteReasons ?? [])];
  return { status, ...(t.coverage !== undefined ? { coverage: t.coverage } : {}), text: parts.join(" · "), reasons };
}

/**
 * `observed gpt-x (requested gpt-y, MISMATCH)` / `requested gpt-y (unverified)`
 * / `unknown (no native record)`; undefined when the verdict has no model claim.
 */
export function modelProvenanceText(model: UsageAvailability["model"] | undefined): string | undefined {
  if (model === undefined) return undefined;
  const effort = (xs: string[] | undefined): string => (xs !== undefined && xs.length > 0 ? ` effort ${xs.join(", ")}` : "");
  if (model.observed !== undefined && model.observed.length > 0) {
    const req =
      model.requested !== undefined
        ? ` (requested ${model.requested}${model.requestedEffort !== undefined ? ` effort ${model.requestedEffort}` : ""}${model.mismatch || model.effortMismatch ? ", MISMATCH" : ""})`
        : " (no model requested)";
    return `observed ${model.observed.join(", ")}${effort(model.observedEffort)}${req}`;
  }
  if (model.requested !== undefined) {
    return `requested ${model.requested}${model.requestedEffort !== undefined ? ` effort ${model.requestedEffort}` : ""} (unverified: not observed)`;
  }
  return "unknown (not observed, none requested)";
}
