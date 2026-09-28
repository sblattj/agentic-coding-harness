// Cross-platform process helpers (#39). Everything here is a pure function of
// (platform, env, filesystem probe) so the win32 branches are unit-testable on
// any host: tests pass `platform: "win32"` and a fake `isFile`, and the path
// arithmetic runs through path.win32 regardless of the machine.
//
// POSIX behavior is deliberately the pre-#39 behavior, unchanged:
//   - commands resolve through PATH split on ':' with an X_OK check;
//   - shell strings run through `/bin/sh -c`;
//   - spawn targets pass through untouched.
// Windows differences handled here:
//   - PATH is spelled `Path` in a copied env object and splits on ';';
//   - bare names resolve through PATHEXT (.COM;.EXE;.BAT;.CMD by default), so
//     npm-installed agent CLIs (`codex.cmd`, `gemini.cmd`) are found;
//   - `.cmd`/`.bat` targets cannot be spawned directly (Node refuses them
//     without a shell since the CVE-2024-27980 fix), so they are wrapped in
//     `cmd.exe /d /s /c "..."` with every argument escaped for cmd.exe;
//   - shell strings run through `%ComSpec% /d /s /c`.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface PlatformOptions {
  /** Defaults to process.platform. */
  platform?: NodeJS.Platform;
  /** Defaults to process.env. */
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  /**
   * Existence/executability probe for a candidate path. Defaults to a real
   * filesystem check (a regular file, plus X_OK on POSIX).
   */
  isFile?: (p: string) => boolean;
}

export interface SpawnTarget {
  command: string;
  args: string[];
  /** Set for cmd.exe invocations whose argument string is pre-quoted. */
  windowsVerbatimArguments?: boolean;
}

const DEFAULT_PATHEXT = ".COM;.EXE;.BAT;.CMD";

function pathApi(platform: NodeJS.Platform): path.PlatformPath {
  return platform === "win32" ? path.win32 : path.posix;
}

function defaultIsFile(platform: NodeJS.Platform): (p: string) => boolean {
  return (p) => {
    try {
      if (!fs.statSync(p).isFile()) return false;
      if (platform !== "win32") fs.accessSync(p, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  };
}

/**
 * Read an env var the way the platform does: case-insensitively on win32
 * (a copied env object keeps Windows' own `Path` spelling), exactly elsewhere.
 */
export function getEnvVar(
  name: string,
  env: PlatformOptions["env"] = process.env,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  if (platform !== "win32") return env[name];
  if (env[name] !== undefined) return env[name];
  const upper = name.toUpperCase();
  for (const [k, v] of Object.entries(env)) {
    if (k.toUpperCase() === upper) return v;
  }
  return undefined;
}

/** True when `cmd` names a path (has a separator) rather than a bare name. */
function hasSeparator(cmd: string, platform: NodeJS.Platform): boolean {
  return platform === "win32" ? /[\\/]/.test(cmd) : cmd.includes("/");
}

/**
 * Resolve a command the way the OS would launch it: a path is checked as-is,
 * a bare name is searched on PATH (plus PATHEXT on win32). Returns the
 * absolute path, or undefined when nothing executable matches.
 */
export function resolveCommand(cmd: string, opts: PlatformOptions = {}): string | undefined {
  const platform = opts.platform ?? process.platform;
  const env = opts.env ?? process.env;
  const isFile = opts.isFile ?? defaultIsFile(platform);
  const p = pathApi(platform);
  if (cmd === "") return undefined;

  if (platform !== "win32") {
    if (cmd.includes("/")) return isFile(cmd) ? p.resolve(cmd) : undefined;
    for (const dir of (env.PATH ?? "").split(p.delimiter)) {
      if (dir === "") continue;
      const candidate = p.join(dir, cmd);
      if (isFile(candidate)) return candidate;
    }
    return undefined;
  }

  const exts = (getEnvVar("PATHEXT", env, platform) ?? DEFAULT_PATHEXT)
    .split(";")
    .map((e) => e.trim())
    .filter((e) => e !== "");
  const hasExt = exts.some((e) => cmd.toLowerCase().endsWith(e.toLowerCase()));
  // Lower-cased: NTFS is case-insensitive, and the conventional spelling reads better in logs.
  const variants = (base: string): string[] => [...(hasExt ? [base] : []), ...exts.map((e) => base + e.toLowerCase())];

  if (hasSeparator(cmd, platform)) {
    for (const v of variants(p.normalize(cmd))) if (isFile(v)) return p.resolve(v);
    return undefined;
  }
  const dirs = (getEnvVar("PATH", env, platform) ?? "")
    .split(";")
    .map((d) => d.replace(/^"(.*)"$/, "$1"))
    .filter((d) => d !== "");
  for (const dir of dirs) {
    for (const v of variants(p.join(dir, cmd))) if (isFile(v)) return v;
  }
  return undefined;
}

/**
 * cmd.exe's absolute path: the child env's ComSpec, else this process's
 * (a minimal child env such as { PATH, HOME } must still find cmd.exe,
 * because spawn searches the CHILD's PATH), else the bare name.
 */
function comspecFor(env: PlatformOptions["env"], platform: NodeJS.Platform): string {
  return (
    (env !== undefined ? getEnvVar("ComSpec", env, platform) : undefined) ??
    getEnvVar("ComSpec", process.env, platform) ??
    system32Exe("cmd.exe", env, platform)
  );
}

/**
 * Absolute path of a Windows system binary (`cmd.exe`, `taskkill.exe`) under
 * %SystemRoot%\System32, so it launches even from a minimal env whose PATH
 * lacks System32 (and whose ComSpec was not passed through).
 */
export function system32Exe(
  exe: string,
  env: PlatformOptions["env"] = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  const root =
    (env !== undefined ? getEnvVar("SystemRoot", env, platform) ?? getEnvVar("windir", env, platform) : undefined) ??
    getEnvVar("SystemRoot", process.env, platform) ??
    getEnvVar("windir", process.env, platform) ??
    "C:\\Windows";
  return path.win32.join(root, "System32", exe);
}

/**
 * The user's home directory. POSIX: os.homedir(), which already honours
 * $HOME. win32: $HOME when set (Git Bash / MSYS users and the test suite set
 * it; os.homedir() ignores it there), else os.homedir() (USERPROFILE).
 */
export function homeDir(
  env: PlatformOptions["env"] = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform === "win32") {
    const home = getEnvVar("HOME", env, platform);
    if (home !== undefined && home !== "") return home;
  }
  return os.homedir();
}

/** Expand a leading `~` / `~/` (and `~\` on win32) against homeDir(). */
export function expandHome(
  p: string,
  env: PlatformOptions["env"] = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  if (p === "~") return homeDir(env, platform);
  if (p.startsWith("~/") || (platform === "win32" && p.startsWith("~\\"))) {
    return pathApi(platform).join(homeDir(env, platform), p.slice(2));
  }
  return p;
}

/** The platform's command interpreter for a shell string. */
export function shellCommand(script: string, opts: Pick<PlatformOptions, "platform" | "env"> = {}): SpawnTarget {
  const platform = opts.platform ?? process.platform;
  if (platform !== "win32") return { command: "/bin/sh", args: ["-c", script] };
  const comspec = comspecFor(opts.env, platform);
  return { command: comspec, args: ["/d", "/s", "/c", `"${script}"`], windowsVerbatimArguments: true };
}

// cmd.exe metacharacters, escaped with ^ (the cross-spawn rule set).
const CMD_META = /([()\][%!^"`<>&|;, *?])/g;

/** Escape one argument for a `cmd.exe /d /s /c "..."` command line. */
export function escapeCmdArgument(arg: string, doubleEscape = false): string {
  // First quote for the target's CommandLineToArgvW parser: double the
  // backslashes that precede a quote or the end, and escape the quotes.
  let s = arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, "$1$1");
  s = `"${s}"`;
  // Then protect every metacharacter from cmd.exe itself. A batch file that
  // forwards `%*` re-parses its arguments once more, so it needs it twice.
  s = s.replace(CMD_META, "^$1");
  if (doubleEscape) s = s.replace(CMD_META, "^$1");
  return s;
}

/** Escape the command path itself for a cmd.exe command line. */
export function escapeCmdCommand(cmd: string): string {
  return cmd.replace(CMD_META, "^$1");
}

/**
 * Make `child.kill()` take down the whole process tree on Windows.
 *
 * Windows has no signals: node's kill() is TerminateProcess on the direct
 * child only. When the child is cmd.exe running an npm shim (or any agent CLI
 * that spawns helpers), the grandchild keeps the stdout pipe open, so the
 * run never sees 'close' and an abort/timeout hangs. `taskkill /T /F` kills
 * the tree. POSIX: returns the child untouched (SIGTERM → trap → SIGKILL
 * escalation semantics are unchanged).
 */
export function withTreeKill<T extends { pid?: number | undefined; kill(signal?: NodeJS.Signals | number): boolean }>(
  child: T,
  platform: NodeJS.Platform = process.platform,
): T {
  if (platform !== "win32") return child;
  const original = child.kill.bind(child);
  child.kill = (signal?: NodeJS.Signals | number): boolean => {
    if (child.pid === undefined) return original(signal);
    const r = spawnSync(system32Exe("taskkill.exe"), ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    return r.status === 0 || original(signal);
  };
  return child;
}

/**
 * The (command, args) to hand node's spawn with shell:false so `command`
 * launches the same way on every OS. POSIX: unchanged. win32: resolve through
 * PATH/PATHEXT; a batch file (.cmd/.bat, e.g. an npm-installed agent CLI) is
 * wrapped in cmd.exe with escaped arguments; an unresolvable name passes
 * through so spawn reports its usual ENOENT.
 */
export function spawnTarget(command: string, args: readonly string[], opts: PlatformOptions = {}): SpawnTarget {
  const platform = opts.platform ?? process.platform;
  if (platform !== "win32") return { command, args: [...args] };

  // An explicit cmd.exe /d /s /c invocation (from shellCommand) is already
  // quoted for cmd; keep it verbatim.
  const base = path.win32.basename(command).toLowerCase();
  if ((base === "cmd.exe" || base === "cmd") && args[0] === "/d" && args[1] === "/s" && args[2] === "/c") {
    return { command, args: [...args], windowsVerbatimArguments: true };
  }

  const resolved = resolveCommand(command, opts);
  if (resolved === undefined) return { command, args: [...args] };
  if (!/\.(cmd|bat)$/i.test(resolved)) return { command: resolved, args: [...args] };

  // Double-escape for every batch file, not only node_modules/.bin shims (the
  // cross-spawn rule): agent CLIs installed with `npm i -g` are the same
  // cmd-shim form under %APPDATA%\npm, and a shim forwards `%*` into a second
  // cmd.exe parse. Single escaping lets a `"` inside a prompt flip cmd's quote
  // state so a later `&`/`|` escapes on that second parse.
  const line = [escapeCmdCommand(path.win32.normalize(resolved)), ...args.map((a) => escapeCmdArgument(a, true))].join(" ");
  const comspec = comspecFor(opts.env, platform);
  return { command: comspec, args: ["/d", "/s", "/c", `"${line}"`], windowsVerbatimArguments: true };
}
