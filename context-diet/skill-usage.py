#!/usr/bin/env python3
"""Mine local Claude Code transcripts for per-skill usage and suggest overrides.

Counts, per skill, model invocations (`Skill` tool_use blocks) and typed slash
commands (`<command-name>/skill</command-name>` in user turns), then joins the
counts with the skills found on disk to write a CSV:

  skill,model_invocations,typed_invocations,invocations,last_used,description_length,suggested_tier

Tiers (see docs/CONTEXT-DIET.md):
  keep                 used in the window; listing is within the length cap
  trim                 used in the window but description+when_to_use exceeds the cap
  user-invocable-only  only ever typed as /name, never invoked by the model
  name-only            not used in the window (or never): list the name only
"""
import argparse
import csv
import datetime as dt
import glob
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import skill_meta  # noqa: E402

CMD_RE = re.compile(r"<command-name>\s*/?([^<\s]+)\s*</command-name>")
HEADER = ["skill", "model_invocations", "typed_invocations", "invocations",
          "last_used", "description_length", "suggested_tier"]


def default_projects_dir():
    return os.path.join(os.path.expanduser("~"), ".claude", "projects")


def default_skill_dirs():
    return [os.path.join(os.path.expanduser("~"), ".claude", "skills")]


def _text_of(content):
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(b.get("text", "") for b in content
                         if isinstance(b, dict) and b.get("type") == "text")
    return ""


def scan_transcript(path, stats):
    """Accumulate counts from one .jsonl transcript into stats[skill]."""
    try:
        f = open(path, encoding="utf-8", errors="replace")
    except OSError:
        return
    with f:
        for line in f:
            if "Skill" not in line and "command-name" not in line:
                continue
            try:
                ev = json.loads(line)
            except ValueError:
                continue
            if not isinstance(ev, dict):
                continue
            ts = ev.get("timestamp") or ""
            msg = ev.get("message") if isinstance(ev.get("message"), dict) else {}
            content = msg.get("content")
            hits = []
            if ev.get("type") == "assistant" and isinstance(content, list):
                for b in content:
                    if isinstance(b, dict) and b.get("type") == "tool_use" and b.get("name") == "Skill":
                        name = (b.get("input") or {}).get("skill")
                        if isinstance(name, str) and name:
                            hits.append((name.lstrip("/"), "model"))
            elif ev.get("type") == "user":
                for m in CMD_RE.finditer(_text_of(content)):
                    hits.append((m.group(1), "typed"))
            for name, kind in hits:
                s = stats.setdefault(name, {"model": 0, "typed": 0, "last": ""})
                s[kind] += 1
                if ts > s["last"]:
                    s["last"] = ts


def find_transcripts(root):
    return sorted(glob.glob(os.path.join(root, "**", "*.jsonl"), recursive=True))


def load_skills(dirs):
    """Map skill name -> listing length from <dir>/<name>/SKILL.md."""
    out = {}
    for d in dirs:
        for p in sorted(glob.glob(os.path.join(d, "*", "SKILL.md"))):
            sk = skill_meta.read_skill(p)
            if sk is None:
                continue
            name = sk["meta"].get("name") or os.path.basename(os.path.dirname(p))
            out[name] = skill_meta.listing_length(sk["meta"])
    return out


def parse_ts(s):
    try:
        return dt.datetime.fromisoformat(s.replace("Z", "+00:00"))
    except (ValueError, AttributeError):
        return None


def suggest_tier(model, typed, last, length, now, window_days, cap):
    t = parse_ts(last)
    recent = t is not None and (now - t) <= dt.timedelta(days=window_days)
    if model + typed == 0 or not recent:
        return "name-only"
    if model == 0:
        return "user-invocable-only"
    if length > cap:
        return "trim"
    return "keep"


def build_rows(stats, skills, now, window_days=30, cap=600):
    names = sorted(set(stats) | set(skills))
    rows = []
    for n in names:
        s = stats.get(n, {"model": 0, "typed": 0, "last": ""})
        length = skills.get(n, "")
        tier = suggest_tier(s["model"], s["typed"], s["last"],
                            length if length != "" else 0, now, window_days, cap)
        rows.append([n, s["model"], s["typed"], s["model"] + s["typed"],
                     s["last"][:10], length, tier])
    rows.sort(key=lambda r: (-r[3], r[0]))
    return rows


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0],
                                 formatter_class=argparse.RawDescriptionHelpFormatter,
                                 epilog=__doc__.split("\n\n", 1)[1])
    ap.add_argument("projects_dir", nargs="?", default=None,
                    help="transcript root (default: ~/.claude/projects)")
    ap.add_argument("--skills-dir", action="append", default=None,
                    help="directory of <name>/SKILL.md (repeatable; default ~/.claude/skills)")
    ap.add_argument("--window-days", type=int, default=30, help="recency window (default 30)")
    ap.add_argument("--cap", type=int, default=600, help="description+when_to_use cap (default 600)")
    ap.add_argument("--now", help="ISO timestamp to treat as now (for reproducible runs)")
    ap.add_argument("-o", "--output", help="write CSV here instead of stdout")
    a = ap.parse_args(argv)

    root = a.projects_dir or default_projects_dir()
    if not os.path.isdir(root):
        print("no such transcript directory: %s" % root, file=sys.stderr)
        return 2
    now = parse_ts(a.now) if a.now else dt.datetime.now(dt.timezone.utc)
    if now is None:
        print("bad --now", file=sys.stderr)
        return 2
    if now.tzinfo is None:
        now = now.replace(tzinfo=dt.timezone.utc)

    stats = {}
    for p in find_transcripts(root):
        scan_transcript(p, stats)
    rows = build_rows(stats, load_skills(a.skills_dir or default_skill_dirs()),
                      now, a.window_days, a.cap)
    out = open(a.output, "w", newline="") if a.output else sys.stdout
    w = csv.writer(out, lineterminator="\n")
    w.writerow(HEADER)
    w.writerows(rows)
    if a.output:
        out.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
