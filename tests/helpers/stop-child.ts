// Stop a test's subprocess AND wait until it is gone, so an after() hook can
// remove the temp dirs it used (#39). On Windows a live process pins its cwd
// (rmdir EBUSY) and a still-running writer refills a dir mid-rm (ENOTEMPTY);
// child.kill() there is TerminateProcess on the direct child only, so the
// whole tree is taken down with taskkill /T /F, like the harness's own
// withTreeKill (src/core/platform.ts).
import { spawnSync, type ChildProcess } from "node:child_process";
import { system32Exe } from "../../src/core/platform.ts";

/**
 * Kill `child` (tree-kill on win32; SIGTERM then SIGKILL after `graceMs`
 * elsewhere) and resolve once it has exited. Safe to call on an exited child
 * and after removeAllListeners(). Resolves after `timeoutMs` at the latest so
 * a wedged child cannot hang the suite.
 */
export function stopChild(child: ChildProcess, { graceMs = 500, timeoutMs = 10_000 } = {}): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    let grace: NodeJS.Timeout | undefined;
    const ceiling = setTimeout(done, timeoutMs);
    function done(): void {
      clearTimeout(ceiling);
      if (grace) clearTimeout(grace);
      resolve();
    }
    child.once("exit", done);
    if (process.platform === "win32" && child.pid !== undefined) {
      spawnSync(system32Exe("taskkill.exe"), ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
      if (child.exitCode === null && child.signalCode === null) child.kill();
      return;
    }
    child.kill("SIGTERM");
    grace = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }, graceMs);
  });
}
