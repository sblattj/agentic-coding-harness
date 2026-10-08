import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parsePlan, tokenizeLine } from "../src/core/queue-plan.ts";
import { exitCodeFor, runQueue, QUEUE_EXIT, type EngineDeps, type HookKind } from "../src/core/queue-engine.ts";
import { QueueStateSchema, type QueueState, type SliceState } from "../src/core/queue-state.ts";
import { runArgvFor } from "../src/cli/queue.ts";

describe("queue plan parsing", () => {
  it("tokenizes quotes, escapes and comments", () => {
    assert.deepEqual(tokenizeLine(`a 'b c' "d \\"e\\" f" g\\ h # trailing`), ["a", "b c", 'd "e" f', "g h"]);
    assert.deepEqual(tokenizeLine("   # only a comment"), []);
    assert.deepEqual(tokenizeLine("x#y"), ["x#y"]);
    assert.deepEqual(tokenizeLine(`'#' ""`), ["#", ""]);
    assert.throws(() => tokenizeLine(`a "oops`), /unterminated double/);
    assert.throws(() => tokenizeLine(`a 'oops`), /unterminated single/);
  });

  it("parses columns, passthrough flags, pre/post and '-' model", () => {
    const plan = [
      "# header",
      "",
      `s1 /w/one claude opus p1.txt --experiment E --variant V --repeat 3 --pre "make sandbox" --post='grade it'`,
      `s2 sub null - /abs/p2.txt --budget-usd 2`,
    ].join("\n");
    const [a, b] = parsePlan(plan, "/plans");
    assert.equal(a!.label, "s1");
    assert.equal(a!.cwd, "/w/one");
    assert.equal(a!.agent, "claude");
    assert.equal(a!.model, "opus");
    assert.equal(a!.promptFile, "/plans/p1.txt");
    assert.deepEqual(a!.runArgs, ["--experiment", "E", "--variant", "V", "--repeat", "3"]);
    assert.equal(a!.preCmd, "make sandbox");
    assert.equal(a!.postCmd, "grade it");
    assert.equal(a!.line, 3);
    assert.equal(b!.cwd, "/plans/sub");
    assert.equal(b!.model, undefined);
    assert.equal(b!.promptFile, "/abs/p2.txt");
    assert.deepEqual(b!.runArgs, ["--budget-usd", "2"]);
    assert.equal(b!.preCmd, undefined);
  });

  it("rejects bad plans with the line number", () => {
    assert.throws(() => parsePlan("a b c", "/"), /plan line 1: expected/);
    assert.throws(() => parsePlan("a /w x - p\na /w x - p", "/"), /line 2: duplicate label/);
    assert.throws(() => parsePlan("bad/label /w x - p", "/"), /label/);
    assert.throws(() => parsePlan("a /w x - p --pre", "/"), /--pre needs a command/);
    assert.throws(() => parsePlan("a /w x - p --model m", "/"), /plan column/);
    assert.throws(() => parsePlan("# nothing\n", "/"), /no slices/);
  });

  it("builds the ach run argv with the prompt last", () => {
    assert.deepEqual(runArgvFor({ agent: "claude", model: "opus", runArgs: ["--repeat", "2"] }, "hi"), ["run", "--agent", "claude", "--model", "opus", "--repeat", "2", "hi"]);
    assert.deepEqual(runArgvFor({ agent: "null", runArgs: [] }, "hi"), ["run", "--agent", "null", "hi"]);
  });
});

// ---- scheduler, against a virtual world -------------------------------------

interface World {
  deps: EngineDeps;
  clock: { t: number };
  launched: string[];
  hooks: string[];
  maxLive: () => number;
  external: Set<number>;
  saves: QueueState[];
}

function mkState(labels: Array<Partial<SliceState> & { label: string }>, over: Partial<QueueState> = {}): QueueState {
  return {
    v: 1,
    id: "q-test",
    planPath: "/plan",
    stateDir: "/state",
    countDirs: [],
    startedAt: 0,
    updatedAt: 0,
    maxConcurrent: 2,
    maxHours: 1,
    deadlineAt: 3_600_000,
    queuePid: 1,
    phase: "running",
    log: "/state/queues/q-test.log",
    slices: labels.map((l) => ({
      cwd: "/w",
      agent: "null",
      promptFile: "/p",
      runArgs: [],
      status: "queued" as const,
      runIds: [],
      log: `/state/queues/q-test/${l.label}.log`,
      ...l,
    })),
    ...over,
  };
}

function world(opts: { runMs?: number; hookExit?: (kind: HookKind, label: string) => number; external?: Set<number>; runExit?: (label: string) => number } = {}): World {
  const clock = { t: 0 };
  const runMs = opts.runMs ?? 10_000;
  const external = opts.external ?? new Set<number>();
  let nextPid = 1000;
  const procs = new Map<number, { end: number; label: string; cb?: (c: number | null) => void; fired: boolean }>();
  const launched: string[] = [];
  const hooks: string[] = [];
  const saves: QueueState[] = [];
  let maxLive = 0;
  const alive = (pid: number) => (procs.get(pid)?.end ?? 0) > clock.t;
  const deps: EngineDeps = {
    now: () => clock.t,
    async sleep(ms) {
      clock.t += ms;
      for (const [pid, p] of procs) {
        if (!p.fired && p.end <= clock.t) {
          p.fired = true;
          p.cb?.(opts.runExit?.(p.label) ?? 0);
        }
        void pid;
      }
    },
    liveRunPids: () => new Set(external),
    runInfoForPid: () => ({ runIds: [], statuses: [] }),
    isPidAlive: alive,
    launch(s) {
      const pid = nextPid++;
      launched.push(s.label);
      const p = { end: clock.t + runMs, label: s.label, cb: undefined as ((c: number | null) => void) | undefined, fired: false };
      procs.set(pid, p);
      const live = [...procs.keys()].filter(alive).length + external.size;
      maxLive = Math.max(maxLive, live);
      return { pid, onExit: (cb) => { p.cb = cb; } };
    },
    async runHook(kind, s) {
      hooks.push(`${kind}:${s.label}@${clock.t}`);
      return opts.hookExit?.(kind, s.label) ?? 0;
    },
    save: (q) => saves.push(structuredClone(q)),
    log: () => {},
  };
  return { deps, clock, launched, hooks, maxLive: () => maxLive, external, saves };
}

describe("queue scheduler", () => {
  it("never exceeds the cap and drains everything", async () => {
    const w = world();
    const st = mkState([{ label: "a" }, { label: "b" }, { label: "c" }, { label: "d" }, { label: "e" }], { maxConcurrent: 2 });
    const out = await runQueue(st, w.deps, { pollMs: 1000 });
    assert.equal(out.phase, "drained");
    assert.deepEqual(w.launched, ["a", "b", "c", "d", "e"]);
    assert.ok(w.maxLive() <= 2, `max live ${w.maxLive()}`);
    assert.deepEqual(out.slices.map((s) => s.status), Array(5).fill("done"));
    assert.equal(exitCodeFor(out), QUEUE_EXIT.drained);
    for (const s of w.saves) QueueStateSchema.parse(s);
  });

  it("counts externally-live runs (other sessions) against the cap", async () => {
    const w = world({ external: new Set([1, 2]) });
    const st = mkState([{ label: "a" }], { maxConcurrent: 2 });
    // Cap is full of someone else's runs: nothing launches until they exit.
    let ticks = 0;
    const origSleep = w.deps.sleep;
    w.deps.sleep = async (ms) => {
      await origSleep(ms);
      if (++ticks === 3) assert.deepEqual(w.launched, []);
      if (ticks === 4) w.external.delete(1);
    };
    await runQueue(st, w.deps, { pollMs: 1000 });
    assert.deepEqual(w.launched, ["a"]);
    assert.ok(ticks >= 4);
  });

  it("counts its own just-launched child even before the registry shows it", async () => {
    const w = world({ runMs: 5_000 });
    const st = mkState([{ label: "a" }, { label: "b" }], { maxConcurrent: 1 });
    await runQueue(st, w.deps, { pollMs: 1000 });
    assert.equal(w.maxLive(), 1);
    assert.deepEqual(w.launched, ["a", "b"]);
  });

  it("marks a pre failure failed up front and never launches it", async () => {
    const w = world({ hookExit: (k, l) => (k === "pre" && l === "bad" ? 3 : 0) });
    const st = mkState([{ label: "ok", preCmd: "true" }, { label: "bad", preCmd: "false", postCmd: "grade" }]);
    const out = await runQueue(st, w.deps, { pollMs: 1000 });
    assert.deepEqual(w.launched, ["ok"]);
    const bad = out.slices.find((s) => s.label === "bad")!;
    assert.equal(bad.status, "pre-failed");
    assert.equal(bad.preExit, 3);
    assert.equal(bad.postStartedAt, undefined, "post must not run for a slice that never launched");
    // all pre hooks ran before the first launch
    assert.deepEqual(w.hooks.slice(0, 2), ["pre:ok@0", "pre:bad@0"]);
    assert.equal(exitCodeFor(out), QUEUE_EXIT.failed);
  });

  it("starts post after the slice finishes, then drains", async () => {
    const w = world({ runMs: 4_000 });
    const st = mkState([{ label: "a", postCmd: "grade" }]);
    const out = await runQueue(st, w.deps, { pollMs: 1000 });
    const post = w.hooks.find((h) => h.startsWith("post:a"))!;
    const at = Number(post.split("@")[1]);
    assert.ok(at >= 4_000, `post started at ${at}, before the run finished`);
    assert.equal(out.slices[0]!.postExit, 0);
    assert.equal(out.slices[0]!.status, "done");
  });

  it("a non-zero run exit fails the slice; a failed post fails the queue", async () => {
    const w = world({ runExit: (l) => (l === "x" ? 1 : 0), hookExit: (k) => (k === "post" ? 2 : 0) });
    const st = mkState([{ label: "x" }, { label: "y", postCmd: "p" }]);
    const out = await runQueue(st, w.deps, { pollMs: 1000 });
    assert.equal(out.slices[0]!.status, "failed");
    assert.equal(out.slices[1]!.status, "done");
    assert.equal(out.slices[1]!.postExit, 2);
    assert.equal(exitCodeFor(out), QUEUE_EXIT.failed);
  });

  it("a launch error fails that slice and the queue keeps going", async () => {
    const w = world();
    const real = w.deps.launch;
    w.deps.launch = (s) => {
      if (s.label === "boom") throw new Error("ENOENT");
      return real(s);
    };
    const out = await runQueue(mkState([{ label: "boom" }, { label: "fine" }]), w.deps, { pollMs: 1000 });
    assert.equal(out.slices[0]!.status, "failed");
    assert.match(out.slices[0]!.error!, /ENOENT/);
    assert.equal(out.slices[1]!.status, "done");
  });

  it("stops launching at --max-hours, leaves running slices running, exits 40", async () => {
    const w = world({ runMs: 100_000 });
    const st = mkState([{ label: "a" }, { label: "b" }, { label: "c" }], { maxConcurrent: 1, deadlineAt: 150_000 });
    const out = await runQueue(st, w.deps, { pollMs: 10_000 });
    assert.equal(out.phase, "expired");
    assert.deepEqual(w.launched, ["a", "b"]);
    assert.deepEqual(out.slices.map((s) => s.status), ["done", "running", "queued"]);
    assert.equal(exitCodeFor(out), QUEUE_EXIT.expired);
  });

  it("derives the verdict from run records when the exit event was not seen (resume)", async () => {
    const w = world();
    const st = mkState([{ label: "r", status: "running", pid: 4242, launchedAt: 0 }]);
    w.deps.isPidAlive = () => false;
    w.deps.runInfoForPid = () => ({ runIds: ["r1"], statuses: ["success"] });
    const out = await runQueue(st, w.deps, { pollMs: 1000 });
    assert.equal(out.slices[0]!.status, "done");
    assert.deepEqual(out.slices[0]!.runIds, ["r1"]);
    const st2 = mkState([{ label: "r", status: "running", pid: 4242, launchedAt: 0 }]);
    w.deps.runInfoForPid = () => ({ runIds: [], statuses: [] });
    const out2 = await runQueue(st2, w.deps, { pollMs: 1000 });
    assert.equal(out2.slices[0]!.status, "failed");
  });
});
