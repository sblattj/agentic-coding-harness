#!/bin/sh
# Probe only: run one test file; on a 120 s stall dump its process tree and stacks.
f="$1"; out="/tmp/probe-$(echo "$f" | tr '/' '_').log"
start=$(date +%s)
./node_modules/.bin/tsx --test "$f" > "$out" 2>&1 &
pid=$!
i=0
while kill -0 $pid 2>/dev/null && [ $i -lt 120 ]; do sleep 1; i=$((i+1)); done
if kill -0 $pid 2>/dev/null; then
  echo "HUNG $f after 120s"
  ps -axo pid,ppid,etime,stat,%cpu,command | grep -vE "grep|ps -axo" | grep -E "node|tsx|sqlite|esbuild|git|sh " | cut -c1-300
  echo "---- tail $f"; tail -30 "$out"
  desc=$(pgrep -P $pid); for c in $desc; do desc="$desc $(pgrep -P $c)"; done
  for c in $desc; do for g in $(pgrep -P $c); do desc="$desc $g"; done; done
  for p in $desc; do echo "---- sample $p: $(ps -o command= -p $p | cut -c1-200)"; sample $p 2 2>/dev/null | grep -E "^ +[0-9]+ " | head -40; done
  echo "---- end $f"
  pkill -9 -P $pid; kill -9 $pid
  exit 0
fi
wait $pid; rc=$?
echo "FILE $f rc=$rc dur=$(( $(date +%s)-start ))s"
