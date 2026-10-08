#!/usr/bin/env node
// Stand-in for the `copilot` binary (GitHub Copilot CLI 1.0.93 behaviour,
// observed): prints JSONL events on stdout, then at exit writes the
// --usage-output-file JSON and appends a session.shutdown record to
// <COPILOT_HOME>/session-state/<id>/events.jsonl. Both are CUMULATIVE for a
// resumed session. Mode via STUB_COPILOT_MODE:
//   ok (default)  AIU telemetry present        no-aiu   tokens, no totalNanoAiu
//   no-telemetry  neither file written         inline   stdout model_call_success AIU only
//   auth          "No authentication information found." exit 1
//   policy        "Access denied by policy settings" exit 1
// STUB_COPILOT_ARGV=<file> records argv as JSON.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
if (process.env.STUB_COPILOT_ARGV) writeFileSync(process.env.STUB_COPILOT_ARGV, JSON.stringify(argv));
if (argv[0] === '--version') {
  console.log('GitHub Copilot CLI 1.0.93.');
  process.exit(0);
}
const flag = (name) => {
  const eq = argv.find((a) => a.startsWith(`${name}=`));
  if (eq) return eq.slice(name.length + 1);
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const mode = process.env.STUB_COPILOT_MODE ?? 'ok';

if (mode === 'auth') {
  process.stderr.write("Error: No authentication information found.\n\nCopilot can be authenticated with GitHub using an OAuth Token or a Fine-Grained Personal Access Token.\n");
  process.exit(1);
}
if (mode === 'policy') {
  process.stderr.write('Error: Access denied by policy settings (Request ID: TEST:0:0:0:0)\n\nYour Copilot CLI policy setting may be preventing access.\n');
  process.exit(1);
}

const sid = flag('--session-id') ?? flag('--resume') ?? '00000000-0000-4000-8000-0000000000aa';
const home = process.env.COPILOT_HOME;
const eventsPath = home ? join(home, 'session-state', sid, 'events.jsonl') : undefined;
const stdoutFile = mode === 'inline' ? 'stdout-inline-aiu.jsonl' : 'stdout-run.jsonl';
const out = readFileSync(join(here, stdoutFile), 'utf8').replaceAll('__SID__', sid);

const readLastShutdown = () => {
  if (!eventsPath || !existsSync(eventsPath)) return null;
  const lines = readFileSync(eventsPath, 'utf8').split('\n').filter((l) => l.includes('session.shutdown'));
  return lines.length ? JSON.parse(lines[lines.length - 1]).data : null;
};
const addSummaries = (prev, add) => {
  if (!prev) return add;
  const sum = (a, b) => (a === undefined && b === undefined ? undefined : (a ?? 0) + (b ?? 0));
  const metrics = {};
  for (const m of new Set([...Object.keys(prev.modelMetrics), ...Object.keys(add.modelMetrics)])) {
    const p = prev.modelMetrics[m];
    const a = add.modelMetrics[m];
    metrics[m] = {
      requests: { count: sum(p?.requests.count, a?.requests.count), cost: 0 },
      usage: Object.fromEntries(['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'].map((k) => [k, sum(p?.usage[k], a?.usage[k])])),
      ...(sum(p?.totalNanoAiu, a?.totalNanoAiu) !== undefined ? { totalNanoAiu: sum(p?.totalNanoAiu, a?.totalNanoAiu) } : {}),
    };
  }
  return { ...add, ...(sum(prev.totalNanoAiu, add.totalNanoAiu) !== undefined ? { totalNanoAiu: sum(prev.totalNanoAiu, add.totalNanoAiu) } : {}), modelMetrics: metrics };
};

process.stdout.write(out, () => {
  if (mode !== 'no-telemetry' && mode !== 'inline') {
    const base = JSON.parse(readFileSync(join(here, mode === 'no-aiu' ? 'usage-no-aiu.json' : 'usage-aiu.json'), 'utf8'));
    const final = addSummaries(readLastShutdown(), base);
    const usageFile = flag('--usage-output-file');
    if (usageFile) writeFileSync(usageFile, JSON.stringify(final));
    if (eventsPath) {
      mkdirSync(dirname(eventsPath), { recursive: true });
      appendFileSync(eventsPath, `${JSON.stringify({ type: 'session.shutdown', data: { shutdownType: 'routine', ...final }, id: '00000000-0000-4000-8000-0000000000bb', timestamp: '2026-01-02T03:04:08.000Z', parentId: null })}\n`);
    }
  }
  process.exit(0);
});
