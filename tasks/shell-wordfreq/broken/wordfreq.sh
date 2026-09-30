#!/bin/sh
set -eu
export LC_ALL=C
file=$1
n=$2
tr -cs 'A-Za-z' '\n' < "$file" | grep -v '^$' | sort | uniq -c \
  | sort -k1,1nr -k2,2 | head -n "$n" | awk '{ print $1 " " $2 }'
