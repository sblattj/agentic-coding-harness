// `ach web` request guard: the cross-site and DNS-rebinding checks every request
// (plain HTTP and WebSocket upgrades) passes before any route runs.
//
// A web page in the user's browser can reach a loopback server: a "simple" POST
// (text/plain, form) needs no CORS preflight, a WebSocket is never same-origin
// checked by the browser, and DNS rebinding makes evil.example resolve to 127.0.0.1
// so the page can read answers too. Native clients (the macOS app, curl, the CLI)
// send no Origin header and Host 127.0.0.1:<port>, so they pass unchanged.
import type { IncomingMessage } from "node:http";

export interface GuardVerdict {
  status: number;
  message: string;
}

const LOOPBACK_BIND = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
const LOOPBACK_NAMES = ["127.0.0.1", "localhost", "[::1]"];

/** True when the server listens on a loopback address only. */
export function isLoopbackBind(host: string): boolean {
  return LOOPBACK_BIND.has(host.toLowerCase()) || /^127\.\d+\.\d+\.\d+$/.test(host);
}

/** Splits a Host header value into name and port (port "" when absent). */
function splitHost(value: string): { name: string; port: string } {
  const v = value.trim().toLowerCase();
  const m = /^(\[[^\]]*\]|[^:]*)(?::(\d*))?$/.exec(v);
  return m === null ? { name: v, port: "" } : { name: m[1] as string, port: m[2] ?? "" };
}

/**
 * Host + Origin check. Refuses (null = allowed):
 * - on a loopback bind, a Host that is not 127.0.0.1 / localhost / [::1] with this port (421);
 * - any request whose Origin is present and is not http://<the Host it was sent to> (403).
 */
export function checkHostOrigin(req: IncomingMessage, bind: { host: string; port: number }): GuardVerdict | null {
  const hostHeader = req.headers.host ?? "";
  if (isLoopbackBind(bind.host)) {
    const { name, port } = splitHost(hostHeader);
    const portOk = port === String(bind.port) || (port === "" && bind.port === 80);
    // A loopback bind to 127.0.0.2 is reached as Host 127.0.0.2: accept the bind address itself too.
    const allowed = LOOPBACK_NAMES.includes(name) || name === bind.host.toLowerCase();
    if (!allowed || !portOk) {
      return { status: 421, message: `misdirected request: Host ${JSON.stringify(hostHeader)} is not this server` };
    }
  }
  const origin = req.headers.origin;
  if (origin !== undefined) {
    // https too: behind a TLS-terminating proxy the page's origin is https://<same host>.
    const o = origin.toLowerCase();
    const h = hostHeader.toLowerCase();
    const sameOrigin = h !== "" && (o === `http://${h}` || o === `https://${h}`);
    if (!sameOrigin) return { status: 403, message: `cross-origin request refused (Origin ${JSON.stringify(origin)})` };
  }
  return null;
}

/**
 * Non-GET /api/* requests carrying a body must be application/json (415 otherwise): a
 * text/plain or form body is exactly what a page can send without a preflight. A POST with
 * no body (the grid's kill and continue buttons) has nothing to smuggle and passes.
 */
export function checkJsonBody(req: IncomingMessage, pathname: string): GuardVerdict | null {
  const method = req.method ?? "GET";
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return null;
  if (pathname !== "/api" && !pathname.startsWith("/api/")) return null;
  const type = (req.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();
  if (type === "application/json") return null;
  const length = req.headers["content-length"];
  const hasBody = req.headers["transfer-encoding"] !== undefined || (length !== undefined && length !== "0");
  if (type === "" && !hasBody) return null;
  return { status: 415, message: "content-type must be application/json" };
}
