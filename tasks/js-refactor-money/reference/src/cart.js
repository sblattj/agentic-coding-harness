"use strict";

const { toCents, applyTax, formatUSD } = require("./money");

function cartTotal(items, taxPct) {
  let cents = 0;
  for (const it of items) cents += toCents(it.price) * it.qty;
  return formatUSD(applyTax(cents, taxPct));
}

module.exports = { cartTotal };
