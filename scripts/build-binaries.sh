#!/usr/bin/env bash
# Build standalone executables. Usage: build-binaries.sh [target] [--out-dir directory]
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUTDIR="$REPO/dist-bin"
TARGETS="darwin-arm64 darwin-x64 linux-x64 linux-arm64"
only=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --out-dir)
      [ "$#" -ge 2 ] && [ -n "$2" ] || { echo 'error: --out-dir needs a directory' >&2; exit 1; }
      OUTDIR="$2"; shift 2 ;;
    *)
      [ -z "$only" ] || { echo 'error: supply only one target' >&2; exit 1; }
      case " $TARGETS " in
        *" $1 "*) only="$1" ;;
        *) echo "error: unknown target '$1' (expected: $TARGETS)" >&2; exit 1 ;;
      esac
      shift ;;
  esac
done
[ -z "$only" ] || TARGETS="$only"
command -v bun >/dev/null || { echo 'error: bun is required' >&2; exit 1; }
mkdir -p "$OUTDIR"
# Invalidate old checksums even if this invocation fails partway through.
rm -f "$OUTDIR/SHA256SUMS"
for target in $TARGETS; do
  bun build --compile --target="bun-$target" --external bun-pty \
    --outfile "$OUTDIR/ach-$target" "$REPO/src/cli/ach.ts"
  chmod +x "$OUTDIR/ach-$target"
done
(
  cd "$OUTDIR"
  for target in $TARGETS; do
    shasum -a 256 "ach-$target"
  done > SHA256SUMS
)
