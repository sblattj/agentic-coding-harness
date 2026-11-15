// `--then` step prompts for interactive runs (#195).
//
// Each queued prompt is typed into the TUI once the agent finishes a turn
// (Claude Code's turn_duration marker in the transcript). One turn end
// releases at most one step, so a prompt the user types by hand in between
// just delays the queue by a turn. With --pause-between, a finished turn
// parks the queue until continue() (a key chord in `ach attach` or the
// owner terminal, or the web tile's NEXT STEP button).
import type { LiveControls, StepState } from "./live-socket.ts";

export interface StepControllerOptions {
  prompts: string[];
  pauseBetween: boolean;
  /** Type into the PTY. */
  write: (data: string) => void;
  /** Wait after a turn end before typing (lets the TUI redraw its prompt). */
  settleMs?: number;
  /** Gap between the prompt text and its Enter key, ms. */
  enterDelayMs?: number;
  /** Progress notes for the owner's stderr. */
  log?: (line: string) => void;
}

export class StepController implements LiveControls {
  readonly #opts: StepControllerOptions;
  #sent = 0;
  #waiting = false;
  #cbs = new Set<(s: StepState) => void>();
  #timers = new Set<ReturnType<typeof setTimeout>>();
  #stopped = false;

  constructor(opts: StepControllerOptions) {
    this.#opts = opts;
  }

  state(): StepState {
    const next = this.#opts.prompts[this.#sent];
    return { total: this.#opts.prompts.length, sent: this.#sent, waiting: this.#waiting, ...(next !== undefined ? { next } : {}) };
  }

  onState(cb: (s: StepState) => void): () => void {
    this.#cbs.add(cb);
    return () => this.#cbs.delete(cb);
  }

  /** The agent finished a turn. */
  turnEnded(): void {
    if (this.#stopped || this.#waiting || this.#sent >= this.#opts.prompts.length) return;
    this.#later(this.#opts.settleMs ?? 800, () => {
      if (this.#stopped || this.#waiting || this.#sent >= this.#opts.prompts.length) return;
      if (this.#opts.pauseBetween) {
        this.#waiting = true;
        this.#opts.log?.(`[interactive] step ${this.#sent + 1}/${this.#opts.prompts.length} is ready; press Ctrl-] n in a terminal (or NEXT STEP in ach web) to send it`);
        this.#emit();
        return;
      }
      this.#typeNext();
    });
  }

  continue(): boolean {
    if (!this.#waiting || this.#stopped) return false;
    this.#waiting = false;
    this.#typeNext();
    return true;
  }

  stop(): void {
    this.#stopped = true;
    for (const t of this.#timers) clearTimeout(t);
    this.#timers.clear();
  }

  #typeNext(): void {
    const prompt = this.#opts.prompts[this.#sent];
    if (prompt === undefined) return;
    this.#sent++;
    this.#opts.log?.(`[interactive] step ${this.#sent}/${this.#opts.prompts.length}: ${prompt.length > 60 ? prompt.slice(0, 57) + "..." : prompt}`);
    // A TUI treats text and Enter that arrive together as a paste; a short gap
    // makes the Enter a submit.
    this.#opts.write(prompt.replace(/\r?\n/g, " "));
    this.#later(this.#opts.enterDelayMs ?? 200, () => this.#opts.write("\r"));
    this.#emit();
  }

  #later(ms: number, fn: () => void): void {
    const t = setTimeout(() => {
      this.#timers.delete(t);
      fn();
    }, ms);
    this.#timers.add(t);
  }

  #emit(): void {
    const s = this.state();
    for (const cb of this.#cbs) {
      try {
        cb(s);
      } catch {
        /* ignore */
      }
    }
  }
}
