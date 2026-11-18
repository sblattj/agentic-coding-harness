import "./support/no-network.mjs";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { loadLayout } from "../src/desks/config.ts";

const dir = realpathSync(mkdtempSync(join(tmpdir(), "desks-rolesdir-")));
after(() => rmSync(dir, { recursive: true, force: true }));

const load = (rolesDir: string): string | undefined => {
  const f = join(dir, "desks.yaml");
  writeFileSync(f, `rolesDir: ${rolesDir}\ndesks:\n  - {name: A, role: r}\n`);
  return loadLayout(f).layout.rolesDir;
};

describe("rolesDir tilde", () => {
  it("expands ~/x to the home directory, not the layout dir", () => {
    assert.equal(load("~/x"), join(homedir(), "x"));
  });
  it("expands a bare ~", () => {
    assert.equal(load("'~'"), homedir());
  });
  it("still resolves other relative paths against the layout file", () => {
    assert.equal(load("roles"), join(dir, "roles"));
  });
});
