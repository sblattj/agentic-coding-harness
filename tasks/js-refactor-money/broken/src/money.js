"use strict";

/** Dollars (number) to integer cents. */
function toCents(amount) {
  return Math.round(amount * 100);
}

/** Add tax (a percentage) to an amount in cents, rounding the tax to a cent. */
function applyTax(cents, ratePct) {
  return cents + Math.round((cents * ratePct) / 100);
}

/** Integer cents to "$1,234.56" / "-$0.05". */
function formatUSD(cents) {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  const dollars = String(Math.floor(abs / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${sign}$${dollars}.${String(abs % 100).padStart(2, "0")}`;
}

module.exports = { toCents, applyTax, formatUSD };
