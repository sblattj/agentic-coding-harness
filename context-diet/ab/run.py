#!/usr/bin/env python3
"""Run each case under each arm N times and record which Skill(s) fired.

Per run:  claude -p PROMPT --settings ARM.json --tools Skill Read Grep Glob
          --strict-mcp-config --mcp-config '{"mcpServers":{}}' --max-turns 2
          --output-format stream-json --verbose
Read-only tools and no MCP keep runs side-effect free.

Results are append-only JSONL, one record per (arm, case, rep). Re-running the
same command skips finished keys (errors are retried unless --keep-errors).
A tailable progress log goes to --progress (default: <out>.progress).
Positives whose expected skills are all `user-invocable-only`/`off` in an arm are
excluded by design (recorded with excluded=true, no call made).

Billing: strips ANTHROPIC_API_KEY from the child env so the subscription is used
(--keep-api-key to disable). Each call has a wall-clock --deadline.
"""
import argparse
import concurrent.futures as cf
import json
import os
import sys
import tempfile
import threading
import time

import _claude

DEFAULT_TOOLS = ["Skill", "Read", "Grep", "Glob"]


def parse_stream(text):
    """Parse stream-json output -> dict(skills, start_tokens, result_ok, num_turns)."""
    skills, first_usage, result = [], None, None
    for line in text.splitlines():
        line = line.strip()
        if not line.startswith("{"):
            continue
        try:
            ev = json.loads(line)
        except ValueError:
            continue
        t = ev.get("type")
        if t == "assistant":
            msg = ev.get("message") or {}
            if first_usage is None and msg.get("usage"):
                u = msg["usage"]
                first_usage = (u.get("input_tokens", 0) + u.get("cache_creation_input_tokens", 0)
                               + u.get("cache_read_input_tokens", 0))
            for b in msg.get("content") or []:
                if isinstance(b, dict) and b.get("type") == "tool_use" and b.get("name") == "Skill":
                    s = (b.get("input") or {}).get("skill")
                    if s:
                        skills.append(s)
        elif t == "result":
            result = ev
    return {"skills": skills, "start_tokens": first_usage,
            "result_ok": bool(result) and not result.get("is_error"),
            "num_turns": (result or {}).get("num_turns")}


def skill_matches(fired, expected):
    """A fired skill matches expected if equal or equal after stripping a plugin prefix."""
    f, e = fired.lower(), expected.lower()
    return f == e or f.split(":")[-1] == e.split(":")[-1]


def build_args(prompt, arm_path, model=None, max_turns=2, tools=None):
    args = ["-p", prompt, "--settings", arm_path, "--tools"] + list(tools or DEFAULT_TOOLS) + [
        "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
        "--max-turns", str(max_turns), "--output-format", "stream-json", "--verbose"]
    if model:
        args += ["--model", model]
    return args


def arm_state(arm_path, skill):
    with open(arm_path, encoding="utf-8") as fh:
        ov = json.load(fh).get("skillOverrides", {})
    for k, v in ov.items():
        if k.lower() == skill.lower() or k.split(":")[-1].lower() == skill.split(":")[-1].lower():
            return v
    return "on"


def is_excluded(case, arm_path):
    exp = case.get("skills") or []
    return (case.get("label") == "positive" and exp
            and all(arm_state(arm_path, s) in ("user-invocable-only", "off") for s in exp))


def done_keys(out_path, keep_errors):
    keys = set()
    if os.path.exists(out_path):
        with open(out_path, encoding="utf-8") as fh:
            for line in fh:
                try:
                    r = json.loads(line)
                except ValueError:
                    continue
                if keep_errors or not r.get("error"):
                    keys.add(r["key"])
    return keys


def run_one(case, arm, arm_path, rep, opts, arm_idx=0):
    rec = {"key": "%s|%s|%d" % (arm, case["id"], rep), "arm": arm, "arm_idx": arm_idx, "case": case["id"], "rep": rep,
           "label": case["label"], "expected": case.get("skills", []),
           "explicit": bool(case.get("explicit")), "synthetic": bool(case.get("synthetic")), "prompt": case["prompt"][:200],
           "ts": int(time.time())}
    if is_excluded(case, arm_path):
        rec.update(excluded=True, skills=[], start_tokens=None)
        return rec
    t0 = time.time()
    try:
        out, _rc = _claude.run_claude(
            build_args(case["prompt"], arm_path, opts.model, opts.max_turns, opts.tools),
            deadline=opts.deadline, cwd=opts.cwd, strip_api_key=not opts.keep_api_key,
            claude_bin=opts.claude_bin)
        p = parse_stream(out)
        if not p["result_ok"] and not p["skills"] and p["start_tokens"] is None:
            raise _claude.ClaudeError("no usable stream output: %r" % out[:200])
        rec.update(skills=p["skills"], start_tokens=p["start_tokens"], num_turns=p["num_turns"])
    except Exception as e:  # noqa: BLE001 - record and continue
        rec.update(error=str(e)[:300], skills=[], start_tokens=None)
    rec["secs"] = round(time.time() - t0, 1)
    return rec


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--cases", required=True, help="kept cases .jsonl (from filter.py)")
    ap.add_argument("--arms", required=True, nargs="+", help="arm .json files, or a make_arms.py output dir (order.txt gives order); first = baseline")
    ap.add_argument("--out", required=True, help="append-only results.jsonl")
    ap.add_argument("--reps", type=int, default=2)
    ap.add_argument("--model", default=None, help="model for the runs (default: CLI default)")
    ap.add_argument("--max-turns", type=int, default=2)
    ap.add_argument("--tools", nargs="+", default=DEFAULT_TOOLS)
    ap.add_argument("--deadline", type=float, default=180, help="per-call wall-clock seconds")
    ap.add_argument("--workers", type=int, default=2)
    ap.add_argument("--limit", type=int, default=0, help="only the first N cases")
    ap.add_argument("--cwd", default=None, help="working dir for the runs (default: fresh empty temp dir)")
    ap.add_argument("--progress", default=None)
    ap.add_argument("--keep-errors", action="store_true", help="treat errored keys as done")
    ap.add_argument("--keep-api-key", action="store_true")
    ap.add_argument("--claude-bin", default="claude")
    a = ap.parse_args(argv)

    arm_files = []
    for p in a.arms:
        if os.path.isdir(p):
            names = sorted(f[:-5] for f in os.listdir(p) if f.endswith(".json"))
            order = os.path.join(p, "order.txt")  # written by make_arms.py
            if os.path.exists(order):
                with open(order, encoding="utf-8") as fh:
                    listed = [x.strip() for x in fh if x.strip()]
                names = [n for n in listed if n in names] + [n for n in names if n not in listed]
            arm_files += [os.path.join(p, n + ".json") for n in names]
        else:
            arm_files.append(p)
    arms = [(os.path.splitext(os.path.basename(p))[0], os.path.abspath(p)) for p in arm_files]
    cases = _claude.read_jsonl(a.cases)
    if a.limit:
        cases = cases[:a.limit]
    a.cwd = a.cwd or tempfile.mkdtemp(prefix="ctxdiet-ab-")
    done = done_keys(a.out, a.keep_errors)
    todo = [(c, arm, path, rep, a, idx) for rep in range(a.reps) for c in cases
            for idx, (arm, path) in enumerate(arms)
            if "%s|%s|%d" % (arm, c["id"], rep) not in done]
    prog_path = a.progress or a.out + ".progress"
    print("%d runs to do (%d already done)" % (len(todo), len(done)), file=sys.stderr)
    lock, n_done, n_err = threading.Lock(), 0, 0

    def work(item):
        nonlocal n_done, n_err
        rec = run_one(*item)
        with lock:
            with open(a.out, "a", encoding="utf-8") as fh:
                fh.write(json.dumps(rec, ensure_ascii=False) + "\n")
            n_done += 1
            n_err += 1 if rec.get("error") else 0
            line = "[%d/%d] %s %s fired=%s%s" % (n_done, len(todo), rec["key"], rec["expected"],
                                                 rec["skills"], " ERROR" if rec.get("error") else "")
            with open(prog_path, "a", encoding="utf-8") as pf:
                pf.write(line + "\n")
            print(line, file=sys.stderr)

    with cf.ThreadPoolExecutor(max_workers=max(1, a.workers)) as ex:
        list(ex.map(work, todo))
    print("done: %d runs, %d errors -> %s" % (n_done, n_err, a.out), file=sys.stderr)
    return 1 if n_err else 0


if __name__ == "__main__":
    sys.exit(main())
