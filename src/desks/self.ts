// How a desk process re-invokes ach itself (#204): hosts, the `ach mcp` desk
// tools inside engines, and `ach desk chat` panes all need the same argv.
// $ACH_SELF_ARGV (a JSON string array) wins, so tests and bundles can pin it.

export function achSelfArgv(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = env.ACH_SELF_ARGV;
  if (raw !== undefined && raw !== "") {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length === 0 || !parsed.every((x) => typeof x === "string")) {
      throw new Error("ACH_SELF_ARGV must be a non-empty JSON array of strings");
    }
    return parsed as string[];
  }
  const script = process.argv[1];
  // A bun-compiled binary reports a virtual /$bunfs/root/<name> (B:/~BUN/ on Windows) as
  // argv[1]; passing it back would reach the CLI as a stray argument.
  const compiled = script === undefined || script.startsWith("/$bunfs/") || script.startsWith("B:/~BUN/");
  return compiled ? [process.execPath] : [process.execPath, ...process.execArgv, script];
}

/**
 * The `desks` MCP server every desk/lane engine gets: `ach mcp` over stdio with
 * the desk identity in env. Frozen in wave 0; both engines use it.
 */
export function desksMcpDef(o: { name: string; stack: string; stateDir: string }, env: NodeJS.ProcessEnv = process.env): {
  command: string;
  args: string[];
  env: Record<string, string>;
} {
  const [command, ...rest] = achSelfArgv(env);
  return {
    command: command as string,
    args: [...rest, "mcp"],
    env: { ACH_DESK_NAME: o.name, ACH_DESK_STACK: o.stack, AGENTIC_CODING_HARNESS_STATE_DIR: o.stateDir },
  };
}
