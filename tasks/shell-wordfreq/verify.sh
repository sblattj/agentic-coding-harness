#!/bin/sh
# Checker: exit 0 = pass. Reads the agent's work in $ACH_WORKSPACE; the
# hidden tests live in the task directory, out of the agent's reach.
set -eu
TASK_DIR="${ACH_TASK_DIR:-$(cd "$(dirname "$0")" && pwd)}"
WS="${ACH_WORKSPACE:-$PWD}"
cd "$WS"
export LC_ALL=C
check() {
  if [ "$2" != "$3" ]; then
    printf 'FAIL %s\n--- expected\n%s\n--- got\n%s\n' "$1" "$2" "$3"
    exit 1
  fi
  echo "ok   $1"
}

check "top 3" "$(printf '3 cat\n3 the\n2 dog')" "$(sh ./wordfreq.sh "$TASK_DIR/hidden/a.txt" 3)"
check "ties alphabetical" "$(printf '1 alpha\n1 beta\n1 zeta')" "$(sh ./wordfreq.sh "$TASK_DIR/hidden/b.txt" 10)"
check "N=1" "3 cat" "$(sh ./wordfreq.sh "$TASK_DIR/hidden/a.txt" 1)"
