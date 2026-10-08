import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { frame, queueLines } from "../src/cli/dash.ts";
import { visibleQueues, toQueueView, QUEUE_RECENT_HOURS } from "../src/core/queue-view.ts";
import { writeQueueState, type QueueState, type SliceState } from "../src/core/queue-state.ts";
import { escapeHtml, renderQueuesPage } from "../src/web/queues.ts";

// Dash + web views of the run-queue state files (#115 part A).

const CLI = new URL("../src/cli/ach.ts", import.meta.url).pathname;
const RUNNER = new URL("./helpers/web-server-runner.ts", import.meta.url).pathname;
const isBun = spawnSync("bun", ["--version"], { encoding: "utf8" }).status === 0;
const NOW = 1_800_000_000_000;
const H = 3_600_000;

function slice(label: string, status: SliceState["status"], over: Partial<SliceState> = {}): SliceState {
  return { label, cwd: "/w", agent: "claude", model: "opus", promptFile: "/w/p.txt", runArgs: [], status, runIds: [], log: `/w/${label}.log`, ...over };
}
function queue(over: Partial<QueueState> = {}): QueueState {
  return {
    v: 1, id: "q1", planPath: "/w/plan.txt", stateDir: "/s", countDirs: [], startedAt: NOW - 2 * H, updatedAt: NOW - 1000,
    maxConcurrent: 2, maxHours: 4, deadlineAt: NOW + 2 * H, queuePid: 4242, phase: "running", log: "/s/queues/q1.log",
    slices: [
      slice("alpha", "running", { pid: 99, launchedAt: NOW - 90_000 }),
      slice("bravo", "queued"),
      slice("charlie", "done", { runIds: ["abcdef0123456789"], launchedAt: NOW - H, finishedAt: NOW - H + 61_000 }),
      slice("delta", "failed", { error: "exit 3", launchedAt: NOW - H, finishedAt: NOW - H + 5000 }),
      slice("echo", "pre-failed", { error: "pre exited 1" }),
    ],
    ...over,
  };
}

describe("queue-view", () => {
  it("counts, time left and the dead-queue case", () => {
    const live = toQueueView(queue(), NOW, () => true);
    assert.deepEqual(live.counts, { queued: 1, "pre-failed": 1, running: 1, done: 1, failed: 1 });
    assert.equal(live.timeLeftMs, 2 * H);
    assert.equal(live.died, false);
    assert.equal(live.slices[0]!.elapsedMs, 90_000);
    const dead = toQueueView(queue(), NOW, () => false);
    assert.equal(dead.died, true);
    assert.equal(dead.displayPhase, "died");
    assert.equal(dead.resumeHint, "ach queue run --resume q1");
    assert.equal(toQueueView(queue({ phase: "drained", endedAt: NOW }), NOW, () => false).died, false);
  });

  it(`shows running queues and those ended within ${QUEUE_RECENT_HOURS}h only`, () => {
    const mk = (id: string, over: Partial<QueueState>) => queue({ id, ...over });
    const out = visibleQueues(
      [
        mk("run", {}),
        mk("fresh", { phase: "drained", endedAt: NOW - H }),
        mk("old", { phase: "drained", endedAt: NOW - (QUEUE_RECENT_HOURS + 1) * H }),
      ],
      NOW, undefined, () => true,
    );
    assert.deepEqual(out.map((q) => q.id), ["run", "fresh"]);
  });
});

describe("dash queues section", () => {
  it("renders every status and the dead-queue hint; absent when no queues", () => {
    const text = queueLines([toQueueView(queue(), NOW, () => false)], 120, false).join("\n");
    for (const s of ["queued", "running", "done", "failed", "pre-failed"]) assert.match(text, new RegExp(`\\b${s}\\b`));
    assert.match(text, /q1  DIED  queued 1 running 1 done 1 failed 1 pre-failed 1  cap 2/);
    assert.match(text, /queue process died \(pid 4242\) — ach queue run --resume q1/);
    assert.match(text, /alpha\s+claude\/opus\s+running\s+pid 99\s+1m30s/);
    assert.match(text, /charlie .*abcdef01\s+1m1s/);
    assert.match(text, /pre exited 1/);
    const live = queueLines([toQueueView(queue(), NOW, () => true)], 120, false).join("\n");
    assert.match(live, /q1  running  .*left 2h0m/);
    assert.doesNotMatch(live, /died/);
    assert.deepEqual(queueLines([], 120, false), []);
    const withQ = frame([], "/s", false, 120, false, { queues: [toQueueView(queue(), NOW, () => true)] });
    assert.match(withQ, /Queues \(running/);
    assert.doesNotMatch(frame([], "/s", false, 120, false), /Queues/);
  });

  it("--json keeps the bare array; --json --queues adds {records, queues}", () => {
    const root = mkdtempSync(join(tmpdir(), "ach-qd-"));
    try {
      writeQueueState(queue({ stateDir: root, phase: "drained", endedAt: Date.now(), startedAt: Date.now(), updatedAt: Date.now() }));
      const run = (extra: string[]) => {
        const args = isBun ? [CLI] : ["--import", "tsx", CLI];
        const r = spawnSync(isBun ? "bun" : process.execPath, [...args, "dash", "--json", "--state-only", "--state-dir", root, ...extra], { encoding: "utf8" });
        assert.equal(r.status, 0, r.stderr);
        return JSON.parse(r.stdout) as unknown;
      };
      assert.ok(Array.isArray(run([])));
      const o = run(["--queues"]) as { records: unknown[]; queues: Array<{ id: string; counts: Record<string, number>; slices: unknown[] }> };
      assert.ok(Array.isArray(o.records));
      assert.equal(o.queues.length, 1);
      assert.equal(o.queues[0]!.id, "q1");
      assert.equal(o.queues[0]!.counts.done, 1);
      assert.equal(o.queues[0]!.slices.length, 5);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("web queue page", () => {
  it("escapes labels, models, errors and ids", () => {
    const evil = "<script>alert(1)</script>";
    const q = queue({ slices: [slice(evil, "failed", { model: '"><img src=x onerror=1>', error: "<b>boom</b>", runIds: ["<i>"] })] });
    const html = renderQueuesPage([toQueueView(q, NOW, () => true)]);
    assert.doesNotMatch(html, /<script>alert/);
    assert.doesNotMatch(html, /<img/);
    assert.doesNotMatch(html, /<b>boom/);
    assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
    assert.equal(escapeHtml(`<&>"'`), "&lt;&amp;&gt;&quot;&#39;");
    assert.match(renderQueuesPage([]), /no queues running/);
  });
});

const children: ChildProcess[] = [];
after(() => { for (const c of children) c.kill("SIGKILL"); });

async function serve(stateDir: string, token: string): Promise<number> {
  const child = spawn("bun", [RUNNER, stateDir, token], { stdio: ["ignore", "pipe", "pipe"] });
  children.push(child);
  let out = "";
  child.stdout!.setEncoding("utf8");
  return new Promise<number>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("web server never ready")), 20_000);
    child.stdout!.on("data", (c: string) => {
      out += c;
      const m = /READY (\d+)\n/.exec(out);
      if (m) { clearTimeout(t); resolve(Number(m[1])); }
    });
    child.once("exit", () => { clearTimeout(t); reject(new Error("server exited early")); });
  });
}

describe("web /api/queues (bun subprocess)", { skip: isBun ? false : "bun not on PATH" }, () => {
  it("returns queue states and requires the token", async () => {
    const root = mkdtempSync(join(tmpdir(), "ach-qw-"));
    try {
      writeQueueState(queue({ stateDir: root, queuePid: process.pid, startedAt: Date.now(), updatedAt: Date.now(), deadlineAt: Date.now() + 2 * H }));
      const port = await serve(root, "sekret");
      const base = `http://127.0.0.1:${port}`;
      assert.equal((await fetch(`${base}/api/queues`)).status, 401);
      assert.equal((await fetch(`${base}/api/queues?token=wrong`)).status, 401);
      assert.equal((await fetch(`${base}/queues`)).status, 401);
      const ok = await fetch(`${base}/api/queues?token=sekret`);
      assert.equal(ok.status, 200);
      const body = (await ok.json()) as { queues: Array<{ id: string; died: boolean; counts: Record<string, number> }> };
      assert.equal(body.queues.length, 1);
      assert.equal(body.queues[0]!.id, "q1");
      assert.equal(body.queues[0]!.died, false);
      assert.equal(body.queues[0]!.counts.running, 1);
      const bearer = await fetch(`${base}/api/queues`, { headers: { authorization: "Bearer sekret" } });
      assert.equal(bearer.status, 200);
      const page = await fetch(`${base}/queues?token=sekret`);
      assert.equal(page.status, 200);
      assert.match(await page.text(), /alpha/);
      const noTok = await serve(root, "");
      assert.equal((await fetch(`http://127.0.0.1:${noTok}/api/queues`)).status, 200);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
