// Browser auth over CDP for `ach smoke` (#139): complete OAuth / SSO /
// device-code steps in the user's REAL browser, in a new tab, without ever
// authorizing from the wrong account.
//
// Decisions:
// - New tab via the browser-level target (GET /json/version ->
//   webSocketDebuggerUrl, then Target.createTarget {url:"about:blank",
//   background:true}), not `PUT /json/new`: we need the browser session anyway
//   to Target.closeTarget the tab in `finally`, `background` keeps the user's
//   focused tab in front, and /json/new is an HTTP side door whose verb Chrome
//   has changed before. We never reuse or navigate an existing tab. The page's
//   own ws URL comes from /json/list (CdpSession has no flattened sessions).
// - An endpoint whose /json/version says Electron is an IDE (Kiro on :9222),
//   not the user's browser: refused before any tab is created.
// - Account guard reads only what the PAGE SHOWS (emails in visible text and
//   in data-email / data-identifier / aria-label / title attributes, plus
//   GitHub's meta[name=user-login]); never cookies, storage or tokens.
//   Unknown required account + any visible account => needs-human (we cannot
//   prove it is the right one). Required account not among the visible ones
//   => wrong-account with no click. We never type passwords: a sign-in form
//   with no account => needs-human. The email-in-text rule is strict on
//   purpose: a footer address counts as "seen".
// - Per-tick order: policy-blocked -> success -> device-code fill (once) ->
//   account guard -> account tile / approve click. Policy pages carry no
//   account, so the guard must not run first.
// - A loopback URL counts as an OAuth callback only when its origin differs
//   from req.url's, or it looks like a callback (/callback, code=). Otherwise
//   a login page served from 127.0.0.1 (tests, the live check) would read as
//   success on its first load.
// - Deadline: on timeout the outcome is `needs-human` with a detail starting
//   "timed out after" and a loginScript (the runner maps it to
//   auth-needs-human). Every CDP call is capped to the remaining budget and a
//   cleanup reserve is kept so the tab close fits inside timeoutMs.
// - Killing CLI processes the step started is the runner's job; this module
//   only returns fast.
import type { AuthHandler, AuthOutcome, AuthRequest } from "./types.ts";
import { CdpSession, browserVersion, listTargets, type CdpTarget } from "../../adapters/kiro-ide-cdp.ts";

// ---------------------------------------------------------------- prompt detection

export interface DetectedAuthPrompt {
  kind: "device-code" | "browser";
  url: string;
  userCode?: string;
}

const URL_RE = /https?:\/\/[^\s"'<>`)\]]+/gi;
/** Device-code codes: XXXX-XXXX (az/gh/aws) or a 9-char az code like ABCDEFGHJ. */
const CODE_RE =
  /(?:\bcode\b[^A-Za-z0-9]{0,40}?|\benter the code\s+|one-time code:\s*)([A-Z0-9]{4}-[A-Z0-9]{4}|[A-Z0-9]{8,9})\b/;
const DEVICE_URL_RE = /devicelogin|\/login\/device|device\.sso\.|\/device\b|\/activate\b|user_code=|deviceauth/i;
const AUTH_URL_RE =
  /oauth|authorize|\/login|signin|sign-in|\bsso\b|consent|accounts\.google\.com|login\.microsoftonline\.com/i;

function trimUrl(u: string): string {
  return u.replace(/[.,;:!?]+$/, "");
}

/**
 * Finds an auth prompt in CLI output. Device-code when the text carries both a
 * device-verification URL and a user code; browser when a URL looks like an
 * OAuth/SSO page and carries a query string. Ordinary URLs -> null.
 */
export function detectAuthPrompt(text: string): DetectedAuthPrompt | null {
  const urls = (text.match(URL_RE) ?? []).map(trimUrl);
  if (urls.length === 0) return null;
  const code = CODE_RE.exec(text)?.[1];
  const deviceUrl = urls.find((u) => DEVICE_URL_RE.test(u));
  if (deviceUrl && code) return { kind: "device-code", url: deviceUrl, userCode: code };
  // A device URL whose code sits in its own query (user_code=) is still device-code.
  const queryCode = deviceUrl ? /[?&]user_code=([A-Za-z0-9-]+)/.exec(deviceUrl)?.[1] : undefined;
  if (deviceUrl && queryCode) return { kind: "device-code", url: deviceUrl, userCode: queryCode };
  const authUrl = urls.find((u) => {
    let parsed: URL;
    try {
      parsed = new URL(u);
    } catch {
      return false;
    }
    return parsed.search.length > 1 && AUTH_URL_RE.test(u);
  });
  if (authUrl) return { kind: "browser", url: authUrl };
  return null;
}

/** Flags that force a device-code / no-browser login. Longest first so prefixes do not shadow. */
export const DEVICE_CODE_FLAGS = [
  "--use-device-code",
  "--use-device-flow",
  "--no-launch-browser",
  "--device-code",
  "--no-browser",
  "--device",
] as const;

/**
 * The flow the reader will actually use when device-code is policy-blocked:
 * the same command with the device-code flags removed (the CLI then opens the
 * browser flow). Null when the command has none of the flags.
 */
export function deviceCodeFallback(command: string): string | null {
  let out = command;
  let hit = false;
  for (const flag of DEVICE_CODE_FLAGS) {
    // The flag as a whole word, optionally `=true|false|value`, bounded by whitespace / end.
    const re = new RegExp(`(^|\\s)${flag.replace(/-/g, "\\-")}(?:=\\S*)?(?=\\s|$)`, "g");
    if (re.test(out)) {
      hit = true;
      out = out.replace(re, "$1");
    }
  }
  if (!hit) return null;
  return out.replace(/[ \t]{2,}/g, " ").trim();
}

// ---------------------------------------------------------------- page-side JS

/**
 * Every injected expression starts with `/*ach-auth:<op>:<base64 json args>*\/`
 * so a fake CDP page can dispatch on it (tests/support/fake-login-pages.ts).
 */
export const AUTH_JS_MARKER = "ach-auth";

export type AuthJsOp = "snapshot" | "fill-code" | "click-account" | "click-approve";

function marked(op: AuthJsOp, args: unknown, body: string): string {
  const b64 = Buffer.from(JSON.stringify(args ?? null)).toString("base64");
  return `/*${AUTH_JS_MARKER}:${op}:${b64}*/ (${body})(${JSON.stringify(args ?? null)})`;
}

/** Decodes a marked expression (for fakes). */
export function parseAuthJs(expression: string): { op: AuthJsOp; args: any } | null {
  const m = /^\/\*ach-auth:([a-z-]+):([A-Za-z0-9+/=]*)\*\//.exec(expression);
  if (!m) return null;
  return { op: m[1] as AuthJsOp, args: JSON.parse(Buffer.from(m[2]!, "base64").toString("utf8")) };
}

const HELPERS = `
  const visible = (el) => !!(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length));
  const codeInputs = () => {
    const sel = 'input[name*=code i], input[autocomplete=one-time-code], input[name=otc], input[id*=otc i], input[name*=otp i]';
    let els = [...document.querySelectorAll(sel)].filter((e) => visible(e) && e.type !== 'hidden' && !e.disabled);
    if (!els.length) {
      const texts = [...document.querySelectorAll('input:not([type]), input[type=text], input[type=tel]')].filter((e) => visible(e) && !e.disabled);
      if (texts.length === 1) els = texts;
    }
    return els;
  };`;

/** Snapshot of what the page SHOWS. */
export interface PageSnapshot {
  url: string;
  readyState: string;
  text: string;
  accounts: string[];
  signInForm: boolean;
  codeInput: boolean;
}

const SNAPSHOT_FN = `(() => {
  ${HELPERS}
  const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}/g;
  const text = ((document.body && document.body.innerText) || '').slice(0, 20000);
  const acc = new Set();
  for (const m of text.match(EMAIL) || []) acc.add(m.toLowerCase());
  const attrs = ['data-email', 'data-identifier', 'aria-label', 'title'];
  for (const el of document.querySelectorAll('[data-email],[data-identifier],[aria-label],[title]')) {
    for (const a of attrs) { const v = el.getAttribute(a); if (v) for (const m of v.match(EMAIL) || []) acc.add(m.toLowerCase()); }
  }
  const gh = document.querySelector('meta[name="user-login"]');
  if (gh && gh.content) acc.add(gh.content.toLowerCase());
  const pw = [...document.querySelectorAll('input[type=password]')].some(visible);
  const ident = [...document.querySelectorAll('input[type=email], input[name=loginfmt], input[name=identifier], input[name=login], input[autocomplete=username]')].some(visible);
  return { url: location.href, readyState: document.readyState, text, accounts: [...acc], signInForm: pw || ident, codeInput: codeInputs().length > 0 };
})`;

const SUBMIT_RE_SRC = "^(next|continue|submit|verify)\\b";

const FILL_CODE_FN = `((code) => {
  ${HELPERS}
  const els = codeInputs();
  if (!els.length) return 'no-input';
  const setVal = (el, v) => {
    const d = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
    d && d.set ? d.set.call(el, v) : (el.value = v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };
  if (els.length > 1 && els.every((e) => e.maxLength === 1)) {
    const chars = code.replace(/[^A-Za-z0-9]/g, '').split('');
    els.forEach((e, i) => setVal(e, chars[i] || ''));
  } else setVal(els[0], code);
  const re = new RegExp(${JSON.stringify(SUBMIT_RE_SRC)}, 'i');
  const btns = [...document.querySelectorAll('button, input[type=submit], input[type=button], [role=button]')].filter(visible);
  const b = btns.find((e) => re.test(((e.innerText || e.value || e.textContent || '') + '').trim()));
  if (b) { b.click(); return 'submitted'; }
  const f = els[0].form;
  if (f) { f.requestSubmit ? f.requestSubmit() : f.submit(); return 'submitted'; }
  return 'filled';
})`;

const CLICK_ACCOUNT_FN = `((account) => {
  ${HELPERS}
  const want = account.toLowerCase();
  const clickable = (el) => el.closest('button, [role=button], [role=link], [role=option], li, [data-identifier], [data-email], [tabindex], a[href]');
  const sameOrigin = (el) => el.tagName !== 'A' || !el.href || new URL(el.href, location.href).origin === location.origin;
  for (const el of document.querySelectorAll('[data-email],[data-identifier]')) {
    const v = ((el.getAttribute('data-email') || el.getAttribute('data-identifier')) + '').toLowerCase();
    if (v === want && visible(el)) { const c = clickable(el) || el; if (!sameOrigin(c)) return 'cross-origin'; c.click(); return 'clicked'; }
  }
  let best = null;
  for (const el of document.querySelectorAll('body *')) {
    if (!visible(el) || el.children.length > 8) continue;
    const t = ((el.innerText || '') + '').toLowerCase();
    if (t.includes(want) && (!best || best.contains(el))) best = el;
  }
  if (!best) return 'none';
  const c = clickable(best);
  if (!c) return 'none';
  if (!sameOrigin(c)) return 'cross-origin';
  c.click();
  return 'clicked';
})`;

const CLICK_APPROVE_FN = `((texts) => {
  ${HELPERS}
  const wants = texts.map((t) => t.toLowerCase());
  const label = (e) => ((e.tagName === 'INPUT' ? e.value : (e.innerText || e.textContent)) || '').trim().replace(/\\s+/g, ' ').toLowerCase();
  const els = [...document.querySelectorAll('button, input[type=submit], input[type=button], [role=button]')]
    .filter((e) => visible(e) && !e.disabled && e.getAttribute('aria-disabled') !== 'true')
    .filter((e) => e.tagName !== 'A' || !e.href || new URL(e.href, location.href).origin === location.origin);
  for (const w of wants) {
    const hit = els.find((e) => { const l = label(e); return l === w || l.startsWith(w + ' '); });
    if (hit) { hit.click(); return label(hit); }
  }
  return 'none';
})`;

export const authJs = {
  snapshot: (): string => marked("snapshot", null, SNAPSHOT_FN),
  fillCode: (code: string): string => marked("fill-code", code, FILL_CODE_FN),
  clickAccount: (account: string): string => marked("click-account", account, CLICK_ACCOUNT_FN),
  clickApprove: (texts: string[]): string => marked("click-approve", texts, CLICK_APPROVE_FN),
};

// ---------------------------------------------------------------- page classification

export const POLICY_BLOCK_RE =
  /AADSTS53003|AADSTS50199|AADSTS530033|conditional access|blocked by (your|an) (organization|administrator|admin)|device (code )?(flow|login) (is )?(blocked|disabled|not allowed)|access has been blocked/i;

export const SUCCESS_RE =
  /you have signed in|signed in successfully|authentication (complete|successful)|you (may|can) (now )?close (this|the) (window|tab)|successfully (authenticated|logged in)|congratulations, you're all set|device (is )?(now )?(connected|authorized)/i;

export const DEFAULT_APPROVE_TEXTS = ["Continue", "Authorize", "Allow", "Accept", "Yes", "Next", "Confirm", "Sign in"];

function matchedLine(text: string, re: RegExp): string {
  const line = text.split(/\r?\n/).find((l) => re.test(l)) ?? re.exec(text)?.[0] ?? "";
  return line.trim().slice(0, 200);
}

function isLoopbackCallback(url: string, startUrl: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (!/^https?:$/.test(u.protocol)) return false;
  if (!/^(localhost|127\.\d+\.\d+\.\d+|\[::1\])$/.test(u.hostname)) return false;
  let startOrigin = "";
  try {
    startOrigin = new URL(startUrl).origin;
  } catch {}
  return u.origin !== startOrigin || /\/callback\b|[?&]code=/.test(u.pathname + u.search);
}

// ---------------------------------------------------------------- login script

function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** One pasteable line: tells the user which account to sign in to, then the command to rerun. */
export function defaultLoginScript(req: AuthRequest & { command?: string }): string {
  const who = req.account ?? "the right account";
  const then = req.command ?? `open ${shq(req.url)}`;
  return `printf '%s\\n' ${shq(`Sign in to ${who} in your browser, then run:`)} ${shq(then)}`;
}

// ---------------------------------------------------------------- handler

export interface BrowserAuthOptions {
  /** CDP endpoint of the user's real browser; default $CDP_BASE or http://127.0.0.1:9333. */
  endpoint?: string;
  /** Whole-request budget, cleanup included; default 180000. */
  timeoutMs?: number;
  /** Visible button texts that approve a consent/continue screen. */
  approveTexts?: string[];
  loginScriptFor?: (req: AuthRequest & { command?: string }) => string;
  log?: (line: string) => void;
  /** Poll interval between page snapshots; default 400. */
  pollMs?: number;
}

/** host:port form expected by listTargets/browserVersion. */
export function normalizeEndpoint(endpoint: string): string {
  return endpoint.trim().replace(/^(https?|wss?):\/\//i, "").replace(/\/+$/, "");
}

class Deadline extends Error {}

export function createBrowserAuthHandler(opts: BrowserAuthOptions = {}): AuthHandler {
  const endpoint = normalizeEndpoint(opts.endpoint ?? process.env.CDP_BASE ?? "http://127.0.0.1:9333");
  const timeoutMs = opts.timeoutMs ?? 180_000;
  const approveTexts = opts.approveTexts ?? DEFAULT_APPROVE_TEXTS;
  const pollMs = opts.pollMs ?? 400;
  const log = opts.log ?? (() => {});
  const loginScriptFor = opts.loginScriptFor ?? defaultLoginScript;

  return async (req: AuthRequest & { command?: string }): Promise<AuthOutcome> => {
    const started = Date.now();
    const reserve = Math.min(3000, Math.floor(timeoutMs / 4));
    const workEnd = started + timeoutMs - reserve;
    const left = () => workEnd - Date.now();
    const cap = (ms: number) => {
      const l = left();
      if (l <= 0) throw new Deadline();
      return Math.max(1, Math.min(ms, l));
    };
    const seen = new Set<string>();
    const out = (o: Omit<AuthOutcome, "seenAccounts">): AuthOutcome => ({ ...o, seenAccounts: [...seen] });
    const human = (detail: string, status: AuthOutcome["status"] = "needs-human"): AuthOutcome =>
      out({ status, detail, loginScript: loginScriptFor(req) });

    // Held in an object so the finally block sees what the (possibly still running) work set.
    const tab: { browser?: CdpSession; page?: CdpSession; targetId?: string; aborted: boolean } = { aborted: false };

    const work = async (): Promise<AuthOutcome> => {
      // a. Refuse IDEs; open a new tab via the browser target.
      const ver = await browserVersion(endpoint, { timeoutMs: cap(5000) });
      const ident = `${ver?.Browser ?? ""} ${ver?.["User-Agent"] ?? ""}`;
      if (/electron/i.test(ident)) {
        return out({
          status: "failed",
          detail: `CDP endpoint ${endpoint} is an Electron app (${ident.trim().slice(0, 120)}), not the user's browser; refusing to authenticate there.`,
        });
      }
      if (!ver?.webSocketDebuggerUrl) return out({ status: "failed", detail: `CDP endpoint ${endpoint} exposes no browser target.` });
      const browser = await CdpSession.connect(
        { id: "browser", type: "browser", url: "", webSocketDebuggerUrl: ver.webSocketDebuggerUrl },
        { timeoutMs: cap(5000) },
      );
      tab.browser = browser;
      const created = await browser.send("Target.createTarget", { url: "about:blank", background: true }, cap(5000));
      const targetId: string | undefined = created?.targetId;
      tab.targetId = targetId;
      if (tab.aborted) throw new Deadline(); // the deadline fired mid-create; finally already ran
      if (!targetId) return out({ status: "failed", detail: "Target.createTarget returned no targetId." });
      log(`browser-auth: opened tab ${targetId}`);
      let target: CdpTarget | undefined;
      while (!target) {
        target = (await listTargets(endpoint, { timeoutMs: cap(3000) })).find((t) => t.id === targetId);
        if (!target) await sleep(cap(100));
      }
      const page = await CdpSession.connect(target, { timeoutMs: cap(5000) });
      tab.page = page;
      await page.send("Page.enable", {}, cap(5000));

      // b. Navigate the new tab.
      const nav = await page.send("Page.navigate", { url: req.url }, cap(15000));
      if (nav?.errorText) return out({ status: "failed", detail: `Could not load ${req.url}: ${nav.errorText}.` });

      let codeFilled = false;
      let accountConfirmed = false;
      const tileClickedOn = new Set<string>();
      let clicks = 0;
      for (;;) {
        cap(1);
        let snap: PageSnapshot | undefined;
        try {
          snap = await page.evaluate<PageSnapshot>(authJs.snapshot());
        } catch (e) {
          if (e instanceof Deadline) throw e;
          log(`browser-auth: snapshot retry (${e instanceof Error ? e.message : e})`);
        }
        if (snap && snap.readyState !== "loading") {
          for (const a of snap.accounts) seen.add(a.toLowerCase());
          // d. Policy block.
          if (POLICY_BLOCK_RE.test(snap.text)) {
            return out({
              status: "policy-blocked",
              detail: `Sign-in was blocked by policy: "${matchedLine(snap.text, POLICY_BLOCK_RE)}".`,
              fallback: "browser",
            });
          }
          // e. Success.
          if (SUCCESS_RE.test(snap.text) || isLoopbackCallback(snap.url, req.url)) {
            return out({ status: "completed", detail: `Signed in${req.account ? ` as ${req.account}` : ""} (${matchedLine(snap.text, SUCCESS_RE) || snap.url}).` });
          }
          // b. Device code.
          if (req.kind === "device-code" && req.userCode && !codeFilled && snap.codeInput) {
            const r = await page.evaluate<string>(authJs.fillCode(req.userCode));
            log(`browser-auth: fill code -> ${r}`);
            codeFilled = r !== "no-input";
            await sleep(cap(pollMs));
            continue;
          }
          // c. Account guard.
          const accounts = snap.accounts.map((a) => a.toLowerCase());
          const want = req.account?.toLowerCase();
          if (want === undefined) {
            if (accounts.length > 0) {
              return human(`The browser shows ${accounts.join(", ")} but the step does not say which account it needs; sign in yourself.`);
            }
            if (snap.signInForm) return human("The browser shows a sign-in form; the harness never types passwords, so sign in yourself.");
          } else if (accounts.length > 0 && !accounts.includes(want)) {
            return human(`The browser is signed in as ${accounts.join(", ")}, not ${req.account}; refusing to authorize.`, "wrong-account");
          } else if (accounts.includes(want)) {
            accountConfirmed = true;
            const others = accounts.filter((a) => a !== want);
            if (others.length > 0 && !tileClickedOn.has(snap.url)) {
              // An account chooser: pick the right tile, never approve on a mixed page.
              tileClickedOn.add(snap.url);
              const r = await page.evaluate<string>(authJs.clickAccount(want));
              log(`browser-auth: click account ${want} -> ${r}`);
              if (r === "clicked") {
                clicks++;
                await sleep(cap(pollMs));
                continue;
              }
            }
            if (others.length === 0 && clicks < 12) {
              const r = await page.evaluate<string>(authJs.clickApprove(approveTexts));
              if (r !== "none") {
                clicks++;
                log(`browser-auth: click approve "${r}"`);
              }
            }
          } else if (snap.signInForm) {
            return human(`The browser shows a sign-in form with no signed-in account; sign in to ${req.account} yourself.`);
          } else if (accountConfirmed && clicks < 12) {
            // Consent page after the chooser that no longer names the account.
            const r = await page.evaluate<string>(authJs.clickApprove(approveTexts));
            if (r !== "none") {
              clicks++;
              log(`browser-auth: click approve "${r}"`);
            }
          }
        }
        await sleep(cap(pollMs));
      }
    };

    let result: AuthOutcome;
    let timer: NodeJS.Timeout | undefined;
    try {
      const deadline = new Promise<"deadline">((r) => {
        timer = setTimeout(() => r("deadline"), Math.max(1, timeoutMs - reserve));
      });
      const raced = await Promise.race([
        work().catch((e) => (e instanceof Deadline ? ("deadline" as const) : Promise.reject(e))),
        deadline,
      ]);
      result =
        raced === "deadline"
          ? human(`Browser auth timed out after ${timeoutMs}ms without completing; finish it yourself.`)
          : raced;
    } catch (e) {
      result = out({ status: "failed", detail: `Browser auth failed: ${e instanceof Error ? e.message : String(e)}.` });
    } finally {
      clearTimeout(timer);
      // f. Always close OUR tab, bounded so we still return inside the budget.
      const closeBudget = Math.max(200, Math.min(reserve, started + timeoutMs - Date.now() - 50));
      tab.aborted = true;
      tab.page?.close();
      if (tab.targetId && tab.browser) {
        try {
          await tab.browser.send("Target.closeTarget", { targetId: tab.targetId }, closeBudget);
          log(`browser-auth: closed tab ${tab.targetId}`);
        } catch (e) {
          log(`browser-auth: closeTarget failed (${e instanceof Error ? e.message : e})`);
        }
      }
      tab.browser?.close();
    }
    return result!;
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
