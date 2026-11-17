// Single-file builds (bun-compiled binary, PyPI _vendor bundle) have no roles/ or
// desks.default.yaml on disk: the embedded copies must match the repo files, and the
// host must be re-spawned without the virtual /$bunfs argv[1].
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BUILTIN_DESK_ASSETS } from "../src/desks/builtin-assets.gen.ts";
import { materializeBuiltinAssets, parseLayout } from "../src/desks/config.ts";
import { achSelfArgv } from "../src/desks/self.ts";

const root = fileURLToPath(new URL("..", import.meta.url));

test("generated desk assets match desks.default.yaml and roles/*.md (run npm run gen:desks-assets)", async () => {
  // @ts-expect-error plain .mjs script, no types
  const { renderDeskAssets } = await import("../scripts/gen-desks-assets.mjs");
  assert.equal(readFileSync(join(root, "src/desks/builtin-assets.gen.ts"), "utf8"), renderDeskAssets(root));
  const roles = readdirSync(join(root, "roles")).filter((f) => f.endsWith(".md")).sort();
  assert.deepEqual(Object.keys(BUILTIN_DESK_ASSETS).filter((k) => k.startsWith("roles/")).sort(), roles.map((f) => `roles/${f}`));
});

test("materializeBuiltinAssets writes the embedded files, rewrites a changed one, and the layout parses", () => {
  const dir = mkdtempSync(join(tmpdir(), "desk-assets-"));
  try {
    assert.equal(materializeBuiltinAssets(dir), dir);
    for (const [rel, text] of Object.entries(BUILTIN_DESK_ASSETS)) assert.equal(readFileSync(join(dir, rel), "utf8"), text);
    writeFileSync(join(dir, "roles/common.md"), "tampered");
    materializeBuiltinAssets(dir);
    assert.equal(readFileSync(join(dir, "roles/common.md"), "utf8"), BUILTIN_DESK_ASSETS["roles/common.md"]);
    const f = join(dir, "desks.default.yaml");
    assert.ok(parseLayout(readFileSync(f, "utf8"), f).desks.length > 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("achSelfArgv drops a compiled binary's virtual argv[1], keeps a real script path", () => {
  const saved = process.argv[1];
  try {
    for (const v of ["/$bunfs/root/ach-darwin-arm64", "B:/~BUN/root/ach.exe"]) {
      process.argv[1] = v;
      assert.deepEqual(achSelfArgv({}), [process.execPath], v);
    }
    process.argv[1] = "/opt/ach/dist/cli/ach.js";
    assert.equal(achSelfArgv({}).at(-1), "/opt/ach/dist/cli/ach.js");
  } finally {
    process.argv[1] = saved as string;
  }
});
