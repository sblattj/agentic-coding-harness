#!/usr/bin/env bash
# trial-all.sh — trial every installed agent on the same small task and print a comparison table.
#
# Drives the harness CLI (src/cli/harness.ts). Resolution order: `harness` on PATH,
# else `bun src/cli/harness.ts`, else `npx tsx src/cli/harness.ts`.
# Output shape per `harness run --json` is the RunResult envelope; parsing below
# tolerates both contested variants (.tokens.{input,..} and .tokens.inputTokens; .costUsd/.totalCost).
set -u -o pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TASK="List the files in the current directory and summarize the project in 3 bullet points"
AGENTS="claude codex opencode gemini kiro"

# --- resolve harness CLI -------------------------------------------------------
HARNESS=""
if command -v harness >/dev/null 2>&1; then
  HARNESS="harness"
elif [ -f "$REPO/src/cli/harness.ts" ] && command -v bun >/dev/null 2>&1; then
  HARNESS="bun $REPO/src/cli/harness.ts"
elif [ -f "$REPO/src/cli/harness.ts" ]; then
  HARNESS="npx tsx $REPO/src/cli/harness.ts"
else
  echo "error: no 'harness' on PATH and $REPO/src/cli/harness.ts not found" >&2
  exit 1
fi

# --- agent availability (both the agent CLI and its harness adapter must exist) ---
ADAPTER_DIR="$REPO/src/adapters"
RUN=() SKIPPED=()
for a in $AGENTS; do
  if command -v "$a" >/dev/null 2>&1 && [ -f "$ADAPTER_DIR/$a.ts" ]; then
    RUN+=("$a")
  else
    command -v "$a" >/dev/null 2>&1 || SKIPPED+=("$a (CLI not installed)")
    [ -f "$ADAPTER_DIR/$a.ts" ] || SKIPPED+=("$a (no harness adapter yet)")
  fi
done
for s in "${SKIPPED[@]:-}"; do [ -n "$s" ] && echo "skip: $s"; done
[ ${#RUN[@]} -eq 0 ] && { echo "error: nothing to trial — no agent with both CLI and adapter" >&2; exit 1; }

# --- run trials ----------------------------------------------------------------
TS="$(date +%Y%m%d-%H%M%S)"
OUT="$REPO/trials/$TS"
mkdir -p "$OUT"
echo "task: $TASK"
echo "out:  $OUT"

for a in "${RUN[@]}"; do
  echo "run:  $a"
  start=$(date +%s)
  # shellcheck disable=SC2086
  if ! $HARNESS run --agent "$a" --json "$TASK" >"$OUT/$a.json" 2>"$OUT/$a.stderr"; then
    echo "(exit != 0 — see $OUT/$a.stderr; keeping the row)" >&2
  fi
  echo $(( $(date +%s) - start )) >"$OUT/$a.secs"
done

# --- comparison table ----------------------------------------------------------
# RunResult envelope (formatSummary + recordFromRunResult contract):
#   .sessionId .tokens.{input,output,cacheRead,cacheWrite,reasoning} .costUsd .durationMs .exitStatus
row() {
  f="$1"; a="$2"
  if command -v jq >/dev/null 2>&1 && [ -s "$f" ]; then
    jq -r --arg a "$a" '
      (.tokens // {}) as $t |
      [($t.input // $t.inputTokens // 0),
       ($t.output // $t.outputTokens // 0),
       (($t.cacheRead // $t.cacheReadTokens // 0) + ($t.cacheWrite // $t.cacheWriteTokens // 0)),
       (.costUsd // .totalCost // "n/a"),
       (.durationMs // "n/a"),
       (.exitStatus // .status // "error")] | @tsv' "$f" 2>/dev/null
  else
    printf '0\t0\t0\tn/a\tn/a\tmissing\n'
  fi
}

echo
printf '%-10s %10s %10s %10s %10s %10s %s\n' AGENT INPUT OUTPUT CACHE COST DUR_S STATUS
printf '%-10s %10s %10s %10s %10s %10s %s\n' ---------- ---------- ---------- ---------- ---------- ---------- ------
for a in "${RUN[@]}"; do
  dur="$(cat "$OUT/$a.secs")"
  IFS=$'\t' read -r i o c cost _ms st <<<"$(row "$OUT/$a.json" "$a")"
  printf '%-10s %10s %10s %10s %10s %10s %s\n' "$a" "$i" "$o" "$c" "$cost" "$dur" "$st"
done
echo
echo "raw outputs: $OUT/  (per agent: .json run result · .stderr event stream · .secs wall time)"
