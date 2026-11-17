// `ach desk ...` and `ach lane ...` (#204). Filled by the CLI/MCP seat.
//   ach desk up [--layout F] [--port-base N] [--term tmux|ghostty|none] [--tmux-session S] [--stack S]
//   ach desk down | attach [--term ...] | send <to> <text> | roster [--json] | inbox [name] [--json]
//   ach desk answer <Dn> <text> | decisions [--json] | engine <name> <agent> [--model M]
//   ach desk host --spec <file>        (internal: the per-desk host process)
//   ach desk chat <name>               (attach REPL for engines without a native TUI)
//   ach lane new <name> --goal "<objective>" [--agent A] [--model M] [--mcps a,b] [--cwd D] [--budget-usd N]
//   ach lane status [name] [--json] | stop <name> | approve <Ln> | reject <Ln> [--reason R]

export async function cmdDesk(_rest: string[]): Promise<number> {
  process.stderr.write("ach desk: not implemented yet\n");
  return 2;
}

export async function cmdLane(_rest: string[]): Promise<number> {
  process.stderr.write("ach lane: not implemented yet\n");
  return 2;
}
