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
