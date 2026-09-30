#!/bin/sh
# Self-check for the bundled task suite (#51). For every task directory:
#   1. the layout is complete (task.md, setup.sh, verify.sh, meta.json,
#      starter/, reference/, broken/);
#   2. setup.sh copies only starter files: no reference/, broken/ or hidden/
#      directories reach the agent's workspace;
#   3. verify.sh FAILS on the untouched starter (the task is not pre-solved);
#   4. verify.sh PASSES once reference/ is overlaid on a fresh workspace;
#   5. verify.sh FAILS once broken/ is overlaid on a fresh workspace.
#
# Usage: scripts/verify-tasks.sh [--tasks-dir DIR] [task ...]
# Needs only sh, node and python3. Exit 0 when every task passes all checks.
set -eu

ROOT=$(cd "$(dirname "$0")/.." && pwd)
TASKS_DIR="$ROOT/tasks"
if [ "${1:-}" = "--tasks-dir" ]; then
  TASKS_DIR=$(cd "$2" && pwd)
  shift 2
fi

if [ "$#" -eq 0 ]; then
  set --
  for d in "$TASKS_DIR"/*/; do
    [ -f "$d/task.md" ] && set -- "$@" "$(basename "$d")"
  done
fi

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT INT TERM

failures=0
bad() {
  echo "FAIL $1: $2"
  failures=$((failures + 1))
}

# run_verify TASK WORKSPACE LOG -> the verify.sh exit status
run_verify() {
  set +e
  ACH_TASK_DIR="$TASKS_DIR/$1" ACH_WORKSPACE="$2" ACH_TASK_ID="$1" \
    sh "$TASKS_DIR/$1/verify.sh" > "$3" 2>&1
  rc=$?
  set -e
  return $rc
}

# fresh TASK NAME -> path of a new workspace prepared by setup.sh ("" on failure)
fresh() {
  ws="$TMP/$1-$2"
  mkdir -p "$ws"
  if ! (cd "$ws" && ACH_TASK_DIR="$TASKS_DIR/$1" ACH_WORKSPACE="$ws" sh "$TASKS_DIR/$1/setup.sh") > "$ws.setup.log" 2>&1; then
    return 1
  fi
  echo "$ws"
}

for task in "$@"; do
  dir="$TASKS_DIR/$task"
  ok=1
  for f in task.md setup.sh verify.sh meta.json; do
    [ -f "$dir/$f" ] || { bad "$task" "missing $f"; ok=0; }
  done
  for sub in starter reference broken; do
    [ -d "$dir/$sub" ] || { bad "$task" "missing $sub/"; ok=0; }
  done
  [ "$ok" -eq 1 ] || continue

  ws=$(fresh "$task" starter) || { bad "$task" "setup.sh failed: $(cat "$TMP/$task-starter.setup.log")"; continue; }
  for leak in reference broken hidden; do
    [ ! -e "$ws/$leak" ] || bad "$task" "setup.sh copied $leak/ into the workspace"
  done
  if run_verify "$task" "$ws" "$TMP/$task-starter.log"; then
    bad "$task" "verify.sh passes on the untouched starter"
  fi

  ws=$(fresh "$task" reference) || { bad "$task" "setup.sh failed"; continue; }
  cp -R "$dir/reference/." "$ws/"
  if ! run_verify "$task" "$ws" "$TMP/$task-reference.log"; then
    bad "$task" "verify.sh fails on reference/:"
    sed 's/^/    /' "$TMP/$task-reference.log"
  fi

  ws=$(fresh "$task" broken) || { bad "$task" "setup.sh failed"; continue; }
  cp -R "$dir/broken/." "$ws/"
  if run_verify "$task" "$ws" "$TMP/$task-broken.log"; then
    bad "$task" "verify.sh passes on broken/ (the checker misses the planted bug)"
  elif [ -n "${VERIFY_TASKS_VERBOSE:-}" ]; then
    # Show WHY broken/ failed, to confirm it is the planted bug and not a crash.
    grep -m 3 -E 'FAIL|Error' "$TMP/$task-broken.log" | sed "s/^/    broken: /" || true
  fi

  echo "ok   $task"
done

if [ "$failures" -gt 0 ]; then
  echo "verify-tasks: $failures failure(s)"
  exit 1
fi
echo "verify-tasks: $# task(s) ok (starter fails, reference passes, broken fails)"
