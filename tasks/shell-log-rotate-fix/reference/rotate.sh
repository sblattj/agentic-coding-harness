#!/bin/sh
set -eu
export LC_ALL=C
dir=$1
keep=$2
count=$(find "$dir" -maxdepth 1 -type f -name '*.log' | wc -l)
remove=$((count - keep))
[ "$remove" -gt 0 ] || exit 0
find "$dir" -maxdepth 1 -type f -name '*.log' | sort | head -n "$remove" |
  while IFS= read -r f; do rm -f -- "$f"; done
