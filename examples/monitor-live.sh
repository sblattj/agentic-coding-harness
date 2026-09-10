#!/usr/bin/env bash
# monitor-live.sh — run `harness watch` in the background, fire a sample `harness run`,
# then show the deltas appearing on the watch stream.
#
# watch tails Claude transcripts (~/.claude/projects/**/*.jsonl, 5s poll, grow-only on first
# sight) plus opencode's SQLite when present, printing per-session delta lines like:
#   claude  a1b2c3d4e5f6  +12,345 in  +678 out  +9,012 cache  +$0.1234
set -u -o pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TASK="Say hello in one sentence and exit"

HARNESS=""
if command -v harness >/dev/null 2>&1; then
  HARNESS="harness"
elif [ -f "$REPO/src/cli/harness.ts" ] && command -v bun >/dev/null 2>&1; then
  HARNESS="bun $REPO/src/cli/harness.ts"
elif [ -f "$REPO/src/cli/harness.ts" ]; then
  HARNESS="npx tsx $REPO/src/cli/harness.ts"
else
  echo "error: no harness CLI — see src/cli/harness.ts" >&2
  exit 1
fi

WATCH_LOG="$(mktemp /tmp/harness-watch.XXXXXX.log)"
trap 'kill "$WATCH_PID" 2>/dev/null' EXIT

echo "watch log: $WATCH_LOG"
$HARNESS watch >"$WATCH_LOG" 2>&1 &
WATCH_PID=$!
sleep 2
before=$(wc -l <"$WATCH_LOG" | tr -d ' ')

echo "sample run: $TASK"
# The run's transcript lands under ~/.claude/projects/**; watch's next poll picks up the growth.
# shellcheck disable=SC2086
$HARNESS run --agent claude --json "$TASK" >/dev/null 2>&1 \
  || echo "(sample run failed — watch may still surface its error events)"

# Settle > watch's 5s poll so at least one tick observes the growth.
sleep 7
after=$(wc -l <"$WATCH_LOG" | tr -d ' ')

echo
echo "--- deltas appearing on the watch stream ($((after - before)) new lines) ---"
sed -n "$((before + 1)),\$p" "$WATCH_LOG" | grep -E 'in +.*out +.*cache' \
  || sed -n "$((before + 1)),\$p" "$WATCH_LOG" \
  || echo "(no new events captured)"

# Bonus: aggregate view of what just landed.
echo
echo "--- harness stats --days 1 ---"
# shellcheck disable=SC2086
$HARNESS stats --days 1 2>/dev/null || echo "(stats unavailable)"
