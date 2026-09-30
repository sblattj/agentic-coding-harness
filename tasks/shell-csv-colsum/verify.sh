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
F="$TASK_DIR/hidden/sales.csv"
check "price column" "103.75" "$(sh ./colsum.sh "$F" price)"
check "units column" "14.00" "$(sh ./colsum.sh "$F" units)"
set +e
out=$(sh ./colsum.sh "$F" nope 2>/dev/null)
code=$?
set -e
check "unknown column exits 2" "2" "$code"
check "unknown column prints nothing" "" "$out"
