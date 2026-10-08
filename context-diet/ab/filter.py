#!/usr/bin/env python3
"""LLM-filter mined candidates: keep prompts understandable without prior context.

Batches of 25 go to `claude -p --model haiku --tools "" --output-format json`.
The judge returns the ids to KEEP; "yes", "do 2 and 3" etc. are dropped.

Billing: unset ANTHROPIC_API_KEY to use your subscription (this script strips it
from the child environment by default; pass --keep-api-key to disable that).
Each call has a wall-clock deadline (--deadline) and a bounded output size
(CLAUDE_CODE_MAX_OUTPUT_TOKENS is set for the child; stdout capture is capped).
"""
import argparse
import json
import re
import sys

import _claude

JUDGE_PROMPT = """You are filtering prompts that a user once typed to a coding assistant.
Keep a prompt ONLY if a reader with NO prior conversation could understand what is
being asked (a self-contained request). Drop replies like "yes", "do 2 and 3",
"continue", "looks good", prompts that refer to unseen context ("that file", "the
above"), and pure pasted logs with no request.

Return ONLY a JSON array of the ids to keep, e.g. ["c0001","c0007"]. No prose.

Prompts (JSON):
%s
"""


def parse_ids(text):
    """Extract a JSON array of strings from a model reply (tolerates fences/prose)."""
    m = re.search(r"\[[^\[\]]*\]", text, re.S)
    if not m:
        raise ValueError("no JSON array in reply: %r" % text[:200])
    arr = json.loads(m.group(0))
    return {str(x) for x in arr}


def result_event(parsed):
    """`--output-format json` yields one result object, or (newer CLIs) a list of events."""
    if isinstance(parsed, list):
        for ev in reversed(parsed):
            if isinstance(ev, dict) and ev.get("type") == "result":
                return ev
        raise _claude.ClaudeError("no result event in JSON output")
    return parsed


def judge_batch(batch, model, deadline, strip_api_key=True, claude_bin="claude", max_output_tokens=2000):
    payload = json.dumps([{"id": c["id"], "prompt": c["prompt"][:600]} for c in batch], ensure_ascii=False)
    args = ["-p", JUDGE_PROMPT % payload, "--model", model, "--tools", "",
            "--output-format", "json", "--max-turns", "1",
            "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}']
    out, _rc = _claude.run_claude(args, deadline=deadline, strip_api_key=strip_api_key,
                                  claude_bin=claude_bin,
                                  extra_env={"CLAUDE_CODE_MAX_OUTPUT_TOKENS": str(max_output_tokens)})
    env = result_event(json.loads(out))
    if env.get("is_error"):
        raise _claude.ClaudeError("judge error: %s" % str(env.get("result"))[:200])
    keep = parse_ids(env.get("result", ""))
    return keep & {c["id"] for c in batch}


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("candidates", help="candidates.jsonl from mine.py")
    ap.add_argument("--out", required=True, help="kept cases .jsonl")
    ap.add_argument("--model", default="haiku", help="judge model (default: haiku)")
    ap.add_argument("--batch-size", type=int, default=25)
    ap.add_argument("--deadline", type=float, default=120, help="per-call wall-clock seconds")
    ap.add_argument("--retries", type=int, default=1, help="retries per failed batch")
    ap.add_argument("--keep-api-key", action="store_true", help="do not strip ANTHROPIC_API_KEY")
    ap.add_argument("--claude-bin", default="claude")
    a = ap.parse_args(argv)

    cands = _claude.read_jsonl(a.candidates)
    kept, failed = [], 0
    for i in range(0, len(cands), a.batch_size):
        batch = cands[i:i + a.batch_size]
        keep = None
        for attempt in range(a.retries + 1):
            try:
                keep = judge_batch(batch, a.model, a.deadline, not a.keep_api_key, a.claude_bin)
                break
            except (_claude.ClaudeError, ValueError) as e:
                print("batch %d attempt %d failed: %s" % (i // a.batch_size, attempt, e), file=sys.stderr)
        if keep is None:
            failed += 1
            continue
        kept.extend(c for c in batch if c["id"] in keep)
        print("batch %d: kept %d/%d" % (i // a.batch_size, len(keep), len(batch)), file=sys.stderr)
    with open(a.out, "w", encoding="utf-8") as fh:
        for c in kept:
            fh.write(json.dumps(c, ensure_ascii=False) + "\n")
    print("kept %d of %d (%d batches failed) -> %s" % (len(kept), len(cands), failed, a.out), file=sys.stderr)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
