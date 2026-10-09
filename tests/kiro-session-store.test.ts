import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import {
  kiroSessionsDir,
  locateKiroSessionStore,
  locateKiroV3SessionDir,
  parseKiroV3Session,
  parseKiroSessionStore,
  readKiroSessionStore,
  sliceKiroSessionStore,
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

describe('sliceKiroSessionStore', () => {
  const turn = (credits: number | null, pct?: number, input = 0) => ({
    inputTokens: input,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    credits,
    ...(pct !== undefined ? { finalContextUsagePercentage: pct } : {}),
  });
  const store = {
    model: 'm',
    contextWindowTokens: 200000,
    turns: [turn(0.5, 10, 100), turn(0.25, 20, 5), turn(0.125, 30, 7)],
    creditsTotal: 0.875,
    lastContextUsagePercentage: 30,
  };

  it('keeps only turns after the prior count and recomputes credits and context', () => {
    const s = sliceKiroSessionStore(store, 1);
    assert.equal(s.turns.length, 2);
    assert.equal(s.creditsTotal, 0.375);
    assert.equal(s.lastContextUsagePercentage, 30);
    assert.equal(s.model, 'm');
    assert.equal(s.contextWindowTokens, 200000);
    assert.equal(sliceKiroSessionStore(store, 2).creditsTotal, 0.125);
  });

  it('yields null credits and no context when nothing is new', () => {
    const s = sliceKiroSessionStore(store, 3);
    assert.equal(s.turns.length, 0);
    assert.equal(s.creditsTotal, null);
    assert.equal(s.lastContextUsagePercentage, undefined);
  });

  it('returns the store unchanged for a fresh session or an impossible boundary', () => {
    assert.equal(sliceKiroSessionStore(store, 0), store);
    assert.equal(sliceKiroSessionStore(store, 4), store);
    assert.equal(sliceKiroSessionStore(store, -1), store);
  });
});

// ---------------------------------------------------------------------------
// v3 engine store: <root>/<16hex>/sess_<id>/{session.json,messages.jsonl}.
// Fixture is a trimmed copy of a real kiro-cli 2.28.0 run (prompt text and
// paths neutralized). Expected numbers are re-derived from the raw file here.
// ---------------------------------------------------------------------------
const V3_ID = 'sess_ec3122ff-e76d-414b-aa58-f46f05c0061a';
const V3_ROOT = join(FIXTURES, 'v3');
const V3_DIR = join(V3_ROOT, 'd09f675e45985feb', V3_ID);

function v3Records(file = join(V3_DIR, 'messages.jsonl')): Array<{ payload: Record<string, any> }> {
  return readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
}

/** Copy the v3 fixture under <tmp>/sessions/<bucket>/ and return {root, cli}. */
function plantV3(bucket = 'd09f675e45985feb', id = V3_ID): { root: string; cli: string } {
  const root = join(mkdtempSync(join(tmpdir(), 'kiro-v3-')), 'sessions');
  const cli = join(root, 'cli');
  mkdirSync(cli, { recursive: true });
  cpSync(V3_DIR, join(root, bucket, id), { recursive: true });
  return { root, cli };
}

describe('parseKiroV3Session / v3 store — real 2.28.0 fixture', () => {
  it('reads credits, latest context % and model from the real messages.jsonl', () => {
    const recs = v3Records();
    const usage = recs.filter((r) => r.payload.type === 'usage_summary');
    const pcts = recs
      .filter((r) => r.payload.type === 'session_metadata')
      .map((r) => r.payload.value.usagePercentage as number);
    assert.equal(usage.length, 1, 'fixture has one usage_summary');
    const expectedCredits = usage[0]!.payload.promptTurnSummaries.reduce(
      (a: number, e: { usage: number }) => a + e.usage,
      0,
    );
    const store = parseKiroV3Session(
      JSON.parse(readFileSync(join(V3_DIR, 'session.json'), 'utf8')),
      readFileSync(join(V3_DIR, 'messages.jsonl'), 'utf8'),
    );
    assert.ok(store);
    assert.equal(store.format, 'v3');
    assert.equal(store.hasTokenData, false);
    assert.equal(store.creditsTotal, expectedCredits);
    assert.equal(store.lastContextUsagePercentage, pcts[pcts.length - 1]);
    assert.equal(store.model, 'auto');
    assert.equal(store.contextWindowTokens, undefined);
    assert.equal(store.turns.length, 1);
  });

  it('does not double count: one turn per executionId, a repeated record replaces', () => {
    const rec = (exec: string, usage: number[]) =>
      JSON.stringify({
        id: `${exec}-usage`,
        payload: {
          type: 'usage_summary',
          executionId: exec,
          promptTurnSummaries: usage.map((u) => ({ unit: 'credit', usage: u })),
        },
      });
    const pct = (v: number) => JSON.stringify({ id: `p${v}`, payload: { type: 'session_metadata', key: 'contextUsage', value: { usagePercentage: v } } });
    const jsonl = [pct(1), rec('e1', [0.25]), rec('e1', [0.25]), pct(3), pct(4), rec('e2', [0.5, 0.125]), 'not json {'].join('\n');
    const store = parseKiroV3Session(undefined, jsonl);
    assert.ok(store);
    assert.equal(store.turns.length, 2);
    assert.deepEqual(store.turns.map((t) => t.credits), [0.25, 0.625]);
    assert.equal(store.creditsTotal, 0.875);
    assert.equal(store.lastContextUsagePercentage, 4);
    assert.equal(store.turns[1]?.contextUsagePercentage, 4);
    assert.equal(store.model, undefined);
  });

  it('yields null credits (not 0) when no usage_summary exists yet, and null for junk', () => {
    const only = JSON.stringify({ payload: { type: 'turn_start' } });
    const store = parseKiroV3Session({ id: 'sess_x' }, only);
    assert.ok(store);
    assert.equal(store.creditsTotal, null);
    assert.equal(store.turns.length, 0);
    assert.equal(parseKiroV3Session(undefined, ''), null);
    assert.equal(parseKiroV3Session(42, '{"nope":1}\n[1]\n'), null);
  });

  it('readKiroSessionStore finds sess_<id> by scanning <root>/*/ and honours KIRO_SESSIONS_DIR', async () => {
    const { root, cli } = plantV3();
    assert.equal(await locateKiroV3SessionDir(V3_ID, { dir: cli }), join(root, 'd09f675e45985feb', V3_ID));
    const read = await readKiroSessionStore(V3_ID, { dir: cli });
    assert.equal(read.ok, true);
    assert.equal(read.ok && read.store.format, 'v3');
    assert.equal(read.ok && read.path, join(root, 'd09f675e45985feb', V3_ID));

    const previous = process.env.KIRO_SESSIONS_DIR;
    process.env.KIRO_SESSIONS_DIR = cli;
    try {
      const viaEnv = await readKiroSessionStore(V3_ID);
      assert.equal(viaEnv.ok, true);
    } finally {
      if (previous === undefined) delete process.env.KIRO_SESSIONS_DIR;
      else process.env.KIRO_SESSIONS_DIR = previous;
    }
  });

  it('a missing v3 id, a non-sess_ id and traversal attempts fail without throwing', async () => {
    const { cli } = plantV3();
    const miss = await readKiroSessionStore('sess_00000000-0000-0000-0000-000000000000', { dir: cli });
    assert.equal(miss.ok, false);
    assert.match(miss.ok ? '' : miss.reason, /no kiro session store for session id sess_0/);
    assert.equal(await locateKiroV3SessionDir('sess_../x', { dir: cli }), null);
    assert.equal(await locateKiroV3SessionDir('sess_a/b', { dir: cli }), null);
    assert.equal(await locateKiroV3SessionDir('sess_a\\b', { dir: cli }), null);
    assert.equal(await locateKiroV3SessionDir('not-a-sess-id', { dir: cli }), null);
    assert.equal(await locateKiroV3SessionDir(undefined, { dir: cli }), null);
    assert.equal(await locateKiroV3SessionDir(V3_ID, { dir: join(tmpdir(), 'no-such-root-xyz', 'cli') }), null);
  });

  it('sliceKiroSessionStore degrades sanely for v3: scopes by turn and keeps the v3 markers', () => {
    const rec = (exec: string, u: number) =>
      JSON.stringify({ payload: { type: 'usage_summary', executionId: exec, promptTurnSummaries: [{ usage: u }] } });
    const pct = (v: number) => JSON.stringify({ payload: { type: 'session_metadata', key: 'contextUsage', value: { usagePercentage: v } } });
    const store = parseKiroV3Session(undefined, [pct(1), rec('a', 0.5), pct(2), rec('b', 0.25)].join('\n'));
    assert.ok(store);
    const sliced = sliceKiroSessionStore(store, 1);
    assert.equal(sliced.creditsTotal, 0.25);
    assert.equal(sliced.lastContextUsagePercentage, 2);
    assert.equal(sliced.hasTokenData, false);
    assert.equal(sliced.format, 'v3');
  });

  it('control: a v2 cli/<uuid>.json store is unchanged and tagged cli-v2', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kiro-sessions-'));
    writeFileSync(join(dir, 'abc.json'), readFileSync(HAIKU, 'utf8'));
    const read = await readKiroSessionStore('abc', { dir });
    assert.equal(read.ok && read.store.format, 'cli-v2');
    assert.equal(read.ok && read.store.hasTokenData, undefined);
  });
});
