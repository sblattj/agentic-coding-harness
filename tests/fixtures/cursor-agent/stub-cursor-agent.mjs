#!/usr/bin/env node
// Stand-in for the `cursor-agent` binary. Synthetic: the stream-json shapes follow
// cursor.com/docs/cli/reference/output-format and the cost-bench `usage` object
// (a live, authenticated CLI was not available). Mode via STUB_CURSOR_MODE:
//   computed (default)  result carries tokens, no cost    reported  tokens + total_cost_usd
//   no-usage            result carries neither            run-error result is_error
//   logged-out          `status` says "Not logged in" (exit 0), like the real CLI; a run would fail
//   run-auth            `status` is fine but the run fails with the real unauthenticated error
// STUB_CURSOR_ARGV=<file> records the argv of the main run as JSON;
// STUB_CURSOR_STATUS=<file> is appended to when `status` is invoked.
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const mode = process.env.STUB_CURSOR_MODE ?? 'computed';
if (argv[0] === '--version') {
  console.log('2026.10.01-stub');
  process.exit(0);
}
if (argv[0] === 'status') {
  if (process.env.STUB_CURSOR_STATUS) appendFileSync(process.env.STUB_CURSOR_STATUS, 'status\n');
  console.log(mode === 'logged-out' ? 'Not logged in' : 'Logged in as synthetic@example.invalid');
  process.exit(0);
}
if (process.env.STUB_CURSOR_ARGV) writeFileSync(process.env.STUB_CURSOR_ARGV, JSON.stringify(argv));
if (mode === 'run-auth' || mode === 'logged-out') {
  process.stderr.write("Error: Authentication required. Please run 'agent login' first, or set CURSOR_API_KEY environment variable.\n");
  process.exit(1);
}
const resume = argv.indexOf('--resume') >= 0 ? argv[argv.indexOf('--resume') + 1] : undefined;
const sid = resume ?? '5b6f8f4e-0d6c-4c53-9f5c-3b0a7c7d9e22';
const file = { computed: 'stream-computed.jsonl', reported: 'stream-reported.jsonl', 'no-usage': 'stream-no-usage.jsonl', 'run-error': 'stream-run-error.jsonl' }[mode];
process.stdout.write(readFileSync(join(here, file), 'utf8').replaceAll('__SID__', sid), () => process.exit(mode === 'run-error' ? 1 : 0));
