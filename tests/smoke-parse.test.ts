// #139: parseMessage / parseFenceInfo.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseFenceInfo, parseMessage } from "../src/core/smoke/parse.ts";

describe("parseFenceInfo", () => {
  it("splits lang and attrs, with quoted values", () => {
    assert.deepEqual(parseFenceInfo('sh account=me@x.com timeout=120 agent=claude'), {
      lang: "sh",
      attrs: { account: "me@x.com", timeout: "120", agent: "claude" },
    });
    assert.deepEqual(parseFenceInfo('bash note="two words" x=1'), {
      lang: "bash",
      attrs: { note: "two words", x: "1" },
    });
    assert.deepEqual(parseFenceInfo(""), { lang: "", attrs: {} });
  });
});

describe("parseMessage", () => {
  it("parses shell fences, skipping blanks and comments, with section/line/index", () => {
    const md = ["# Setup", "", "## Install", "```bash", "# comment", "npm i -g foo", "", "foo --version", "```"].join("\n");
    const steps = parseMessage(md);
    assert.equal(steps.length, 2);
    assert.deepEqual(steps.map((s) => [s.index, s.kind, s.text, s.line, s.section]), [
      [1, "shell", "npm i -g foo", 6, "Install"],
      [2, "shell", "foo --version", 8, "Install"],
    ]);
  });

  it("joins backslash continuations and keeps text verbatim", () => {
    const md = "```sh\nfoo \\\n  --bar \\\n  --baz\nnext\n```";
    const steps = parseMessage(md);
    assert.equal(steps.length, 2);
    assert.equal(steps[0]!.text, "foo \\\n  --bar \\\n  --baz");
    assert.equal(steps[0]!.line, 2);
    assert.equal(steps[1]!.text, "next");
    assert.equal(steps[1]!.line, 5);
  });

  it("swallows heredocs through the terminator", () => {
    for (const intro of ["<<EOF", "<<'EOF'", "<<-EOF"]) {
      const md = `\`\`\`bash\ncat > f ${intro}\nline # not a comment\n\nEOF\necho done\n\`\`\``;
      const steps = parseMessage(md);
      assert.equal(steps.length, 2, intro);
      assert.equal(steps[0]!.text, `cat > f ${intro}\nline # not a comment\n\nEOF`);
      assert.equal(steps[1]!.text, "echo done");
    }
  });

  it("console fences: only prompt lines are commands", () => {
    const md = "```console\n$ ls\nfile1\nfile2\n% echo hi\nhi\n```";
    assert.deepEqual(parseMessage(md).map((s) => s.text), ["ls", "echo hi"]);
    const t = parseMessage("```terminal\nnot a command\n$ pwd\n```");
    assert.deepEqual(t.map((s) => s.text), ["pwd"]);
  });

  it("strips a leading $ in sh fences", () => {
    assert.deepEqual(parseMessage("```zsh\n$ whoami\n```").map((s) => s.text), ["whoami"]);
  });

  it("prompt/agent fences are one step; open fences one per line", () => {
    const md = "```prompt\nDo the thing.\n\nThen another.\n```\n\n```agent\nhello\n```\n\n```open\nhttps://a.example\n\nhttps://b.example\n```";
    const s = parseMessage(md);
    assert.deepEqual(s.map((x) => [x.kind, x.text, x.line]), [
      ["prompt", "Do the thing.\n\nThen another.", 2],
      ["prompt", "hello", 8],
      ["open", "https://a.example", 12],
      ["open", "https://b.example", 14],
    ]);
  });

  it("parses attrs from the info string", () => {
    const s = parseMessage('```sh account=me@x.com timeout=120 agent="claude code"\nfoo\n```');
    assert.deepEqual(s[0]!.attrs, { account: "me@x.com", timeout: "120", agent: "claude code" });
  });

  it("handles ~~~ fences", () => {
    assert.deepEqual(parseMessage("~~~sh\nls\n~~~").map((s) => s.text), ["ls"]);
  });

  it("recognizes steps outside fences", () => {
    const md = [
      "## Go",
      "$ npm test",
      "`ach doctor --json`",
      "Open https://example.com/login.",
      "Go to http://x.test/a?b=1 now",
      "Visit https://one.example and https://two.example",
      "See https://not-a-step.example",
      "Some `inline` text",
    ].join("\n");
    const s = parseMessage(md);
    assert.deepEqual(s.map((x) => [x.kind, x.text, x.line, x.section]), [
      ["shell", "npm test", 2, "Go"],
      ["shell", "ach doctor --json", 3, "Go"],
      ["open", "https://example.com/login", 4, "Go"],
      ["open", "http://x.test/a?b=1", 5, "Go"],
    ]);
  });

  it("ignores fences with other info and does not read headings inside fences", () => {
    const md = "# Real\n```json\n{\"a\": 1}\n```\n```\nplain\n```\n```yaml\nk: v\n```\n```text\n$ nope\n```\n```sh\n# Fake heading\nls\n```\n";
    const s = parseMessage(md);
    assert.equal(s.length, 1);
    assert.equal(s[0]!.text, "ls");
    assert.equal(s[0]!.section, "Real");
  });

  it("section is undefined before any heading", () => {
    assert.equal(parseMessage("```sh\nls\n```")[0]!.section, undefined);
  });
});
