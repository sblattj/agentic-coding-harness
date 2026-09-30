"use strict";
const assert = require("node:assert/strict");
const { cartTotal } = require("../src/cart.js");
const { invoiceLines } = require("../src/invoice.js");

assert.equal(cartTotal([{ price: 1.25, qty: 2 }, { price: 0.1, qty: 3 }], 10), "$3.08");
assert.deepEqual(invoiceLines([{ label: "Widget", amount: 9.99 }], 0), ["Widget: $9.99"]);
console.log("ok");
