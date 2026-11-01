import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { checkKiroIde } from "../src/cli/doctor.ts";
import { HISTORY_VIEW_JS, READ_MODEL_JS } from "../src/adapters/kiro-ide-cdp.ts";
import { FakeModelPicker, startFakeCdp, type FakeCdp, type FakeTargetSpec } from "./fake-cdp.ts";

// checkKiroIde against a fake CDP endpoint; the binary row uses a script in a tmp dir.

const WORKBENCH = "vscode-file://vscode-app/Applications/Kiro.app/Contents/Resources/app/out/vs/code/electron-browser/workbench/workbench.html";
const CHAT = "vscode-webview://abc/index.html?id=1&extensionId=kiro.kiroAgent&purpose=webviewView";
const ctxs = [
  { id: 1, name: "", origin: "x" },
  { id: 2, name: "Electron Isolated Context", origin: "x" },
];

function page(text: string): FakeTargetSpec {
  return {
    id: "page",
    type: "page",
    url: WORKBENCH,
    contexts: ctxs,
    handler: (method) => (method === "Runtime.evaluate" ? { result: { type: "string", value: text } } : {}),
  };
}

function chat(hasInput: boolean, picker: FakeModelPicker | null = new FakeModelPicker()): FakeTargetSpec {
  return {
    id: "chat",
    type: "iframe",
    url: CHAT,
    contexts: ctxs,
    // Only context 2 carries the input and the picker, like the real IDE.
    handler: (method, p, contextId) => {
      if (method !== "Runtime.evaluate") return {};
      const picked = picker && hasInput && contextId === 2 ? picker.evaluate(p.expression) : { handled: false };
      if (picked.handled) return { result: { type: "object", value: picked.value } };
      return { result: { type: "boolean", value: hasInput && contextId === 2 } };
    },
  };
}

/**
 * A chat target with a scripted body text: `historyView` makes it the Session History view (no input);
 * otherwise it has the input, and `picker` (null = absent) serves the model picker.
 */
function chatWith(body: string, opts: { historyView?: boolean; picker?: FakeModelPicker | null; hasInput?: boolean } = {}): FakeTargetSpec & { evals: string[] } {
  const evals: string[] = [];
  const hasInput = opts.hasInput ?? !opts.historyView;
  const picker = opts.picker === undefined ? new FakeModelPicker() : opts.picker;
  return {
    id: "chat",
    type: "iframe",
    url: CHAT,
    contexts: ctxs,
    evals,
    handler: (method, p, contextId) => {
      if (method !== "Runtime.evaluate") return {};
      evals.push(p.expression);
      if (contextId !== 2) return { result: { type: "boolean", value: false } };
      if (p.expression === HISTORY_VIEW_JS) return { result: { type: "boolean", value: !!opts.historyView } };
      if (p.expression === "document.body.innerText") return { result: { type: "string", value: body } };
      const picked = picker && hasInput ? picker.evaluate(p.expression) : { handled: false };
      if (picked.handled) return { result: { type: "object", value: picked.value } };
      return { result: { type: "boolean", value: hasInput } };
    },
  };
}

const SIGNED_IN = "Explorer | Kiro Free 0 / 50 updated just now";

let tmp: string;
let bin: string;
const open: FakeCdp[] = [];

before(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ach-doctor-kiro-ide-"));
  bin = path.join(tmp, "Kiro");
  await fs.writeFile(bin, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
});

after(async () => {
  await Promise.all(open.map((f) => f.close()));
  await fs.rm(tmp, { recursive: true, force: true });
});

async function fake(targets: FakeTargetSpec[]): Promise<FakeCdp> {
  const f = await startFakeCdp({ targets });
  open.push(f);
  return f;
}

function run(endpoint: string, extra: { bin?: string } = {}) {
  return checkKiroIde({ env: { PATH: "" }, cwd: tmp, endpoint, bin: extra.bin ?? bin, platform: "darwin", fetchTimeoutMs: 2000 });
}

const row = (rows: Awaited<ReturnType<typeof run>>, name: string) => rows.find((r) => r.name === name);

describe("checkKiroIde", () => {
  it("waits for a chat input frame whose context is created late", async () => {
    // Kiro IDE 1.4.62: the input's nested frame context arrives a few hundred ms after Runtime.enable.
    const lateChat: FakeTargetSpec = {
      id: "chat",
      type: "iframe",
      url: CHAT,
      contexts: [ctxs[0]!],
      lateContexts: { afterMs: 150, contexts: [{ id: 3, name: "", origin: "x" }] },
      handler: (method, _p, contextId) =>
        method === "Runtime.evaluate" ? { result: { type: "boolean", value: contextId === 3 } } : {},
    };
    const f = await fake([page(SIGNED_IN), lateChat]);
    assert.equal(row(await run(f.endpoint), "chat")?.status, "verified");
  });

  it("all green: binary, cdp, signed-in, chat verified", async () => {
    const f = await fake([page(SIGNED_IN), chat(true)]);
    const rows = await run(f.endpoint);
    assert.deepEqual(rows.map((r) => [r.name, r.status]), [
      ["binary", "verified"],
      ["cdp", "verified"],
      ["signed-in", "verified"],
      ["chat", "verified"],
      ["model", "verified"],
    ]);
    assert.ok(rows.every((r) => r.agent === "kiro-ide"));
    assert.match(row(rows, "cdp")!.detail, /Kiro\/1\.2\.4/);
    assert.match(row(rows, "signed-in")!.detail, /Kiro Free/);
  });

  it("unreachable CDP fails with a launch hint and skips signed-in/chat", async () => {
    const f = await fake([]);
    const endpoint = f.endpoint;
    await f.close();
    open.splice(open.indexOf(f), 1);
    const rows = await run(endpoint);
    assert.equal(row(rows, "cdp")!.status, "failed");
    assert.match(row(rows, "cdp")!.hint!, /--remote-debugging-port=9222/);
    assert.match(row(rows, "cdp")!.hint!, /ach run --agent kiro-ide/);
    assert.equal(row(rows, "signed-in")!.status, "unproven");
    assert.match(row(rows, "signed-in")!.detail, /not attempted/);
    assert.equal(row(rows, "chat")!.status, "unproven");
    assert.equal(row(rows, "model")!.status, "unproven");
    assert.match(row(rows, "model")!.detail, /not attempted/);
  });

  it("signed-out text fails signed-in with a sign-in hint", async () => {
    const f = await fake([page("Sign in | By signing in, you agree to the | AWS Customer Agreement"), chat(true)]);
    const rows = await run(f.endpoint);
    const r = row(rows, "signed-in")!;
    assert.equal(r.status, "failed");
    assert.match(r.hint!, /sign in once for this profile/);
  });

  // Found live on Kiro 1.2.4: the sign-in screen keeps a chat input but has no model picker.
  it("signed-out: model row is not reported as selector drift, even with no picker", async () => {
    const f = await fake([page("Sign in | By signing in, you agree to the"), chat(true, null)]);
    const rows = await run(f.endpoint);
    assert.equal(row(rows, "chat")!.status, "verified");
    assert.equal(row(rows, "model")!.status, "unproven");
    assert.equal(row(rows, "model")!.detail, "not attempted: Kiro is signed out");
    assert.equal(rows.filter((r) => r.status === "failed").map((r) => r.name).join(), "signed-in");
  });

  it("signed-out: a missing chat input is not reported as selector drift", async () => {
    const f = await fake([page("Sign in | By signing in, you agree to the"), chat(false)]);
    const rows = await run(f.endpoint);
    assert.equal(row(rows, "chat")!.status, "unproven");
    assert.equal(row(rows, "chat")!.detail, "not attempted: Kiro is signed out");
    assert.equal(row(rows, "model")!.status, "unproven");
    assert.equal(rows.filter((r) => r.status === "failed").map((r) => r.name).join(), "signed-in");
  });

  it("onboarding screen adds a warning row but is not a failure", async () => {
    const f = await fake([page(`${SIGNED_IN} | Import configuration | Next | Skip All`), chat(true)]);
    const rows = await run(f.endpoint);
    assert.equal(row(rows, "signed-in")!.status, "verified");
    assert.equal(row(rows, "onboarding")!.status, "unproven");
    assert.match(row(rows, "onboarding")!.detail, /dismisses/);
    assert.ok(rows.every((r) => r.status !== "failed"));
  });

  it("chat target without the input fails loudly (selector drift)", async () => {
    const f = await fake([page(SIGNED_IN), chat(false)]);
    const rows = await run(f.endpoint);
    const r = row(rows, "chat")!;
    assert.equal(r.status, "failed");
    assert.match(r.detail, /selectors no longer match this Kiro IDE version/);
    assert.ok(r.hint);
  });

  // Issue #160: the model row reads the picker label and never opens the popup.
  it("model row: verified with the label the picker shows, popup never opened", async () => {
    const picker = new FakeModelPicker({ label: "Claude Sonnet 5.5" });
    const f = await fake([page(SIGNED_IN), chat(true, picker)]);
    const r = row(await run(f.endpoint), "model")!;
    assert.equal(r.status, "verified");
    assert.equal(r.detail, "picker shows 'Claude Sonnet 5.5'");
    assert.equal(r.agent, "kiro-ide");
    assert.equal(picker.toggles, 0, "doctor must not open the popup");
    assert.equal(picker.open, false);
    // control: the label changes with the IDE state
    picker.label = "Auto";
    assert.equal(row(await run(f.endpoint), "model")!.detail, "picker shows 'Auto'");
  });

  it("model row: chat input present but no picker fails with a selectors-no-longer-match message", async () => {
    const picker = new FakeModelPicker();
    picker.present = false;
    const f = await fake([page(SIGNED_IN), chat(true, picker)]);
    const rows = await run(f.endpoint);
    const r = row(rows, "model")!;
    assert.equal(r.status, "failed");
    assert.match(r.detail, /selectors no longer match this Kiro IDE version/);
    assert.ok(r.hint);
    assert.equal(row(rows, "chat")!.status, "verified");
  });

  it("model row: unproven (not failed) when evaluating the label throws in every context", async () => {
    const picker = new FakeModelPicker();
    const f = await fake([
      page(SIGNED_IN),
      {
        id: "chat",
        type: "iframe",
        url: CHAT,
        contexts: ctxs,
        handler: (method, p, contextId) => {
          if (method !== "Runtime.evaluate") return {};
          if (p.expression === READ_MODEL_JS) {
            return { exceptionDetails: { text: "Uncaught", exception: { description: "Execution context was destroyed" } } };
          }
          void picker;
          return { result: { type: "boolean", value: contextId === 2 } };
        },
      },
    ]);
    const rows = await run(f.endpoint);
    assert.equal(row(rows, "chat")!.status, "verified");
    const r = row(rows, "model")!;
    assert.equal(r.status, "unproven");
    assert.match(r.detail, /Execution context was destroyed/);
  });

  it("model row: unproven when the chat input is missing or there is no chat target", async () => {
    const noInput = await fake([page(SIGNED_IN), chat(false)]);
    const a = row(await run(noInput.endpoint), "model")!;
    assert.equal(a.status, "unproven");
    assert.match(a.detail, /not attempted/);
    const noChat = await fake([page(SIGNED_IN)]);
    const b = row(await run(noChat.endpoint), "model")!;
    assert.equal(b.status, "unproven");
    assert.match(b.detail, /not attempted/);
  });

  it("history view (no open session): chat and model are unproven, nothing is clicked, no drift message", async () => {
    const c = chatWith("Session History Answer Simple Trivia Questions", { historyView: true });
    const f = await fake([page(SIGNED_IN), c]);
    const rows = await run(f.endpoint);
    const chatRow = row(rows, "chat")!;
    assert.equal(chatRow.status, "unproven");
    assert.match(chatRow.detail, /Session History is showing with no open session/);
    assert.match(chatRow.detail, /ach run/);
    assert.doesNotMatch(chatRow.detail, /selectors no longer match/);
    assert.equal(chatRow.hint, undefined);
    const model = row(rows, "model")!;
    assert.equal(model.status, "unproven");
    assert.match(model.detail, /Session History is showing/);
    assert.ok(!rows.some((r) => r.status === "failed"));
    assert.ok(!c.evals.some((e) => e.includes(".click()") && !e.startsWith("(() => !document.querySelector")), "doctor evaluates probes only");
    assert.ok(!f.calls.some((x) => x.method.startsWith("Input.")));
  });

  it("control: no input and no history view stays failed selector drift", async () => {
    const f = await fake([page(SIGNED_IN), chatWith("Something else entirely", { hasInput: false })]);
    const r = row(await run(f.endpoint), "chat")!;
    assert.equal(r.status, "failed");
    assert.match(r.detail, /selectors no longer match this Kiro IDE version/);
    assert.ok(r.hint);
  });

  it("model row: no picker on an empty chat (\"Let's build\") is unproven, with a re-run hint", async () => {
    const f = await fake([page(SIGNED_IN), chatWith("New Session\nLoading\nStarting cloud session\nLet's build", { picker: null, hasInput: true })]);
    const rows = await run(f.endpoint);
    const r = row(rows, "model")!;
    assert.equal(r.status, "unproven");
    assert.match(r.detail, /not shown on this empty chat yet/);
    assert.match(r.detail, /re-run doctor/);
    assert.equal(row(rows, "chat")!.status, "verified");
  });

  it("control: no picker on a chat with content stays failed", async () => {
    const f = await fake([page(SIGNED_IN), chatWith("You: hi\nKiro: hello\nElapsed time: 3s", { picker: null, hasInput: true })]);
    const r = row(await run(f.endpoint), "model")!;
    assert.equal(r.status, "failed");
    assert.match(r.detail, /selectors no longer match this Kiro IDE version/);
  });

  it("missing binary is a failure locally", async () => {
    const f = await fake([page(SIGNED_IN), chat(true)]);
    const rows = await run(f.endpoint, { bin: path.join(tmp, "nope") });
    assert.equal(row(rows, "binary")!.status, "failed");
    assert.match(row(rows, "binary")!.hint!, /brew install --cask kiro/);
  });

  it("non-loopback endpoint warns about exposure and downgrades a missing binary to a warning", async () => {
    // Nothing listens on 192.0.2.1 (TEST-NET-1): cdp fails fast with the short timeout, which is fine here.
    const rows = await checkKiroIde({
      env: { PATH: "" },
      cwd: tmp,
      endpoint: "192.0.2.1:9222",
      bin: path.join(tmp, "nope"),
      platform: "darwin",
      fetchTimeoutMs: 300,
    });
    const exp = row(rows, "cdp-exposure")!;
    assert.equal(exp.status, "unproven");
    assert.match(exp.detail, /remote code execution/);
    assert.match(exp.hint!, /tunnel/);
    assert.equal(row(rows, "binary")!.status, "unproven");
  });

  // Issue #161: a normal browser (or another Electron app) on the Kiro port.
  const REAL_KIRO_VERSION = {
    Browser: "Chrome/152.0.7977.130",
    "User-Agent":
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Kiro/1.2.4 Chrome/152.0.7977.130 Electron/44.4.3 Safari/537.36",
  };
  const VIVALDI_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Vivaldi/7.0.3495.18";
  const CHROME_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
  const CODE_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Code/1.95.0 Chrome/128.0.6613.186 Electron/32.2.6 Safari/537.36";

  async function wrong(version: Record<string, unknown>, targets: FakeTargetSpec[] = []) {
    const f = await startFakeCdp({ targets, version });
    open.push(f);
    return { f, rows: await run(f.endpoint) };
  }

  it("real Kiro 1.2.4 strings (Browser says Chrome) pass: control", async () => {
    const f = await startFakeCdp({ targets: [page(SIGNED_IN), chat(true)], version: REAL_KIRO_VERSION });
    open.push(f);
    const rows = await run(f.endpoint);
    assert.equal(row(rows, "cdp")!.status, "verified");
    assert.match(row(rows, "cdp")!.detail, /Kiro\/1\.2\.4/);
    assert.equal(row(rows, "chat")!.status, "verified");
  });

  for (const [name, ua, product] of [
    ["Vivaldi", VIVALDI_UA, /a Vivaldi\/7\.0\.3495\.18/],
    ["plain Chrome", CHROME_UA, /a Chrome\/130\.0\.0\.0/],
    ["generic VS Code Electron app with a workbench target", CODE_UA, /a Electron app \(Electron\/32\.2\.6\)/],
  ] as const) {
    it(`${name} on the port fails the cdp row and skips signed-in/chat`, async () => {
      const { f, rows } = await wrong({ Browser: "Chrome/130.0.0.0", "User-Agent": ua }, [page(SIGNED_IN), chat(true)]);
      const cdp = row(rows, "cdp")!;
      assert.equal(cdp.status, "failed");
      assert.match(cdp.detail, new RegExp(`^port ${f.endpoint.split(":")[1]} is ${product.source}, not Kiro IDE; pass --kiro-ide-port$`));
      assert.match(cdp.hint!, /--kiro-ide-port <N>/);
      assert.equal(row(rows, "signed-in")!.status, "unproven");
      assert.match(row(rows, "signed-in")!.detail, /not attempted: endpoint is not Kiro IDE/);
      assert.equal(row(rows, "chat")!.status, "unproven");
      assert.ok(!rows.some((r) => r.status === "verified" && (r.name === "signed-in" || r.name === "chat")));
      assert.equal(f.calls.length, 0, "no CDP command reached the endpoint");
    });
  }

  it("missing User-Agent falls back to a workbench page target and passes", async () => {
    const { rows } = await wrong({ Browser: "Chrome/152.0.7977.130" }, [page(SIGNED_IN), chat(true)]);
    assert.equal(row(rows, "cdp")!.status, "verified");
    assert.equal(row(rows, "chat")!.status, "verified");
  });

  it("missing User-Agent and no workbench target fails, naming the Browser field", async () => {
    const { rows } = await wrong({ Browser: "Chrome/152.0.7977.130" });
    assert.equal(row(rows, "cdp")!.status, "failed");
    assert.match(row(rows, "cdp")!.detail, /is a Chrome\/152\.0\.7977\.130, not Kiro IDE; pass --kiro-ide-port/);
  });
});
