#!/usr/bin/env python3
"""Lint SKILL.md files: `description` + `when_to_use` must fit in a character cap.

Every skill's description and when_to_use are loaded into every prompt, so long
trigger lists are a recurring token cost. Overflow belongs in a `## More
triggers` section in the skill body, which loads only when the skill fires.

Exit status: 0 clean, 1 violations found, 2 usage error.
"""
import argparse
import glob
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import skill_meta  # noqa: E402

DEFAULT_CAP = 600


def collect(paths):
    """Expand files/dirs to SKILL.md paths. A dir may be a skill dir or a root of skill dirs."""
    out = []
    for p in paths:
        if os.path.isdir(p):
            direct = os.path.join(p, "SKILL.md")
            if os.path.isfile(direct):
                out.append(direct)
            out.extend(sorted(glob.glob(os.path.join(p, "**", "SKILL.md"), recursive=True)))
        elif os.path.isfile(p):
            out.append(p)
    seen, uniq = set(), []
    for p in out:
        if p not in seen:
            seen.add(p)
            uniq.append(p)
    return uniq


def lint_file(path, cap):
    """Return a violation dict or None."""
    sk = skill_meta.read_skill(path)
    if sk is None:
        return {"path": path, "length": 0, "cap": cap, "problem": "unreadable"}
    meta = sk["meta"]
    n = skill_meta.listing_length(meta)
    if n <= cap:
        return None
    return {"path": path, "length": n, "cap": cap, "over": n - cap,
            "problem": "over-cap",
            "fields": {k: len(meta.get(k, "") or "") for k in skill_meta.FIELDS_COUNTED},
            "has_more_triggers": "## More triggers" in sk["body"]}


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0],
                                 epilog="\n\n".join(__doc__.split("\n\n")[1:]),
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("paths", nargs="+", help="SKILL.md files or directories to scan")
    ap.add_argument("--cap", type=int, default=DEFAULT_CAP,
                    help="max description+when_to_use chars (default %d)" % DEFAULT_CAP)
    a = ap.parse_args(argv)
    files = collect(a.paths)
    if not files:
        print("no SKILL.md files found", file=sys.stderr)
        return 2
    bad = 0
    for f in files:
        v = lint_file(f, a.cap)
        if v is None:
            continue
        bad += 1
        if v["problem"] == "unreadable":
            print("%s: unreadable" % f)
            continue
        print("%s: description+when_to_use is %d chars (cap %d, over by %d; description=%d, when_to_use=%d)"
              % (f, v["length"], v["cap"], v["over"], v["fields"]["description"], v["fields"]["when_to_use"]))
        if v["has_more_triggers"]:
            print("  suggestion: shorten the description; extra trigger phrases can go in the existing '## More triggers' section")
        else:
            print("  suggestion: keep the first sentence(s) in the description and move the extra trigger phrases to a '## More triggers' section in the body")
    print("%d skill(s) checked, %d over the cap" % (len(files), bad))
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
