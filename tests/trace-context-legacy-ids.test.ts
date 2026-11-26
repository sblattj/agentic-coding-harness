// #73: a run (or RunResult file) WITHOUT a `trace` field exports exactly what
// it did before trace-context propagation landed. The golden was rendered from
// the pre-#73 src/emitters/otel.ts + langfuse.ts with the same stubbed id
// sources (tests/support/legacy-export-ids.ts). Own file on purpose: the
// langfuse slice-id counter is module state, so this needs a fresh process.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { renderLegacy, stubIdSources } from "./support/legacy-export-ids.ts";

describe("legacy export ids (#73)", () => {
  it("toOtlpJson / toLangfuseOtlpJson without trace ids are byte-for-byte the pre-#73 output", async () => {
    const golden = readFileSync(new URL("./fixtures/trace-context/legacy-export-golden.json", import.meta.url), "utf8");
    const restore = stubIdSources();
    try {
      const otel = await import("../src/emitters/otel.ts");
      const lf = await import("../src/emitters/langfuse.ts");
      assert.equal(renderLegacy(otel.toOtlpJson as never, lf.toLangfuseOtlpJson as never), golden);
    } finally {
      restore();
    }
  });
});
