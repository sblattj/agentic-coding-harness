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
} as const;

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
