// Issue #160: the picker JS that is injected into the Kiro chat webview actually runs here,
// against a tiny DOM whose elements carry the LIVE attributes observed on Kiro 1.2.4 (literal
// copies, not imported from the source), so a drifted selector or a broken expression fails.
import assert from "node:assert/strict";
import vm from "node:vm";
import { describe, it } from "node:test";

import {
  CLOSE_MODEL_PICKER_JS,
  KIRO_IDE_SELECTORS,
  LIST_MODEL_OPTIONS_JS,
  OPEN_MODEL_PICKER_JS,
  READ_MODEL_JS,
  clickModelOptionJs,
} from "../src/adapters/kiro-ide-cdp.ts";

interface El {
  tag: string;
  classes: string[];
  attrs: Record<string, string>;
  text: string;
  children: El[];
  onClick?: () => void;
}

function matches(el: El, selector: string): boolean {
  const m = /^([a-z]*)((?:\.[\w-]+)*)((?:\[[\w-]+(?:=[\w-]+)?\])*)$/.exec(selector);
  if (!m) throw new Error(`mini-DOM does not understand selector ${selector}`);
  if (m[1] && el.tag !== m[1]) return false;
  for (const c of m[2]!.split(".").filter(Boolean)) if (!el.classes.includes(c)) return false;
  for (const a of m[3]!.match(/\[[^\]]+\]/g) ?? []) {
    const [k, v] = a.slice(1, -1).split("=");
    if (!(k! in el.attrs)) return false;
    if (v !== undefined && el.attrs[k!] !== v) return false;
  }
  return true;
}

function wrap(el: El): any {
  return {
    getAttribute: (k: string) => (k in el.attrs ? el.attrs[k]! : null),
    get textContent() {
      return el.text;
    },
    get innerText() {
      return el.text;
    },
    click: () => el.onClick?.(),
    querySelectorAll: (sel: string) => all(el, sel).map(wrap),
  };
}
function all(root: El, sel: string): El[] {
  const out: El[] = [];
  for (const c of root.children) {
    if (matches(c, sel)) out.push(c);
    out.push(...all(c, sel));
  }
  return out;
}

/** The live picker structure: trigger + label always; the popup only while expanded. */
function livePicker(names: Array<{ name: string; disabled?: boolean }>, initial: string) {
  const root: El = { tag: "body", classes: [], attrs: {}, text: "", children: [] };
  const label: El = { tag: "span", classes: ["model-selector-label"], attrs: {}, text: initial, children: [] };
  const trigger: El = {
    tag: "button",
    classes: ["model-selector-trigger"],
    attrs: { "aria-haspopup": "listbox", "aria-expanded": "false" },
    text: "",
    children: [label],
  };
  const popup: El = { tag: "div", classes: ["chat-input-popup-menu"], attrs: { role: "listbox" }, text: "", children: [] };
  const setOpen = (open: boolean) => {
    trigger.attrs["aria-expanded"] = String(open);
    root.children = open ? [trigger, popup] : [trigger];
  };
  popup.children = names.map((n, i) => ({
    tag: "div",
    classes: ["chat-input-popup-option"],
    attrs: { role: "option", ...(n.disabled ? { "aria-disabled": "true" } : {}) },
    // Real option text is multi-line: name, credit multiplier, description.
    text: `  ${n.name}\n${i === 0 ? "" : "1.3x credits"}\nSome description`,
    children: [],
    onClick: () => {
      label.text = n.name;
      setOpen(false);
    },
  }));
  trigger.onClick = () => setOpen(trigger.attrs["aria-expanded"] !== "true");
  setOpen(false);
  const ctx = vm.createContext({ document: { querySelector: (sel: string) => (all(root, sel)[0] ? wrap(all(root, sel)[0]!) : null) } });
  return { run: (js: string): any => JSON.parse(JSON.stringify(vm.runInContext(js, ctx) ?? null)), label, trigger };
}

const NAMES = [{ name: "Auto" }, { name: "Claude Opus 5.5" }, { name: "Claude Sonnet 5.5" }, { name: "Locked", disabled: true }];

describe("kiro-ide picker JS against the live DOM shape", () => {
  it("pins the live selectors", () => {
    assert.equal(KIRO_IDE_SELECTORS.modelTrigger, "button.model-selector-trigger");
    assert.equal(KIRO_IDE_SELECTORS.modelLabel, "span.model-selector-label");
    assert.equal(KIRO_IDE_SELECTORS.modelPopup, ".chat-input-popup-menu[role=listbox]");
    assert.equal(KIRO_IDE_SELECTORS.modelOption, ".chat-input-popup-option[role=option]");
  });

  it("reads the label and the expanded state", () => {
    const d = livePicker(NAMES, "Auto");
    assert.deepEqual(d.run(READ_MODEL_JS), { trigger: true, expanded: false, label: "Auto" });
    d.run(OPEN_MODEL_PICKER_JS);
    assert.equal(d.run(READ_MODEL_JS).expanded, true);
  });

  it("lists only the first line of each option, with the disabled flag; null while closed", () => {
    const d = livePicker(NAMES, "Auto");
    assert.equal(d.run(LIST_MODEL_OPTIONS_JS), null);
    assert.equal(d.run(OPEN_MODEL_PICKER_JS), "ok");
    assert.deepEqual(d.run(LIST_MODEL_OPTIONS_JS), [
      { name: "Auto", disabled: false },
      { name: "Claude Opus 5.5", disabled: false },
      { name: "Claude Sonnet 5.5", disabled: false },
      { name: "Locked", disabled: true },
    ]);
  });

  it("open is idempotent and close toggles it back", () => {
    const d = livePicker(NAMES, "Auto");
    d.run(OPEN_MODEL_PICKER_JS);
    d.run(OPEN_MODEL_PICKER_JS);
    assert.equal(d.run(READ_MODEL_JS).expanded, true, "a second open must not toggle it shut");
    assert.equal(d.run(CLOSE_MODEL_PICKER_JS), "ok");
    assert.equal(d.run(READ_MODEL_JS).expanded, false);
    assert.equal(d.run(CLOSE_MODEL_PICKER_JS), "ok");
    assert.equal(d.run(READ_MODEL_JS).expanded, false);
  });

  it("clicking an option really clicks it: the label changes and the popup closes", () => {
    const d = livePicker(NAMES, "Auto");
    d.run(OPEN_MODEL_PICKER_JS);
    assert.equal(d.run(clickModelOptionJs(2)), "clicked");
    assert.deepEqual(d.run(READ_MODEL_JS), { trigger: true, expanded: false, label: "Claude Sonnet 5.5" });
  });

  it("refuses a disabled option, a missing index and a closed popup", () => {
    const d = livePicker(NAMES, "Auto");
    assert.equal(d.run(clickModelOptionJs(0)), "none", "popup closed");
    d.run(OPEN_MODEL_PICKER_JS);
    assert.equal(d.run(clickModelOptionJs(3)), "none", "aria-disabled");
    assert.equal(d.run(clickModelOptionJs(9)), "none", "no such option");
    assert.equal(d.run(READ_MODEL_JS).label, "Auto");
  });

  it("with no trigger every expression degrades instead of throwing", () => {
    const ctx = vm.createContext({ document: { querySelector: () => null } });
    const run = (js: string): any => JSON.parse(JSON.stringify(vm.runInContext(js, ctx) ?? null));
    assert.deepEqual(run(READ_MODEL_JS), { trigger: false, expanded: false, label: null });
    assert.equal(run(OPEN_MODEL_PICKER_JS), "none");
    assert.equal(run(CLOSE_MODEL_PICKER_JS), "none");
    assert.equal(run(LIST_MODEL_OPTIONS_JS), null);
    assert.equal(run(clickModelOptionJs(0)), "none");
  });
});
