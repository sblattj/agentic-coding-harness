// `ach desk ...` and `ach lane ...` (#204). Filled by the CLI/MCP seat.
//   ach desk up [--layout F] [--port-base N] [--term tmux|ghostty|none] [--tmux-session S] [--stack S]
//   ach desk down | attach [--term ...] | send <to> <text> | roster [--json] | inbox [name] [--json]
//   ach desk answer <Dn> <text> | decisions [--json] | engine <name> <agent> [--model M]
//   ach desk host --spec <file>        (internal: the per-desk host process)
//   ach desk chat <name>               (attach REPL for engines without a native TUI)
//   ach lane new <name> --goal "<objective>" [--agent A] [--model M] [--mcps a,b] [--cwd D] [--budget-usd N]
//   ach lane status [name] [--json] | stop <name> | approve <Ln> | reject <Ln> [--reason R]
import { readFileSync } from "node:fs";
import type { HostSpec } from "../desks/types.ts";

/** `ach desk host --spec <file>`: the per-desk host process (src/desks/host.ts). */
async function cmdDeskHost(args: string[]): Promise<number> {
  let specFile: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    if (a === "--spec") specFile = args[++i];
    else if (a.startsWith("--spec=")) specFile = a.slice("--spec=".length);
    else {
      process.stderr.write(`ach desk host: unexpected argument ${JSON.stringify(a)}\nusage: ach desk host --spec <file>\n`);
      return 2;
    }
  }
  if (specFile === undefined || specFile === "") {
    process.stderr.write("usage: ach desk host --spec <file>\n");
    return 2;
  }
  let spec: HostSpec;
  try {
    spec = JSON.parse(readFileSync(specFile, "utf8")) as HostSpec;
  } catch (e) {
    process.stderr.write(`ach desk host: cannot read spec ${specFile}: ${e instanceof Error ? e.message : String(e)}\n`);
    return 2;
  }
  const { runHost } = await import("../desks/host.ts");
  return runHost(spec);
}

export async function cmdDesk(rest: string[]): Promise<number> {
  const [sub, ...args] = rest;
  if (sub === "host") return cmdDeskHost(args);
  process.stderr.write("ach desk: not implemented yet\n");
  return 2;
}

export async function cmdLane(_rest: string[]): Promise<number> {
  process.stderr.write("ach lane: not implemented yet\n");
  return 2;
}
