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

const { LRUCache } = require(path.join(ws, "lru.js"));
t("capacity validation", () => {
  assert.throws(() => new LRUCache(0), RangeError);
  assert.throws(() => new LRUCache(1.5), RangeError);
});
t("basic get/set/size", () => {
  const c = new LRUCache(2);
  assert.equal(c.set("a", 1), c);
  c.set("b", 2);
  assert.equal(c.get("a"), 1);
  assert.equal(c.get("zz"), undefined);
  assert.equal(c.size, 2);
});
t("get refreshes recency", () => {
  const c = new LRUCache(2);
  c.set("a", 1).set("b", 2);
  c.get("a");
  c.set("c", 3);
  assert.equal(c.has("a"), true);
  assert.equal(c.has("b"), false);
});
t("has does not refresh recency", () => {
  const c = new LRUCache(2);
  c.set("a", 1).set("b", 2);
  c.has("a");
  c.set("c", 3);
  assert.equal(c.has("a"), false);
});
t("update moves to most recent", () => {
  const c = new LRUCache(2);
  c.set("a", 1).set("b", 2).set("a", 10).set("c", 3);
  assert.equal(c.get("a"), 10);
  assert.equal(c.has("b"), false);
  assert.equal(c.size, 2);
});
t("delete", () => {
  const c = new LRUCache(3);
  c.set("a", 1);
  assert.equal(c.delete("a"), true);
  assert.equal(c.delete("a"), false);
  assert.equal(c.size, 0);
});
