// Claude-native desks and lanes (#204, alternative take): roster, spare/handoff
// detection, inbox send, lane launch/--after and transcript metering, all against
// an injected fake Claude (no real processes are signalled).
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import {
  envelope, isEmptySpare, launchAfter, launchArgs, launchLane, laneStatus, listSessions, postLine, sendTo,
  type PeerDeps, type PeerSession,
} from "../src/desks/claude-native.ts";

interface FakeSession { pid: number; sessionId: string; name: string; kind: string; status: string; jobId?: string; socket?: string }

function fake() {
  const home = mkdtempSync(path.join(os.tmpdir(), "ach-peers-"));
  mkdirSync(path.join(home, "sessions"), { recursive: true });
  mkdirSync(path.join(home, "projects", "-tmp-x"), { recursive: true });
  const alive = new Set<number>();
  const calls: string[][] = [];
  const posts: { socket: string; line: string }[] = [];
  const killed: number[] = [];
  let clock = 0;
  let onBg: ((args: string[]) => FakeSession | null) | null = null;
  const add = (s: FakeSession, opts: { transcript?: boolean; agentsRow?: boolean } = {}) => {
    alive.add(s.pid);
    writeFileSync(path.join(home, "sessions", `${s.pid}.json`), JSON.stringify({
      pid: s.pid, sessionId: s.sessionId, name: s.name, kind: s.kind, status: s.status,
      ...(s.jobId ? { jobId: s.jobId } : {}), ...(s.socket ? { messagingSocketPath: s.socket } : {}),
    }));
    if (opts.transcript) {
      writeFileSync(path.join(home, "projects", "-tmp-x", `${s.sessionId}.jsonl`), JSON.stringify({
        type: "assistant", sessionId: s.sessionId, timestamp: "2026-11-17T10:00:00.000Z", requestId: "r1",
        message: { id: "m1", model: "claude-opus-5-5", usage: { input_tokens: 50, cache_creation_input_tokens: 5, cache_read_input_tokens: 7, output_tokens: 25 } },
      }) + "\n");
    }
  };
  const deps: PeerDeps = {
    claudeHome: home,
    alive: (p) => alive.has(p),
    kill: (p) => { killed.push(p); alive.delete(p); },
    sleep: async (ms) => { clock += ms; },
    now: () => clock,
    post: async (socket, line) => { posts.push({ socket, line }); },
    exec: async (file, args) => {
      calls.push([file, ...args]);
      if (args[0] === "agents") {
        // the supported roster: name/kind/status by pid, no socket path
        const rows = [...alive].map((pid) => {
          try { return JSON.parse(readFileSync(path.join(home, "sessions", `${pid}.json`), "utf8")); }
          catch { return null; }
        }).filter(Boolean).map((r) => ({ pid: r.pid, sessionId: r.sessionId, name: r.name, kind: r.kind, status: r.status }));
        return { code: 0, stdout: JSON.stringify(rows), stderr: "" };
      }
      if (args[0] === "stop") {
        for (const pid of [...alive]) {
          const f = readFileSync(path.join(home, "sessions", `${pid}.json`), "utf8");
          if (JSON.parse(f).jobId === args[1]) alive.delete(pid);
        }
        return { code: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "--bg") {
        const s = onBg?.(args);
        if (s) add(s);
        return { code: 0, stdout: `started ${s?.jobId ?? "?"}\n  claude attach ${s?.jobId}\n  claude stop ${s?.jobId}\n`, stderr: "" };
      }
      return { code: 1, stdout: "", stderr: "unexpected" };
    },
  };
  return { home, deps, alive, calls, posts, killed, add, setOnBg: (f: typeof onBg) => { onBg = f; } };
}

const spare = (over: Partial<PeerSession> = {}): PeerSession => ({
  pid: 1, sessionId: "s1", name: "ORCHESTRATOR", kind: "bg", status: "shell", cwd: null, jobId: "j1", socket: null,
  transcript: null, handoff: null, ...over,
});

describe("isEmptySpare", () => {
  it("is a bg shell session with no transcript and no live adopted shells", () => {
    assert.equal(isEmptySpare(spare()), true);
    assert.equal(isEmptySpare(spare({ handoff: { liveShellPids: [] } })), true);
  });
  it("is not empty when an exit handoff still runs an adopted shell", () => {
    assert.equal(isEmptySpare(spare({ handoff: { liveShellPids: [4242] } })), false);
  });
  it("is not empty once it has a transcript, is interactive, or is busy", () => {
    assert.equal(isEmptySpare(spare({ transcript: "/x.jsonl" })), false);
    assert.equal(isEmptySpare(spare({ kind: "interactive" })), false);
    assert.equal(isEmptySpare(spare({ status: "busy" })), false);
  });
});

describe("listSessions", () => {
  it("joins the roster with session files, skips dead pids, reads exit handoffs", async () => {
    const f = fake();
    f.add({ pid: 10, sessionId: "aaa", name: "DECISIONS", kind: "interactive", status: "idle", socket: "/tmp/s10.sock" }, { transcript: true });
    f.add({ pid: 11, sessionId: "bbb", name: "ORCHESTRATOR", kind: "bg", status: "shell", jobId: "bbb1" });
    writeFileSync(path.join(f.home, "sessions", "99.json"), JSON.stringify({ pid: 99, sessionId: "dead", name: "GHOST" }));
    mkdirSync(path.join(f.home, "jobs", "bbb1"), { recursive: true });
    writeFileSync(path.join(f.home, "jobs", "bbb1", "adopt.json"), JSON.stringify({ origin: "exit", shells: [{ pid: 500 }, { pid: 501 }] }));
    f.alive.add(501);
    const ss = await listSessions(f.deps);
    assert.deepEqual(ss.map((s) => s.name), ["DECISIONS", "ORCHESTRATOR"]);
    assert.equal(ss[0]!.socket, "/tmp/s10.sock");
    assert.match(ss[0]!.transcript ?? "", /aaa\.jsonl$/);
    assert.deepEqual(ss[1]!.handoff, { liveShellPids: [501] });
    assert.equal(isEmptySpare(ss[1]!), false, "a handoff running a shell holds the name");
  });
});

describe("sendTo", () => {
  it("posts a labelled user line to the one live holder's socket", async () => {
    const f = fake();
    f.add({ pid: 10, sessionId: "aaa", name: "lane-a", kind: "bg", status: "busy", socket: "/tmp/a.sock" }, { transcript: true });
    f.add({ pid: 11, sessionId: "bbb", name: "lane-a", kind: "bg", status: "shell", jobId: "j" }); // empty spare: ignored
    await sendTo(f.deps, "lane-a", "human", "status?");
    assert.equal(f.posts.length, 1);
    assert.equal(f.posts[0]!.socket, "/tmp/a.sock");
    assert.deepEqual(JSON.parse(f.posts[0]!.line), { type: "user", message: { role: "user", content: "[peer-msg from human] status?" } });
  });
  it("refuses no holder, two holders, and a holder without an inbox", async () => {
    const f = fake();
    await assert.rejects(sendTo(f.deps, "nobody", "h", "x"), /no live Claude session named 'nobody'/);
    f.add({ pid: 10, sessionId: "a", name: "dup", kind: "interactive", status: "idle", socket: "/a" });
    f.add({ pid: 11, sessionId: "b", name: "dup", kind: "interactive", status: "idle", socket: "/b" });
    await assert.rejects(sendTo(f.deps, "dup", "h", "x"), /2 live sessions are named 'dup'/);
    f.add({ pid: 12, sessionId: "c", name: "mute", kind: "interactive", status: "idle" });
    await assert.rejects(sendTo(f.deps, "mute", "h", "x"), /no inbox socket/);
  });
});

describe("launchLane", () => {
  const opts = { name: "lane-x", goal: "ship it", cwd: "/tmp", model: "opus", bypass: true, disallowedTools: ["AskUserQuestion"], reportTo: "ORCHESTRATOR" };

  it("builds bg args that accept ach's inbox posts and carry the goal and report contract", () => {
    const a = launchArgs(opts);
    assert.deepEqual(a.slice(0, 6), ["--bg", "-n", "lane-x", "--model", "opus", "--dangerously-skip-permissions"]);
    assert.ok(a.includes("--disallowed-tools=AskUserQuestion"));
    assert.equal(a[a.indexOf("--settings") + 1], JSON.stringify({ crossSessionInbound: "accept" }));
    assert.match(a.at(-1)!, /Goal:\nship it/);
    assert.match(a.at(-1)!, /session named ORCHESTRATOR with SendMessage/);
    assert.ok(!a.includes("--session-id"), "--bg ignores --session-id; the id is read back");
  });

  it("stops an empty spare holding the name, launches, reads the session id back and records it", async () => {
    const f = fake();
    f.add({ pid: 20, sessionId: "old", name: "lane-x", kind: "bg", status: "shell", jobId: "oldjob" });
    f.setOnBg(() => ({ pid: 30, sessionId: "newjob-1234", name: "lane-x", kind: "bg", status: "busy", jobId: "newjob" }));
    const lanes = path.join(f.home, "lanes");
    const rec = await launchLane(f.deps, opts, lanes);
    assert.equal(rec.pid, 30);
    assert.equal(rec.sessionId, "newjob-1234");
    assert.equal(rec.jobId, "newjob");
    assert.ok(f.calls.some((c) => c[1] === "stop" && c[2] === "oldjob"), "spare stopped via claude stop");
    assert.ok(!f.alive.has(20));
    const st = await laneStatus(f.deps, lanes, "lane-x");
    assert.equal(st.live, true);
  });

  it("refuses a name a live session holds, including an exit handoff with a running shell", async () => {
    const f = fake();
    f.add({ pid: 20, sessionId: "h", name: "lane-x", kind: "bg", status: "shell", jobId: "hj" });
    mkdirSync(path.join(f.home, "jobs", "hj"), { recursive: true });
    writeFileSync(path.join(f.home, "jobs", "hj", "adopt.json"), JSON.stringify({ origin: "exit", shells: [{ pid: 777 }] }));
    f.alive.add(777);
    await assert.rejects(launchLane(f.deps, opts, path.join(f.home, "lanes")), /already live \(pid 20\)/);
    assert.equal(f.killed.length, 0, "never signals a handoff that carries live work");
    assert.ok(!f.calls.some((c) => c[1] === "stop"));
  });

  it("fails loudly when the session never registers", async () => {
    const f = fake();
    f.setOnBg(() => null);
    await assert.rejects(launchLane(f.deps, { ...opts, registerTimeoutMs: 5000 }, path.join(f.home, "lanes")), /did not register/);
  });
});

describe("launchAfter", () => {
  it("waits until the predecessor is gone, ignoring an empty spare that takes its name, then launches", async () => {
    const f = fake();
    f.add({ pid: 40, sessionId: "orch", name: "ORCHESTRATOR", kind: "interactive", status: "busy" }, { transcript: true });
    let polls = 0;
    const realSleep = f.deps.sleep;
    f.deps.sleep = async (ms) => {
      polls++;
      if (polls === 2) { // predecessor exits; a spare grabs the name at once
        f.alive.delete(40);
        f.add({ pid: 41, sessionId: "spare", name: "ORCHESTRATOR", kind: "bg", status: "shell", jobId: "sp" });
      }
      await realSleep(ms);
    };
    f.setOnBg(() => ({ pid: 50, sessionId: "succ-1", name: "ORCHESTRATOR-2", kind: "bg", status: "busy", jobId: "succ" }));
    const log: string[] = [];
    const rec = await launchAfter(f.deps, "ORCHESTRATOR",
      { name: "ORCHESTRATOR-2", goal: "take over", cwd: "/tmp", model: "opus", bypass: true, disallowedTools: [] },
      path.join(f.home, "lanes"), 60_000, (s) => log.push(s));
    assert.equal(rec.pid, 50);
    assert.equal(rec.after, "ORCHESTRATOR");
    assert.ok(log.some((l) => /is gone/.test(l)));
  });

  it("gives up after the timeout", async () => {
    const f = fake();
    f.add({ pid: 40, sessionId: "orch", name: "ORCHESTRATOR", kind: "interactive", status: "busy" }, { transcript: true });
    await assert.rejects(launchAfter(f.deps, "ORCHESTRATOR",
      { name: "n2", goal: "g", cwd: "/tmp", model: "opus", bypass: true, disallowedTools: [] },
      path.join(f.home, "lanes"), 20_000, () => {}), /still live after/);
  });
});

describe("laneStatus metering", () => {
  it("reads tokens from the lane's transcript with the claude normalizer", async () => {
    const f = fake();
    f.setOnBg(() => ({ pid: 60, sessionId: "met-1", name: "lane-m", kind: "bg", status: "busy", jobId: "met" }));
    const lanes = path.join(f.home, "lanes");
    await launchLane(f.deps, { name: "lane-m", goal: "g", cwd: "/tmp", model: "opus", bypass: true, disallowedTools: [] }, lanes);
    f.add({ pid: 60, sessionId: "met-1", name: "lane-m", kind: "bg", status: "idle", jobId: "met" }, { transcript: true });
    const st = await laneStatus(f.deps, lanes, "lane-m");
    assert.deepEqual(st.tokens, { input: 50, output: 25, cacheRead: 7, cacheWrite: 5, turns: 1 });
    f.alive.delete(60);
    assert.equal((await laneStatus(f.deps, lanes, "lane-m")).live, false);
  });
});

describe("postLine", () => {
  it("writes exactly one newline-terminated JSON line to a unix socket", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "ach-sock-"));
    const sock = path.join(dir, "in.sock");
    let got = "";
    const srv = net.createServer((c) => { c.on("data", (d) => (got += d)); });
    await new Promise<void>((r) => srv.listen(sock, r));
    await postLine(sock, envelope("t", "hi"));
    await new Promise((r) => setTimeout(r, 50));
    srv.close();
    assert.ok(got.endsWith("\n"));
    assert.equal(got.split("\n").length, 2);
    assert.equal(JSON.parse(got).message.content, "[peer-msg from t] hi");
  });
  it("rejects when nothing listens", async () => {
    await assert.rejects(postLine(path.join(os.tmpdir(), "ach-none-" + process.pid + ".sock"), "{}"), /inbox/);
  });
});

