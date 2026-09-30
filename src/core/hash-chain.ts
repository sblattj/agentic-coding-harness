// Tamper-evident metering (agentic-coding-harness#59): a per-run sha256 hash
// chain over every event line the driver writes, closed by a terminal seal.
//
// WHAT IS CHAINED
//   Both event logs the driver writes for a run, through this one helper:
//   - the raw transcript <stateDir>/raw/<agent>-<session>.jsonl (the file
//     `ach audit` re-derives RunRecord totals from — the numbers' evidence);
//   - the run-to-directory events.jsonl (#6) when RunSpec.outputDir is set.
//   The chain is PER RUN, not per file: a resumed session appends a second
//   run to the same transcript, and each run's lines carry their own runId, so
//   one file can hold several independent chains (and legacy unchained lines)
//   without any of them breaking.
//
// LINE FORMAT (v1)
//   A chained line is the event's own JSON with the chain metadata spliced in
//   as the FIRST key:
//     {"ach_chain":{"v":1,"run":"<runId>","seq":N,"prev":"<hex64>","hash":"<hex64>"},<rest of the event JSON>
//   Stripping that fixed-format prefix gives back, byte for byte, the line
//   the driver wrote before #59 (`JSON.stringify(event)`), called BODY below.
//
// WHAT IS HASHED (exact bytes, UTF-8)
//   hash = sha256( "ach-chain/v1\n" + runId + "\n" + seq + "\n" + prev + "\n" + BODY )
//   prev of seq 0 = sha256("ach-chain/v1\ngenesis\n" + runId).
//   The verifier recovers BODY by stripping the prefix, never by parse +
//   re-stringify, so the check is over the exact bytes on disk: re-ordering a
//   record's keys or re-spacing it counts as an edit.
//
// SEAL
//   The run's last chained line (seq = eventCount) is an `ach.seal` record:
//     {"type":"ach.seal","timestamp":..,"runId":..,"eventCount":N,
//      "lastHash":"<hash of seq N-1, or genesis>","totals":{..}|null,"totalsHash":..|null}
//   `totals` is the canonical metering subset of RunRecord.totals (the four
//   token counts, costUsd, credits); totalsHash = sha256(canonical JSON of it).
//   The seal line's own hash is the run's SEAL HASH, mirrored into
//   RunRecord.seal (and status.json in run-to-directory mode) together with
//   eventCount/lastHash/totalsHash — the external anchor that makes tail
//   truncation and a deleted seal line detectable.
//
// THREAT MODEL (tamper-EVIDENT, not tamper-proof — no keys, no signing)
//   Detects post-hoc edits to files on disk: any byte of a chained record,
//   deleted / inserted / reordered records, a truncated tail (given the
//   RunRecord anchor), and an edit to the sealed RunRecord totals. It does NOT
//   detect someone who rewrites the whole chain, the seal, and RunRecord.seal
//   consistently (anyone can recompute sha256), nor a compromised harness
//   process mid-run. Store the printed seal hash elsewhere to anchor a run
//   externally.

import { createHash } from 'node:crypto';

export const CHAIN_VERSION = 1;
export const CHAIN_KEY = 'ach_chain';
export const SEAL_EVENT_TYPE = 'ach.seal';
const DOMAIN = 'ach-chain/v1';

/** The metering subset of RunRecord.totals that a seal covers. */
export interface SealTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
  credits: number | null;
}

/** Terminal seal of one run's chain (RunRecord.seal / status.json seal). */
export interface RunSeal {
  v: 1;
  algo: 'sha256';
  /** Chained event records before the seal line (the seal line is seq = eventCount). */
  eventCount: number;
  /** Hash of the last event record (genesis hash when eventCount is 0). */
  lastHash: string;
  /** Hash of the seal line itself — print this and store it elsewhere to anchor the run. */
  sealHash: string;
  /** sha256 of the canonical sealed totals; null when the run had no totals to seal. */
  totalsHash: string | null;
  /** ms epoch the seal was written. */
  at: number;
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export function genesisHash(runId: string): string {
  return sha256Hex(`${DOMAIN}\ngenesis\n${runId}`);
}

/** The chain link: hash of one record's BODY bound to its run, position, and predecessor. */
export function linkHash(runId: string, seq: number, prev: string, body: string): string {
  return sha256Hex(`${DOMAIN}\n${runId}\n${seq}\n${prev}\n${body}`);
}

/** Canonical sealed-totals object (fixed key order, credits null when absent). */
export function canonicalTotals(t: {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
  credits?: number | null;
}): SealTotals {
  return {
    inputTokens: t.inputTokens,
    outputTokens: t.outputTokens,
    cacheReadTokens: t.cacheReadTokens,
    cacheWriteTokens: t.cacheWriteTokens,
    costUsd: t.costUsd,
    credits: typeof t.credits === 'number' ? t.credits : null,
  };
}

export function totalsHash(t: Parameters<typeof canonicalTotals>[0]): string {
  return sha256Hex(JSON.stringify(canonicalTotals(t)));
}

function frame(runId: string, seq: number, prev: string, hash: string, body: string): string {
  if (!body.startsWith('{') || !body.endsWith('}')) {
    throw new Error('hash-chain: record body must be a JSON object');
  }
  const head = `{"${CHAIN_KEY}":{"v":${CHAIN_VERSION},"run":${JSON.stringify(runId)},"seq":${seq},"prev":"${prev}","hash":"${hash}"}`;
  return body === '{}' ? `${head}}` : `${head},${body.slice(1)}`;
}

/**
 * Writer-side chain state for ONE run. frame() turns an event body into the
 * chained line to append (no trailing newline); seal() closes the chain.
 * Two writers built for the same runId and fed the same bodies produce
 * identical lines, so the transcript and events.jsonl chains agree.
 */
export class ChainWriter {
  readonly runId: string;
  #seq = 0;
  #prev: string;
  #seal: RunSeal | null = null;

  constructor(runId: string) {
    this.runId = runId;
    this.#prev = genesisHash(runId);
  }

  get eventCount(): number {
    return this.#seal?.eventCount ?? this.#seq;
  }

  get sealed(): RunSeal | null {
    return this.#seal;
  }

  /** Chain one record body (`JSON.stringify(event)`); returns the line to write. */
  frame(body: string): string {
    if (this.#seal !== null) throw new Error(`hash-chain: run ${this.runId} is already sealed`);
    const hash = linkHash(this.runId, this.#seq, this.#prev, body);
    const line = frame(this.runId, this.#seq, this.#prev, hash, body);
    this.#prev = hash;
    this.#seq++;
    return line;
  }

  /** Close the chain with the terminal seal record. Idempotent: a second call returns null. */
  seal(at: number, totals: SealTotals | null): { line: string; seal: RunSeal } | null {
    if (this.#seal !== null) return null;
    const eventCount = this.#seq;
    const lastHash = this.#prev;
    const tHash = totals === null ? null : sha256Hex(JSON.stringify(canonicalTotals(totals)));
    const body = JSON.stringify({
      type: SEAL_EVENT_TYPE,
      timestamp: at,
      runId: this.runId,
      eventCount,
      lastHash,
      totals: totals === null ? null : canonicalTotals(totals),
      totalsHash: tHash,
    });
    const line = this.frame(body);
    this.#seal = { v: 1, algo: 'sha256', eventCount, lastHash, sealHash: this.#prev, totalsHash: tHash, at };
    return { line, seal: this.#seal };
  }
}

// ---------------------------------------------------------------- verification

const FRAME_RE =
  /^\{"ach_chain":\{"v":1,"run":("(?:[^"\\]|\\.)*"),"seq":(0|[1-9]\d*),"prev":"([0-9a-f]{64})","hash":"([0-9a-f]{64})"\}([,}])/;

export interface FramedLine {
  run: string;
  seq: number;
  prev: string;
  hash: string;
  /** The exact hashed body recovered from the line. */
  body: string;
}

/** Parse a chained line's prefix; null when the line is not a well-formed chained record. */
export function parseFramedLine(line: string): FramedLine | null {
  const m = FRAME_RE.exec(line);
  if (m === null) return null;
  let run: string;
  try {
    run = JSON.parse(m[1]!) as string;
  } catch {
    return null;
  }
  const rest = line.slice(m[0].length);
  let body: string;
  if (m[5] === '}') {
    if (rest !== '') return null;
    body = '{}';
  } else {
    body = `{${rest}`;
  }
  return { run, seq: Number(m[2]), prev: m[3]!, hash: m[4]!, body };
}

/** Strip the chain metadata from a chained line: the original event JSON line, or the line unchanged. */
export function stripChain(line: string): string {
  return parseFramedLine(line)?.body ?? line;
}

/**
 * ok        chain intact and sealed (and, when checked, totals match the seal)
 * tampered  a break: edited / deleted / inserted / reordered record, truncated
 *           tail, seal disagreeing with its anchor, or edited sealed totals
 * unsealed  legacy: no chained record for this run at all (pre-#59 log)
 * open      chained records intact but no seal and no anchor — a run still
 *           in progress, or one that crashed before sealing
 */
export type ChainStatus = 'ok' | 'tampered' | 'unsealed' | 'open';

export interface ChainRecordCheck {
  /** 1-based line number in the file. */
  line: number;
  seq: number;
  type: string;
  hash: string;
}

export interface ChainBreak {
  /** 1-based line number of the first bad record (file length + 1 for a missing tail). */
  line: number;
  seq?: number;
  reason: string;
}

export type TotalsCheck =
  | { status: 'match' }
  | { status: 'match-after-corrections'; corrections: number }
  | { status: 'mismatch'; fields: Array<{ field: keyof SealTotals; sealed: number | null; recorded: number | null }> }
  | { status: 'not-checked'; reason: string };

export interface ChainVerification {
  status: ChainStatus;
  runId: string;
  /** Chained event records verified (seal line excluded). */
  records: number;
  sealed: boolean;
  sealHash?: string;
  /** Totals the seal line recorded. */
  sealedTotals?: SealTotals | null;
  totals?: TotalsCheck;
  firstBad?: ChainBreak;
  /** Informational notes (e.g. no external anchor). */
  notes: string[];
  /** Per-record verification, in chain order (seal line included). */
  checks: ChainRecordCheck[];
}

/** A RunRecord-side correction entry (RunRecord.corrections, written by `ach audit --fix`). */
export interface TotalsCorrection {
  at: number;
  field: string;
  from: number;
  to: number;
}

export interface VerifyChainOptions {
  runId: string;
  /** External anchor (RunRecord.seal or status.json seal). */
  anchor?: RunSeal;
  /** Recorded totals to check against the sealed totals (RunRecord.totals). */
  totals?: Parameters<typeof canonicalTotals>[0];
  /** RunRecord.corrections: legitimate post-seal `ach audit --fix` rewrites. */
  corrections?: readonly TotalsCorrection[];
}

const TOTAL_FIELDS: ReadonlyArray<keyof SealTotals> = [
  'inputTokens',
  'outputTokens',
  'cacheReadTokens',
  'cacheWriteTokens',
  'costUsd',
  'credits',
];

function checkTotals(
  sealedHash: string | null,
  sealedTotals: SealTotals | null,
  recorded: Parameters<typeof canonicalTotals>[0] | undefined,
  corrections: readonly TotalsCorrection[] | undefined,
  sealAt: number,
): TotalsCheck {
  if (recorded === undefined) return { status: 'not-checked', reason: 'no recorded totals to compare' };
  if (sealedHash === null || sealedTotals === null) return { status: 'not-checked', reason: 'seal carries no totals' };
  const current = canonicalTotals(recorded);
  if (totalsHash(current) === sealedHash) return { status: 'match' };
  // Undo `ach audit --fix` corrections made after the seal, newest first: a
  // disclosed, audited rewrite is not tampering — but it is reported.
  const later = (corrections ?? []).filter((c) => c.at >= sealAt && c.field.startsWith('totals.'));
  if (later.length > 0) {
    const undone: SealTotals = { ...current };
    for (const c of [...later].sort((a, b) => b.at - a.at)) {
      const f = c.field.slice('totals.'.length) as keyof SealTotals;
      if (TOTAL_FIELDS.includes(f)) undone[f] = c.from;
    }
    if (totalsHash(undone) === sealedHash) return { status: 'match-after-corrections', corrections: later.length };
  }
  const fields = TOTAL_FIELDS.filter((f) => current[f] !== sealedTotals[f]).map((f) => ({
    field: f,
    sealed: sealedTotals[f],
    recorded: current[f],
  }));
  return { status: 'mismatch', fields };
}

/**
 * Verify one run's chain inside a JSONL file's text. Lines chained to OTHER
 * runs are skipped (a resumed session's transcript holds several runs);
 * unchained lines before the run's first record are legacy history and are
 * ignored, but any unchained or malformed line between the run's first
 * record and its seal is a break (e.g. a planted `usage` line).
 */
export function verifyChainText(text: string, opts: VerifyChainOptions): ChainVerification {
  const { runId, anchor } = opts;
  const out: ChainVerification = { status: 'ok', runId, records: 0, sealed: false, notes: [], checks: [] };
  const fail = (b: ChainBreak): ChainVerification => {
    out.status = 'tampered';
    out.firstBad = b;
    return out;
  };

  const lines = text.split('\n');
  // A file that ends in '\n' yields a trailing '' — not a line.
  const lastIndex = lines.length > 0 && lines[lines.length - 1] === '' ? lines.length - 1 : lines.length;
  let expectedSeq = 0;
  let expectedPrev = genesisHash(runId);
  let inSegment = false;
  let pendingForeign: number | null = null;
  let sealBody: Record<string, unknown> | null = null;
  let sealLine = 0;

  for (let i = 0; i < lastIndex; i++) {
    const raw = lines[i]!;
    const lineNo = i + 1;
    const framed = parseFramedLine(raw);
    if (framed === null || framed.run !== runId) {
      // Another run's chained record: legitimate interleaving, skip it.
      if (framed !== null) continue;
      if (raw.trim() === '') continue;
      if (inSegment && sealBody === null && pendingForeign === null) pendingForeign = lineNo;
      continue;
    }
    if (sealBody !== null) {
      return fail({ line: lineNo, seq: framed.seq, reason: 'chained record after the terminal seal' });
    }
    if (pendingForeign !== null) {
      return fail({ line: pendingForeign, reason: 'unchained or malformed line inside the run (record inserted or its chain prefix edited)' });
    }
    inSegment = true;
    if (framed.seq !== expectedSeq) {
      return fail({
        line: lineNo,
        seq: framed.seq,
        reason: `sequence break: expected seq ${expectedSeq}, found ${framed.seq} (record deleted, inserted, or reordered)`,
      });
    }
    if (framed.prev !== expectedPrev) {
      return fail({ line: lineNo, seq: framed.seq, reason: 'prev hash does not link to the previous record' });
    }
    const recomputed = linkHash(runId, framed.seq, framed.prev, framed.body);
    if (recomputed !== framed.hash) {
      return fail({ line: lineNo, seq: framed.seq, reason: 'hash mismatch: record content was edited' });
    }
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(framed.body) as Record<string, unknown>;
    } catch {
      return fail({ line: lineNo, seq: framed.seq, reason: 'record body is not valid JSON' });
    }
    const type = typeof parsed.type === 'string' ? parsed.type : '?';
    out.checks.push({ line: lineNo, seq: framed.seq, type, hash: framed.hash });
    if (type === SEAL_EVENT_TYPE) {
      if (parsed.eventCount !== framed.seq || parsed.lastHash !== framed.prev || parsed.runId !== runId) {
        return fail({ line: lineNo, seq: framed.seq, reason: 'seal record does not describe the chain it closes' });
      }
      sealBody = parsed;
      sealLine = lineNo;
      out.sealed = true;
      out.sealHash = framed.hash;
    } else {
      out.records++;
    }
    expectedSeq++;
    expectedPrev = framed.hash;
  }

  const tailLine = lastIndex + 1;
  if (!inSegment) {
    if (anchor !== undefined) {
      return fail({ line: 1, reason: `no chained record for this run, but its anchor records a seal over ${anchor.eventCount} record(s) (log deleted or replaced)` });
    }
    out.status = 'unsealed';
    out.notes.push('unsealed (legacy): the log carries no hash chain for this run');
    return out;
  }
  if (sealBody === null) {
    if (anchor !== undefined) {
      return fail({
        line: tailLine,
        seq: expectedSeq,
        reason: `seal record missing: log ends after ${out.records} record(s) but the anchor sealed ${anchor.eventCount} (tail truncated)`,
      });
    }
    if (pendingForeign !== null) out.notes.push(`unchained line ${pendingForeign} follows the last chained record`);
    out.status = 'open';
    out.notes.push('open: chain intact but not sealed (run still in progress, or it ended before sealing)');
    return out;
  }
  if (anchor !== undefined) {
    if (anchor.sealHash !== out.sealHash || anchor.eventCount !== sealBody.eventCount || anchor.lastHash !== sealBody.lastHash) {
      return fail({ line: sealLine, seq: expectedSeq - 1, reason: 'seal record disagrees with its anchor (RunRecord.seal / status.json)' });
    }
    if (anchor.totalsHash !== (sealBody.totalsHash ?? null)) {
      return fail({ line: sealLine, seq: expectedSeq - 1, reason: 'sealed totals hash disagrees with its anchor' });
    }
  } else {
    out.notes.push('no external anchor (RunRecord.seal) — a consistent rewrite of the whole chain would not be detected');
  }
  const sealedTotals = (sealBody.totals ?? null) as SealTotals | null;
  const sealedTotalsHash = (sealBody.totalsHash ?? null) as string | null;
  out.sealedTotals = sealedTotals;
  // The seal line's own totals object and its hash must agree.
  if ((sealedTotals === null) !== (sealedTotalsHash === null) || (sealedTotals !== null && totalsHash(sealedTotals) !== sealedTotalsHash)) {
    return fail({ line: sealLine, seq: expectedSeq - 1, reason: 'seal record totals disagree with its totalsHash' });
  }
  const sealAt = typeof sealBody.timestamp === 'number' ? sealBody.timestamp : 0;
  out.totals = checkTotals(sealedTotalsHash, sealedTotals, opts.totals, opts.corrections, sealAt);
  if (out.totals.status === 'mismatch') {
    const what = out.totals.fields.map((f) => `${f.field} sealed=${f.sealed} recorded=${f.recorded}`).join(', ');
    return fail({ line: sealLine, seq: expectedSeq - 1, reason: `recorded totals differ from the sealed totals${what ? `: ${what}` : ''}` });
  }
  if (out.totals.status === 'match-after-corrections') {
    out.notes.push(`totals match the seal after undoing ${out.totals.corrections} \`ach audit --fix\` correction(s) (RunRecord.corrections)`);
  }
  return out;
}
