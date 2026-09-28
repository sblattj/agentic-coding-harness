import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

// ---------------------------------------------------------------------------
// scripts/build-binaries.sh (integration, real subprocess)
//
// Builds a real `bun build --compile` standalone executable and runs it —
// the regression this guards against is real: `invokedAsCli()` in
// src/cli/ach.ts used to compare `realpathSync(argv[1])` against
// `realpathSync(fileURLToPath(import.meta.url))`, and in a compiled binary
// BOTH of those raw paths collapse to the same synthetic `/$bunfs/root/...`
// path that realpathSync cannot resolve (ENOENT — no real inode) — so the
// CLI silently printed nothing and exited 0 for every subcommand.
//
// No network: this test builds only the NATIVE target (current
// process.platform/arch), which bun already has locally. Cross-compiling to
// a foreign target downloads that target's bun runtime on first use, so
// that path is exercised by scripts/build-binaries.sh itself, not here.
const REPO_ROOT = new URL("..", import.meta.url).pathname;
const SCRIPT = join(REPO_ROOT, "scripts", "build-binaries.sh");
const DIST_BIN = mkdtempSync(join(tmpdir(), "ach-binaries-test-"));

function nativeTarget(): string | null {
  const os = process.platform === "darwin" ? "darwin" : process.platform === "linux" ? "linux" : null;
  const arch = process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "x64" : null;
  return os && arch ? `${os}-${arch}` : null;
}

function bunAvailable(): boolean {
  const r = spawnSync("bun", ["--version"], { encoding: "utf8" });
  return r.status === 0;
}

const target = nativeTarget();
after(() => rmSync(DIST_BIN, { recursive: true, force: true }));

describe("scripts/build-binaries.sh", () => {
  it("exists and is executable", () => {
    assert.ok(existsSync(SCRIPT), `expected ${SCRIPT} to exist`);
    const mode = statSync(SCRIPT).mode;
    assert.ok((mode & 0o111) !== 0, "expected build-binaries.sh to be executable");
  });

  it("rejects an unknown target with a non-zero exit and no compile attempt", (t) => {
    if (!bunAvailable()) {
      t.skip("bun not on PATH");
      return;
    }
    const r = spawnSync("bash", [SCRIPT, "bogus-target", "--out-dir", DIST_BIN], { encoding: "utf8" });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /unknown target 'bogus-target'/);
    assert.ok(!existsSync(join(DIST_BIN, "ach-bogus-target")));
  });

  it("rejects a missing output directory", () => {
    const result = spawnSync("bash", [SCRIPT, "--out-dir"], { encoding: "utf8" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /--out-dir needs a directory/);
  });

  it("builds the native-target binary and it actually runs --version / help", (t) => {
    if (!bunAvailable()) {
      t.skip("bun not on PATH");
      return;
    }
    if (target === null) {
      t.skip(`no native target mapping for ${process.platform}/${process.arch}`);
      return;
    }
    const outPath = join(DIST_BIN, `ach-${target}`);

    const unrelated = join(DIST_BIN, "ach-unrelated");
    writeFileSync(unrelated, "preserve existing output");
    const build = spawnSync("bash", [SCRIPT, target, "--out-dir", DIST_BIN], { encoding: "utf8" });
    assert.equal(build.status, 0, `build failed: ${build.stderr}`);
    assert.ok(existsSync(outPath), `expected compiled binary at ${outPath}`);

    assert.equal(readFileSync(unrelated, "utf8"), "preserve existing output");
    const hash = createHash("sha256").update(readFileSync(outPath)).digest("hex");
    assert.equal(readFileSync(join(DIST_BIN, "SHA256SUMS"), "utf8"), `${hash}  ach-${target}\n`);

    const smoke = spawnSync(process.execPath, [join(REPO_ROOT, "scripts/smoke-binary.mjs"), outPath], { encoding: "utf8" });
    assert.equal(smoke.status, 0, smoke.stdout + smoke.stderr);

    const version = spawnSync(outPath, ["--version"], { encoding: "utf8" });
    assert.equal(version.status, 0, `--version exited ${version.status}: ${version.stderr}`);
    assert.match(version.stdout.trim(), /^\d+\.\d+\.\d+$/, `expected a semver on stdout, got: ${JSON.stringify(version.stdout)}`);

    const help = spawnSync(outPath, ["help"], { encoding: "utf8" });
    assert.equal(help.status, 0, `help exited ${help.status}: ${help.stderr}`);
    assert.match(help.stdout, /agentic-coding-harness/);
    assert.match(help.stdout, /usage:/);
  });
});
