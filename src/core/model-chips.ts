// Per-model cost chips (#67): the compact text dash prints for a multi-model
// run. The web UI mirrors the same data in src/web/index.html (plain JS, so
// the formatting is duplicated there with the full model name).
import type { RunRecord } from "./registry.ts";

type Chip = NonNullable<NonNullable<RunRecord["totals"]>["byModel"]>[number];

/** "claude-opus-5-20261001" -> "opus"; other models keep their id minus provider prefix and date. */
export function shortModelName(model: string): string {
  const m = model.trim().toLowerCase().replace(/^(?:[a-z0-9_-]+\/)+/, "").replace(/-(?:19|20)\d{6}$/, "");
  const fam = /^claude-(opus|sonnet|haiku)\b/.exec(m);
  return fam ? (fam[1] as string) : m;
}

/**
 * `opus $0.4000 + haiku $0.0200` for a run with a per-model breakdown; null
 * when there is none (single-model or no slices), so callers keep the plain
 * aggregate. An unpriced model prints `n/a`, never a number.
 */
export function modelChipsText(byModel: readonly Chip[] | undefined): string | null {
  if (!byModel || byModel.length < 2) return null;
  return byModel
    .map((c) => `${shortModelName(c.model)} ${c.costUsd === null ? "n/a" : `$${c.costUsd.toFixed(4)}`}`)
    .join(" + ");
}
