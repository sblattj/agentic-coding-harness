import "./support/no-network.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startFeed, renderEvent, CALL_ENDED_MESSAGE, WAITING_NOTE, FULL_CONTEXT_PREFIX } from "../src/desks/feeds.ts";
import type { FeedSpec } from "../src/desks/types.ts";

const FAKE = fileURLToPath(new URL("./fixtures/desks/fake-feed.mjs", import.meta.url));
const node = process.execPath;

type Step = Record<string, unknown>;
const ev = (type: string, extra: Record<string, unknown> = {}) => ({ line: { type, ...extra } });
const alive = ev("alive");

function feedCmd(steps: Step[], pidFile?: string): string[] {
  return [node, FAKE, JSON.stringify(steps), ...(pidFile ? [pidFile] : [])];
}
const activeCmd = (active: boolean) => [node, "-e", `console.log(JSON.stringify({active:${active}}))`];
const fullCmd = [node, "-e", "process.stdout.write('line1\\nline2\\n')"];

async function waitFor(cond: () => boolean, what: string, ms = 8000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`timeout waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function alivePid(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function harness(spec: FeedSpec, extra: Partial<Parameters<typeof startFeed>[2]> = {}) {
  const msgs: string[] = [];
  const notes: string[] = [];
  const errors: string[] = [];
  const handle = startFeed(spec, async (t) => { msgs.push(t); }, {
    onNote: (n) => notes.push(n), onError: (e) => errors.push(e), ...extra,
  });
  return { msgs, notes, errors, handle };
}

test("backlog is suppressed and full context is sent once, as one message", async () => {
  const h = harness({
    command: feedCmd([ev("utterance", { text: "old1" }), ev("utterance", { text: "old2" }), alive, { delay: 50 }, alive, alive]),
    activeCheck: activeCmd(true), fullContext: fullCmd, batchSeconds: 0.2,
  });
  try {
    await waitFor(() => h.msgs.length >= 1, "full context");
    await sleep(400);
    assert.deepEqual(h.msgs, [`${FULL_CONTEXT_PREFIX}line1\nline2\n`]);
    assert.equal(h.errors.length, 0);
    assert.ok(h.handle.pid > 0);
  } finally { await h.handle.stop(); }
});

test("inactive session: one waiting note, no full context", async () => {
  const h = harness({
    command: feedCmd([ev("utterance", { text: "old" }), alive, { delay: 30 }, alive, alive]),
    activeCheck: activeCmd(false), fullContext: fullCmd,
  });
  try {
    await waitFor(() => h.msgs.length >= 1, "waiting note");
    await sleep(300);
    assert.deepEqual(h.msgs, [WAITING_NOTE]);
  } finally { await h.handle.stop(); }
});

test("without activeCheck: active only when the backlog was non-empty", async () => {
  const a = harness({ command: feedCmd([ev("utterance", { text: "x" }), alive]), fullContext: fullCmd });
  const b = harness({ command: feedCmd([alive]), fullContext: fullCmd });
  try {
    await waitFor(() => a.msgs.length >= 1 && b.msgs.length >= 1, "both");
    assert.ok(a.msgs[0]!.startsWith(FULL_CONTEXT_PREFIX));
    assert.deepEqual(b.msgs, [WAITING_NOTE]);
  } finally { await a.handle.stop(); await b.handle.stop(); }
});

test("batching window: events collapse into one message, heartbeats never delivered", async () => {
  const h = harness({
    command: feedCmd([
      ev("utterance", { text: "bk" }), alive, { delay: 100 },
      ev("utterance", { speaker: "Ann", t: "10:01", text: "hello" }), alive,
      { delay: 30 }, ev("note", { n: 1 }), { delay: 600 }, ev("utterance", { text: "later" }),
    ]),
    activeCheck: activeCmd(true), batchSeconds: 0.25,
  });
  try {
    await waitFor(() => h.msgs.length >= 2, "two batches");
    assert.equal(h.msgs[0], "New events (2):\n- utterance: [10:01] Ann: hello\n- {\"type\":\"note\",\"n\":1}");
    assert.equal(h.msgs[1], "New events (1):\n- utterance: later");
    assert.ok(!h.msgs.some((m) => m.includes("alive")));
  } finally { await h.handle.stop(); }
});

test("immediate event flushes the pending batch first, in order", async () => {
  const h = harness({
    command: feedCmd([alive, { delay: 80 }, ev("utterance", { text: "a" }), ev("utterance", { text: "b" }), ev("for_me", { text: "you?" }), ev("utterance", { text: "c" })]),
    activeCheck: activeCmd(true), immediate: ["for_me"], batchSeconds: 0.3,
  });
  try {
    await waitFor(() => h.msgs.length >= 3, "3 msgs");
    assert.equal(h.msgs[0], "New events (2):\n- utterance: a\n- utterance: b");
    assert.equal(h.msgs[1], "for_me: you?");
    assert.equal(h.msgs[2], "New events (1):\n- utterance: c");
  } finally { await h.handle.stop(); }
});

test("call_ended flushes, sends the closing message, and a new call gets full context again", async () => {
  const h = harness({
    command: feedCmd([
      alive, { delay: 80 }, ev("utterance", { text: "a" }), ev("call_ended"),
      { delay: 80 }, ev("call_started"), alive, { delay: 50 }, ev("utterance", { text: "second call" }),
    ]),
    activeCheck: activeCmd(true), fullContext: fullCmd, batchSeconds: 0.3,
  });
  try {
    await waitFor(() => h.msgs.length >= 5, "5 msgs");
    assert.equal(h.msgs[0], `${FULL_CONTEXT_PREFIX}line1\nline2\n`);
    assert.equal(h.msgs[1], "New events (1):\n- utterance: a");
    assert.equal(h.msgs[2], CALL_ENDED_MESSAGE);
    assert.equal(h.msgs[3], `${FULL_CONTEXT_PREFIX}line1\nline2\n`);
  } finally { await h.handle.stop(); }
});

test("onActive reports true when a call starts, false when it ends or waits", async () => {
  const states: boolean[] = [];
  const h = harness({
    command: feedCmd([alive, { delay: 80 }, ev("utterance", { text: "a" }), ev("call_ended")]),
    activeCheck: activeCmd(true), batchSeconds: 0.2,
  }, { onActive: (a: boolean) => states.push(a) });
  try {
    await waitFor(() => states.length >= 2, "2 active states");
    assert.deepEqual(states.slice(0, 2), [true, false]);
  } finally { await h.handle.stop(); }
  const w: boolean[] = [];
  const h2 = harness({ command: feedCmd([alive, { delay: 200 }]), activeCheck: activeCmd(false) }, { onActive: (a: boolean) => w.push(a) });
  try {
    await waitFor(() => w.length >= 1, "waiting state");
    assert.deepEqual(w, [false]);
  } finally { await h2.handle.stop(); }
});

test("malformed lines go to onError and the feed keeps going", async () => {
  const h = harness({
    command: feedCmd([alive, { delay: 50 }, { raw: "not json" }, { raw: '{"no":"type"}' }, ev("for_me", { text: "ok" })]),
    activeCheck: activeCmd(true), immediate: ["for_me"],
  });
  try {
    await waitFor(() => h.msgs.length >= 1, "msg");
    assert.equal(h.msgs[0], "for_me: ok");
    assert.equal(h.errors.length, 2);
    assert.match(h.errors[0]!, /malformed/);
  } finally { await h.handle.stop(); }
});

test("deliver rejection goes to onError and delivery continues in order", async () => {
  const got: string[] = [];
  const errors: string[] = [];
  let first = true;
  const handle = startFeed({
    command: feedCmd([alive, { delay: 50 }, ev("for_me", { text: "1" }), ev("for_me", { text: "2" })]),
    activeCheck: activeCmd(true), immediate: ["for_me"],
  }, async (t) => { await sleep(20); if (first) { first = false; throw new Error("boom"); } got.push(t); }, { onError: (e) => errors.push(e) });
  try {
    await waitFor(() => got.length >= 1, "second delivery");
    assert.deepEqual(got, ["for_me: 2"]);
    assert.match(errors[0]!, /boom/);
  } finally { await handle.stop(); }
});

test("child crash: exit note, restart, backlog/full-context rule applies again", async () => {
  const dir = mkdtempSync(join(tmpdir(), "feeds-"));
  const pidFile = join(dir, "pids");
  const h = harness({
    command: feedCmd([ev("utterance", { text: "bk" }), alive, { delay: 100 }, { stderr: "oops" }, { exit: 3 }], pidFile),
    activeCheck: activeCmd(true), fullContext: fullCmd,
  }, { restartBaseMs: 100 });
  try {
    await waitFor(() => h.msgs.length >= 2, "two full contexts");
    assert.ok(h.notes.includes("feed exited code=3"), h.notes.join("|"));
    assert.ok(h.notes.includes("feed stderr: oops"));
    assert.equal(h.msgs[0], h.msgs[1]);
    assert.ok(h.msgs[0]!.startsWith(FULL_CONTEXT_PREFIX));
    const pids = readFileSync(pidFile, "utf8").trim().split("\n");
    assert.ok(pids.length >= 2 && pids[0] !== pids[1]);
  } finally { await h.handle.stop(); }
});

test("stderr notes are rate-limited", async () => {
  const h = harness({
    command: feedCmd([{ stderr: "a" }, { stderr: "b" }, { stderr: "c" }, { delay: 200 }]),
  }, { stderrGapMs: 60000 });
  try {
    await sleep(500);
    assert.deepEqual(h.notes.filter((n) => n.startsWith("feed stderr:")), ["feed stderr: a"]);
  } finally { await h.handle.stop(); }
});

test("stop() kills the child, cancels restarts, delivers nothing more", async () => {
  const dir = mkdtempSync(join(tmpdir(), "feeds-"));
  const pidFile = join(dir, "pids");
  const h = harness({ command: feedCmd([alive], pidFile), activeCheck: activeCmd(true) }, { restartBaseMs: 50 });
  await waitFor(() => existsSync(pidFile) && readFileSync(pidFile, "utf8").trim() !== "", "pid file");
  const pid = h.handle.pid;
  assert.equal(pid, Number(readFileSync(pidFile, "utf8").trim().split("\n")[0]));
  assert.ok(alivePid(pid));
  await h.handle.stop();
  assert.equal(alivePid(pid), false);
  await sleep(300);
  assert.equal(readFileSync(pidFile, "utf8").trim().split("\n").length, 1, "no restart after stop");
  assert.ok(!h.notes.some((n) => n.startsWith("feed exited")), "stop is not reported as an exit");
});

test("stop() escalates to KILL when the child ignores TERM", async () => {
  const script = "process.on('SIGTERM',()=>{});console.log(JSON.stringify({type:'alive'}));setInterval(()=>{},1e6)";
  const h = harness({ command: [node, "-e", script] }, { killAfterMs: 200 });
  await waitFor(() => h.handle.pid > 0, "pid");
  const pid = h.handle.pid;
  await sleep(150);
  await h.handle.stop();
  assert.equal(alivePid(pid), false);
});

test("spawn failure is reported and retried without throwing", async () => {
  const h = harness({ command: ["/nonexistent/binary-xyz"] }, { restartBaseMs: 50 });
  try {
    await waitFor(() => h.errors.length >= 2, "two spawn errors");
    assert.match(h.errors[0]!, /spawn failed/);
  } finally { await h.handle.stop(); }
});

test("renderEvent: text/speaker/t when present, else compact JSON", () => {
  assert.equal(renderEvent({ type: "utterance", speaker: "Bo", t: "9:00", text: "hi" }), "utterance: [9:00] Bo: hi");
  assert.equal(renderEvent({ type: "utterance", text: "hi" }), "utterance: hi");
  assert.equal(renderEvent({ type: "ci", status: "red" }), '{"type":"ci","status":"red"}');
});

const hangCmd = (pidFile?: string) => [
  node, "-e",
  `${pidFile ? `require('fs').appendFileSync(${JSON.stringify(pidFile)}, process.pid+'\\n');` : ""}setInterval(()=>{},1e6)`,
];

test("a hung activeCheck is killed at the helper timeout and later events still flow", async () => {
  const h = harness({
    command: feedCmd([alive, { delay: 100 }, alive, { delay: 100 }, ev("utterance", { text: "x" })]),
    activeCheck: hangCmd(), batchSeconds: 0.05,
  }, { helperTimeoutMs: 300 });
  try {
    await waitFor(() => h.errors.some((e) => /active-check failed/.test(e)), "active-check timeout error", 4000);
  } finally { await h.handle.stop(); }
});

test("stop() kills an in-flight helper command", async () => {
  const dir = mkdtempSync(join(tmpdir(), "feeds-"));
  const pidFile = join(dir, "helper-pids");
  const h = harness({ command: feedCmd([alive]), activeCheck: hangCmd(pidFile) }, { helperTimeoutMs: 60000 });
  await waitFor(() => existsSync(pidFile) && readFileSync(pidFile, "utf8").trim() !== "", "helper pid");
  const helper = Number(readFileSync(pidFile, "utf8").trim().split("\n")[0]);
  assert.ok(alivePid(helper));
  await h.handle.stop();
  await waitFor(() => !alivePid(helper), "helper dead after stop", 2000).catch(() => { try { process.kill(helper, "SIGKILL"); } catch { /* gone */ } throw new Error("helper survived stop()"); });
});

test("the pending event queue is bounded: oldest dropped with a note while a helper is stuck", async () => {
  const lines = Array.from({ length: 60 }, (_, i) => ev("utterance", { text: `e${i}` }));
  const h = harness({ command: feedCmd([alive, ...lines]), activeCheck: hangCmd() }, { helperTimeoutMs: 60000, maxPendingEvents: 10 });
  try {
    await waitFor(() => h.notes.some((n) => /dropped \d+ oldest/.test(n)), "drop note", 4000);
  } finally { await h.handle.stop(); }
});

test("stop() kills grandchildren of a shell-wrapped feed (process group)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "feeds-"));
  const pidFile = join(dir, "gc-pid");
  const h = harness({ command: ["/bin/sh", "-c", `sleep 300 & echo $! > ${pidFile}; echo '{"type":"alive"}'; wait`] }, { killAfterMs: 300 });
  await waitFor(() => existsSync(pidFile) && readFileSync(pidFile, "utf8").trim() !== "", "grandchild pid");
  const gc = Number(readFileSync(pidFile, "utf8").trim());
  assert.ok(alivePid(gc));
  await h.handle.stop();
  const dead = await waitFor(() => !alivePid(gc), "grandchild dead", 2000).then(() => true, () => false);
  if (!dead) { try { process.kill(gc, "SIGKILL"); } catch { /* gone */ } }
  assert.ok(dead, "grandchild survived stop()");
});

// prxref #208: a feed that writes without newlines must not grow the host's buffer without bound.
const writerCmd = (script: string) => [node, "-e", `${script}; setInterval(() => {}, 1 << 30);`];

test("unterminated stdout over maxLineChars is dropped at once, then the feed resyncs at the next newline", async () => {
  const h = harness({
    command: writerCmd(`process.stdout.write("a".repeat(300)); setTimeout(() => process.stdout.write("more-garbage\\n" + JSON.stringify({ type: "alive" }) + "\\n"), 2000)`),
  }, { maxLineChars: 100 });
  try {
    // Old code buffered forever here: no error until a newline, so this wait failed.
    await waitFor(() => h.errors.some((e) => e.includes("over 100 chars")), "over-cap error while the line is unterminated", 1500);
    assert.deepEqual(h.msgs, [], "nothing parsed before the newline");
    await waitFor(() => h.msgs.length >= 1, "event after resync", 5000);
    assert.deepEqual(h.msgs, [WAITING_NOTE]);
    assert.equal(h.errors.filter((e) => e.includes("over 100 chars")).length, 1, "one error per oversized line");
    assert.equal(h.errors.filter((e) => e.includes("malformed")).length, 0, "the dropped tail is never parsed");
  } finally { await h.handle.stop(); }
});

test("over-cap line followed by its newline in the same chunk: one error, next line still parsed", async () => {
  const h = harness({
    command: writerCmd(`process.stdout.write("b".repeat(300) + "\\n" + JSON.stringify({ type: "alive" }) + "\\n")`),
  }, { maxLineChars: 100 });
  try {
    await waitFor(() => h.msgs.length >= 1, "event after oversized line");
    assert.deepEqual(h.msgs, [WAITING_NOTE]);
    assert.equal(h.errors.length, 1, h.errors.join("\n"));
    assert.ok(h.errors[0]!.includes("over 100 chars"), h.errors[0]);
  } finally { await h.handle.stop(); }
});

test("unterminated stderr over maxLineChars is dropped with a note instead of buffering", async () => {
  const h = harness({ command: writerCmd(`process.stderr.write("c".repeat(300))`) }, { maxLineChars: 100, stderrGapMs: 0 });
  try {
    await waitFor(() => h.notes.some((n) => n.includes("feed stderr line over 100 chars")), "stderr over-cap note", 1500);
  } finally { await h.handle.stop(); }
});
