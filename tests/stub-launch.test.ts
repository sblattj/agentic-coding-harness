// #39: launch a STUB agent binary (no real CLI, no auth, no network) through
// the harness's real launch path — driver → adapter → runJsonlCli →
// defaultSpawnFn → src/core/platform.ts spawnTarget → the OS — on every CI
// OS. The stub is installed the way npm installs an agent CLI:
//   - POSIX: an executable `fake-agent` script on PATH;
//   - Windows: a `fake-agent.cmd` cmd-shim that forwards `%*` to node, found
//     through PATH + PATHEXT and launched via cmd.exe with escaped arguments.
// The prompt carries every cmd.exe metacharacter plus quotes, so a quoting
// bug on Windows shows up as an argv mismatch (or a split command), not as a
// silent pass.
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { createCustomAdapter } from "../src/adapters/custom.ts";
import { createDriver } from "../src/core/driver.ts";
import { resolveCommand } from "../src/core/platform.ts";

const NODE = process.execPath;
const IS_WIN = process.platform === "win32";

const ECHO_AGENT = `
process.stdout.write(JSON.stringify({ type: 'result', argv: process.argv.slice(2), model: 'stub-1', usage: { in: 3, out: 2 } }) + '\\n');
`;

let root: string;
let bin: string;
let savedPath: string | undefined;

before(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "ach-stub-launch-"));
  bin = path.join(root, "bin");
  writeFileSync(path.join(root, "echo-agent.mjs"), ECHO_AGENT);
  mkdirSync(bin, { recursive: true });
  if (IS_WIN) {
    // Same shape as npm's cmd-shim: forward every argument with %*.
    writeFileSync(path.join(bin, "fake-agent.cmd"), `@"${NODE}" "${path.join(root, "echo-agent.mjs")}" %*\r\n`);
  } else {
    const p = path.join(bin, "fake-agent");
    writeFileSync(p, `#!/bin/sh\nexec '${NODE}' '${path.join(root, "echo-agent.mjs")}' "$@"\n`);
    chmodSync(p, 0o755);
  }
  savedPath = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${savedPath ?? ""}`;
});

after(() => {
  process.env.PATH = savedPath;
  rmSync(root, { recursive: true, force: true });
});

function echoedArgv(events: Array<Record<string, unknown>>): unknown {
  for (const e of events) {
    if (e.type !== "message" || typeof e.content !== "string") continue;
    try {
      const obj = JSON.parse(e.content) as { type?: string; argv?: unknown };
      if (obj.type === "result") return obj.argv;
    } catch {
      /* not the echo line */
    }
  }
  throw new Error(`no echo line among events: ${JSON.stringify(events)}`);
}

describe("stub agent launch through the real spawn path (#39)", () => {
  it("resolves the bare stub name on PATH (PATHEXT → .cmd on Windows)", () => {
    const resolved = resolveCommand("fake-agent");
    assert.equal(resolved, path.join(bin, IS_WIN ? "fake-agent.cmd" : "fake-agent"));
  });

  for (const prompt of [
    "plain words",
    `it's "quoted" & a | b > c < d ^ 100% (x) !bang; semi, comma *? \`tick\``,
    "trailing backslash \\",
    'embedded \\"escaped\\" quote',
  ]) {
    it(`delivers the prompt as ONE argv element: ${JSON.stringify(prompt).slice(0, 40)}`, async () => {
      const stateDir = mkdtempSync(path.join(root, "state-"));
      const adapter = createCustomAdapter({ name: "custom", template: "fake-agent --flag {prompt}" });
      const driver = createDriver({ adapters: { custom: adapter }, stateDir });
      const res = await driver.run("custom", { prompt, cwd: root });
      assert.equal(res.exitStatus, "success", JSON.stringify(res.events));
      assert.deepEqual(echoedArgv(res.events as Array<Record<string, unknown>>), ["--flag", prompt]);
    });
  }
});
