#!/usr/bin/env node
// Stamp src/core/pricing-data.json with a snapshot date (issue #40).
//
//   node scripts/stamp-pricing-snapshot.mjs [YYYY-MM-DD] [--file PATH]
//
// Default date is today (UTC). Only the top-level `snapshotDate` key changes;
// the file's formatting and every model entry are left byte-for-byte alone.
// Run it after refreshing the model entries (see docs/TOKEN-COUNTING.md,
// "Refreshing the bundled price snapshot"). This script never touches the
// network: the LiteLLM extract is merged by hand from a file you downloaded.
import { readFileSync, writeFileSync } from "node:fs";

const argv = process.argv.slice(2);
let file = new URL("../src/core/pricing-data.json", import.meta.url).pathname;
let date = new Date().toISOString().slice(0, 10);
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--file") file = argv[++i] ?? file;
  else date = argv[i];
}
if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) {
  console.error(`stamp-pricing-snapshot: '${date}' is not a YYYY-MM-DD date`);
  process.exit(2);
}
const text = readFileSync(file, "utf8");
const re = /^(\s*"snapshotDate":\s*)"[^"]*"/m;
if (!re.test(text)) {
  console.error(`stamp-pricing-snapshot: no top-level "snapshotDate" key in ${file}`);
  process.exit(1);
}
writeFileSync(file, text.replace(re, `$1"${date}"`));
console.log(`stamped ${file} snapshotDate=${date}`);
