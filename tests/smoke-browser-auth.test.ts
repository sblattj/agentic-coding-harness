// browser-auth (#139): prompt detection, device-code fallback, and the CDP
// handler against a FAKE browser (tests/support/fake-login-pages.ts). Never the
// user's real browser, never a real identity provider.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  POLICY_BLOCK_RE,
  SUCCESS_RE,
  createBrowserAuthHandler,
  defaultLoginScript,
  detectAuthPrompt,
  deviceCodeFallback,
  normalizeEndpoint,
  parseAuthJs,
  authJs,
} from "../src/core/smoke/browser-auth.ts";
import { startFakeBrowser } from "./support/fake-login-pages.ts";

describe("detectAuthPrompt", () => {
  const cases: Array<[string, string, ReturnType<typeof detectAuthPrompt>]> = [
    [
      "az",
      "To sign in, use a web browser to open the page https://microsoft.com/devicelogin and enter the code ABCD-EFGH to authenticate.",
      { kind: "device-code", url: "https://microsoft.com/devicelogin", userCode: "ABCD-EFGH" },
    ],
    [
      "az 9-char code",
      "To sign in, use a web browser to open the page https://microsoft.com/devicelogin and enter the code F7KQ2LMNP to authenticate.",
      { kind: "device-code", url: "https://microsoft.com/devicelogin", userCode: "F7KQ2LMNP" },
    ],
    [
      "gh",
      "! First copy your one-time code: 1A2B-3C4D\nPress Enter to open https://github.com/login/device in your browser...",
      { kind: "device-code", url: "https://github.com/login/device", userCode: "1A2B-3C4D" },
    ],
    [
      "aws sso",
      "Attempting to automatically open the SSO authorization page in your default browser.\nIf the browser does not open, open the following URL:\n\nhttps://device.sso.us-east-1.amazonaws.com/\n\nThen enter the code:\n\nWXYZ-1234\n",
      { kind: "device-code", url: "https://device.sso.us-east-1.amazonaws.com/", userCode: "WXYZ-1234" },
    ],
    [
      "aws sso user_code url",
      "Open https://device.sso.us-east-1.amazonaws.com/?user_code=QRST-5678 to continue",
      { kind: "device-code", url: "https://device.sso.us-east-1.amazonaws.com/?user_code=QRST-5678", userCode: "QRST-5678" },
    ],
    [
      "gcloud",
      "Go to the following link in your browser:\n\n    https://accounts.google.com/o/oauth2/auth?response_type=code&client_id=32555940559.apps.googleusercontent.com&redirect_uri=http%3A%2F%2Flocalhost%3A8085%2F&scope=openid\n",
      {
        kind: "browser",
        url: "https://accounts.google.com/o/oauth2/auth?response_type=code&client_id=32555940559.apps.googleusercontent.com&redirect_uri=http%3A%2F%2Flocalhost%3A8085%2F&scope=openid",
      },
    ],
    [
      "entra authorize",
      "Opening https://login.microsoftonline.com/common/oauth2/v2.0/authorize?client_id=abc&scope=x.",
      { kind: "browser", url: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize?client_id=abc&scope=x" },
    ],
    ["docs link", "See https://docs.github.com/en/authentication/keeping-your-account-and-data-secure for details.", null],
    ["npm registry", "npm notice https://registry.npmjs.org/@scope/pkg/-/pkg-1.0.0.tgz", null],
    ["login page without query", "Visit https://example.com/login to manage your account", null],
    ["no url", "Logged in as octocat", null],
  ];
  for (const [name, text, want] of cases) {
    it(name, () => assert.deepEqual(detectAuthPrompt(text), want));
  }
});

describe("deviceCodeFallback", () => {
  const cases: Array<[string, string | null]> = [
    ["az login --use-device-code", "az login"],
    ["az login --tenant t1 --use-device-code --allow-no-subscriptions", "az login --tenant t1 --allow-no-subscriptions"],
    ["gcloud auth login --no-launch-browser", "gcloud auth login"],
    ["gcloud auth login --no-browser", "gcloud auth login"],
    ["aws sso login --use-device-code --profile dev", "aws sso login --profile dev"],
    ["databricks auth login --device-code", "databricks auth login"],
    ["tool login --device", "tool login"],
    ["pac auth create --use-device-flow=true", "pac auth create"],
    ["gh auth login --web", null],
    ["tool login --device-id 7", null],
    ["az login", null],
  ];
  for (const [cmd, want] of cases) {
    it(cmd, () => assert.equal(deviceCodeFallback(cmd), want));
  }
});

describe("page regexes and helpers", () => {
  it("policy block", () => {
    for (const s of [
      "AADSTS53003: Access has been blocked by Conditional Access policies.",
      "AADSTS50199: For security reasons, user confirmation is required",
      "Device code flow is blocked by your organization",
      "This sign-in was blocked by an administrator",
    ])
      assert.ok(POLICY_BLOCK_RE.test(s), s);
    assert.ok(!POLICY_BLOCK_RE.test("Enter the code displayed on your device"));
  });
  it("success", () => {
    for (const s of [
      "You have signed in to the Microsoft Azure Cross-platform Command Line Interface application on your device. You may now close this window.",
      "Congratulations, you're all set!",
      "Your device is now connected.",
      "Authentication complete.",
    ])
      assert.ok(SUCCESS_RE.test(s), s);
    assert.ok(!SUCCESS_RE.test("Sign in to continue"));
  });
  it("endpoint normalization", () => {
    assert.equal(normalizeEndpoint("http://127.0.0.1:9333/"), "127.0.0.1:9333");
    assert.equal(normalizeEndpoint("127.0.0.1:9333"), "127.0.0.1:9333");
  });
  it("injected JS round-trips its marker", () => {
    assert.deepEqual(parseAuthJs(authJs.clickAccount("a@example.com")), { op: "click-account", args: "a@example.com" });
    assert.deepEqual(parseAuthJs(authJs.snapshot()), { op: "snapshot", args: null });
  });
  it("login script is one pasteable line, single-quoted", () => {
    const s = defaultLoginScript({ stepIndex: 1, kind: "browser", url: "https://x/y?a=1&b=$HOME", account: "a@example.com", command: "az login --tenant 'it''s'" });
    assert.ok(!s.includes("\n"));
    assert.equal(s, `printf '%s\\n' 'Sign in to a@example.com in your browser, then run:' 'az login --tenant '\\''it'\\'''\\''s'\\'''`);
    const s2 = defaultLoginScript({ stepIndex: 1, kind: "browser", url: "https://x/y?a=$HOME" });
    assert.equal(s2, `printf '%s\\n' 'Sign in to the right account in your browser, then run:' 'open '\\''https://x/y?a=$HOME'\\'''`);
  });
});

describe("createBrowserAuthHandler (fake CDP browser)", () => {
  const base = "https://login.example.com";
  const run = async (fb: Awaited<ReturnType<typeof startFakeBrowser>>, req: Partial<Parameters<ReturnType<typeof createBrowserAuthHandler>>[0]>, timeoutMs = 5000) => {
    const handler = createBrowserAuthHandler({ endpoint: `http://${fb.endpoint}`, timeoutMs, pollMs: 10 });
    return handler({ stepIndex: 1, kind: "browser", url: `${base}/chooser`, ...req } as any);
  };
  const userTabUntouched = (fb: Awaited<ReturnType<typeof startFakeBrowser>>) =>
    assert.equal(fb.cdp.calls.filter((c) => c.targetId === "user-tab").length, 0, "user's tab must never be touched");

  it("right account: clicks its tile, then Continue -> completed", async () => {
    const fb = await startFakeBrowser();
    try {
      const o = await run(fb, { account: "A@example.com" });
      assert.equal(o.status, "completed", o.detail);
      assert.deepEqual(
        fb.clicks().map((c) => [c.op, c.page]),
        [
          ["click-account", "/chooser"],
          ["click-approve", "/consent-a"],
        ],
      );
      assert.deepEqual(fb.ops.find((x) => x.op === "click-account")?.args, "a@example.com");
      assert.ok(o.seenAccounts.includes("a@example.com") && o.seenAccounts.includes("b@example.com"));
      assert.equal(fb.createCalls(), 1);
      assert.deepEqual(fb.closeCalls(), [{ targetId: "auth-tab" }]);
      userTabUntouched(fb);
    } finally {
      await fb.close();
    }
  });

  it("wrong account: wrong-account, loginScript, and NO click", async () => {
    const fb = await startFakeBrowser();
    try {
      const o = await run(fb, { account: "c@example.com", command: "az login" } as any);
      assert.equal(o.status, "wrong-account");
      assert.deepEqual(o.seenAccounts.sort(), ["a@example.com", "b@example.com"]);
      assert.equal(o.loginScript, `printf '%s\\n' 'Sign in to c@example.com in your browser, then run:' 'az login'`);
      assert.deepEqual(fb.clicks(), [], "no click of any kind");
      assert.equal(fb.current(), "/chooser");
      assert.deepEqual(fb.closeCalls(), [{ targetId: "auth-tab" }]);
      userTabUntouched(fb);
    } finally {
      await fb.close();
    }
  });

  it("account unknown + accounts visible: needs-human, no click", async () => {
    const fb = await startFakeBrowser();
    try {
      const o = await run(fb, {});
      assert.equal(o.status, "needs-human");
      assert.match(o.detail, /a@example\.com, b@example\.com/);
      assert.ok(o.loginScript);
      assert.deepEqual(fb.clicks(), []);
      assert.deepEqual(fb.closeCalls(), [{ targetId: "auth-tab" }]);
    } finally {
      await fb.close();
    }
  });

  it("plain sign-in form: needs-human (never types a password)", async () => {
    const fb = await startFakeBrowser();
    try {
      const o = await run(fb, { url: `${base}/signin`, account: "a@example.com" });
      assert.equal(o.status, "needs-human");
      assert.match(o.detail, /sign-in form/);
      assert.deepEqual(fb.clicks(), []);
      assert.deepEqual(fb.closeCalls(), [{ targetId: "auth-tab" }]);
    } finally {
      await fb.close();
    }
  });

  it("device code: fills the code, picks the account, approves -> completed", async () => {
    const fb = await startFakeBrowser();
    try {
      const o = await run(fb, { kind: "device-code", url: `${base}/device`, userCode: "ABCD-EFGH", account: "a@example.com" });
      assert.equal(o.status, "completed", o.detail);
      assert.deepEqual(
        fb.clicks().map((c) => [c.op, c.args]),
        [
          ["fill-code", "ABCD-EFGH"],
          ["click-account", "a@example.com"],
          ["click-approve", ["Continue", "Authorize", "Allow", "Accept", "Yes", "Next", "Confirm", "Sign in"]],
        ],
      );
      assert.deepEqual(fb.closeCalls(), [{ targetId: "auth-tab" }]);
    } finally {
      await fb.close();
    }
  });

  it("policy-blocked page: policy-blocked with browser fallback, quoting the line", async () => {
    const fb = await startFakeBrowser();
    try {
      const o = await run(fb, { kind: "device-code", url: `${base}/policy`, userCode: "ABCD-EFGH", account: "a@example.com" });
      assert.equal(o.status, "policy-blocked");
      assert.equal(o.fallback, "browser");
      assert.match(o.detail, /AADSTS53003: Access has been blocked by Conditional Access policies/);
      assert.deepEqual(fb.clicks(), []);
      assert.deepEqual(fb.closeCalls(), [{ targetId: "auth-tab" }]);
    } finally {
      await fb.close();
    }
  });

  it("Electron endpoint is refused before any tab is created", async () => {
    const fb = await startFakeBrowser({ version: { Browser: "Chrome/138.0", "User-Agent": "Mozilla/5.0 Kiro/1.2.4 Chrome/138.0 Electron/37.2.0 Safari/537.36" } });
    try {
      const o = await run(fb, { account: "a@example.com" });
      assert.equal(o.status, "failed");
      assert.match(o.detail, /Electron/);
      assert.equal(fb.createCalls(), 0);
      assert.deepEqual(fb.closeCalls(), []);
      assert.equal(fb.ops.length, 0);
    } finally {
      await fb.close();
    }
  });

  it("page that never settles: returns within the budget and closes the tab", async () => {
    const fb = await startFakeBrowser();
    try {
      const t0 = Date.now();
      const o = await run(fb, { url: `${base}/blank-wait`, account: "a@example.com" }, 800);
      const took = Date.now() - t0;
      assert.equal(o.status, "needs-human");
      assert.match(o.detail, /^Browser auth timed out after 800ms/);
      assert.ok(took <= 800, `took ${took}ms`);
      assert.deepEqual(fb.closeCalls(), [{ targetId: "auth-tab" }]);
    } finally {
      await fb.close();
    }
  });

  it("hung page (Runtime.evaluate never answers): returns within the budget and closes the tab", async () => {
    const fb = await startFakeBrowser({ hangEvaluate: true });
    try {
      const t0 = Date.now();
      const o = await run(fb, { account: "a@example.com" }, 1000);
      const took = Date.now() - t0;
      assert.equal(o.status, "needs-human");
      assert.match(o.detail, /timed out/);
      assert.ok(took <= 1000, `took ${took}ms`);
      assert.deepEqual(fb.closeCalls(), [{ targetId: "auth-tab" }]);
    } finally {
      await fb.close();
    }
  });

  it("unreachable endpoint: failed, fast", async () => {
    const handler = createBrowserAuthHandler({ endpoint: "http://127.0.0.1:1", timeoutMs: 3000 });
    const o = await handler({ stepIndex: 1, kind: "browser", url: `${base}/chooser` });
    assert.equal(o.status, "failed");
  });
});
