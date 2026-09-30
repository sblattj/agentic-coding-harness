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
T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT
mkdir -p "$T/logs/sub" "$T/empty"
for f in 'app-20260101.log' 'app 20260102.log' 'app-20260103.log' 'app-20260104.log' 'notes.txt' 'sub/app-20250101.log'; do
  : > "$T/logs/$f"
done
sh ./rotate.sh "$T/logs" 2
check "keeps the 2 newest" "$(printf 'app-20260103.log\napp-20260104.log\nnotes.txt\nsub')" "$(ls "$T/logs")"
check "subdirectory untouched" "app-20250101.log" "$(ls "$T/logs/sub")"
sh ./rotate.sh "$T/logs" 5
check "KEEP above count removes nothing" "$(printf 'app-20260103.log\napp-20260104.log\nnotes.txt\nsub')" "$(ls "$T/logs")"
: > "$T/logs/app-20260105 part 2.log"
: > "$T/logs/app-20260109 final.log"
sh ./rotate.sh "$T/logs" 1
check "names with spaces" "$(printf 'app-20260109 final.log\nnotes.txt\nsub')" "$(ls "$T/logs")"
sh ./rotate.sh "$T/empty" 3
check "empty directory" "" "$(ls "$T/empty")"
