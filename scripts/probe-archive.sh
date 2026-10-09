#!/bin/sh
# Probe only: run archive.test.ts; if it outlives 60 s, dump the process tree.
./node_modules/.bin/tsx --test tests/archive.test.ts > /tmp/arch.log 2>&1 &
pid=$!
i=0
while kill -0 $pid 2>/dev/null && [ $i -lt 60 ]; do sleep 1; i=$((i+1)); done
if kill -0 $pid 2>/dev/null; then
  echo "HUNG after 60s"; ps -axo pid,ppid,etime,stat,command | grep -vE "grep|ps -axo" | grep -E "node|tsx|sqlite|sh |git" | cut -c1-400
  echo "---- arch.log tail"; tail -60 /tmp/arch.log
  for p in $(pgrep -P $pid; pgrep -f "src/cli/ach.ts"); do echo "---- sample $p"; sample $p 3 2>/dev/null | head -60; done
  pkill -9 -f "src/cli/ach.ts"; kill -9 $pid; exit 1
fi
wait $pid; rc=$?; echo "DONE rc=$rc in ${i}s"; tail -8 /tmp/arch.log; exit $rc
