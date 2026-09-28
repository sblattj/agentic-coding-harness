// `ach stats` usage-window extras: 5h billing blocks (--blocks, #18), pace
// (#19) and plan framing (--plan, #36). The math lives in
// src/core/usage-windows.ts and src/core/plans.ts; this module only selects
// records, assembles the JSON fields, and renders text lines.
import { BLOCK_AGENTS, computeBlocks, computePace, type Pace, type UsageBlock, type UsageWindowRecord } from "../core/usage-windows.ts";
import { planUsage, type PlanPreset, type PlanUsage } from "../core/plans.ts";
import { fmtInt, fmtUsd } from "./lib.ts";

export const BLOCKS_NOTE =
  "note: 5h billing blocks are Claude-scoped (Anthropic subscription plans meter usage in rolling 5-hour windows; other vendors do not bill this way) — no claude records in range, nothing to group.";

export interface StatsExtrasInput {
  records: UsageWindowRecord[];
  now: number;
  /** --blocks: emit the block list. */
  blocks: boolean;
  plan?: PlanPreset;
  budgetUsd?: number;
  /** Spent against the budget: cost of the records in the stats scope. */
  spentUsd: number;
}

export interface StatsExtras {
  /** Additive keys for the stats JSON object. */
  json: Record<string, unknown>;
  /** Lines printed after the totals/agent/day rows. */
  text: string[];
  /** One indented line placed under the claude agent row (plan framing). */
  planLine?: string;
}

const hhmm = (isoTs: string): string => isoTs.slice(11, 16) + "Z";
const na = (v: number | null, f: (n: number) => string): string => (v === null ? "n/a" : f(v));
const rate = (n: number): string => `$${n.toFixed(4)}/h`;
const tpm = (n: number): string => `${n.toFixed(1)} tok/min`;
const pct = (n: number): string => `${n.toFixed(1)}%`;

function planCurrent(active: UsageBlock | null, plan: PlanPreset): (PlanUsage & { blockStart: string; blockEnd: string }) | null {
  if (!active) return null;
  return { ...planUsage(active, plan), blockStart: active.start, blockEnd: active.end };
}

export function formatPaceLine(p: Pace): string {
  const parts = (Object.entries(p.windows) as Array<[string, Pace["windows"]["1h"]]>).map(
    ([name, w]) => `${name}: ${na(w.usdPerHour, rate)} ${na(w.tokensPerMinute, tpm)}`,
  );
  if (p.budget === "exhausted") parts.push(`budget $${p.budgetUsd} exhausted`);
  else if (p.budget === "ok") {
    const eta = p.windows["1h"].etaBudgetHit ?? p.windows["15m"].etaBudgetHit;
    parts.push(`budget $${p.budgetUsd} hit at ${eta ?? "n/a (no current rate)"}`);
  }
  return `${"pace".padEnd(9)} ${parts.join("  ")}`;
}

function blockLine(b: UsageBlock, plan: PlanPreset | undefined): string {
  const unpriced = b.unpricedRecords > 0 ? ` (+${b.unpricedRecords} unpriced)` : "";
  let s = `  ${b.start.slice(0, 16)}Z → ${hhmm(b.end)}  records=${fmtInt(b.records)} tokens=${fmtInt(b.tokens)} cost=${fmtUsd(b.costUsd)}${unpriced}`;
  if (plan) {
    const u = planUsage(b, plan);
    s += `  plan ${pct(u.tokensPct)} tok ${pct(u.usdPct)} $`;
  }
  if (b.active && b.projection) {
    const p = b.projection;
    s += `  ACTIVE burn ${na(p.usdPerHour, rate)} ${na(p.tokensPerMinute, tpm)}  projected ${na(p.projectedCostUsd, fmtUsd)} / ${na(p.projectedTokens, fmtInt)} tok at ${hhmm(b.end)}`;
  }
  return s;
}

export function statsExtras(input: StatsExtrasInput): StatsExtras {
  const { records, now, plan, budgetUsd, spentUsd } = input;
  const pace = computePace(records, { now, ...(budgetUsd !== undefined ? { budgetUsd, spentUsd } : {}) });
  const json: Record<string, unknown> = { pace };
  const text: string[] = [formatPaceLine(pace)];

  const wantBlocks = input.blocks || plan !== undefined;
  if (!wantBlocks) return { json, text };

  const blocks = computeBlocks(records, { now });
  const hasClaude = records.some((r) => BLOCK_AGENTS.includes(r.agent));
  const active = blocks.find((b) => b.active) ?? null;

  if (input.blocks) {
    json.blocks = blocks;
    if (!hasClaude) {
      json.blocksNote = BLOCKS_NOTE;
      text.push(BLOCKS_NOTE);
    } else {
      text.push("blocks (claude 5h billing windows, UTC; projection = cost + ($/h since first event) x time left):");
      for (const b of blocks) text.push(blockLine(b, plan));
    }
  }

  let planLine: string | undefined;
  if (plan) {
    const current = planCurrent(active, plan);
    json.plan = { ...plan, current };
    const label = `plan ${plan.name}${plan.estimate ? ` (estimate, ${plan.source.split(" ")[0]} as of ${plan.asOf})` : ""}`;
    planLine = current
      ? `  ${label}: ${pct(current.tokensPct)} of plan window used (${fmtInt(current.windowTokensUsed)}/${fmtInt(plan.windowTokens)} in+out tok), ${pct(current.usdPct)} of $${plan.windowUsd.toFixed(2)}` +
        (current.messagesPct === null ? "" : `, ${pct(current.messagesPct)} of ${fmtInt(plan.windowMessages!)} msgs`) +
        ` [window ${hhmm(current.blockStart)}–${hhmm(current.blockEnd)}]`
      : `  ${label}: % of plan window used n/a (no active 5h window)`;
    if (!hasClaude && !input.blocks) text.push(BLOCKS_NOTE);
  }
  return { json, text, ...(planLine !== undefined ? { planLine } : {}) };
}
