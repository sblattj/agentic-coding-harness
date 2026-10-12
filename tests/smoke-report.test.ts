// #139: friction table, edits, markdown->html, rich-text clipboard.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  applyEdits,
  copyRichText,
  markdownToHtml,
  renderFrictionDetails,
  renderFrictionTable,
} from "../src/core/smoke/report.ts";
import { HarnessError } from "../src/core/types.ts";
import type { SmokeReport, StepRecord } from "../src/core/smoke/types.ts";

function rec(index: number, text: string, over: Partial<StepRecord> = {}): StepRecord {
  return {
    step: { index, kind: "shell", text, line: index, attrs: {} },
    status: "pass",
    exitCode: 0,
    durationMs: 1200,
    tokens: null,
    prompts: [],
    denials: [],
    friction: [],
    outputTail: "",
    attempt: 1,
    ...over,
  };
}

function report(): SmokeReport {
  return {
    messageFile: "m.md",
    sandboxRoot: "/tmp/sb",
    startedAt: "2026-10-12T00:00:00Z",
    durationMs: 9000,
    steps: [
      rec(1, "echo a | cat\nsecond line"),
      rec(2, "ach login --long-flag-" + "x".repeat(60), {
        status: "fixed",
        durationMs: 3400,
        tokens: 1500,
        prompts: ["Password:"],
        denials: ["EACCES", "policy"],
        friction: [
          { kind: "wrong-flag", detail: "no such flag", evidence: "error: unknown option\nusage: ..." },
          { kind: "interactive-prompt", detail: "asked for a password" },
        ],
      }),
      rec(3, "skipme", { status: "skipped", durationMs: 0 }),
    ],
    fixes: [
      { stepIndex: 2, target: "instructions", summary: "use --short", where: "message:L2", rerunPassed: true },
    ],
    revisedMessage: "",
    hostKeychainUnchanged: true,
    reapedPids: [11, 12],
    stubbedRequests: [{ stub: "s", method: "POST", path: "/x", body: "", at: "t" }],
  };
}

describe("renderFrictionTable", () => {
  it("text: header, rule, cells, footer", () => {
    const out = renderFrictionTable(report());
    const lines = out.split("\n");
    assert.match(lines[0]!, /^#\s+step\s+status\s+time\s+tokens\s+prompts\/denials\s+friction\s+fix$/);
    assert.match(lines[1]!, /^-+(  -+)+$/);
    assert.match(lines[2]!, /^1\s+echo a \| cat\s+pass\s+1\.2s\s+-\s+0/);
    assert.ok(!lines[2]!.includes("second line"));
    assert.match(lines[3]!, /^2\s+ach login --long-flag-x+…\s+fixed\s+3\.4s\s+1500\s+3\s+wrong-flag, interactive-prompt\s+instructions: use --short \(message:L2\)$/);
    const step2 = lines[3]!.split(/\s{2,}/)[1]!;
    assert.equal([...step2].length, 48);
    assert.ok(out.includes("steps: 3 (pass 1, fail 0, fixed 1, skipped 1)"));
    assert.ok(out.includes("total time: 4.6s, total tokens: 1500"));
    assert.ok(out.includes("host keychain unchanged: yes"));
    assert.ok(out.includes("reaped pids: 2"));
    assert.ok(out.includes("stubbed requests: 1"));
  });

  it("markdown: GFM table with escaped pipes", () => {
    const out = renderFrictionTable(report(), { format: "markdown" });
    const lines = out.split("\n");
    assert.equal(lines[0], "| # | step | status | time | tokens | prompts/denials | friction | fix |");
    assert.equal(lines[1], "| --- | --- | --- | --- | --- | --- | --- | --- |");
    assert.equal(lines[2], "| 1 | echo a \\| cat | pass | 1.2s | - | 0 |  |  |");
    assert.ok(lines[3]!.includes("| fixed | 3.4s | 1500 | 3 | wrong-flag, interactive-prompt | instructions: use --short (message:L2) |"));
    assert.ok(out.includes("- host keychain unchanged: yes"));
  });

  it("hostKeychainUnchanged null renders n/a, false renders no", () => {
    const r = report();
    r.hostKeychainUnchanged = null;
    assert.ok(renderFrictionTable(r).includes("host keychain unchanged: n/a"));
    r.hostKeychainUnchanged = false;
    assert.ok(renderFrictionTable(r).includes("host keychain unchanged: no"));
  });
});

describe("renderFrictionDetails", () => {
  it("lists step, kind, detail, indented evidence, and fixes", () => {
    const out = renderFrictionDetails(report());
    assert.ok(out.includes("step 2 [wrong-flag] no such flag"));
    assert.ok(out.includes("    error: unknown option\n    usage: ..."));
    assert.ok(out.includes("step 2 [interactive-prompt] asked for a password"));
    assert.ok(out.includes("fix (instructions) at message:L2: use --short; rerunPassed: pass"));
  });
});

describe("applyEdits", () => {
  const msg = "a\nb\nc\nd";
  it("replace with original check", () => {
    assert.equal(applyEdits(msg, [{ line: 2, op: "replace", original: "b", text: "B", reason: "r" }]), "a\nB\nc\nd");
  });
  it("replaces a multi-line original exactly", () => {
    assert.equal(
      applyEdits(msg, [{ line: 2, op: "replace", original: "b\nc", text: "X", reason: "r" }]),
      "a\nX\nd",
    );
  });
  it("insert-before and insert-after", () => {
    assert.equal(
      applyEdits(msg, [
        { line: 1, op: "insert-before", text: "top", reason: "r" },
        { line: 4, op: "insert-after", text: "end", reason: "r" },
      ]),
      "top\na\nb\nc\nd\nend",
    );
  });
  it("mismatch throws SMOKE_EDIT_MISMATCH", () => {
    assert.throws(
      () => applyEdits(msg, [{ line: 2, op: "replace", original: "zzz", text: "B", reason: "r" }]),
      (e: unknown) => e instanceof HarnessError && e.code === "SMOKE_EDIT_MISMATCH",
    );
    assert.throws(
      () => applyEdits(msg, [{ line: 9, op: "insert-after", text: "x", reason: "r" }]),
      (e: unknown) => e instanceof HarnessError && e.code === "SMOKE_EDIT_MISMATCH",
    );
  });
  it("multi-edit uses ORIGINAL line numbers regardless of input order", () => {
    const edits = [
      { line: 1, op: "insert-after" as const, text: "a2\na3", reason: "r" },
      { line: 3, op: "replace" as const, original: "c", text: "C", reason: "r" },
      { line: 2, op: "insert-before" as const, text: "pre-b", reason: "r" },
      { line: 4, op: "insert-after" as const, text: "z", reason: "r" },
    ];
    const expected = "a\na2\na3\npre-b\nb\nC\nd\nz";
    assert.equal(applyEdits(msg, edits), expected);
    assert.equal(applyEdits(msg, [...edits].reverse()), expected);
  });
  it("same-line inserts keep input order; insert-after a replaced span lands after it", () => {
    assert.equal(
      applyEdits(msg, [
        { line: 2, op: "insert-before", text: "p1", reason: "r" },
        { line: 2, op: "insert-before", text: "p2", reason: "r" },
        { line: 2, op: "replace", original: "b\nc", text: "X", reason: "r" },
        { line: 2, op: "insert-after", text: "q", reason: "r" },
      ]),
      "a\np1\np2\nX\nq\nd",
    );
  });
});

describe("markdownToHtml", () => {
  it("escapes html and renders blocks", () => {
    const html = markdownToHtml("# Title\n\nHello <script>alert(1)</script> **bold** *it* `c<d` [x](https://e.com/a?b=1&c=2)\n\n- one\n- two\n\n1. first\n2. second\n\n```sh\necho \"<hi>\" && ls\n```");
    assert.ok(!html.includes("<script>"));
    assert.ok(html.includes("&lt;script&gt;"));
    assert.ok(html.includes("<h1>Title</h1>"));
    assert.ok(html.includes("<strong>bold</strong>"));
    assert.ok(html.includes("<em>it</em>"));
    assert.ok(html.includes("<code>c&lt;d</code>"));
    assert.ok(html.includes('<a href="https://e.com/a?b=1&amp;c=2">x</a>'));
    assert.ok(html.includes("<ul><li>one</li><li>two</li></ul>"));
    assert.ok(html.includes("<ol><li>first</li><li>second</li></ol>"));
    assert.ok(html.includes("<pre><code>echo &quot;&lt;hi&gt;&quot; &amp;&amp; ls</code></pre>"));
  });
  it("refuses javascript: links", () => {
    assert.ok(!markdownToHtml("[x](javascript:alert(1))").includes("<a "));
  });
});

describe("copyRichText", () => {
  it("darwin: textutil then pbcopy -Prefer rtf", () => {
    const calls: Array<{ cmd: string; args: string[]; input: string }> = [];
    const r = copyRichText("<p>hi</p>", "hi", {
      platform: "darwin",
      run: (cmd, args, input) => {
        calls.push({ cmd, args, input });
        return { status: 0, stderr: "", stdout: cmd.endsWith("textutil") ? "{\\rtf1 hi}" : "" };
      },
    });
    assert.equal(r.copied, true);
    assert.deepEqual(calls, [
      { cmd: "/usr/bin/textutil", args: ["-convert", "rtf", "-format", "html", "-stdin", "-stdout"], input: "<p>hi</p>" },
      { cmd: "/usr/bin/pbcopy", args: ["-Prefer", "rtf"], input: "{\\rtf1 hi}" },
    ]);
  });
  it("returns copied:false when a tool exits 1, and does not throw", () => {
    const r = copyRichText("<p>x</p>", "x", { platform: "darwin", run: () => ({ status: 1, stderr: "boom" }) });
    assert.equal(r.copied, false);
    const t = copyRichText("<p>x</p>", "x", {
      platform: "darwin",
      run: () => {
        throw new Error("spawn");
      },
    });
    assert.equal(t.copied, false);
  });
  it("linux: xclip, then wl-copy, else no clipboard tool", () => {
    const seen: string[] = [];
    const a = copyRichText("h", "p", {
      platform: "linux",
      run: (cmd) => {
        seen.push(cmd);
        return { status: cmd === "wl-copy" ? 0 : null, stderr: "" };
      },
    });
    assert.deepEqual(seen, ["xclip", "wl-copy"]);
    assert.deepEqual(a, { copied: true, how: "wl-copy" });
    const b = copyRichText("h", "p", { platform: "linux", run: () => ({ status: null, stderr: "" }) });
    assert.deepEqual(b, { copied: false, how: "no clipboard tool" });
  });
});
