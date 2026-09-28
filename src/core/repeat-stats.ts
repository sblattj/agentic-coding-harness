// Repeat-run statistics (#30): pure, dependency-free math over k scored
// repeats of the same cell (same experiment×variant, or same --repeat group).
//
//   pass@1       c / n — the unbiased per-attempt pass rate.
//   pass^k       C(c, k) / C(n, k) — probability that k draws WITHOUT
//                replacement ALL pass (τ-bench, Yao et al. 2024). With k = n
//                it is 1 iff every repeat passed ("consistency").
//   any-pass@k   1 − C(n − c, k) / C(n, k) — the unbiased HumanEval pass@k
//                estimator (Chen et al. 2021, eq. 1). With k = n it is 1 iff
//                at least one repeat passed.
//   Wilson 95%   score interval for the pass@1 proportion (Wilson 1927;
//                Newcombe 1998 "method 3"). Unlike the Wald interval it
//                stays inside [0, 1] and is honest at small n.
//
// Honesty rule: with k = 1 there is no spread to estimate, so repeatStats
// omits every CI / k-draw field rather than emitting a degenerate interval;
// with k = 0 there are no statistics at all (undefined, rendered n/a).

/** Φ⁻¹(0.975): the two-sided 95% standard-normal quantile. */
export const WILSON_Z95 = 1.959963984540054;

function assertCounts(successes: number, n: number): void {
  if (!Number.isInteger(successes) || !Number.isInteger(n)) {
    throw new RangeError(`counts must be integers (successes=${successes}, n=${n})`);
  }
  if (n < 0 || successes < 0 || successes > n) {
    throw new RangeError(`successes must be within 0..n (successes=${successes}, n=${n})`);
  }
}

function assertK(n: number, k: number): void {
  if (!Number.isInteger(k) || k < 1 || k > n) {
    throw new RangeError(`k must be an integer within 1..n (k=${k}, n=${n})`);
  }
}

/** Wilson score interval; undefined when n = 0 (no observations). */
export function wilsonInterval(
  successes: number,
  n: number,
  z: number = WILSON_Z95,
): { lo: number; hi: number } | undefined {
  assertCounts(successes, n);
  if (n === 0) return undefined;
  const p = successes / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  // Clamp float dust at the boundaries (c = 0 → lo is exactly 0, c = n → hi 1).
  return {
    lo: successes === 0 ? 0 : Math.max(0, center - half),
    hi: successes === n ? 1 : Math.min(1, center + half),
  };
}

/** c / n. */
export function passAt1(successes: number, n: number): number {
  assertCounts(successes, n);
  if (n === 0) throw new RangeError("pass@1 needs n >= 1");
  return successes / n;
}

/** Unbiased pass@k = 1 − C(n−c, k)/C(n, k), in the numerically stable
 *  product form 1 − Π_{i=n−c+1..n} (1 − k/i) (Chen et al. 2021). */
export function anyPassAtK(n: number, successes: number, k: number): number {
  assertCounts(successes, n);
  assertK(n, k);
  if (n - successes < k) return 1;
  let prodFail = 1;
  for (let i = n - successes + 1; i <= n; i++) prodFail *= 1 - k / i;
  return 1 - prodFail;
}

/** pass^k = C(c, k)/C(n, k) = Π_{i=0..k−1} (c − i)/(n − i). */
export function passHatK(n: number, successes: number, k: number): number {
  assertCounts(successes, n);
  assertK(n, k);
  if (successes < k) return 0;
  let prod = 1;
  for (let i = 0; i < k; i++) prod *= (successes - i) / (n - i);
  return prod;
}

export interface RepeatStats {
  /** Number of scored repeats in the cell (the k in pass^k / any-pass@k). */
  k: number;
  passes: number;
  passAt1: number;
  /** All k passed (pass^k with k = n). Present only when k >= 2. */
  passHatK?: number;
  /** At least one of k passed (any-pass@k with k = n). Present only when k >= 2. */
  anyPassAtK?: number;
  /** Wilson 95% bounds on pass@1. Present only when k >= 2. */
  wilsonLo?: number;
  wilsonHi?: number;
}

/** Roll one cell's pass/fail outcomes into RepeatStats; undefined when the
 *  cell has no scored outcomes at all. */
export function repeatStats(outcomes: readonly boolean[]): RepeatStats | undefined {
  const k = outcomes.length;
  if (k === 0) return undefined;
  const passes = outcomes.filter(Boolean).length;
  const base: RepeatStats = { k, passes, passAt1: passAt1(passes, k) };
  if (k < 2) return base;
  const w = wilsonInterval(passes, k)!;
  return {
    ...base,
    passHatK: passHatK(k, passes, k),
    anyPassAtK: anyPassAtK(k, passes, k),
    wilsonLo: w.lo,
    wilsonHi: w.hi,
  };
}
