#!/usr/bin/env python3
"""Report per-arm trigger metrics with Wilson 95% CIs and paired exact McNemar tests.

Metrics (run level, excluded/errored runs dropped):
  recall            positives where an expected skill fired
  recall (implicit) same, restricted to positives that do not name the skill
  wrong skill       positives where skills fired but none was expected
  fires on negatives
  median start tokens (first assistant turn input+cache usage)
Paired test: per-case majority outcome across reps (hit iff > half the reps hit),
each non-baseline arm vs the baseline (first arm in run order, or --baseline),
over positive cases present in both arms. McNemar is the exact two-sided
binomial test on discordant pairs. Also lists per-skill regressions.
"""
import argparse
import json
import math
import statistics
import sys
from collections import defaultdict

from run import skill_matches

Z95 = 1.959963984540054


def wilson(k, n, z=Z95):
    """Wilson score interval for k successes of n. Returns (lo, hi); (nan, nan) if n == 0."""
    if n == 0:
        return (float("nan"), float("nan"))
    p = k / n
    d = 1 + z * z / n
    c = (p + z * z / (2 * n)) / d
    h = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return (max(0.0, c - h), min(1.0, c + h))


def mcnemar_exact(b, c):
    """Exact two-sided McNemar p (binomial on discordant pairs b, c)."""
    n = b + c
    if n == 0:
        return 1.0
    k = min(b, c)
    tail = sum(math.comb(n, i) for i in range(k + 1)) / 2 ** n
    return min(1.0, 2 * tail)


def is_hit(rec):
    return any(skill_matches(f, e) for f in rec["skills"] for e in rec["expected"])


def load(path):
    recs = []
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if line:
                recs.append(json.loads(line))
    return recs


def fmt(k, n):
    if n == 0:
        return "n/a (0)"
    lo, hi = wilson(k, n)
    return "%3.0f%% [%2.0f-%2.0f] (%d/%d)" % (100 * k / n, 100 * lo, 100 * hi, k, n)


def summarize(recs):
    pos = [r for r in recs if r["label"] == "positive"]
    neg = [r for r in recs if r["label"] == "negative"]
    imp = [r for r in pos if not r.get("explicit")]
    toks = [r["start_tokens"] for r in recs if r.get("start_tokens")]
    return {
        "recall": (sum(is_hit(r) for r in pos), len(pos)),
        "recall_implicit": (sum(is_hit(r) for r in imp), len(imp)),
        "wrong": (sum(1 for r in pos if r["skills"] and not is_hit(r)), len(pos)),
        "neg_fire": (sum(1 for r in neg if r["skills"]), len(neg)),
        "median_tokens": statistics.median(toks) if toks else None,
    }


def majority(recs):
    """case id -> bool majority hit over positive records."""
    by = defaultdict(list)
    for r in recs:
        if r["label"] == "positive":
            by[r["case"]].append(is_hit(r))
    return {c: sum(v) * 2 > len(v) for c, v in by.items()}


def skill_rates(recs):
    by = defaultdict(lambda: [0, 0])
    for r in recs:
        if r["label"] == "positive":
            for e in r["expected"][:1]:
                by[e][1] += 1
                by[e][0] += is_hit(r)
    return by


def build_report(recs, baseline=None, synthetic="exclude"):
    """synthetic: exclude (default; real recall is not inflated) | include | only."""
    synth_all = [r for r in recs if r.get("synthetic") and not r.get("excluded") and not r.get("error")]
    all_recs = recs  # arm list/order always comes from every record
    if synthetic == "exclude":
        recs = [r for r in recs if not r.get("synthetic")]
    elif synthetic == "only":
        recs = [r for r in recs if r.get("synthetic")]
    usable = [r for r in recs if not r.get("excluded") and not r.get("error")]
    # order arms by the run's arm order (arm_idx), not by file order: workers append concurrently
    order = {}
    for r in all_recs:
        order.setdefault(r["arm"], r.get("arm_idx", len(order)))
        order[r["arm"]] = min(order[r["arm"]], r.get("arm_idx", order[r["arm"]]))
    arms = sorted(order, key=lambda x: order[x])
    base = baseline or (arms[0] if arms else None)
    per = {a: [r for r in usable if r["arm"] == a] for a in arms}
    out = {"synthetic_mode": synthetic, "baseline": base, "arms": {}, "paired": {},
           "errors": sum(1 for r in recs if r.get("error")),
           "excluded": sum(1 for r in recs if r.get("excluded"))}
    for a in arms:
        out["arms"][a] = summarize(per[a])
        if synthetic == "exclude":  # shown separately, never mixed into the real numbers
            sp = [r for r in synth_all if r["arm"] == a and r["label"] == "positive"]
            out["arms"][a]["synthetic_recall"] = (sum(is_hit(r) for r in sp), len(sp))
    bm = majority(per[base]) if base else {}
    for a in arms:
        if a == base:
            continue
        am = majority(per[a])
        common = sorted(set(bm) & set(am))
        only_base = [c for c in common if bm[c] and not am[c]]
        only_arm = [c for c in common if am[c] and not bm[c]]
        sb, sa = skill_rates(per[base]), skill_rates(per[a])
        regress = sorted(((s, sb[s], sa[s]) for s in sb if s in sa and
                          sa[s][0] / max(sa[s][1], 1) < sb[s][0] / max(sb[s][1], 1)),
                         key=lambda x: x[0])
        out["paired"][a] = {"cases": len(common), "only_baseline": len(only_base),
                            "only_arm": len(only_arm),
                            "p": mcnemar_exact(len(only_base), len(only_arm)),
                            "regressions": regress}
    return out


def render(rep):
    L = []
    L.append("Baseline arm: %s   (errors dropped: %d, excluded by design: %d)" % (
        rep["baseline"], rep["errors"], rep["excluded"]))
    L.append("Synthetic cases: %s" % rep.get("synthetic_mode"))
    L.append("")
    L.append("%-14s %-24s %-24s %-22s %-22s %s" % ("arm", "recall", "recall (implicit)", "wrong skill",
                                                     "fires on negatives", "median start tok"))
    for a, s in rep["arms"].items():
        mt = "%.0f" % s["median_tokens"] if s["median_tokens"] is not None else "n/a"
        L.append("%-14s %-24s %-24s %-22s %-22s %s" % (
            a, fmt(*s["recall"]), fmt(*s["recall_implicit"]), fmt(*s["wrong"]), fmt(*s["neg_fire"]), mt))
        if s.get("synthetic_recall") and s["synthetic_recall"][1]:
            L.append("%-14s synthetic-only recall (not in the numbers above): %s" % ("", fmt(*s["synthetic_recall"])))
    for a, p in rep["paired"].items():
        L.append("")
        L.append("Paired %s vs %s over %d positive cases (per-case majority): only %s hit: %d, only %s hit: %d, "
                 "exact McNemar p = %.4g" % (a, rep["baseline"], p["cases"], rep["baseline"],
                                             p["only_baseline"], a, p["only_arm"], p["p"]))
        for s, b, x in p["regressions"]:
            L.append("  regression: %s  %d/%d -> %d/%d" % (s, b[0], b[1], x[0], x[1]))
    return "\n".join(L)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("results", help="results.jsonl from run.py")
    ap.add_argument("--baseline", default=None, help="baseline arm name (default: first arm in run order)")
    ap.add_argument("--synthetic", choices=["exclude", "include", "only"], default="exclude",
                    help="treatment of synthetic cases (default exclude; their recall is shown on its own line)")
    ap.add_argument("--json", action="store_true", help="emit JSON instead of text")
    a = ap.parse_args(argv)
    rep = build_report(load(a.results), a.baseline, a.synthetic)
    print(json.dumps(rep, indent=2) if a.json else render(rep))
    return 0


if __name__ == "__main__":
    sys.exit(main())
