// #139: ach smoke local stubs (src/core/smoke/stubs.ts). Real sockets, real curl.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import http from "node:http";
import net from "node:net";
import type { AddressInfo } from "node:net";
import { describe, it } from "node:test";

import { parseStubFlag, startStubs, summarizeStubbed } from "../src/core/smoke/stubs.ts";
import type { StubSet } from "../src/core/smoke/stubs.ts";

async function withStubs(
  specs: Parameters<typeof startStubs>[0],
  fn: (s: StubSet) => Promise<void>,
  opts?: Parameters<typeof startStubs>[1],
): Promise<void> {
  const s = await startStubs(specs, opts);
  try {
    await fn(s);
  } finally {
    await s.close();
  }
}

function call(base: string, method: string, path: string, body?: string): Promise<{ status: number; json: unknown }> {
  return new Promise((resolve, reject) => {
    const u = new URL(path, base);
    const req = http.request(u, { method }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        const t = Buffer.concat(chunks).toString("utf8");
        resolve({ status: res.statusCode ?? 0, json: t ? JSON.parse(t) : undefined });
      });
    });
    req.on("error", reject);
    req.end(body);
  });
}

function rawExchange(port: number, payload: string, until: RegExp): Promise<string> {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, "127.0.0.1", () => sock.write(payload));
    let buf = "";
    sock.on("data", (d) => {
      buf += d.toString("utf8");
      if (until.test(buf)) {
        sock.destroy();
        resolve(buf);
      }
    });
    sock.on("error", reject);
    sock.on("close", () => resolve(buf));
  });
}

const portOf = (url: string): number => Number(new URL(url).port);

function run(cmd: string, args: string[], env: Record<string, string>): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { env: { PATH: process.env.PATH ?? "", ...env }, timeout: 20000 }, (e, out, err) => {
      resolve({ code: e ? ((e as { code?: number }).code ?? 1) : 0, out, err });
    });
  });
}

describe("parseStubFlag", () => {
  it("parses name=ENV with a known preset", () => {
    assert.deepEqual(parseStubFlag("jira=JIRA_BASE_URL"), { name: "jira", envVar: "JIRA_BASE_URL", preset: "jira" });
  });
  it("unknown name=ENV is generic", () => {
    assert.deepEqual(parseStubFlag("acme=ACME_URL"), { name: "acme", envVar: "ACME_URL", preset: "generic" });
  });
  it("parses host patterns", () => {
    assert.deepEqual(parseStubFlag("host:api.example.com"), { name: "api.example.com", host: "api.example.com" });
    assert.deepEqual(parseStubFlag("host:*.atlassian.net"), { name: "*.atlassian.net", host: "*.atlassian.net" });
  });
  it("parses a bare preset", () => {
    assert.deepEqual(parseStubFlag("slack"), { name: "slack", preset: "slack" });
  });
  for (const bad of ["", "   ", "nope", "jira=", "jira=1BAD", "jira=A B", "=X", "host:", "host:bad host", "host:*", "host:a/b"]) {
    it(`rejects ${JSON.stringify(bad)} with USAGE`, () => {
      assert.throws(
        () => parseStubFlag(bad),
        (e: unknown) => (e as { code?: string }).code === "USAGE",
      );
    });
  }
});

describe("env stubs", () => {
  it("exports one base URL per envVar and no proxy env", async () => {
    await withStubs(
      [parseStubFlag("jira=JIRA_BASE_URL"), parseStubFlag("github=GH_API")],
      async (s) => {
        assert.deepEqual(Object.keys(s.env).sort(), ["GH_API", "JIRA_BASE_URL"]);
        assert.match(s.env.JIRA_BASE_URL!, /^http:\/\/127\.0\.0\.1:\d+$/);
        assert.notEqual(s.env.JIRA_BASE_URL, s.env.GH_API);
        assert.equal(s.proxyUrl, null);
      },
    );
  });

  it("jira: issue create + myself, recorded", async () => {
    await withStubs([parseStubFlag("jira=JIRA_BASE_URL")], async (s) => {
      const base = s.env.JIRA_BASE_URL!;
      for (const v of ["2", "3"]) {
        const r = await call(base, "POST", `/rest/api/${v}/issue?x=1`, '{"fields":{}}');
        assert.equal(r.status, 201);
        const j = r.json as { id: string; key: string; self: string };
        assert.match(j.key, /^STUB-\d+$/);
        assert.ok(j.id && j.self);
      }
      const me = await call(base, "GET", "/rest/api/2/myself");
      assert.deepEqual(me.json, { accountId: "stub", emailAddress: "stub@example.invalid" });
      const reqs = s.requests();
      assert.equal(reqs.length, 3);
      assert.equal(reqs[0]!.stub, "jira");
      assert.equal(reqs[0]!.method, "POST");
      assert.equal(reqs[0]!.path, "/rest/api/2/issue?x=1");
      assert.equal(reqs[0]!.body, '{"fields":{}}');
      assert.ok(!Number.isNaN(Date.parse(reqs[0]!.at)));
    });
  });

  it("first jira issue is STUB-1 / 10001", async () => {
    await withStubs([parseStubFlag("jira=J")], async (s) => {
      const r = await call(s.env.J!, "POST", "/rest/api/2/issue", "{}");
      assert.equal((r.json as { key: string }).key, "STUB-1");
      assert.equal((r.json as { id: string }).id, "10001");
    });
  });

  it("github: issue create + user", async () => {
    await withStubs([parseStubFlag("github=GH")], async (s) => {
      const r = await call(s.env.GH!, "POST", "/repos/o/r/issues", '{"title":"t"}');
      assert.equal(r.status, 201);
      assert.deepEqual(r.json, { number: 1, html_url: "http://stub.invalid/1" });
      assert.deepEqual((await call(s.env.GH!, "GET", "/user")).json, { login: "stub" });
      assert.equal(s.requests()[0]!.stub, "github");
    });
  });

  it("linear: graphql issueCreate", async () => {
    await withStubs([parseStubFlag("linear=LIN")], async (s) => {
      const r = await call(s.env.LIN!, "POST", "/graphql", '{"query":"mutation"}');
      assert.deepEqual(r.json, { data: { issueCreate: { success: true, issue: { id: "stub", identifier: "STUB-1" } } } });
      assert.equal(s.requests()[0]!.body, '{"query":"mutation"}');
    });
  });

  it("slack: bare preset gets SLACK_BASE_URL, chat.postMessage ok", async () => {
    await withStubs([parseStubFlag("slack")], async (s) => {
      const r = await call(s.env.SLACK_BASE_URL!, "POST", "/api/chat.postMessage", "{}");
      assert.deepEqual(r.json, { ok: true, ts: "1.0" });
    });
  });

  it("generic: POST/PUT/PATCH 201 with incrementing ids, GET 200, DELETE 204", async () => {
    await withStubs([parseStubFlag("acme=ACME")], async (s) => {
      const b = s.env.ACME!;
      assert.deepEqual((await call(b, "POST", "/a", "x")).json, { id: "stub-1" });
      const put = await call(b, "PUT", "/a");
      assert.equal(put.status, 201);
      assert.deepEqual(put.json, { id: "stub-2" });
      assert.equal((await call(b, "PATCH", "/a")).status, 201);
      const g = await call(b, "GET", "/a");
      assert.equal(g.status, 200);
      assert.deepEqual(g.json, {});
      assert.equal((await call(b, "DELETE", "/a")).status, 204);
      assert.deepEqual(s.requests().map((r) => r.method), ["POST", "PUT", "PATCH", "GET", "DELETE"]);
    });
  });

  it("caps recorded bodies at 8 KB", async () => {
    await withStubs([parseStubFlag("acme=ACME")], async (s) => {
      await call(s.env.ACME!, "POST", "/big", "a".repeat(20000));
      assert.equal(s.requests()[0]!.body.length, 8192);
    });
  });

  it("a real curl honours the env var and the request is recorded", async () => {
    await withStubs([parseStubFlag("jira=JIRA_BASE_URL")], async (s) => {
      const r = await run(
        "sh",
        ["-c", `curl -s -X POST "$JIRA_BASE_URL/rest/api/2/issue" -d '{}'`],
        s.env,
      );
      assert.equal(r.code, 0, r.err);
      assert.match(r.out, /"key":"STUB-1"/);
      const reqs = s.requests();
      assert.equal(reqs.length, 1);
      assert.equal(reqs[0]!.method, "POST");
      assert.equal(reqs[0]!.path, "/rest/api/2/issue");
      assert.equal(reqs[0]!.body, "{}");
    });
  });
});

describe("host proxy", () => {
  it("sets proxy env only when a host spec or blockHosts exists", async () => {
    await withStubs([parseStubFlag("host:blocked.example.test")], async (s) => {
      assert.ok(s.proxyUrl);
      for (const k of ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"]) assert.equal(s.env[k], s.proxyUrl);
      assert.equal(s.env.NO_PROXY, "127.0.0.1,localhost");
      assert.equal(s.env.no_proxy, "127.0.0.1,localhost");
    });
    await withStubs([], async (s) => assert.ok(s.proxyUrl), { blockHosts: ["x.example.test"] });
    await withStubs([], async (s) => assert.equal(s.proxyUrl, null));
  });

  it("refuses a matching CONNECT with 403 and records it", async () => {
    await withStubs([parseStubFlag("host:*.atlassian.net")], async (s) => {
      const out = await rawExchange(
        portOf(s.proxyUrl!),
        "CONNECT acme.atlassian.net:443 HTTP/1.1\r\nHost: acme.atlassian.net:443\r\n\r\n",
        /ach smoke/,
      );
      assert.match(out, /^HTTP\/1\.1 403 Forbidden/);
      assert.match(out, /ach smoke/);
      const reqs = s.requests();
      assert.equal(reqs.length, 1);
      assert.equal(reqs[0]!.method, "CONNECT");
      assert.equal(reqs[0]!.path, "acme.atlassian.net:443");
      assert.equal(reqs[0]!.stub, "*.atlassian.net");
    });
  });

  it("*. glob refuses subdomains and tunnels non-matching hosts", async () => {
    // Uses *.localhost so nothing resolves off-machine: a non-matching host tunnels to a dead local port.
    await withStubs([parseStubFlag("host:*.localhost")], async (s) => {
      const dead = net.createServer();
      await new Promise<void>((r) => dead.listen(0, "127.0.0.1", r));
      const p = (dead.address() as AddressInfo).port;
      await new Promise<void>((r) => dead.close(() => r()));
      const apex = await rawExchange(portOf(s.proxyUrl!), `CONNECT 127.0.0.1:${p} HTTP/1.1\r\n\r\n`, /502/);
      assert.match(apex, /502/);
      assert.equal(s.requests().length, 0);
      const sub = await rawExchange(portOf(s.proxyUrl!), `CONNECT a.localhost:${p} HTTP/1.1\r\n\r\n`, /ach smoke/);
      assert.match(sub, /403/);
      assert.equal(s.requests().length, 1);
    });
  });

  it("tunnels a non-matching CONNECT to a local echo server", async () => {
    const echo = net.createServer((c) => c.on("data", (d) => c.write(d)).on("error", () => {}));
    await new Promise<void>((r) => echo.listen(0, "127.0.0.1", r));
    const echoPort = (echo.address() as AddressInfo).port;
    try {
      await withStubs([parseStubFlag("host:blocked.example.test")], async (s) => {
        const out = await rawExchange(
          portOf(s.proxyUrl!),
          `CONNECT 127.0.0.1:${echoPort} HTTP/1.1\r\n\r\nping-through-tunnel`,
          /ping-through-tunnel/,
        );
        assert.match(out, /^HTTP\/1\.1 200/);
        assert.match(out, /ping-through-tunnel/);
        assert.equal(s.requests().length, 0);
      });
    } finally {
      echo.close();
    }
  });

  it("a failing tunnel target does not crash the proxy", async () => {
    await withStubs([parseStubFlag("host:blocked.example.test")], async (s) => {
      const dead = net.createServer();
      await new Promise<void>((r) => dead.listen(0, "127.0.0.1", r));
      const p = (dead.address() as AddressInfo).port;
      await new Promise<void>((r) => dead.close(() => r()));
      const out = await rawExchange(portOf(s.proxyUrl!), `CONNECT 127.0.0.1:${p} HTTP/1.1\r\n\r\n`, /502/);
      assert.match(out, /502/);
      // proxy still serves
      const again = await rawExchange(portOf(s.proxyUrl!), "CONNECT blocked.example.test:443 HTTP/1.1\r\n\r\n", /ach smoke/);
      assert.match(again, /403/);
    });
  });

  it("answers plain-HTTP proxied requests to a matching host locally", async () => {
    await withStubs([parseStubFlag("host:api.example.test")], async (s) => {
      const out = await rawExchange(
        portOf(s.proxyUrl!),
        "POST http://api.example.test/v1/things?a=b HTTP/1.1\r\nHost: api.example.test\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}",
        /stub-1/,
      );
      assert.match(out, /^HTTP\/1\.1 201/);
      assert.match(out, /"id":"stub-1"/);
      const r = s.requests();
      assert.equal(r.length, 1);
      assert.equal(r[0]!.path, "/v1/things?a=b");
      assert.equal(r[0]!.body, "{}");
      assert.equal(r[0]!.stub, "api.example.test");
    });
  });

  it("forwards plain-HTTP proxied requests to other hosts", async () => {
    const origin = http.createServer((_q, res) => res.end("origin-ok"));
    await new Promise<void>((r) => origin.listen(0, "127.0.0.1", r));
    const op = (origin.address() as AddressInfo).port;
    try {
      await withStubs([parseStubFlag("host:api.example.test")], async (s) => {
        const out = await rawExchange(
          portOf(s.proxyUrl!),
          `GET http://127.0.0.1:${op}/x HTTP/1.1\r\nHost: 127.0.0.1:${op}\r\nConnection: close\r\n\r\n`,
          /origin-ok/,
        );
        assert.match(out, /origin-ok/);
        assert.equal(s.requests().length, 0);
      });
    } finally {
      origin.close();
    }
  });

  it("a real curl through HTTPS_PROXY gets a proxy refusal and the CONNECT is recorded", async () => {
    await withStubs([parseStubFlag("host:blocked.example.test")], async (s) => {
      const r = await run(
        "sh",
        ["-c", `curl -s -S -o /dev/null -w '%{http_code}' --max-time 10 https://blocked.example.test`],
        s.env,
      );
      assert.notEqual(r.code, 0, "curl must fail");
      assert.match(r.err, /CONNECT tunnel failed|403/i);
      assert.equal(r.out, "000");
      const reqs = s.requests();
      assert.equal(reqs.length, 1);
      assert.equal(reqs[0]!.method, "CONNECT");
      assert.equal(reqs[0]!.path, "blocked.example.test:443");
    });
  });
});

describe("close", () => {
  it("is idempotent and leaves no listening ports", async () => {
    const s = await startStubs([parseStubFlag("jira=J"), parseStubFlag("host:x.example.test")]);
    const ports = [portOf(s.env.J!), portOf(s.proxyUrl!)];
    // hold an open keep-alive connection: close() must destroy it
    const held = net.connect(ports[0]!, "127.0.0.1");
    await new Promise<void>((r) => held.once("connect", () => r()));
    held.on("error", () => {});
    await s.close();
    await s.close();
    for (const p of ports) {
      await assert.rejects(
        new Promise<void>((res, rej) => {
          const c = net.connect(p, "127.0.0.1", () => {
            c.destroy();
            res();
          });
          c.on("error", rej);
        }),
        /ECONNREFUSED/,
      );
    }
    assert.ok(held.destroyed || held.readyState !== "open");
  });
});

describe("summarizeStubbed", () => {
  it("writes one human line per request", () => {
    const at = new Date().toISOString();
    assert.deepEqual(
      summarizeStubbed([
        { stub: "jira", method: "POST", path: "/rest/api/2/issue", body: "{}", at },
        { stub: "*.atlassian.net", method: "CONNECT", path: "a.atlassian.net:443", body: "", at },
      ]),
      [
        "jira: POST /rest/api/2/issue (stubbed, nothing created)",
        "*.atlassian.net: CONNECT a.atlassian.net:443 (refused, nothing sent)",
      ],
    );
  });
});
