#!/usr/bin/env bash
# Context ablation runner: run the same prompts under context variants with
# `claude -p --output-format json` and write one JSONL file per variant.
# Portable to macOS bash 3.2 (no mapfile, no associative arrays).
set -u

HERE=$(cd "$(dirname "$0")" && pwd)
OUT="./ablate-out"
REPS=1
EXPECT=""
PROMPTS_FILE=""
PROMPT="Reply with exactly: OK"
MAX_TURNS=""
MODEL=""
VARIANTS=""
CLAUDE_BIN="${CLAUDE_BIN:-claude}"

usage() {
  cat <<'USAGE'
Usage: ablate.sh [options]

Runs each prompt under each variant (REPS times) via `claude -p` and writes
<out>/<variant>.jsonl, one row per run: start_tokens (input + cache write +
cache read), input/output/cache tokens, cost_usd, turns, duration_ms, wall_ms,
is_error, and pass when --expect is given.

Options:
  -v, --variants LIST   comma-separated variant names (default: baseline,no-skills,no-mcp,no-instructions,six-tools,six-tools-no-mcp,floor)
  -p, --prompt TEXT     single prompt (default: "Reply with exactly: OK")
  -f, --prompts-file F  file with one prompt per line (overrides --prompt)
  -n, --reps N          repetitions per prompt per variant (default 1)
  -o, --out DIR         output directory (default ./ablate-out)
  -e, --expect STR      mark a run pass/fail by whether the reply contains STR
  -m, --model NAME      pass --model NAME
      --max-turns N     pass --max-turns N
      --list            print the known variants and exit
  -h, --help            this help

Variants:
  baseline          your normal config
  no-skills         --disable-slash-commands (no skills listing)
  no-mcp            --strict-mcp-config with an empty server map
  no-instructions   CLAUDE_CODE_DISABLE_CLAUDE_MDS=1 (no CLAUDE.md files)
  six-tools         --tools Bash Read Edit Write Grep Glob (omits ToolSearch:
                    MCP schemas then load in full, so this can go UP)
  six-tools-no-mcp  six-tools plus an empty MCP config
  floor             six tools, no MCP, no instructions files

Environment: CLAUDE_BIN overrides the claude executable. If ANTHROPIC_API_KEY
is set it is unset for the run so the subscription is used; set
ABLATE_KEEP_API_KEY=1 to keep it.
USAGE
}

KNOWN="baseline no-skills no-mcp no-instructions six-tools six-tools-no-mcp floor"
DEFAULT_VARIANTS="baseline,no-skills,no-mcp,no-instructions,six-tools,six-tools-no-mcp,floor"

while [ $# -gt 0 ]; do
  case "$1" in
    -h|--help) usage; exit 0 ;;
    --list) for k in $KNOWN; do echo "$k"; done; exit 0 ;;
    -v|--variants) VARIANTS="${2:-}"; shift 2 ;;
    -p|--prompt) PROMPT="${2:-}"; shift 2 ;;
    -f|--prompts-file) PROMPTS_FILE="${2:-}"; shift 2 ;;
    -n|--reps) REPS="${2:-}"; shift 2 ;;
    -o|--out) OUT="${2:-}"; shift 2 ;;
    -e|--expect) EXPECT="${2:-}"; shift 2 ;;
    -m|--model) MODEL="${2:-}"; shift 2 ;;
    --max-turns) MAX_TURNS="${2:-}"; shift 2 ;;
    *) echo "unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done
[ -z "$VARIANTS" ] && VARIANTS="$DEFAULT_VARIANTS"
case "$REPS" in ''|*[!0-9]*) echo "--reps must be a positive integer" >&2; exit 2 ;; esac
[ "$REPS" -ge 1 ] || { echo "--reps must be >= 1" >&2; exit 2; }
command -v "$CLAUDE_BIN" >/dev/null 2>&1 || { echo "claude executable not found: $CLAUDE_BIN" >&2; exit 2; }
command -v python3 >/dev/null 2>&1 || { echo "python3 is required" >&2; exit 2; }

EMPTY_MCP='{"mcpServers":{}}'
SIX_TOOLS="Bash Read Edit Write Grep Glob"

# Sets ARGS (array) and VENV (array of NAME=VALUE) for a variant; returns 1 if unknown.
variant_config() {
  ARGS=(); VENV=()
  case "$1" in
    baseline) ;;
    no-skills) ARGS=(--disable-slash-commands) ;;
    no-mcp) ARGS=(--strict-mcp-config --mcp-config "$EMPTY_MCP") ;;
    no-instructions) VENV=(CLAUDE_CODE_DISABLE_CLAUDE_MDS=1) ;;
    six-tools) ARGS=(--tools $SIX_TOOLS) ;;
    six-tools-no-mcp) ARGS=(--tools $SIX_TOOLS --strict-mcp-config --mcp-config "$EMPTY_MCP") ;;
    floor) ARGS=(--tools $SIX_TOOLS --strict-mcp-config --mcp-config "$EMPTY_MCP"); VENV=(CLAUDE_CODE_DISABLE_CLAUDE_MDS=1) ;;
    *) return 1 ;;
  esac
  return 0
}

# Validate variants before spending anything.
OLDIFS=$IFS; IFS=,
for v in $VARIANTS; do
  variant_config "$v" || { IFS=$OLDIFS; echo "unknown variant: $v (see --list)" >&2; exit 2; }
done
IFS=$OLDIFS

# Collect prompts into numbered temp files (bash 3.2: no mapfile).
WORK=$(mktemp -d "${TMPDIR:-/tmp}/ablate.XXXXXX") || exit 1
trap 'rm -rf "$WORK"' EXIT
NPROMPTS=0
if [ -n "$PROMPTS_FILE" ]; then
  [ -r "$PROMPTS_FILE" ] || { echo "cannot read $PROMPTS_FILE" >&2; exit 2; }
  while IFS= read -r line || [ -n "$line" ]; do
    [ -z "$line" ] && continue
    printf '%s' "$line" > "$WORK/prompt.$NPROMPTS"
    NPROMPTS=$((NPROMPTS + 1))
  done < "$PROMPTS_FILE"
else
  printf '%s' "$PROMPT" > "$WORK/prompt.0"
  NPROMPTS=1
fi
[ "$NPROMPTS" -ge 1 ] || { echo "no prompts" >&2; exit 2; }

mkdir -p "$OUT" || exit 1
now_ms() { python3 -c 'import time;print(int(time.time()*1000))'; }

OLDIFS=$IFS; IFS=,
for v in $VARIANTS; do
  IFS=$OLDIFS
  : > "$OUT/$v.jsonl"
  variant_config "$v"
  p=0
  while [ "$p" -lt "$NPROMPTS" ]; do
    r=1
    while [ "$r" -le "$REPS" ]; do
      extra=()
      [ -n "$MODEL" ] && extra=(--model "$MODEL")
      [ -n "$MAX_TURNS" ] && extra=(${extra[@]+"${extra[@]}"} --max-turns "$MAX_TURNS")
      envp=()
      [ "${ABLATE_KEEP_API_KEY:-0}" = "1" ] || envp=(-u ANTHROPIC_API_KEY)
      t0=$(now_ms)
      env ${envp[@]+"${envp[@]}"} ${VENV[@]+"${VENV[@]}"} "$CLAUDE_BIN" -p "$(cat "$WORK/prompt.$p")" \
        --output-format json ${ARGS[@]+"${ARGS[@]}"} ${extra[@]+"${extra[@]}"} \
        > "$WORK/raw.json" 2> "$WORK/err.txt"
      rc=$?
      t1=$(now_ms)
      rowargs=(--variant "$v" --prompt "$p" --rep "$r" --wall-ms $((t1 - t0)))
      [ -n "$EXPECT" ] && rowargs=("${rowargs[@]}" --expect "$EXPECT")
      python3 "$HERE/ablate_row.py" "${rowargs[@]}" < "$WORK/raw.json" >> "$OUT/$v.jsonl"
      echo "$v prompt=$p rep=$r rc=$rc" >&2
      r=$((r + 1))
    done
    p=$((p + 1))
  done
  IFS=,
done
IFS=$OLDIFS
echo "wrote $OUT/*.jsonl" >&2
