"""Builders for synthetic transcripts and skills used by the context-diet tests."""
import json
import os


def write_jsonl(path, events):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        for e in events:
            f.write(json.dumps(e) + "\n")


def skill_call(skill, ts):
    return {"type": "assistant", "timestamp": ts, "message": {"role": "assistant", "content": [
        {"type": "text", "text": "using it"},
        {"type": "tool_use", "id": "t1", "name": "Skill", "input": {"skill": skill}}]}}


def other_tool(ts):
    return {"type": "assistant", "timestamp": ts, "message": {"role": "assistant", "content": [
        {"type": "tool_use", "id": "t2", "name": "Bash", "input": {"command": "ls"}}]}}


def typed(skill, ts, as_list=False):
    text = "<command-message>x</command-message>\n<command-name>/%s</command-name>" % skill
    content = [{"type": "text", "text": text}] if as_list else text
    return {"type": "user", "timestamp": ts, "message": {"role": "user", "content": content}}


def write_skill(root, name, description, when_to_use=None, body="Body.\n", folded=False):
    d = os.path.join(root, name)
    os.makedirs(d, exist_ok=True)
    lines = ["---", "name: %s" % name]
    if folded:
        lines.append("description: >")
        lines.extend("  " + w for w in description.split("\n"))
    else:
        lines.append("description: %s" % json.dumps(description))
    if when_to_use is not None:
        lines.append("when_to_use: %s" % json.dumps(when_to_use))
    lines += ["---", body]
    with open(os.path.join(d, "SKILL.md"), "w", encoding="utf-8") as f:
        f.write("\n".join(lines))
    return os.path.join(d, "SKILL.md")
