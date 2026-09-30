"use strict";

const UNIT_MS = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
const PART = /(\d+(?:\.\d+)?)(ms|s|m|h|d)?\s*/y;

function parseDuration(text) {
  if (typeof text !== "string") throw new TypeError("duration must be a string");
  const s = text.trim();
  if (s === "") throw new TypeError("empty duration");
  let total = 0;
  PART.lastIndex = 0;
  while (PART.lastIndex < s.length) {
    const start = PART.lastIndex;
    const m = PART.exec(s);
    if (m === null) throw new TypeError(`invalid duration at "${s.slice(start)}"`);
    total += Number(m[1]) * UNIT_MS[m[2] ?? "ms"];
  }
  return Math.round(total);
}

module.exports = { parseDuration };
