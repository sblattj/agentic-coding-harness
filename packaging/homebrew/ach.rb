# packaging/homebrew/ach.rb — Homebrew formula for the `ach` CLI.
#
# NOT tapped or published anywhere yet. This file lives in-repo so it can be
# reviewed, tested locally, and eventually copied into a `homebrew-tap`
# repo (or submitted to homebrew-core) as a separate, later step.
#
# `url`/`sha256` below pin the latest npm-published version as of this
# writing (0.10.1) and were verified end-to-end on 2026-09-27: `brew
# tap-new`, drop this file in as Formula/ach.rb, `brew install
# <tap>/ach`, `ach --version`, and `brew test <tap>/ach` all passed.
# EVERY subsequent release needs the same two values bumped together —
# see docs/PACKAGING.md ("Homebrew formula: sha256 update procedure") for
# the exact commands; a stale pin here fails brew's download-integrity
# check, not a silent wrong-version install.
#
# Installs the built npm package (dist/cli/ach.js, a `#!/usr/bin/env node`
# bundle — no bun required at runtime) via the standard Homebrew
# Node.js-application pattern (see
# https://docs.brew.sh/Language-Specific-Formulae#nodejs, "Standard npm
# installation"): `std_npm_args` installs the package into `libexec` using
# npm's global layout, then `bin.install_symlink` links the declared `bin`
# entry (package.json `"bin": { "ach": "./dist/cli/ach.js" }`) into the
# formula's own `bin/`.
class Ach < Formula
  desc "Run, watch, and meter coding agents with cost tracking and run artifacts"
  homepage "https://github.com/sblattj/agentic-coding-harness"

  # Bump both together at release time — see docs/PACKAGING.md ("Homebrew
  # formula: sha256 update procedure"). The version segment in the URL
  # does NOT track package.json automatically; update it by hand.
  url "https://registry.npmjs.org/agentic-coding-harness/-/agentic-coding-harness-0.10.1.tgz"
  sha256 "5ec7c07683a5fbb8722fc185e2b18efe9f1746cb2ee51604e36f782fe6c0b661"
  license "MIT"

  depends_on "node"

  def install
    system "npm", "install", *std_npm_args
    bin.install_symlink libexec.glob("bin/*")
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/ach --version")

    # Smoke test against an empty, isolated state dir (never the real
    # user state dir): --state-only skips machine transcript directories
    # so the test needs no local agent CLIs and touches no live network.
    ENV["AGENTIC_CODING_HARNESS_STATE_DIR"] = testpath.to_s
    out = shell_output("#{bin}/ach stats --json --state-only")
    require "json"
    stats = JSON.parse(out)
    assert_equal 0, stats["total"]["records"]
  end
end
