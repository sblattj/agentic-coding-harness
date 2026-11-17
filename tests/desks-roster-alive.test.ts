// isEntryAlive does a real loopback fetch, which no-network.mjs blocks: kept out of desks-roster.test.ts.
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { isEntryAlive } from "../src/desks/roster.ts";
import type { RosterEntry } from "../src/desks/types.ts";

const e = (url: string, pid = process.pid): RosterEntry => ({
  name: "A", kind: "desk", role: "r", agent: "a", engine: "opencode", mcps: [], port: 1, url, pid, runId: "r", cwd: "/", startedAt: 1,
});

describe("isEntryAlive", () => {
  let server: Server;
  let url = "";
  before(async () => {
    server = createServer((req, res) => {
      if (req.url === "/health") {
        res.writeHead(200).end("{}");
      } else if (req.url === "/slow/health") {
        setTimeout(() => res.writeHead(200).end("{}"), 1500);
      } else {
        res.writeHead(500).end();
      }
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(() => {
    server.closeAllConnections();
    server.close();
  });

  it("alive: live pid and /health 2xx", async () => assert.equal(await isEntryAlive(e(url)), true));
  it("dead: pid does not exist", async () => assert.equal(await isEntryAlive(e(url, 2_147_483_000)), false));
  it("dead: /health is non-2xx", async () => assert.equal(await isEntryAlive(e(`${url}/nope`)), false));
  it("dead: /health slower than timeoutMs", async () => assert.equal(await isEntryAlive(e(`${url}/slow`), 200), false));
  it("dead: nothing listening", async () => {
    const s = createServer();
    await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
    const dead = `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
    await new Promise((r) => s.close(r));
    assert.equal(await isEntryAlive(e(dead)), false);
  });
});
