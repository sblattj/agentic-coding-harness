# Release packaging

Publish the npm package before pushing its matching `v<version>` tag. The
`Standalone release binaries` workflow runs on tags, or manually with an existing
tag. It does not publish npm. A tag must match `package.json` exactly.

## Standalone executables

```sh
npm ci
npm run build:standalone                             # all four targets
npm run build:standalone -- darwin-arm64 --out-dir /tmp/ach-build
node scripts/smoke-binary.mjs /tmp/ach-build/ach-darwin-arm64 --doctor
```

Building requires Bun. Running a compiled executable requires neither Bun nor Node.
The default output directory is `dist-bin`; `--out-dir` isolates tests and release
builds. `SHA256SUMS` covers only the targets built by that invocation. A failed build
removes the previous manifest so old checksums cannot masquerade as new success.
Cross-compilation downloads Bun runtimes on first use.

CI builds and runs each binary on its native runner:

| Artifact | Runner |
| --- | --- |
| `ach-darwin-arm64` | `macos-15` |
| `ach-darwin-x64` | `macos-15-intel` |
| `ach-linux-x64` | `ubuntu-24.04` |
| `ach-linux-arm64` | `ubuntu-24.04-arm` |

Each smoke runs the real executable from an empty directory with isolated state:
version, help, doctor JSON, empty stats, dashboard pages, terminal component HTML,
JavaScript and vendored xterm assets. A missing route is checked as a negative
control. The publish job waits for all four native checks, merges artifacts,
regenerates `SHA256SUMS`, and uploads the four executables plus checksums to the
GitHub release. A rerun replaces the same named assets. Download an executable,
verify its checksum, and `chmod +x` it before use.

The web server's `readAsset()` loads files from disk for source/npm execution and
uses text imports embedded by Bun for standalone execution. The `bun-pty` native
addon remains external: standalone builds support dashboard viewing, but live
browser PTY sessions require a package installation with that addon available.

## Homebrew tap

This repository is also its own tap; `Formula/ach.rb` is the canonical formula.

```sh
brew tap sblattj/agentic-coding-harness https://github.com/sblattj/agentic-coding-harness
brew install sblattj/agentic-coding-harness/ach
brew test sblattj/agentic-coding-harness/ach
```

The formula installs the npm package with Homebrew's Node dependency. It requires
neither Bun nor a working source checkout. The release workflow updates its URL
and SHA-256 after the binary jobs pass and the exact npm version is available.
`scripts/update-homebrew.mjs` downloads that registry tarball, verifies registry
SHA-1 and SHA-512 integrity, then computes SHA-256. The workflow commits only
`Formula/ach.rb` to the default branch with its repository-scoped `GITHUB_TOKEN`.
The branch must allow this automation commit; no cross-repository secret is used.
A manual dispatch for an old version is rejected if the default branch has moved
to another package version, preventing accidental formula downgrades.

For a local formula update after publishing npm:

```sh
node scripts/update-homebrew.mjs 0.11.0
brew update
brew reinstall sblattj/agentic-coding-harness/ach
brew test sblattj/agentic-coding-harness/ach
```

Review the URL and checksum together before committing. Local formula edits must
be copied into a scratch tap to test before publishing; `brew reinstall` uses the
published tap checkout, not the current source directory.
