// Kiro IDE 1.4.154 replaced the Autopilot switch (#autopilot-toggle) with a "Permission mode" combobox
// (Supervised / Accept file changes / Approve for me). The state JS that is injected into the chat webview runs
// here against the live markup in tests/fixtures/kiro-ide/permission-mode-1.4.154.html (the label is read from
// the fixture, not typed into the test), and against the old switch, so a drifted selector fails. The turn
// parser runs against a multi-turn pane in the live 1.4.154 shape (contents replaced).
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { describe, it } from "node:test";

import { AUTOPILOT_STATE_JS, KIRO_IDE_SELECTORS, READ_PERMISSION_MODE_JS } from "../src/adapters/kiro-ide-cdp.ts";
import { parseKiroIdeTurn } from "../src/adapters/kiro-ide.ts";

const FIXTURE = fs.readFileSync(path.join(import.meta.dirname, "fixtures", "kiro-ide", "permission-mode-1.4.154.html"), "utf8");

/** The closed trigger's label and attributes, parsed from the captured markup. */
function liveTrigger(): { cls: string; labelCls: string; label: string } {
  const m = /<button type="button" class="([\w-]+)" aria-label="Permission mode"[^>]*><span class="([\w-]+)">([^<]+)<\/span>/.exec(FIXTURE);
  assert.ok(m, "fixture holds the permission mode trigger");
  return { cls: m[1]!, labelCls: m[2]!, label: m[3]! };
}
const liveOptions = (): string[] => [...FIXTURE.matchAll(/<span class="kiro-pm-text"><span>([^<]+)<\/span>/g)].map((x) => x[1]!);

/** A document holding either the 1.4.154 trigger (label text) or the old switch (checked), or neither. */
function doc(opts: { label?: string; toggle?: boolean }) {
  const t = liveTrigger();
  const label = opts.label === undefined ? null : { textContent: `  ${opts.label} ` };
  const trigger = opts.label === undefined ? null : { getAttribute: (k: string) => (k === "aria-label" ? "Permission mode" : null) };
  const document = {
    getElementById: (id: string) => (id === "autopilot-toggle" && opts.toggle !== undefined ? { checked: opts.toggle } : null),
    querySelector: (sel: string) => {
      if (sel === `button.${t.cls}`) return trigger;
      if (sel === `span.${t.labelCls}` || sel === `button.${t.cls} span.${t.labelCls}`) return label;
      return null;
    },
  };
  const ctx = vm.createContext({ document });
  return (js: string): unknown => vm.runInContext(js, ctx);
}

describe("kiro-ide Autopilot state on 1.4.154 (permission mode) and before (switch)", () => {
  it("pins the live 1.4.154 selectors from the fixture", () => {
    const t = liveTrigger();
    assert.equal(KIRO_IDE_SELECTORS.permissionModeTrigger, `button.${t.cls}`);
    assert.equal(KIRO_IDE_SELECTORS.permissionModeLabel, `span.${t.labelCls}`);
    assert.deepEqual(liveOptions(), ["Supervised", "Accept file changes", "Approve for me"]);
  });

  it("reads every 1.4.154 mode: Supervised is off, the two unattended modes are on", () => {
    const [supervised, acceptFiles, approve] = liveOptions();
    assert.equal(doc({ label: supervised })(AUTOPILOT_STATE_JS), "off");
    assert.equal(doc({ label: acceptFiles })(AUTOPILOT_STATE_JS), "on");
    assert.equal(doc({ label: approve })(AUTOPILOT_STATE_JS), "on");
    assert.equal(doc({ label: liveTrigger().label })(AUTOPILOT_STATE_JS), "on", "the captured window was on Approve for me");
    assert.equal(doc({ label: approve })(READ_PERMISSION_MODE_JS), "Approve for me");
  });

  it("still reads the pre-1.4.154 Autopilot switch, and says unknown with neither", () => {
    assert.equal(doc({ toggle: true })(AUTOPILOT_STATE_JS), "on");
    assert.equal(doc({ toggle: false })(AUTOPILOT_STATE_JS), "off");
    assert.equal(doc({})(AUTOPILOT_STATE_JS), "unknown");
    assert.equal(doc({ label: "" })(AUTOPILOT_STATE_JS), "unknown");
    assert.equal(doc({})(READ_PERMISSION_MODE_JS), null);
  });

  it("keeps the old switch id in the expression (the adapter fakes key on it)", () => {
    assert.match(AUTOPILOT_STATE_JS, /autopilot-toggle/);
  });
});

describe("parseKiroIdeTurn on a pane that holds earlier turns (--kiro-ide-no-new-session)", () => {
  const PANE = fs.readFileSync(path.join(import.meta.dirname, "fixtures", "kiro-ide", "multi-turn-pane-1.4.154.txt"), "utf8");
  it("reads this turn's reply, credits and elapsed time, not the first turn's", () => {
    const t = parseKiroIdeTurn(PANE, "Reply with one word: ready");
    assert.equal(t.reply, "ready");
    assert.equal(t.credits, 0);
    assert.equal(t.elapsedSeconds, 2);
    assert.equal(t.complete, true);
  });
  it("a middle turn still ends at its own footer", () => {
    const t = parseKiroIdeTurn(PANE, "Without reading any file again: which file did you just read, and what version did it say? One line.");
    assert.match(t.reply, /version as 1\.2\.3/);
    assert.doesNotMatch(t.reply, /Est\. Credits/);
    assert.equal(t.credits, 0.02);
    assert.equal(t.elapsedSeconds, 1);
  });
});
