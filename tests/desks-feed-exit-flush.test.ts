import "./support/no-network.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { startFeed } from "../src/desks/feeds.ts";

const FAKE = fileURLToPath(new URL("./fixtures/desks/fake-feed.mjs", import.meta.url));
const ev = (type: string, extra: Record<string, unknown> = {}) => ({ line: { type, ...extra } });

test("events batched when the feed child exits are flushed, not dropped", async () => {
  const msgs: string[] = [];
  const steps = [ev("utterance", { text: "bk" }), ev("alive"), { delay: 100 }, ev("utterance", { text: "pending-at-exit" }), { exit: 0 }];
  const handle = startFeed(
    {
      command: [process.execPath, FAKE, JSON.stringify(steps)],
      activeCheck: [process.execPath, "-e", "console.log(JSON.stringify({active:true}))"],
      batchSeconds: 30, // the batch window never elapses before the exit
    },
    async (t) => { msgs.push(t); },
    { onNote: () => {}, onError: () => {}, restartBaseMs: 60_000 },
  );
  try {
    const t0 = Date.now();
    while (!msgs.some((m) => m.includes("pending-at-exit"))) {
      if (Date.now() - t0 > 8000) throw new Error(`batched text never delivered; msgs=${JSON.stringify(msgs)}`);
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.ok(msgs.some((m) => m === "New events (1):\n- utterance: pending-at-exit"));
  } finally { await handle.stop(); }
});
