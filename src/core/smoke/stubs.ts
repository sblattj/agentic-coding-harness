// Local stubs for outward write integrations (agentic-coding-harness#139,
// step 4 of `ach smoke`): "point ticketing or other write integrations at a
// local stub, so the run creates nothing real."
//
// Two mechanisms, both node:http / node:net only:
//   1. envVar specs (`jira=JIRA_BASE_URL`): one HTTP server per spec on
//      127.0.0.1:0, its base URL exported under the env var. Responses mimic the
//      write endpoints of the named preset so the tool believes it succeeded.
//   2. host specs (`host:*.atlassian.net`) and opts.blockHosts: ONE forward
//      proxy, exported via HTTP(S)_PROXY. We never MITM TLS: a CONNECT to a
//      matching host is refused with 403 (the tool sees a proxy refusal and
//      nothing leaves the machine); every other CONNECT is tunnelled untouched
//      so unrelated traffic (package installs, auth) keeps working. Plain-HTTP
//      proxied requests to a matching host are answered by the generic preset.
// Every request that reaches a stub is recorded as a StubRequest.

import http from "node:http";
import net from "node:net";
import type { AddressInfo } from "node:net";
import { HarnessError } from "../types.ts";
import type { StubRequest } from "./types.ts";

export type StubPreset = "jira" | "github" | "linear" | "slack" | "generic";

export interface StubSpec {
  name: string;
  envVar?: string;
  host?: string;
  preset?: StubPreset;
}

export interface StubSet {
  env: Record<string, string>;
  requests(): StubRequest[];
  close(): Promise<void>;
  proxyUrl: string | null;
}

const PRESETS: readonly StubPreset[] = ["jira", "github", "linear", "slack", "generic"];
const BODY_CAP = 8 * 1024;
const ENV_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const HOST_RE = /^(\*\.)?[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$/;

function isPreset(s: string): s is StubPreset {
  return (PRESETS as readonly string[]).includes(s);
}

function usage(flag: string, why: string): HarnessError {
  return new HarnessError(
    `bad --stub value ${JSON.stringify(flag)}: ${why} (forms: jira=JIRA_BASE_URL, host:api.example.com, host:*.atlassian.net, slack)`,
    "USAGE",
    2,
  );
}

export function parseStubFlag(v: string): StubSpec {
  const raw = typeof v === "string" ? v.trim() : "";
  if (!raw) throw usage(String(v), "empty");
  if (raw.startsWith("host:")) {
    const host = raw.slice(5).trim().toLowerCase();
    if (!HOST_RE.test(host)) throw usage(v, "invalid host pattern");
    return { name: host, host };
  }
  const eq = raw.indexOf("=");
  if (eq >= 0) {
    const name = raw.slice(0, eq).trim().toLowerCase();
    const envVar = raw.slice(eq + 1).trim();
    if (!/^[a-z0-9][a-z0-9_-]*$/.test(name)) throw usage(v, "invalid stub name");
    if (!ENV_RE.test(envVar)) throw usage(v, "invalid env var name");
    return { name, envVar, preset: isPreset(name) ? name : "generic" };
  }
  const name = raw.toLowerCase();
  if (!isPreset(name)) throw usage(v, "bare names must be a preset (jira, github, linear, slack, generic)");
  return { name, preset: name };
}

// ---------------------------------------------------------------- matching

function hostMatches(pattern: string, host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  const p = pattern.toLowerCase();
  if (p.startsWith("*.")) return h.endsWith(p.slice(1)) && h.length > p.length - 1;
  return h === p;
}

// ---------------------------------------------------------------- responses

interface Reply {
  status: number;
  body?: unknown;
}

function reply(preset: StubPreset, method: string, path: string, n: number, base: string): Reply {
  const p = path.split("?")[0]!;
  const write = method === "POST" || method === "PUT" || method === "PATCH";
  if (preset === "jira") {
    if (method === "POST" && /^\/rest\/api\/[23]\/issue\/?$/.test(p)) {
      const key = `STUB-${n}`;
      return { status: 201, body: { id: String(10000 + n), key, self: `${base}/rest/api/2/issue/${10000 + n}` } };
    }
    if (method === "GET" && /^\/rest\/api\/[^/]+\/myself\/?$/.test(p)) {
      return { status: 200, body: { accountId: "stub", emailAddress: "stub@example.invalid" } };
    }
  } else if (preset === "github") {
    if (method === "POST" && /^\/repos\/[^/]+\/[^/]+\/issues\/?$/.test(p)) {
      return { status: 201, body: { number: n, html_url: `http://stub.invalid/${n}` } };
    }
    if (method === "GET" && p === "/user") return { status: 200, body: { login: "stub" } };
  } else if (preset === "linear") {
    if (method === "POST" && p === "/graphql") {
      return {
        status: 200,
        body: { data: { issueCreate: { success: true, issue: { id: "stub", identifier: `STUB-${n}` } } } },
      };
    }
  } else if (preset === "slack") {
    if (method === "POST" && p === "/api/chat.postMessage") return { status: 200, body: { ok: true, ts: `${n}.0` } };
  }
  // generic behaviour (also the fallback for unrouted preset paths)
  if (write) return { status: 201, body: { id: `stub-${n}` } };
  if (method === "DELETE") return { status: 204 };
  return { status: 200, body: {} };
}

function send(res: http.ServerResponse, r: Reply): void {
  if (r.body === undefined) {
    res.writeHead(r.status, { "content-length": "0" });
    res.end();
    return;
  }
  const s = JSON.stringify(r.body);
  res.writeHead(r.status, { "content-type": "application/json", "content-length": Buffer.byteLength(s) });
  res.end(s);
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      if (size < BODY_CAP) chunks.push(c);
      size += c.length;
    });
    req.on("end", () => resolve(Buffer.concat(chunks).subarray(0, BODY_CAP).toString("utf8")));
    req.on("error", () => resolve(Buffer.concat(chunks).subarray(0, BODY_CAP).toString("utf8")));
  });
}

// ---------------------------------------------------------------- startStubs

export async function startStubs(specs: StubSpec[], opts: { blockHosts?: string[] } = {}): Promise<StubSet> {
  const log: StubRequest[] = [];
  const servers: http.Server[] = [];
  const sockets = new Set<net.Socket>();
  const env: Record<string, string> = {};
  let closed: Promise<void> | null = null;

  const track = (s: http.Server): void => {
    servers.push(s);
    s.on("connection", (sock) => {
      sockets.add(sock);
      sock.on("close", () => sockets.delete(sock));
    });
  };
  const listen = (s: http.Server): Promise<number> =>
    new Promise((resolve, reject) => {
      s.once("error", reject);
      s.listen(0, "127.0.0.1", () => resolve((s.address() as AddressInfo).port));
    });
  const record = (stub: string, method: string, path: string, body: string): void => {
    log.push({ stub, method, path, body, at: new Date().toISOString() });
  };

  try {
    // 1. one server per env-var spec (a bare preset spec gets <NAME>_BASE_URL)
    for (const spec of specs) {
      if (spec.host && !spec.envVar) continue;
      const envVar = spec.envVar ?? `${spec.name.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_BASE_URL`;
      const preset = spec.preset ?? (isPreset(spec.name) ? spec.name : "generic");
      let n = 0;
      const srv = http.createServer(async (req, res) => {
        const body = await readBody(req);
        const method = (req.method ?? "GET").toUpperCase();
        const path = req.url ?? "/";
        n += 1;
        record(spec.name, method, path, body);
        const base = `http://127.0.0.1:${(srv.address() as AddressInfo | null)?.port ?? 0}`;
        send(res, reply(preset, method, path, n, base));
      });
      track(srv);
      const port = await listen(srv);
      env[envVar] = `http://127.0.0.1:${port}`;
    }

    // 2. one forward proxy for host specs and blockHosts
    const patterns: { pattern: string; name: string }[] = [];
    for (const spec of specs) if (spec.host) patterns.push({ pattern: spec.host, name: spec.name });
    for (const h of opts.blockHosts ?? []) patterns.push({ pattern: h, name: h });
    const find = (host: string) => patterns.find((p) => hostMatches(p.pattern, host));

    let proxyUrl: string | null = null;
    if (patterns.length > 0) {
      let n = 0;
      const proxy = http.createServer(async (req, res) => {
        // Plain-HTTP proxying: req.url is an absolute URI.
        let u: URL;
        try {
          u = new URL(req.url ?? "");
        } catch {
          res.writeHead(400, { "content-length": "0" });
          res.end();
          return;
        }
        const method = (req.method ?? "GET").toUpperCase();
        const hit = find(u.hostname);
        if (hit) {
          const body = await readBody(req);
          n += 1;
          record(hit.name, method, u.pathname + u.search, body);
          send(res, reply("generic", method, u.pathname, n, `http://${u.host}`));
          return;
        }
        const headers = { ...req.headers };
        delete headers["proxy-connection"];
        const up = http.request(
          { host: u.hostname, port: u.port || 80, method, path: u.pathname + u.search, headers },
          (ur) => {
            res.writeHead(ur.statusCode ?? 502, ur.headers);
            ur.pipe(res);
            ur.on("error", () => res.destroy());
          },
        );
        up.on("error", () => {
          if (!res.headersSent) res.writeHead(502, { "content-length": "0" });
          res.end();
        });
        res.on("close", () => up.destroy());
        req.pipe(up);
      });
      proxy.on("connect", (req, client: net.Socket, head: Buffer) => {
        sockets.add(client);
        client.on("close", () => sockets.delete(client));
        client.on("error", () => client.destroy());
        const target = req.url ?? "";
        const m = /^(\[[^\]]+\]|[^:]+):(\d+)$/.exec(target);
        if (!m) {
          client.end("HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
          return;
        }
        const host = m[1]!.replace(/^\[|\]$/g, "");
        const port = Number(m[2]);
        const hit = find(host);
        if (hit) {
          record(hit.name, "CONNECT", target, "");
          const msg = `ach smoke: ${target} is stubbed; the outward connection was refused so nothing real is created.\n`;
          client.end(
            `HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(msg)}\r\nConnection: close\r\n\r\n${msg}`,
          );
          return;
        }
        const up = net.connect(port, host);
        sockets.add(up);
        up.on("close", () => sockets.delete(up));
        up.on("error", () => {
          if (!client.destroyed && !up.connecting && up.bytesRead === 0 && up.bytesWritten === 0 && !client.writableEnded) {
            client.end("HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
          }
          client.destroy();
        });
        up.once("connect", () => {
          client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
          if (head.length) up.write(head);
          up.pipe(client);
          client.pipe(up);
        });
        client.on("close", () => up.destroy());
        up.on("close", () => client.destroy());
      });
      proxy.on("clientError", (_e, sock) => sock.destroy());
      track(proxy);
      const port = await listen(proxy);
      proxyUrl = `http://127.0.0.1:${port}`;
      for (const k of ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"]) env[k] = proxyUrl;
      env.NO_PROXY = "127.0.0.1,localhost";
      env.no_proxy = "127.0.0.1,localhost";
    }

    const close = (): Promise<void> => {
      if (closed) return closed;
      closed = new Promise<void>((resolve) => {
        let pending = servers.length;
        if (pending === 0) resolve();
        for (const s of servers) s.close(() => --pending === 0 && resolve());
        for (const sock of sockets) sock.destroy();
        sockets.clear();
      });
      return closed;
    };
    return { env, requests: () => log.slice(), close, proxyUrl };
  } catch (e) {
    for (const s of servers) s.close();
    for (const sock of sockets) sock.destroy();
    throw e;
  }
}

// ---------------------------------------------------------------- reporting

export function summarizeStubbed(reqs: StubRequest[]): string[] {
  return reqs.map((r) =>
    r.method === "CONNECT"
      ? `${r.stub}: CONNECT ${r.path} (refused, nothing sent)`
      : `${r.stub}: ${r.method} ${r.path} (stubbed, nothing created)`,
  );
}
