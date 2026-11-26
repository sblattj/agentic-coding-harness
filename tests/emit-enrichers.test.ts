// #95: custom enrichers (static attrs + env-var mappings) on OTel / Langfuse /
// ATIF exports, through the pure builders, the `ach emit` CLI, the config
// file `emit` section and the MCP harness_emit tool.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { InMemorySpanExporter, NodeTracerProvider, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-node';
import { loadEnricher, resolveEnrichAttributes, runEnricher, sanitizeEnrichAttributes, type EnricherInput } from '../src/emitters/enrich.ts';
import { emitRun, toOtlpJson, type OtlpSpanJson } from '../src/emitters/otel.ts';
import { emitToLangfuse, toLangfuseOtlpJson } from '../src/emitters/langfuse.ts';
import { AtifWriter } from '../src/emitters/atif.ts';
import { registerInspectTools } from '../src/mcp/tools-inspect.ts';
import type { McpServer, McpToolDef } from '../src/mcp/contract.ts';
import type { AgentEvent } from '../src/core/types.ts';

const CLI = new URL('../src/cli/ach.ts', import.meta.url).pathname;
const T0 = Date.parse('2026-09-10T12:00:00Z');

function events(): AgentEvent[] {
  return [
    { type: 'message', source: 'user', content: 'hi', timestamp: T0 },
    { type: 'tool_call', toolCallId: 'c1', functionName: 'Bash', arguments: {}, timestamp: T0 + 100 },
    { type: 'tool_result', toolCallId: 'c1', content: 'ok', timestamp: T0 + 200 },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.001 }, timestamp: T0 + 300 },
    { type: 'message', source: 'agent', content: 'done', timestamp: T0 + 400 },
  ];
}

const base = { sessionId: 'sess-1', agentName: 'agent-x', model: 'model-y' };

function attrOf(span: OtlpSpanJson, key: string): unknown {
  const a = span.attributes.find((x) => x.key === key);
  return a === undefined ? undefined : (a.value.stringValue ?? a.value.intValue);
}

type Doc = { resourceSpans: { resource: { attributes: { key: string; value: { stringValue?: string } }[] }; scopeSpans: { spans: OtlpSpanJson[] }[] }[] };
const spansOf = (doc: Doc): OtlpSpanJson[] => doc.resourceSpans[0]!.scopeSpans[0]!.spans;
const resourceOf = (doc: Doc): Record<string, string | undefined> =>
  Object.fromEntries(doc.resourceSpans[0]!.resource.attributes.map((a) => [a.key, a.value.stringValue]));

describe('resolveEnrichAttributes (#95)', () => {
  it('static key=value entries become attributes (value may contain =)', () => {
    const r = resolveEnrichAttributes({ attrs: ['team=platform', 'environment=staging', 'q=a=b'] }, {});
    assert.deepEqual(r.attributes, { team: 'platform', environment: 'staging', q: 'a=b' });
    assert.deepEqual(r.warnings, []);
  });

  it('env mappings read the runtime env when present', () => {
    const r = resolveEnrichAttributes({ attrEnv: ['ci.build_id=BUILD_NUMBER', 'vcs.sha=GIT_COMMIT'] }, { BUILD_NUMBER: '77', GIT_COMMIT: 'abc123' });
    assert.deepEqual(r.attributes, { 'ci.build_id': '77', 'vcs.sha': 'abc123' });
    assert.deepEqual(r.warnings, []);
  });

  it('a missing or empty env var is skipped with one warning, never an empty attribute', () => {
    const r = resolveEnrichAttributes({ attrEnv: ['ci.build_id=BUILD_NUMBER', 'x=EMPTY_ONE'] }, { EMPTY_ONE: '' });
    assert.deepEqual(r.attributes, {});
    assert.equal(r.warnings.length, 2);
    assert.match(r.warnings[0]!, /env BUILD_NUMBER is not set; skipped/);
  });

  it('malformed entries fail open: warning + skip, no throw', () => {
    const r = resolveEnrichAttributes({ attrs: ['noequals', '=v', 'ok=1'], attrEnv: ['k=not a name', 'bare'] }, {});
    assert.deepEqual(r.attributes, { ok: '1' });
    assert.equal(r.warnings.length, 4);
  });

  it('an env mapping overrides a static entry with the same key when set', () => {
    const r = resolveEnrichAttributes({ attrs: ['run=local'], attrEnv: ['run=RUN_ID'] }, { RUN_ID: '9' });
    assert.deepEqual(r.attributes, { run: '9' });
  });

  it('sanitizeEnrichAttributes keeps scalars and skips the rest with warnings', () => {
    const r = sanitizeEnrichAttributes({ team: 'a', n: 3, nested: { x: 1 }, '': 'e' });
    assert.deepEqual(r.attributes, { team: 'a', n: '3' });
    assert.equal(r.warnings.length, 2);
    assert.equal(sanitizeEnrichAttributes('bad').warnings.length, 1);
  });
});

describe('OTel export carries enricher attributes (#95)', () => {
  it('every span (root, chat, tool) and the resource carry the attributes', () => {
    const doc = toOtlpJson(events(), { ...base, attributes: { team: 'platform', 'ci.build_id': '77' } });
    const spans = spansOf(doc);
    assert.equal(spans.length, 3);
    for (const s of spans) {
      assert.equal(attrOf(s, 'team'), 'platform', `${s.name} lacks team`);
      assert.equal(attrOf(s, 'ci.build_id'), '77', `${s.name} lacks ci.build_id`);
    }
    const res = resourceOf(doc);
    assert.equal(res.team, 'platform');
    assert.equal(res['service.name'], 'agentic-coding-harness');
  });

  it('built-in keys win a clash, and service.name cannot be overridden', () => {
    const doc = toOtlpJson(events(), { ...base, attributes: { 'gen_ai.operation.name': 'spoof', 'service.name': 'spoof' } });
    const spans = spansOf(doc);
    assert.equal(attrOf(spans[0]!, 'gen_ai.operation.name'), 'invoke_agent');
    assert.equal(spans[0]!.attributes.filter((a) => a.key === 'gen_ai.operation.name').length, 1);
    assert.equal(resourceOf(doc)['service.name'], 'agentic-coding-harness');
    assert.equal(doc.resourceSpans[0]!.resource.attributes.filter((a) => a.key === 'service.name').length, 1);
  });

  it('no attributes: output unchanged (resource is service.name only)', () => {
    const doc = toOtlpJson(events(), base);
    assert.deepEqual(Object.keys(resourceOf(doc)), ['service.name']);
    assert.equal(attrOf(spansOf(doc)[0]!, 'team'), undefined);
  });

  it('the live tracer path (emitRun) stamps every span too', async () => {
    const exporter = new InMemorySpanExporter();
    const provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
    emitRun(provider.getTracer('t'), { ...base, events: events(), attributes: { team: 'platform' } });
    await provider.forceFlush();
    const finished = exporter.getFinishedSpans();
    assert.equal(finished.length, 3);
    for (const s of finished) assert.equal(s.attributes.team, 'platform', `${s.name} lacks team`);
    await provider.shutdown();
  });
});

describe('Langfuse export carries enricher attributes (#95)', () => {
  it('every Langfuse span carries them', () => {
    const spans = spansOf(toLangfuseOtlpJson(events(), { ...base, attributes: { team: 'platform' } }));
    assert.ok(spans.length >= 3);
    for (const s of spans) assert.equal(attrOf(s, 'team'), 'platform', `${s.name} lacks team`);
  });

  it('multi-model slice spans keep them', () => {
    const ev: AgentEvent[] = [
      { type: 'message', source: 'user', content: 'go', timestamp: T0 },
      {
        type: 'usage',
        usage: {
          inputTokens: 20, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, model: 'm-a',
          extra: { raw: { models: [
            { model: 'm-a', input: 10, output: 5, cacheRead: 0, cacheWrite: 0, reasoning: 0, costUsd: 0.001 },
            { model: 'm-b', input: 10, output: 5, cacheRead: 0, cacheWrite: 0, reasoning: 0, costUsd: 0.001 },
          ] } },
        },
        timestamp: T0 + 100,
      },
    ];
    const spans = spansOf(toLangfuseOtlpJson(ev, { ...base, attributes: { team: 'platform' } }));
    const slices = spans.filter((s) => s.name.startsWith('chat '));
    assert.equal(slices.length, 2);
    for (const s of spans) assert.equal(attrOf(s, 'team'), 'platform', `${s.name} lacks team`);
  });

  it('the POSTed body carries them', async () => {
    let posted = '';
    const fetchImpl = (async (_url: string, init: { body: string }) => {
      posted = init.body;
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;
    const r = await emitToLangfuse(events(), { ...base, baseUrl: 'http://lf.invalid', publicKey: 'pk', secretKey: 'sk', fetchImpl, attributes: { team: 'platform' } });
    assert.equal(r.ok, true);
    for (const s of spansOf(JSON.parse(posted))) assert.equal(attrOf(s, 'team'), 'platform');
  });
});

describe('ATIF export carries enricher attributes (#95)', () => {
  it('writes them to the top-level extra.attributes and still validates', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ach-enrich-atif-'));
    const out = path.join(dir, 't.json');
    const w = AtifWriter.fromEvents(events(), { agent: 'a', version: '1', modelName: 'm', attributes: { team: 'platform' } });
    const doc = w.finalize(out);
    assert.deepEqual(doc.extra.attributes, { team: 'platform' });
    assert.deepEqual(AtifWriter.validate(out), { ok: true, errors: [] });
    assert.equal('attributes' in AtifWriter.fromEvents(events()).toTrajectory().extra, false);
  });
});

// ---------------------------------------------------------------- CLI + config

function runCli(args: string[], env: Record<string, string | undefined>, cwd?: string): { code: number; stdout: string; stderr: string } {
  const isBun = (process.versions as { bun?: string }).bun !== undefined;
  const merged: Record<string, string | undefined> = { ...process.env, ...env };
  for (const [k, v] of Object.entries(merged)) if (v === undefined) delete merged[k];
  const p = spawnSync(process.execPath, isBun ? [CLI, ...args] : ['--import', import.meta.resolve('tsx'), CLI, ...args], {
    env: merged as NodeJS.ProcessEnv,
    encoding: 'utf8',
    cwd,
  });
  return { code: p.status ?? -1, stdout: p.stdout ?? '', stderr: p.stderr ?? '' };
}

/** Async variant for tests whose CLI child talks to an in-process server
 *  (spawnSync would block the event loop the server needs). */
function runCliAsync(args: string[], env: Record<string, string | undefined>, cwd?: string): Promise<{ code: number; stdout: string; stderr: string }> {
  const merged: Record<string, string | undefined> = { ...process.env, ...env };
  for (const [k, v] of Object.entries(merged)) if (v === undefined) delete merged[k];
  return new Promise((resolve) => {
    const c = spawn(process.execPath, ['--import', import.meta.resolve('tsx'), CLI, ...args], { env: merged as NodeJS.ProcessEnv, cwd });
    let stdout = '';
    let stderr = '';
    c.stdout.on('data', (b: Buffer) => (stdout += b.toString()));
    c.stderr.on('data', (b: Buffer) => (stderr += b.toString()));
    const timer = setTimeout(() => c.kill('SIGKILL'), 60_000);
    c.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

describe('ach emit --attr / --attr-env and the emit config section (#95)', () => {
  let dir = '';
  let eventsFile = '';
  let cfgEnv: Record<string, string | undefined> = {};
  let lf: http.Server;
  let lfUrl = '';
  let lfBody = '';
  before(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ach-enrich-cli-'));
    eventsFile = path.join(dir, 'events.json');
    await fs.writeFile(eventsFile, JSON.stringify({ events: events() }));
    // Isolate state dir, HOME (user config) and cwd (project config).
    cfgEnv = {
      AGENTIC_CODING_HARNESS_STATE_DIR: path.join(dir, 'state'),
      AGENTIC_CODING_HARNESS_CONFIG: undefined,
      AGENTIC_CODING_HARNESS_UPDATE_CHECK: undefined,
      HOME: path.join(dir, 'home'),
      BUILD_NUMBER: undefined,
    };
    lf = http.createServer((req, res) => {
      let b = '';
      req.on('data', (c: Buffer) => (b += c.toString()));
      req.on('end', () => {
        lfBody = b;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{}');
      });
    });
    await new Promise<void>((r) => lf.listen(0, '127.0.0.1', () => r()));
    lfUrl = `http://127.0.0.1:${(lf.address() as { port: number }).port}`;
  });
  after(async () => {
    await new Promise<void>((r) => lf.close(() => r()));
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('otel: --attr and --attr-env land on every span and the resource', async () => {
    const out = path.join(dir, 'otel.json');
    const r = runCli(['emit', '--input', eventsFile, '--format', 'otel', '--out', out, '--attr', 'team=platform', '--attr-env', 'ci.build_id=BUILD_NUMBER'], { ...cfgEnv, BUILD_NUMBER: '77' }, dir);
    assert.equal(r.code, 0, r.stderr);
    assert.doesNotMatch(r.stderr, /warning/);
    const doc = JSON.parse(await fs.readFile(out, 'utf8')) as Doc;
    for (const s of spansOf(doc)) {
      assert.equal(attrOf(s, 'team'), 'platform');
      assert.equal(attrOf(s, 'ci.build_id'), '77');
    }
    assert.equal(resourceOf(doc).team, 'platform');
  });

  it('a missing env var warns once on stderr and the export still succeeds without it', async () => {
    const out = path.join(dir, 'otel-missing.json');
    const r = runCli(['emit', '--input', eventsFile, '--format', 'otel', '--out', out, '--attr', 'team=platform', '--attr-env', 'ci.build_id=BUILD_NUMBER', '--attr', 'broken'], cfgEnv, dir);
    assert.equal(r.code, 0, r.stderr);
    assert.equal((r.stderr.match(/BUILD_NUMBER is not set/g) ?? []).length, 1);
    assert.match(r.stderr, /--attr 'broken' is not key=value; skipped/);
    const doc = JSON.parse(await fs.readFile(out, 'utf8')) as Doc;
    for (const s of spansOf(doc)) {
      assert.equal(attrOf(s, 'team'), 'platform');
      assert.equal(s.attributes.some((a) => a.key === 'ci.build_id'), false);
    }
  });

  it('atif: --attr lands in extra.attributes of the validated file', async () => {
    const out = path.join(dir, 'traj.json');
    const r = runCli(['emit', '--input', eventsFile, '--format', 'atif', '--out', out, '--attr', 'team=platform'], cfgEnv, dir);
    assert.equal(r.code, 0, r.stderr);
    const doc = JSON.parse(await fs.readFile(out, 'utf8'));
    assert.deepEqual(doc.extra.attributes, { team: 'platform' });
  });

  it('langfuse: the POSTed payload and the --out dump carry the attributes', async () => {
    const out = path.join(dir, 'lf.json');
    lfBody = '';
    const r = await runCliAsync(['emit', '--input', eventsFile, '--format', 'langfuse', '--out', out, '--langfuse-url', lfUrl, '--langfuse-public-key', 'pk', '--langfuse-secret-key', 'sk', '--attr', 'team=platform'], cfgEnv, dir);
    assert.equal(r.code, 0, r.stderr);
    for (const doc of [JSON.parse(lfBody) as Doc, JSON.parse(await fs.readFile(out, 'utf8')) as Doc]) {
      const spans = spansOf(doc);
      assert.ok(spans.length >= 3);
      for (const s of spans) assert.equal(attrOf(s, 'team'), 'platform');
    }
  });

  it('the config file emit section supplies them; a flag replaces the whole list', async () => {
    const cwd = path.join(dir, 'proj');
    await fs.mkdir(path.join(cwd, '.ach'), { recursive: true });
    await fs.writeFile(path.join(cwd, '.ach', 'config.json'), JSON.stringify({ emit: { attr: ['team=platform', 'environment=staging'], attrEnv: 'ci.build_id=BUILD_NUMBER' } }));
    const out = path.join(dir, 'cfg.json');
    let r = runCli(['emit', '--input', eventsFile, '--format', 'otel', '--out', out], { ...cfgEnv, BUILD_NUMBER: '5' }, cwd);
    assert.equal(r.code, 0, r.stderr);
    let root = spansOf(JSON.parse(await fs.readFile(out, 'utf8')) as Doc)[0]!;
    assert.equal(attrOf(root, 'team'), 'platform');
    assert.equal(attrOf(root, 'environment'), 'staging');
    assert.equal(attrOf(root, 'ci.build_id'), '5');

    r = runCli(['emit', '--input', eventsFile, '--format', 'otel', '--out', out, '--attr', 'team=infra'], { ...cfgEnv, BUILD_NUMBER: '5' }, cwd);
    assert.equal(r.code, 0, r.stderr);
    root = spansOf(JSON.parse(await fs.readFile(out, 'utf8')) as Doc)[0]!;
    assert.equal(attrOf(root, 'team'), 'infra');
    assert.equal(attrOf(root, 'environment'), undefined, 'flag replaces the config list');
    assert.equal(attrOf(root, 'ci.build_id'), '5', '--attr-env from config still applies');

    const show = runCli(['config', '--show', 'emit', '--json'], cfgEnv, cwd);
    assert.equal(show.code, 0, show.stderr);
    assert.match(show.stdout, /emit\.attr/);
  });

  it('a config emit.attr does not break --format sft', async () => {
    const cwd = path.join(dir, 'proj-sft');
    await fs.mkdir(path.join(cwd, '.ach'), { recursive: true });
    await fs.writeFile(path.join(cwd, '.ach', 'config.json'), JSON.stringify({ emit: { attr: ['team=platform'] } }));
    const r = runCli(['emit', '--input', eventsFile, '--format', 'sft', '--out', path.join(dir, 'sft.jsonl')], cfgEnv, cwd);
    assert.doesNotMatch(r.stderr, /attr/);
    assert.equal(r.code, 0, r.stderr);
  });
});

describe('config-file emit keys do not trip the cross-format checks (#95)', () => {
  let dir = '';
  let eventsFile = '';
  let env: Record<string, string | undefined> = {};
  before(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ach-enrich-xfmt-'));
    eventsFile = path.join(dir, 'events.json');
    await fs.writeFile(eventsFile, JSON.stringify({ events: events() }));
    env = { AGENTIC_CODING_HARNESS_STATE_DIR: path.join(dir, 'state'), AGENTIC_CODING_HARNESS_CONFIG: undefined, AGENTIC_CODING_HARNESS_UPDATE_CHECK: undefined, HOME: path.join(dir, 'home') };
  });
  async function project(name: string, emit: Record<string, unknown>): Promise<string> {
    const cwd = path.join(dir, name);
    await fs.mkdir(path.join(cwd, '.ach'), { recursive: true });
    await fs.writeFile(path.join(cwd, '.ach', 'config.json'), JSON.stringify({ emit }));
    return cwd;
  }
  after(async () => fs.rm(dir, { recursive: true, force: true }));

  it('emit.langfuseUrl in the file does not break --format sft', async () => {
    const cwd = await project('sft', { langfuseUrl: 'http://lf.invalid', model: 'm' });
    const r = runCli(['emit', '--input', eventsFile, '--format', 'sft', '--out', path.join(dir, 's.jsonl')], env, cwd);
    assert.equal(r.code, 0, r.stderr);
  });

  it('emit.minScore in the file does not break --format otel', async () => {
    const cwd = await project('otel', { minScore: 1, fullConversation: true });
    const r = runCli(['emit', '--input', eventsFile, '--format', 'otel', '--out', path.join(dir, 'o.json')], env, cwd);
    assert.equal(r.code, 0, r.stderr);
  });

  it('a typed flag still trips them', async () => {
    const cwd = await project('typed', { attr: ['team=platform'] });
    const r = runCli(['emit', '--input', eventsFile, '--format', 'otel', '--min-score', '1'], env, cwd);
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /--min-score only applies to --format sft/);
  });
});

// ---------------------------------------------------------------- user enricher module

const MODULES: Record<string, string> = {
  'good.mjs': "export default (i) => i.kind === 'span' ? { 'dyn.op': i.operation, 'dyn.name': i.name, 'dyn.session': i.run.sessionId, 'gen_ai.operation.name': 'spoof' } : { 'dyn.kind': i.kind, 'dyn.agent': i.run.agent };\n",
  'async.mjs': "export default async (i) => { await new Promise((r) => setTimeout(r, 5)); return { 'dyn.async': i.operation }; };\n",
  'throw.mjs': "export default () => { throw new Error('boom from enricher'); };\n",
  'bad.mjs': 'export default () => 42;\n',
  'slow.mjs': 'export default () => new Promise(() => {});\n',
  'nodefault.mjs': 'export const x = 1;\n',
  'syntax.mjs': 'export default (\n',
};

describe('user enricher module (#95)', () => {
  let dir = '';
  let eventsFile = '';
  let env: Record<string, string | undefined> = {};
  let lf: http.Server;
  let lfUrl = '';
  let lfBody = '';
  const mod = (name: string): string => path.join(dir, 'mods', name);
  before(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ach-enrich-mod-'));
    await fs.mkdir(path.join(dir, 'mods'), { recursive: true });
    for (const [n, src] of Object.entries(MODULES)) await fs.writeFile(mod(n), src);
    eventsFile = path.join(dir, 'events.json');
    await fs.writeFile(eventsFile, JSON.stringify({ events: events() }));
    env = { AGENTIC_CODING_HARNESS_STATE_DIR: path.join(dir, 'state'), AGENTIC_CODING_HARNESS_CONFIG: undefined, AGENTIC_CODING_HARNESS_UPDATE_CHECK: undefined, HOME: path.join(dir, 'home') };
    lf = http.createServer((req, res) => {
      let b = '';
      req.on('data', (c: Buffer) => (b += c.toString()));
      req.on('end', () => {
        lfBody = b;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{}');
      });
    });
    await new Promise<void>((r) => lf.listen(0, '127.0.0.1', () => r()));
    lfUrl = `http://127.0.0.1:${(lf.address() as { port: number }).port}`;
  });
  after(async () => {
    await new Promise<void>((r) => lf.close(() => r()));
    await fs.rm(dir, { recursive: true, force: true });
  });

  const input = (name: string): EnricherInput => ({ kind: 'span', name, operation: 'chat', attributes: {}, run: { format: 'otel', sessionId: 's', agent: 'a', model: 'm' } });

  it('runEnricher: sync and async results per input, scalars only', async () => {
    const sync = await runEnricher(() => ({ a: 'x', n: 2, nested: { y: 1 } }), [input('one')]);
    assert.deepEqual(sync, { results: [{ a: 'x', n: '2' }], warnings: [] });
    const asyncFn = (await loadEnricher(mod('async.mjs'))).fn!;
    const r = await runEnricher(asyncFn, [input('one'), input('two')]);
    assert.deepEqual(r.results, [{ 'dyn.async': 'chat' }, { 'dyn.async': 'chat' }]);
  });

  it('runEnricher: a throw, a bad return or a timeout is one warning and stops the enricher', async () => {
    const thrown = await runEnricher((await loadEnricher(mod('throw.mjs'))).fn!, [input('one'), input('two')]);
    assert.deepEqual(thrown.results, []);
    assert.equal(thrown.warnings.length, 1);
    assert.match(thrown.warnings[0]!, /boom from enricher/);
    const bad = await runEnricher((await loadEnricher(mod('bad.mjs'))).fn!, [input('one'), input('two')]);
    assert.equal(bad.warnings.length, 1);
    assert.match(bad.warnings[0]!, /returned number/);
    const slow = await runEnricher((await loadEnricher(mod('slow.mjs'))).fn!, [input('one')], 50);
    assert.equal(slow.warnings.length, 1);
    assert.match(slow.warnings[0]!, /timed out after 50ms/);
  });

  it('loadEnricher: missing file, no default export and a syntax error all warn, never throw', async () => {
    for (const p of [mod('nope.mjs'), mod('nodefault.mjs'), mod('syntax.mjs')]) {
      const r = await loadEnricher(p);
      assert.equal(r.fn, undefined);
      assert.match(r.warning ?? '', /exporting without it/);
    }
  });

  it('otel: dynamic attrs reach every span; built-in keys still win', async () => {
    const out = path.join(dir, 'otel.json');
    const r = runCli(['emit', '--input', eventsFile, '--format', 'otel', '--out', out, '--session-id', 'sess-9', '--enricher', mod('good.mjs')], env, dir);
    assert.equal(r.code, 0, r.stderr);
    assert.doesNotMatch(r.stderr, /warning/);
    const spans = spansOf(JSON.parse(await fs.readFile(out, 'utf8')) as Doc);
    assert.equal(spans.length, 3);
    for (const s of spans) {
      assert.equal(attrOf(s, 'dyn.name'), s.name);
      assert.equal(attrOf(s, 'dyn.op'), attrOf(s, 'gen_ai.operation.name'));
      assert.notEqual(attrOf(s, 'gen_ai.operation.name'), 'spoof');
      assert.equal(attrOf(s, 'dyn.session'), 'sess-9');
    }
  });

  it('langfuse: async module attrs reach every POSTed span', async () => {
    lfBody = '';
    const r = await runCliAsync(['emit', '--input', eventsFile, '--format', 'langfuse', '--langfuse-url', lfUrl, '--langfuse-public-key', 'pk', '--langfuse-secret-key', 'sk', '--enricher', mod('async.mjs')], env, dir);
    assert.equal(r.code, 0, r.stderr);
    const spans = spansOf(JSON.parse(lfBody) as Doc);
    assert.ok(spans.length >= 3);
    for (const s of spans) assert.equal(attrOf(s, 'dyn.async'), attrOf(s, 'gen_ai.operation.name'));
  });

  it('atif: the trajectory-level call lands in extra.attributes, merged with --attr', async () => {
    const out = path.join(dir, 'traj.json');
    const r = runCli(['emit', '--input', eventsFile, '--format', 'atif', '--out', out, '--agent', 'agent-z', '--attr', 'team=platform', '--enricher', mod('good.mjs')], env, dir);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(JSON.parse(await fs.readFile(out, 'utf8')).extra.attributes, { team: 'platform', 'dyn.kind': 'trajectory', 'dyn.agent': 'agent-z' });
  });

  it('a throwing module and a missing file each warn once and still export', async () => {
    for (const m of [mod('throw.mjs'), mod('missing.mjs')]) {
      const out = path.join(dir, 'fail.json');
      await fs.rm(out, { force: true });
      const r = runCli(['emit', '--input', eventsFile, '--format', 'otel', '--out', out, '--attr', 'team=platform', '--enricher', m], env, dir);
      assert.equal(r.code, 0, r.stderr);
      assert.equal((r.stderr.match(/warning: --enricher/g) ?? []).length, 1, r.stderr);
      const spans = spansOf(JSON.parse(await fs.readFile(out, 'utf8')) as Doc);
      assert.equal(spans.length, 3);
      for (const s of spans) {
        assert.equal(attrOf(s, 'team'), 'platform');
        assert.equal(s.attributes.some((a) => a.key.startsWith('dyn.')), false);
      }
    }
  });

  it('emit.enricher in a config file resolves against the file, a relative flag against cwd', async () => {
    const cwd = path.join(dir, 'proj');
    await fs.mkdir(path.join(cwd, '.ach'), { recursive: true });
    await fs.writeFile(path.join(cwd, '.ach', 'config.json'), JSON.stringify({ emit: { enricher: '../../mods/good.mjs' } }));
    const out = path.join(dir, 'cfg.json');
    let r = runCli(['emit', '--input', eventsFile, '--format', 'otel', '--out', out], env, cwd);
    assert.equal(r.code, 0, r.stderr);
    assert.doesNotMatch(r.stderr, /warning/);
    assert.equal(attrOf(spansOf(JSON.parse(await fs.readFile(out, 'utf8')) as Doc)[0]!, 'dyn.op'), 'invoke_agent');

    r = runCli(['emit', '--input', eventsFile, '--format', 'otel', '--out', out, '--enricher', 'mods/async.mjs'], env, dir);
    assert.equal(r.code, 0, r.stderr);
    const root = spansOf(JSON.parse(await fs.readFile(out, 'utf8')) as Doc)[0]!;
    assert.equal(attrOf(root, 'dyn.async'), 'invoke_agent');
  });
});

// ---------------------------------------------------------------- MCP

describe('MCP harness_emit attributes (#95)', () => {
  const tools = new Map<string, McpToolDef>();
  const fake = { registerTool: (d: McpToolDef) => tools.set(d.name, d) } as unknown as McpServer;
  let dir = '';
  before(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ach-enrich-mcp-'));
    registerInspectTools(fake, { stateDir: dir });
    await fs.writeFile(path.join(dir, 'run.json'), JSON.stringify({ events: events() }));
  });
  after(async () => fs.rm(dir, { recursive: true, force: true }));

  it('static attributes reach the otel file and the atif file; bad values come back as warnings', async () => {
    const t = tools.get('harness_emit')!;
    const otelOut = path.join(dir, 'o.json');
    const res = (await t.handler({ runFile: path.join(dir, 'run.json'), format: 'otel', out: otelOut, attributes: { team: 'platform', bad: { x: 1 } } })) as { warnings?: string[] };
    assert.equal(res.warnings?.length, 1);
    for (const s of spansOf(JSON.parse(await fs.readFile(otelOut, 'utf8')) as Doc)) assert.equal(attrOf(s, 'team'), 'platform');

    const atifOut = path.join(dir, 'a.json');
    await t.handler({ runFile: path.join(dir, 'run.json'), format: 'atif', out: atifOut, attributes: { team: 'platform' } });
    assert.deepEqual(JSON.parse(await fs.readFile(atifOut, 'utf8')).extra.attributes, { team: 'platform' });
  });

  it('an enricher module is never accepted over MCP: ignored with a warning, not loaded', async () => {
    const t = tools.get('harness_emit')!;
    const modPath = path.join(dir, 'm.mjs');
    const marker = path.join(dir, 'loaded.txt');
    await fs.writeFile(modPath, `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(marker)}, 'x'); export default () => ({ 'dyn.x': '1' });\n`);
    const out = path.join(dir, 'e.json');
    const res = (await t.handler({ runFile: path.join(dir, 'run.json'), format: 'otel', out, enricher: modPath })) as { warnings?: string[] };
    assert.equal(res.warnings?.length, 1);
    assert.match(res.warnings![0]!, /not accepted over MCP/);
    for (const s of spansOf(JSON.parse(await fs.readFile(out, 'utf8')) as Doc)) assert.equal(attrOf(s, 'dyn.x'), undefined);
    await assert.rejects(fs.stat(marker), /ENOENT/);
  });
});
