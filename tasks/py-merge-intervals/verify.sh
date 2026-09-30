#!/bin/sh
# Checker: exit 0 = pass. Reads the agent's work in $ACH_WORKSPACE; the
# hidden tests live in the task directory, out of the agent's reach.
set -eu
TASK_DIR="${ACH_TASK_DIR:-$(cd "$(dirname "$0")" && pwd)}"
WS="${ACH_WORKSPACE:-$PWD}"
cd "$WS"
export ACH_WORKSPACE="$WS" PYTHONDONTWRITEBYTECODE=1
exec python3 "$TASK_DIR/hidden/test_intervals.py"
