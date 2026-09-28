// `ach regrade <run-id> --verify '<cmd>'` (#89): re-score a saved run under a
// new checker without re-running (or paying for) the agent.
//
// What it grades: the run's recorded cwd AS IT IS NOW. The harness does not
// snapshot workspaces, so a regrade is only meaningful while the workspace
// still holds the run's output; a missing cwd is a clear error. The verdict
// is APPENDED to the record's `regrades` array — the run-time `verify` verdict
// and the event transcript are never touched.
import fs from "node:fs";
import { parseArgs } from "node:util";

import { stateDir } from "../core/store.ts";
import { HarnessError } from "../core/types.ts";
import { DEFAULT_VERIFY_TIMEOUT_MS, runVerifier } from "../core/verify.ts";
import { annotateRunRecord, formatVerifyLine, readRawRunRecord } from "./trials.ts";

export async function cmdRegrade(rest: string[]): Promise<number> {
  const args = parseArgs({
    args: rest,
    options: {
      verify: { type: "string" },
      verifier: { type: "string" },
      "verify-timeout-ms": { type: "string" },
      json: { type: "boolean", default: false },
    },
    allowPositionals: true,
  });
  const runId = args.positionals[0];
  if (runId === undefined || args.positionals.length !== 1) {
    throw new HarnessError("regrade requires exactly one <run-id>", "USAGE");
  }
  if (args.values.verify !== undefined && args.values.verifier !== undefined) {
    throw new HarnessError("use only one of --verify or --verifier", "USAGE");
  }
  const command = args.values.verify ?? args.values.verifier;
  if (command === undefined || command.trim() === "") {
    throw new HarnessError("regrade requires --verify '<cmd>'", "USAGE");
  }
  const rawTimeout = args.values["verify-timeout-ms"];
  let timeoutMs = DEFAULT_VERIFY_TIMEOUT_MS;
  if (rawTimeout !== undefined) {
    const n = Number(rawTimeout);
    if (!Number.isInteger(n) || n <= 0) {
      throw new HarnessError(`--verify-timeout-ms expects a positive integer, got '${rawTimeout}'`, "USAGE");
    }
    timeoutMs = n;
  }

  const dir = stateDir();
  const rec = readRawRunRecord(dir, runId);
  if (rec === null) throw new HarnessError(`no run record '${runId}' under ${dir}/runs`, "IO");
  if (rec.cwd === undefined || rec.cwd === "") {
    throw new HarnessError(`run '${runId}' records no cwd (external run?) — nothing to regrade against`, "IO");
  }
  if (!fs.existsSync(rec.cwd)) {
    throw new HarnessError(`run '${runId}' workspace ${rec.cwd} no longer exists; cannot regrade`, "IO");
  }

  const verdict = await runVerifier({ command, cwd: rec.cwd, env: process.env, timeoutMs });
  const regrades = [...(Array.isArray(rec.regrades) ? rec.regrades : []), verdict];
  if (!annotateRunRecord(dir, runId, { regrades })) {
    throw new HarnessError(`could not write regrade verdict to run record '${runId}'`, "IO");
  }
  if (args.values.json) {
    process.stdout.write(JSON.stringify(verdict, null, 2) + "\n");
  } else {
    process.stdout.write(`run        ${runId}\n${formatVerifyLine(verdict)}\nregrades   ${regrades.length}\n`);
  }
  return verdict.status === "pass" ? 0 : 1;
}
