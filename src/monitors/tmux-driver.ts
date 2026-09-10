/**
 * Tmux-backed driver + monitor: the universal TUI fallback lane for driving
 * and watching any agent CLI that renders a terminal UI (Claude Code,
 * OpenCode, Kiro, ...). Anything that paints a tmux pane can be driven via
 * send/capture and classified with a declarative rule manifest.
 *
 * TODO-MERGE: src/core/types.ts landed 2026-09-09 covering the event-stream
 * domain (AgentEvent, CanonicalTokenRecord); it defines nothing for the
 * monitor domain, so AgentState, DetectionRule, DetectionResult,
 * CaptureCapable, TokenReading and the *Rule manifests remain local here.
 * Rehome them into core/types.ts when the monitor lane merges with core.
 */

import { execFileSync, spawnSync } from 'node:child_process';

export type AgentState = 'running' | 'waiting' | 'idle';

export interface DetectionRule {
  state: AgentState;
  /** Must not carry the `g` flag: rules are re-tested on every poll and a
   *  stateful /g/ regex would silently alternate matches. */
  pattern: RegExp;
  region?: 'bottom' | 'anywhere';
  /** Higher number wins; ties resolve to the earlier-listed rule. */
  priority: number;
}

export interface DetectionResult {
  state: AgentState;
  matchedRule?: DetectionRule;
}

export interface CaptureCapable {
  capture(opts?: { last?: number }): string;
}

export const BOTTOM_REGION_LINES = 4;

export function bottomRegion(paneText: string): string {
  const nonEmpty = paneText.split('\n').filter((line) => line.trim().length > 0);
  return nonEmpty.slice(-BOTTOM_REGION_LINES).join('\n');
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export interface StartOptions {
  width?: number;
  height?: number;
}

export class TmuxDriver {
  private readonly tmuxBin: string;
  private sessionName: string | null = null;

  constructor(options: { tmuxBin?: string } = {}) {
    this.tmuxBin = options.tmuxBin ?? 'tmux';
  }

  private requireSession(): string {
    if (!this.sessionName) {
      throw new Error('TmuxDriver: no active session; call start() first');
    }
    return this.sessionName;
  }

  private checkTmux(): void {
    const res = spawnSync('which', [this.tmuxBin], { encoding: 'utf8' });
    if (res.status !== 0) {
      throw new Error(
        `tmux not found on PATH ('which ${this.tmuxBin}' failed). Install tmux to use the TUI fallback lane.`,
      );
    }
  }

  start(sessionName: string, command: string, opts: StartOptions = {}): void {
    this.checkTmux();
    const { width = 220, height = 50 } = opts;
    execFileSync(this.tmuxBin, [
      'new-session', '-d', '-s', sessionName,
      '-x', String(width), '-y', String(height),
      command,
    ]);
    this.sessionName = sessionName;
  }

  send(text: string): void {
    const target = this.requireSession();
    // Split literal text from Enter (claude-squad lesson): typing "<text>"
    // and Enter in one call submits mid-paste for TUIs that treat the newline
    // as part of the literal input. Text first, then a discrete Enter, gives
    // the app one clean submit.
    execFileSync(this.tmuxBin, ['send-keys', '-t', target, '-l', text]);
    execFileSync(this.tmuxBin, ['send-keys', '-t', target, 'Enter']);
  }

  capture(opts: { last?: number } = {}): string {
    const target = this.requireSession();
    const { last = 50 } = opts;
    return execFileSync(
      this.tmuxBin,
      ['capture-pane', '-p', '-J', '-S', `-${last}`, '-t', target],
      { encoding: 'utf8' },
    );
  }

  pipeTo(logPath: string): void {
    const target = this.requireSession();
    execFileSync(this.tmuxBin, [
      'pipe-pane', '-o', '-t', target,
      `cat >> ${shellQuote(logPath)}`,
    ]);
  }

  stop(): void {
    const target = this.sessionName;
    if (!target) return;
    this.sessionName = null;
    const res = spawnSync(this.tmuxBin, ['kill-session', '-t', target]);
    if (res.status !== 0) {
      const err = (res.stderr?.toString() ?? '').trim();
      // Benign teardown races: server already dead, session already gone.
      if (!/no server|can'?t find session|no such session/i.test(err)) {
        throw new Error(`tmux kill-session failed: ${err || 'unknown error'}`);
      }
    }
  }
}

export class StateDetector {
  private readonly rules: readonly DetectionRule[];

  constructor(rules: readonly DetectionRule[]) {
    this.rules = rules;
  }

  detect(paneText: string): DetectionResult {
    const bottom = bottomRegion(paneText);
    let best: DetectionRule | undefined;
    for (const rule of this.rules) {
      const region = rule.region === 'bottom' ? bottom : paneText;
      if (!rule.pattern.test(region)) continue;
      if (!best || rule.priority > best.priority) best = rule;
    }
    if (!best) return { state: 'idle' };
    return { state: best.state, matchedRule: best };
  }
}

/**
 * Claude Code manifest. The permission box and the status line both sit in
 * the bottom region; waiting outranks running because a mid-run permission
 * prompt can still show "esc to interrupt" elsewhere on screen.
 */
export const CLAUDE_RULES: DetectionRule[] = [
  { state: 'waiting', pattern: /No, and tell Claude|Do you want to proceed/, region: 'bottom', priority: 30 },
  { state: 'running', pattern: /esc to interrupt/, region: 'bottom', priority: 20 },
  { state: 'idle', pattern: /✻ .* for /, region: 'bottom', priority: 10 },
];

/** OpenCode manifest. */
export const OPENCODE_RULES: DetectionRule[] = [
  { state: 'waiting', pattern: /Permission required|△/, region: 'bottom', priority: 30 },
  { state: 'running', pattern: /esc.*interrupt/i, region: 'bottom', priority: 20 },
];

/**
 * Generic best-effort manifest for CLIs whose exact status strings have not
 * been archived yet (Kiro today). Refine once pipeTo logs reveal the real
 * prompts; the patterns below are intentionally broad.
 */
export const KIRO_RULES: DetectionRule[] = [
  {
    state: 'waiting',
    pattern: /\[Y\/n\]|\[y\/N\]|approv(e|al) required|awaiting (your )?(input|approval)/i,
    region: 'anywhere',
    priority: 30,
  },
  { state: 'running', pattern: /working|processing|generating/i, region: 'anywhere', priority: 20 },
];

export interface TokenReading {
  tokens?: number;
  raw?: string;
}

export class TokenScraper {
  /**
   * Scraped tokens are approximate status-line values read off the TUI,
   * NOT billing-grade usage numbers. `tokens` sums every ↓/↑ "tokens"
   * figure visible in the bottom region (the CLIs show input and output
   * separately); `raw` is the last literal match. Returns {} when no
   * token readout is on screen.
   */
  scrape(paneText: string): TokenReading {
    const region = bottomRegion(paneText);
    const re = /[↓↑]\s*([\d,.]+)([km]?)\s*tokens/gi;
    let tokens: number | undefined;
    let raw: string | undefined;
    let m: RegExpExecArray | null;
    while ((m = re.exec(region)) !== null) {
      const value = parseFloat((m[1] ?? '').replace(/,/g, ''));
      if (Number.isNaN(value)) continue;
      const suffix = (m[2] ?? '').toLowerCase();
      const mult = suffix === 'k' ? 1_000 : suffix === 'm' ? 1_000_000 : 1;
      tokens = (tokens ?? 0) + value * mult;
      raw = m[0];
    }
    return tokens === undefined ? {} : { tokens, raw };
  }
}

export interface WatchLoopOptions {
  intervalMs?: number;
  lastLines?: number;
  onChange: (state: AgentState, paneText: string) => void | Promise<void>;
  onError?: (err: unknown) => void;
}

export interface WatchLoopHandle {
  stop(): void;
  getState(): AgentState | undefined;
}

/**
 * Polls the driver's capture, dedupes consecutive identical states, and calls
 * onChange on transitions. The first sample counts as a transition (there is
 * no prior state to dedupe against). Transient capture failures are reported
 * via onError and keep the loop alive on the last known state.
 */
export function watchLoop(
  driver: CaptureCapable,
  detector: StateDetector,
  options: WatchLoopOptions,
): WatchLoopHandle {
  const { intervalMs = 2000, lastLines = 50, onChange, onError } = options;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let currentState: AgentState | undefined;

  const schedule = () => {
    if (!stopped) timer = setTimeout(tick, intervalMs);
  };

  const tick = async (): Promise<void> => {
    if (stopped) return;
    try {
      const paneText = driver.capture({ last: lastLines });
      const { state } = detector.detect(paneText);
      if (state !== currentState) {
        currentState = state;
        await onChange(state, paneText);
      }
    } catch (err) {
      onError?.(err);
    }
    schedule();
  };

  void tick();

  return {
    stop() {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
    },
    getState() {
      return currentState;
    },
  };
}
