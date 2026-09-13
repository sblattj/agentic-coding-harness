// web — dashboard server CLI (src/web/server.ts over Bun.serve).
// Serves the live-run dashboard (HTML + /api/runs + ws tails) and opens the
// browser to it. Without a token (--token or env AGENTIC_CODING_HARNESS_HTTP_TOKEN)
// the server binds loopback only and runs unauthenticated with a stderr
// warning, mirroring serve.
import { spawnSync } from "node:child_process";
import { parseArgs } from "node:util";
import { HarnessError } from "../core/types.ts";
import { stateDir } from "../core/store.ts";
import { startWebServer, type WebServerHandle } from "../web/server.ts";

const DEFAULT_PORT = 8399;
const DEFAULT_HOST = "127.0.0.1";

function optPort(v: string | undefined, flag: string): number {
  const n = Number(v ?? DEFAULT_PORT);
  if (!Number.isInteger(n) || n < 0 || n > 65_535) {
    throw new HarnessError(`${flag} expects a port number 0-65535, got '${v}'`, "USAGE");
  }
  return n;
}

export async function cmdWeb(rest: string[]): Promise<number> {
  const args = parseArgs({
    args: rest,
    options: {
      port: { type: "string" },
      host: { type: "string" },
      token: { type: "string" },
      dir: { type: "string" },
      "no-open": { type: "boolean", default: false },
    },
    allowPositionals: true,
  });
  // Optional positional trials-dir: accepted for symmetry with `harness
  // report <trials-dir>` but unused — the dashboard reads the live registry
  // out of the state dir, not a trials tree.
  const [trialsDir] = args.positionals;
  if (trialsDir !== undefined) {
    process.stderr.write(`web: ignoring trials-dir '${trialsDir}' (dashboard reads the live registry)\n`);
  }

  const port = optPort(args.values.port, "--port");
  const dir = args.values.dir ?? stateDir();
  // CLI flag wins over env; when both are unset: warn + force loopback.
  const token = args.values.token ?? (process.env.AGENTIC_CODING_HARNESS_HTTP_TOKEN || undefined);
  let host = args.values.host ?? DEFAULT_HOST;
  if (token === undefined) {
    process.stderr.write("web: no token set — unauthenticated loopback only\n");
    host = DEFAULT_HOST;
  }

  const handle: WebServerHandle = startWebServer({ port, host, token, stateDir: dir });
  const url = `http://${host}:${handle.port}` + (token === undefined ? "" : `?token=${token}`);
  process.stderr.write(`web dashboard: http://${host}:${handle.port} (auth ${token === undefined ? "off" : "on"})\n`);

  if (!args.values["no-open"]) {
    try {
      if (process.platform === "darwin") {
        spawnSync("open", [url], { stdio: "ignore" });
      } else if (process.platform === "linux") {
        spawnSync("xdg-open", [url], { stdio: "ignore" });
      }
    } catch {
      // best-effort convenience; a failed browser launch never kills the server
    }
  }

  const stopped = new Promise<void>((resolve) => {
    let closing = false;
    const shutdown = (): void => {
      if (closing) return;
      closing = true;
      resolve();
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  });
  await stopped;
  await handle.close();
  return 0;
}
