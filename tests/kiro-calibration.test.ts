/**
 * OPT-IN PAID CALIBRATION — this file spends real Kiro credits.
 *
 * Skipped unless `KIRO_CALIBRATION=1`. Everything else under `tests/` runs
 * against fixtures and the fake ACP server; this is the one test that drives
 * the real `kiro-cli` against the real service.
 *
 *   KIRO_CALIBRATION=1 KIRO_CALIBRATION_AGENT=<native agent> \
 *     node --import tsx --test --test-timeout=240000 tests/kiro-calibration.test.ts
 *
 * What it proves: the credit figure the harness reports is the same number
 * kiro-cli's OWN session store charges — re-summed here straight off disk the
 * way tests/driver.test.ts (`FIXTURE_CREDITS`) sums the fixture — and every
 * usage figure the harness prints is either real or explicitly `unavailable`
 * (no fabricated zeros).
 *
 * Cost: two prompts to claude-haiku-4.5 (one headless, one ACP), ~0.04 credits
 * each as observed on 2026-09-12 against kiro-cli 2.21.2.
 *
 * There is no "precondition failed, so pass" path here: a missing binary, a
 * missing session store or a non-success run all FAIL with the precondition
 * named in the message.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, test } from "node:test";

const CLI = new URL("../src/cli/harness.ts", import.meta.url).pathname;

const ENABLED = process.env.KIRO_CALIBRATION === "1";
const SKIP_REASON = "set KIRO_CALIBRATION=1 to run the paid calibration (spends credits)";
/**
 * The skip rides on each `test()`, not on the `describe()`. Measured on node
 * v24.15.0: `describe(name, { skip }, …)` short-circuits the suite body, so no
 * subtest is ever registered and the runner summary reports `skipped 0` — the
 * suite lands under `suites`. Per-test skips report `skipped 4`, which is what
 * makes "this file was skipped, not silently absent" observable in `npm test`.
 */
const SKIP: false | string = ENABLED ? false : SKIP_REASON;

const MODEL = "claude-haiku-4.5";
const PROMPT = "Reply with exactly the word pong.";
/** Credit figures are IEEE doubles carried through JSON; compare, never equate. */
const EPS = 1e-9;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ------------------------------------------------------------------ shapes

interface RunOut {
  code: number;
  stdout: string;
  stderr: string;
}

interface TokenRecord {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

interface CalibrationJson {
  exitStatus: string;
  warnings: unknown[];
  totalCost: number;
  tokens: TokenRecord[];
  events: Array<Record<string, unknown>>;
  usage: {
    tokens: { available: boolean };
    credits: {
      available: boolean;
      value?: number;
      sources?: Partial<Record<"stream" | "session-store" | "tap", number>>;
    };
    context?: { available: boolean; tokens?: number };
  };
  kiro: {
    cliVersion: string;
    transport: string;
    nativeSessionId?: string;
    modelAck: string;
    effective: { argv?: string[]; trustFlag?: unknown };
  };
}

/** Numbers echoed to stdout so the operator sees them on a green run. */
interface Observation {
  transport: string;
  cliVersion: string;
  modelAck: string;
  credits: number;
  stream: number | undefined;
  sessionStore: number | undefined;
  tap: number | undefined;
  storeResum: number;
}

// ----------------------------------------------------------------- helpers

/** Same shape as tests/cli.test.ts `runCli` — drive the REAL entry point. */
function runCli(args: string[], env: Record<string, string>): RunOut {
  // bun runs .ts natively; node needs the tsx loader.
  const isBun = (process.versions as { bun?: string }).bun !== undefined;
  const p = spawnSync(process.execPath, isBun ? [CLI, ...args] : ["--import", "tsx", CLI, ...args], {
    env: { ...process.env, ...env },
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    timeout: 180_000,
  });
  return {
    code: p.status ?? -1,
    stdout: p.stdout ?? "",
    stderr: p.stderr ?? "",
  };
}

/** Mirrors `kiroSessionsDir()` in src/adapters/kiro-session-store.ts. */
function kiroSessionsDir(): string {
  return process.env.KIRO_SESSIONS_DIR ?? path.join(os.homedir(), ".kiro", "sessions", "cli");
}

/**
 * Re-sum the credits kiro-cli's own store records for a session, exactly the
 * way tests/driver.test.ts derives FIXTURE_CREDITS from the fixture.
 */
function resumSessionStoreCredits(file: string): number {
  const raw = JSON.parse(fs.readFileSync(file, "utf8")) as {
    session_state?: {
      conversation_metadata?: {
        user_turn_metadatas?: Array<{ metering_usage?: Array<{ value: number }> }>;
      };
    };
  };
  const turns = raw.session_state?.conversation_metadata?.user_turn_metadatas;
  assert.ok(
    Array.isArray(turns) && turns.length > 0,
    `precondition: ${file} has no session_state.conversation_metadata.user_turn_metadatas[] to re-sum`,
  );
  return turns.reduce(
    (sum, t) => sum + (t.metering_usage ?? []).reduce((a, m) => a + m.value, 0),
    0,
  );
}

function parseJsonStdout(out: RunOut, label: string): CalibrationJson {
  try {
    return JSON.parse(out.stdout.trim()) as CalibrationJson;
  } catch (err) {
    assert.fail(
      `${label}: --json stdout is not parseable JSON (${String(err)})\n` +
        `stdout head: ${out.stdout.slice(0, 400)}\n` +
        `stderr tail: ${out.stderr.slice(-800)}`,
    );
  }
}

/** The final assistant text: events[] carries `{type:'message', source:'agent', content}`. */
function agentReply(json: CalibrationJson): string {
  const texts: string[] = [];
  for (const e of json.events) {
    if (e.type === "message" && e.source === "agent" && typeof e.content === "string") {
      texts.push(e.content);
    }
  }
  return texts.join("\n");
}

const observations: Observation[] = [];

/** One paid run + every assertion the calibration claim rests on. */
function calibrate(transport: "headless" | "acp"): void {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), `kiro-calib-${transport}-`));
  const agent = process.env.KIRO_CALIBRATION_AGENT;
  const args = [
    "run",
    "--agent",
    "kiro",
    "--model",
    MODEL,
    "--json",
    ...(transport === "acp" ? ["--kiro-transport", "acp"] : []),
    ...(agent !== undefined && agent !== "" ? ["--kiro-agent", agent] : []),
    PROMPT,
  ];

  const out = runCli(args, { AGENT_HARNESS_STATE_DIR: stateDir });
  const json = parseJsonStdout(out, transport);

  // --- the run itself -----------------------------------------------------
  assert.equal(
    json.exitStatus,
    "success",
    `${transport}: exitStatus is '${json.exitStatus}' (cli exit ${out.code}); stderr tail: ${out.stderr.slice(-1200)}`,
  );
  assert.deepEqual(json.warnings, [], `${transport}: run raised warnings`);

  // --- credits: the calibration claim -------------------------------------
  const credits = json.usage.credits;
  assert.equal(credits.available, true, `${transport}: usage.credits.available is not true`);
  assert.ok(
    typeof credits.value === "number" && credits.value > 0,
    `${transport}: usage.credits.value is ${String(credits.value)}, expected a positive number`,
  );
  const sources = credits.sources ?? {};
  const stream = sources.stream;
  const store = sources["session-store"];
  assert.ok(
    typeof stream === "number",
    `${transport}: usage.credits.sources.stream missing (got ${JSON.stringify(sources)})`,
  );
  assert.ok(
    typeof store === "number",
    `${transport}: usage.credits.sources['session-store'] missing (got ${JSON.stringify(sources)})`,
  );
  assert.ok(
    Math.abs(stream - store) <= EPS,
    `${transport}: stream (${stream}) and session-store (${store}) credits disagree by ${Math.abs(stream - store)}`,
  );
  assert.ok(
    Math.abs(credits.value - stream) <= EPS,
    `${transport}: usage.credits.value (${credits.value}) is not the stream figure (${stream})`,
  );
  const tap = sources.tap;
  if (typeof tap === "number") {
    assert.ok(
      Math.abs(tap - stream) <= EPS,
      `${transport}: MITM tap credits (${tap}) disagree with the stream figure (${stream})`,
    );
  }

  // --- usage is real or explicitly unavailable — never fabricated ----------
  if (json.usage.tokens.available === false) {
    for (const [i, t] of json.tokens.entries()) {
      assert.deepEqual(
        {
          inputTokens: t.inputTokens,
          outputTokens: t.outputTokens,
          cacheReadTokens: t.cacheReadTokens,
          cacheWriteTokens: t.cacheWriteTokens,
        },
        { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
        `${transport}: usage.tokens.available===false but tokens[${i}] carries a non-zero count — a fabricated figure`,
      );
    }
    assert.equal(
      json.totalCost,
      0,
      `${transport}: usage.tokens.available===false but totalCost is ${json.totalCost} — priced from counts the CLI never reported`,
    );
  } else {
    const totalIn = json.tokens.reduce((a, t) => a + t.inputTokens + t.cacheReadTokens + t.cacheWriteTokens, 0);
    const totalOut = json.tokens.reduce((a, t) => a + t.outputTokens, 0);
    assert.ok(
      totalIn > 0,
      `${transport}: usage.tokens.available===true but every input/cache count is 0 across ${json.tokens.length} records`,
    );
    assert.ok(
      totalOut > 0,
      `${transport}: usage.tokens.available===true but every outputTokens is 0 across ${json.tokens.length} records`,
    );
  }

  const ctx = json.usage.context;
  assert.ok(ctx !== undefined, `${transport}: usage.context is absent`);
  assert.equal(ctx.available, true, `${transport}: usage.context.available is not true`);
  assert.ok(
    typeof ctx.tokens === "number" && ctx.tokens > 0,
    `${transport}: usage.context.tokens is ${String(ctx.tokens)}, expected a positive derived figure`,
  );

  // --- provenance ---------------------------------------------------------
  // The harness does NOT normalize cliVersion across transports: headless
  // parses `kiro-cli --version` stdout (src/adapters/kiro.ts, `#cliVersion`)
  // and keeps the "kiro-cli " prefix; ACP takes the handshake's
  // `agentInfo.version` (src/adapters/kiro-acp.ts, `handshake`) which is bare.
  // Both degrade to the literal 'unknown' on failure, so each regex is a real
  // assertion; the cross-run test below pins that the NUMBERS agree.
  const versionRe = transport === "headless" ? /^kiro-cli \d+\.\d+/ : /^\d+\.\d+/;
  assert.match(
    json.kiro.cliVersion,
    versionRe,
    `${transport}: kiro.cliVersion '${json.kiro.cliVersion}' does not match ${String(versionRe)}`,
  );
  const nativeSessionId = json.kiro.nativeSessionId;
  assert.ok(
    typeof nativeSessionId === "string" && UUID_RE.test(nativeSessionId),
    `${transport}: kiro.nativeSessionId '${String(nativeSessionId)}' is not a uuid`,
  );
  assert.equal(json.kiro.transport, transport, `${transport}: kiro.transport mismatch`);

  if (transport === "headless") {
    assert.ok(
      ["unsupported", "unverified", "acknowledged"].includes(json.kiro.modelAck),
      `headless: kiro.modelAck is '${json.kiro.modelAck}', expected unsupported|unverified|acknowledged (cliVersion ${json.kiro.cliVersion})`,
    );
    const argv = json.kiro.effective.argv ?? [];
    const i = argv.indexOf("--model");
    assert.ok(
      i >= 0 && argv[i + 1] === MODEL,
      `headless: kiro.effective.argv does not forward --model ${MODEL} (argv: ${JSON.stringify(argv)})`,
    );
    assert.equal(
      json.kiro.effective.trustFlag,
      null,
      `headless: kiro.effective.trustFlag is ${JSON.stringify(json.kiro.effective.trustFlag)}, expected null (no --trust-tools requested)`,
    );
  } else {
    assert.equal(
      json.kiro.modelAck,
      "acknowledged",
      `acp: kiro.modelAck is '${json.kiro.modelAck}', expected 'acknowledged' — observed on kiro-cli 2.21.2; this run reported cliVersion '${json.kiro.cliVersion}', so a newer CLI may have changed the ACP model handshake`,
    );
  }

  // --- THE CALIBRATION: re-sum the CLI's own store ------------------------
  const storeFile = path.join(kiroSessionsDir(), `${nativeSessionId}.json`);
  assert.ok(
    fs.existsSync(storeFile),
    `${transport}: precondition failed — kiro-cli session store not found at ${storeFile} (set KIRO_SESSIONS_DIR if the CLI writes elsewhere)`,
  );
  const resum = resumSessionStoreCredits(storeFile);
  assert.ok(
    Math.abs(resum - store) <= EPS,
    `${transport}: session store at ${storeFile} sums to ${resum} but the harness reported sources['session-store'] = ${store}`,
  );
  assert.ok(
    Math.abs(resum - credits.value) <= EPS,
    `${transport}: session store at ${storeFile} sums to ${resum} but the harness reported usage.credits.value = ${credits.value}`,
  );

  // --- the model actually answered ----------------------------------------
  const reply = agentReply(json);
  assert.match(
    reply,
    /pong/i,
    `${transport}: no assistant message event contained 'pong' (events[] message/agent content: ${JSON.stringify(reply).slice(0, 400)})`,
  );

  const obs: Observation = {
    transport,
    cliVersion: json.kiro.cliVersion,
    modelAck: json.kiro.modelAck,
    credits: credits.value,
    stream,
    sessionStore: store,
    tap,
    storeResum: resum,
  };
  observations.push(obs);
  console.log(
    `[kiro-calibration] transport=${obs.transport} cliVersion="${obs.cliVersion}" modelAck=${obs.modelAck} ` +
      `credits=${obs.credits} stream=${String(obs.stream)} session-store=${String(obs.sessionStore)} tap=${String(obs.tap)} ` +
      `store-resum=${obs.storeResum}`,
  );
}

// ------------------------------------------------------------------- suite

describe("kiro paid calibration", () => {
  test("precondition: the kiro-cli binary runs", { skip: SKIP }, () => {
    const bin = process.env.KIRO_CLI_BIN ?? "kiro-cli";
    const p = spawnSync(bin, ["--version"], { encoding: "utf8", timeout: 30_000 });
    assert.ok(
      p.error === undefined && (p.stdout ?? "").trim() !== "",
      `precondition failed — '${bin} --version' produced no output (error: ${String(p.error)}); ` +
        `set KIRO_CLI_BIN or put kiro-cli on PATH`,
    );
    console.log(`[kiro-calibration] binary=${bin} version="${(p.stdout ?? "").trim()}"`);
  });

  test("headless run: reported credits equal kiro-cli's own session store", { skip: SKIP }, () => {
    calibrate("headless");
  });

  test("acp run: reported credits equal kiro-cli's own session store", { skip: SKIP }, () => {
    calibrate("acp");
  });

  test("both transports report the same kiro-cli version number", { skip: SKIP }, () => {
    assert.equal(
      observations.length,
      2,
      `expected both paid runs to have completed, got ${observations.length}`,
    );
    const numeric = observations.map((o) => o.cliVersion.replace(/^kiro-cli\s+/, ""));
    assert.equal(
      numeric[0],
      numeric[1],
      `headless reported '${observations[0]?.cliVersion}' and acp reported '${observations[1]?.cliVersion}'`,
    );
    const total = observations.reduce((a, o) => a + o.credits, 0);
    console.log(`[kiro-calibration] total credits spent by this file: ${total}`);
  });
});
