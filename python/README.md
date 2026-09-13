# agentic-coding-harness (Python wrapper)

[![PyPI](https://img.shields.io/pypi/v/agentic-coding-harness)](https://pypi.org/project/agentic-coding-harness/)

Run, watch, and meter coding agents from the command line. This Python
package wraps the compiled `ach` CLI (vendored inside the wheel) and launches
it with whatever JavaScript runtime you have installed — Bun if available,
otherwise Node.js >= 18.19. No Python runtime dependencies; stdlib only.

```sh
# run without installing (the alias name matters for uvx)
uvx agentic-coding-harness --help

# or install
uv tool install agentic-coding-harness
ach --help
```

## Requirements

- Python 3.9+
- Bun or Node.js >= 18.19 on your PATH (or in the usual install dirs), or set
  `AGENTIC_CODING_HARNESS_RUNTIME=/path/to/runtime` to force one.

## What it does

The console scripts `ach` and `agentic-coding-harness` both locate a JS
runtime, then `exec` the vendored `ach.mjs` bundle with full argument, stdio,
signal, and exit-code passthrough. If no runtime is found they print install
instructions and exit 127.

See the [project README](https://github.com/sblattj/agentic-coding-harness)
for the full `ach` CLI documentation.
