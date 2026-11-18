import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deskPaths, readHostToken } from "../src/desks/roster.ts";

test("readHostToken rejects names that climb out of specs/ and still serves valid names", () => {
  const state = mkdtempSync(join(tmpdir(), "host-token-"));
  const { specs } = deskPaths(state, "s1");
  mkdirSync(specs, { recursive: true });
  writeFileSync(join(specs, "ALPHA.json"), JSON.stringify({ token: "tok-a" }));
  writeFileSync(join(specs, "lane-1.json"), JSON.stringify({ token: "tok-l" }));
  // outside specs/, reachable via ../
  writeFileSync(join(specs, "..", "outside.json"), JSON.stringify({ token: "stolen" }));
  assert.equal(readHostToken(state, "s1", "../outside"), undefined);
  assert.equal(readHostToken(state, "s1", "../../s1/outside"), undefined);
  assert.equal(readHostToken(state, "s1", "ALPHA"), "tok-a");
  assert.equal(readHostToken(state, "s1", "lane-1"), "tok-l");
});
