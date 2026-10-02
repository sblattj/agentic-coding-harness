// Kiro IDE adapter (issue #110): fake-CDP tests, parser tests on the raw
// live-captured chat text, and one run through the real Driver.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import {
  KIRO_IDE_CAPABILITIES,
  KiroIdeAdapter,
  parseKiroIdeTurn,
  workspaceTitleMatches,
  type SpawnFn,
  type SpawnedChild,
} from "../src/adapters/kiro-ide.ts";
import { createDriver } from "../src/core/driver.ts";
import { listRunRecords } from "../src/core/registry.ts";
import type { AgentEvent, RunSpec } from "../src/core/types.ts";
import { startFakeCdp, type FakeCdp } from "./fake-cdp.ts";

const PROMPT = "Read the file hello.txt with your file read tool and reply with its exact contents. Do not use the shell.";

// RAW, verbatim live capture (Kiro IDE 1.2.4, workspace ws-b, hook fired).
const FIXTURE_WS_B = `Read hello.txt File Contents
Loading
Artifacts
0
Starting cloud session
Checkpoint
Restore

${PROMPT}

Run Command Hook
marker
Kiro
1 tool call
Read File
hello.txt

The exact contents of hello.txt are:

hello from ws-b
Est. Credits Used: 0.18
Elapsed time: 3s




Auto
Default
Autopilot`;

// ws-a variant: no hook, other title/credits/contents.
const FIXTURE_WS_A = `Read hello.txt With File Tool
Loading
Artifacts
0
Starting cloud session
Checkpoint
Restore

${PROMPT}

Kiro
1 tool call
Read File
hello.txt

The exact contents of hello.txt are:

hello from ws-a
Est. Credits Used: 0.12
Elapsed time: 4s




Auto
Default
Autopilot`;

const IDLE_TEXT = "New Session\nLoading\nArtifacts\n0\nStarting cloud session\nLet's build\nAuto\nDefault\nAutopilot";

const WORKBENCH_URL = "vscode-file://vscode-app/Applications/Kiro.app/Contents/Resources/app/out/vs/code/electron-browser/workbench/workbench.html";
const CHAT_URL = "vscode-webview://abc/index.html?id=1&extensionId=kiro.kiroAgent&purpose=webviewView";

interface World {
  fake: FakeCdp;
  state: { text: string; autopilot: "on" | "off"; deep: string; sent: boolean; enter: number };
}

const open: FakeCdp[] = [];
afterEach(async () => {
  while (open.length) await open.pop()!.close();
});

async function world(
  opts: {
    final?: string;
    autopilot?: "on" | "off";
    deep?: string;
    title?: string;
    withChat?: boolean;
    neverFinish?: boolean;
    /** Enter is swallowed: nothing is submitted (seen live right after a folder switch). */
    swallow?: boolean;
  } = {},
): Promise<World> {
  const state = {
    text: IDLE_TEXT,
    autopilot: opts.autopilot ?? "on",
    deep: opts.deep ?? "Kiro Free 0 / 50 | Autocomplete",
    sent: false,
    enter: 0,
  };
  const targets: Parameters<typeof startFakeCdp>[0]["targets"] = [
    {
      id: "page1",
      type: "page",
      url: WORKBENCH_URL,
      title: opts.title ?? "ws-b",
      contexts: [
        { id: 1, name: "", origin: "vscode-file://vscode-app" },
        { id: 2, name: "Electron Isolated Context", origin: "vscode-file://vscode-app" },
      ],
      handler: (method, params) => {
        if (method !== "Runtime.evaluate") return {};
        const e: string = params.expression;
        if (e.includes("Skip All")) return { result: { type: "string", value: "clicked" } };
        return { result: { type: "string", value: state.deep } };
      },
    },
  ];
  if (opts.withChat !== false) {
    targets.push({
      id: "chat1",
      type: "iframe",
      url: CHAT_URL,
      contexts: [
        { id: 3, name: "", origin: "vscode-webview://abc" },
        { id: 4, name: "", origin: "vscode-webview://abc" },
      ],
      handler: (method, params, contextId) => {
        if (method === "Input.insertText") {
          state.sent = true;
          return {};
        }
        if (method === "Input.dispatchKeyEvent") {
          if (params.type === "keyDown" && params.key === "Enter") {
            state.enter++;
            if (opts.swallow) return {};
            // Submitted: the prompt is echoed; a finished turn adds the reply.
            state.text = opts.neverFinish ? `${IDLE_TEXT}\n\n${PROMPT}` : (opts.final ?? FIXTURE_WS_B);
          }
          return {};
        }
        if (method !== "Runtime.evaluate") return {};
        const e: string = params.expression;
        const val = (v: unknown) => ({ result: { type: typeof v, value: v } });
        if (e.startsWith("!!document.querySelector")) return val(contextId === 3);
        if (contextId !== 3) return val(null);
        if (e.includes("autopilot-toggle")) return val(state.autopilot);
        if (e.includes("New session")) {
          state.text = IDLE_TEXT;
          return val("clicked");
        }
        if (e.includes("e.focus()")) return val(true);
        if (e === "document.body.innerText") return val(state.text);
        return val(null);
      },
    });
  }
  const fake = await startFakeCdp({ targets });
  open.push(fake);
  return { fake, state };
}

function recordingSpawn(): { spawn: SpawnFn; calls: Array<{ cmd: string; args: string[] }>; kills: number[] } {
  const calls: Array<{ cmd: string; args: string[] }> = [];
  const kills: number[] = [];
  const spawn: SpawnFn = (cmd, args) => {
    calls.push({ cmd, args });
    const child: SpawnedChild = {
      pid: 4242,
      exitCode: null,
      kill: () => {
        kills.push(calls.length);
        return true;
      },
      unref: () => {},
      on: () => child,
    };
    return child;
  };
  return { spawn, calls, kills };
}

function specFor(fake: FakeCdp, extra: Partial<RunSpec> = {}): RunSpec {
  return { prompt: PROMPT, cwd: "/tmp/kiro-ide-spike/ws-b", kiroIde: { cdp: fake.endpoint }, ...extra } as RunSpec;
}

async function collect(h: { attach(): AsyncIterable<AgentEvent> }): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const e of h.attach()) out.push(e);
  return out;
}

const fast = { pollMs: 15, readyTimeoutMs: 3000, recoverMs: 100 };

describe("KiroIdeAdapter (fake CDP)", () => {
  it("happy path: events, credits 0.18, hook marker, tool call; attach mode never spawns", async () => {
    const w = await world();
    const { spawn, calls } = recordingSpawn();
    const adapter = new KiroIdeAdapter({ ...fast, spawn });
    const handle = await adapter.launch(specFor(w.fake));
    assert.match(handle.sessionId, /^kiro-ide-/);
    const [events, exit] = await Promise.all([collect(handle), handle.wait()]);
    assert.equal(exit, "success");
    assert.equal(calls.length, 0, "attach mode must never spawn");
    const types = events.map((e) => e.type);
    assert.deepEqual(types.filter((t) => t !== "progress"), [
      "session_start",
      "message",
      "tool_call",
      "tool_call",
      "usage",
      "step",
      "session_end",
    ]);
    const start = events[0] as any;
    assert.equal(start.agent, "kiro-ide");
    const msg = events.find((e) => e.type === "message") as any;
    assert.equal(msg.source, "assistant");
    assert.match(msg.content, /hello from ws-b/);
    const tools = events.filter((e) => e.type === "tool_call").map((e: any) => e.functionName);
    assert.deepEqual(tools, ["hook:marker", "Read File"]);
    const usage = events.find((e) => e.type === "usage") as any;
    assert.equal(usage.usage.model, "kiro-ide");
    assert.equal(usage.usage.extra.credits, 0.18);
    assert.equal(usage.usage.extra.creditsCumulative, 0.18);
    assert.equal(usage.usage.extra.tokensAvailable, false);
    assert.equal(usage.usage.extra.source, "native");
    assert.equal((events.find((e) => e.type === "step") as any).payload.countsAsTurn, true);
    // prompt went through the chat target via CDP Input events
    const ins = w.fake.calls.find((c) => c.method === "Input.insertText");
    assert.equal(ins?.targetId, "chat1");
    assert.equal(ins?.params.text, PROMPT);
    assert.equal(w.state.enter, 1);
    // new session was requested before the send
    const order = w.fake.calls.filter((c) => c.targetId === "chat1").map((c) => (c.params?.expression?.includes?.("New session") ? "new" : c.method));
    assert.ok(order.indexOf("new") >= 0 && order.indexOf("new") < order.indexOf("Input.insertText"));
  });

  it("newSession:false does not click New session; model pin is ignored with a progress note", async () => {
    const w = await world();
    const adapter = new KiroIdeAdapter(fast);
    const h = await adapter.launch(specFor(w.fake, { model: "claude-x", kiroIde: { cdp: w.fake.endpoint, newSession: false } }));
    const [events, exit] = await Promise.all([collect(h), h.wait()]);
    assert.equal(exit, "success");
    assert.ok(!w.fake.calls.some((c) => String(c.params?.expression ?? "").includes("New session")));
    assert.ok(events.some((e: any) => e.type === "progress" && /model 'claude-x' ignored/.test(e.text)));
  });

  it("fails fast when the profile is not signed in", async () => {
    const w = await world({ deep: "An agentic IDE | Sign in | By signing in, you agree to the | AWS Customer Agreement" });
    const adapter = new KiroIdeAdapter(fast);
    const h = await adapter.launch(specFor(w.fake, { kiroIde: { cdp: w.fake.endpoint, userDataDir: "/p/profile" } }));
    const [events, exit] = await Promise.all([collect(h), h.wait()]);
    assert.equal(exit, "error");
    const err = events.find((e) => e.type === "error") as any;
    assert.match(err.message, /not signed in for profile \/p\/profile; launch it once and sign in/);
    assert.ok(!w.fake.calls.some((c) => c.method === "Input.insertText"));
  });

  it("clicks Skip All on the onboarding screen", async () => {
    const w = await world({ deep: "Import configuration | Next | Skip All" });
    const adapter = new KiroIdeAdapter(fast);
    const h = await adapter.launch(specFor(w.fake));
    await Promise.all([collect(h), h.wait()]);
    const clicks = w.fake.calls.filter((c) => c.targetId === "page1" && String(c.params?.expression ?? "").includes("click()"));
    assert.ok(clicks.length >= 2, "Skip All is attempted in every context");
    assert.deepEqual(new Set(clicks.map((c) => c.contextId)), new Set([1, 2]));
  });

  it("fails fast when the chat is not in Autopilot", async () => {
    const w = await world({ autopilot: "off" });
    const adapter = new KiroIdeAdapter(fast);
    const h = await adapter.launch(specFor(w.fake));
    const [events, exit] = await Promise.all([collect(h), h.wait()]);
    assert.equal(exit, "error");
    assert.match((events.find((e) => e.type === "error") as any).message, /not in Autopilot/);
    assert.ok(!w.fake.calls.some((c) => c.method === "Input.insertText"));
  });

  it("times out when no chat target appears", async () => {
    const w = await world({ withChat: false });
    const adapter = new KiroIdeAdapter({ ...fast, readyTimeoutMs: 400 });
    const h = await adapter.launch(specFor(w.fake));
    const [events, exit] = await Promise.all([collect(h), h.wait()]);
    assert.equal(exit, "error");
    assert.match((events.find((e) => e.type === "error") as any).message, /not ready after 400ms.*no chat webview target/);
  });

  it("abort mid-wait resolves 'aborted' promptly", async () => {
    const w = await world({ neverFinish: true });
    const adapter = new KiroIdeAdapter({ ...fast, pollMs: 5000 });
    const h = await adapter.launch(specFor(w.fake));
    const events: AgentEvent[] = [];
    const drained = (async () => {
      for await (const e of h.attach()) events.push(e);
    })();
    const t0 = Date.now();
    while (w.state.enter === 0) await new Promise((r) => setTimeout(r, 10));
    h.abort();
    assert.equal(await h.wait(), "aborted");
    await drained;
    assert.ok(Date.now() - t0 < 3000, "abort must not wait out the 5 s poll");
    assert.ok(!events.some((e) => e.type === "usage"));
  });

  it("launch mode with an IDE already answering uses the --reuse-window form and no fresh child", async () => {
    const w = await world();
    const port = Number(w.fake.endpoint.split(":")[1]);
    const { spawn, calls, kills } = recordingSpawn();
    const adapter = new KiroIdeAdapter({ ...fast, spawn, platform: "darwin", homeDir: "/home/x" });
    const h = await adapter.launch({ prompt: PROMPT, cwd: "/tmp/kiro-ide-spike/ws-b", kiroIde: { port } } as RunSpec);
    const [, exit] = await Promise.all([collect(h), h.wait()]);
    assert.equal(exit, "success");
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.cmd, "/Applications/Kiro.app/Contents/MacOS/Kiro");
    assert.deepEqual(calls[0]!.args, ["--user-data-dir=/home/x/.local/state/ach-kiro-ide/profile", "--reuse-window", "/tmp/kiro-ide-spike/ws-b"]);
    assert.equal(kills.length, 0);
  });

  it("waits for the workspace title to match; recovers once with --reuse-window", async () => {
    const w = await world({ title: "ws-a" }); // wrong folder -> never ready
    const port = Number(w.fake.endpoint.split(":")[1]);
    const { spawn, calls } = recordingSpawn();
    const adapter = new KiroIdeAdapter({ ...fast, readyTimeoutMs: 700, recoverMs: 100, spawn });
    const h = await adapter.launch({ prompt: PROMPT, cwd: "/tmp/kiro-ide-spike/ws-b", kiroIde: { port } } as RunSpec);
    const [events, exit] = await Promise.all([collect(h), h.wait()]);
    assert.equal(exit, "error");
    assert.match((events.find((e) => e.type === "error") as any).message, /not ready/);
    // initial reuse-window + exactly one recovery re-invocation
    assert.equal(calls.length, 2);
    assert.ok(calls.every((c) => c.args.includes("--reuse-window")));
  });

  it("fails when the prompt is never submitted instead of polling an idle chat", async () => {
    const w = await world({ swallow: true });
    const h = await new KiroIdeAdapter({ ...fast, submitTimeoutMs: 300 }).launch(specFor(w.fake));
    const [events, exit] = await Promise.all([collect(h), h.wait()]);
    assert.equal(exit, "error");
    assert.match((events.find((e) => e.type === "error") as any).message, /not submitted/);
  });

  it("bounds a submitted turn that never prints Elapsed time", async () => {
    const w = await world({ neverFinish: true });
    const h = await new KiroIdeAdapter({ ...fast, turnTimeoutMs: 300 }).launch(specFor(w.fake));
    const [events, exit] = await Promise.all([collect(h), h.wait()]);
    assert.equal(exit, "error");
    assert.match((events.find((e) => e.type === "error") as any).message, /did not finish/);
  });

  it("with no spec.cwd (how `ach run` calls it) targets process.cwd(), not whatever folder is open", async () => {
    // Regression: the first live A/B ran the ws-a prompt in the ws-b window because
    // spec.cwd was undefined, so no folder was passed and any title matched.
    const w = await world({ title: "ws-b" });
    const port = Number(w.fake.endpoint.split(":")[1]);
    const { spawn, calls } = recordingSpawn();
    const adapter = new KiroIdeAdapter({ ...fast, readyTimeoutMs: 700, recoverMs: 100, spawn });
    const h = await adapter.launch({ prompt: PROMPT, kiroIde: { port } } as RunSpec);
    const [, exit] = await Promise.all([collect(h), h.wait()]);
    assert.equal(exit, "error"); // the open window is ws-b, not this process's cwd
    assert.ok(calls.length >= 1);
    assert.equal(calls[0]!.args.at(-1), process.cwd());
  });

  it("fresh launch spawns with --remote-debugging-port and abort kills only that child", async () => {
    const free = await new Promise<number>((resolve) => {
      const s = net.createServer().listen(0, "127.0.0.1", () => {
        const p = (s.address() as net.AddressInfo).port;
        s.close(() => resolve(p));
      });
    });
    const { spawn, calls, kills } = recordingSpawn();
    const adapter = new KiroIdeAdapter({ ...fast, spawn, platform: "linux", homeDir: "/h" });
    const h = await adapter.launch({ prompt: PROMPT, cwd: "/w/proj", kiroIde: { port: free } } as RunSpec);
    while (calls.length === 0) await new Promise((r) => setTimeout(r, 10));
    assert.equal(calls[0]!.cmd, "kiro");
    assert.deepEqual(calls[0]!.args, [`--remote-debugging-port=${free}`, "--user-data-dir=/h/.local/state/ach-kiro-ide/profile", "/w/proj"]);
    h.abort();
    assert.equal(await h.wait(), "aborted");
    assert.equal(kills.length, 1);
  });
});

describe("parseKiroIdeTurn", () => {
  it("parses the raw ws-b capture", () => {
    const t = parseKiroIdeTurn(FIXTURE_WS_B, PROMPT);
    assert.equal(t.promptFound, true);
    assert.equal(t.credits, 0.18);
    assert.equal(t.elapsedSeconds, 3);
    assert.deepEqual(t.hooks, ["marker"]);
    assert.equal(t.toolCallCount, 1);
    assert.deepEqual(t.toolCalls, [{ name: "Read File", args: ["hello.txt"] }]);
    assert.equal(t.reply, "The exact contents of hello.txt are:\n\nhello from ws-b");
    assert.equal(t.complete, true);
  });

  it("parses the ws-a variant (no hook)", () => {
    const t = parseKiroIdeTurn(FIXTURE_WS_A, PROMPT);
    assert.equal(t.credits, 0.12);
    assert.equal(t.elapsedSeconds, 4);
    assert.deepEqual(t.hooks, []);
    assert.deepEqual(t.toolCalls, [{ name: "Read File", args: ["hello.txt"] }]);
    assert.equal(t.reply, "The exact contents of hello.txt are:\n\nhello from ws-a");
  });

  it("handles no tool calls, multiple tools, and a missing prompt echo", () => {
    const plain = parseKiroIdeTurn(`Restore\n\nhi\n\nKiro\nHello there.\nEst. Credits Used: 0.05\nElapsed time: 1m 5s\n`, "hi");
    assert.equal(plain.reply, "Hello there.");
    assert.equal(plain.elapsedSeconds, 65);
    assert.equal(plain.toolCallCount, 0);
    const multi = parseKiroIdeTurn(`x\nRestore\n\nP\n\nKiro\n2 tool calls\nRead File\na.txt\nWrite File\nb.txt\n\nDone.\nEst. Credits Used: 1\nElapsed time: 9s`, "P");
    assert.deepEqual(multi.toolCalls, [
      { name: "Read File", args: ["a.txt"] },
      { name: "Write File", args: ["b.txt"] },
    ]);
    assert.equal(multi.reply, "Done.");
    const lost = parseKiroIdeTurn(`junk\nRestore\n\nunmatched echo\n\nKiro\nok\nEst. Credits Used: 2\nElapsed time: 2s`, "something else");
    assert.equal(lost.promptFound, false);
    assert.equal(lost.reply, "ok");
  });

  it("reports an incomplete turn", () => {
    const t = parseKiroIdeTurn("Restore\n\nhi\n\nKiro\nthinking", "hi");
    assert.equal(t.complete, false);
    assert.equal(t.credits, null);
  });
});

describe("workspaceTitleMatches", () => {
  it("matches folder-only and file-prefixed titles", () => {
    assert.ok(workspaceTitleMatches("ws-a", "/tmp/x/ws-a"));
    assert.ok(workspaceTitleMatches("hello.txt — ws-a", "/tmp/x/ws-a/"));
    assert.ok(workspaceTitleMatches("● hello.txt — ws-a", "/tmp/x/ws-a"));
    assert.ok(!workspaceTitleMatches("hello.txt — ws-b", "/tmp/x/ws-a"));
    assert.ok(workspaceTitleMatches("anything", undefined));
  });
});

describe("KIRO_IDE_CAPABILITIES", () => {
  it("is honest about being a GUI app", () => {
    assert.equal(KIRO_IDE_CAPABILITIES.headless, false);
    assert.equal(KIRO_IDE_CAPABILITIES.streaming, false);
  });
});

describe("KiroIdeAdapter through the real Driver", () => {
  it("lands credits 0.18 on the run record", async () => {
    const w = await world();
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "harness-kiro-ide-"));
    // The driver takes an explicit adapters map; no driver.ts change is needed.
    const driver = createDriver({
      adapters: { "kiro-ide": new KiroIdeAdapter(fast) },
      stateDir,
      registry: { stateDir },
    });
    const result = await driver.run("kiro-ide", specFor(w.fake));
    assert.equal(result.exitStatus, "success", JSON.stringify(result.warnings));
    assert.equal(result.usage?.credits.value, 0.18);
    const rec = listRunRecords(stateDir).find((r) => r.runId === result.runId);
    assert.equal(rec?.totals?.credits, 0.18);
    assert.equal(rec?.totals?.inputTokens, 0, "placeholder token zeros must not be summed");
  });
});
