#!/usr/bin/env python3
"""Single-file quick trigger A/B: does a Skill fire, before vs. after a settings change?

For the full real-prompt pipeline use mine/filter/make_arms/run/report. This is the
quick version: hand-written plain-language prompts, two settings files, count Skill hits.

Prompts file: one per line, `skill-name<TAB>prompt` (blank lines and # comments ignored).
Example:
  quick_ab.py --prompts prompts.tsv --a before.json --b after.json --reps 3
Prints hits per arm and the exact McNemar p over per-prompt majority outcomes.
Reuses run.py (stream parsing, deadline, API-key stripping) and report.py (stats).
"""
import argparse
import sys
import tempfile

import _claude
import run
from report import mcnemar_exact, wilson


def read_prompts(path):
    rows = []
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            line = line.rstrip("\n")
            if not line.strip() or line.lstrip().startswith("#"):
                continue
            skill, _, prompt = line.partition("\t")
            if not prompt:
                raise SystemExit("bad line (need skill<TAB>prompt): %r" % line)
            rows.append((skill.strip(), prompt.strip()))
    return rows


def fired(prompt, settings, a):
    out, _ = _claude.run_claude(run.build_args(prompt, settings, a.model, a.max_turns),
                                deadline=a.deadline, cwd=a.cwd, strip_api_key=not a.keep_api_key,
                                claude_bin=a.claude_bin)
    return run.parse_stream(out)["skills"]


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--prompts", required=True)
    ap.add_argument("--a", required=True, help="settings.json for arm A (baseline)")
    ap.add_argument("--b", required=True, help="settings.json for arm B")
    ap.add_argument("--reps", type=int, default=3)
    ap.add_argument("--model", default=None)
    ap.add_argument("--max-turns", type=int, default=2)
    ap.add_argument("--deadline", type=float, default=180)
    ap.add_argument("--cwd", default=None)
    ap.add_argument("--keep-api-key", action="store_true")
    ap.add_argument("--claude-bin", default="claude")
    a = ap.parse_args(argv)
    a.cwd = a.cwd or tempfile.mkdtemp(prefix="ctxdiet-quick-")
    maj, total = {"A": [], "B": []}, {"A": 0, "B": 0}
    runs = 0
    for skill, prompt in read_prompts(a.prompts):
        for tag, path in (("A", a.a), ("B", a.b)):
            hits = 0
            for _ in range(a.reps):
                try:
                    hits += any(run.skill_matches(f, skill) for f in fired(prompt, path, a))
                except _claude.ClaudeError as e:
                    print("error: %s" % e, file=sys.stderr)
                runs += 1
            total[tag] += hits
            maj[tag].append(hits * 2 > a.reps)
            print("%s %-24s %d/%d  %s" % (tag, skill, hits, a.reps, prompt[:50]))
    n = len(maj["A"])
    for tag in "AB":
        lo, hi = wilson(total[tag], n * a.reps)
        print("arm %s: %d/%d runs hit (Wilson95 %.0f-%.0f%%)" % (tag, total[tag], n * a.reps, 100 * lo, 100 * hi))
    b = sum(1 for x, y in zip(maj["A"], maj["B"]) if x and not y)
    c = sum(1 for x, y in zip(maj["A"], maj["B"]) if y and not x)
    print("only A hit: %d, only B hit: %d, exact McNemar p = %.4g" % (b, c, mcnemar_exact(b, c)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
