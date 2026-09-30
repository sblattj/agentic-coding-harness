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

const fs = require("node:fs");
const src = (f) => fs.readFileSync(path.join(ws, "src", f), "utf8");
const money = require(path.join(ws, "src", "money.js"));
const { cartTotal } = require(path.join(ws, "src", "cart.js"));
const { invoiceLines } = require(path.join(ws, "src", "invoice.js"));
t("money.toCents", () => {
  assert.equal(money.toCents(1.25), 125);
  assert.equal(money.toCents(0.1 + 0.2), 30);
});
t("money.applyTax", () => {
  assert.equal(money.applyTax(1000, 8.25), 1083);
  assert.equal(money.applyTax(999, 0), 999);
});
t("money.formatUSD", () => {
  assert.equal(money.formatUSD(5), "$0.05");
  assert.equal(money.formatUSD(-310), "-$3.10");
  assert.equal(money.formatUSD(123456789), "$1,234,567.89");
});
t("cartTotal behaviour", () => {
  assert.equal(cartTotal([{ price: 1.25, qty: 2 }, { price: 0.1, qty: 3 }], 10), "$3.08");
  assert.equal(cartTotal([{ price: 600, qty: 2 }], 0), "$1,200.00");
});
t("invoiceLines behaviour", () => {
  assert.deepEqual(invoiceLines([{ label: "A", amount: 9.99 }, { label: "B", amount: -1 }], 10), ["A: $10.99", "B: -$1.10"]);
});
for (const f of ["cart.js", "invoice.js"]) {
  t(`${f} uses ./money and has no inline copy`, () => {
    const s = src(f);
    assert.match(s, /require\(\s*["']\.\/money(\.js)?["']\s*\)/);
    assert.doesNotMatch(s, /Math\.round|padStart/);
  });
}
t("visible test still passes", () => {
  const r = require("node:child_process").spawnSync(process.execPath, [path.join(ws, "test", "run.js")], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
});
