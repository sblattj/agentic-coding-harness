"use strict";

const { toCents, applyTax, formatUSD } = require("./money");

function invoiceLines(lines, taxPct) {
  return lines.map((l) => `${l.label}: ${formatUSD(applyTax(toCents(l.amount), taxPct))}`);
}

module.exports = { invoiceLines };
