// `ach smoke` step runner (agentic-coding-harness#139): run ONE SmokeStep,
// literally, inside a Sandbox, and turn what happened into a StepRecord.
//
// Decisions (each is tested in tests/smoke-runner.test.ts):
//   * Reader model: ONE terminal session across steps. Each shell step runs as
//     `/bin/zsh -c <script>` where the script is newline-joined (never
//     `;`-joined, so a step ending in `&` or holding a `#` comment cannot
//     swallow the epilogue):
//       prelude  — trap the epilogue on EXIT, source ~/.zprofile and ~/.zshrc
//                  when present (installers write PATH there; the reader's
//                  next terminal tab gets it), then <state>/session.sh
//                  (previous steps' exports + `cd`);
//       the step text EXACTLY as written (literal run);
//       epilogue — `export -p` + `cd ${(q)PWD}` into session.sh, $PWD into
//                  session.cwd. Runs on failure too (EXIT trap); the exit code
//                  is the step's own.
//   * stdin is /dev/null unless opts.input is given: the harness cannot type,
//     so output asking for input is interactive-prompt friction.
//   * Every child goes through sb.spawnTracked (own process group). When the
//     step's shell exits its group is killed, unless the step deliberately
//     backgrounds (`... &` at the end, or `nohup`): those are left for
//     sandbox teardown and noted on the record (backgroundLeft).
//   * Auth: each output chunk, and each line the `open` shim appends to
//     <state>/opened-urls.jsonl, goes through opts.detectAuth; an http(s) URL
//     handed to the shim that detectAuth does not recognise is a plain
//     {kind:'browser'} request. The FIRST hit per step calls opts.onAuth
//     concurrently while the process keeps running; any outcome other than
//     `completed` kills the step's group at once (no waiting for timeout).
//   * Prompt steps run the agent CLI the reader types into, inside the
//     sandbox: `<node> <achCli> run --agent <agent> --json <prompt>`.
//     `ach run --json` prints the full RunResult to stdout
//     (src/cli/ach.ts cmdRun: `process.stdout.write(JSON.stringify(out, null, 2))`);
//     tokens = sum over RunResult.tokens (CanonicalTokenRecord[]) of
//     input + output + cacheRead + cacheWrite.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import type { Sandbox } from './sandbox.ts';
import type { AuthHandler, AuthOutcome, AuthRequest, Friction, SmokeStep, StepRecord } from './types.ts';

export interface RunnerStepRecord extends StepRecord {
  /** Outcome of the step's auth request, when one was detected and handled. */
  auth?: AuthOutcome;
  /** The step deliberately backgrounded processes; they are reaped at teardown. */
  backgroundLeft?: boolean;
  /** Loopback http(s) URLs the step opened (never auth requests). */
  localUrls?: string[];
  /** The step started a long-running local server, left running until teardown. */
  service?: { listening: string[] };
}

/** True for http(s) URLs whose host is loopback (127.0.0.1, localhost, [::1], 0.0.0.0). */
export function isLoopbackUrl(u: string): boolean {
  let url: URL;
  try {
    url = new URL(u);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  const h = url.hostname.toLowerCase();
  return h === 'localhost' || h === '[::1]' || h === '::1' || h === '0.0.0.0' || /^127\.\d+\.\d+\.\d+$/.test(h);
}

/** Listening TCP sockets ("host:port") held by a process group (lsof; [] when none or unavailable). */
export function listeningSockets(pgid: number): string[] {
  const r = spawnSync('/usr/sbin/lsof', ['-nP', '-a', '-iTCP', '-sTCP:LISTEN', '-g', String(pgid), '-Fn'], { encoding: 'utf8', timeout: 5000 });
  if (r.status !== 0 && !r.stdout) return [];
  const out = new Set<string>();
  for (const l of (r.stdout ?? '').split('\n')) if (l.startsWith('n')) out.add(l.slice(1));
  return [...out];
}

export type DetectAuth = (text: string) => Omit<AuthRequest, 'stepIndex' | 'account'> | null;

export interface RunStepOptions {
  /** Default 300000; the step's `timeout=` attr (seconds) overrides. */
  timeoutMs?: number;
  /** A shell step still running after this long that holds a listening TCP socket counts as a started service (default 8000). */
  serviceGraceMs?: number;
  /** Fed to stdin instead of /dev/null. */
  input?: string;
  detectAuth?: DetectAuth;
  onAuth?: AuthHandler;
  /** Default account (--account); the step's `account=` attr overrides. */
  account?: string;
  /** Agent for prompt steps (default "claude"); the step's `agent=` attr overrides. */
  agent?: string;
  /** Path of the running `ach` entry, for prompt steps. */
  achCli?: string;
  /** Attempt number for the record (default 1). */
  attempt?: number;
}

export const DEFAULT_STEP_TIMEOUT_MS = 300_000;
const TAIL_BYTES = 4096;
const SCAN_CAP = 256 * 1024;
const OPEN_POLL_MS = 150;
export const DEFAULT_SERVICE_GRACE_MS = 8000;
const SERVICE_POLL_MS = 1000;

/** Binary each agent name needs on PATH (default: the agent name itself). */
const AGENT_BINARIES: Record<string, string> = {
  claude: 'claude',
  codex: 'codex',
  gemini: 'gemini',
  cursor: 'cursor-agent',
  'cursor-agent': 'cursor-agent',
  copilot: 'copilot',
  kiro: 'kiro-cli',
  opencode: 'opencode',
};

// ---------------------------------------------------------------- friction classification

function trimEvidence(s: string): string {
  const t = s.trim();
  return t.length > 400 ? t.slice(0, 397) + '...' : t;
}

export interface OutputScan {
  friction: Friction[];
  prompts: string[];
  denials: string[];
}

const RE_MISSING = [
  /command not found:\s*(\S+)/i,
  /(?:^|:\s)(\S+): command not found/i,
  /not found:\s*(\S+)/i,
  /^zsh:\d*:?\s*no such file or directory:\s*(\S+)/i,
];
const RE_WRONG_FLAG = /unknown option|unrecognized (?:option|argument)|invalid option|Usage:/i;
/** darwin: shell steps cannot exec the host browser launchers by absolute path (#139). */
const EXEC_GUARD_PROFILE = '(version 1)(allow default)(deny process-exec (literal "/usr/bin/open") (literal "/usr/bin/osascript"))';
const RE_HOST_BROWSER_DENIED = /\/usr\/bin\/(?:open|osascript)\b.*Operation not permitted|Operation not permitted.*\/usr\/bin\/(?:open|osascript)\b/;
const RE_DENIED = /Permission denied|EACCES|Operation not permitted|not allowed|denied/i;
const RE_PROMPT = /\(y\/N\)|\[Y\/n\]|Password:|Press (?:Enter|any key)|\? .+[:?]\s*$|not a tty|stdin is not a terminal|Inappropriate ioctl/i;
const RE_KEYCHAIN = /keychain cannot be found|SecKeychain|errSec/i;
const RE_ASSUMPTION = /ENOENT\b.*\.(?:json|ya?ml|env)\b|missing (?:env|environment variable)|is not set/i;

/** Classify a step's output: friction rows plus the prompt and denial lines. */
export function scanOutput(output: string, exitCode: number | null, step: SmokeStep): OutputScan {
  void step;
  const failed = exitCode !== 0;
  const lines = output.split(/\r?\n|\r/).map((l) => l.trimEnd()).filter((l) => l.trim() !== '');
  const friction: Friction[] = [];
  const prompts: string[] = [];
  const denials: string[] = [];
  const seen = new Set<string>();
  const add = (f: Friction) => {
    if (seen.has(f.kind)) return;
    seen.add(f.kind);
    friction.push(f);
  };
  for (const line of lines) {
    if (RE_PROMPT.test(line)) {
      prompts.push(line.trim());
      add({ kind: 'interactive-prompt', detail: 'The step waited for input the message does not mention.', evidence: trimEvidence(line) });
    }
    if (RE_KEYCHAIN.test(line)) {
      add({ kind: 'keychain', detail: 'The step hit a missing keychain or a keychain prompt.', evidence: trimEvidence(line) });
    }
    if (!failed) continue;
    let missing: string | undefined;
    for (const re of RE_MISSING) {
      const m = re.exec(line);
      if (m) {
        missing = m[1]!.replace(/[:'"`]+$/, '');
        break;
      }
    }
    if (missing !== undefined) {
      add({ kind: 'missing-prereq', detail: `\`${missing}\` is not installed; the message never installs it.`, evidence: trimEvidence(line) });
    }
    if (RE_WRONG_FLAG.test(line)) {
      add({ kind: 'wrong-flag', detail: 'The command rejected a flag or its usage.', evidence: trimEvidence(line) });
    }
    if (RE_DENIED.test(line)) {
      denials.push(line.trim());
      if (RE_HOST_BROWSER_DENIED.test(line)) {
        add({ kind: 'denied', detail: 'A program in the step tried to open the host browser by absolute path (/usr/bin/open or /usr/bin/osascript); the smoke sandbox blocked it. Use `open` from PATH or print the URL instead.', evidence: trimEvidence(line) });
      }
      add({ kind: 'denied', detail: 'The step was denied (permissions or policy).', evidence: trimEvidence(line) });
    }
    if (RE_ASSUMPTION.test(line)) {
      add({ kind: 'unstated-assumption', detail: 'The step needed a file or variable the message never set up.', evidence: trimEvidence(line) });
    }
  }
  if (failed && friction.length === 0) {
    const last = lines[lines.length - 1];
    add({
      kind: 'failed',
      detail: `The step exited ${exitCode === null ? 'without an exit code' : exitCode}.`,
      ...(last !== undefined ? { evidence: trimEvidence(last) } : {}),
    });
  }
  return { friction, prompts, denials };
}

/** Friction rows for a step's output (see scanOutput for prompts/denials). */
export function classifyFriction(output: string, exitCode: number | null, step: SmokeStep): Friction[] {
  return scanOutput(output, exitCode, step).friction;
}

// ---------------------------------------------------------------- helpers

function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function isBackgrounding(text: string): boolean {
  return /&\s*$/.test(text.trimEnd()) && !/&&\s*$/.test(text.trimEnd()) ? true : /\bnohup\b/.test(text);
}

function killGroup(pgid: number | undefined, sig: NodeJS.Signals): void {
  if (pgid === undefined) return;
  try {
    process.kill(-pgid, sig);
  } catch {
    /* gone */
  }
}

function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function killGroupHard(pgid: number | undefined): Promise<void> {
  if (pgid === undefined) return;
  killGroup(pgid, 'SIGTERM');
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline && groupAlive(pgid)) await new Promise((r) => setTimeout(r, 50));
  if (groupAlive(pgid)) killGroup(pgid, 'SIGKILL');
}

function sessionCwd(sb: Sandbox): string {
  try {
    const p = fs.readFileSync(sb.statePath('session.cwd'), 'utf8').trim();
    if (p !== '' && fs.statSync(p).isDirectory()) return p;
  } catch {
    /* first step */
  }
  return sb.home;
}

function findOnPath(bin: string, envPath: string): string | null {
  for (const dir of envPath.split(':')) {
    if (dir === '') continue;
    const p = path.join(dir, bin);
    try {
      fs.accessSync(p, fs.constants.X_OK);
      if (fs.statSync(p).isFile()) return p;
    } catch {
      /* next */
    }
  }
  return null;
}

/** Sum tokens from `ach run --json` stdout; null when unparseable. */
export function tokensFromRunJson(stdout: string): number | null {
  const t = stdout.trim();
  const candidates = [t];
  const idx = t.lastIndexOf('\n{');
  if (idx >= 0) candidates.push(t.slice(idx + 1));
  const first = t.indexOf('{');
  if (first > 0) candidates.push(t.slice(first));
  for (const c of candidates) {
    try {
      const j = JSON.parse(c) as { tokens?: Array<Record<string, unknown>> };
      if (!Array.isArray(j.tokens)) continue;
      let sum = 0;
      for (const r of j.tokens) {
        for (const k of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens']) {
          const v = r[k];
          if (typeof v === 'number' && Number.isFinite(v)) sum += v;
        }
      }
      return sum;
    } catch {
      /* next */
    }
  }
  return null;
}

function authFriction(o: AuthOutcome): Friction | null {
  switch (o.status) {
    case 'completed':
      return null;
    case 'wrong-account':
      return { kind: 'auth-wrong-account', detail: o.detail };
    case 'policy-blocked':
      return { kind: 'auth-policy-blocked', detail: o.fallback ? `${o.detail} (fallback: ${o.fallback})` : o.detail };
    default:
      return { kind: 'auth-needs-human', detail: o.loginScript ? `${o.detail} Run: ${o.loginScript}` : o.detail };
  }
}

function baseRecord(step: SmokeStep, opts: RunStepOptions): RunnerStepRecord {
  return { step, status: 'pass', exitCode: null, durationMs: 0, tokens: null, prompts: [], denials: [], friction: [], outputTail: '', attempt: opts.attempt ?? 1 };
}

// ---------------------------------------------------------------- runStep

export async function runStep(sb: Sandbox, step: SmokeStep, opts: RunStepOptions = {}): Promise<RunnerStepRecord> {
  const started = Date.now();
  const rec = baseRecord(step, opts);
  const account = step.attrs.account ?? opts.account;

  if (step.kind === 'open') {
    const hit = opts.detectAuth?.(step.text) ?? null;
    if (hit && opts.onAuth) {
      const outcome = await opts.onAuth({ ...hit, stepIndex: step.index, command: step.text, ...(account !== undefined ? { account } : {}) });
      rec.auth = outcome;
      const f = authFriction(outcome);
      if (f) rec.friction.push(f);
      rec.status = f ? 'fail' : 'pass';
      rec.outputTail = `opened ${step.text} (auth: ${outcome.status})`;
    } else {
      rec.status = 'skipped';
      rec.outputTail = `opened ${step.text} (not driven)`;
    }
    rec.durationMs = Date.now() - started;
    return rec;
  }

  const attrTimeout = Number(step.attrs.timeout);
  const timeoutMs = Number.isFinite(attrTimeout) && attrTimeout > 0 ? attrTimeout * 1000 : (opts.timeoutMs ?? DEFAULT_STEP_TIMEOUT_MS);
  const cwd = sessionCwd(sb);

  let cmd: string;
  let args: string[];
  let background = false;
  if (step.kind === 'prompt') {
    const agent = step.attrs.agent ?? opts.agent ?? 'claude';
    const bin = AGENT_BINARIES[agent] ?? agent;
    if (findOnPath(bin, sb.env.PATH ?? '') === null) {
      rec.status = 'fail';
      rec.friction.push({ kind: 'missing-prereq', detail: `agent CLI not installed — the message never installs it (\`${bin}\` is not on PATH).` });
      rec.outputTail = `${bin}: not found on the sandbox PATH`;
      rec.durationMs = Date.now() - started;
      return rec;
    }
    if (opts.achCli === undefined) {
      rec.status = 'fail';
      rec.friction.push({ kind: 'failed', detail: 'No ach entry point was given to run the prompt step.' });
      rec.durationMs = Date.now() - started;
      return rec;
    }
    cmd = process.execPath;
    args = [opts.achCli, 'run', '--agent', agent, '--json', step.text];
  } else {
    const st = sb.statePath('session.sh');
    const stQ = shq(st);
    const script = [
      `__ach_smoke_epilogue() { export -p > ${stQ}; print -r -- "cd \${(q)PWD}" >> ${stQ}; print -r -- "$PWD" > ${shq(sb.statePath('session.cwd'))}; }`,
      `trap __ach_smoke_epilogue EXIT`,
      `[[ -r "$HOME/.zprofile" ]] && source "$HOME/.zprofile"`,
      `[[ -r "$HOME/.zshrc" ]] && source "$HOME/.zshrc"`,
      `[[ -r ${stQ} ]] && source ${stQ}`,
      ...(process.platform === 'darwin'
        ? [`function /usr/bin/open { ${shq(path.join(sb.shims, 'open'))} "$@"; }`]
        : []),
      `true`,
      step.text,
    ].join('\n');
    if (sb.execGuard && process.platform === 'darwin') {
      // sandbox-exec execs its target: same pid and process group (reaping unchanged).
      cmd = '/usr/bin/sandbox-exec';
      args = ['-p', EXEC_GUARD_PROFILE, '/bin/zsh', '-c', script];
    } else {
      cmd = '/bin/zsh';
      args = ['-c', script];
    }
    background = isBackgrounding(step.text);
  }

  const child = sb.spawnTracked(cmd, args, {
    cwd,
    env: sb.env,
    stdio: [opts.input !== undefined ? 'pipe' : 'ignore', 'pipe', 'pipe'],
  });
  const pgid = child.pid;
  if (opts.input !== undefined && child.stdin) {
    child.stdin.on('error', () => {});
    child.stdin.end(opts.input);
  }

  let output = '';
  let stdout = '';
  let carry = '';
  let authPromise: Promise<void> | null = null;
  let authKilled = false;
  let timedOut = false;

  const startAuth = (hit: Omit<AuthRequest, 'stepIndex' | 'account'>) => {
    if (authPromise !== null || !opts.onAuth) return;
    const req: AuthRequest = { ...hit, stepIndex: step.index, command: step.text, ...(account !== undefined ? { account } : {}) };
    authPromise = opts.onAuth(req).then(
      (o) => {
        rec.auth = o;
        if (o.status !== 'completed') {
          authKilled = true;
          void killGroupHard(pgid);
        }
      },
      (e: unknown) => {
        rec.auth = { status: 'failed', detail: `auth handler threw: ${e instanceof Error ? e.message : String(e)}`, seenAccounts: [] };
        authKilled = true;
        void killGroupHard(pgid);
      },
    );
  };

  const onChunk = (buf: Buffer, isStdout: boolean) => {
    const s = buf.toString('utf8');
    output += s;
    if (output.length > SCAN_CAP) output = output.slice(-SCAN_CAP);
    if (isStdout) stdout += s;
    if (opts.detectAuth && authPromise === null) {
      const text = carry + s;
      const nl = text.lastIndexOf('\n');
      carry = nl >= 0 ? text.slice(nl + 1) : text;
      const hit = opts.detectAuth(text);
      if (hit) startAuth(hit);
    }
  };
  child.stdout?.on('data', (b: Buffer) => onChunk(b, true));
  child.stderr?.on('data', (b: Buffer) => onChunk(b, false));

  // Poll the open shim's log by byte offset (fs.watch misses appends on macOS).
  const openLog = sb.statePath('opened-urls.jsonl');
  let offset = 0;
  try {
    offset = fs.statSync(openLog).size;
  } catch {
    offset = 0;
  }
  let pending = '';
  const pollOpen = () => {
    let size = 0;
    try {
      size = fs.statSync(openLog).size;
    } catch {
      return;
    }
    if (size <= offset) return;
    const fd = fs.openSync(openLog, 'r');
    try {
      const b = Buffer.alloc(size - offset);
      fs.readSync(fd, b, 0, b.length, offset);
      offset = size;
      pending += b.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
    const lines = pending.split('\n');
    pending = lines.pop() ?? '';
    for (const line of lines) {
      if (authPromise !== null) return;
      let argv: string[] = [];
      try {
        const j = JSON.parse(line) as { argv?: unknown };
        if (Array.isArray(j.argv)) argv = j.argv.map(String);
      } catch {
        continue;
      }
      for (const a of argv) {
        if (isLoopbackUrl(a)) {
          (rec.localUrls ??= []).push(a);
          continue;
        }
        const hit = opts.detectAuth?.(a) ?? (/^https?:\/\//i.test(a) ? { kind: 'browser' as const, url: a } : null);
        if (hit) {
          startAuth(hit);
          break;
        }
      }
    }
  };
  const poller = opts.onAuth ? setInterval(pollOpen, OPEN_POLL_MS) : null;

  const timer = setTimeout(() => {
    timedOut = true;
    void killGroupHard(pgid);
  }, timeoutMs);

  // Service detection (shell steps only): after the grace period, a still-running
  // step whose process group listens on a TCP socket is a started server.
  let serviceSockets: string[] | null = null;
  let svcTimer: NodeJS.Timeout | null = null;
  let svcPoll: NodeJS.Timeout | null = null;
  const servicePromise =
    step.kind === 'prompt' || pgid === undefined
      ? new Promise<never>(() => {})
      : new Promise<'service'>((resolve) => {
          const check = () => {
            if (child.exitCode !== null || child.signalCode !== null) return;
            const l = listeningSockets(pgid);
            if (l.length > 0) {
              serviceSockets = l;
              resolve('service');
            }
          };
          svcTimer = setTimeout(() => {
            check();
            if (serviceSockets === null) svcPoll = setInterval(check, SERVICE_POLL_MS);
          }, opts.serviceGraceMs ?? DEFAULT_SERVICE_GRACE_MS);
        });

  const waitExit = new Promise<number | null>((resolve) => {
    let settled = false;
    child.on('error', (e) => {
      output += `\n${e.message}\n`;
      if (!settled) {
        settled = true;
        resolve(null);
      }
    });
    child.on('exit', (code, signal) => {
      if (settled) return;
      settled = true;
      // A backgrounded grandchild may hold the pipes open: give output a
      // moment to drain, then stop reading.
      const done = () => resolve(code ?? (signal ? null : null));
      let closed = false;
      child.on('close', () => {
        if (!closed) {
          closed = true;
          done();
        }
      });
      setTimeout(() => {
        if (!closed) {
          closed = true;
          child.stdout?.destroy();
          child.stderr?.destroy();
          done();
        }
      }, 300);
    });
  });
  const raced = await Promise.race([waitExit, servicePromise]);
  const exitCode: number | null = raced === 'service' ? null : raced;
  const isService = raced === 'service';
  if (svcTimer) clearTimeout(svcTimer);
  if (svcPoll) clearInterval(svcPoll);
  clearTimeout(timer);
  if (poller) {
    pollOpen();
    clearInterval(poller);
  }

  if (isService) {
    rec.service = { listening: serviceSockets ?? [] };
    rec.backgroundLeft = true;
  } else if (background) rec.backgroundLeft = true;
  else await killGroupHard(pgid);

  if (authPromise !== null) await authPromise;

  rec.exitCode = exitCode;
  const scan = scanOutput(output, exitCode, step);
  rec.prompts = scan.prompts;
  rec.denials = scan.denials;
  if (isService) {
    rec.friction.push(...scan.friction.filter((f) => f.kind !== 'failed'));
  } else if (timedOut) {
    rec.friction.push({ kind: 'timeout', detail: `The step did not finish within ${Math.round(timeoutMs / 1000)} s.` });
    // Keep prompt/denial evidence: a hang on input explains the timeout.
    for (const f of scan.friction) if (f.kind !== 'failed') rec.friction.push(f);
  } else if (authKilled) {
    for (const f of scan.friction) if (f.kind === 'interactive-prompt' || f.kind === 'keychain') rec.friction.push(f);
  } else {
    rec.friction.push(...scan.friction);
  }
  if (rec.auth) {
    const f = authFriction(rec.auth);
    if (f) rec.friction.push(f);
  }
  if (step.kind === 'prompt') rec.tokens = tokensFromRunJson(stdout);
  rec.status = isService || (!timedOut && !authKilled && exitCode === 0) ? 'pass' : 'fail';
  const tail = Buffer.from(output, 'utf8');
  rec.outputTail = tail.length > TAIL_BYTES ? tail.subarray(tail.length - TAIL_BYTES).toString('utf8') : output;
  if (isService) rec.outputTail += `${rec.outputTail.endsWith('\n') || rec.outputTail === '' ? '' : '\n'}[smoke] left running as a service (listening on ${(serviceSockets ?? []).join(', ')}) until teardown`;
  else if (background) rec.outputTail += `${rec.outputTail.endsWith('\n') || rec.outputTail === '' ? '' : '\n'}[smoke] step left background processes; reaped at teardown`;
  rec.durationMs = Date.now() - started;
  return rec;
}
