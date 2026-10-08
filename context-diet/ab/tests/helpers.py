import json
import os
import stat
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

FAKE = r'''#!/usr/bin/env python3
import json, os, sys
a = sys.argv[1:]
log = os.environ.get("FAKE_CLAUDE_LOG")
if log:
    with open(log, "a") as f:
        f.write(json.dumps({"args": a, "has_key": "ANTHROPIC_API_KEY" in os.environ,
                            "max_out": os.environ.get("CLAUDE_CODE_MAX_OUTPUT_TOKENS")}) + "\n")
if os.environ.get("FAKE_CLAUDE_HANG"):
    import time; time.sleep(60)
prompt = a[a.index("-p") + 1]
fmt = a[a.index("--output-format") + 1]
if fmt == "json":
    # judge: keep ids whose prompt text does not contain "KEEPNOT"
    payload = json.loads(prompt.split("Prompts (JSON):\n", 1)[1])
    ids = [p["id"] for p in payload if "yes" != p["prompt"].strip().lower()]
    res = {"type": "result", "is_error": False, "result": "```json\n%s\n```" % json.dumps(ids)}
    # newer CLIs emit a list of events; older emit the bare result object
    print(json.dumps([{"type": "system"}, res] if os.environ.get("FAKE_CLAUDE_LIST") else res))
    sys.exit(0)
override = {}
if "--settings" in a:
    override = json.load(open(a[a.index("--settings") + 1])).get("skillOverrides", {})
print(json.dumps({"type": "system", "subtype": "init"}))
content = [{"type": "text", "text": "ok"}]
if "deploy" in prompt and override.get("deploy", "on") == "on":
    content.insert(0, {"type": "tool_use", "name": "Skill", "input": {"skill": "deploy"}})
if "wrongfire" in prompt:
    content.insert(0, {"type": "tool_use", "name": "Skill", "input": {"skill": "other"}})
print(json.dumps({"type": "assistant", "message": {"content": content, "usage": {
    "input_tokens": 5, "cache_creation_input_tokens": 100, "cache_read_input_tokens": 1000}}}))
print(json.dumps({"type": "result", "is_error": False, "num_turns": 1}))
'''


def make_fake_bin(dirpath):
    p = os.path.join(dirpath, "claude")
    with open(p, "w") as f:
        f.write(FAKE)
    os.chmod(p, os.stat(p).st_mode | stat.S_IXUSR)
    return p


def write_jsonl(path, rows):
    with open(path, "w") as f:
        for r in rows:
            f.write(json.dumps(r) + "\n")
