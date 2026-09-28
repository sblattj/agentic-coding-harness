# Packaging: single-file binaries and the Homebrew formula

> **STATUS:** written against the actual scripts — build = `scripts/build-binaries.sh`,
> formula = `packaging/homebrew/ach.rb`, embedded-asset fallback = `src/web/server.ts`
> (`readAsset`) / `src/web/assets.d.ts`. Verified 2026-09-27 on macOS arm64 (see each
> section below for exactly what was run and what came back).

Neither of these is tapped, released, or published anywhere. This doc is the procedure
for a maintainer to do that later; running it does not itself publish anything.

## 1. Single-file binaries (`scripts/build-binaries.sh`)

```sh
scripts/build-binaries.sh                # all four targets
scripts/build-binaries.sh darwin-arm64    # just one
```

Produces `dist-bin/ach-<os>-<arch>` for `darwin-arm64`, `darwin-x64`, `linux-x64`,
`linux-arm64` via `bun build --compile --target=bun-<os>-<arch> src/cli/ach.ts`, plus a
`dist-bin/SHA256SUMS` covering whatever is currently in `dist-bin/`. `dist-bin/` is
gitignored — these are build outputs, not source.

**No node/bun runtime is required to RUN the resulting binary.** Building it still
requires `bun` on PATH; cross-compiling to a non-native target downloads that target's
bun runtime on first use (network required — the native-arch target needs none).

### Why this needed a source fix, not just a build script

`bun build --compile` was already the right primitive, and the web dashboard's asset
loader (`readAsset()` in `src/web/server.ts`, declarations in `src/web/assets.d.ts`) was
already written to embed `index.html`/`grid.html`/`compare.html`/`trio.html`/`feed.js`/
`vendor/xterm/*` into a compiled bundle via `import("./x.html", { with: { type: "text" }
})` — disk copy first, embedded fallback second. That part needed no changes at all.

What did need a fix: `invokedAsCli()` in `src/cli/ach.ts` used to compare
`realpathSync(process.argv[1])` against `realpathSync(fileURLToPath(import.meta.url))`
to decide whether to run `main()` at all. In a `bun build --compile` executable, BOTH of
those raw paths collapse to the identical synthetic `/$bunfs/root/<name>` path baked in
at compile time (confirmed with a throwaway probe script — the value is fixed at compile
time and does not change based on the real on-disk filename or how the binary is
invoked). `realpathSync` throws `ENOENT` on that path (no real inode), so the old code's
`catch { return false; }` made every compiled binary a silent no-op: `ach --version`
printed nothing and exited 0. The fix falls back to a raw string comparison when
`realpathSync` throws, which is exactly true in the compiled case and exactly what the
original check already covered in the normal-filesystem case. See the regression test in
`tests/build-binaries.test.ts` (compiles the native target for real and asserts
`--version`/`help` actually produce output — it fails RED against the pre-fix code).

### bun-pty (the browser terminal pane's native PTY relay)

Passed with `--external bun-pty` — it ships prebuilt `.dylib`/`.so` per platform that it
`dlopen()`s via `bun:ffi` at a path relative to its own `node_modules` location (see
`src/web/pty-manager.ts`), so it cannot be embedded into a single-file bundle. A
standalone binary therefore has no `bun-pty` available at runtime. That is already a
handled, non-fatal path: `PtyManager.spawn()` throws a `HarnessError` that the web
server's PTY request handler already catches — the browser terminal pane reports an
error instead of taking the process down; the rest of `ach web` (grid/compare/trio/
stats/runs) is unaffected. `ach dash` (the terminal dashboard) never touches `bun-pty` at
all — it is a plain ANSI-table renderer already gated on `process.stdout.isTTY`/
`NO_COLOR` (`src/cli/dash.ts`), so it degrades to its non-ansi mode the same way it
always has, compiled binary or not.

### What was actually verified (macOS arm64, this machine)

- `bun build --compile --target=bun-darwin-arm64 --external bun-pty src/cli/ach.ts
  --outfile dist-bin/ach-darwin-arm64` — builds in well under a second, no network.
- `./dist-bin/ach-darwin-arm64 --version` → `0.10.1`, exit 0.
- `./dist-bin/ach-darwin-arm64 help` → full usage text, exit 0.
- `AGENTIC_CODING_HARNESS_STATE_DIR=<empty tmp dir> ./dist-bin/ach-darwin-arm64 stats
  --json --state-only` → the empty-totals JSON envelope, exit 0 (there is no `ach doctor`
  subcommand in this codebase to smoke-test — that half of issue #82's acceptance
  criterion references a subcommand that does not exist here; out of scope for this
  change, which adds no new CLI surface).
- `./dist-bin/ach-darwin-arm64 web --port <free-port> --dir <empty tmp dir> --no-open`,
  then `curl` of `/` and `/feed.js` on that port both returned `200` with real HTML/JS
  content (served from the embedded fallback — there is no sibling `index.html` next to
  a single-file binary), then the process was killed.
- Cross-compile smoke: `--target=bun-darwin-x64`, `bun-linux-x64`, `bun-linux-arm64` each
  produced a correctly-architected binary (checked with `file`: Mach-O x86_64, ELF
  x86-64, ELF aarch64 respectively). Only the native darwin-arm64 binary could be
  runtime-verified on this machine — the other three are build-verified only (this repo
  has no Linux/x64 host in CI yet to run them on).

## 2. Homebrew formula (`packaging/homebrew/ach.rb`)

Installs the built npm package (`dist/cli/ach.js`, a `#!/usr/bin/env node` bundle) via
Homebrew's standard Node.js-application pattern
(<https://docs.brew.sh/Language-Specific-Formulae#nodejs>, "Standard npm installation"):
`std_npm_args` installs into `libexec` using npm's global layout, `bin.install_symlink`
links the package's declared `bin` entry into the formula's own `bin/`. `depends_on
"node"` — no bun needed at runtime for this install path (the Node build already copies
the web assets to disk next to `dist/cli/ach.js`, so `readAsset()` finds them there
directly; the embedded-bundle fallback above is for the `--compile` binaries, not this
path).

This file is **not** in a real tap — Homebrew (7.x) flatly refuses `brew install
--formula <path>` for any file that is not inside a proper tap. To actually run it:

```sh
brew tap-new local/ach-test          # one-time scratch tap
cp packaging/homebrew/ach.rb "$(brew --repository local/ach-test)/Formula/ach.rb"
cd "$(brew --repository local/ach-test)" && git add Formula/ach.rb && git commit -m wip
brew install local/ach-test/ach
ach --version
brew test local/ach-test/ach
brew uninstall ach && brew untap local/ach-test   # clean up afterward
```

### What was actually verified (macOS arm64, this machine, 2026-09-27)

Ran exactly the sequence above. `brew install local/ach-test/ach` installed `node` and
its transitive deps as bottles, then built `ach` (`npm install --global
--build-from-source --min-release-age= ...`) — **35.8MB, 4,454 files, built in 24s**.
`ach --version` (via the installed `/opt/homebrew/bin/ach` symlink) printed `0.10.1`,
exit 0. `brew test local/ach-test/ach` ran both lines from the `test do` block
(`ach --version`, `ach stats --json --state-only` against an isolated
`AGENTIC_CODING_HARNESS_STATE_DIR`) and exited 0. Both acceptance checks in issue #81
("`ach --version` works without bun or a repo checkout", "the formula's `test` block
passes under `brew test`") pass as written, today, against the currently-pinned version.
Afterward: `brew uninstall ach` (autoremoved every dependency it had installed —
`node`, `abseil`, `fmt`, `ada-url`, `hdrhistogram_c`, `libffi`, `libuv`, `simdutf`,
`merve`, `nbytes`, `simdjson`, `uvwasi`, `highway` — formula count back to its exact
pre-install baseline) and `brew untap local/ach-test`. One residual side effect: the
install upgraded a few already-installed shared deps (`ca-certificates`, `readline`,
`libuv`, `xz`) to newer versions already queued as "outdated" on this machine; Homebrew
does not downgrade on uninstall, so those upgrades are not reverted, and were not
attempted to be reverted here as it would risk breaking a live install.

**Explicitly out of scope here** (belongs to a follow-up, not this doc): creating a real
`sblattj/homebrew-ach` (or similar) tap repo, a release-CI job that bumps this formula on
tag, and README changes recommending `brew install` to end users before the formula is
actually reachable via a real tap. Committing this formula and this doc does not publish
anything — no tap or repo was created as part of this work.

### Homebrew formula: sha256 update procedure

`url`/`sha256` in `packaging/homebrew/ach.rb` pin one exact npm-published tarball. They do
NOT track `package.json`'s version automatically — bump both together, by hand, every
time a new version is published to npm:

```sh
# 1. Confirm the version is actually published (npm publish already happened):
npm view agentic-coding-harness versions --json | tail -3

# 2. Get the tarball URL for the version you're packaging, and its registry-reported
#    sha1 (used only as an authenticity cross-check against what you download):
npm view agentic-coding-harness@<version> dist.tarball
npm view agentic-coding-harness@<version> dist.shasum

# 3. Download that exact tarball and compute BOTH checksums locally:
curl -sL -o ach.tgz "$(npm view agentic-coding-harness@<version> dist.tarball)"
shasum -a 1   ach.tgz   # must equal step 2's dist.shasum, or the download is not trustworthy
shasum -a 256 ach.tgz   # this is the value that goes into the formula

# 4. Update packaging/homebrew/ach.rb: the `<version>` in the `url` line and the
#    `sha256` line, together, to the values from steps 2-3.

# 5. Re-verify with the scratch-tap sequence in this doc before shipping the change.
```

The current pin (`0.10.1`) was produced and verified with exactly this procedure — see
"What was actually verified" above.
