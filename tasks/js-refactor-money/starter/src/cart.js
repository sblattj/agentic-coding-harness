"use strict";

function cartTotal(items, taxPct) {
  let cents = 0;
  for (const it of items) cents += Math.round(it.price * 100) * it.qty;
  cents = cents + Math.round((cents * taxPct) / 100);
  const abs = Math.abs(cents);
  return (cents < 0 ? "-" : "") + "$" + Math.floor(abs / 100) + "." + String(abs % 100).padStart(2, "0");
}

module.exports = { cartTotal };
