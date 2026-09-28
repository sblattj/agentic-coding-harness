// Repeat-run statistics (#30): pass@1, pass^k, any-pass@k and the Wilson 95%
// score interval. Expected values are computed here by INDEPENDENT routes, not
// by calling the module's own helpers:
//
// - Wilson bounds: the module uses the textbook center ± half-width form
//   (Wilson 1927, JASA 22:209; Newcombe 1998, Stat Med 17:857, "method 3").
//   The test instead solves the defining quadratic
//     (p̂ − p)² = z² · p(1 − p) / n
//   ⇔ (n + z²)p² − (2c + z²)p + c²/n = 0
//   for its two roots. Same interval, different algebra, so a transcription
//   slip in either form breaks the equality.
// - Published anchors: statsmodels `proportion_confint(8, 10, method="wilson")`
//   = (0.4902, 0.9433); Newcombe 1998 Table I, 81/263 → (0.2553, 0.3662).
//   NOTE: issue #30's body quotes "8/10 → [0.579, 0.945]"; that pair is not
//   the Wilson 95% interval for 8/10 (both independent routes above give
//   [0.4902, 0.9433]), so the test pins the correct value, not the typo.
// - pass@k: combinatorial definition 1 − C(n−c, k)/C(n, k) (Chen et al. 2021,
//   "Evaluating LLMs Trained on Code", eq. 1) computed with exact factorial
//   binomials; pass^k: C(c, k)/C(n, k) (Yao et al. 2024, τ-bench).
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  WILSON_Z95,
  anyPassAtK,
  passAt1,
  passHatK,
  repeatStats,
  wilsonInterval,
} from "../src/core/repeat-stats.ts";

const Z = 1.959963984540054; // Φ⁻¹(0.975)

function wilsonByQuadratic(c: number, n: number, z = Z): [number, number] {
  const a = n + z * z;
  const b = -(2 * c + z * z);
  const cc = (c * c) / n;
  const disc = Math.sqrt(b * b - 4 * a * cc);
  return [(-b - disc) / (2 * a), (-b + disc) / (2 * a)];
}

function fact(n: number): number {
  let f = 1;
  for (let i = 2; i <= n; i++) f *= i;
  return f;
}
function choose(n: number, k: number): number {
  if (k < 0 || k > n) return 0;
  return fact(n) / (fact(k) * fact(n - k));
}

const close = (actual: number, expected: number, eps = 1e-9, msg?: string): void => {
  assert.ok(Math.abs(actual - expected) <= eps, msg ?? `${actual} !≈ ${expected} (eps ${eps})`);
};

describe("wilsonInterval", () => {
  it("uses the 95% two-sided normal quantile", () => {
    close(WILSON_Z95, Z, 1e-12);
  });

  it("matches the quadratic-root form for a sweep of (c, n)", () => {
    const cases: Array<[number, number]> = [
      [0, 1], [1, 1], [0, 5], [3, 5], [5, 5], [8, 10], [1, 29], [15, 148], [81, 263], [50, 100],
    ];
    for (const [c, n] of cases) {
      const w = wilsonInterval(c, n);
      assert.ok(w !== undefined);
      const [lo, hi] = wilsonByQuadratic(c, n);
      close(w.lo, Math.max(0, lo), 1e-9, `lo ${c}/${n}: ${w.lo} vs ${lo}`);
      close(w.hi, Math.min(1, hi), 1e-9, `hi ${c}/${n}: ${w.hi} vs ${hi}`);
    }
  });

  it("matches published reference values", () => {
    const a = wilsonInterval(8, 10)!;
    close(a.lo, 0.4902, 5e-5);
    close(a.hi, 0.9433, 5e-5);
    const b = wilsonInterval(81, 263)!;
    close(b.lo, 0.2553, 5e-5);
    close(b.hi, 0.3662, 5e-5);
  });

  it("stays inside [0, 1] at the boundaries", () => {
    const zero = wilsonInterval(0, 20)!;
    assert.equal(zero.lo, 0);
    close(zero.hi, 0.1611, 5e-5); // Newcombe 1998 Table I, 0/20
    const all = wilsonInterval(20, 20)!;
    assert.equal(all.hi, 1);
    close(all.lo, 1 - 0.1611, 5e-5);
  });

  it("returns undefined for n = 0 and rejects impossible counts", () => {
    assert.equal(wilsonInterval(0, 0), undefined);
    assert.throws(() => wilsonInterval(3, 2), /successes/);
    assert.throws(() => wilsonInterval(-1, 2), /successes/);
    assert.throws(() => wilsonInterval(1.5, 2), /integer/);
  });
});

describe("pass@1 / pass^k / any-pass@k", () => {
  it("fixture cell: k = 3 scored repeats with one flaky fail", () => {
    const outcomes = [true, false, true];
    assert.equal(passAt1(2, 3), 2 / 3);
    assert.equal(passHatK(3, 2, 3), 0); // not all three passed
    assert.equal(anyPassAtK(3, 2, 3), 1); // at least one passed
    const s = repeatStats(outcomes)!;
    assert.equal(s.k, 3);
    assert.equal(s.passes, 2);
    assert.equal(s.passAt1, 2 / 3);
    assert.equal(s.passHatK, 0);
    assert.equal(s.anyPassAtK, 1);
    const [lo, hi] = wilsonByQuadratic(2, 3);
    close(s.wilsonLo!, lo);
    close(s.wilsonHi!, hi);
  });

  it("agrees with the exact combinatorial definitions for k < n", () => {
    for (let n = 1; n <= 12; n++) {
      for (let c = 0; c <= n; c++) {
        for (let k = 1; k <= n; k++) {
          close(anyPassAtK(n, c, k), 1 - choose(n - c, k) / choose(n, k), 1e-12, `pass@${k} n=${n} c=${c}`);
          close(passHatK(n, c, k), choose(c, k) / choose(n, k), 1e-12, `pass^${k} n=${n} c=${c}`);
        }
      }
    }
    // Hand-checked: n=5, c=2 → pass@2 = 1 − C(3,2)/C(5,2) = 1 − 3/10; pass^2 = 1/10.
    close(anyPassAtK(5, 2, 2), 0.7);
    close(passHatK(5, 2, 2), 0.1);
  });

  it("k = 1 renders pass@1 only — no degenerate CI fields", () => {
    const s = repeatStats([true]);
    assert.deepEqual(s, { k: 1, passes: 1, passAt1: 1 });
    assert.equal("wilsonLo" in s, false);
  });

  it("an empty cell has no statistics", () => {
    assert.equal(repeatStats([]), undefined);
  });

  it("rejects k outside 1..n", () => {
    assert.throws(() => anyPassAtK(3, 1, 4), /k/);
    assert.throws(() => passHatK(3, 1, 0), /k/);
  });
});
