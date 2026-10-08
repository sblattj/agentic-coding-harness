#!/usr/bin/env python3
"""Generate synthetic positive cases for skills with too few mined positives.

The issue's run added 14 synthetic positives on top of 45 mined ones. This step
automates that: for each skill in --skills-dir with fewer than --min-positives
positives in cases.jsonl, ask a cheap model (default haiku, via the same
_claude.py call path as filter.py: deadline, bounded output, API key stripped)
for --per-skill realistic plain-language prompts that should trigger the skill
WITHOUT naming it. Each is appended to cases.jsonl as
{"id","prompt","label":"positive","skills":[name],"explicit":false,"synthetic":true}.

Skipped: skills that are user-invocable-only/off in any --arms file, skills with
`disable-model-invocation: true` frontmatter, and prompts duplicating an existing case.
report.py excludes synthetic cases by default so real recall is not inflated.
"""
import argparse
import json
import re
import sys

import _claude
import make_arms
from filter import parse_ids, result_event
from mine import is_explicit
from run import arm_state

PROMPT = """Skill: %(name)s
Description: %(desc)s

Write %(n)d different realistic messages a user might type to a coding assistant that
this skill should handle. Plain everyday language, one or two sentences each, concrete
details (file names, topics), varied phrasing. Do NOT mention the skill name or say
"skill". Return ONLY a JSON array of %(n)d strings. No prose."""


def read_skill(path_dir):
    """Return {name: description} for skills under a dir, plus the set that disable model invocation."""
    import os
    info, no_model = {}, set()
    for entry in sorted(os.listdir(path_dir)):
        p = os.path.join(path_dir, entry)
        f = os.path.join(p, "SKILL.md") if os.path.isdir(p) else p
        if not (os.path.isfile(f) and f.endswith(".md")) or entry.lower() == "readme.md":
            continue
        fallback = entry if os.path.isdir(p) else entry[:-3]
        with open(f, encoding="utf-8", errors="replace") as fh:
            head = fh.read(6000)
        m = re.match(r"---\s*\n(.*?)\n---", head, re.S)
        fm = m.group(1) if m else ""
        name = make_arms.skill_name(f, fallback)
        d = re.search(r"^description:\s*(.+?)(?=^\S|\Z)", fm, re.S | re.M)
        desc = re.sub(r"\s+", " ", d.group(1)).strip(" '\"") if d else ""
        info[name] = desc[:600]
        if re.search(r"^disable-model-invocation:\s*true\s*$", fm, re.M):
            no_model.add(name)
    return info, no_model


def parse_prompts(text, n):
    m = re.search(r"\[.*\]", text, re.S)
    if not m:
        raise ValueError("no JSON array in reply: %r" % text[:200])
    arr = json.loads(m.group(0))
    return [s.strip() for s in arr if isinstance(s, str) and s.strip()][:n]


def norm(s):
    return re.sub(r"\W+", " ", s.lower()).strip()


def generate(name, desc, n, model, deadline, strip_api_key=True, claude_bin="claude", max_output_tokens=1500):
    args = ["-p", PROMPT % {"name": name, "desc": desc, "n": n}, "--model", model, "--tools", "",
            "--output-format", "json", "--max-turns", "1", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}']
    out, _ = _claude.run_claude(args, deadline=deadline, strip_api_key=strip_api_key, claude_bin=claude_bin,
                                extra_env={"CLAUDE_CODE_MAX_OUTPUT_TOKENS": str(max_output_tokens)})
    env = result_event(json.loads(out))
    if env.get("is_error"):
        raise _claude.ClaudeError("generator error: %s" % str(env.get("result"))[:200])
    return parse_prompts(env.get("result", ""), n)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("cases", help="cases.jsonl (from filter.py); synthetic cases are appended to it")
    ap.add_argument("--skills-dir", required=True)
    ap.add_argument("--arms", nargs="*", default=[], help="arm .json files; skills hidden from the model in any are skipped")
    ap.add_argument("--min-positives", type=int, default=1, help="generate for skills with fewer positives than this (default 1 = none mined)")
    ap.add_argument("--per-skill", type=int, default=2, help="prompts per skill (the issue gives only a total of 14)")
    ap.add_argument("--model", default="haiku")
    ap.add_argument("--deadline", type=float, default=120)
    ap.add_argument("--keep-api-key", action="store_true")
    ap.add_argument("--claude-bin", default="claude")
    ap.add_argument("--dry-run", action="store_true", help="list the skills that would get prompts, call nothing")
    a = ap.parse_args(argv)

    cases = _claude.read_jsonl(a.cases)
    counts = {}
    for c in cases:
        if c.get("label") == "positive":
            for s in c.get("skills", []):
                counts[s] = counts.get(s, 0) + 1
    seen = {norm(c["prompt"]) for c in cases}
    info, no_model = read_skill(a.skills_dir)
    added, failed = [], 0
    for name, desc in info.items():
        if counts.get(name, 0) >= a.min_positives:
            continue
        if name in no_model or any(arm_state(p, name) in ("user-invocable-only", "off") for p in a.arms):
            print("skip %s: not model-invocable" % name, file=sys.stderr)
            continue
        if a.dry_run:
            print("would generate %d for %s (%d mined)" % (a.per_skill, name, counts.get(name, 0)), file=sys.stderr)
            continue
        try:
            prompts = generate(name, desc, a.per_skill, a.model, a.deadline, not a.keep_api_key, a.claude_bin)
        except (_claude.ClaudeError, ValueError) as e:
            print("generation for %s failed: %s" % (name, e), file=sys.stderr)
            failed += 1
            continue
        k = 0
        for p in prompts:
            if norm(p) in seen or is_explicit(p, name):
                continue
            seen.add(norm(p))
            added.append({"id": "syn-%s-%d" % (name.replace(":", "_"), k), "prompt": p, "label": "positive",
                          "skills": [name], "explicit": False, "synthetic": True})
            k += 1
        print("%s: +%d" % (name, k), file=sys.stderr)
    if added:
        with open(a.cases, "a", encoding="utf-8") as fh:
            for r in added:
                fh.write(json.dumps(r, ensure_ascii=False) + "\n")
    print("appended %d synthetic positives to %s (%d skills failed)" % (len(added), a.cases, failed), file=sys.stderr)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
