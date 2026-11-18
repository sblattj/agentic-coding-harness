// Pane shell portability: Ubuntu CI has no /bin/zsh, so panes and Ghostty surfaces must not hard-code it.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { surfaceCommand } from "../src/desks/term/ghostty.ts";
import { TmuxDriver, paneCommand, pickPaneShell, shellFor, type PaneShell } from "../src/desks/term/tmux.ts";

const HAVE_TMUX = spawnSync("tmux", ["-V"]).status === 0;
const tmp = mkdtempSync(join(tmpdir(), "ach-desks-shell-"));
after(() => rmSync(tmp, { recursive: true, force: true }));

const only = (...present: string[]) => (p: string): boolean => present.includes(p);
const weird = `a b 'q' "d" $HOME \`x\`; echo pwned`;

describe("pickPaneShell", () => {
  it("prefers /bin/zsh when present", () => {
    const s = pickPaneShell({ env: { SHELL: "/bin/bash" }, isExecutable: only("/bin/zsh", "/bin/bash", "/bin/sh") });
    assert.deepEqual([s.path, s.flags], ["/bin/zsh", ["-lic"]]);
  });
  it("no /bin/zsh (Ubuntu): an absolute, executable POSIX $SHELL, with login+interactive flags", () => {
    const s = pickPaneShell({ env: { SHELL: "/bin/bash" }, isExecutable: only("/bin/bash", "/bin/sh") });
    assert.deepEqual([s.path, s.flags], ["/bin/bash", ["-lic"]]);
    const z = pickPaneShell({ env: { SHELL: "/usr/bin/zsh" }, isExecutable: only("/usr/bin/zsh", "/bin/sh") });
    assert.deepEqual([z.path, z.flags], ["/usr/bin/zsh", ["-lic"]]);
  });
  it("falls back to /bin/sh -lc for a missing, relative, non-executable or non-POSIX $SHELL", () => {
    for (const SHELL of [undefined, "", "bash", "/bin/bash", "/usr/bin/fish", "/usr/bin/nu", "/bin/csh"]) {
      const s = pickPaneShell({ env: { SHELL }, isExecutable: only("/bin/sh", "/usr/bin/fish", "/usr/bin/nu", "/bin/csh") });
      assert.deepEqual([s.path, s.flags], ["/bin/sh", ["-lc"]], `SHELL=${String(SHELL)}`);
    }
  });
  it("on this host it picks an existing shell", () => {
    assert.ok(existsSync(pickPaneShell().path));
  });
});

// The Ubuntu path on this Mac: dash is Ubuntu's /bin/sh, bash its usual $SHELL.
const SHELLS = ["/bin/dash", "/bin/bash", "/bin/sh", "/bin/zsh"].filter((p) => existsSync(p)).map((p) => shellFor(p) as PaneShell);

describe("paneCommand / surfaceCommand through each shell, as the pane runs it (login flags included)", () => {
  for (const sh of SHELLS) {
    it(`${sh.path} ${sh.flags.join(" ")}`, () => {
      const pc = paneCommand(["printf", "%s|", "a b", "it's", weird], sh);
      assert.ok(pc.startsWith(`'${sh.path}' ${sh.flags.join(" ")} '`), pc);
      const out = execFileSync("/bin/sh", ["-c", pc], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      assert.ok(out.endsWith(`a b|it's|${weird}|`), `quoting survived: ${JSON.stringify(out)}`);

      const pidfile = join(tmp, `${sh.path.replace(/\W/g, "_")}.pid`);
      const sc = surfaceCommand(["printf", "%s", weird], pidfile, sh);
      assert.ok(sc.startsWith(`'${sh.path}' ${sh.flags.join(" ")} '`), sc);
      const out2 = execFileSync("/bin/sh", ["-c", sc], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      assert.ok(out2.endsWith(weird), `surface quoting survived: ${JSON.stringify(out2)}`);
      assert.match(readFileSync(pidfile, "utf8"), /^\d+$/m, "pid recorded");
    });
  }
});

describe("real tmux panes without zsh", { skip: !HAVE_TMUX && "tmux not installed" }, () => {
  const sock = `ach-desks-sh-${process.pid}`;
  after(() => {
    try {
      execFileSync("tmux", ["-L", sock, "kill-server"]);
    } catch {
      /* gone */
    }
  });
  for (const path of ["/bin/dash", "/bin/bash"].filter((p) => existsSync(p))) {
    it(`a pane runs its argv through ${path} with quoting intact`, async () => {
      const sh = shellFor(path) as PaneShell;
      const d = new TmuxDriver({ socket: sock, session: "s", dir: join(tmp, "tok"), shell: sh });
      const marker = join(tmp, `m-${path.replace(/\W/g, "_")}`);
      const id = await d.open({ mode: "window", name: "w", cwd: tmp, argv: ["/bin/sh", "-c", `printf '%s' "$1" > "$0"; sleep 60`, marker, weird] });
      const start = execFileSync("tmux", ["-L", sock, "display-message", "-p", "-t", id, "#{pane_start_command}"], { encoding: "utf8" });
      assert.ok(start.includes(path) && !start.includes("zsh"), `pane started through ${path}: ${start}`);
      for (let i = 0; i < 100 && !existsSync(marker); i++) await new Promise((r) => setTimeout(r, 100));
      assert.equal(readFileSync(marker, "utf8"), weird);
      await d.close(id);
      assert.equal(await d.alive(id), false);
    });
  }
});
