// Cursor dashboard usage export (CSV or JSON) -> canonical token records.
//
// The Cursor IDE keeps no per-message tokens on disk any more (see ./cursor.ts),
// but the dashboard exports the exact per-request usage:
//  - CSV  `GET /api/dashboard/export-usage-events-csv`
//  - JSON `POST /api/dashboard/get-filtered-usage-events`
// Both captured live 2026-10-09 (tests/fixtures/cursor-dashboard/). Contract and
// mapping: docs/transcript-adapters.md ("Cursor dashboard export").
//
// Records carry `extra.source === "cursor-dashboard"`; consumers key on that.
import fs from 'node:fs';
import path from 'node:path';
import type { CanonicalTokenRecord } from './transcripts.ts';
import { warnTranscript, type WarnFn } from './transcript-warnings.ts';

export const CURSOR_DASHBOARD_SOURCE = 'cursor-dashboard';
export const CURSOR_DASHBOARD_DIR = 'cursor-dashboard';

export const CURSOR_CSV_HEADER =
  'Date,Cloud Agent ID,Automation ID,Kind,Model,Max Mode,Input (w/ Cache Write),Input (w/o Cache Write),Cache Read,Output Tokens,Total Tokens,Cost';

export type CursorExportFormat = 'csv' | 'json';

/** Detect the export format of `text`, or null when it is neither. */
export function detectCursorExportFormat(text: string): CursorExportFormat | null {
  const t = text.replace(/^﻿/, '');
  const firstLine = t.split(/\r?\n/, 1)[0] ?? '';
  if (firstLine.trim() === CURSOR_CSV_HEADER) return 'csv';
  if (t.trimStart().startsWith('{')) {
    try {
      const j = JSON.parse(t) as { usageEventsDisplay?: unknown };
      if (j && Array.isArray(j.usageEventsDisplay)) return 'json';
    } catch { /* not JSON */ }
  }
  return null;
}

/** RFC-4180-style parser: every field may be quoted; `""` escapes a quote; commas and newlines inside quotes are data. */
export function parseCsvRecords(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let sawAny = false;
  const s = text.replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else field += c;
      continue;
    }
    if (c === '"') { inQuotes = true; sawAny = true; }
    else if (c === ',') { row.push(field); field = ''; sawAny = true; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      if (sawAny || field !== '') { row.push(field); rows.push(row); }
      row = []; field = ''; sawAny = false;
    } else { field += c; sawAny = true; }
  }
  if (sawAny || field !== '') { row.push(field); rows.push(row); }
  return rows;
}

function counter(v: string): number | null {
  const t = v.trim();
  if (!/^\d+$/.test(t)) return null;
  const n = Number(t);
  return Number.isSafeInteger(n) ? n : null;
}

function modelOf(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const m = raw.trim();
  if (!m || m === 'auto' || m === 'default') return null;
  return m;
}

function parseCsv(text: string, file: string, warn: WarnFn): CanonicalTokenRecord[] {
  const rows = parseCsvRecords(text);
  const out: CanonicalTokenRecord[] = [];
  for (let r = 1; r < rows.length; r++) {
    const f = rows[r]!;
    const n = r; // data row number, 1-based after the header
    if (f.length !== 12) { warn(`cursor-dashboard: ${file}: row ${n}: skipped, expected 12 fields, got ${f.length}`); continue; }
    const ms = Date.parse(f[0]!);
    if (!Number.isFinite(ms)) { warn(`cursor-dashboard: ${file}: row ${n}: skipped, unparseable Date '${f[0]}'`); continue; }
    const cacheWrite = counter(f[6]!);
    const input = counter(f[7]!);
    const cacheRead = counter(f[8]!);
    const output = counter(f[9]!);
    if (cacheWrite === null || input === null || cacheRead === null || output === null) {
      warn(`cursor-dashboard: ${file}: row ${n}: skipped, a token counter is not a non-negative integer`); continue;
    }
    const total = counter(f[10]!);
    const sum = cacheWrite + input + cacheRead + output;
    if (total === null || total !== sum) {
      warn(`cursor-dashboard: ${file}: row ${n}: skipped, Total Tokens ${f[10]} != sum of the four counters ${sum}`); continue;
    }
    const rec: CanonicalTokenRecord = {
      agent: 'cursor', sessionId: null, timestamp: new Date(ms).toISOString(), model: modelOf(f[4]),
      input, output, cacheRead, cacheWrite, reasoning: 0,
      extra: { source: CURSOR_DASHBOARD_SOURCE, costBasis: 'cursor-dashboard-charged' },
    };
    const costRaw = f[11]!.trim();
    if (costRaw !== '') {
      const cost = Number(costRaw.replace(/^\$/, ''));
      if (Number.isFinite(cost) && cost >= 0) rec.costUsd = cost;
      else warn(`cursor-dashboard: ${file}: row ${n}: unreadable Cost '${f[11]}', record kept without cost`);
    }
    out.push(rec);
  }
  return out;
}

function nonNegInt(v: unknown): number | null {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null;
}

function parseJson(text: string, file: string, warn: WarnFn): CanonicalTokenRecord[] {
  let events: unknown[];
  try { events = (JSON.parse(text.replace(/^﻿/, '')) as { usageEventsDisplay: unknown[] }).usageEventsDisplay; }
  catch (e) { warn(`cursor-dashboard: ${file}: unreadable JSON: ${(e as Error).message}`); return []; }
  const out: CanonicalTokenRecord[] = [];
  events.forEach((raw, idx) => {
    const n = idx + 1;
    const ev = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const tu = (ev.tokenUsage && typeof ev.tokenUsage === 'object' ? ev.tokenUsage : null) as Record<string, unknown> | null;
    const ms = typeof ev.timestamp === 'string' || typeof ev.timestamp === 'number' ? Number(ev.timestamp) : NaN;
    if (!Number.isFinite(ms) || !Number.isFinite(new Date(ms).getTime())) {
      warn(`cursor-dashboard: ${file}: event ${n}: skipped, unparseable timestamp`); return;
    }
    const keys = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'] as const;
    const present = tu ? keys.filter((k) => tu[k] !== undefined) : [];
    if (!tu || present.length === 0 || (present.length < keys.length && ev.isTokenBasedCall !== true)) {
      warn(`cursor-dashboard: ${file}: event ${n}: skipped, token counters absent${ev.isTokenBasedCall === true ? '' : ' (not a token-based call)'}`); return;
    }
    const vals: Record<string, number> = {};
    for (const k of keys) {
      if (tu[k] === undefined) { vals[k] = 0; continue; }
      const v = nonNegInt(tu[k]);
      if (v === null) { warn(`cursor-dashboard: ${file}: event ${n}: skipped, ${k} is not a non-negative integer`); return; }
      vals[k] = v;
    }
    const rec: CanonicalTokenRecord = {
      agent: 'cursor',
      sessionId: typeof ev.conversationId === 'string' && ev.conversationId ? ev.conversationId : null,
      timestamp: new Date(ms).toISOString(), model: modelOf(ev.model),
      input: vals.inputTokens!, output: vals.outputTokens!, cacheRead: vals.cacheReadTokens!, cacheWrite: vals.cacheWriteTokens!, reasoning: 0,
      extra: { source: CURSOR_DASHBOARD_SOURCE, costBasis: 'cursor-dashboard-charged' },
    };
    // chargedCents is what the dashboard shows as Cost; tokenUsage.totalCents is a different, larger figure.
    if (typeof ev.chargedCents === 'number' && Number.isFinite(ev.chargedCents) && ev.chargedCents >= 0) rec.costUsd = ev.chargedCents / 100;
    out.push(rec);
  });
  return out;
}

/** Parse one dashboard export. Unknown format: one warning, `[]`. */
export function parseCursorDashboardExport(text: string, file: string, warn: WarnFn = warnTranscript): CanonicalTokenRecord[] {
  const fmt = detectCursorExportFormat(text);
  if (fmt === 'csv') return parseCsv(text, file, warn);
  if (fmt === 'json') return parseJson(text, file, warn);
  warn(`cursor-dashboard: ${file}: not a Cursor dashboard usage export (expected the CSV header or a JSON object with usageEventsDisplay)`);
  return [];
}

/** Request identity across exports: timestamp to the second plus the three stable counters. */
export function dashboardIdentity(r: CanonicalTokenRecord): string {
  return `${(r.timestamp ?? '').slice(0, 19)}|${r.input}|${r.cacheRead}|${r.output}`;
}

/** Read every stored export under <stateDir>/cursor-dashboard/; one record per request, JSON copies preferred. */
export function readCursorDashboardStore(stateDir: string, warn: WarnFn = warnTranscript): CanonicalTokenRecord[] {
  const dir = path.join(stateDir, CURSOR_DASHBOARD_DIR);
  let names: string[];
  try { names = fs.readdirSync(dir); } catch { return []; }
  const files = names.filter((n) => /\.(csv|json)$/i.test(n)).sort();
  // JSON first so its copy (conversationId, precise cost) wins the identity.
  files.sort((a, b) => Number(/\.json$/i.test(b)) - Number(/\.json$/i.test(a)) || (a < b ? -1 : a > b ? 1 : 0));
  const seen = new Set<string>();
  const out: CanonicalTokenRecord[] = [];
  for (const name of files) {
    const file = path.join(dir, name);
    let text: string;
    try { text = fs.readFileSync(file, 'utf8'); } catch (e) { warn(`cursor-dashboard: ${file}: unreadable: ${(e as Error).message}`); continue; }
    for (const rec of parseCursorDashboardExport(text, file, warn)) {
      const id = dashboardIdentity(rec);
      if (seen.has(id)) continue;
      seen.add(id);
      out.push(rec);
    }
  }
  return out;
}
