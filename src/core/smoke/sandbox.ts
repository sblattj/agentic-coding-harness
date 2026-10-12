// `ach smoke` sandbox (agentic-coding-harness#139): a brand-new user's
// machine, minus the machine.
//
// Decisions (each is tested in tests/smoke-sandbox.test.ts):
//   * Root: fs.mkdtemp under os.tmpdir() (realpath'd: /var -> /private/var,
//     so cwd checks and recorded paths agree), overridable with opts.root.
//     Layout: <root>/home (HOME), <root>/tmp (TMPDIR), <root>/state (harness
//     files: opened-urls.jsonl, session.sh), <root>/shims (harness PATH shims).
//   * The env is built FROM SCRATCH, never by filtering process.env: a filter
//     leaks whatever variable nobody thought of. Every config-dir redirect a
//     CLI honours lives in ONE table (SANDBOX_CONFIG_VARS) pointing under the
//     sandbox HOME, so a tool that ignores HOME but reads e.g. CODEX_HOME still
//     lands in the sandbox. opts.env merges last (stub URLs, proxies);
//     opts.extraPath appends to PATH (--allow-path).
//   * `open` / `xdg-open` shims (and BROWSER) append their argv as one JSON
//     line to <state>/opened-urls.jsonl and exit 0: a CLI that launches "the
//     browser" never reaches the user's real default browser; the runner turns
//     those lines into auth requests (src/core/smoke/runner.ts).
//   * Keychain (darwin): the host search list + default keychain are
//     snapshotted with the REAL env before anything else. The sandbox gets its
//     own <home>/Library/Keychains/login.keychain-db (random password,
//     unlocked, no auto-lock), which under that HOME is the default keychain
//     and the whole search list. Without it `security` (and every CLI that
//     stores a token) hangs on a host GUI popup, so every `security` call has a
//     15 s deadline. Teardown deletes the sandbox keychain, re-reads the host
//     list/default and restores the snapshot only if they changed.
//   * Reaping: every process the harness spawns goes through spawnTracked
//     (detached: own process group). Teardown kills each tracked group
//     (SIGTERM, 2 s, SIGKILL) — that covers `cmd &` and `nohup cmd &`, which
//     keep the group even after reparenting to launchd. Escapees that left
//     the group (setsid, double-fork daemons) are swept by the UNION of two
//     discriminators, because neither alone is enough on macOS:
//       - `ps -E -ww -axo pid=,command=` containing the token HOME=<home>.
//         Measured: `ps -E` appends the environment only for non-platform
//         binaries (node, python, user-installed CLIs); for Apple platform
//         binaries (/bin/sleep, /bin/zsh) it prints the command alone.
//       - `lsof -a -d cwd -u <uid> -Fpn`: any process whose cwd is under the
//         sandbox root (catches platform binaries started from a step's cwd).
//     Known gap: a platform binary that setsid's AND chdir's out of the root
//     is not caught.
//   * SIGINT/SIGTERM/exit: one module-level set of handlers (installed while
//     any sandbox is live) runs a synchronous best-effort teardown: kill the
//     tracked groups and verify/restore the host keychain list. Normal
//     teardown unregisters the sandbox.

import { spawn, spawnSync, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { HarnessError } from '../types.ts';

/** Deadline for every `security` call: a hang means a host GUI popup. */
export const SECURITY_TIMEOUT_MS = 15_000;
const SECURITY_BIN = '/usr/bin/security';

/**
 * Every config-dir redirect the sandbox sets. Values starting with `~` are
 * paths under the sandbox HOME; anything else is a literal value.
 * GEMINI_CLI_HOME is confirmed in @google/gemini-cli's bundle
 * (`const envHome = process.env["GEMINI_CLI_HOME"]; if (envHome) return envHome; return os.homedir();`),
 * so it is a HOME replacement and points at the sandbox HOME itself.
 */
export const SANDBOX_CONFIG_VARS: Readonly<Record<string, string>> = Object.freeze({
  XDG_CONFIG_HOME: '~/.config',
  XDG_DATA_HOME: '~/.local/share',
  XDG_CACHE_HOME: '~/.cache',
  XDG_STATE_HOME: '~/.local/state',
  npm_config_prefix: '~/.npm-global',
  npm_config_cache: '~/.npm',
  npm_config_userconfig: '~/.npmrc',
  GIT_CONFIG_GLOBAL: '~/.gitconfig',
  GIT_CONFIG_NOSYSTEM: '1',
  CLAUDE_CONFIG_DIR: '~/.claude',
  CODEX_HOME: '~/.codex',
  GEMINI_CLI_HOME: '~',
  GH_CONFIG_DIR: '~/.config/gh',
  AZURE_CONFIG_DIR: '~/.azure',
  CLOUDSDK_CONFIG: '~/.config/gcloud',
  AWS_CONFIG_FILE: '~/.aws/config',
  AWS_SHARED_CREDENTIALS_FILE: '~/.aws/credentials',
  KUBECONFIG: '~/.kube/config',
  DOCKER_CONFIG: '~/.docker',
  CARGO_HOME: '~/.cargo',
  RUSTUP_HOME: '~/.rustup',
  GOPATH: '~/go',
  BUN_INSTALL: '~/.bun',
  PNPM_HOME: '~/.local/share/pnpm',
  NVM_DIR: '~/.nvm',
  PIP_CONFIG_FILE: '~/.config/pip/pip.conf',
  HOMEBREW_NO_AUTO_UPDATE: '1',
});

/** Directories created up front (tools expect XDG dirs to exist). */
const PRECREATE = ['.config', '.local/share', '.local/state', '.local/bin', '.cache', '.npm-global/bin'];

export interface SandboxOptions {
  /** Parent dir for the sandbox root (default os.tmpdir()). */
  root?: string;
  /** Create a per-sandbox keychain on darwin (default true). */
  keychain?: boolean;
  /** Dirs appended to PATH (e.g. --allow-path). */
  extraPath?: string[];
  /** Merged last into the env (stub URLs, proxies). */
  env?: Record<string, string>;
  /** Keep the root on teardown (default false). */
  keep?: boolean;
}

export interface TeardownResult {
  /** Processes still alive at teardown that the harness killed. */
  reapedPids: number[];
  /** Host keychain list + default identical before/after (null off darwin or keychain disabled). */
  hostKeychainUnchanged: boolean | null;
  /** The host list/default changed and was restored from the snapshot. */
  keychainRestored: boolean;
  /** The kept root, when opts.keep. */
  kept: string | null;
}

export interface Sandbox {
  root: string;
  home: string;
  tmp: string;
  shims: string;
  env: Record<string, string>;
  /** Path of a harness file under <root>/state. */
  statePath(name: string): string;
  keychainPath: string | null;
  /** Spawn in its own process group (detached); the group is reaped on teardown. */
  spawnTracked(cmd: string, args: string[], opts?: SpawnOptions): ChildProcess;
  trackedPgids: Set<number>;
  teardown(): Promise<TeardownResult>;
}

// ---------------------------------------------------------------- host keychain

export interface HostKeychainSnapshot {
  /** Raw `security list-keychains -d user` stdout. */
  list: string;
  /** Raw `security default-keychain -d user` stdout. */
  default: string;
}

function security(args: string[], env: NodeJS.ProcessEnv): { status: number | null; stdout: string; stderr: string; timedOut: boolean } {
  const r = spawnSync(SECURITY_BIN, args, { env, timeout: SECURITY_TIMEOUT_MS, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const timedOut = (r.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT' || r.signal === 'SIGTERM';
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', timedOut };
}

/** Read the host's user-domain keychain search list and default (REAL env). */
export function readHostKeychain(): HostKeychainSnapshot {
  const l = security(['list-keychains', '-d', 'user'], process.env);
  const d = security(['default-keychain', '-d', 'user'], process.env);
  if (l.timedOut || d.timedOut) throw new HarnessError('security timed out reading the host keychain list', 'SMOKE_KEYCHAIN');
  return { list: l.stdout, default: d.stdout };
}

function keychainEntries(out: string): string[] {
  return out
    .split('\n')
    .map((s) => s.trim().replace(/^"(.*)"$/, '$1'))
    .filter((s) => s !== '');
}

/** Restore the host list/default to `snap` if they differ. Returns [unchanged, restored]. */
function verifyHostKeychain(snap: HostKeychainSnapshot): { unchanged: boolean; restored: boolean } {
  let now: HostKeychainSnapshot;
  try {
    now = readHostKeychain();
  } catch {
    return { unchanged: false, restored: false };
  }
  if (now.list === snap.list && now.default === snap.default) return { unchanged: true, restored: false };
  let ok = true;
  if (now.list !== snap.list) {
    const r = security(['list-keychains', '-d', 'user', '-s', ...keychainEntries(snap.list)], process.env);
    ok &&= r.status === 0;
  }
  const def = keychainEntries(snap.default)[0];
  if (now.default !== snap.default && def !== undefined) {
    const r = security(['default-keychain', '-d', 'user', '-s', def], process.env);
    ok &&= r.status === 0;
  }
  return { unchanged: false, restored: ok };
}

// ---------------------------------------------------------------- process helpers

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
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

/** pid -> pgid for every process (`ps -axo pid=,pgid=`). */
function listGroups(): Map<number, number> {
  const r = spawnSync('/bin/ps', ['-axo', 'pid=,pgid='], { encoding: 'utf8', timeout: 10_000 });
  const m = new Map<number, number>();
  for (const line of (r.stdout ?? '').split('\n')) {
    const [a, b] = line.trim().split(/\s+/);
    const pid = Number(a);
    const pgid = Number(b);
    if (Number.isInteger(pid) && Number.isInteger(pgid) && pid > 0) m.set(pid, pgid);
  }
  return m;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Processes that escaped the tracked groups: `ps -E` shows HOME=<home>, or
 * the cwd (lsof) is under the sandbox root. Excludes this process.
 */
export function findEscapees(home: string, root: string): number[] {
  const out = new Set<number>();
  const homeRe = new RegExp(`(^|\\s)HOME=${escapeRe(home)}(\\s|$)`);
  const ps = spawnSync('/bin/ps', ['-E', '-ww', '-axo', 'pid=,command='], { encoding: 'utf8', timeout: 10_000, maxBuffer: 256 * 1024 * 1024 });
  for (const line of (ps.stdout ?? '').split('\n')) {
    const m = /^\s*(\d+)\s(.*)$/.exec(line);
    if (m && homeRe.test(m[2]!)) out.add(Number(m[1]));
  }
  const uid = String(process.getuid?.() ?? '');
  if (uid !== '') {
    const lsof = spawnSync('/usr/sbin/lsof', ['-a', '-d', 'cwd', '-u', uid, '-Fpn'], { encoding: 'utf8', timeout: 20_000, maxBuffer: 64 * 1024 * 1024 });
    let pid = 0;
    const prefix = root.endsWith('/') ? root : root + '/';
    for (const line of (lsof.stdout ?? '').split('\n')) {
      if (line.startsWith('p')) pid = Number(line.slice(1));
      else if (line.startsWith('n') && pid > 0) {
        const p = line.slice(1);
        if (p === root || p.startsWith(prefix)) out.add(pid);
      }
    }
  }
  out.delete(process.pid);
  // Never kill an ancestor of this process (e.g. a test runner started inside the root).
  out.delete(process.ppid);
  return [...out].sort((a, b) => a - b);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- signal registry

interface LiveSandbox {
  pgids: Set<number>;
  snapshot: HostKeychainSnapshot | null;
  root: string;
  keep: boolean;
}

const live = new Set<LiveSandbox>();
let handlersInstalled = false;

function syncTeardownAll(): void {
  for (const s of live) {
    for (const g of s.pgids) {
      try {
        process.kill(-g, 'SIGKILL');
      } catch {
        /* gone */
      }
    }
    if (s.snapshot !== null) {
      try {
        verifyHostKeychain(s.snapshot);
      } catch {
        /* best effort */
      }
    }
    if (!s.keep) {
      try {
        fs.rmSync(s.root, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    }
  }
  live.clear();
}

function onSignal(sig: NodeJS.Signals): void {
  syncTeardownAll();
  uninstallHandlers();
  process.kill(process.pid, sig);
}
const onSigint = () => onSignal('SIGINT');
const onSigterm = () => onSignal('SIGTERM');
const onExit = () => syncTeardownAll();

function installHandlers(): void {
  if (handlersInstalled) return;
  process.on('SIGINT', onSigint);
  process.on('SIGTERM', onSigterm);
  process.on('exit', onExit);
  handlersInstalled = true;
}

function uninstallHandlers(): void {
  if (!handlersInstalled) return;
  process.off('SIGINT', onSigint);
  process.off('SIGTERM', onSigterm);
  process.off('exit', onExit);
  handlersInstalled = false;
}

/** Test hook: are the module-level signal handlers installed? */
export function signalHandlersInstalled(): boolean {
  return handlersInstalled;
}

// ---------------------------------------------------------------- shims

function shimScript(log: string): string {
  const q = `'${log.replace(/'/g, `'\\''`)}'`;
  return `#!/bin/bash
# ach smoke browser shim (#139): record the argv instead of opening anything.
esc() { local s=$1; s=\${s//\\\\/\\\\\\\\}; s=\${s//\\"/\\\\\\"}; s=\${s//$'\\n'/\\\\n}; s=\${s//$'\\r'/\\\\r}; s=\${s//$'\\t'/\\\\t}; printf '%s' "$s"; }
out='['; sep=''
for a in "$@"; do out+="$sep\\"$(esc "$a")\\""; sep=','; done
out+=']'
printf '{"at":"%s","argv":%s}\\n' "$(/bin/date -u +%Y-%m-%dT%H:%M:%SZ)" "$out" >> ${q}
exit 0
`;
}

// ---------------------------------------------------------------- createSandbox

export async function createSandbox(opts: SandboxOptions = {}): Promise<Sandbox> {
  const useKeychain = process.platform === 'darwin' && opts.keychain !== false;
  // Snapshot the host BEFORE anything else touches it.
  const snapshot = useKeychain ? readHostKeychain() : null;

  const parent = opts.root ?? os.tmpdir();
  const root = fs.realpathSync(fs.mkdtempSync(path.join(fs.realpathSync(parent), 'ach-smoke-')));
  const home = path.join(root, 'home');
  const tmp = path.join(root, 'tmp');
  const state = path.join(root, 'state');
  const shims = path.join(root, 'shims');
  for (const d of [home, tmp, state, shims]) fs.mkdirSync(d, { recursive: true });
  for (const d of PRECREATE) fs.mkdirSync(path.join(home, d), { recursive: true });

  const log = path.join(state, 'opened-urls.jsonl');
  for (const name of ['open', 'xdg-open']) {
    fs.writeFileSync(path.join(shims, name), shimScript(log), { mode: 0o755 });
  }

  const user = os.userInfo().username;
  const env: Record<string, string> = {
    HOME: home,
    USER: user,
    LOGNAME: user,
    SHELL: '/bin/zsh',
    LANG: 'en_US.UTF-8',
    TERM: 'xterm-256color',
    TMPDIR: tmp,
    PATH: [shims, path.join(home, '.local/bin'), path.join(home, '.npm-global/bin'), '/usr/bin', '/bin', '/usr/sbin', '/sbin', ...(opts.extraPath ?? [])].join(':'),
    BROWSER: path.join(shims, 'open'),
  };
  for (const [k, v] of Object.entries(SANDBOX_CONFIG_VARS)) {
    env[k] = v === '~' ? home : v.startsWith('~/') ? path.join(home, v.slice(2)) : v;
  }
  Object.assign(env, opts.env ?? {});

  const reg: LiveSandbox = { pgids: new Set<number>(), snapshot, root, keep: opts.keep === true };
  live.add(reg);
  installHandlers();

  let keychainPath: string | null = null;
  if (useKeychain) {
    const kc = path.join(home, 'Library', 'Keychains', 'login.keychain-db');
    fs.mkdirSync(path.dirname(kc), { recursive: true });
    // A random password, not an empty one: GitHub's macos-15 runners reject
    // `unlock-keychain -p ""` ("The user name or passphrase you entered is not
    // correct") although this Mac accepts it. Kept in <state>/keychain-password
    // (0600) so a step or a --keep'd sandbox can unlock it again.
    const pw = randomBytes(18).toString('base64url');
    fs.writeFileSync(path.join(state, 'keychain-password'), pw + '\n', { mode: 0o600 });
    for (const args of [
      ['create-keychain', '-p', pw, kc],
      ['unlock-keychain', '-p', pw, kc],
      ['set-keychain-settings', kc],
    ]) {
      const r = security(args, env);
      if (r.timedOut || r.status !== 0) {
        live.delete(reg);
        if (live.size === 0) uninstallHandlers();
        if (snapshot) verifyHostKeychain(snapshot);
        fs.rmSync(root, { recursive: true, force: true });
        throw new HarnessError(
          `sandbox keychain: security ${args[0]} ${r.timedOut ? 'timed out (host popup?)' : `failed: ${r.stderr.trim()}`}`,
          'SMOKE_KEYCHAIN',
        );
      }
    }
    keychainPath = kc;
  }

  let done: TeardownResult | null = null;

  const sb: Sandbox = {
    root,
    home,
    tmp,
    shims,
    env,
    keychainPath,
    trackedPgids: reg.pgids,
    statePath: (name: string) => path.join(state, name),
    spawnTracked(cmd, args, o = {}) {
      const child = spawn(cmd, args, { cwd: home, env, ...o, detached: true });
      if (child.pid !== undefined) reg.pgids.add(child.pid);
      return child;
    },
    async teardown() {
      if (done) return done;
      const reaped = new Set<number>();
      // (1) tracked process groups.
      const groups = listGroups();
      const tracked = [...reg.pgids];
      for (const [pid, pgid] of groups) if (tracked.includes(pgid) && pid !== process.pid) reaped.add(pid);
      for (const g of tracked) {
        try {
          process.kill(-g, 'SIGTERM');
        } catch {
          /* gone */
        }
      }
      const deadline = Date.now() + 2000;
      while (Date.now() < deadline && tracked.some(groupAlive)) await sleep(50);
      for (const g of tracked) {
        if (groupAlive(g)) {
          try {
            process.kill(-g, 'SIGKILL');
          } catch {
            /* gone */
          }
        }
      }
      // (2) orphan sweep.
      const esc = findEscapees(home, root);
      for (const pid of esc) {
        reaped.add(pid);
        try {
          process.kill(pid, 'SIGTERM');
        } catch {
          /* gone */
        }
      }
      const d2 = Date.now() + 2000;
      while (Date.now() < d2 && esc.some(alive)) await sleep(50);
      for (const pid of esc) {
        if (alive(pid)) {
          try {
            process.kill(pid, 'SIGKILL');
          } catch {
            /* gone */
          }
        }
      }
      // (3) sandbox keychain.
      if (keychainPath !== null) security(['delete-keychain', keychainPath], env);
      // (4) host keychain verify / restore.
      let hostKeychainUnchanged: boolean | null = null;
      let keychainRestored = false;
      if (snapshot !== null) {
        const v = verifyHostKeychain(snapshot);
        hostKeychainUnchanged = v.unchanged;
        keychainRestored = v.restored;
      }
      // (5) root.
      if (!reg.keep) fs.rmSync(root, { recursive: true, force: true });
      live.delete(reg);
      if (live.size === 0) uninstallHandlers();
      done = { reapedPids: [...reaped].sort((a, b) => a - b), hostKeychainUnchanged, keychainRestored, kept: reg.keep ? root : null };
      return done;
    },
  };
  return sb;
}
