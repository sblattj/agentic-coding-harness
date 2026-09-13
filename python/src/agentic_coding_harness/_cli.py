"""Console-script entry point: locate a JS runtime and exec the vendored ach.mjs.

Stdlib only. Prefers Bun, then Node >= 18.19. The runtime may be forced via
the AGENTIC_CODING_HARNESS_RUNTIME environment variable. On POSIX we execv so
stdio, signals, and exit codes pass through untouched; on Windows we fall back
to subprocess.call.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys

_PACKAGE_DIR = os.path.dirname(os.path.abspath(__file__))
_BUNDLE = os.path.join(_PACKAGE_DIR, "_vendor", "ach.mjs")
_RUNTIME_ENV = "AGENTIC_CODING_HARNESS_RUNTIME"

_COMMON_DIRS = (
    "/opt/homebrew/bin",
    "/usr/local/bin",
    os.path.expanduser("~/.bun/bin"),
    os.path.expanduser("~/.volta/bin"),
)

_MISSING_RUNTIME_MESSAGE = """ach: no JavaScript runtime found.

agentic-coding-harness needs Bun or Node.js (>= 18.19) to run.

Install one of:
  curl -fsSL https://bun.sh/install | bash      # Bun (recommended)
  https://nodejs.org/en/download                 # Node.js >= 18.19

Or point {env} at an existing runtime binary, e.g.:
  export {env}=/usr/local/bin/node
""".format(env=_RUNTIME_ENV)


def _candidate_paths(name: str):
    found = shutil.which(name)
    if found:
        yield found
    seen = {found} if found else set()
    for directory in _COMMON_DIRS:
        candidate = os.path.join(directory, name)
        if candidate not in seen and os.path.isfile(candidate) and os.access(candidate, os.X_OK):
            seen.add(candidate)
            yield candidate


def _node_major_minor(path: str):
    """Return (major, minor) for a node binary, or None if it can't be probed."""
    try:
        out = subprocess.run(
            [path, "--version"],
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    version = (out.stdout or "").strip().lstrip("v")
    if not version:
        return None
    parts = version.split(".")
    try:
        return int(parts[0]), int(parts[1])
    except (ValueError, IndexError):
        return None


def find_runtime(env=None):
    """Return the path to a usable JS runtime, or None.

    Honors AGENTIC_CODING_HARNESS_RUNTIME when set.
    """
    environ = env if env is not None else os.environ
    override = environ.get(_RUNTIME_ENV)
    if override:
        if os.path.isfile(override) and os.access(override, os.X_OK):
            return override
        resolved = shutil.which(override)
        if resolved:
            return resolved
        return None

    for bun in _candidate_paths("bun"):
        return bun

    for node in _candidate_paths("node"):
        version = _node_major_minor(node)
        if version is None:
            # Unprobeable (e.g. broken install) - skip rather than fail hard.
            continue
        major, minor = version
        if (major, minor) >= (18, 19):
            return node

    return None


def main(argv=None):
    runtime = find_runtime()
    if runtime is None:
        sys.stderr.write(_MISSING_RUNTIME_MESSAGE)
        return 127
    if not os.path.isfile(_BUNDLE):
        sys.stderr.write(
            "ach: vendored bundle missing ({}). The install is broken; "
            "reinstall agentic-coding-harness.\n".format(_BUNDLE)
        )
        return 127

    args = list(sys.argv[1:] if argv is None else argv)

    if os.name == "posix":
        os.execv(runtime, [runtime, _BUNDLE] + args)  # never returns
        return 127  # pragma: no cover - execv failed to replace us

    return subprocess.call([runtime, _BUNDLE] + args)


if __name__ == "__main__":
    sys.exit(main())
