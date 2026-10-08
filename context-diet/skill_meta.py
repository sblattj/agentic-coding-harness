"""Tiny SKILL.md front-matter reader shared by skill-usage.py and skill-lint.py.

Handles the YAML subset skills use: `key: value`, quoted values, and folded or
literal block scalars (`>`, `|`, with optional `-`/`+`). No third-party deps.
"""
import re

FIELDS_COUNTED = ("description", "when_to_use")


def split_frontmatter(text):
    """Return (frontmatter_text, body_text). Empty front matter if absent."""
    lines = text.split("\n")
    if not lines or lines[0].strip() != "---":
        return "", text
    for i in range(1, len(lines)):
        if lines[i].strip() == "---":
            return "\n".join(lines[1:i]), "\n".join(lines[i + 1:])
    return "", text


def _unquote(v):
    v = v.strip()
    if len(v) >= 2 and v[0] == v[-1] and v[0] in "\"'":
        q, v = v[0], v[1:-1]
        if q == '"':
            v = v.replace('\\"', '"').replace("\\n", " ")
        else:
            v = v.replace("''", "'")
    return v


def parse_frontmatter(fm):
    """Parse top-level scalar keys of a front-matter block into a dict of str."""
    out = {}
    lines = fm.split("\n")
    i = 0
    while i < len(lines):
        m = re.match(r"^([A-Za-z_][\w-]*)\s*:\s*(.*)$", lines[i])
        if not m:
            i += 1
            continue
        key, rest = m.group(1), m.group(2).rstrip()
        i += 1
        if re.match(r"^[>|][+-]?\d*$", rest):
            folded = rest[0] == ">"
            block = []
            while i < len(lines) and (lines[i].startswith((" ", "\t")) or lines[i].strip() == ""):
                block.append(lines[i].strip())
                i += 1
            while block and block[-1] == "":
                block.pop()
            out[key] = (" " if folded else "\n").join(block).strip()
        elif rest == "":
            # Plain multi-line scalar or nested map: collect indented lines.
            block = []
            while i < len(lines) and lines[i].startswith((" ", "\t")):
                block.append(lines[i].strip())
                i += 1
            out[key] = " ".join(block)
        else:
            out[key] = _unquote(rest)
    return out


def read_skill(path):
    """Read a SKILL.md. Returns dict(name, meta, body, text) or None if unreadable."""
    try:
        with open(path, encoding="utf-8") as f:
            text = f.read()
    except (OSError, UnicodeDecodeError):
        return None
    fm, body = split_frontmatter(text)
    return {"meta": parse_frontmatter(fm), "body": body, "text": text}


def listing_length(meta):
    """Characters of description + when_to_use, the part loaded into every prompt."""
    return sum(len(meta.get(k, "") or "") for k in FIELDS_COUNTED)
