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
  return script === undefined ? [process.execPath] : [process.execPath, ...process.execArgv, script];
}
