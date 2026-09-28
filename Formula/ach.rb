# Updated on release tags by .github/workflows/release-binaries.yml.
class Ach < Formula
  desc "Run, watch, and meter coding agents with cost tracking and run artifacts"
  homepage "https://github.com/sblattj/agentic-coding-harness"

  # Bump both together at release time — see docs/PACKAGING.md ("Homebrew
  # formula: sha256 update procedure"). The version segment in the URL
  # does NOT track package.json automatically; update it by hand.
  url "https://registry.npmjs.org/agentic-coding-harness/-/agentic-coding-harness-0.11.2.tgz"
  sha256 "01f173874aa03708c9b1235d19f58f90958714c1a3988d284a565b5e1e6c23b2"
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
