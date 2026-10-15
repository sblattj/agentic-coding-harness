# Release packaging

The `Standalone release binaries` workflow runs on `v*` tags, or manually with an
existing tag. Its `npm` job publishes that tag's version to npm (with provenance),
skipping if the version is already published; the Homebrew job waits on it. A tag must match `package.json` exactly.

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

## Publishing to npm

The `npm` job publishes with npm trusted publishing (OIDC): no token or Actions
secret is involved. The job has `id-token: write`, upgrades to npm 11 (trusted
publishing needs npm 11.5.1+), and npm exchanges the job's GitHub OIDC token for a
short-lived publish credential. The package's npm settings (Settings, Trusted
Publisher) list GitHub Actions with repository `sblattj/agentic-coding-harness`,
workflow `release-binaries.yml`, no environment, and "Allow npm publish". If
that is missing or the workflow file is renamed, the publish fails with an
`::error::` saying so. Provenance is attached automatically. The job builds explicitly and runs `npm publish --ignore-scripts`
because `ci.yml` already gates tests on `main`; `prepack` still runs the full suite
for a local `npm publish`.

To backfill or retry a tag (publish is idempotent; an already-published version is
skipped):

```sh
gh workflow run release-binaries.yml -f tag=vX.Y.Z
```

## Publishing to PyPI

The `pypi` job publishes the Python wrapper (`python/`, which ships the committed
`_vendor/ach.mjs` bundle) with PyPI trusted publishing. It checks the tag matches
`python/pyproject.toml`, builds the wheel and sdist, installs the wheel into a
throwaway venv and checks `ach --version`, then uploads with
`pypa/gh-action-pypi-publish` (`skip-existing`, so a re-run is green). The PyPI
project's Publishing settings list GitHub publisher `sblattj/agentic-coding-harness`,
workflow `release-binaries.yml`, environment `pypi`. The same
`gh workflow run release-binaries.yml -f tag=vX.Y.Z` retries it.

A version older than npm's current `latest` is published under the `backfill` dist-tag, so a backfill never moves `latest` backwards. A backfill run's `homebrew` job fails its version check (the formula always tracks the default branch's version); that is expected and harmless.

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
