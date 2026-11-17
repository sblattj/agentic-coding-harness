// tmux TerminalDriver (#204, guide 8b). Every call is `tmux [-L socket] ...` via execFile (no shell).
// Every open uses -d so the user's current window never changes.
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OpenRequest, TerminalDriver } from "../types.ts";

/** POSIX single-quote one string so it survives `sh -c` (and zsh -c) verbatim. */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** The pane command: `/bin/zsh -lic <quoted argv>`. */
export function paneCommand(argv: string[]): string {
  return `/bin/zsh -lic ${shellQuote(argv.map(shellQuote).join(" "))}`;
}

/** tmux expands formats in -c and -n values; `##` is a literal `#`. */
export function fmtEscape(s: string): string {
  return s.replace(/#/g, "##");
}

/** Pane user option that marks a pane as opened by this driver. */
export const OWNER_OPTION = "@ach_run";

const defaultTagDir = (): string => join(tmpdir(), "ach-desks-tmux");

export type TmuxRunner = (args: string[]) => Promise<string>;

export interface TmuxDriverOptions {
  session?: string;
  socket?: string;
  /** Test seam: replaces execFile("tmux", ...). Receives args WITHOUT the -L prefix. */
  run?: TmuxRunner;
  /** Directory of the per-pane ownership tokens (default <tmpdir>/ach-desks-tmux). */
  dir?: string;
}

export const DEFAULT_TMUX_SESSION = "ach-desks";

export class TmuxDriver implements TerminalDriver {
  readonly kind = "tmux" as const;
  private session?: string;
  private checked = false;
  private readonly socket?: string;
  private readonly runner?: TmuxRunner;
  private readonly dir: string;

  constructor(opts: TmuxDriverOptions = {}) {
    this.session = opts.session;
    this.socket = opts.socket;
    this.runner = opts.run;
    this.dir = opts.dir ?? defaultTagDir();
  }

  // Pane ids (%N) restart from %0 with every tmux server, and hosts outlive the server, so a stored id can
  // name a user's unrelated pane later. Each pane we open gets a random token in the pane option @ach_run,
  // remembered in a sidecar file (the roster keeps the plain %N); close/alive act only when both agree.
  private tokenFile(id: string): string {
    const safe = (x: string): string => x.replace(/[^A-Za-z0-9_-]/g, "_");
    return join(this.dir, `${safe(this.socket ?? "default")}-${safe(id)}.tok`);
  }

  private expectedToken(id: string): string | undefined {
    try {
      return readFileSync(this.tokenFile(id), "utf8").trim() || undefined;
    } catch {
      return undefined;
    }
  }

  /** True only when pane `id` exists and carries the token we recorded when we opened it. */
  private async owned(id: string): Promise<boolean> {
    const want = this.expectedToken(id);
    if (!want) return false;
    try {
      const got = (await this.tmux(["display-message", "-p", "-t", id, `#{${OWNER_OPTION}}`])).trim();
      return got === want;
    } catch {
      return false;
    }
  }

  private tmux(args: string[]): Promise<string> {
    if (this.runner) return this.runner(args);
    const full = this.socket ? ["-L", this.socket, ...args] : args;
    return new Promise((resolve, reject) => {
      execFile("tmux", full, { encoding: "utf8", timeout: 15_000 }, (err, stdout, stderr) => {
        if (err) {
          const e = new Error(`tmux ${args[0]} failed: ${(stderr || err.message).trim()}`);
          reject(e);
          return;
        }
        resolve(stdout);
      });
    });
  }

  /** Window id of the default window a new-session we created made; reaped once a real window exists. */
  private strayWindow?: string;

  private async createSession(name: string): Promise<void> {
    // -P -F prints the default window's id so the first real window can replace it (no stray empty window 0).
    const w = (await this.tmux(["new-session", "-d", "-s", name, "-P", "-F", "#{window_id}"])).trim();
    if (/^@\d+$/.test(w)) this.strayWindow = w;
  }

  private async resolveSession(): Promise<string> {
    if (this.session) {
      if (!this.checked) {
        // An explicit session may not exist yet (fresh socket): create it, never assume it.
        try {
          await this.tmux(["has-session", "-t", this.session]);
        } catch {
          await this.createSession(this.session);
        }
        this.checked = true;
      }
      return this.session;
    }
    let first = "";
    try {
      first = (await this.tmux(["list-sessions", "-F", "#{session_name}"])).split("\n")[0]?.trim() ?? "";
    } catch {
      first = ""; // no server running
    }
    if (!first) {
      await this.createSession(DEFAULT_TMUX_SESSION);
      first = DEFAULT_TMUX_SESSION;
    }
    this.session = first;
    this.checked = true;
    return first;
  }

  /** After the first real window exists in a session we created, drop its empty default window. */
  private async reapStray(): Promise<void> {
    const w = this.strayWindow;
    if (!w) return;
    this.strayWindow = undefined;
    try {
      await this.tmux(["kill-window", "-t", w]);
    } catch {
      /* already gone */
    }
  }

  async open(req: OpenRequest): Promise<string> {
    const cmd = paneCommand(req.argv);
    const cwd = fmtEscape(req.cwd);
    const name = fmtEscape(req.name);
    const common = ["-c", cwd, "-P", "-F", "#{pane_id}", cmd];
    let out: string;
    switch (req.mode) {
      case "window": {
        const s = await this.resolveSession();
        out = await this.tmux(["new-window", "-d", "-t", `${s}:`, "-n", name, ...common]);
        await this.reapStray();
        break;
      }
      case "right":
      case "down": {
        if (!req.of) throw new Error(`tmux: mode ${req.mode} needs "of" (the pane to split)`);
        out = await this.tmux(["split-window", "-d", req.mode === "right" ? "-h" : "-v", "-t", req.of, ...common]);
        break;
      }
      case "tab": {
        if (!req.of) throw new Error(`tmux: mode tab needs "of" (a pane in the target session)`);
        const s2 = (await this.tmux(["display-message", "-p", "-t", req.of, "#{session_name}"])).trim();
        if (!s2) throw new Error(`tmux: cannot find the session of pane ${req.of}`);
        out = await this.tmux(["new-window", "-d", "-t", `${s2}:`, "-n", name, ...common]);
        break;
      }
      default:
        throw new Error(`tmux: unknown open mode ${String(req.mode)}`);
    }
    const id = out.trim();
    if (!/^%\d+$/.test(id)) throw new Error(`tmux: unexpected pane id ${JSON.stringify(id)}`);
    const token = randomUUID();
    try {
      await this.tmux(["set-option", "-p", "-t", id, OWNER_OPTION, token]);
    } catch (e) {
      // An untagged pane could never be closed safely; do not leave it behind.
      await this.tmux(["kill-pane", "-t", id]).catch(() => undefined);
      throw e;
    }
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(this.tokenFile(id), `${token}\n`);
    return id;
  }

  async close(id: string): Promise<void> {
    if (!(await this.owned(id))) {
      // Gone, reused by another pane after a tmux restart, or opened before tagging existed: not ours to kill.
      process.stderr.write(`desks: tmux pane ${id} is not one we opened (gone, reused, or untagged); not killing it\n`);
      rmSync(this.tokenFile(id), { force: true });
      return;
    }
    try {
      await this.tmux(["kill-pane", "-t", id]);
    } catch (e) {
      const m = (e as Error).message;
      // Already gone (pane, window, or whole server): closing is idempotent.
      if (/can't find|no server|no current|error connecting|no such file/i.test(m)) {
        rmSync(this.tokenFile(id), { force: true });
        return;
      }
      throw e;
    }
    rmSync(this.tokenFile(id), { force: true });
  }

  async alive(id: string): Promise<boolean> {
    if (!(await this.owned(id))) return false;
    try {
      const out = await this.tmux(["display-message", "-p", "-t", id, "#{pane_id}"]);
      return out.trim() === id;
    } catch {
      return false;
    }
  }
}
