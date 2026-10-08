import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  KIRO_MITM_ADDON,
  buildEventStreamFrame,
  frameToMitmLine,
  parseEventStreamFrames,
  parseMitmLine,
  writeAddonScript,
} from '../src/monitors/kiro-mitm.js';
import { mitmRecordToUsageEvent } from '../src/adapters/kiro.js';
import { computeUsageAvailability } from '../src/core/usage-availability.js';
import type { CanonicalTokenRecord } from '../src/core/types.js';

const TOKEN_USAGE = {
  uncachedInputTokens: 1200,
  cacheReadInputTokens: 3400,
  cacheWriteInputTokens: 500,
  outputTokens: 210,
  totalTokens: 5310,
};

function python3Available(): boolean {
  try {
    const r = spawnSync('python3', ['--version'], { encoding: 'utf8' });
    return !r.error && r.status === 0;
  } catch {
    return false;
  }
}

describe('kiro-mitm EventStream frame parser (TS)', () => {
  it('extracts tokenUsage from a base64-encoded metadataEvent frame', () => {
    const payload = Buffer.from(JSON.stringify({ tokenUsage: TOKEN_USAGE, contextUsagePercentage: 42.5 }));
    const b64 = buildEventStreamFrame('metadataEvent', payload).toString('base64');
    const frames = parseEventStreamFrames(Buffer.from(b64, 'base64'));
    assert.equal(frames.length, 1);
    assert.equal(frames[0].eventType, 'metadataEvent');
    const line = frameToMitmLine(frames[0]);
    assert.ok(line, 'metadata frame should yield an emit line');
    const rec = parseMitmLine(JSON.stringify(line));
    assert.ok(rec);
    assert.equal(rec.agent, 'kiro');
    assert.equal(rec.inputTokens, 1200);
    assert.equal(rec.cacheReadTokens, 3400);
    assert.equal(rec.cacheWriteTokens, 500);
    assert.equal(rec.outputTokens, 210);
    assert.equal(rec.extra?.totalTokens, 5310);
    assert.equal(rec.extra?.contextUsagePercentage, 42.5);
    assert.equal(rec.extra?.event, 'metadataEvent');
    assert.equal(typeof rec.timestamp, 'number');
  });

  it('rejects frames with corrupted CRC or truncated data', () => {
    const good = buildEventStreamFrame('metadataEvent', Buffer.from(JSON.stringify({ tokenUsage: TOKEN_USAGE })));

    const badMsgCrc = Buffer.from(good);
    badMsgCrc[badMsgCrc.length - 1] ^= 0xff;
    assert.equal(parseEventStreamFrames(badMsgCrc).length, 0);

    const badPreludeCrc = Buffer.from(good);
    badPreludeCrc[8] ^= 0x01;
    assert.equal(parseEventStreamFrames(badPreludeCrc).length, 0);

    assert.equal(parseEventStreamFrames(good.subarray(0, good.length - 3)).length, 0);
  });

  it('ignores non-metering frames and non-JSON lines', () => {
    const frame = buildEventStreamFrame('assistantResponseEvent', Buffer.from(JSON.stringify({ content: 'hi' })));
    const [f] = parseEventStreamFrames(frame);
    assert.ok(f);
    assert.equal(frameToMitmLine(f), null);

    assert.equal(parseMitmLine('mitmdump: listening at *:8888'), null);
    assert.equal(parseMitmLine('{"event":"nope"}'), null);
    assert.equal(parseMitmLine('not json'), null);
    assert.equal(parseMitmLine(''), null);
  });

  it('parses multiple concatenated frames and coerces string numerics', () => {
    const stream = Buffer.concat([
      buildEventStreamFrame('assistantResponseEvent', Buffer.from('{"content":"hi"}')),
      buildEventStreamFrame(
        'messageMetadataEvent',
        Buffer.from(JSON.stringify({ tokenUsage: { ...TOKEN_USAGE, outputTokens: '210' } })),
      ),
    ]);
    const frames = parseEventStreamFrames(stream);
    assert.equal(frames.length, 2);
    const line = frameToMitmLine(frames[1]);
    assert.ok(line);
    assert.equal(line.event, 'messageMetadataEvent');
    const rec = parseMitmLine(JSON.stringify(line));
    assert.equal(rec?.outputTokens, 210);
    assert.equal(rec?.extra?.totalTokens, 5310);
  });
});

describe('kiro-mitm python addon selftest', () => {
  const hasPython = python3Available();

  it('addon source is self-consistent', () => {
    assert.ok(KIRO_MITM_ADDON.includes('def response(flow)'));
    assert.ok(KIRO_MITM_ADDON.includes('--selftest'));
    assert.ok(KIRO_MITM_ADDON.includes('generateAssistantResponse'));
    assert.ok(KIRO_MITM_ADDON.includes(String.raw`runtime\.[^/?#]*\.kiro\.dev`));
  });

  it('python3 parses a hex-encoded metadataEvent frame', { skip: hasPython ? false : 'python3 not available' }, () => {
    const payload = Buffer.from(JSON.stringify({ tokenUsage: TOKEN_USAGE, credits: 0.42 }));
    const hex = buildEventStreamFrame('messageMetadataEvent', payload).toString('hex');
    const script = writeAddonScript();
    const out = execFileSync('python3', [script, '--selftest', hex], { encoding: 'utf8' });
    const jsonLine = out
      .trim()
      .split('\n')
      .find((l) => l.startsWith('{'));
    assert.ok(jsonLine, `expected a JSON line in selftest output, got: ${JSON.stringify(out)}`);
    const rec = parseMitmLine(jsonLine);
    assert.ok(rec);
    assert.equal(rec.extra?.event, 'messageMetadataEvent');
    assert.equal(rec.inputTokens, 1200);
    assert.equal(rec.cacheReadTokens, 3400);
    assert.equal(rec.cacheWriteTokens, 500);
    assert.equal(rec.outputTokens, 210);
    assert.equal(rec.extra?.totalTokens, 5310);
    const credits = rec.extra?.credits;
    assert.ok(typeof credits === 'number' && Math.abs(credits - 0.42) < 1e-9);
  });
});

// Issue #121: raw kiro-cli 2.28.0 turn. No frame carries tokenUsage; context
// arrives on its own contextUsageEvent; credits on meteringEvent.usage.
const KIRO_228_FRAMES: Array<[string, Record<string, unknown>]> = [
  ['initial', { conversationId: '' }],
  ['metadataEvent', { stopReason: 'END_TURN' }],
  ['contextUsageEvent', { contextUsagePercentage: 6.01140022277832 }],
  ['meteringEvent', { unit: 'credit', unitPlural: 'credits', usage: 0.13357169761194032 }],
];
const KIRO_228_STREAM = Buffer.concat(
  KIRO_228_FRAMES.map(([t, o]) => buildEventStreamFrame(t, Buffer.from(JSON.stringify(o)))),
);

function tsRecords(): CanonicalTokenRecord[] {
  return parseEventStreamFrames(KIRO_228_STREAM)
    .map((f) => frameToMitmLine(f))
    .filter((l) => l !== null)
    .map((l) => parseMitmLine(JSON.stringify(l)))
    .filter((r): r is CanonicalTokenRecord => r !== null);
}

function pyLines(): string[] {
  const out = execFileSync('python3', [writeAddonScript(), '--selftest', KIRO_228_STREAM.toString('hex')], {
    encoding: 'utf8',
  });
  return out.split('\n').filter((l) => l.startsWith('{'));
}

function assertKiro228(recs: CanonicalTokenRecord[]): void {
  assert.ok(recs.length >= 2, `expected context + metering records, got ${recs.length}`);
  for (const r of recs) {
    assert.equal(r.extra?.tokensAvailable, false, `record ${String(r.extra?.event)} must be flagged unavailable`);
  }
  const ctx = recs.find((r) => r.extra?.event === 'contextUsageEvent');
  assert.equal(ctx?.extra?.contextUsagePercentage, 6.01140022277832);
  const metering = recs.find((r) => r.extra?.event === 'meteringEvent');
  assert.equal(metering?.extra?.credits, 0.13357169761194032);
  // the stopReason-only metadataEvent carries nothing: no fake record
  assert.equal(recs.find((r) => r.extra?.event === 'metadataEvent'), undefined);
  assert.equal(recs.find((r) => r.extra?.event === 'initial'), undefined);
}

describe('kiro 2.28.0 turn without tokenUsage (#121)', () => {
  const hasPython = python3Available();

  it('TS path: contextUsageEvent captured, tokens flagged unavailable, credits kept', () => {
    assertKiro228(tsRecords());
  });

  it('python addon: same records as the TS path', { skip: hasPython ? false : 'python3 not available' }, () => {
    const py = pyLines().map((l) => parseMitmLine(l)).filter((r): r is CanonicalTokenRecord => r !== null);
    assertKiro228(py);
    const strip = (r: CanonicalTokenRecord) => ({
      event: r.extra?.event,
      ctx: r.extra?.contextUsagePercentage,
      credits: r.extra?.credits,
      avail: r.extra?.tokensAvailable,
    });
    assert.deepEqual(py.map(strip), tsRecords().map(strip));
  });

  it('run usage: tokens unavailable, credits and context available', () => {
    for (const recs of [tsRecords(), ...(hasPython ? [pyLines().map((l) => parseMitmLine(l)!)] : [])]) {
      // raw parser output AND the adapter carrier the driver actually sees
      for (const tokens of [recs, recs.map((r) => mitmRecordToUsageEvent(r).mitmRecord)]) {
        const { usage } = computeUsageAvailability({
          agent: 'kiro',
          tokens,
          totalCost: 0,
          pricerPriced: false,
        });
        assert.equal(usage.tokens.available, false);
        assert.equal(usage.credits.available, true);
        assert.equal(usage.credits.value, 0.13357169761194032);
        assert.equal(usage.context?.available, true);
        assert.equal(usage.context?.percentage, 6.01140022277832);
        assert.equal(usage.cost?.tokens, undefined);
      }
    }
  });

  it('control: frames that carry tokenUsage stay real and are not flagged', () => {
    const payload = Buffer.from(JSON.stringify({ tokenUsage: TOKEN_USAGE }));
    const [f] = parseEventStreamFrames(buildEventStreamFrame('metadataEvent', payload));
    const rec = parseMitmLine(JSON.stringify(frameToMitmLine(f)));
    assert.ok(rec);
    assert.equal(rec.inputTokens, 1200);
    assert.notEqual(rec.extra?.tokensAvailable, false);
    const { usage } = computeUsageAvailability({
      agent: 'kiro',
      tokens: [mitmRecordToUsageEvent(rec).mitmRecord],
      totalCost: 0,
      pricerPriced: false,
    });
    assert.equal(usage.tokens.available, true);
  });

  it('a lone contextUsageEvent or meteringEvent frame never yields a zero-token record', () => {
    for (const [t, o] of [KIRO_228_FRAMES[2], KIRO_228_FRAMES[3]]) {
      const [f] = parseEventStreamFrames(buildEventStreamFrame(t, Buffer.from(JSON.stringify(o))));
      const line = frameToMitmLine(f);
      assert.ok(line);
      assert.equal(line.tokenUsage, null);
      assert.equal(parseMitmLine(JSON.stringify(line))?.extra?.tokensAvailable, false);
    }
  });
});
