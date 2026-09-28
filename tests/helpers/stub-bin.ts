// Fake agent binaries written as POSIX sh scripts, launchable on every OS
// (#39). On macOS/Linux the script itself is the executable (shebang +
// chmod 755). On Windows a sibling `<name>.cmd` forwards to Git for Windows'
// sh.exe, so a bare `<name>` resolves through PATHEXT to the .cmd and the
// harness's real launch path (src/core/platform.ts spawnTarget → cmd.exe →
// the stub) is exercised end to end, exactly like an npm-installed agent CLI.
import { chmodSync, writeFileSync } from "node:fs";
import path from "node:path";
import { resolveCommand } from "../../src/core/platform.ts";

const isWin = process.platform === "win32";

function findWindowsSh(): string | undefined {
  const onPath = resolveCommand("sh");
  if (onPath !== undefined) return onPath;
  for (const p of ["C:\\Program Files\\Git\\usr\\bin\\sh.exe", "C:\\Program Files\\Git\\bin\\sh.exe"]) {
    const r = resolveCommand(p);
    if (r !== undefined) return r;
  }
  return undefined;
}

const WINDOWS_SH = isWin ? findWindowsSh() : undefined;

/**
 * `false` when sh stubs can run here, else a skip reason for node:test.
 * On Windows this needs Git for Windows (preinstalled on GitHub runners).
 */
export const SH_STUB_SKIP: false | string =
  isWin && WINDOWS_SH === undefined ? "sh stubs need Git for Windows' sh.exe on Windows" : false;

/**
 * Write `script` (a POSIX sh body; a `#!/bin/sh` line is added when absent)
 * to `file` and make it launchable. Returns `file`, the path to hand the
 * harness (a bare name on PATH works too, via PATHEXT on Windows).
 */
export function writeShStub(file: string, script: string): string {
  const body = script.startsWith("#!") ? script : `#!/bin/sh\n${script}`;
  writeFileSync(file, body);
  chmodSync(file, 0o755);
  if (isWin) {
    if (WINDOWS_SH === undefined) throw new Error(SH_STUB_SKIP || "no sh.exe");
    // %~dpn0 = this .cmd's own path minus the extension = the sh script.
    // sh's own dir goes on PATH so the script's cat/touch/sleep resolve even
    // when a test pins PATH to a fake-bin dir.
    const shDir = path.win32.dirname(WINDOWS_SH);
    writeFileSync(`${file}.cmd`, `@set "PATH=%PATH%;${shDir}"\r\n@"${WINDOWS_SH}" "%~dpn0" %*\r\n`);
  }
  return file;
}

/** Prepend `dir` to a PATH value with the platform's delimiter. */
export function prependPath(dir: string, pathValue: string | undefined): string {
  return pathValue ? `${dir}${path.delimiter}${pathValue}` : dir;
}
