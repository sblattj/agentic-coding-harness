// Cursor globalStorage/state.vscdb, cursorDiskKV bubbleId:<composer>:<bubble>.
// Format evidence: codeburn tests/providers/cursor-real-tokens.test.ts.
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
    const { stdout } = await exec('sqlite3', ['-readonly', '-json', file, "SELECT key, CAST(value AS TEXT) AS value FROM cursorDiskKV WHERE key LIKE 'bubbleId:%' ORDER BY key"], { maxBuffer: 64 * 1024 * 1024 });
    const rows: Array<{ key: string; value: string }> = JSON.parse(stdout || '[]');
    let unavailable = 0;
    for (const row of rows) {
      try {
        const bubble = JSON.parse(row.value);
        const usage = bubble?.tokenCount;
        if (!usage || (usage.inputTokens === 0 && usage.outputTokens === 0)) { unavailable++; continue; }
        if (![usage.inputTokens, usage.outputTokens].every((n) => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0)) {
          warn(`cursor: ${file}: skipped ${row.key}: invalid reported tokenCount`); continue;
        }
        const timestamp = typeof bubble.createdAt === 'string' && Number.isFinite(Date.parse(bubble.createdAt)) ? bubble.createdAt : null;
        out.push({ agent: 'cursor', sessionId: row.key.split(':')[1] || null, timestamp,
          model: typeof bubble.modelInfo?.modelName === 'string' ? bubble.modelInfo.modelName : null,
          input: usage.inputTokens, output: usage.outputTokens, cacheRead: 0, cacheWrite: 0, reasoning: 0 });
      } catch { warn(`cursor: ${file}: skipped malformed bubble ${row.key}`); }
    }
    if (unavailable) warn(`cursor: ${file}: reported usage unavailable for ${unavailable} bubbles; no token estimates used`);
  } catch (error) { warn(`cursor: skipped unreadable store ${file}: ${(error as Error).message}`); }
  return out;
}
