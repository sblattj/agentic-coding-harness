#!/usr/bin/env bash
# output-guard-post.sh — Kiro postToolUse spill-and-notice guard (trial, kiro-cli 2.21.2)
#
# Kiro CANNOT rewrite tool output, and on 2.21.2 hook output CANNOT reach the
# model at all (probed 2026-09-10, v1 engine):
#   - exit 0 + stdout  -> stdout is DISCARDED (not in model context, not on terminal)
#   - exit != 0 + stderr -> stderr is shown to the HUMAN on the terminal only
#   - v3 engine (KAS 0.58.7) does not fire hooks at all on this binary
# So this guard is spill-file + HUMAN notice on 2.21.2. On CLI 3.0 (per docs),
# stderr + non-zero exit IS sent to the agent — this design is forward-compatible.
#
# Payload schema on 2.21.2 v1 engine (probed):
#   {"hook_event_name":"postToolUse","cwd":"...","tool_name":"execute_bash",
#    "tool_input":{"command":"...","summary":"..."},
#    "tool_response":{"success":true,"result":[{"exit_status":"0","stdout":"...","stderr":""}]}}
# Note: matcher "shell" (agent-facing name) arrives as tool_name "execute_bash".
# Kiro itself truncates large stdout BEFORE the hook sees it: the payload carries
# only the LAST ~133,333 bytes (tail cut mid-line, no truncation marker). The
# spill file therefore contains what entered the pipeline, not bytes Kiro dropped.
#
# Arms: OUTPUT_GUARD=1 (armed) vs unset (silent pass-through).
# Spill dir: $OUTPUT_GUARD_STATE_DIR (default ~/.local/state/kiro/output-guard).
# This script never blocks the tool: error paths exit 0 silently.

THRESHOLD_BYTES=20000

PAYLOAD="$(cat)" || exit 0

TOOL_NAME="$(printf '%s' "$PAYLOAD" | jq -r '.tool_name // empty' 2>/dev/null)" || exit 0
case "$TOOL_NAME" in
  execute_bash|shell|run_command) ;;
  *) exit 0 ;;
esac

[ "${OUTPUT_GUARD:-}" = "1" ] || exit 0

extract_output() {
  # v1/2.x shape: .tool_response.result[].stdout/.stderr
  # speculative CLI-3.0 shape: top-level .output (hooks never fire on 2.21.2 v3)
  printf '%s' "$PAYLOAD" | jq -j -r '
    ((.tool_response.result // [])
      | map((.stdout // "")
            + (if (.stderr // "") != "" then "\n--- tool stderr ---\n" + .stderr else "" end)
            + (.output // ""))
      | join(""))
    + (.output // "")
  ' 2>/dev/null
}

SIZE_BYTES="$(extract_output | wc -c | tr -d ' ')"
[ "$SIZE_BYTES" -gt "$THRESHOLD_BYTES" ] || exit 0

STATE_DIR="${OUTPUT_GUARD_STATE_DIR:-$HOME/.local/state/kiro/output-guard}"
mkdir -p "$STATE_DIR" 2>/dev/null || exit 0
SPILL_PATH="$STATE_DIR/$(date +%Y%m%dT%H%M%S)-$$.txt"

extract_output > "$SPILL_PATH" 2>/dev/null || exit 0

# stderr + exit 2: visible to the human on 2.21.2; delivered to the agent on CLI 3.0.
echo "TOOL OUTPUT OVERSIZE ($SIZE_BYTES bytes) — full output saved to $SPILL_PATH. Read it selectively (grep/sed ranges). Do NOT cat the whole file." >&2
exit 2
