import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CdpSession,
  DEEP_TEXT_JS,
  KIRO_IDE_SELECTORS,
  browserVersion,
  clickByTextJs,
  endpointFrom,
  isLoopbackHost,
  listTargets,
} from "../src/adapters/kiro-ide-cdp.ts";
import { NO_REPLY, startFakeCdp, type FakeCdpSpec } from "./fake-cdp.ts";

const spec = (over: Partial<FakeCdpSpec["targets"][number]> = {}): FakeCdpSpec => ({
  targets: [
    {
      id: "chat",
      type: "iframe",
      url: "vscode-webview://x/index.html?extensionId=kiro.kiroAgent",
      contexts: [
        { id: 1, name: "", origin: "vscode-webview://x" },
        { id: 2, name: "inner", origin: "vscode-webview://y" },
      ],
      ...over,
    },
    { id: "wb", type: "page", url: "vscode-file://app/workbench.html", title: "ws-a" },
  ],
});

describe("kiro-ide-cdp", () => {
  it("listTargets / browserVersion parse the fake endpoint", async (t) => {
    const fake = await startFakeCdp(spec());
    t.after(() => fake.close());
    const targets = await listTargets(fake.endpoint);
    assert.equal(targets.length, 2);
    assert.equal(targets[1]!.title, "ws-a");
    assert.ok(targets[0]!.webSocketDebuggerUrl?.startsWith("ws://127.0.0.1:"));
    assert.match((await browserVersion(fake.endpoint)).Browser, /^Chrome\//);
    await assert.rejects(listTargets("127.0.0.1:1", { timeoutMs: 500 }));
  });

  it("connect + enableRuntime collects contexts and drops destroyed/cleared", async (t) => {
    const fake = await startFakeCdp(spec());
    t.after(() => fake.close());
    const s = await CdpSession.connect((await listTargets(fake.endpoint))[0]!);
    t.after(() => s.close());
    await s.enableRuntime();
    assert.deepEqual(s.contexts().map((c) => c.id), [1, 2]);
    fake.emit("chat", "Runtime.executionContextDestroyed", { executionContextId: 1 });
    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(s.contexts().map((c) => c.id), [2]);
    fake.emit("chat", "Runtime.executionContextsCleared", {});
    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(s.contexts(), []);
  });

  it("evaluate returns value, passes params, throws on exceptionDetails and CDP error", async (t) => {
    const fake = await startFakeCdp(
      spec({
        handler: (method, params) => {
          if (method !== "Runtime.evaluate") return {};
          if (params.expression === "boom") return { exceptionDetails: { text: "Uncaught", exception: { description: "ReferenceError: boom" } } };
          if (params.expression === "cdperr") return { __error: "bad ctx" };
          return { result: { value: `v:${params.expression}:${params.contextId}` } };
        },
      }),
    );
    t.after(() => fake.close());
    const s = await CdpSession.connect((await listTargets(fake.endpoint))[0]!);
    t.after(() => s.close());
    assert.equal(await s.evaluate("a", 2), "v:a:2");
    const call = fake.calls.find((c) => c.method === "Runtime.evaluate")!;
    assert.equal(call.params.returnByValue, true);
    assert.equal(call.params.awaitPromise, true);
    await assert.rejects(s.evaluate("boom"), /ReferenceError: boom/);
    await assert.rejects(s.evaluate("cdperr"), /bad ctx/);
  });

  it("evaluateEach runs across every context and captures per-context errors", async (t) => {
    const fake = await startFakeCdp(
      spec({
        handler: (method, params, ctx) => {
          if (ctx === 2) return { exceptionDetails: { text: "nope" } };
          return { result: { value: `ctx${ctx}` } };
        },
      }),
    );
    t.after(() => fake.close());
    const s = await CdpSession.connect((await listTargets(fake.endpoint))[0]!);
    t.after(() => s.close());
    await s.enableRuntime();
    const got = await s.evaluateEach<string>("x");
    assert.equal(got.length, 2);
    assert.deepEqual(got[0], { contextId: 1, name: "", value: "ctx1" });
    assert.equal(got[1]!.contextId, 2);
    assert.equal(got[1]!.name, "inner");
    assert.match(got[1]!.error ?? "", /nope/);
  });

  it("insertText and pressEnter send the exact Input.* params", async (t) => {
    const fake = await startFakeCdp(spec());
    t.after(() => fake.close());
    const s = await CdpSession.connect((await listTargets(fake.endpoint))[0]!);
    t.after(() => s.close());
    await s.insertText("hello");
    await s.pressEnter();
    const input = fake.calls.filter((c) => c.method.startsWith("Input."));
    assert.deepEqual(input.map((c) => c.method), ["Input.insertText", "Input.dispatchKeyEvent", "Input.dispatchKeyEvent"]);
    assert.deepEqual(input[0]!.params, { text: "hello" });
    assert.deepEqual(input[1]!.params, { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: "\r" });
    assert.deepEqual(input[2]!.params, { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
  });

  it("send rejects on per-call timeout", async (t) => {
    const fake = await startFakeCdp(spec({ handler: () => NO_REPLY }));
    t.after(() => fake.close());
    const s = await CdpSession.connect((await listTargets(fake.endpoint))[0]!);
    t.after(() => s.close());
    await assert.rejects(s.send("Foo.bar", {}, 100), /timed out/);
  });

  it("connect rejects when the target has no webSocketDebuggerUrl", async () => {
    await assert.rejects(CdpSession.connect({ id: "x", type: "page", url: "u" }), /webSocketDebuggerUrl/);
  });

  it("endpointFrom", () => {
    assert.equal(endpointFrom(undefined, 9222), "127.0.0.1:9222");
    assert.equal(endpointFrom("", 9333), "127.0.0.1:9333");
    assert.equal(endpointFrom("10.0.0.5:9400", 9222), "10.0.0.5:9400");
    assert.equal(endpointFrom("myhost", 9222), "myhost:9222");
    assert.equal(endpointFrom("[::1]:9222", 1), "[::1]:9222");
  });

  it("isLoopbackHost", () => {
    for (const h of ["127.0.0.1", "127.5.6.7", "::1", "[::1]", "localhost", "LOCALHOST"]) assert.equal(isLoopbackHost(h), true, h);
    for (const h of ["10.0.0.1", "example.com", "128.0.0.1", "0.0.0.0"]) assert.equal(isLoopbackHost(h), false, h);
  });

  it("expression builders", () => {
    assert.equal(KIRO_IDE_SELECTORS.chatInput, ".chat-input-content");
    assert.ok(!DEEP_TEXT_JS.includes("slice(0, 3000)"));
    const js = clickByTextJs('Skip "All"');
    assert.ok(js.includes(JSON.stringify('Skip "All"')));
    assert.ok(js.includes("'clicked'") && js.includes("'none'"));
    assert.doesNotThrow(() => new Function(`return ${js}`));
    assert.doesNotThrow(() => new Function(`return ${DEEP_TEXT_JS}`));
  });
});
