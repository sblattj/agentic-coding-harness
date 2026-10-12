// `ach smoke <message-file>` (agentic-coding-harness#139): argument parsing
// and output for src/core/smoke/index.ts runSmoke. See docs/SMOKE.md.
//
// Every usage error exits 2 (HarnessError exitCode 2), parseArgs errors
// included, so a script can tell "bad invocation" from "the message has
// friction" (exit 1).
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

import { HarnessError } from "../core/types.ts";
import { runSmoke } from "../core/smoke/index.ts";
import { copyRichText, markdownToHtml, renderFrictionDetails, renderFrictionTable } from "../core/smoke/report.ts";
import { parseStubFlag } from "../core/smoke/stubs.ts";

function usage(msg: string): HarnessError {
  return new HarnessError(`smoke: ${msg} (see ach smoke --help)`, "USAGE", 2);
}

/** <out>/<name>.smoked.md; never the input file itself. */
export function revisedPath(messageFile: string, outDir: string | undefined, cwd = process.cwd()): string {
  const base = path.basename(messageFile).replace(/\.(md|markdown|txt)$/i, "");
  const p = path.resolve(outDir ?? cwd, `${base}.smoked.md`);
  if (p === path.resolve(messageFile)) throw usage(`--out would overwrite the input file ${messageFile}`);
  return p;
}

export async function cmdSmoke(rest: string[]): Promise<number> {
  let args;
  try {
    args = parseArgs({
      args: rest,
      options: {
        account: { type: "string" },
        agent: { type: "string" },
        cdp: { type: "string" },
        "no-browser": { type: "boolean", default: false },
        stub: { type: "string", multiple: true },
        "block-host": { type: "string", multiple: true },
        "allow-path": { type: "string", multiple: true },
        timeout: { type: "string" },
        "no-fix": { type: "boolean", default: false },
        "fix-agent": { type: "string" },
        "fix-tool": { type: "string" },
        out: { type: "string" },
        copy: { type: "boolean", default: false },
        format: { type: "string" },
        json: { type: "boolean", default: false },
        keep: { type: "boolean", default: false },
        "no-keychain": { type: "boolean", default: false },
      },
      allowPositionals: true,
    });
  } catch (e) {
    throw usage((e as Error).message.split("\n")[0]!);
  }
  const v = args.values;
  if (args.positionals.length !== 1) throw usage(args.positionals.length === 0 ? "missing <message-file>" : `expected one <message-file>, got ${args.positionals.length}`);
  const messageFile = path.resolve(args.positionals[0]!);
  if (!fs.existsSync(messageFile) || !fs.statSync(messageFile).isFile()) throw usage(`message file not found: ${args.positionals[0]}`);

  const format = v.format ?? "text";
  if (format !== "text" && format !== "markdown") throw usage(`--format expects text or markdown, got '${format}'`);
  let timeoutMs: number | undefined;
  if (v.timeout !== undefined) {
    const n = Number(v.timeout);
    if (!Number.isFinite(n) || n <= 0) throw usage(`--timeout expects seconds > 0, got '${v.timeout}'`);
    timeoutMs = Math.round(n * 1000);
  }
  const allowPath = (v["allow-path"] ?? []).map((d) => {
    const abs = path.resolve(d);
    if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) throw usage(`--allow-path is not a directory: ${d}`);
    return abs;
  });
  let fixTool: string | undefined;
  if (v["fix-tool"] !== undefined) {
    fixTool = path.resolve(v["fix-tool"]);
    if (!fs.existsSync(fixTool)) throw usage(`--fix-tool repo not found: ${v["fix-tool"]}`);
  }
  const stubs = (v.stub ?? []).map(parseStubFlag);
  const outFile = revisedPath(messageFile, v.out);

  const result = await runSmoke({
    messageFile,
    browser: !v["no-browser"],
    stubs,
    blockHosts: v["block-host"] ?? [],
    allowPath,
    fix: !v["no-fix"],
    keep: v.keep,
    keychain: !v["no-keychain"],
    log: (line) => process.stderr.write(`smoke: ${line}\n`),
    ...(v.account !== undefined ? { account: v.account } : {}),
    ...(v.agent !== undefined ? { agent: v.agent } : {}),
    ...(v.cdp !== undefined ? { cdp: v.cdp } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(v["fix-agent"] !== undefined ? { fixAgent: v["fix-agent"] } : {}),
    ...(fixTool !== undefined ? { fixTool } : {}),
  });

  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, result.revisedMessage);

  let copied: { copied: boolean; how: string } | null = null;
  if (v.copy) copied = copyRichText(markdownToHtml(result.revisedMessage), result.revisedMessage);

  if (v.json) {
    process.stdout.write(JSON.stringify({ ...result, revisedMessagePath: outFile, ...(copied ? { copied } : {}) }, null, 2) + "\n");
    return result.exitCode;
  }

  const out: string[] = [renderFrictionTable(result, { format })];
  const details = renderFrictionDetails(result);
  if (details) out.push("", "details:", details);
  if (result.notes.length > 0) out.push("", "notes:", ...result.notes.map((n) => `- ${n}`));
  if (result.loginScripts.length > 0) {
    out.push("", "login scripts (run these yourself):", ...result.loginScripts.map((l) => `  step ${l.stepIndex}: ${l.script}`));
  }
  out.push("", `revised message: ${outFile} (${result.editsApplied} edit${result.editsApplied === 1 ? "" : "s"})`);
  if (copied) out.push(copied.copied ? `copied the revised message as rich text (${copied.how})` : `not copied: ${copied.how}`);
  out.push(v.keep ? `sandbox kept: ${result.sandboxRoot}` : `sandbox removed: ${result.sandboxRoot}`);
  out.push(`exit ${result.exitCode}: ${result.exitCode === 0 ? "every step passed or was fixed" : "friction left (see table)"}`);
  process.stdout.write(out.join("\n") + "\n");
  return result.exitCode;
}
