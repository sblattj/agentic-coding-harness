import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import {
  kiroSessionsDir,
  locateKiroSessionStore,
  parseKiroSessionStore,
  readKiroSessionStore,
} from '../src/adapters/kiro-session-store.ts';

// Real (sanitized) kiro session stores, one per probe run on kiro-cli 2.21.2.
// Every expected number below is COMPUTED from the fixture, never typed by
// hand — the point of the suite is that the parser reports what the file says.
const FIXTURES = join(dirname(new URL(import.meta.url).pathname), 'fixtures', 'kiro');
const AUTO = join(FIXTURES, 'session-store-auto.json');
const HAIKU = join(FIXTURES, 'session-store-haiku.json');

function load(file: string): Record<string, unknown> {
  return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
}

/** Independent re-derivation straight off the raw JSON (not via the parser). */
function rawTurns(json: Record<string, unknown>): Array<Record<string, unknown>> {
  const state = json.session_state as Record<string, unknown>;
  const meta = state.conversation_metadata as Record<string, unknown>;
  return meta.user_turn_metadatas as Array<Record<string, unknown>>;
}

describe('parseKiroSessionStore — real 2.21.2 fixtures', () => {
  it('reads per-turn counters, model, window and credits from the auto-model run', () => {
    const json = load(AUTO);
    const store = parseKiroSessionStore(json);
    assert.ok(store, 'fixture parses');

    const raw = rawTurns(json);
    assert.equal(store.turns.length, raw.length);
    assert.equal(store.model, (((json.session_state as Record<string, unknown>).rts_model_state as Record<string, unknown>).model_info as Record<string, unknown>).model_id);
    assert.equal(store.contextWindowTokens, (((json.session_state as Record<string, unknown>).rts_model_state as Record<string, unknown>).model_info as Record<string, unknown>).context_window_tokens);

    const expectedCredits = raw.reduce(
      (sum, t) => sum + (t.metering_usage as Array<{ value: number }>).reduce((a, m) => a + m.value, 0),
      0,
    );
    assert.equal(store.creditsTotal, expectedCredits);
    assert.equal(store.turns[0]?.credits, expectedCredits);
    assert.equal(store.lastContextUsagePercentage, raw[raw.length - 1]?.final_context_usage_percentage);
  });

  it('sums a MULTI-entry metering_usage array for one turn (haiku run)', () => {
    const json = load(HAIKU);
    const store = parseKiroSessionStore(json);
    assert.ok(store);
    const metering = rawTurns(json)[0]?.metering_usage as Array<{ value: number }>;
    assert.ok(metering.length > 1, 'fixture really has several model calls in the turn');
    assert.equal(store.creditsTotal, metering.reduce((a, m) => a + m.value, 0));
    assert.equal(store.model, 'claude-haiku-4.5');
  });

  it('reports ZERO token counters for every turn of both fixtures — the measured 2.21.x truth', () => {
    for (const file of [AUTO, HAIKU]) {
      const store = parseKiroSessionStore(load(file));
      assert.ok(store);
      for (const t of store.turns) {
        assert.equal(t.inputTokens + t.outputTokens + t.cacheReadTokens + t.cacheWriteTokens, 0, file);
      }
    }
  });

  it('never throws on malformed input and returns null for a non-store document', () => {
    for (const bad of [null, undefined, 42, 'nope', [], {}, { session_state: 7 }]) {
      assert.equal(parseKiroSessionStore(bad), null, JSON.stringify(bad ?? null));
    }
  });

  it('tolerates a store whose turns are junk: no turns, null credits, no invented zeros', () => {
    const store = parseKiroSessionStore({
      session_state: { conversation_metadata: { user_turn_metadatas: [null, 5, { model: 7 }] } },
    });
    assert.ok(store);
    assert.equal(store.turns.length, 1); // only the object survives
    assert.equal(store.turns[0]?.credits, null); // absent metering !== 0 credits
    assert.equal(store.creditsTotal, null);
    assert.equal(store.model, undefined); // a non-string model is not a model
    assert.equal(store.contextWindowTokens, undefined);
    assert.equal(store.lastContextUsagePercentage, undefined);
  });

  it('falls back to conversation_metadata.last_context_usage when turns carry no percentage', () => {
    const store = parseKiroSessionStore({
      session_state: {
        conversation_metadata: { user_turn_metadatas: [{}], last_context_usage: { percentage: 3.5 } },
      },
    });
    assert.equal(store?.lastContextUsagePercentage, 3.5);
  });
});

describe('locateKiroSessionStore / readKiroSessionStore', () => {
  it('resolves <dir>/<id>.json and honours KIRO_SESSIONS_DIR', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kiro-sessions-'));
    writeFileSync(join(dir, 'abc.json'), readFileSync(HAIKU, 'utf8'));

    assert.equal(await locateKiroSessionStore('abc', { dir }), join(dir, 'abc.json'));

    const previous = process.env.KIRO_SESSIONS_DIR;
    process.env.KIRO_SESSIONS_DIR = dir;
    try {
      assert.equal(kiroSessionsDir(), dir);
      const read = await readKiroSessionStore('abc');
      assert.equal(read.ok, true);
      assert.equal(read.ok && read.store.model, 'claude-haiku-4.5');
    } finally {
      if (previous === undefined) delete process.env.KIRO_SESSIONS_DIR;
      else process.env.KIRO_SESSIONS_DIR = previous;
    }
  });

  it('returns null (never throws) for a missing id, an empty id and a traversal attempt', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kiro-sessions-'));
    assert.equal(await locateKiroSessionStore('nope', { dir }), null);
    assert.equal(await locateKiroSessionStore('', { dir }), null);
    assert.equal(await locateKiroSessionStore(undefined, { dir }), null);
    assert.equal(await locateKiroSessionStore('../../etc/passwd', { dir }), null);
  });

  it('reports a reason instead of throwing for bad JSON and for a non-store file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kiro-sessions-'));
    writeFileSync(join(dir, 'broken.json'), '{ not json');
    writeFileSync(join(dir, 'other.json'), '{"hello":"world"}');

    const broken = await readKiroSessionStore('broken', { dir });
    assert.equal(broken.ok, false);
    assert.match(broken.ok === false ? broken.reason : '', /not valid JSON/);

    const other = await readKiroSessionStore('other', { dir });
    assert.equal(other.ok, false);
    assert.match(other.ok === false ? other.reason : '', /no session_state/);

    const missing = await readKiroSessionStore('gone', { dir });
    assert.equal(missing.ok, false);
    assert.match(missing.ok === false ? missing.reason : '', /no kiro session store/);
  });
});
