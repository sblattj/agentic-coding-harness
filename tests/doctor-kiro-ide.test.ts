import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { checkKiroIde } from "../src/cli/doctor.ts";
import { startFakeCdp, type FakeCdp, type FakeTargetSpec } from "./fake-cdp.ts";

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

function chat(hasInput: boolean): FakeTargetSpec {
  return {
    id: "chat",
    type: "iframe",
    url: CHAT,
    contexts: ctxs,
    // Only context 2 carries the input, like the real IDE.
    handler: (method, _p, contextId) =>
      method === "Runtime.evaluate" ? { result: { type: "boolean", value: hasInput && contextId === 2 } } : {},
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
  });

  it("signed-out text fails signed-in with a sign-in hint", async () => {
    const f = await fake([page("Sign in | By signing in, you agree to the | AWS Customer Agreement"), chat(true)]);
    const rows = await run(f.endpoint);
    const r = row(rows, "signed-in")!;
    assert.equal(r.status, "failed");
    assert.match(r.hint!, /sign in once for this profile/);
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
