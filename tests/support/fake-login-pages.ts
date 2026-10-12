// Fake login pages for browser-auth tests (#139). Two consumers, one page set:
//
// 1. startFakeBrowser(): a fake CDP browser built on tests/fake-cdp.ts. Pages
//    are simulated in the page target's Runtime.evaluate handler: browser-auth
//    marks every injected expression (/*ach-auth:<op>:<args>*/), and the fake
//    answers snapshot / fill-code / click-account / click-approve from a small
//    page-state machine. Chosen over serving HTML to a real browser engine
//    because unit tests must not touch the user's browser and the repo has no
//    DOM implementation; the page-side JS itself is exercised by the live check.
// 2. startLoginServer(): the same pages as real HTML on 127.0.0.1:0, for the
//    manual live check against the user's Chrome. Its request log proves which
//    links/buttons were (not) followed.
import http from "node:http";
import type net from "node:net";
import { parseAuthJs } from "../../src/core/smoke/browser-auth.ts";
import { NO_REPLY, startFakeCdp, type FakeCdp, type FakeCdpSpec } from "../fake-cdp.ts";

export interface FakePage {
  text: string;
  /** Visible signed-in identities (chooser tiles or "signed in as"). */
  accounts?: string[];
  signInForm?: boolean;
  codeInput?: boolean;
  /** account -> next page path, for chooser tiles. */
  tiles?: Record<string, string>;
  /** button text -> next page path. */
  buttons?: Record<string, string>;
  /** next page path after a code is submitted. */
  onCode?: string;
}

export const PAGES: Record<string, FakePage> = {
  "/chooser": {
    text: "Choose an account\na@example.com\nb@example.com",
    accounts: ["a@example.com", "b@example.com"],
    tiles: { "a@example.com": "/consent-a", "b@example.com": "/consent-b" },
  },
  "/consent-a": { text: "Signed in as a@example.com\nAllow Demo App to access your account?", accounts: ["a@example.com"], buttons: { Continue: "/done" } },
  "/consent-b": { text: "Signed in as b@example.com\nAllow Demo App?", accounts: ["b@example.com"], buttons: { Continue: "/done" } },
  "/device": { text: "Enter code\nEnter the code displayed on your device", codeInput: true, onCode: "/chooser" },
  "/policy": {
    text: "Sign in\nAADSTS53003: Access has been blocked by Conditional Access policies. The access policy does not allow token issuance.",
  },
  "/done": { text: "You have signed in to Demo App. You may now close this window." },
  "/signin": { text: "Sign in\nEmail\nPassword\nSign in", signInForm: true },
  "/blank-wait": { text: "Redirecting..." },
};

export interface FakeBrowser {
  cdp: FakeCdp;
  endpoint: string;
  /** Every Runtime.evaluate op the page saw, in order. */
  ops: Array<{ op: string; args: unknown; page: string }>;
  clicks(): Array<{ op: string; args: unknown; page: string }>;
  createCalls(): number;
  closeCalls(): Array<{ targetId: string }>;
  current(): string;
  close(): Promise<void>;
}

export interface FakeBrowserOptions {
  version?: Record<string, unknown>;
  /** Page path -> page; defaults to PAGES. Navigation URL's pathname picks the page. */
  pages?: Record<string, FakePage>;
  /** Never answer Runtime.evaluate (hung page). */
  hangEvaluate?: boolean;
}

export async function startFakeBrowser(opts: FakeBrowserOptions = {}): Promise<FakeBrowser> {
  const pages = opts.pages ?? PAGES;
  let current = "about:blank";
  const ops: FakeBrowser["ops"] = [];
  const spec: FakeCdpSpec = {
    targets: [
      // The user's existing tab: browser-auth must never touch it.
      { id: "user-tab", type: "page", url: "https://mail.example.com/", handler: () => ({}) },
      {
        id: "browser",
        type: "browser",
        url: "",
        handler: (method, params) => {
          if (method === "Target.createTarget") {
            spec.targets.find((t) => t.id === "auth-tab")!.hidden = false;
            return { targetId: "auth-tab" };
          }
          if (method === "Target.closeTarget") {
            spec.targets.find((t) => t.id === "auth-tab")!.hidden = true;
            return { success: params?.targetId === "auth-tab" };
          }
          return {};
        },
      },
      {
        id: "auth-tab",
        type: "page",
        url: "about:blank",
        hidden: true,
        handler: (method, params) => {
          if (method === "Page.navigate") {
            current = new URL(params.url).pathname;
            return { frameId: "f1" };
          }
          if (method !== "Runtime.evaluate") return {};
          if (opts.hangEvaluate) return NO_REPLY;
          const parsed = parseAuthJs(params.expression);
          if (!parsed) return { result: { type: "undefined" } };
          ops.push({ op: parsed.op, args: parsed.args, page: current });
          const pg = pages[current];
          const value = (v: unknown) => ({ result: { type: typeof v, value: v } });
          if (parsed.op === "snapshot") {
            return value({
              url: `https://login.example.com${current}`,
              readyState: "complete",
              text: pg?.text ?? "",
              accounts: pg?.accounts ?? [],
              signInForm: !!pg?.signInForm,
              codeInput: !!pg?.codeInput,
            });
          }
          if (parsed.op === "fill-code") {
            if (!pg?.codeInput) return value("no-input");
            if (pg.onCode) current = pg.onCode;
            return value("submitted");
          }
          if (parsed.op === "click-account") {
            const next = pg?.tiles?.[String(parsed.args).toLowerCase()];
            if (!next) return value("none");
            current = next;
            return value("clicked");
          }
          if (parsed.op === "click-approve") {
            for (const t of parsed.args as string[]) {
              const next = pg?.buttons?.[t];
              if (next) {
                current = next;
                return value(t.toLowerCase());
              }
            }
            return value("none");
          }
          return value(null);
        },
      },
    ],
  };
  const cdp = await startFakeCdp(spec);
  // Learn the browser target's ws URL while it is listed, then hide it like real Chrome does.
  const list = (await (await fetch(`http://${cdp.endpoint}/json/list`)).json()) as Array<{ id: string; webSocketDebuggerUrl: string }>;
  const browserWs = list.find((t) => t.id === "browser")!.webSocketDebuggerUrl;
  spec.targets.find((t) => t.id === "browser")!.hidden = true;
  spec.version = {
    Browser: "Chrome/153.0.8010.48",
    "User-Agent": "Mozilla/5.0 (Macintosh) Chrome/153.0.0.0 Safari/537.36",
    "Protocol-Version": "1.3",
    ...opts.version,
    webSocketDebuggerUrl: browserWs,
  };
  return {
    cdp,
    endpoint: cdp.endpoint,
    ops,
    clicks: () => ops.filter((o) => o.op !== "snapshot"),
    createCalls: () => cdp.calls.filter((c) => c.method === "Target.createTarget").length,
    closeCalls: () => cdp.calls.filter((c) => c.method === "Target.closeTarget").map((c) => c.params),
    current: () => current,
    close: () => cdp.close(),
  };
}

// ---------------------------------------------------------------- real HTML (live check)

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

function html(path: string, pg: FakePage): string {
  const paras = pg.text
    .split("\n")
    .filter((l) => !(pg.tiles && l in pg.tiles))
    .map((l) => `<p>${esc(l)}</p>`)
    .join("");
  const tiles = Object.entries(pg.tiles ?? {})
    .map(([acct, next]) => `<li data-identifier="${esc(acct)}" tabindex="0" onclick="location.href='${next}'">${esc(acct)}</li>`)
    .join("");
  const buttons = Object.entries(pg.buttons ?? {})
    .map(([t, next]) => `<button type="button" onclick="location.href='${next}'">${esc(t)}</button>`)
    .join("");
  const code = pg.codeInput
    ? `<form action="${pg.onCode ?? "/done"}" method="get"><input name="otc" type="text" autocomplete="one-time-code"><button type="submit">Next</button></form>`
    : "";
  const signin = pg.signInForm ? `<form><input type="email" name="identifier"><input type="password" name="pw"><button type="button">Sign in</button></form>` : "";
  // A cross-domain link that must never be followed.
  const foreign = `<a href="https://example.org/elsewhere">Continue elsewhere</a>`;
  return `<!doctype html><html><head><title>fake ${esc(path)}</title></head><body>${paras}${tiles ? `<ul>${tiles}</ul>` : ""}${code}${signin}${buttons}${foreign}</body></html>`;
}

export interface LoginServer {
  base: string;
  requests: string[];
  close(): Promise<void>;
}

export async function startLoginServer(pages: Record<string, FakePage> = PAGES): Promise<LoginServer> {
  const requests: string[] = [];
  const server = http.createServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://x");
    if (u.pathname === "/favicon.ico") {
      res.statusCode = 404;
      return res.end();
    }
    requests.push(`${req.method} ${u.pathname}${u.search}`);
    const pg = pages[u.pathname];
    if (!pg) {
      res.statusCode = 404;
      return res.end("not found");
    }
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(html(u.pathname, pg));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as net.AddressInfo).port;
  return {
    base: `http://127.0.0.1:${port}`,
    requests,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}
