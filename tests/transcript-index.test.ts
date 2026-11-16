// #202: the dashboard's transcript projection is indexed per file. A refresh
// re-reads only changed files, the first pass can take recent files (by
// mtime) and backfill the rest, and merged rows equal transcriptView's.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { TranscriptIndex, transcriptView } from '../src/cli/transcript-view.ts';
import { parseClaudeTranscript, scanOptionsForRoot } from '../src/monitors/transcripts.ts';
import { TranscriptRunSource } from '../src/web/run-source-transcript.ts';
import type { RunRecord } from '../src/core/registry.ts';
import { PRICING_OVERRIDE_ENV } from '../src/core/pricing.ts';
import { VERSION } from '../src/version.ts';
import { startWebServer } from '../src/web/server.ts';
import { FsRunSource } from '../src/web/run-source.ts';

const DAY = 86_400_000;
const homes: string[] = [];
after(() => { for (const h of homes) rmSync(h, { recursive: true, force: true }); });

function line(session: string, id: string, ts: string, input: number, output: number, model = 'claude-sonnet-4-5'): string {
  return JSON.stringify({ type: 'assistant', sessionId: session, timestamp: ts, requestId: `req-${id}`,
    message: { id: `msg-${id}`, model, usage: { input_tokens: input, output_tokens: output, cache_read_input_tokens: 1, cache_creation_input_tokens: 2 } } });
}

/** A home with three Claude files: s-new (main + a sub-agent file) and s-old, plus an amp thread. */
function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'ach-tindex-'));
  homes.push(home);
  const state = join(home, 'state');
  mkdirSync(state);
  const proj = join(home, '.claude', 'projects', 'p');
  mkdirSync(join(proj, 's-new', 'subagents'), { recursive: true });
  const files = {
    main: join(proj, 's-new.jsonl'),
    sub: join(proj, 's-new', 'subagents', 'agent-1.jsonl'),
    old: join(proj, 's-old.jsonl'),
  };
  writeFileSync(files.main, [line('s-new', 'a', '2026-11-14T10:00:00Z', 100, 10), line('s-new', 'b', '2026-11-14T11:00:00Z', 50, 5)].join('\n') + '\n');
  writeFileSync(files.sub, line('s-new', 'c', '2026-11-14T10:30:00Z', 7, 3, 'claude-haiku-4-5') + '\n');
  writeFileSync(files.old, line('s-old', 'd', '2026-09-01T10:00:00Z', 20, 2) + '\n');
  const amp = join(home, '.local/share/amp/threads');
  mkdirSync(amp, { recursive: true });
  writeFileSync(join(amp, 'thread.json'), JSON.stringify({ id: 'amp-session', messages: [{ role: 'assistant', timestamp: '2026-11-13T01:00:00Z', usage: { inputTokens: 12, outputTokens: 34 } }] }));
  const old = (Date.now() - 60 * DAY) / 1000;
  utimesSync(files.old, old, old);
  return { home, state, files, scan: scanOptionsForRoot(home) };
}

const byId = (rows: RunRecord[]) => [...rows].sort((a, b) => (a.runId < b.runId ? -1 : 1));

describe('TranscriptIndex', () => {
  it('merged rows equal transcriptView for the same files', async () => {
    const f = fixture();
    const idx = new TranscriptIndex(f.state, f.scan);
    await idx.update();
    assert.deepEqual(byId(await idx.rows([])), byId(await transcriptView(f.state, [], f.scan)));
    const sNew = (await idx.rows([])).find((r) => r.sessionId === 's-new')!;
    assert.equal(sNew.totals!.inputTokens, 157, 'main + sub-agent files sum into one session');
    assert.deepEqual(sNew.usage!.model!.observed, ['claude-haiku-4-5', 'claude-sonnet-4-5']);
  });

  it('a refresh re-reads only changed files and drops deleted ones', async () => {
    const f = fixture();
    const idx = new TranscriptIndex(f.state, f.scan);
    await idx.update();
    const first = idx.parseCount;
    assert.equal(first, 4);
    await idx.update();
    assert.equal(idx.parseCount, first, 'unchanged files are not parsed again');
    writeFileSync(f.files.main, line('s-new', 'a', '2026-11-14T10:00:00Z', 100, 10) + '\n' + line('s-new', 'e', '2026-11-15T10:00:00Z', 1000, 1) + '\n');
    await idx.update();
    assert.equal(idx.parseCount, first + 1, 'only the rewritten file is parsed');
    assert.equal((await idx.rows([])).find((r) => r.sessionId === 's-new')!.totals!.inputTokens, 1107);
    unlinkSync(f.files.old);
    await idx.update();
    assert.equal((await idx.rows([])).some((r) => r.sessionId === 's-old'), false);
  });

  it('minMtimeMs parses recent files first and leaves the rest pending', async () => {
    const f = fixture();
    const idx = new TranscriptIndex(f.state, f.scan);
    assert.equal(idx.progress().complete, false, 'not complete before the first walk');
    await idx.update({ minMtimeMs: Date.now() - 7 * DAY });
    assert.deepEqual(idx.progress(), { complete: false, filesParsed: 3, filesTotal: 4 });
    assert.equal((await idx.rows([])).some((r) => r.sessionId === 's-old'), false);
    await idx.update();
    assert.deepEqual(idx.progress(), { complete: true, filesParsed: 4, filesTotal: 4 });
    assert.equal((await idx.rows([])).some((r) => r.sessionId === 's-old'), true);
    assert.equal(idx.parseCount, 4, 'the backfill does not re-read the recent files');
  });

  it('rows skip sessions the registry owns', async () => {
    const f = fixture();
    const idx = new TranscriptIndex(f.state, f.scan);
    await idx.update();
    const owned = { runId: 'r', agent: 'claude', sessionId: 's-new', startedAt: 1 } as RunRecord;
    assert.equal((await idx.rows([owned])).some((r) => r.sessionId === 's-new'), false);
  });
});

describe('TranscriptIndex cache file', () => {
  it('a new index reuses the saved rows and re-reads only files that changed', async () => {
    const f = fixture();
    const cache = join(f.state, 'cache', 'transcript-index.json');
    const a = new TranscriptIndex(f.state, f.scan, cache);
    await a.update();
    await a.save();
    const before = byId(await a.rows([]));
    const b = new TranscriptIndex(f.state, f.scan, cache);
    await b.update();
    assert.equal(b.parseCount, 0, 'nothing re-read after a restart');
    assert.deepEqual(byId(await b.rows([])), before);
    writeFileSync(f.files.old, line('s-old', 'd', '2026-09-01T10:00:00Z', 20, 2) + '\n' + line('s-old', 'z', '2026-09-02T10:00:00Z', 5, 5) + '\n');
    const c = new TranscriptIndex(f.state, f.scan, cache);
    await c.update();
    assert.equal(c.parseCount, 1);
    assert.equal((await c.rows([])).find((r) => r.sessionId === 's-old')!.totals!.inputTokens, 25);
  });

  it('a corrupt cache, another version, or another price table forces a re-read', async () => {
    const f = fixture();
    const cache = join(f.state, 'cache', 'transcript-index.json');
    const a = new TranscriptIndex(f.state, f.scan, cache);
    await a.update();
    await a.save();
    const good = JSON.parse(readFileSync(cache, 'utf8'));
    assert.equal(good.files.length, 4, 'the saved cache holds every file');
    const reread = async (): Promise<number> => {
      const idx = new TranscriptIndex(f.state, f.scan, cache);
      await idx.update();
      return idx.parseCount;
    };
    writeFileSync(cache, JSON.stringify(good));
    assert.equal(await reread(), 0, 'control: the intact cache is reused');
    for (const body of ['{not json', JSON.stringify({ ...good, v: 999 }), JSON.stringify({ ...good, key: 'other' })]) {
      writeFileSync(cache, body);
      assert.equal(await reread(), 4);
    }
    // The key carries the ach version and the override file's identity.
    const key = JSON.parse(good.key);
    assert.equal(key[0], VERSION);
    writeFileSync(cache, JSON.stringify(good));
    const override = join(f.home, 'prices.json');
    writeFileSync(override, '{}');
    const prev = process.env[PRICING_OVERRIDE_ENV];
    process.env[PRICING_OVERRIDE_ENV] = override;
    try {
      assert.equal(await reread(), 4, 'a pricing override invalidates rows priced without it');
    } finally {
      if (prev === undefined) delete process.env[PRICING_OVERRIDE_ENV]; else process.env[PRICING_OVERRIDE_ENV] = prev;
    }
  });
});

describe('TranscriptRunSource with recentMs', () => {
  it('start() resolves with the recent sessions, then the backfill adds the older ones', async () => {
    const f = fixture();
    const src = new TranscriptRunSource(f.state, f.scan, { recentMs: 7 * DAY });
    const seen: RunRecord[][] = [];
    try {
      await src.start((records) => seen.push(records));
      const atStart = src.snapshot().map((r) => r.sessionId);
      assert.ok(atStart.includes('s-new'));
      const deadline = Date.now() + 10_000;
      while (!src.progress().complete && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
      while (!src.snapshot().some((r) => r.sessionId === 's-old') && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
      assert.ok(src.snapshot().some((r) => r.sessionId === 's-old'), 'backfill reached the 60-day-old file');
      assert.equal(src.progress().complete, true);
    } finally {
      await src.stop();
    }
  });
});

describe('streaming JSONL reader', () => {
  it('handles a BOM, CRLF, a malformed line and a last line without a newline', async () => {
    const home = mkdtempSync(join(tmpdir(), 'ach-jsonl-'));
    homes.push(home);
    const file = join(home, 's.jsonl');
    writeFileSync(file, '﻿' + line('s', 'a', '2026-11-14T10:00:00Z', 1, 1) + '\r\n{not json\r\n\r\n' + line('s', 'b', '2026-11-14T10:00:01Z', 2, 2));
    const recs = await parseClaudeTranscript(file);
    assert.deepEqual(recs.map((r) => r.input), [1, 2]);
    assert.deepEqual(await parseClaudeTranscript(join(home, 'missing.jsonl')), []);
    assert.deepEqual(await parseClaudeTranscript(home), [], 'a directory reads as empty');
  });
});

describe('scan progress on the server surface', () => {
  async function get(base: string, path: string): Promise<Record<string, unknown>> {
    const res = await fetch(base + path);
    assert.equal(res.status, 200, path);
    return (await res.json()) as Record<string, unknown>;
  }

  it('a transcript source reports scan on /api/runs and transcriptScan on /api/stats and /health', async () => {
    const f = fixture();
    const src = new TranscriptRunSource(f.state, f.scan, { recentMs: 7 * DAY });
    const server = await startWebServer({ port: 0, host: '127.0.0.1', stateDir: f.state, runSource: src, listWindow: { pageSize: 50 } });
    try {
      const base = `http://127.0.0.1:${server.port}`;
      const deadline = Date.now() + 10_000;
      while (!src.progress().complete && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
      const done = { complete: true, filesParsed: 4, filesTotal: 4 };
      assert.deepEqual((await get(base, '/api/runs')).scan, done);
      assert.deepEqual((await get(base, '/api/stats')).transcriptScan, done);
      assert.deepEqual((await get(base, '/health')).transcriptScan, done);
    } finally {
      await server.close();
    }
  });

  it('a registry-only source (--state-only) carries none of them', async () => {
    const f = fixture();
    const server = await startWebServer({ port: 0, host: '127.0.0.1', stateDir: f.state, runSource: new FsRunSource(f.state), listWindow: { pageSize: 50 } });
    try {
      const base = `http://127.0.0.1:${server.port}`;
      assert.equal('scan' in (await get(base, '/api/runs')), false);
      assert.equal('transcriptScan' in (await get(base, '/api/stats')), false);
      assert.equal('transcriptScan' in (await get(base, '/health')), false);
    } finally {
      await server.close();
    }
  });
});
