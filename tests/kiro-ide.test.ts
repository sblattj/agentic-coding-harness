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
  targets: Parameters<typeof startFakeCdp>[0]["targets"];
  state: {
    text: string;
    autopilot: "on" | "off";
    deep: string;
    sent: boolean;
    enter: number;
    tabClicks: number;
    /** Overrides what the pane-text expression returns. */
    paneFn?: () => string;
    /** Replaces the default Enter behaviour. */
    onEnter?: () => void;
    onTabClick?: (index: number) => void;
    /** The chat webview shows the Session History view: no input, a New session button. */
    history?: boolean;
    /** Shows the history view for exactly one poll, then the normal chat. */
    flash?: boolean;
  };
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
    /** The chat starts with a previous conversation (so New session must be clicked). */
    used?: boolean;
    /** Adds a hidden second chat target "chat2" (a rebuilt webview after a folder switch). */
    swapChat?: boolean;
    neverFinish?: boolean;
    /** Enter is swallowed: nothing is submitted (seen live right after a folder switch). */
    swallow?: boolean;
  } = {},
): Promise<World> {
  const state = {
    text: opts.used ? `${FIXTURE_WS_A.replace(/hello from ws-a/, "old")}` : IDLE_TEXT,
    autopilot: opts.autopilot ?? "on",
    deep: opts.deep ?? "Kiro Free 0 / 50 | Autocomplete",
    sent: false,
    enter: 0,
    tabClicks: 0,
  } as World["state"];
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
  for (const [id, hidden] of opts.withChat === false ? [] : ([["chat1", false], ...(opts.swapChat ? [["chat2", true]] : [])] as Array<[string, boolean]>)) {
    targets.push({
      id,
      hidden,
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
            if (state.onEnter) {
              state.onEnter();
              return {};
            }
            if (opts.swallow) return {};
            // Submitted: the prompt is echoed; a finished turn adds the reply.
            state.text = opts.neverFinish ? `${IDLE_TEXT}\n\n${PROMPT}` : (opts.final ?? FIXTURE_WS_B);
          }
          return {};
        }
        if (method !== "Runtime.evaluate") return {};
        const e: string = params.expression;
        const val = (v: unknown) => ({ result: { type: typeof v, value: v } });
        if (e.includes("Session History")) {
          if (contextId !== 3) return val(false);
          if (state.flash) {
            state.flash = false;
            return val(true);
          }
          return val(!!state.history);
        }
        if (e.startsWith("!!document.querySelector")) return val(contextId === 3 && !state.history && !state.flash);
        if (contextId !== 3) return val(null);
        if (e.includes("autopilot-toggle")) return val(state.autopilot);
        if (e.includes("New session")) {
          state.history = false;
          state.text = IDLE_TEXT;
          return val("clicked");
        }
        if (e.includes("e.focus()")) return val(true);
        if (e.includes("tab-bar-item") && e.endsWith(".length")) return val(2);
        if (e.includes("tab-bar-item")) {
          state.tabClicks++;
          state.onTabClick?.(Number(/\[(\d+)\]/.exec(e)![1]));
          return val("clicked");
        }
        if (e.includes("session-manager-header")) return val(state.paneFn ? state.paneFn() : state.text);
        return val(null);
      },
    });
  }
  const fake = await startFakeCdp({ targets });
  open.push(fake);
  return { fake, state, targets };
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

const fast = { pollMs: 15, readyTimeoutMs: 3000, recoverMs: 100, modelSettleMs: 100 };

describe("KiroIdeAdapter (fake CDP)", () => {
  it("happy path: events, credits 0.18, hook marker, tool call; attach mode never spawns", async () => {
    const w = await world({ used: true });
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

  it("newSession:false does not click New session; --model without a model picker fails before sending (issue #160)", async () => {
    // This world has no model picker, so a requested model cannot be set: fail, never send on the wrong model.
    const w = await world();
    const adapter = new KiroIdeAdapter(fast);
    const h = await adapter.launch(specFor(w.fake, { model: "claude-x", kiroIde: { cdp: w.fake.endpoint, newSession: false } }));
    const [events, exit] = await Promise.all([collect(h), h.wait()]);
    assert.equal(exit, "error");
    assert.ok(!w.fake.calls.some((c) => String(c.params?.expression ?? "").includes("New session")));
    assert.ok(events.some((e: any) => e.type === "error" && /could not select model 'claude-x'/.test(e.message)));
    assert.ok(!w.state.sent, "no prompt text was typed");
    assert.ok(!events.some((e: any) => e.type === "progress" && /ignored/.test(e.text)));
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

  it("a truncated tab label of the prompt while the pane is idle does not pass submit", async () => {
    const w = await world({ swallow: true });
    // Even if the tab label leaked into the pane text, a 70-char label is not the full prompt.
    w.state.paneFn = () => `${PROMPT.slice(0, 70)}\n${IDLE_TEXT}`;
    const adapter = new KiroIdeAdapter({ ...fast, submitTimeoutMs: 600 });
    const h = await adapter.launch(specFor(w.fake));
    const [events, exit] = await Promise.all([collect(h), h.wait()]);
    assert.equal(exit, "error");
    assert.match((events.find((e) => e.type === "error") as any).message, /not submitted/);
  });

  it("pane loses its echo: clicks the prompt's session tab and completes", async () => {
    const w = await world();
    let polls = 0;
    w.state.onEnter = () => {
      w.state.text = `${IDLE_TEXT}\n\n${PROMPT}`; // echoed, turn running
    };
    w.state.paneFn = () => {
      // after submit proof, the webview flips to a fresh pane until the tab is clicked
      if (w.state.enter > 0 && polls++ >= 3 && w.state.tabClicks === 0) return IDLE_TEXT;
      return w.state.text;
    };
    w.state.onTabClick = (i) => {
      if (i === 1) w.state.text = FIXTURE_WS_B; // the newest tab holds the prompt's session
    };
    const adapter = new KiroIdeAdapter(fast);
    const h = await adapter.launch(specFor(w.fake));
    const [events, exit] = await Promise.all([collect(h), h.wait()]);
    assert.equal(exit, "success", JSON.stringify(events.filter((e) => e.type === "error")));
    assert.ok(w.state.tabClicks >= 1);
    assert.ok(events.some((e: any) => e.type === "progress" && /re-selected/.test(e.text)));
    assert.equal((events.find((e) => e.type === "usage") as any).usage.extra.credits, 0.18);
  });

  it("an already-empty chat is reused instead of clicking New session", async () => {
    const w = await world();
    const h = await new KiroIdeAdapter(fast).launch(specFor(w.fake));
    const [, exit] = await Promise.all([collect(h), h.wait()]);
    assert.equal(exit, "success");
    assert.ok(!w.fake.calls.some((c) => String(c.params?.expression ?? "").includes("New session")));
  });

  describe("history view (every session tab closed)", () => {
    const HISTORY_TEXT = "Session History Answer Simple Trivia Questions 11/1/2026, 8:52:13 AM";
    const newSessionClicks = (w: World) =>
      w.fake.calls.filter((c) => {
        const e = String(c.params?.expression ?? "");
        return c.contextId === 3 && e.includes("b.click()") && e.includes("New session") && !e.includes("Session History");
      }).length;

    it("two consecutive polls: clicks New session once, then sends the prompt", async () => {
      const w = await world();
      w.state.history = true;
      w.state.text = HISTORY_TEXT;
      const h = await new KiroIdeAdapter(fast).launch(specFor(w.fake));
      const [events, exit] = await Promise.all([collect(h), h.wait()]);
      assert.equal(exit, "success", JSON.stringify(events.filter((e) => e.type === "error")));
      assert.equal(newSessionClicks(w), 1, "exactly one New session click (the later new-session step sees a fresh pane)");
      assert.equal(w.fake.calls.find((c) => c.method === "Input.insertText")?.params.text, PROMPT);
      assert.ok(events.some((e: any) => e.type === "progress" && /Session History/.test(e.text)));
    });

    it("a one-poll flash of the view does not click", async () => {
      const w = await world();
      w.state.flash = true;
      const h = await new KiroIdeAdapter(fast).launch(specFor(w.fake));
      const [events, exit] = await Promise.all([collect(h), h.wait()]);
      assert.equal(exit, "success", JSON.stringify(events.filter((e) => e.type === "error")));
      assert.equal(newSessionClicks(w), 0);
      assert.ok(!events.some((e: any) => e.type === "progress" && /Session History/.test(e.text)));
    });

    it("newSession:false fails fast with a clear message and sends nothing", async () => {
      const w = await world();
      w.state.history = true;
      w.state.text = HISTORY_TEXT;
      const t0 = Date.now();
      const h = await new KiroIdeAdapter({ ...fast, readyTimeoutMs: 20_000 }).launch(
        specFor(w.fake, { kiroIde: { cdp: w.fake.endpoint, newSession: false } }),
      );
      const [events, exit] = await Promise.all([collect(h), h.wait()]);
      assert.equal(exit, "error");
      assert.ok(Date.now() - t0 < 5000, "failed fast, not at the ready timeout");
      const msg = (events.find((e) => e.type === "error") as any).message as string;
      assert.match(msg, /no open session \(Session History is showing\)/);
      assert.match(msg, /open a session/);
      assert.equal(newSessionClicks(w), 0);
      assert.ok(!w.state.sent);
    });
  });

  describe("pending tool approval", () => {
    const approval = (cmd: string) => `${IDLE_TEXT}\n\n${PROMPT}\nYour approval is required to continue: ${cmd}\nAllow\nAlways allow\nDeny\nAlways deny\nCancel`;
    const noClicks = (w: World) => assert.ok(!w.fake.calls.some((c) => String(c.params?.expression ?? "").includes("Allow") || String(c.params?.expression ?? "").includes("Deny")));

    it("an approval left pending past approvalTimeoutMs fails naming the command; ach never clicks", async () => {
      const w = await world();
      w.state.onEnter = () => {
        w.state.text = approval("uname -s");
      };
      const h = await new KiroIdeAdapter({ ...fast, approvalTimeoutMs: 300 }).launch(specFor(w.fake));
      const [events, exit] = await Promise.all([collect(h), h.wait()]);
      assert.equal(exit, "error");
      const msg = (events.find((e) => e.type === "error") as any).message as string;
      assert.match(msg, /waiting for approval to run `uname -s`/);
      assert.match(msg, /approve it in the IDE, or trust the command in Kiro/);
      assert.equal((events.find((e) => e.type === "error") as any).payload?.kind, "invalid_request", "not reclassified as an outage");
      const notes = events.filter((e: any) => e.type === "progress" && /approval/.test(e.text));
      assert.equal(notes.length, 1, "one progress line per command");
      assert.match((notes[0] as any).text, /`uname -s`.*fails in 0s|`uname -s`.*fails in \d+s/);
      noClicks(w);
    });

    it("detects an approval whose card shows the first sub-command between the command and Allow (Kiro IDE 1.4.86)", async () => {
      const w = await world();
      w.state.onEnter = () => {
        w.state.text = `${IDLE_TEXT}\n\n${PROMPT}\nYour approval is required to continue: wc -c out.txt && od -c out.txt\nwc -c out.txt\nAllow\nAlways allow\nDeny\nAlways deny\nCancel`;
      };
      const h = await new KiroIdeAdapter({ ...fast, approvalTimeoutMs: 300, turnTimeoutMs: 5000 }).launch(specFor(w.fake));
      const [events, exit] = await Promise.all([collect(h), h.wait()]);
      assert.equal(exit, "error");
      const msg = (events.find((e) => e.type === "error") as any).message as string;
      assert.match(msg, /waiting for approval to run `wc -c out.txt && od -c out.txt`/, msg);
      noClicks(w);
    });

    it("an approval that clears (human approved in the IDE) keeps the run alive", async () => {
      const w = await world();
      w.state.onEnter = () => {
        w.state.text = approval("uname -s");
        setTimeout(() => (w.state.text = FIXTURE_WS_B), 150);
      };
      const h = await new KiroIdeAdapter({ ...fast, approvalTimeoutMs: 600 }).launch(specFor(w.fake));
      const [events, exit] = await Promise.all([collect(h), h.wait()]);
      assert.equal(exit, "success", JSON.stringify(events.filter((e) => e.type === "error")));
      assert.ok(events.some((e: any) => e.type === "progress" && /uname -s/.test(e.text)));
      noClicks(w);
    });

    it("a prompt that quotes the phrase does not trip it", async () => {
      const w = await world();
      const quoting = "Explain this message: Your approval is required to continue: rm x\nAllow";
      w.state.onEnter = () => {
        w.state.text = `${IDLE_TEXT}\n\n${quoting}`;
      };
      const h = await new KiroIdeAdapter({ ...fast, approvalTimeoutMs: 100, turnTimeoutMs: 700 }).launch(specFor(w.fake, { prompt: quoting }));
      const [events, exit] = await Promise.all([collect(h), h.wait()]);
      assert.equal(exit, "error");
      const msg = (events.find((e) => e.type === "error") as any).message as string;
      assert.match(msg, /did not finish/, msg);
      assert.ok(!events.some((e: any) => e.type === "progress" && /approval/.test(e.text)));
    });

    it("a changed command restarts the timer", async () => {
      const w = await world();
      let enterAt = 0;
      w.state.onEnter = () => {
        enterAt = Date.now();
      };
      w.state.paneFn = () => (enterAt === 0 ? w.state.text : approval(Date.now() - enterAt < 300 ? "echo a" : "echo b"));
      const h = await new KiroIdeAdapter({ ...fast, approvalTimeoutMs: 450 }).launch(specFor(w.fake));
      const [events, exit] = await Promise.all([collect(h), h.wait()]);
      assert.equal(exit, "error");
      const msg = (events.find((e) => e.type === "error") as any).message as string;
      assert.match(msg, /`echo b`/);
      assert.ok(Date.now() - enterAt >= 700, `timer restarted at the change (failed ${Date.now() - enterAt}ms after submit)`);
      assert.equal(events.filter((e: any) => e.type === "progress" && /approval/.test(e.text)).length, 2);
    });
  });

  it("submit stalls because the prompt ran in another tab: scans tabs and recovers", async () => {
    const w = await world();
    w.state.onEnter = () => {
      w.state.text = IDLE_TEXT; // a late New Session took the pane; the prompt is in tab 1
    };
    w.state.onTabClick = (i) => {
      if (i === 1) w.state.text = `${IDLE_TEXT}\n\n${PROMPT}`;
      if (i === 1) setTimeout(() => (w.state.text = FIXTURE_WS_B), 100);
    };
    const adapter = new KiroIdeAdapter({ ...fast, pollMs: 100 });
    const h = await adapter.launch(specFor(w.fake));
    const [events, exit] = await Promise.all([collect(h), h.wait()]);
    assert.equal(exit, "success", JSON.stringify(events.filter((e) => e.type === "error")));
    assert.ok(events.some((e: any) => e.type === "progress" && /another session tab/.test(e.text)));
  });

  it("a re-selected tab that renders its conversation slowly is still recovered (live: hooked workspace, Kiro IDE 1.4.86)", async () => {
    const w = await world();
    w.state.onEnter = () => {
      w.state.text = IDLE_TEXT; // the pane keeps the empty view; the prompt ran in tab 1
    };
    let pending: ReturnType<typeof setTimeout> | undefined;
    w.state.onTabClick = (i) => {
      clearTimeout(pending);
      w.state.text = IDLE_TEXT; // selecting any tab shows the empty view first
      if (i === 1) {
        pending = setTimeout(() => {
          w.state.text = `${IDLE_TEXT}\n\n${PROMPT}`;
          pending = setTimeout(() => (w.state.text = FIXTURE_WS_B), 100);
        }, 700); // well past the old single 250ms read
      }
    };
    const adapter = new KiroIdeAdapter({ ...fast, pollMs: 100, submitTimeoutMs: 6000 });
    const h = await adapter.launch(specFor(w.fake));
    const [events, exit] = await Promise.all([collect(h), h.wait()]);
    clearTimeout(pending);
    assert.equal(exit, "success", JSON.stringify(events.filter((e) => e.type === "error")));
    assert.ok(events.some((e: any) => e.type === "progress" && /another session tab/.test(e.text)));
  });

  it("only counts Elapsed time after the last prompt echo (an older turn's elapsed does not finish the run)", async () => {
    const w = await world();
    w.state.onEnter = () => {
      w.state.text = `Elapsed time: 9s\n\n${PROMPT}`;
    };
    const adapter = new KiroIdeAdapter({ ...fast, turnTimeoutMs: 400 });
    const h = await adapter.launch(specFor(w.fake, { kiroIde: { cdp: w.fake.endpoint, newSession: false } }));
    const [events, exit] = await Promise.all([collect(h), h.wait()]);
    assert.equal(exit, "error");
    assert.match((events.find((e) => e.type === "error") as any).message, /did not finish/);
  });

  it("after a folder switch, ignores the pre-switch chat id and uses the rebuilt one", async () => {
    const w = await world({ title: "ws-a", swapChat: true });
    const page = w.targets.find((t) => t.id === "page1")!;
    const chat1 = w.targets.find((t) => t.id === "chat1")!;
    const chat2 = w.targets.find((t) => t.id === "chat2")!;
    const spawn: SpawnFn = () => {
      page.title = "ws-b"; // title flips at once, the old webview lingers, then is replaced
      setTimeout(() => {
        chat1.hidden = true;
        chat2.hidden = false;
      }, 400);
      return { pid: 1, exitCode: null, kill: () => true, unref: () => {}, on: () => undefined };
    };
    const port = Number(w.fake.endpoint.split(":")[1]);
    const adapter = new KiroIdeAdapter({ ...fast, spawn });
    const h = await adapter.launch({ prompt: PROMPT, cwd: "/tmp/kiro-ide-spike/ws-b", kiroIde: { port } } as RunSpec);
    const [, exit] = await Promise.all([collect(h), h.wait()]);
    assert.equal(exit, "success");
    assert.ok(!w.fake.calls.some((c) => c.targetId === "chat1"), "the stale pre-switch chat id was never connected");
    assert.ok(w.fake.calls.some((c) => c.targetId === "chat2" && c.method === "Input.insertText"));
  });

  it("a second concurrent run against the same endpoint is refused by the lock", async () => {
    const w = await world({ neverFinish: true });
    const lockDir = await fs.mkdtemp(path.join(os.tmpdir(), "ach-lock-"));
    const a = new KiroIdeAdapter({ ...fast, lockDir });
    const b = new KiroIdeAdapter({ ...fast, lockDir });
    const h1 = await a.launch(specFor(w.fake));
    const d1 = collect(h1);
    while (w.state.enter === 0) await new Promise((r) => setTimeout(r, 10));
    const h2 = await b.launch(specFor(w.fake));
    const [ev2, exit2] = await Promise.all([collect(h2), h2.wait()]);
    assert.equal(exit2, "error");
    assert.match((ev2.find((e) => e.type === "error") as any).message, /already driving the Kiro IDE/);
    h1.abort();
    assert.equal(await h1.wait(), "aborted");
    await d1;
    assert.deepEqual(await fs.readdir(lockDir), [], "lock released");
  });

  it("ACH_KIRO_IDE_DEBUG=1 emits debug progress events with data for the CLI renderer", async () => {
    process.env.ACH_KIRO_IDE_DEBUG = "1";
    try {
      const w = await world({ used: true });
      const adapter = new KiroIdeAdapter(fast);
      const h = await adapter.launch(specFor(w.fake));
      const [events] = await Promise.all([collect(h), h.wait()]);
      const dbgs = events.filter((e: any) => e.type === "progress" && /^kiro-ide\[debug\]/.test(e.text));
      assert.ok(dbgs.some((e: any) => /ready chat target=/.test(e.text)));
      assert.ok(dbgs.some((e: any) => /autopilot=on/.test(e.text)));
      assert.ok(dbgs.some((e: any) => /new-session=clicked/.test(e.text)));
      assert.ok(dbgs.some((e: any) => /submit-pass/.test(e.text)));
      assert.ok(dbgs.every((e: any) => e.data === e.text));
    } finally {
      delete process.env.ACH_KIRO_IDE_DEBUG;
    }
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

// Kiro IDE 1.4.62 (live): the prompt echo is rendered as markdown, and a refused prompt
// shows up only as an "Error sending prompt" notification in the workbench.
const MD_PROMPT = `This is a hook test. Run each of these commands exactly as written, one tool call each.

1. git merge feature 2>&1 | tail -2 && echo AFTER-MERGE
2. grep -rn --include=*.cjs foo .
3. ls

Then reply with one line per command.`;
// What innerText gives for that prompt once rendered: list numbers are CSS markers.
const MD_ECHO = `This is a hook test. Run each of these commands exactly as written, one tool call each.

git merge feature 2>&1 | tail -2 && echo AFTER-MERGE
grep -rn --include=*.cjs foo .
ls

Then reply with one line per command.`;

describe("Kiro IDE prompt echo and refusals", () => {
  it("echoKey ignores list markers, code marks and whitespace", async () => {
    const { echoKey, echoProbe, lastEchoEnd } = await import("../src/adapters/kiro-ide.ts");
    assert.equal(echoKey(MD_PROMPT), echoKey(MD_ECHO));
    assert.equal(echoKey("- `a` **b**\n# c"), "abc");
    assert.ok(echoProbe(MD_PROMPT).length <= 200);
    const pane = `Restore\n\n${MD_ECHO}\n\nKiro\n1. BLOCKED\nElapsed time: 2s`;
    const end = lastEchoEnd(pane, echoKey(MD_PROMPT));
    assert.equal(pane.slice(end).trim().split("\n")[0], "Kiro");
    assert.equal(lastEchoEnd("nothing here", "abc"), -1);
  });

  it("promptErrorFrom pulls Kiro's refusal text", async () => {
    const { promptErrorFrom } = await import("../src/adapters/kiro-ide.ts");
    const deep = "Kiro | Error sending prompt: You've reached your monthly usage limit. Please return next month to continue building. (Request ID: 98068fa0) | View Usage";
    assert.equal(promptErrorFrom(deep), "You've reached your monthly usage limit. Please return next month to continue building.");
    assert.equal(promptErrorFrom("Kiro Free 0 / 50 | Autocomplete"), null);
  });

  it("a markdown-rendered prompt echo counts as submitted and the reply parses", async () => {
    const w = await world();
    w.state.onEnter = () => {
      w.state.text = `Checkpoint\nRestore\n\n${MD_ECHO}\n\nKiro\n1. BLOCKED\n2. BLOCKED\n3. RAN\nEst. Credits Used: 0.2\nElapsed time: 3s\n\nAuto\nDefault\nAutopilot`;
    };
    const adapter = new KiroIdeAdapter(fast);
    const h = await adapter.launch(specFor(w.fake, { prompt: MD_PROMPT }));
    const events = await collect(h);
    assert.equal(await h.wait(), "success");
    assert.ok(!events.some((e) => e.type === "error"), JSON.stringify(events.find((e) => e.type === "error")));
    const msg = events.find((e) => e.type === "message") as any;
    assert.match(msg.content, /1\. BLOCKED/);
    assert.ok(!msg.content.includes("git merge"), msg.content);
  });

  it("a refused prompt fails with Kiro's own message, not 'not submitted'", async () => {
    const w = await world();
    w.state.onEnter = () => {
      // The prompt is echoed, no turn runs, and the workbench shows the refusal.
      w.state.text = `Checkpoint\nRestore\n\n${MD_ECHO}\n\nKiro`;
      w.state.deep = "Error sending prompt: You've reached your monthly usage limit. Please return next month to continue building. (Request ID: 98068fa0) | Source: kiroAgent | View Usage";
    };
    const adapter = new KiroIdeAdapter({ ...fast, submitTimeoutMs: 3000, turnTimeoutMs: 3000 });
    const h = await adapter.launch(specFor(w.fake, { prompt: MD_PROMPT }));
    const events = await collect(h);
    assert.equal(await h.wait(), "error");
    const err = events.find((e) => e.type === "error") as any;
    assert.match(err.message, /Kiro IDE refused the prompt: You've reached your monthly usage limit/);
  });
});

describe("lastEchoEnd with list markers before the echo", () => {
  it("maps the offset exactly when earlier turns contain numbered lists", async () => {
    const { echoKey, lastEchoEnd } = await import("../src/adapters/kiro-ide.ts");
    const pane = `1. old\n2. older\n\n${MD_ECHO}\nKiro\n1. BLOCKED`;
    const end = lastEchoEnd(pane, echoKey(MD_PROMPT));
    assert.equal(pane.slice(end), "\nKiro\n1. BLOCKED");
  });
});
