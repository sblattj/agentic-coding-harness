// Issue #161: the kiro-ide run refuses an endpoint that is not Kiro IDE before it drives anything.
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { KiroIdeAdapter, type SpawnFn } from "../src/adapters/kiro-ide.ts";
import { classifyKiroIdeEndpoint } from "../src/adapters/kiro-ide-cdp.ts";
import type { AgentEvent, RunSpec } from "../src/core/types.ts";
import { startFakeCdp, type FakeCdp } from "./fake-cdp.ts";

const WORKBENCH = "vscode-file://vscode-app/Applications/Kiro.app/Contents/Resources/app/out/vs/code/electron-browser/workbench/workbench.html";
const CHAT = "vscode-webview://abc/index.html?id=1&extensionId=kiro.kiroAgent&purpose=webviewView";
const REAL_KIRO = {
  Browser: "Chrome/152.0.7977.130",
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Kiro/1.2.4 Chrome/152.0.7977.130 Electron/44.4.3 Safari/537.36",
};
const VIVALDI = {
  Browser: "Chrome/130.0.0.0",
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Vivaldi/7.0.3495.18",
};
const tgt = (id: string, type: string, url: string) => ({ id, type, url, title: "ws", contexts: [{ id: 1, name: "", origin: "x" }] });
const TARGETS = [tgt("page", "page", WORKBENCH), tgt("chat", "iframe", CHAT)];

const open: FakeCdp[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((f) => f.close()));
});

function spawnRecorder(): { spawn: SpawnFn; calls: string[][] } {
  const calls: string[][] = [];
  const spawn: SpawnFn = (_cmd, args) => {
    calls.push(args);
    const child: any = { pid: 1, exitCode: null, kill: () => true, unref: () => {}, on: () => child };
    return child;
  };
  return { spawn, calls };
}

async function drive(fake: FakeCdp, kiroIde: Record<string, unknown>, spawn: SpawnFn) {
  const adapter = new KiroIdeAdapter({ pollMs: 15, readyTimeoutMs: 1500, recoverMs: 100, spawn, platform: "darwin", homeDir: "/home/x" });
  const h = await adapter.launch({ prompt: "hi", cwd: "/tmp/ws", kiroIde } as RunSpec);
  const events: AgentEvent[] = [];
  const [, exit] = await Promise.all([(async () => { for await (const e of h.attach()) events.push(e); })(), h.wait()]);
  return { events, exit };
}

describe("kiro-ide run refuses a non-Kiro endpoint (#161)", () => {
  it("attach mode: errors with the wrong-product message, spawns nothing, sends no CDP command", async () => {
    const fake = await startFakeCdp({ targets: TARGETS, version: VIVALDI });
    open.push(fake);
    const { spawn, calls } = spawnRecorder();
    const { events, exit } = await drive(fake, { cdp: fake.endpoint }, spawn);
    assert.equal(exit, "error");
    const err = events.find((e) => e.type === "error") as any;
    assert.match(err.message, new RegExp(`^port ${fake.endpoint.split(":")[1]} is a Vivaldi/7\\.0\\.3495\\.18, not Kiro IDE; pass --kiro-ide-port`));
    assert.match(err.message, /--kiro-ide-port <N>/);
    assert.equal(fake.calls.length, 0, "no Runtime/Input/Target command reached the endpoint");
    assert.equal(calls.length, 0);
  });

  it("launch mode with a browser already holding the port: no spawn, no attach, error", async () => {
    const fake = await startFakeCdp({ targets: TARGETS, version: VIVALDI });
    open.push(fake);
    const { spawn, calls } = spawnRecorder();
    const port = Number(fake.endpoint.split(":")[1]);
    const { events, exit } = await drive(fake, { port }, spawn);
    assert.equal(exit, "error");
    assert.match((events.find((e) => e.type === "error") as any).message, /is a Vivaldi\/7\.0\.3495\.18, not Kiro IDE/);
    assert.equal(calls.length, 0, "Kiro was not spawned against the browser's port");
    assert.equal(fake.calls.length, 0);
  });

  it("real Kiro 1.2.4 strings are not refused (control)", async () => {
    const fake = await startFakeCdp({ targets: TARGETS, version: REAL_KIRO });
    open.push(fake);
    const { spawn } = spawnRecorder();
    const { events } = await drive(fake, { cdp: fake.endpoint }, spawn);
    assert.ok(!events.some((e) => e.type === "error" && /not Kiro IDE/.test((e as any).message)));
    assert.ok(fake.calls.length > 0, "the run proceeded to drive the real Kiro endpoint");
  });
});

describe("classifyKiroIdeEndpoint", () => {
  const wb = [{ id: "p", type: "page", url: WORKBENCH }];
  it("real Kiro passes on User-Agent alone", () => assert.equal(classifyKiroIdeEndpoint(REAL_KIRO, undefined).kind, "kiro"));
  it("a UA without Kiro/ fails even with a workbench target", () => {
    const v = classifyKiroIdeEndpoint({ "User-Agent": "x Code/1.95 Electron/32.2.6 Safari/537.36" }, wb);
    assert.deepEqual([v.kind, (v as any).product], ["other", "Electron app (Electron/32.2.6)"]);
  });
  it("absent or empty UA uses the workbench target", () => {
    assert.equal(classifyKiroIdeEndpoint({}, wb).kind, "kiro");
    assert.equal(classifyKiroIdeEndpoint({ "User-Agent": "  " }, wb).kind, "kiro");
    assert.equal(classifyKiroIdeEndpoint({ Browser: "Chrome/1" }, []).kind, "other");
  });
});
