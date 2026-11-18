import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, utimesSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname } from "node:path";
import { deskPaths, updateRoster } from "../src/desks/roster.ts";

test("a stale lock is reclaimed and leaves no .stale-* leftovers", async () => {
  const state = mkdtempSync(join_(tmpdir()));
  const p = deskPaths(state, "s1");
  mkdirSync(p.lock, { recursive: true });
  const old = new Date(Date.now() - 60_000);
  utimesSync(p.lock, old, old);
  await updateRoster(state, "s1", (r) => { r.portBase = 4801; });
  const left = readdirSync(dirname(p.lock)).filter((f) => f.includes(".stale-"));
  assert.deepEqual(left, []);
  assert.equal(existsSync(p.lock), false);
});
function join_(d: string): string { return mkdtempSync(d + "/stale-lock-"); }
