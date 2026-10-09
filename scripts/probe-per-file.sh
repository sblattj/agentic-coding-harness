#!/bin/sh
# Probe only: run one test file with a hard wall-clock limit and report it.
f="$1"; out="/tmp/probe-$(echo "$f" | tr '/' '_').log"
start=$(date +%s)
perl -e 'alarm 240; exec @ARGV' ./node_modules/.bin/tsx --test "$f" > "$out" 2>&1
rc=$?
end=$(date +%s)
echo "FILE $f rc=$rc dur=$((end-start))s"
if [ "$rc" -ne 0 ]; then echo "---- tail $f"; tail -40 "$out"; echo "---- end $f"; fi
