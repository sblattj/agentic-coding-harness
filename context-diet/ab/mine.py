#!/usr/bin/env python3
"""Mine candidate trigger prompts from Claude Code session transcripts.

A user prompt whose turn called Skill(x) becomes a positive labelled x (a turn
that called several skills accepts any of them). Short prompts whose turn called
no skill become negatives. Positives that literally name the skill are tagged
explicit. Typed slash commands, tool results, meta/caveat messages and
sidechain (subagent) turns are skipped.

Usage: mine.py TRANSCRIPT_DIR_OR_FILE [...] --out candidates.jsonl [--days 30]
"""
import argparse
import json
import os
import random
import sys
import time
from datetime import datetime, timezone


def iter_files(paths):
    for p in paths:
        if os.path.isfile(p):
            yield p
        else:
            for root, _dirs, files in os.walk(p):
                for f in sorted(files):
                    if f.endswith(".jsonl"):
                        yield os.path.join(root, f)


def user_text(rec):
    """Return the prompt text of a real human user turn, else None."""
    if rec.get("type") != "user" or rec.get("isSidechain") or rec.get("isMeta"):
        return None
    content = (rec.get("message") or {}).get("content")
    if isinstance(content, str):
        text = content
    elif isinstance(content, list):
        if any(isinstance(b, dict) and b.get("type") == "tool_result" for b in content):
            return None
        text = "\n".join(b.get("text", "") for b in content
                         if isinstance(b, dict) and b.get("type") == "text")
    else:
        return None
    text = text.strip()
    if not text or text.startswith("<") or text.startswith("/"):
        return None  # slash command, caveat, system reminder, etc.
    return text


def skills_called(rec):
    if rec.get("type") != "assistant" or rec.get("isSidechain"):
        return []
    content = (rec.get("message") or {}).get("content")
    out = []
    if isinstance(content, list):
        for b in content:
            if isinstance(b, dict) and b.get("type") == "tool_use" and b.get("name") == "Skill":
                s = (b.get("input") or {}).get("skill")
                if s:
                    out.append(s)
    return out


def parse_ts(rec):
    ts = rec.get("timestamp")
    if not ts:
        return None
    try:
        return datetime.fromisoformat(ts.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


def is_explicit(prompt, skill):
    low = prompt.lower()
    bare = skill.split(":")[-1].lower()
    return skill.lower() in low or bare in low


def mine_file(path, min_ts=None):
    turns = []  # [prompt, ts, [skills]]
    with open(path, encoding="utf-8", errors="replace") as fh:
        for line in fh:
            try:
                rec = json.loads(line)
            except ValueError:
                continue
            txt = user_text(rec)
            if txt is not None:
                turns.append([txt, parse_ts(rec), []])
                continue
            if turns:
                turns[-1][2].extend(skills_called(rec))
    for prompt, ts, skills in turns:
        if min_ts is not None and ts is not None and ts < min_ts:
            continue
        yield prompt, ts, list(dict.fromkeys(skills))


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("paths", nargs="+", help="transcript .jsonl files or directories (e.g. your Claude projects dir)")
    ap.add_argument("--out", required=True, help="output candidates.jsonl")
    ap.add_argument("--days", type=float, default=30, help="only turns newer than N days (0 = all)")
    ap.add_argument("--max-negative-chars", type=int, default=300, help="negatives must be shorter than this")
    ap.add_argument("--max-prompt-chars", type=int, default=2000, help="truncate stored prompts")
    ap.add_argument("--max-negatives", type=int, default=0, help="random-sample negatives to this count (0 = keep all)")
    ap.add_argument("--seed", type=int, default=0)
    a = ap.parse_args(argv)

    min_ts = time.time() - a.days * 86400 if a.days > 0 else None
    pos, neg, seen = [], [], set()
    for f in iter_files(a.paths):
        for prompt, _ts, skills in mine_file(f, min_ts):
            key = prompt[:a.max_prompt_chars]
            if key in seen:
                continue
            seen.add(key)
            if skills:
                pos.append({"prompt": key, "label": "positive", "skills": skills,
                            "explicit": any(is_explicit(prompt, s) for s in skills)})
            elif len(prompt) < a.max_negative_chars:
                neg.append({"prompt": key, "label": "negative", "skills": [], "explicit": False})
    rng = random.Random(a.seed)
    if a.max_negatives and len(neg) > a.max_negatives:
        neg = rng.sample(neg, a.max_negatives)
    rows = pos + neg
    with open(a.out, "w", encoding="utf-8") as fh:
        for i, r in enumerate(rows):
            r["id"] = "c%04d" % i
            fh.write(json.dumps(r, ensure_ascii=False) + "\n")
    print("mined %d positives (%d explicit), %d negatives -> %s" % (
        len(pos), sum(1 for r in pos if r["explicit"]), len(neg), a.out), file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
