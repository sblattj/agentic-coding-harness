// Read-only dashboard projection. These rows are never persisted to the registry.
import { createHash } from 'node:crypto';
import { descriptorDirs, loadAgentDescriptors, readDescriptorTap } from '../core/agent-descriptors.ts';
import { withPricingHints } from '../core/pricing-hints.ts';
import { createPricer, PRICING_OVERRIDE_ENV, pricingMeta } from '../core/pricing.ts';
import { VERSION } from '../version.ts';
import { statSync } from 'node:fs';
import type { RunRecord } from '../core/registry.ts';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { scanAll, transcriptSources, walkFiles, type CanonicalTokenRecord, type ScanOptions } from '../monitors/transcripts.ts';
import { drainTranscriptWarnings } from '../monitors/transcript-warnings.ts';
import { reportCatalogIssues } from './custom-agents.ts';

type Pricer = ReturnType<typeof createPricer>;
type Rows = Map<string, RunRecord>;

/** Fold one usage record into `rows` (keyed agent + session, or origin). */
function addUsage(rows: Rows, agent: string, session: string | null, origin: string, ts: string | null, input: number, output: number, read: number, write: number, cost: number | undefined, reported: boolean, credits?: number, model?: string | null): void {
  const key = `${agent}\0${session ?? origin}`;
  const time = ts ? Date.parse(ts) : NaN;
  const at = Number.isFinite(time) ? time : 0;
  let r = rows.get(key);
  if (!r) {
    r = { runId: `transcript-${createHash('sha256').update(key).digest('hex').slice(0, 24)}`, agent,
      ...(session ? { sessionId: session } : {}), startedAt: at, updatedAt: at,
      source: 'external', metadata: { source: 'transcript' }, lastEvent: 'source: transcript',
      totals: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 },
      usage: { tokens: { available: true, source: 'tap' }, credits: { available: false }, usd: { available: cost !== undefined } } };
    rows.set(key, r);
  }
  if (typeof model === 'string' && model !== '' && model !== 'unknown' && model !== '<synthetic>') {
    const seen = new Set(r.usage!.model?.observed ?? []);
    seen.add(model);
    r.usage!.model = { source: 'native', observed: [...seen].sort() };
  }
  r.startedAt = Math.min(r.startedAt, at);
  r.updatedAt = Math.max(r.updatedAt ?? 0, at);
  r.endedAt = r.updatedAt;
  r.totals!.inputTokens += input; r.totals!.outputTokens += output;
  r.totals!.cacheReadTokens += read; r.totals!.cacheWriteTokens += write;
  r.totals!.costUsd += cost ?? 0;
  if (credits !== undefined) r.totals!.credits = (r.totals!.credits ?? 0) + credits;
  if (cost === undefined) r.usage!.usd.available = false;
  if (cost !== undefined) r.totals!.costSource = !reported || r.totals!.costSource === 'computed' ? 'computed' : 'reported';
}

/** One transcript usage record, priced like `ach stats` (vendor-metered: the stated USD only). */
function addTranscriptRecord(rows: Rows, pricer: Pricer, r: CanonicalTokenRecord): void {
  if (r.extra?.vendorMetered === true) {
    const aiu = typeof r.extra.credits === 'number' ? r.extra.credits : undefined;
    addUsage(rows, r.agent, r.sessionId, r.sourcePath ?? '', r.timestamp, r.input, r.output, r.cacheRead, r.cacheWrite, r.costUsd, true, aiu, r.model);
    return;
  }
  const price = r.model ? pricer.price({ model: r.model, sessionId: r.sessionId, inputTokens: r.input, outputTokens: r.output, cacheReadTokens: r.cacheRead, cacheWriteTokens: r.cacheWrite, ...(r.cacheWrite1h !== undefined ? { cacheWrite1hTokens: r.cacheWrite1h } : {}) }) : NaN;
  addUsage(rows, r.agent, r.sessionId, r.sourcePath ?? '', r.timestamp, r.input, r.output, r.cacheRead, r.cacheWrite, Number.isFinite(price) ? price : undefined, false, undefined, r.model);
}

/** agents.d usage taps (custom agents), read fresh each pass: small, user-owned files. */
async function addDescriptorTaps(rows: Rows, pricer: Pricer, dir: string): Promise<string[]> {
  const catalog = loadAgentDescriptors({ dirs: descriptorDirs({ cwd: process.cwd(), stateDir: dir }) });
  reportCatalogIssues(catalog);
  const warnings: string[] = [];
  for (const descriptor of catalog.descriptors) {
    const priced = descriptor.descriptor.pricingHints ? withPricingHints(pricer, descriptor.descriptor.pricingHints, descriptor.file) : pricer;
    for (const r of await readDescriptorTap(descriptor)) {
      const value = r.costUsd ?? (r.model ? priced.price({ model: r.model, sessionId: r.sessionId, inputTokens: r.inputTokens, outputTokens: r.outputTokens, cacheReadTokens: r.cacheReadTokens, cacheWriteTokens: r.cacheWriteTokens }) : NaN);
      addUsage(rows, r.agent, r.sessionId, descriptor.file, r.ts, r.inputTokens, r.outputTokens, r.cacheReadTokens, r.cacheWriteTokens, Number.isFinite(value) ? value : undefined, r.costUsd !== undefined, undefined, r.model);
    }
    if (priced !== pricer) warnings.push(...priced.drainWarnings());
  }
  return warnings;
}

function claimedKeys(runs: RunRecord[]): Set<string> {
  return new Set(runs.filter((r) => r.sessionId).map((r) => `${r.agent}\0${r.sessionId}`));
}

export async function transcriptView(dir: string, runs: RunRecord[], scan: ScanOptions = {}): Promise<RunRecord[]> {
  const claimed = claimedKeys(runs);
  const rows: Rows = new Map();
  const pricer = createPricer();
  for await (const r of scanAll(scan)) addTranscriptRecord(rows, pricer, r);
  const warnings = await addDescriptorTaps(rows, pricer, dir);
  for (const w of [...warnings, ...drainTranscriptWarnings(), ...pricer.drainWarnings()]) process.stderr.write(`[warn] ${w}\n`);
  // native transcripts mirror harness-owned sessions
  return [...rows.values()].filter((r) => !claimed.has(`${r.agent}\0${r.sessionId ?? ''}`) || r.sessionId === undefined);
}

// ------------------------------------------------------------ incremental (#202)

/** Merge a per-file partial row into the running total for the same key. */
function mergeRow(into: RunRecord, add: RunRecord): void {
  into.startedAt = Math.min(into.startedAt, add.startedAt);
  into.updatedAt = Math.max(into.updatedAt ?? 0, add.updatedAt ?? 0);
  into.endedAt = into.updatedAt;
  const a = into.totals!, b = add.totals!;
  a.inputTokens += b.inputTokens; a.outputTokens += b.outputTokens;
  a.cacheReadTokens += b.cacheReadTokens; a.cacheWriteTokens += b.cacheWriteTokens;
  a.costUsd += b.costUsd;
  if (b.credits !== undefined) a.credits = (a.credits ?? 0) + b.credits;
  if (a.costSource === 'computed' || b.costSource === 'computed') a.costSource = 'computed';
  else if (b.costSource === 'reported') a.costSource = 'reported';
  if (!add.usage!.usd.available) into.usage!.usd.available = false;
  const observed = add.usage!.model?.observed;
  if (observed !== undefined && observed.length > 0) {
    const seen = new Set([...(into.usage!.model?.observed ?? []), ...observed]);
    into.usage!.model = { source: 'native', observed: [...seen].sort() };
  }
}

function cloneRow(r: RunRecord): RunRecord {
  return { ...r, metadata: { ...r.metadata }, totals: { ...r.totals! },
    usage: { ...r.usage!, usd: { ...r.usage!.usd }, ...(r.usage!.model ? { model: { ...r.usage!.model, observed: [...(r.usage!.model.observed ?? [])] } } : {}) } };
}

interface IndexedFile {
  stamp: string;
  mtimeMs: number;
  rows: Rows;
}

export interface TranscriptIndexProgress {
  /** Every transcript file found on the last walk has been parsed at its current stamp. */
  complete: boolean;
  filesParsed: number;
  filesTotal: number;
}

export interface TranscriptIndexUpdate {
  /** Parse only files modified at or after this ms epoch; older ones stay pending. */
  minMtimeMs?: number;
  /** Yield to the event loop between files (background backfill). */
  yieldEvery?: number;
  /** Stop early (server shutdown). */
  shouldStop?: () => boolean;
}

/**
 * The dashboard's transcript projection, kept per file (#202). Each file's
 * usage folds into partial rows keyed by its path + mtime + size (+ a sqlite
 * WAL sidecar's), so a refresh only re-reads files that changed, and the
 * first pass can take the recent files (by mtime) before backfilling the
 * rest. Merged rows equal transcriptView's for the same files.
 */
export class TranscriptIndex {
  private readonly files = new Map<string, IndexedFile>();
  private pending = 0;
  private total = 0;
  private readonly pricer: Pricer = createPricer();
  /** Files parsed over this index's life (tests assert reuse). */
  parseCount = 0;
  private dirty = false;
  private walked = false;
  private loaded = false;
  private lastSave = 0;

  /** `cacheFile`: persist the per-file rows so a restart re-reads only files that changed. */
  constructor(private readonly dir: string, private readonly scan: ScanOptions = {}, private readonly cacheFile?: string) {}

  /** Write the cache if anything changed (at most every `minIntervalMs`). */
  async save(minIntervalMs = 0): Promise<void> {
    if (this.cacheFile === undefined || !this.dirty || Date.now() - this.lastSave < minIntervalMs) return;
    const files = [...this.files].map(([file, f]) => [file, f.stamp, f.mtimeMs, [...f.rows]]);
    const tmp = `${this.cacheFile}.${process.pid}.tmp`;
    try {
      await mkdir(dirname(this.cacheFile), { recursive: true });
      await writeFile(tmp, JSON.stringify({ v: CACHE_VERSION, key: cacheKey(), files }));
      await rename(tmp, this.cacheFile);
      this.dirty = false;
      this.lastSave = Date.now();
    } catch {
      await rm(tmp, { force: true }).catch(() => {});
    }
  }

  private async load(): Promise<void> {
    this.loaded = true;
    if (this.cacheFile === undefined) return;
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(this.cacheFile, 'utf8'));
    } catch {
      return; // none yet, or unreadable: a full parse rebuilds it
    }
    const c = raw as { v?: unknown; key?: unknown; files?: unknown };
    if (c.v !== CACHE_VERSION || c.key !== cacheKey() || !Array.isArray(c.files)) return;
    for (const entry of c.files) {
      if (!Array.isArray(entry) || entry.length !== 4) continue;
      const [file, stamp, mtimeMs, rows] = entry as [unknown, unknown, unknown, unknown];
      if (typeof file !== 'string' || typeof stamp !== 'string' || typeof mtimeMs !== 'number' || !Array.isArray(rows)) continue;
      this.files.set(file, { stamp, mtimeMs, rows: new Map(rows as Array<[string, RunRecord]>) });
    }
  }

  progress(): TranscriptIndexProgress {
    // Nothing is complete before the first walk has counted the files.
    return { complete: this.walked && this.pending === 0, filesParsed: this.total - this.pending, filesTotal: this.total };
  }

  async update(opts: TranscriptIndexUpdate = {}): Promise<void> {
    if (!this.loaded) await this.load();
    const found = new Map<string, { parse: (f: string) => Promise<CanonicalTokenRecord[]>; stamp: string; mtimeMs: number }>();
    for (const src of transcriptSources(this.scan)) {
      for (const file of await walkFiles(src.dir, src.keep)) {
        if (found.has(file)) continue; // first source wins, like scanAll
        const st = await fileStamp(file);
        if (st === null) continue;
        found.set(file, { parse: src.parse, ...st });
      }
    }
    for (const file of [...this.files.keys()]) if (!found.has(file)) { this.files.delete(file); this.dirty = true; }
    // Newest first, so a stopped or bounded pass has the recent sessions.
    const todo = [...found].filter(([file, f]) => this.files.get(file)?.stamp !== f.stamp).sort((a, b) => b[1].mtimeMs - a[1].mtimeMs);
    let pending = 0;
    let n = 0;
    for (const [file, f] of todo) {
      if (opts.shouldStop?.()) { pending++; continue; }
      if (opts.minMtimeMs !== undefined && f.mtimeMs < opts.minMtimeMs) { pending++; continue; }
      const rows: Rows = new Map();
      for (const r of await f.parse(file)) addTranscriptRecord(rows, this.pricer, { ...r, source: 'transcript', sourcePath: file });
      this.parseCount++;
      this.files.set(file, { stamp: f.stamp, mtimeMs: f.mtimeMs, rows });
      this.dirty = true;
      // A background backfill streams GBs of transcript text; collecting now
      // and then keeps the high-water RSS down (about a third lower measured).
      if (opts.yieldEvery !== undefined && this.parseCount % 500 === 0) (globalThis as { Bun?: { gc(force: boolean): void } }).Bun?.gc(true);
      if (opts.yieldEvery !== undefined && ++n % opts.yieldEvery === 0) await new Promise<void>((resolve) => setImmediate(resolve));
    }
    this.total = found.size;
    this.pending = pending;
    this.walked = true;
    for (const w of [...drainTranscriptWarnings(), ...this.pricer.drainWarnings()]) process.stderr.write(`[warn] ${w}\n`);
  }

  /** Merged rows (plus agents.d taps), minus sessions the registry owns. */
  async rows(runs: RunRecord[]): Promise<RunRecord[]> {
    const merged: Rows = new Map();
    for (const f of this.files.values()) {
      for (const [key, r] of f.rows) {
        const have = merged.get(key);
        if (have === undefined) merged.set(key, cloneRow(r));
        else mergeRow(have, r);
      }
    }
    const pricer = createPricer();
    const warnings = await addDescriptorTaps(merged, pricer, this.dir);
    for (const w of [...warnings, ...pricer.drainWarnings()]) process.stderr.write(`[warn] ${w}\n`);
    const claimed = claimedKeys(runs);
    return [...merged.values()].filter((r) => r.sessionId === undefined || !claimed.has(`${r.agent}\0${r.sessionId}`));
  }
}

const CACHE_VERSION = 1;

/**
 * Cached rows are parser output priced with the current table: a new ach
 * version (parsers, row shape), a different bundled extract, or a different
 * or edited pricing override file invalidates them.
 */
function cacheKey(): string {
  const meta = pricingMeta();
  const override = process.env[PRICING_OVERRIDE_ENV]?.trim() || null;
  let overrideStamp: string | null = null;
  if (override !== null) {
    try {
      const st = statSync(override);
      overrideStamp = `${st.mtimeMs}:${st.size}`;
    } catch {
      overrideStamp = 'missing';
    }
  }
  return JSON.stringify([VERSION, meta.snapshotDate, meta.modelCount, meta.source, override, overrideStamp]);
}

async function fileStamp(file: string): Promise<{ stamp: string; mtimeMs: number } | null> {
  try {
    const st = await stat(file);
    let stamp = `${st.mtimeMs}:${st.size}`;
    let mtimeMs = st.mtimeMs;
    try {
      // sqlite sources (cursor, goose) write through a WAL before the main file changes.
      const wal = await stat(`${file}-wal`);
      stamp += `:${wal.mtimeMs}:${wal.size}`;
      mtimeMs = Math.max(mtimeMs, wal.mtimeMs);
    } catch { /* no WAL */ }
    return { stamp, mtimeMs };
  } catch {
    return null;
  }
}
