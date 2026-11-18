// tmux TerminalDriver (#204, guide 8b). Every call is `tmux [-L socket] ...` via execFile (no shell).
// Every open uses -d so the user's current window never changes.
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { accessSync, constants, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join } from "node:path";
import type { OpenRequest, TerminalDriver } from "../types.ts";

/** POSIX single-quote one string so it survives `sh -c` (and zsh -c) verbatim. */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** The shell a pane (tmux) or surface (Ghostty) runs its command through. */
export interface PaneShell {
  /** Absolute path of the shell binary. */
  path: string;
  /** Flags before the command string: login (+ interactive where the shell supports it) so PATH setup runs. */
  flags: string[];
  /** Flags that run a command string WITHOUT reading any rc/profile (tests use them to check quoting). */
  bareFlags: string[];
}

/** POSIX-quoting shells we can hand the command string to. fish/nu/csh parse quotes differently: never chosen. */
const SH_LIKE = new Set(["sh", "dash", "ash"]);
const RC_SHELLS = new Set(["zsh", "bash", "ksh", "mksh"]);

function isExecutable(p: string): boolean {
  try {
    accessSync(p, constants.X_OK);
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/** Flags for a shell path, or undefined when it is not a POSIX-quoting shell we know. */
export function shellFor(path: string): PaneShell | undefined {
  const name = basename(path);
  if (name === "zsh") return { path, flags: ["-lic"], bareFlags: ["-fc"] };
  if (RC_SHELLS.has(name)) return { path, flags: ["-lic"], bareFlags: name === "bash" ? ["--norc", "--noprofile", "-c"] : ["-c"] };
  // sh/dash/ash: -l reads /etc/profile and ~/.profile; -i adds nothing useful there (no rc), so skip it.
  if (SH_LIKE.has(name)) return { path, flags: ["-lc"], bareFlags: ["-c"] };
  return undefined;
}

export interface PickPaneShellOptions {
  /** Environment to read SHELL from (default process.env). */
  env?: NodeJS.ProcessEnv;
  /** Test seam: is this path an executable file (default access(X_OK) + isFile). */
  isExecutable?: (path: string) => boolean;
}

/**
 * The pane shell: /bin/zsh when present, else $SHELL when it is an absolute, executable POSIX-quoting shell
 * (zsh, bash, ksh, mksh, sh, dash, ash), else /bin/sh. macOS always has /bin/zsh; stock Ubuntu has neither
 * /bin/zsh nor (often) a zsh $SHELL, so it gets bash or dash.
 */
export function pickPaneShell(opts: PickPaneShellOptions = {}): PaneShell {
  const env = opts.env ?? process.env;
  const exec = opts.isExecutable ?? isExecutable;
  const usable = (p: string | undefined): PaneShell | undefined =>
    p && isAbsolute(p) && exec(p) ? shellFor(p) : undefined;
  return usable("/bin/zsh") ?? usable(env.SHELL) ?? shellFor("/bin/sh")!;
}

/** The pane command: `<shell> <flags> <quoted argv>` (e.g. `/bin/zsh -lic '...'`). */
export function paneCommand(argv: string[], shell: PaneShell = pickPaneShell()): string {
  return [shellQuote(shell.path), ...shell.flags, shellQuote(argv.map(shellQuote).join(" "))].join(" ");
}

/** tmux expands formats in -c and -n values; `##` is a literal `#`. */
export function fmtEscape(s: string): string {
  return s.replace(/#/g, "##");
}

/** Pane user option that marks a pane as opened by this driver. */
export const OWNER_OPTION = "@ach_run";

/** Bound on fresh panes tried when tmux hands out ids that older sidecars still name. */
const MAX_ID_COLLISIONS = 32;

const defaultTagDir = (): string => join(tmpdir(), "ach-desks-tmux");

export type TmuxRunner = (args: string[]) => Promise<string>;

export interface TmuxDriverOptions {
  session?: string;
  socket?: string;
  /** Test seam: replaces execFile("tmux", ...). Receives args WITHOUT the -L prefix. */
  run?: TmuxRunner;
  /** Directory of the per-pane ownership tokens (default <tmpdir>/ach-desks-tmux). */
  dir?: string;
  /** Shell the pane command runs through (default pickPaneShell()). */
  shell?: PaneShell;
}

export const DEFAULT_TMUX_SESSION = "ach-desks";

export class TmuxDriver implements TerminalDriver {
  readonly kind = "tmux" as const;
  private session?: string;
  private checked = false;
  private readonly socket?: string;
  private readonly runner?: TmuxRunner;
  private readonly dir: string;
  private readonly shell?: PaneShell;

  constructor(opts: TmuxDriverOptions = {}) {
    this.session = opts.session;
    this.socket = opts.socket;
    this.runner = opts.run;
    this.dir = opts.dir ?? defaultTagDir();
    this.shell = opts.shell;
  }

  // Pane ids (%N) restart from %0 with every tmux server, and hosts outlive the server, so a stored id can
  // name a user's unrelated pane later. Each pane we open gets a random token in the pane option @ach_run,
  // handed back by tokenOf() so the roster stores it next to the %N (TerminalRef.token), and also remembered in a
  // sidecar file for callers without a stored token; close/alive act only when the pane still carries it.
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

  /** Tokens of the panes this instance opened (the service stores them in TerminalRef.token). */
  private readonly tokens = new Map<string, string>();

  tokenOf(id: string): string | undefined {
    return this.tokens.get(id);
  }

  /**
   * True only when pane `id` exists and carries `token` (the caller's stored TerminalRef.token), or, without one,
   * the token in the sidecar. The stored token is the root check: a sidecar names whichever pane last claimed %N.
   */
  private async owned(id: string, token?: string): Promise<boolean> {
    const want = token ?? this.expectedToken(id);
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

  /** Opens one pane for `req` and returns its %N id (untagged, no sidecar yet). */
  private async spawn(req: OpenRequest): Promise<string> {
    const cmd = paneCommand(req.argv, this.shell ?? pickPaneShell());
    const cwd = fmtEscape(req.cwd);
    const name = fmtEscape(req.name);
    const common = ["-c", cwd, "-P", "-F", "#{pane_id}", cmd];
    let out: string;
    switch (req.mode) {
      case "window": {
        const s = await this.resolveSession();
        out = await this.tmux(["new-window", "-d", "-t", `${s}:`, "-n", name, ...common]);
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
    return id;
  }

  /**
   * Records `token` as the owner of pane `id`, only if no sidecar for `id` exists yet. An existing sidecar means an
   * earlier pane of ours had this %N on a previous tmux server, and a stale roster entry may still name it: writing
   * over it would hand that entry the new pane's token, so its close() could kill the new pane.
   */
  private claim(id: string, token: string): boolean {
    mkdirSync(this.dir, { recursive: true });
    try {
      writeFileSync(this.tokenFile(id), `${token}\n`, { flag: "wx" });
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw e;
    }
  }

  async open(req: OpenRequest): Promise<string> {
    // Panes whose %N still has an older sidecar: replaced by a fresh pane (a higher %N), then killed.
    const collided: string[] = [];
    try {
      for (let attempt = 0; attempt < MAX_ID_COLLISIONS; attempt++) {
        const id = await this.spawn(req);
        const token = randomUUID();
        try {
          await this.tmux(["set-option", "-p", "-t", id, OWNER_OPTION, token]);
        } catch (e) {
          // An untagged pane could never be closed safely; do not leave it behind.
          await this.tmux(["kill-pane", "-t", id]).catch(() => undefined);
          throw e;
        }
        let claimed: boolean;
        try {
          claimed = this.claim(id, token);
        } catch (e) {
          // The sidecar could not be written: the tagged pane would be unclosable and unowned. Do not leave it behind.
          await this.tmux(["kill-pane", "-t", id]).catch(() => undefined);
          throw e;
        }
        if (claimed) {
          this.tokens.set(id, token);
          if (req.mode === "window") await this.reapStray();
          return id;
        }
        collided.push(id);
      }
      throw new Error(`tmux: ${MAX_ID_COLLISIONS} new panes all reused pane ids that stale ownership records still name (in ${this.dir})`);
    } finally {
      // Ours, opened just now, never recorded: safe to kill by id. The replacement (if any) already exists.
      for (const id of collided) await this.tmux(["kill-pane", "-t", id]).catch(() => undefined);
    }
  }

  /**
   * Removes the sidecar of `id` only when it is the record of the pane `token` names (or, without a token, the one
   * just checked against the pane): a stale ref must never delete the record of a newer pane that reused its %N.
   */
  private dropSidecar(id: string, token?: string): void {
    if (token === undefined || this.tokens.get(id) === token) this.tokens.delete(id);
    if (token !== undefined && this.expectedToken(id) !== token) return;
    rmSync(this.tokenFile(id), { force: true });
  }

  async close(id: string, token?: string): Promise<void> {
    if (!(await this.owned(id, token))) {
      // Gone, reused by another pane after a tmux restart, or opened before tagging existed: not ours to kill.
      process.stderr.write(`desks: tmux pane ${id} is not one we opened (gone, reused, or untagged); not killing it\n`);
      this.dropSidecar(id, token);
      return;
    }
    try {
      await this.tmux(["kill-pane", "-t", id]);
    } catch (e) {
      const m = (e as Error).message;
      // Already gone (pane, window, or whole server): closing is idempotent.
      if (/can't find|no server|no current|error connecting|no such file/i.test(m)) {
        this.dropSidecar(id, token);
        return;
      }
      throw e;
    }
    this.dropSidecar(id, token);
  }

  async alive(id: string, token?: string): Promise<boolean> {
    if (!(await this.owned(id, token))) return false;
    try {
      const out = await this.tmux(["display-message", "-p", "-t", id, "#{pane_id}"]);
      return out.trim() === id;
    } catch {
      return false;
    }
  }
}
