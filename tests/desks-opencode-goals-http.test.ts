import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { readOpencodeGoal, setOpencodeGoal } from "../src/desks/engines/opencode-goals.ts";

async function serve(handler: (req: IncomingMessage, res: ServerResponse, body: string) => void): Promise<{ url: string; server: Server }> {
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => handler(req, res, body));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, server };
}
const close = (s: Server) => new Promise<void>((r) => { s.closeAllConnections(); s.close(() => r()); });

describe("setOpencodeGoal (fake server)", () => {
  it("resolves once the marker appears (after 2 polls) and posts the goal command", async () => {
    let polls = 0;
    let posted: unknown;
    const { url, server } = await serve((req, res, body) => {
      if (req.method === "POST") { posted = { url: req.url, body: JSON.parse(body) }; return; } // blocks like opencode
      polls++;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(polls >= 3 ? [{ parts: [{ text: "New active goal: x" }] }] : []));
    });
    try {
      await setOpencodeGoal({ baseUrl: url, sessionId: "ses_1", objective: "--max-minutes 2 x", model: "ferry/super-flash", timeoutMs: 5000, pollMs: 20 });
      assert.equal(polls, 3);
      assert.deepEqual(posted, { url: "/session/ses_1/command", body: { command: "goal", arguments: "--max-minutes 2 x", model: "ferry/super-flash" } });
    } finally { await close(server); }
  });

  it("rejects after timeoutMs with the last message text when the marker never appears", async () => {
    const { url, server } = await serve((req, res) => {
      if (req.method === "POST") return;
      res.end(JSON.stringify([{ parts: [{ text: "just chatting" }] }]));
    });
    try {
      await assert.rejects(setOpencodeGoal({ baseUrl: url, sessionId: "s", objective: "x", timeoutMs: 150, pollMs: 20 }), /not active after 150 ms.*just chatting/s);
    } finally { await close(server); }
  });

  it("a poll cut off by the deadline keeps the last messages read in the error", async () => {
    // GET 1 is the baseline, GET 2 answers, every later GET hangs until the deadline aborts it.
    let gets = 0;
    const { url, server } = await serve((req, res) => {
      if (req.method === "POST") return;
      gets++;
      if (gets <= 2) res.end(JSON.stringify([{ parts: [{ text: "just chatting" }] }]));
    });
    try {
      await assert.rejects(setOpencodeGoal({ baseUrl: url, sessionId: "s", objective: "x", timeoutMs: 400, pollMs: 20 }), /not active after 400 ms.*just chatting/s);
      assert.ok(gets >= 3, `a later poll hung (gets=${gets})`);
    } finally { await close(server); }
  });

  it("rejects with the POST error when the command fails first", async () => {
    const { url, server } = await serve((req, res) => {
      if (req.method === "POST") { res.statusCode = 500; res.end("boom"); return; }
      res.end("[]");
    });
    try {
      await assert.rejects(setOpencodeGoal({ baseUrl: url, sessionId: "s", objective: "x", timeoutMs: 3000, pollMs: 20 }), /HTTP 500.*boom/s);
    } finally { await close(server); }
  });

  it("a second goal is not confirmed by the first goal's marker still in the history", async () => {
    // Session history already holds goal 1's marker; the goal 2 command hangs and adds nothing.
    const history = [{ info: { id: "msg_1", role: "assistant" }, parts: [{ text: "New active goal: first" }] }];
    const { url, server } = await serve((req, res) => {
      if (req.method === "POST") return;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(history));
    });
    try {
      await assert.rejects(setOpencodeGoal({ baseUrl: url, sessionId: "s", objective: "second", timeoutMs: 200, pollMs: 20 }), /not active after 200 ms/);
    } finally { await close(server); }
  });

  it("a second goal is confirmed by a marker in a message newer than the post", async () => {
    const history: unknown[] = [{ info: { id: "msg_1", role: "assistant" }, parts: [{ text: "New active goal: first" }] }];
    const { url, server } = await serve((req, res) => {
      if (req.method === "POST") {
        history.push({ info: { id: "msg_2", role: "assistant" }, parts: [{ text: "New active goal: second" }] });
        return;
      }
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(history));
    });
    try {
      await setOpencodeGoal({ baseUrl: url, sessionId: "s", objective: "second", timeoutMs: 2000, pollMs: 20 });
    } finally { await close(server); }
  });

  it("rejects when the server is unreachable", async () => {
    const { url, server } = await serve(() => {});
    await close(server);
    await assert.rejects(setOpencodeGoal({ baseUrl: url, sessionId: "s", objective: "x", timeoutMs: 1000, pollMs: 20 }));
  });
});

const PORT = 5651;
describe("opencode goal plugin (live)", { skip: process.env.ACH_DESKS_LIVE === "1" ? false : "set ACH_DESKS_LIVE=1" }, () => {
  it("sets a goal on a real opencode serve and reads it achieved", { timeout: 240_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), "ocgoals-live-"));
    let child: ChildProcess | undefined;
    try {
      child = spawn("opencode", ["serve", "--hostname", "127.0.0.1", "--port", String(PORT)], {
        cwd: dir, stdio: "ignore", env: { ...process.env, OPENCODE_CONFIG_CONTENT: JSON.stringify({ mcp: { toolbox: { enabled: false } } }) },
      });
      const base = `http://127.0.0.1:${PORT}`;
      for (let i = 0; i < 60; i++) {
        try { if ((await fetch(`${base}/session/status`)).ok) break; } catch { /* not up */ }
        await new Promise((r) => setTimeout(r, 500));
      }
      const r = await fetch(`${base}/session?directory=${encodeURIComponent(dir)}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "ocgoals" }) });
      const sessionId = ((await r.json()) as { id: string }).id;
      await setOpencodeGoal({ baseUrl: base, sessionId, objective: `--max-minutes 2 write the word DONE into ${dir}/out.txt`, model: "ferry/super-flash" });
      let state = "";
      for (let i = 0; i < 90; i++) {
        state = readOpencodeGoal({ dir, sessionId }).state;
        if (state === "achieved") break;
        await new Promise((r2) => setTimeout(r2, 2000));
      }
      assert.equal(state, "achieved");
      assert.ok(existsSync(join(dir, "out.txt")));
      assert.match(readFileSync(join(dir, "out.txt"), "utf8"), /DONE/);
    } finally {
      child?.kill("SIGTERM");
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
