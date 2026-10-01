// Prime Agent session transcripts as a native machine source (src/monitors/prime.ts).
// Fixtures (tests/fixtures/prime) are a real prime-agent 0.9.8 run, trimmed.
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { isPrimeSessionFile, parsePrimeSession } from "../src/monitors/prime.ts";
import { scanAll, scanOptionsForRoot, walkFiles, type CanonicalTokenRecord } from "../src/monitors/transcripts.ts";

const fixtures = new URL("./fixtures/prime", import.meta.url).pathname;
const ROOT = join(fixtures, "sessions", "01a0f5c1-58b0-7452-a3c9-dfe75f77b6e9.jsonl");
const PARENT = join(fixtures, "sessions", "01a0f5bd-e279-7384-a414-0852a851db8d.jsonl");
const CHILD = join(
  fixtures,
  "session-artifacts/01a0f5bd-e279-7384-a414-0852a851db8d/sub-61b507e2/01a0f5be-19f9-733d-a26a-c43f15332ca5.jsonl",
);
const EDGES = join(dirname(CHILD), "semantic-edges.jsonl");

const sum = (rs: CanonicalTokenRecord[]) => ({
  n: rs.length,
  input: rs.reduce((a, r) => a + r.input, 0),
  output: rs.reduce((a, r) => a + r.output, 0),
  cacheRead: rs.reduce((a, r) => a + r.cacheRead, 0),
  cacheWrite: rs.reduce((a, r) => a + r.cacheWrite, 0),
});
const total = (rs: CanonicalTokenRecord[]) => {
  const s = sum(rs);
  return s.input + s.output + s.cacheRead + s.cacheWrite;
};

test("root session: 2 assistant messages, exact totals, header-derived fields", async () => {
  const rs = await parsePrimeSession(ROOT);
  assert.deepEqual(sum(rs), { n: 2, input: 23952, output: 58, cacheRead: 0, cacheWrite: 0 });
  assert.equal(total(rs), 24010);
  for (const r of rs) {
    assert.equal(r.agent, "prime");
    assert.equal(r.sessionId, "01a0f5c1-58b0-7452-a3c9-dfe75f77b6e9");
    assert.equal(r.cwd, "/private/tmp/prime-probe");
    assert.equal(r.model, "flash");
    assert.match(r.timestamp ?? "", /^2026-10-01T/);
  }
});

test("parent counts only its own messages (child_usage_attributed ignored)", async () => {
  const rs = await parsePrimeSession(PARENT);
  assert.deepEqual(sum(rs), { n: 3, input: 36615, output: 310, cacheRead: 0, cacheWrite: 0 });
  assert.equal(total(rs), 36925);
});

test("child session is counted from its own file", async () => {
  const rs = await parsePrimeSession(CHILD);
  assert.deepEqual(sum(rs), { n: 7, input: 93710, output: 1360, cacheRead: 0, cacheWrite: 0 });
  assert.equal(total(rs), 95070);
  assert.equal(new Set(rs.map((r) => r.sessionId)).size, 1);
});

test("keep rule: sessions and sub-* children only, never semantic-edges / ledger / logs", () => {
  assert.equal(isPrimeSessionFile(ROOT), true);
  assert.equal(isPrimeSessionFile(CHILD), true);
  assert.equal(isPrimeSessionFile(EDGES), false);
  assert.equal(isPrimeSessionFile("/h/.prime/agent/rlm-ledger/01a0f5c1-58b0-7452-a3c9-dfe75f77b6e9.jsonl"), false);
  assert.equal(isPrimeSessionFile("/h/.prime/agent/logs/agent.jsonl"), false);
  assert.equal(isPrimeSessionFile("/h/.prime/agent/sessions/notes.jsonl"), false);
  assert.equal(isPrimeSessionFile("/h/.prime/agent/session-artifacts/p/other/01a0f5c1-58b0-7452-a3c9-dfe75f77b6e9.jsonl"), false);
});

test("scan of the fixture root: exactly 12 records, grand total 156005, edges never walked", async () => {
  const files = await walkFiles(fixtures, isPrimeSessionFile);
  assert.equal(files.length, 3);
  assert.ok(!files.includes(EDGES));
  const rs: CanonicalTokenRecord[] = [];
  for await (const r of scanAll({ claudeDir: "/nonexistent", codexDir: "/nonexistent", geminiDir: "/nonexistent", primeDir: fixtures, sourceRoots: {} })) {
    if (r.agent === "prime") rs.push(r);
  }
  assert.equal(rs.length, 12);
  assert.equal(total(rs), 24010 + 36925 + 95070);
  assert.equal(total(rs), 156005);
  assert.ok(rs.every((r) => r.source === "transcript" && r.sourcePath !== undefined));
});

test("home-shaped root (.prime/agent) is resolved by scanOptionsForRoot", async () => {
  const home = mkdtempSync(join(tmpdir(), "ach-prime-home-"));
  try {
    cpSync(fixtures, join(home, ".prime", "agent"), { recursive: true });
    const opts = scanOptionsForRoot(home);
    assert.equal(opts.primeDir, join(home, ".prime", "agent"));
    const rs: CanonicalTokenRecord[] = [];
    for await (const r of scanAll(opts)) if (r.agent === "prime") rs.push(r);
    assert.equal(total(rs), 156005);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("parser never throws: bad lines warn and are skipped, missing file warns", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ach-prime-bad-"));
  try {
    mkdirSync(join(dir, "sessions"));
    const f = join(dir, "sessions", "01a0f5c1-58b0-7452-a3c9-dfe75f77b6e9.jsonl");
    const good = JSON.stringify({ type: "message", timestamp: "2026-10-01T00:00:00Z", message: { role: "assistant", model: "m", usage: { input: 5, output: 2, cacheRead: 1, cacheWrite: 3 } } });
    writeFileSync(f, ["{not json", "[]", JSON.stringify({ type: "message", message: { role: "user" } }), good, ""].join("\n"));
    const warnings: string[] = [];
    const rs = await parsePrimeSession(f, (w) => warnings.push(w));
    assert.equal(rs.length, 1);
    assert.deepEqual(sum(rs), { n: 1, input: 5, output: 2, cacheRead: 1, cacheWrite: 3 });
    assert.equal(rs[0]!.sessionId, "01a0f5c1-58b0-7452-a3c9-dfe75f77b6e9");
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /line 1/);
    const missing: string[] = [];
    assert.deepEqual(await parsePrimeSession(join(dir, "nope.jsonl"), (w) => missing.push(w)), []);
    assert.equal(missing.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
