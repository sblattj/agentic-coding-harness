// Preloaded into every test file by `npm test` (--import). Gives every
// synchronous child-process call a time limit when the caller set none, so a
// hung child (or an orphaned grandchild that keeps the stdout pipe open) fails
// the test that spawned it instead of blocking the file until the CI job is
// cancelled. A call that passes its own `timeout` is left untouched.
//
// spawnSync blocks the event loop, so node:test's own per-test timeout cannot
// interrupt it; the limit has to live on the spawn call itself.
import { createRequire, syncBuiltinESMExports } from "node:module";
import { basename } from "node:path";

const require = createRequire(import.meta.url);
const cp = require("node:child_process");

export const DEFAULT_SPAWN_TIMEOUT_MS = Number(process.env.ACH_TEST_SPAWN_TIMEOUT_MS) || 90_000;

const testFile = basename(process.argv[1] ?? "?");

function describe(file, args) {
  const argv = Array.isArray(args) ? args : [];
  return [file, ...argv].map(String).join(" ").slice(0, 300);
}

function report(file, args, ms) {
  process.stderr.write(
    `[spawn-timeout] ${testFile}: child timed out after ${ms} ms and was killed: ${describe(file, args)}\n`,
  );
}

// Overloads: (file), (file, args), (file, options), (file, args, options).
function withTimeout(args, options) {
  let argv = args;
  let opts = options;
  if (!Array.isArray(argv) && argv !== undefined && argv !== null && opts === undefined) {
    opts = argv;
    argv = undefined;
  }
  const own = opts?.timeout;
  if (own !== undefined && own !== null && own > 0) return { argv, opts, ms: own, injected: false };
  return { argv, opts: { ...opts, timeout: DEFAULT_SPAWN_TIMEOUT_MS }, ms: DEFAULT_SPAWN_TIMEOUT_MS, injected: true };
}

const origSpawnSync = cp.spawnSync;
cp.spawnSync = function spawnSync(file, args, options) {
  const { argv, opts, ms, injected } = withTimeout(args, options);
  const r = argv === undefined ? origSpawnSync(file, opts) : origSpawnSync(file, argv, opts);
  if (injected && r.error?.code === "ETIMEDOUT") report(file, argv, ms);
  return r;
};

const origExecFileSync = cp.execFileSync;
cp.execFileSync = function execFileSync(file, args, options) {
  const { argv, opts, ms, injected } = withTimeout(args, options);
  try {
    return argv === undefined ? origExecFileSync(file, opts) : origExecFileSync(file, argv, opts);
  } catch (err) {
    if (injected && err?.code === "ETIMEDOUT") report(file, argv, ms);
    throw err;
  }
};

const origExecSync = cp.execSync;
cp.execSync = function execSync(command, options) {
  const own = options?.timeout;
  const injected = !(own > 0);
  const opts = injected ? { ...options, timeout: DEFAULT_SPAWN_TIMEOUT_MS } : options;
  try {
    return origExecSync(command, opts);
  } catch (err) {
    if (injected && err?.code === "ETIMEDOUT") report(command, [], DEFAULT_SPAWN_TIMEOUT_MS);
    throw err;
  }
};

// Make `import { spawnSync } from "node:child_process"` see the wrappers.
syncBuiltinESMExports();
