#!/bin/sh
set -eu
file=$1
col=$2
awk -F, -v col="$col" '
  NR == 1 { for (i = 1; i <= NF; i++) if ($i == col) idx = i
            if (!idx) { print "colsum: no column " col > "/dev/stderr"; bad = 1; exit 2 }
            next }
  NF == 0 { next }
  { sum += $idx }
  END { if (!bad) printf "%.2f\n", sum }
' "$file"
