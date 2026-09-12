import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { describeListenError } from "../src/cli/serve.ts";

// describeListenError — pure classifier for a Bun.serve listen failure,
// unit-tested without binding a real socket. The EADDRINUSE shape below was
// captured from a live two-process control run of `harness serve` on this
// host: `code: "EADDRINUSE"`, message
// "Failed to start server. Is port <N> in use?".
describe("describeListenError", () => {
  test("recognizes a Bun.serve address-in-use error (observed shape)", () => {
    const err = Object.assign(new Error("Failed to start server. Is port 8397 in use?"), {
      code: "EADDRINUSE",
      syscall: "listen",
      errno: 0,
    });
    const msg = describeListenError(err, "127.0.0.1", 8397);
    assert.equal(
      msg,
      "serve: port 8397 on 127.0.0.1 is already in use (another harness serve or harness web?); pass --port to choose another",
    );
  });

  test("recognizes address-in-use by message text alone when code is absent", () => {
    const err = new Error("Failed to start server. Is port 8398 in use?");
    const msg = describeListenError(err, "0.0.0.0", 8398);
    assert.match(msg ?? "", /port 8398 on 0\.0\.0\.0 is already in use/);
  });

  test("returns null for an unrelated error (control)", () => {
    const err = new Error("EPERM: operation not permitted");
    assert.equal(describeListenError(err, "127.0.0.1", 8398), null);
  });

  test("returns null for a non-Error thrown value", () => {
    assert.equal(describeListenError("boom", "127.0.0.1", 8398), null);
  });
});
