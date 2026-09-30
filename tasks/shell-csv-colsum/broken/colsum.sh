#!/bin/sh
set -eu
file=$1
col=$2
awk -F, -v col="$col" '
  NR == 1 { for (i = 1; i <= NF; i++) if ($i == col) idx = i; next }
  NF == 0 { next }
  { if (idx) sum += $idx }
  END { printf "%.2f\n", sum }
' "$file"
