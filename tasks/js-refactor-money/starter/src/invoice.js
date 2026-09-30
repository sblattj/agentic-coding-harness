"use strict";

function invoiceLines(lines, taxPct) {
  return lines.map((l) => {
    let cents = Math.round(l.amount * 100);
    cents = cents + Math.round((cents * taxPct) / 100);
    const abs = Math.abs(cents);
    return l.label + ": " + (cents < 0 ? "-" : "") + "$" + Math.floor(abs / 100) + "." + String(abs % 100).padStart(2, "0");
  });
}

module.exports = { invoiceLines };
