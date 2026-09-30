#!/bin/sh
dir=$1
keep=$2
cd "$dir" || exit 1
files=$(ls *.log | sort)
n=$(echo "$files" | wc -l)
for f in $files; do
  if [ "$n" -lt "$keep" ]; then break; fi
  rm "$f"
  n=$((n - 1))
done
