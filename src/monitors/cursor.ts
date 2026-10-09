// Cursor globalStorage/state.vscdb, cursorDiskKV bubbleId:<composer>:<bubble>.
// Format evidence: codeburn tests/providers/cursor-real-tokens.test.ts and
// docs/providers/cursor.md; alp82/aistack docs/research/harness-adapters-2026-08.md
// (a real 2026-08 store: tokenCount {0,0} on all but 12 of 39,060 bubbles, and
// newer conversations stored as agentKv:blob:<sha256> rows with no tokens).
// Read only explicit tokenCount counters. Context snapshots and text lengths
// are not billed usage and must never become estimated token records.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { CanonicalTokenRecord } from './transcripts.ts';
import { warnTranscript, type WarnFn } from './transcript-warnings.ts';
const exec = promisify(execFile);
export async function parseCursorDb(file: string, warn: WarnFn = warnTranscript): Promise<CanonicalTokenRecord[]> {
  const out: CanonicalTokenRecord[] = [];
  try {
    // One sqlite3 process. SQLite extracts only the fields read here, so message
    // text and conversation blobs never cross the pipe (a 2026 store holds tens
    // of thousands of bubbles and agentKv blobs). Invalid JSON yields NULL.
    // composerData context gauges (contextTokensUsed, promptTokenBreakdown) are
    // never selected; only modelConfig.modelName. agentKv blobs are counted only.
    const j = (path: string): string => `json_extract(CAST(value AS TEXT), '${path}')`;
    const sql = `SELECT key, CASE WHEN json_valid(CAST(value AS TEXT)) THEN json_object('tokenCount', ${j('$.tokenCount')}, 'createdAt', ${j('$.createdAt')}, 'model', ${j('$.modelInfo.modelName')}) END AS value FROM cursorDiskKV WHERE key LIKE 'bubbleId:%' `
      + `UNION ALL SELECT key, CASE WHEN json_valid(CAST(value AS TEXT)) THEN json_object('model', ${j('$.modelConfig.modelName')}) END FROM cursorDiskKV WHERE key LIKE 'composerData:%' `
      + "UNION ALL SELECT 'agentKv:count', CAST(COUNT(*) AS TEXT) FROM cursorDiskKV WHERE key LIKE 'agentKv:blob:%' ORDER BY key";
    const { stdout } = await exec('sqlite3', ['-readonly', '-json', file, sql], { maxBuffer: 64 * 1024 * 1024 });
    const rows: Array<{ key: string; value: string | null }> = JSON.parse(stdout || '[]');
    // "default" is Cursor's auto-routing: the served model is unknown.
    const named = (m: unknown): string | null => (typeof m === 'string' && m.trim() !== '' && m !== 'default' ? m : null);
    const composerModel = new Map<string, string>();
    let agentKv = 0;
    for (const row of rows) {
      if (row.key === 'agentKv:count') { agentKv = Number(row.value) || 0; continue; }
      if (!row.key.startsWith('composerData:') || row.value === null) continue;
      const name = named(JSON.parse(row.value)?.model);
      if (name) composerModel.set(row.key.slice('composerData:'.length), name);
    }
    let unavailable = 0;
    for (const row of rows) {
      if (!row.key.startsWith('bubbleId:')) continue;
      try {
        if (row.value === null) throw new Error('invalid JSON');
        const bubble = JSON.parse(row.value);
        const usage = bubble?.tokenCount;
        if (!usage || (usage.inputTokens === 0 && usage.outputTokens === 0)) { unavailable++; continue; }
        if (![usage.inputTokens, usage.outputTokens].every((n) => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0)) {
          warn(`cursor: ${file}: skipped ${row.key}: invalid reported tokenCount`); continue;
        }
        const created = bubble.createdAt;
        const ms = typeof created === 'string' ? Date.parse(created) : typeof created === 'number' ? created : NaN;
        const timestamp = Number.isFinite(ms) && Number.isFinite(new Date(ms).getTime()) ? (typeof created === 'string' ? created : new Date(ms).toISOString()) : null;
        const sessionId = row.key.split(':')[1] || null;
        const model = named(bubble.model) ?? (sessionId ? composerModel.get(sessionId) ?? null : null);
        out.push({ agent: 'cursor', sessionId, timestamp, model,
          input: usage.inputTokens, output: usage.outputTokens, cacheRead: 0, cacheWrite: 0, reasoning: 0 });
      } catch { warn(`cursor: ${file}: skipped malformed bubble ${row.key}`); }
    }
    if (!out.length && (unavailable > 0 || agentKv > 0)) {
      warn(`cursor: ${file}: this Cursor build does not record per-message token counts locally (${unavailable + agentKv} conversation entries without usage); use \`ach run --agent cursor\` for exact CLI usage or the Cursor dashboard usage export`);
    } else if (unavailable) warn(`cursor: ${file}: reported usage unavailable for ${unavailable} bubbles; no token estimates used`);
  } catch (error) { warn(`cursor: skipped unreadable store ${file}: ${(error as Error).message}`); }
  return out;
}
