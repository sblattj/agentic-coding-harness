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
E="$TASK_DIR/hidden/app.env.sample"
check "value containing =" "abc=def==" "$(sh ./getenv.sh "$E" TOKEN)"
check "outer quotes only" 'Ada \"the\" Lovelace' "$(sh ./getenv.sh "$E" NAME)"
check "last occurrence wins" "8080" "$(sh ./getenv.sh "$E" PORT)"
check "comment and suffix keys ignored" "example.org" "$(sh ./getenv.sh "$E" HOST)"
if out=$(sh ./getenv.sh "$E" MISSING); then
  echo "FAIL missing key must exit non-zero (printed '$out')"
  exit 1
fi
check "missing key prints nothing" "" "${out:-}"
