// web — dashboard server CLI (src/web/server.ts over node:http + ws; one
// code path under Bun and Node).
// Serves the live-run dashboard (HTML + /api/runs + ws tails) and opens the
// browser to it. Without a token (--token or env AGENTIC_CODING_HARNESS_HTTP_TOKEN)
// the server binds loopback only and runs unauthenticated with a stderr
// warning, mirroring serve.
import { spawnSync } from "node:child_process";
import { parseArgs } from "node:util";
import { HarnessError } from "../core/types.ts";
import { stateDir } from "../core/store.ts";
import { describeListenError } from "./serve.ts";
import { startWebServer, type WebServerHandle } from "../web/server.ts";
import { FsRunSource, type RunSource } from "../web/run-source.ts";
import { HttpRunSource } from "../web/run-source-http.ts";
import { MergedRunSource } from "../web/run-source-merged.ts";

const DEFAULT_PORT = 8399;
const DEFAULT_HOST = "127.0.0.1";

function optPort(v: string | undefined, flag: string): number {
  const n = Number(v ?? DEFAULT_PORT);
  if (!Number.isInteger(n) || n < 0 || n > 65_535) {
    throw new HarnessError(`${flag} expects a port number 0-65535, got '${v}'`, "USAGE");
  }
  return n;
}

// ---------------------------------------------------------------- source flags

/** Raw --source-* flag values plus the dashboard token (fallback for
 *  --source-token). Kept as a plain input record so resolution is testable
 *  without a CLI process. */
export interface SourceFlagValues {
  source?: string;
  "source-token"?: string;
  "source-mode"?: string;
  "source-poll-ms"?: string;
  "source-merge"?: string;
  token?: string;
}

/** Resolved external run source (spec §5.1): null when none is configured. */
export interface ResolvedSourceOptions {
  url: string;
  host: string;
  token: string | undefined;
  mode: "poll" | "sse" | "ws";
  pollMs: number;
  merge: "state" | "only";
}

const SOURCE_ENV = {
  source: "AGENTIC_CODING_HARNESS_SOURCE",
  "source-token": "AGENTIC_CODING_HARNESS_SOURCE_TOKEN",
  "source-mode": "AGENTIC_CODING_HARNESS_SOURCE_MODE",
  "source-poll-ms": "AGENTIC_CODING_HARNESS_SOURCE_POLL_MS",
  "source-merge": "AGENTIC_CODING_HARNESS_SOURCE_MERGE",
} as const;

/** CLI flag wins over its env default; the returned label names the winner
 *  (flag or env var) for error messages. */
function flagOrEnv(flags: SourceFlagValues, env: EnvLookup, key: keyof typeof SOURCE_ENV): {
  value: string | undefined;
  label: string;
} {
  const flagVal = flags[key];
  if (flagVal !== undefined) return { value: flagVal, label: `--${key}` };
  const envVal = env[SOURCE_ENV[key]];
  if (envVal !== undefined && envVal !== "") return { value: envVal, label: SOURCE_ENV[key] };
  return { value: undefined, label: `--${key}` };
}

type EnvLookup = Record<string, string | undefined>;

/** Validate + resolve the --source-* option set (flag > env per key).
 *  Returns null when no source is configured; throws HarnessError("USAGE")
 *  on any invalid combination. Pure: no process.env reads, no side effects. */
export function resolveSourceOptions(flags: SourceFlagValues, env: EnvLookup): ResolvedSourceOptions | null {
  const source = flagOrEnv(flags, env, "source");
  const sourceToken = flagOrEnv(flags, env, "source-token");
  const sourceMode = flagOrEnv(flags, env, "source-mode");
  const sourcePollMs = flagOrEnv(flags, env, "source-poll-ms");
  const sourceMerge = flagOrEnv(flags, env, "source-merge");

  if (source.value === undefined) {
    // A token/mode/poll cadence/merge without a source URL configures
    // nothing — reject it instead of silently ignoring it.
    for (const f of [sourceToken, sourceMode, sourcePollMs, sourceMerge]) {
      if (f.value !== undefined) {
        throw new HarnessError(`${f.label} requires --source`, "USAGE");
      }
    }
    return null;
  }

  let parsed: URL;
  try {
    parsed = new URL(source.value);
  } catch {
    throw new HarnessError(
      `${source.label} expects an absolute http(s) URL, got '${source.value}'`,
      "USAGE",
    );
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new HarnessError(
      `${source.label} expects an absolute http(s) URL, got '${source.value}'`,
      "USAGE",
    );
  }

  if (sourceMode.value !== undefined && sourceMode.value !== "poll" && sourceMode.value !== "sse" && sourceMode.value !== "ws") {
    throw new HarnessError(`${sourceMode.label} expects poll|sse|ws, got '${sourceMode.value}'`, "USAGE");
  }
  const mode = (sourceMode.value ?? "poll") as "poll" | "sse" | "ws";

  let pollMs = 3000;
  if (sourcePollMs.value !== undefined) {
    const n = Number(sourcePollMs.value);
    if (!Number.isInteger(n) || n < 250) {
      throw new HarnessError(
        `${sourcePollMs.label} expects an integer >= 250, got '${sourcePollMs.value}'`,
        "USAGE",
      );
    }
    pollMs = n;
  }

  if (sourceMerge.value !== undefined && sourceMerge.value !== "state" && sourceMerge.value !== "only") {
    throw new HarnessError(`${sourceMerge.label} expects state|only, got '${sourceMerge.value}'`, "USAGE");
  }
  const merge = (sourceMerge.value ?? "only") as "state" | "only";

  // The feed token falls back to the dashboard token (spec §5.1/§9).
  const token = sourceToken.value ?? flags.token;

  return { url: parsed.toString(), host: parsed.host, token, mode, pollMs, merge };
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
      source: { type: "string" },
      "source-token": { type: "string" },
      "source-mode": { type: "string" },
      "source-poll-ms": { type: "string" },
      "source-merge": { type: "string" },
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

  const source = resolveSourceOptions(
    {
      source: args.values.source,
      "source-token": args.values["source-token"],
      "source-mode": args.values["source-mode"],
      "source-poll-ms": args.values["source-poll-ms"],
      "source-merge": args.values["source-merge"],
      token,
    },
    process.env,
  );
  let runSource: RunSource | undefined;
  let sourceUrl: string | undefined;
  if (source !== null) {
    // Spec §9: log the resolved host once the source is validated.
    process.stderr.write(
      `web: external run source ${source.host} (mode ${source.mode}, merge ${source.merge})\n`,
    );
    const httpSource = new HttpRunSource({
      url: source.url,
      token: source.token,
      mode: source.mode,
      pollMs: source.pollMs,
    });
    // merge=state: local registry first, external feed LAST so it wins
    // runId collisions. merge=only: the hub consumes just the feed.
    runSource =
      source.merge === "state" ? new MergedRunSource([new FsRunSource(dir), httpSource]) : httpSource;
    sourceUrl = source.url;
  }

  let handle: WebServerHandle;
  try {
    handle = await startWebServer(
      runSource === undefined
        ? { port, host, token, stateDir: dir }
        : { port, host, token, stateDir: dir, runSource, sourceUrl },
    );
  } catch (err) {
    const described = describeListenError(err, host, port);
    if (described !== null) {
      process.stderr.write(described.replace(/^serve:/, "web:") + "\n");
      return 1;
    }
    throw err;
  }
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
