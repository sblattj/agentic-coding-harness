// Minimal Chrome DevTools Protocol client for driving the Kiro IDE (Electron)
// desktop app (issue #110). Uses `ws` and global fetch only. Also the single
// home of the DOM selectors / injected JS shared by the adapter and doctor.
import { WebSocket } from "ws";

export interface CdpTarget {
  id: string;
  type: string;
  url: string;
  title?: string;
  webSocketDebuggerUrl?: string;
}

export interface CdpContext {
  id: number;
  name: string;
  origin: string;
}

export const KIRO_IDE_SELECTORS = {
  chatInput: ".chat-input-content",
  chatTargetUrl: "extensionId=kiro.kiroAgent",
  workbenchUrl: "workbench.html",
  // Model picker (issue #160). Observed live on Kiro IDE 1.2.4 and 1.4.62 over CDP. The trigger carries aria-haspopup=listbox and
  // aria-expanded; element.click() toggles the popup. The option's innerText is multi-line:
  // the name, then a credit multiplier, then a description, so only the first line is the name.
  modelTrigger: "button.model-selector-trigger",
  modelLabel: "span.model-selector-label",
  // 1.2.4: the popup menu itself is the listbox. 1.4.62: the menu is a role=dialog panel (with a
  // filter box) and the listbox is a child list, so the 1.2.4 selector matched nothing there.
  modelPopup: ".chat-input-popup-menu[role=listbox], .kiro-model-selector-list[role=listbox]",
  modelOption: ".chat-input-popup-option[role=option]",
} as const;

const sel = (s: string): string => JSON.stringify(s);

/** The picker's current state: `{trigger, expanded, label}` (label null when the span is absent). */
export const READ_MODEL_JS = `(() => { const t = document.querySelector(${sel(KIRO_IDE_SELECTORS.modelTrigger)}); const l = document.querySelector(${sel(KIRO_IDE_SELECTORS.modelLabel)}); return { trigger: !!t, expanded: !!t && t.getAttribute('aria-expanded') === 'true', label: l ? (l.textContent || '').trim() : null }; })()`;
/** Opens the popup when it is closed (a click toggles, so an open popup is left alone). 'none' = no trigger. */
export const OPEN_MODEL_PICKER_JS = `(() => { const t = document.querySelector(${sel(KIRO_IDE_SELECTORS.modelTrigger)}); if (!t) return 'none'; if (t.getAttribute('aria-expanded') !== 'true') t.click(); return 'ok'; })()`;
/** Closes the popup when it is open. Never selects anything. */
export const CLOSE_MODEL_PICKER_JS = `(() => { const t = document.querySelector(${sel(KIRO_IDE_SELECTORS.modelTrigger)}); if (!t) return 'none'; if (t.getAttribute('aria-expanded') === 'true') t.click(); return 'ok'; })()`;
/** The popup's options as `[{name, disabled}]` (name = first non-empty line), or null when no popup is rendered. */
export const LIST_MODEL_OPTIONS_JS = `(() => { const p = document.querySelector(${sel(KIRO_IDE_SELECTORS.modelPopup)}); if (!p) return null; return [...p.querySelectorAll(${sel(KIRO_IDE_SELECTORS.modelOption)})].map((o) => ({ name: ((o.innerText || o.textContent || '').split('\\n').map((x) => x.trim()).find((x) => x !== '') || ''), disabled: o.getAttribute('aria-disabled') === 'true' })); })()`;
export function clickModelOptionJs(index: number): string {
  return `(() => { const p = document.querySelector(${sel(KIRO_IDE_SELECTORS.modelPopup)}); if (!p) return 'none'; const o = [...p.querySelectorAll(${sel(KIRO_IDE_SELECTORS.modelOption)})][${Number(index)}]; if (!o || o.getAttribute('aria-disabled') === 'true') return 'none'; o.click(); return 'clicked'; })()`;
}

export interface KiroIdeModelOption {
  name: string;
  disabled: boolean;
}
export interface KiroIdePickerState {
  trigger: boolean;
  expanded: boolean;
  label: string | null;
}

/** Case-insensitive, letters and digits only: "claude-sonnet-5.5" and "Claude Sonnet 5.5" are the same model. */
export function normalizeModelName(s: string): string {
  return s.replace(/[^\p{L}\p{N}]+/gu, "").toLowerCase();
}

export type KiroIdeModelPick =
  | { kind: "match"; index: number; name: string }
  | { kind: "disabled"; name: string }
  | { kind: "none" };

/** Exact normalized match on the option name, never a substring ("Claude Opus 5" must not pick "Claude Opus 5.5"). */
export function pickModelOption(options: KiroIdeModelOption[], want: string): KiroIdeModelPick {
  const key = normalizeModelName(want);
  if (key === "") return { kind: "none" };
  let disabled: string | undefined;
  for (let i = 0; i < options.length; i++) {
    const o = options[i]!;
    if (normalizeModelName(o.name) !== key) continue;
    if (o.disabled) disabled ??= o.name;
    else return { kind: "match", index: i, name: o.name };
  }
  return disabled !== undefined ? { kind: "disabled", name: disabled } : { kind: "none" };
}

/** Walks shadow roots, skips STYLE/SCRIPT, returns all text nodes joined by " | ". */
export const DEEP_TEXT_JS =
  "(() => { const out = []; const walk = (n) => { if (n.nodeType === 3) { const s = n.textContent.trim(); if (s && !/^[\\s{}.:#@;-]/.test(s)) out.push(s); return; } if (n.nodeName === 'STYLE' || n.nodeName === 'SCRIPT') return; if (n.shadowRoot) walk(n.shadowRoot); for (const c of n.childNodes) walk(c); }; walk(document.body); return out.join(' | '); })()";

/** Clicks the first button-like element whose text equals `text`; returns 'clicked' or 'none'. */
export function clickByTextJs(text: string): string {
  const want = JSON.stringify(text);
  return `(() => { const want = ${want}; const hits = []; const walk = (n) => { if (n.nodeType === 1) { const t = (n.innerText ?? n.textContent ?? '').trim(); if (t === want && (n.tagName === 'BUTTON' || n.getAttribute('role') === 'button' || n.tagName === 'A' || n.onclick)) hits.push(n); if (n.shadowRoot) walk(n.shadowRoot); } for (const c of n.childNodes) walk(c); }; walk(document.body); if (!hits.length) return 'none'; hits[0].click(); return 'clicked'; })()`;
}

export function endpointFrom(hostPort: string | undefined, port: number): string {
  const v = hostPort?.trim();
  if (!v) return `127.0.0.1:${port}`;
  // Already host:port (single colon) or [v6]:port.
  if (/^\[.*\]:\d+$/.test(v) || /^[^:]+:\d+$/.test(v)) return v;
  return v.startsWith("[") ? `${v}:${port}` : `${v.includes(":") ? `[${v}]` : v}:${port}`;
}

export function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h === "::1") return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}

async function getJson(url: string, timeoutMs: number): Promise<any> {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`GET ${url} -> HTTP ${res.status}`);
  return res.json();
}

export async function listTargets(endpoint: string, opts: { timeoutMs?: number } = {}): Promise<CdpTarget[]> {
  const v = await getJson(`http://${endpoint}/json/list`, opts.timeoutMs ?? 5000);
  return Array.isArray(v) ? (v as CdpTarget[]) : [];
}

export async function browserVersion(endpoint: string, opts: { timeoutMs?: number } = {}): Promise<any> {
  return getJson(`http://${endpoint}/json/version`, opts.timeoutMs ?? 5000);
}

export type KiroIdeEndpointVerdict =
  | { kind: "kiro"; kiroVersion?: string; version: any }
  | { kind: "other"; product: string; version: any };

function hasText(v: unknown): v is string {
  return typeof v === "string" && v.trim() !== "";
}

/** Names the product behind a CDP endpoint from User-Agent, falling back to the Browser field. */
export function describeCdpProduct(version: any): string {
  const ua = hasText(version?.["User-Agent"]) ? (version["User-Agent"] as string) : "";
  const tok = (re: RegExp) => re.exec(ua)?.[0];
  const named =
    tok(/Vivaldi\/[\w.]+/) ??
    tok(/Edg\/[\w.]+/)?.replace(/^Edg/, "Edge") ??
    tok(/OPR\/[\w.]+/)?.replace(/^OPR/, "Opera") ??
    tok(/Brave\/[\w.]+/) ??
    tok(/Firefox\/[\w.]+/) ??
    (ua.includes("Electron/") ? `Electron app (${tok(/Electron\/[\w.]+/)})` : undefined) ??
    tok(/HeadlessChrome\/[\w.]+/) ??
    tok(/Chrome\/[\w.]+/);
  if (named) return named;
  return hasText(version?.Browser) ? (version.Browser as string).trim() : "unknown browser";
}

/**
 * Pure classifier (issue #161). Kiro IDE is an Electron app whose /json/version
 * `Browser` field reads plain "Chrome/..." (observed on Kiro 1.2.4), so Browser is never
 * tested. The signal is User-Agent containing "Kiro/". Only when User-Agent is absent or
 * empty does a page target whose url contains the workbench path count (a generic VS Code
 * Electron app has that workbench url too, so it must not be used when a UA is present).
 */
export function classifyKiroIdeEndpoint(version: any, targets: CdpTarget[] | undefined): KiroIdeEndpointVerdict {
  const ua = version?.["User-Agent"];
  if (hasText(ua)) {
    if (ua.includes("Kiro/")) return { kind: "kiro", kiroVersion: /Kiro\/(\S+)/.exec(ua)?.[1], version };
    return { kind: "other", product: describeCdpProduct(version), version };
  }
  if ((targets ?? []).some((t) => t.type === "page" && t.url.includes(KIRO_IDE_SELECTORS.workbenchUrl))) {
    return { kind: "kiro", version };
  }
  return { kind: "other", product: describeCdpProduct(version), version };
}

function portOf(endpoint: string): string {
  return /:(\d+)$/.exec(endpoint)?.[1] ?? endpoint;
}

export function kiroIdeWrongEndpointMessage(endpoint: string, product: string): string {
  return `port ${portOf(endpoint)} is a ${product}, not Kiro IDE; pass --kiro-ide-port`;
}

export const KIRO_IDE_WRONG_ENDPOINT_HINT =
  "another app owns this debugging port. Pass --kiro-ide-port <N> (or --kiro-ide-cdp host:port) for the port Kiro listens on; to let ach launch Kiro, free the port or choose an unused one such as --kiro-ide-port 9333";

/**
 * Shared by doctor and the run: fetch /json/version (throws when unreachable), list targets
 * only when the User-Agent cannot decide, and classify. Read-only; sends no CDP command.
 */
export async function checkKiroIdeEndpoint(endpoint: string, opts: { timeoutMs?: number } = {}): Promise<KiroIdeEndpointVerdict> {
  const version = await browserVersion(endpoint, opts);
  let targets: CdpTarget[] | undefined;
  if (!hasText(version?.["User-Agent"])) targets = await listTargets(endpoint, opts).catch(() => []);
  return classifyKiroIdeEndpoint(version, targets);
}

export class CdpSession {
  private nextId = 0;
  private readonly pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private ctxs = new Map<number, CdpContext>();

  private constructor(private readonly ws: WebSocket) {
    ws.on("message", (raw) => this.onMessage(raw.toString()));
    ws.on("close", () => this.failAll(new Error("CDP socket closed")));
    ws.on("error", (e) => this.failAll(e instanceof Error ? e : new Error(String(e))));
  }

  static async connect(target: CdpTarget, opts: { timeoutMs?: number } = {}): Promise<CdpSession> {
    if (!target.webSocketDebuggerUrl) throw new Error(`CDP target ${target.id} has no webSocketDebuggerUrl`);
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    const timeoutMs = opts.timeoutMs ?? 10_000;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        ws.terminate();
        reject(new Error(`CDP connect timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      ws.once("open", () => {
        clearTimeout(timer);
        resolve();
      });
      ws.once("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
    });
    return new CdpSession(ws);
  }

  private onMessage(raw: string): void {
    let d: any;
    try {
      d = JSON.parse(raw);
    } catch {
      return;
    }
    if (typeof d.id === "number") {
      const p = this.pending.get(d.id);
      if (!p) return;
      this.pending.delete(d.id);
      clearTimeout(p.timer);
      if (d.error) p.reject(new Error(`CDP error: ${d.error.message ?? JSON.stringify(d.error)}`));
      else p.resolve(d.result);
      return;
    }
    if (d.method === "Runtime.executionContextCreated") {
      const c = d.params?.context;
      if (c) this.ctxs.set(c.id, { id: c.id, name: c.name ?? "", origin: c.origin ?? "" });
    } else if (d.method === "Runtime.executionContextDestroyed") {
      this.ctxs.delete(d.params?.executionContextId);
    } else if (d.method === "Runtime.executionContextsCleared") {
      this.ctxs.clear();
    }
  }

  private failAll(err: Error): void {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
      this.pending.delete(id);
    }
  }

  send(method: string, params: Record<string, unknown> = {}, timeoutMs = 10_000): Promise<any> {
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.ws.send(JSON.stringify({ id, method, params }), (err) => {
          if (err && this.pending.delete(id)) {
            clearTimeout(timer);
            reject(err);
          }
        });
      } catch (e) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  /** Enables Runtime and waits briefly so the initial context events are collected. */
  async enableRuntime(): Promise<void> {
    await this.send("Runtime.enable");
    // Context events are emitted right after the Runtime.enable reply; yield once so they are seen.
    await new Promise((r) => setTimeout(r, 50));
  }

  /**
   * Waits until no new execution context has appeared for `quietMs` (bounded by `maxMs`).
   * The Kiro chat webview's input lives in a nested frame whose context is created a few
   * hundred ms after Runtime.enable (live, Kiro IDE 1.4.62), so a one-shot probe right after
   * enableRuntime() saw only the outer frame.
   */
  async settleContexts(opts: { quietMs?: number; maxMs?: number } = {}): Promise<void> {
    const quietMs = opts.quietMs ?? 300;
    const maxMs = opts.maxMs ?? 2000;
    const start = Date.now();
    let count = this.ctxs.size;
    let since = Date.now();
    while (Date.now() - start < maxMs) {
      await new Promise((r) => setTimeout(r, 50));
      if (this.ctxs.size !== count) {
        count = this.ctxs.size;
        since = Date.now();
      } else if (Date.now() - since >= quietMs) {
        return;
      }
    }
  }

  contexts(): CdpContext[] {
    return [...this.ctxs.values()];
  }

  async evaluate<T = unknown>(expression: string, contextId?: number): Promise<T | undefined> {
    const params: Record<string, unknown> = { expression, returnByValue: true, awaitPromise: true };
    if (contextId !== undefined) params.contextId = contextId;
    const res = await this.send("Runtime.evaluate", params);
    if (res?.exceptionDetails) {
      const d = res.exceptionDetails;
      throw new Error(d.exception?.description ?? d.text ?? "evaluate failed");
    }
    return res?.result?.value as T | undefined;
  }

  async evaluateEach<T = unknown>(expression: string): Promise<Array<{ contextId: number; name: string; value?: T; error?: string }>> {
    const out: Array<{ contextId: number; name: string; value?: T; error?: string }> = [];
    for (const c of this.contexts()) {
      try {
        out.push({ contextId: c.id, name: c.name, value: await this.evaluate<T>(expression, c.id) });
      } catch (e) {
        out.push({ contextId: c.id, name: c.name, error: e instanceof Error ? e.message : String(e) });
      }
    }
    return out;
  }

  async insertText(text: string): Promise<void> {
    await this.send("Input.insertText", { text });
  }

  async pressEnter(): Promise<void> {
    const base = { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 };
    await this.send("Input.dispatchKeyEvent", { type: "keyDown", ...base, text: "\r" });
    await this.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
  }

  close(): void {
    this.failAll(new Error("CDP session closed"));
    try {
      this.ws.terminate();
    } catch {
      /* already closed */
    }
  }
}
