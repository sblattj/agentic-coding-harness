#!/usr/bin/env python3
"""Build A/B "arm" settings files: complete skillOverrides maps.

Each arm pins EVERY skill found in --skills-dir to an explicit state, so arms
never depend on ambient defaults. Output: one `<arm>.json` per arm, shaped
{"skillOverrides": {"<skill>": "<state>", ...}}, passed to `claude --settings`.

States: on | name-only | user-invocable-only | off

Skill discovery: every immediate subdirectory containing SKILL.md (name taken
from frontmatter `name:`, else the directory name) and every top-level *.md.

Example:
  make_arms.py --skills-dir ~/.claude/skills --out arms \\
      --arm before --arm after \\
      --set 'after:deploy-*=name-only' --set 'after:old-thing=user-invocable-only'
Also writes order.txt so run.py/report.py treat the first --arm as the baseline.
Rules apply in order; the SKILL part is an fnmatch glob.
"""
import argparse
import fnmatch
import json
import os
import re
import sys

STATES = ("on", "name-only", "user-invocable-only", "off")


def skill_name(path, fallback):
    try:
        with open(path, encoding="utf-8", errors="replace") as fh:
            head = fh.read(4000)
    except OSError:
        return fallback
    m = re.match(r"---\s*\n(.*?)\n---", head, re.S)
    if m:
        n = re.search(r"^name:\s*['\"]?([^'\"\n]+?)['\"]?\s*$", m.group(1), re.M)
        if n:
            return n.group(1).strip()
    return fallback


def discover(skills_dir):
    names = []
    for entry in sorted(os.listdir(skills_dir)):
        p = os.path.join(skills_dir, entry)
        if os.path.isdir(p) and os.path.exists(os.path.join(p, "SKILL.md")):
            names.append(skill_name(os.path.join(p, "SKILL.md"), entry))
        elif os.path.isfile(p) and entry.endswith(".md") and entry.lower() != "readme.md":
            names.append(skill_name(p, entry[:-3]))
    return names


def build_arms(names, arm_names, rules, default_state="on"):
    arms = {a: {n: default_state for n in names} for a in arm_names}
    for arm, pattern, state in rules:
        if arm not in arms:
            raise SystemExit("--set refers to unknown arm %r" % arm)
        hit = [n for n in names if fnmatch.fnmatchcase(n, pattern)]
        if not hit:
            print("warning: pattern %r matched no skill (arm %s)" % (pattern, arm), file=sys.stderr)
        for n in hit:
            arms[arm][n] = state
    return arms


def parse_rule(s):
    m = re.match(r"^([^:=]+):(.+)=([a-z-]+)$", s)
    if not m or m.group(3) not in STATES:
        raise SystemExit("bad --set %r; want ARM:SKILL_GLOB=STATE with STATE in %s" % (s, "|".join(STATES)))
    return m.group(1), m.group(2), m.group(3)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--skills-dir", required=True)
    ap.add_argument("--out", required=True, help="directory for <arm>.json files")
    ap.add_argument("--arm", action="append", default=[], help="arm name (repeatable; first = baseline). Default: before")
    ap.add_argument("--set", dest="sets", action="append", default=[], metavar="ARM:GLOB=STATE")
    ap.add_argument("--default-state", default="on", choices=STATES)
    a = ap.parse_args(argv)

    names = discover(a.skills_dir)
    if not names:
        raise SystemExit("no skills found in %s" % a.skills_dir)
    arm_names = a.arm or ["before"]
    arms = build_arms(names, arm_names, [parse_rule(s) for s in a.sets], a.default_state)
    os.makedirs(a.out, exist_ok=True)
    with open(os.path.join(a.out, "order.txt"), "w", encoding="utf-8") as fh:
        fh.write("\n".join(arm_names) + "\n")  # run.py uses this: first arm = baseline
    for arm, ov in arms.items():
        path = os.path.join(a.out, arm + ".json")
        with open(path, "w", encoding="utf-8") as fh:
            json.dump({"skillOverrides": ov}, fh, indent=2, sort_keys=True)
            fh.write("\n")
        counts = {}
        for v in ov.values():
            counts[v] = counts.get(v, 0) + 1
        print("%s: %d skills %s -> %s" % (arm, len(ov), counts, path), file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
