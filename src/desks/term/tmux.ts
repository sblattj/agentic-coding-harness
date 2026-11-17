// tmux TerminalDriver (#204, guide 8b). Every call is `tmux [-L socket] ...` via execFile (no shell).
// Every open uses -d so the user's current window never changes.
import { execFile } from "node:child_process";
import type { OpenRequest, TerminalDriver } from "../types.ts";

/** POSIX single-quote one string so it survives `sh -c` (and zsh -c) verbatim. */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** The pane command: `/bin/zsh -lic <quoted argv>`. */
export function paneCommand(argv: string[]): string {
  return `/bin/zsh -lic ${shellQuote(argv.map(shellQuote).join(" "))}`;
}

export type TmuxRunner = (args: string[]) => Promise<string>;

export interface TmuxDriverOptions {
  session?: string;
  socket?: string;
  /** Test seam: replaces execFile("tmux", ...). Receives args WITHOUT the -L prefix. */
  run?: TmuxRunner;
}

export const DEFAULT_TMUX_SESSION = "ach-desks";

export class TmuxDriver implements TerminalDriver {
  readonly kind = "tmux" as const;
  private session?: string;
  private checked = false;
  private readonly socket?: string;
  private readonly runner?: TmuxRunner;

  constructor(opts: TmuxDriverOptions = {}) {
    this.session = opts.session;
    this.socket = opts.socket;
    this.runner = opts.run;
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
    const common = ["-c", req.cwd, "-P", "-F", "#{pane_id}", cmd];
    let out: string;
    switch (req.mode) {
      case "window": {
        const s = await this.resolveSession();
        out = await this.tmux(["new-window", "-d", "-t", `${s}:`, "-n", req.name, ...common]);
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
        out = await this.tmux(["new-window", "-d", "-t", `${s2}:`, "-n", req.name, ...common]);
        break;
      }
      default:
        throw new Error(`tmux: unknown open mode ${String(req.mode)}`);
    }
    const id = out.trim();
    if (!/^%\d+$/.test(id)) throw new Error(`tmux: unexpected pane id ${JSON.stringify(id)}`);
    return id;
  }

  async close(id: string): Promise<void> {
    try {
      await this.tmux(["kill-pane", "-t", id]);
    } catch (e) {
      const m = (e as Error).message;
      // Already gone (pane, window, or whole server): closing is idempotent.
      if (/can't find|no server|no current|error connecting|no such file/i.test(m)) return;
      throw e;
    }
  }

  async alive(id: string): Promise<boolean> {
    try {
      const out = await this.tmux(["display-message", "-p", "-t", id, "#{pane_id}"]);
      return out.trim() === id;
    } catch {
      return false;
    }
  }
}
