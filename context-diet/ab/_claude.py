"""Shared helper: run `claude -p` as a subprocess with a hard wall-clock deadline.

Billing note: `claude -p` bills the API when ANTHROPIC_API_KEY is set. To use a
subscription login, unset it. By default we strip it from the child env
(disable with strip_api_key=False).
"""
import json
import os
import signal
import subprocess
import tempfile

MAX_CAPTURE_BYTES = 8 * 1024 * 1024  # hard bound on captured stdout


class ClaudeError(RuntimeError):
    pass


def child_env(strip_api_key=True, extra=None):
    env = dict(os.environ)
    if strip_api_key:
        env.pop("ANTHROPIC_API_KEY", None)
    if extra:
        env.update(extra)
    return env


def run_claude(args, deadline=180.0, cwd=None, strip_api_key=True, extra_env=None,
               claude_bin="claude"):
    """Run `claude -p ...args`. Returns (stdout_text, returncode).

    The whole process group is killed at `deadline` seconds. Raises ClaudeError
    on timeout. Stdout is truncated to MAX_CAPTURE_BYTES.
    """
    cwd = cwd or tempfile.gettempdir()
    proc = subprocess.Popen(
        [claude_bin] + list(args), cwd=cwd, stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        env=child_env(strip_api_key, extra_env), start_new_session=True)
    try:
        out, err = proc.communicate(timeout=deadline)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except (ProcessLookupError, PermissionError):
            proc.kill()
        proc.communicate()
        raise ClaudeError("deadline of %ss exceeded" % deadline)
    text = out[:MAX_CAPTURE_BYTES].decode("utf-8", "replace")
    if proc.returncode != 0 and not text.strip():
        raise ClaudeError("claude exited %d: %s" % (
            proc.returncode, err[-500:].decode("utf-8", "replace")))
    return text, proc.returncode


def read_jsonl(path):
    out = []
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if line:
                out.append(json.loads(line))
    return out
