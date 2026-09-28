// #39: the cross-platform process helpers in src/core/platform.ts, pinned under
// win32-shaped inputs (path.win32 paths, `Path`/PATHEXT env, a fake file
// probe) so the Windows branches are exercised on every CI host, and under
// POSIX inputs to prove the pre-#39 behavior is unchanged.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  escapeCmdArgument,
  getEnvVar,
  resolveCommand,
  shellCommand,
  spawnTarget,
} from "../src/core/platform.ts";

const winFiles = (files: string[]) => {
  const set = new Set(files.map((f) => f.toLowerCase()));
  return (p: string) => set.has(p.toLowerCase());
};

describe("platform: win32 command resolution", () => {
  const env = {
    Path: "C:\\Windows\\system32;\"C:\\Program Files\\nodejs\";C:\\Users\\me\\AppData\\Roaming\\npm",
    PATHEXT: ".COM;.EXE;.BAT;.CMD",
    ComSpec: "C:\\Windows\\system32\\cmd.exe",
  };
  const isFile = winFiles([
    "C:\\Program Files\\nodejs\\node.exe",
    "C:\\Users\\me\\AppData\\Roaming\\npm\\codex.cmd",
    "C:\\Users\\me\\AppData\\Roaming\\npm\\codex",
    "D:\\tools\\agent.exe",
  ]);

  it("reads Path case-insensitively and searches PATHEXT (not the extensionless sh shim)", () => {
    assert.equal(getEnvVar("PATH", env, "win32"), env.Path);
    assert.equal(getEnvVar("PATH", env, "linux"), undefined);
    assert.equal(
      resolveCommand("codex", { platform: "win32", env, isFile }),
      "C:\\Users\\me\\AppData\\Roaming\\npm\\codex.cmd",
    );
    assert.equal(resolveCommand("node", { platform: "win32", env, isFile }), "C:\\Program Files\\nodejs\\node.exe");
    assert.equal(resolveCommand("node.exe", { platform: "win32", env, isFile }), "C:\\Program Files\\nodejs\\node.exe");
    assert.equal(resolveCommand("missing", { platform: "win32", env, isFile }), undefined);
  });

  it("checks drive-letter and forward-slash paths as paths, adding PATHEXT", () => {
    assert.equal(resolveCommand("D:\\tools\\agent", { platform: "win32", env, isFile }), "D:\\tools\\agent.exe");
    assert.equal(resolveCommand("D:/tools/agent.exe", { platform: "win32", env, isFile }), "D:\\tools\\agent.exe");
    assert.equal(resolveCommand("D:\\tools\\nope", { platform: "win32", env, isFile }), undefined);
  });

  it("spawns an .exe directly by its resolved path", () => {
    assert.deepEqual(spawnTarget("node", ["-v"], { platform: "win32", env, isFile }), {
      command: "C:\\Program Files\\nodejs\\node.exe",
      args: ["-v"],
    });
  });

  it("wraps a .cmd shim in cmd.exe with every argument escaped", () => {
    const t = spawnTarget("codex", ["exec", "fix a & b | c \"quoted\" 100%"], { platform: "win32", env, isFile });
    assert.equal(t.command, "C:\\Windows\\system32\\cmd.exe");
    assert.equal(t.windowsVerbatimArguments, true);
    assert.deepEqual(t.args.slice(0, 3), ["/d", "/s", "/c"]);
    const line = t.args[3]!;
    assert.ok(line.startsWith('"C:\\Users\\me\\AppData\\Roaming\\npm\\codex.cmd ^^^"exec^^^"'), line);
    // no raw cmd.exe metacharacter survives unescaped inside the argument
    assert.ok(!/[^^][&|%<>]/.test(line.slice(1, -1).replace(/\^./g, "")), line);
  });

  it("an unresolvable name passes through untouched (spawn reports ENOENT)", () => {
    assert.deepEqual(spawnTarget("nope", ["a"], { platform: "win32", env, isFile }), { command: "nope", args: ["a"] });
  });

  it("an explicit cmd.exe /d /s /c invocation stays verbatim", () => {
    const sh = shellCommand("echo hi && exit 3", { platform: "win32", env });
    assert.deepEqual(sh, {
      command: "C:\\Windows\\system32\\cmd.exe",
      args: ["/d", "/s", "/c", '"echo hi && exit 3"'],
      windowsVerbatimArguments: true,
    });
    assert.deepEqual(spawnTarget(sh.command, sh.args, { platform: "win32", env, isFile }), sh);
  });

  it("escapeCmdArgument quotes for argv and ^-escapes cmd metacharacters", () => {
    assert.equal(escapeCmdArgument("plain"), '^"plain^"');
    assert.equal(escapeCmdArgument('a"b'), '^"a\\^"b^"');
    assert.equal(escapeCmdArgument("a\\"), '^"a\\\\^"');
    assert.equal(escapeCmdArgument("x&y", true), '^^^"x^^^&y^^^"');
  });
});

describe("platform: POSIX behavior unchanged", () => {
  it("shellCommand is /bin/sh -c", () => {
    assert.deepEqual(shellCommand("echo hi", { platform: "linux" }), { command: "/bin/sh", args: ["-c", "echo hi"] });
    assert.deepEqual(shellCommand("echo hi", { platform: "darwin" }), { command: "/bin/sh", args: ["-c", "echo hi"] });
  });

  it("spawnTarget passes the command through untouched", () => {
    assert.deepEqual(spawnTarget("claude", ["-p", "x & y"], { platform: "linux", env: { PATH: "/usr/bin" } }), {
      command: "claude",
      args: ["-p", "x & y"],
    });
  });

  it("resolveCommand searches PATH on ':' with a posix join", () => {
    const isFile = (p: string) => p === "/opt/bin/agent";
    assert.equal(resolveCommand("agent", { platform: "linux", env: { PATH: "/usr/bin:/opt/bin" }, isFile }), "/opt/bin/agent");
    assert.equal(resolveCommand("agent", { platform: "linux", env: { Path: "/opt/bin" }, isFile }), undefined);
  });

  it("resolves a real executable on this host", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ach-platform-"));
    try {
      const name = process.platform === "win32" ? "stub.cmd" : "stub";
      fs.writeFileSync(path.join(dir, name), process.platform === "win32" ? "@echo off\r\n" : "#!/bin/sh\n", { mode: 0o755 });
      const env = { ...process.env, PATH: dir };
      assert.equal(resolveCommand("stub", { env }), path.join(dir, name));
      if (process.platform !== "win32") {
        fs.chmodSync(path.join(dir, name), 0o644);
        assert.equal(resolveCommand("stub", { env }), undefined, "non-executable file is not a command on POSIX");
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
