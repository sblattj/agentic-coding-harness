#!/usr/bin/env python3
"""Turn one `claude -p --output-format json` payload into one ablation JSONL row.

Reads the payload on stdin (a single result object, or the event array that
recent Claude Code versions print) and writes one JSON line on stdout.
Used by ablate.sh; importable for tests.
"""
import argparse
import json
import sys


def result_object(payload):
    """Return the `result` event from a payload (object or event list)."""
    if isinstance(payload, list):
        for ev in reversed(payload):
            if isinstance(ev, dict) and ev.get("type") == "result":
                return ev
        return {}
    return payload if isinstance(payload, dict) else {}


def build_row(payload, variant, prompt_idx, rep, expect=None, wall_ms=None):
    r = result_object(payload)
    u = r.get("usage") or {}
    inp = int(u.get("input_tokens") or 0)
    cw = int(u.get("cache_creation_input_tokens") or 0)
    cr = int(u.get("cache_read_input_tokens") or 0)
    row = {
        "variant": variant,
        "prompt": prompt_idx,
        "rep": rep,
        "input_tokens": inp,
        "output_tokens": int(u.get("output_tokens") or 0),
        "cache_read_tokens": cr,
        "cache_write_tokens": cw,
        # Everything the model had to read: the "start tokens" metric.
        "start_tokens": inp + cw + cr,
        "cost_usd": r.get("total_cost_usd"),
        "turns": r.get("num_turns"),
        "duration_ms": r.get("duration_ms"),
        "wall_ms": wall_ms,
        "is_error": bool(r.get("is_error", not r)),
    }
    if expect is not None:
        text = r.get("result") or ""
        row["pass"] = (not row["is_error"]) and expect in text
    return row


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--variant", required=True)
    ap.add_argument("--prompt", type=int, default=0, help="prompt index")
    ap.add_argument("--rep", type=int, default=1)
    ap.add_argument("--expect", help="substring the reply must contain (adds a pass field)")
    ap.add_argument("--wall-ms", type=int)
    a = ap.parse_args(argv)
    try:
        payload = json.load(sys.stdin)
    except ValueError:
        payload = {}
    print(json.dumps(build_row(payload, a.variant, a.prompt, a.rep, a.expect, a.wall_ms)))


if __name__ == "__main__":
    main()
