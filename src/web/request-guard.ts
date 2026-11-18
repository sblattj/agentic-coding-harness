// `ach web` request guard: the cross-site and DNS-rebinding checks every request
// (plain HTTP and WebSocket upgrades) passes before any route runs.
//
// A web page in the user's browser can reach a loopback server: a "simple" POST
// (text/plain, form) needs no CORS preflight, a WebSocket is never same-origin
// checked by the browser, and DNS rebinding makes evil.example resolve to 127.0.0.1
// so the page can read answers too. Native clients (the macOS app, curl, the CLI)
// send no Origin header and Host 127.0.0.1:<port>, so they pass unchanged.
//
// A non-loopback bind (0.0.0.0, a LAN IP, a hostname; only with a --token or env token)
// is rebindable too: the pages and the read-only JSON API stay unauthenticated there
// (src/cli/web.ts), so evil.example rebound to the LAN IP could read them from a
// victim's browser. Rebinding needs an attacker-controlled DNS NAME in the Host, so
// that bind accepts only names that are this machine: any IP literal (a browser that
// typed an IP sends it as Host, and an IP cannot be rebound), localhost, the bind
// host when it is a name, and os.hostname() with its short and .local forms. The port
// is not checked there: a rebinding request already carries the server's port, and a
// port forward or proxy legitimately changes it. A reverse proxy or LAN DNS name that is none
// of those (a Tailscale or router-suffix name) is listed in env
// AGENTIC_CODING_HARNESS_WEB_ALLOWED_HOSTS (comma-separated names); it is accepted on either
// kind of bind, on any port, because the user vouched for it.
import type { IncomingMessage } from "node:http";
import { isIP } from "node:net";
import { hostname as osHostname } from "node:os";

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

/** This machine's own names: os.hostname(), its first label, and <label>.local (mDNS). */
function machineNames(): string[] {
  const full = osHostname().trim().toLowerCase().replace(/\.$/, "");
  if (full === "") return [];
  const short = full.split(".")[0] as string;
  return [...new Set([full, short, `${short}.local`])];
}

/** Extra Host names from env AGENTIC_CODING_HARNESS_WEB_ALLOWED_HOSTS (comma-separated). */
export function extraAllowedHosts(env: NodeJS.ProcessEnv = process.env): string[] {
  return (env.AGENTIC_CODING_HARNESS_WEB_ALLOWED_HOSTS ?? "")
    .split(",")
    .map((h) => h.trim().toLowerCase().replace(/\.$/, ""))
    .filter((h) => h !== "");
}

/** Host names a non-loopback bind accepts (see the header comment for why). */
function nonLoopbackHostOk(name: string, bindHost: string): boolean {
  if (name === "") return false;
  const bare = name.startsWith("[") && name.endsWith("]") ? name.slice(1, -1) : name;
  if (isIP(bare) !== 0) return true;
  const n = name.replace(/\.$/, "");
  if (n === "localhost") return true;
  const bind = bindHost.toLowerCase().replace(/\.$/, "");
  if (isIP(bind) === 0 && bind !== "" && n === bind) return true;
  return machineNames().includes(n);
}

/**
 * Host + Origin check. Refuses (null = allowed):
 * - on a loopback bind, a Host that is not 127.0.0.1 / localhost / [::1] / the bind address with this port (421);
 * - on a non-loopback bind, a Host whose name is not an IP literal, localhost, the bind host or
 *   this machine's hostname (421; any port);
 * - neither, when the Host name is listed in env AGENTIC_CODING_HARNESS_WEB_ALLOWED_HOSTS;
 * - any request whose Origin is present and is not http://<the Host it was sent to> (403).
 */
export function checkHostOrigin(req: IncomingMessage, bind: { host: string; port: number }): GuardVerdict | null {
  const hostHeader = req.headers.host ?? "";
  const extra = extraAllowedHosts();
  if (extra.length > 0 && extra.includes(splitHost(hostHeader).name.replace(/\.$/, ""))) {
    // user-listed name (reverse proxy, tailnet or LAN DNS): any port, either bind kind
  } else if (isLoopbackBind(bind.host)) {
    const { name, port } = splitHost(hostHeader);
    const portOk = port === String(bind.port) || (port === "" && bind.port === 80);
    // A loopback bind to 127.0.0.2 is reached as Host 127.0.0.2: accept the bind address itself too.
    const allowed = LOOPBACK_NAMES.includes(name) || name === bind.host.toLowerCase();
    if (!allowed || !portOk) {
      return { status: 421, message: `misdirected request: Host ${JSON.stringify(hostHeader)} is not this server` };
    }
  } else if (!nonLoopbackHostOk(splitHost(hostHeader).name, bind.host)) {
    return { status: 421, message: `misdirected request: Host ${JSON.stringify(hostHeader)} is not this server` };
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
