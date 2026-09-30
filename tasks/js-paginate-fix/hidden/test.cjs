"use strict";
const assert = require("node:assert/strict");
const path = require("node:path");
const ws = process.env.ACH_WORKSPACE || process.cwd();
let failed = 0;
function t(name, fn) {
  try {
    fn();
    console.log("ok   " + name);
  } catch (e) {
    failed++;
    console.log("FAIL " + name + "\n" + (e && e.message ? e.message : String(e)));
  }
}
process.on("exit", () => {
  if (failed > 0) process.exitCode = 1;
});

const { paginate } = require(path.join(ws, "paginate.js"));
const xs = [1, 2, 3, 4, 5, 6, 7];
t("first page", () => {
  const p = paginate(xs, 1, 3);
  assert.deepEqual(p.items, [1, 2, 3]);
  assert.equal(p.totalPages, 3);
  assert.equal(p.hasPrev, false);
  assert.equal(p.hasNext, true);
});
t("last partial page", () => {
  const p = paginate(xs, 3, 3);
  assert.deepEqual(p.items, [7]);
  assert.equal(p.hasNext, false);
  assert.equal(p.hasPrev, true);
});
t("past the end", () => assert.deepEqual(paginate(xs, 9, 3).items, []));
t("exact multiple", () => assert.equal(paginate([1, 2, 3, 4], 1, 2).totalPages, 2));
t("empty list", () => {
  const p = paginate([], 1, 5);
  assert.equal(p.totalPages, 0);
  assert.equal(p.hasNext, false);
  assert.equal(p.totalItems, 0);
});
t("bad arguments throw RangeError", () => {
  assert.throws(() => paginate(xs, 0, 3), RangeError);
  assert.throws(() => paginate(xs, 1, 0), RangeError);
  assert.throws(() => paginate(xs, 1.5, 3), RangeError);
});
