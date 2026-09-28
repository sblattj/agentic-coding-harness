#!/usr/bin/env bash
# build-binaries.sh — build single-file standalone `ach` executables via
# `bun build --compile`, one per target platform. No node/bun runtime is
# required to RUN the resulting binary; building it still requires bun.
#
# Usage:
#   scripts/build-binaries.sh              # build all targets below
#   scripts/build-binaries.sh darwin-arm64  # build just one target
#
# Output: dist-bin/ach-<os>-<arch>, plus dist-bin/SHA256SUMS covering
# whatever it just built (gitignored — see docs/PACKAGING.md).
#
# Web dashboard assets (index.html, grid.html, compare.html, trio.html,
# feed.js, vendor/xterm/*) are embedded directly into each binary: bun's
# --compile bundler inlines the `import("./x.html", { with: { type:
# "text" } })` loaders declared in src/web/assets.d.ts and wired up in
# src/web/server.ts's readAsset() — no extra `cp` step is needed here
# (unlike build:node in package.json, which copies the same files to
# disk next to the Node bundle so a filesystem-relative import works).
#
# bun-pty (the native Rust/FFI addon backing the browser terminal-pane
# PTY relay) is passed with --external: it ships a prebuilt .dylib/.so
# per platform that it dlopen()s at runtime by a path relative to its
# own node_modules location (see src/web/pty-manager.ts) — it cannot be
# embedded into a single-file --compile bundle. A standalone binary
# built by this script therefore has no bun-pty available at runtime:
# PtyManager.spawn() throws a HarnessError that the web server's PTY
# request handler already catches (src/web/server.ts), so the browser
# terminal pane reports an error instead of crashing the process; the
# rest of `ach web` (grid/compare/trio/stats/runs) is unaffected. `ach
# dash` (the terminal dashboard) never touches bun-pty at all — it is a
# plain ANSI-table renderer already gated on process.stdout.isTTY /
# NO_COLOR — so it degrades to its non-ansi mode the same way it always
# has, compiled binary or not.
#
# Cross-compiling to a NON-native target downloads that target's bun
# runtime (network required, cached by bun after the first run). A
# native-arch build (e.g. darwin-arm64 on Apple Silicon) needs no
# network at all.
set -u -o pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUTDIR="$REPO/dist-bin"
ENTRY="$REPO/src/cli/ach.ts"

if ! command -v bun >/dev/null 2>&1; then
  echo "error: bun is required to build standalone binaries (https://bun.sh)" >&2
  exit 1
fi

ALL_TARGETS="darwin-arm64 darwin-x64 linux-x64 linux-arm64"
ONLY="${1:-}"
if [ -n "$ONLY" ]; then
  case " $ALL_TARGETS " in
    *" $ONLY "*) TARGETS="$ONLY" ;;
    *)
      echo "error: unknown target '$ONLY' (expected one of: $ALL_TARGETS)" >&2
      exit 1
      ;;
  esac
else
  TARGETS="$ALL_TARGETS"
fi

mkdir -p "$OUTDIR"

built=""
fail=0
for t in $TARGETS; do
  out="$OUTDIR/ach-$t"
  echo "==> building $out (bun-$t)"
  if bun build --compile --target="bun-$t" --external bun-pty --outfile "$out" "$ENTRY"; then
    chmod +x "$out"
    built="$built $out"
  else
    echo "!! build failed for target '$t'" >&2
    fail=1
  fi
done

# Regenerate SHA256SUMS from whatever ach-<os>-<arch> binaries currently
# sit in dist-bin/ (not just the ones this invocation built), so re-running
# for a single target never leaves stale or missing entries for the rest.
if [ -n "$built" ] && command -v shasum >/dev/null 2>&1; then
  (
    cd "$OUTDIR" || exit 1
    rm -f SHA256SUMS
    for f in ach-*; do
      [ -f "$f" ] || continue
      shasum -a 256 "$f" >> SHA256SUMS
    done
  )
  echo "==> checksums: $OUTDIR/SHA256SUMS"
fi

exit "$fail"
