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

const { parseDuration } = require(path.join(ws, "duration.js"));
t("single units", () => {
  assert.equal(parseDuration("250ms"), 250);
  assert.equal(parseDuration("2s"), 2000);
  assert.equal(parseDuration("3m"), 180000);
  assert.equal(parseDuration("1h"), 3600000);
  assert.equal(parseDuration("2d"), 172800000);
});
t("combinations and whitespace", () => {
  assert.equal(parseDuration("1h30m"), 5400000);
  assert.equal(parseDuration(" 1h 30m 5s "), 5405000);
  assert.equal(parseDuration("1m250ms"), 60250);
});
t("decimals round to ms", () => {
  assert.equal(parseDuration("1.5s"), 1500);
  assert.equal(parseDuration("0.0005s"), 1);
});
t("invalid input throws TypeError", () => {
  for (const bad of ["", "   ", "10", "5x", "h", "-1s", "1h 2", "1 h"]) {
    assert.throws(() => parseDuration(bad), TypeError, JSON.stringify(bad));
  }
  assert.throws(() => parseDuration(5), TypeError);
});
