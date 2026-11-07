// Offline guarantee for the pricing and stats tests (issue #40). A test file
// that does `import "./support/no-network.mjs"` as its first import runs with
// every outbound network primitive replaced by one that THROWS: global fetch,
// node:http/https request+get, TCP net.Socket.connect (and so tls, undici,
// ws) and dns.lookup. Unix-socket / IPC connects are left alone (tsx and the
// node:test runner use them), as is listen(): a test may still serve locally,
// it just may not call out.
//
// Child processes the test spawns inherit the guard through NODE_OPTIONS, so
// `ach stats` run as a subprocess is held to the same rule. A future fetch
// added to the pricing/stats path therefore fails CI instead of shipping.
import { createRequire, syncBuiltinESMExports } from "node:module";

const require = createRequire(import.meta.url);

export class NetworkBlocked extends Error {
  constructor(what) {
    super(`NetworkBlocked: a pricing/stats test attempted a network call (${what})`);
    this.name = "NetworkBlocked";
  }
}

const here = import.meta.url;
const flag = `--import=${here}`;
if (!(process.env.NODE_OPTIONS ?? "").includes(here)) {
  process.env.NODE_OPTIONS = `${process.env.NODE_OPTIONS ?? ""} ${flag}`.trim();
}

if (!globalThis.__achNoNetwork) {
  globalThis.__achNoNetwork = true;

  globalThis.fetch = async (input) => {
    throw new NetworkBlocked(`fetch ${typeof input === "string" ? input : (input?.url ?? String(input))}`);
  };

  for (const mod of ["node:http", "node:https"]) {
    const m = require(mod);
    for (const fn of ["request", "get"]) {
      m[fn] = () => {
        throw new NetworkBlocked(`${mod}.${fn}`);
      };
    }
  }

  const net = require("node:net");
  const realConnect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function (...args) {
    // net.connect(...) hands connect() a pre-normalized [options, cb] array.
    const a = Array.isArray(args[0]) ? args[0][0] : args[0];
    // A string first arg and an options object with `path` are unix-socket / IPC.
    const ipc = typeof a === "string" || (a !== null && typeof a === "object" && typeof a.path === "string");
    if (!ipc) throw new NetworkBlocked(`tcp connect ${typeof a === "object" ? `${a?.host ?? "localhost"}:${a?.port}` : String(a)}`);
    return realConnect.apply(this, args);
  };

  const dns = require("node:dns");
  dns.lookup = () => {
    throw new NetworkBlocked("dns.lookup");
  };

  syncBuiltinESMExports();
}
