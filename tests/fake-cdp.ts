// Reusable fake CDP endpoint for kiro-ide tests: an http server on 127.0.0.1:0
// serving /json/list and /json/version, plus one ws server per fake target.
import http from "node:http";
import type net from "node:net";
import { WebSocketServer, type WebSocket } from "ws";

export interface FakeContext {
  id: number;
  name: string;
  origin: string;
}

export interface FakeCall {
  targetId: string;
  method: string;
  params: any;
  contextId?: number;
}

/** Return a value for the CDP `result`, or throw / return {__error} to emit a CDP error. Return NO_REPLY to never answer. */
export type FakeHandler = (method: string, params: any, contextId?: number) => unknown | Promise<unknown>;

export const NO_REPLY = Symbol("no-reply");

export interface FakeTargetSpec {
  id: string;
  type: string;
  url: string;
  title?: string;
  /** Hidden targets are absent from /json/list (mutable at run time). */
  hidden?: boolean;
  contexts?: FakeContext[];
  /** Contexts created this many ms after Runtime.enable (a nested frame loading late). */
  lateContexts?: { afterMs: number; contexts: FakeContext[] };
  handler?: FakeHandler;
}

export interface FakeCdpSpec {
  targets: FakeTargetSpec[];
  version?: Record<string, unknown>;
  /** Per-request override for /json/version (n counts from 1): stall, fail, or answer. */
  versionFn?: (n: number) => { status?: number; delayMs?: number; body?: Record<string, unknown> } | undefined;
}

export interface FakeCdp {
  endpoint: string;
  calls: FakeCall[];
  /** Push an event frame to every connected socket of a target. */
  emit(targetId: string, method: string, params: unknown): void;
  close(): Promise<void>;
}

export async function startFakeCdp(spec: FakeCdpSpec): Promise<FakeCdp> {
  const calls: FakeCall[] = [];
  let versionHits = 0;
  const sockets = new Map<string, Set<WebSocket>>();
  const wsServers: WebSocketServer[] = [];
  const wsPorts = new Map<string, number>();

  for (const t of spec.targets) {
    const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    wsServers.push(wss);
    sockets.set(t.id, new Set());
    wss.on("connection", (ws) => {
      sockets.get(t.id)!.add(ws);
      ws.on("close", () => sockets.get(t.id)!.delete(ws));
      ws.on("message", async (raw) => {
        const msg = JSON.parse(raw.toString());
        const contextId: number | undefined = msg.params?.contextId;
        calls.push({ targetId: t.id, method: msg.method, params: msg.params, contextId });
        if (msg.method === "Runtime.enable") {
          ws.send(JSON.stringify({ id: msg.id, result: {} }));
          for (const c of t.contexts ?? []) {
            ws.send(JSON.stringify({ method: "Runtime.executionContextCreated", params: { context: c } }));
          }
          const late = t.lateContexts;
          if (late) {
            setTimeout(() => {
              for (const c of late.contexts) {
                if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ method: "Runtime.executionContextCreated", params: { context: c } }));
              }
            }, late.afterMs);
          }
          return;
        }
        try {
          const result = t.handler ? await t.handler(msg.method, msg.params, contextId) : {};
          if (result === NO_REPLY) return;
          if (result && typeof result === "object" && "__error" in (result as any)) {
            ws.send(JSON.stringify({ id: msg.id, error: { code: -32000, message: String((result as any).__error) } }));
          } else {
            ws.send(JSON.stringify({ id: msg.id, result: result ?? {} }));
          }
        } catch (e) {
          ws.send(JSON.stringify({ id: msg.id, error: { code: -32000, message: e instanceof Error ? e.message : String(e) } }));
        }
      });
    });
    wsPorts.set(t.id, await new Promise<number>((resolve) => wss.on("listening", () => resolve((wss.address() as net.AddressInfo).port))));
  }

  const server = http.createServer((req, res) => {
    const json = (v: unknown) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(v));
    };
    if (req.url === "/json/list") {
      return json(
        spec.targets.filter((t) => !t.hidden).map((t) => ({
          id: t.id,
          type: t.type,
          url: t.url,
          title: t.title ?? "",
          webSocketDebuggerUrl: `ws://127.0.0.1:${wsPorts.get(t.id)}/devtools/page/${t.id}`,
        })),
      );
    }
    if (req.url === "/json/version") {
      const o = spec.versionFn?.(++versionHits);
      if (o?.status) {
        res.statusCode = o.status;
        return res.end("err");
      }
      if (o?.delayMs) {
        setTimeout(() => json(o.body ?? spec.version ?? {}), o.delayMs);
        return;
      }
      if (o?.body) return json(o.body);
      return json(spec.version ?? { Browser: "Chrome/152.0.7977.130", "User-Agent": "Mozilla/5.0 Kiro/1.2.4", "Protocol-Version": "1.3" });
    }
    res.statusCode = 404;
    res.end("not found");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as net.AddressInfo).port;

  return {
    endpoint: `127.0.0.1:${port}`,
    calls,
    emit(targetId, method, params) {
      for (const ws of sockets.get(targetId) ?? []) ws.send(JSON.stringify({ method, params }));
    },
    async close() {
      for (const set of sockets.values()) for (const ws of set) ws.terminate();
      await Promise.all(wsServers.map((w) => new Promise<void>((r) => w.close(() => r()))));
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

// ---------------------------------------------------------------- model picker (issue #160)

import {
  CLOSE_MODEL_PICKER_JS,
  LIST_MODEL_OPTIONS_JS,
  OPEN_MODEL_PICKER_JS,
  READ_MODEL_JS,
  clickModelOptionJs,
} from "../src/adapters/kiro-ide-cdp.ts";

export interface FakePickerOption {
  name: string;
  disabled?: boolean;
}

/** The 1.2.4 option names observed live, plus look-alikes for the exact-match tests. */
export const FAKE_PICKER_MODELS: FakePickerOption[] = [
  { name: "Auto" },
  { name: "Claude Opus 5.5" },
  { name: "Claude Opus 5" },
  { name: "Claude Sonnet 5.5" },
  { name: "GPT 5.6 Sol" },
];

/**
 * A model picker with real state, not canned answers: the popup is open or closed, the trigger
 * click toggles it, the option list exists only while it is open, and clicking an option changes
 * the label and closes the popup (as observed live on Kiro 1.2.4). It dispatches on the exact
 * expressions the adapter sends (the builders in kiro-ide-cdp.ts), so a changed expression that
 * no longer reaches the picker fails loudly instead of being answered.
 */
export class FakeModelPicker {
  open = false;
  label: string;
  options: FakePickerOption[];
  /** Whether the trigger/label exist at all (a selector-drift simulation turns them off). */
  present = true;
  /** When set, clicking an option does not change the label (a read-back mismatch). */
  ignoreClicks = false;
  /** When set, the popup shows no options (a slow/empty render). */
  emptyPopup = false;
  /** Every option name clicked, in order. */
  clicked: string[] = [];
  /** Trigger toggles (open + close). */
  toggles = 0;
  constructor(opts: { label?: string; options?: FakePickerOption[] } = {}) {
    this.options = opts.options ?? FAKE_PICKER_MODELS;
    this.label = opts.label ?? "Auto";
  }

  /** Returns `{handled:false}` for an expression that is not a picker one. */
  evaluate(expression: string): { handled: boolean; value?: unknown } {
    const done = (value: unknown) => ({ handled: true, value });
    if (expression === READ_MODEL_JS) {
      return done(this.present ? { trigger: true, expanded: this.open, label: this.label } : { trigger: false, expanded: false, label: null });
    }
    if (expression === OPEN_MODEL_PICKER_JS) {
      if (!this.present) return done("none");
      if (!this.open) {
        this.open = true;
        this.toggles++;
      }
      return done("ok");
    }
    if (expression === CLOSE_MODEL_PICKER_JS) {
      if (!this.present) return done("none");
      if (this.open) {
        this.open = false;
        this.toggles++;
      }
      return done("ok");
    }
    if (expression === LIST_MODEL_OPTIONS_JS) {
      if (!this.open || this.emptyPopup) return done(null);
      return done(this.options.map((o) => ({ name: o.name, disabled: o.disabled === true })));
    }
    for (let i = 0; i < this.options.length; i++) {
      if (expression !== clickModelOptionJs(i)) continue;
      const o = this.options[i]!;
      if (!this.open || o.disabled) return done("none");
      this.clicked.push(o.name);
      if (!this.ignoreClicks) this.label = o.name;
      this.open = false;
      return done("clicked");
    }
    return { handled: false };
  }
}
