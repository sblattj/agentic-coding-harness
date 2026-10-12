// `ach smoke` reporting (agentic-coding-harness#139): the friction table, the
// per-row details, applying fix edits to the message, and getting the revised
// message onto the clipboard as rich text.
//
// Decisions:
//  - Edits are addressed by ORIGINAL 1-based line numbers and applied
//    bottom-up (by original position), so earlier edits never shift later ones.
//  - markdownToHtml is deliberately small and dependency-free: it targets chat
//    and email paste, escapes every character it does not recognize as markup,
//    and only emits http(s)/mailto links.
//  - copyRichText on macOS goes html -> RTF (textutil) -> pbcopy -Prefer rtf, so
//    Mail/Slack/Docs paste rich text. It never throws for a missing tool.
import { spawnSync } from "node:child_process";

import { HarnessError } from "../types.ts";
import type { FixRecord, MessageEdit, SmokeReport, StepRecord } from "./types.ts";

// ---------------------------------------------------------------- friction table

const STEP_MAX = 48;

function stepCell(r: StepRecord): string {
  const first = (r.step.text.split("\n")[0] ?? "").trim();
  return first.length > STEP_MAX ? `${first.slice(0, STEP_MAX - 1)}…` : first;
}

/**
 * Role of a record the integration added after a fix (#139 index.ts):
 * "install" = an inserted install step it executed, "rerun" = the failing
 * step run again (attempt 2). Stored in step.attrs so the contract types stay
 * unchanged; attempt-1 records carry neither.
 */
export const SMOKE_ROLE_ATTR = "smoke-role";

function role(r: StepRecord): "install" | "rerun" | "original" {
  const v = r.step.attrs[SMOKE_ROLE_ATTR];
  return v === "install" || v === "rerun" ? v : r.attempt > 1 ? "rerun" : "original";
}

function indexCell(r: StepRecord): string {
  const rl = role(r);
  return rl === "original" ? String(r.step.index) : `${r.step.index} ${rl === "install" ? "fix" : "rerun"}`;
}

/**
 * One outcome per message step (by step.index), ignoring inserted-install
 * rows: "fixed" when any of its records is fixed, else the status of its last
 * original/rerun record. Used by the footer and by runSmoke's exit code.
 */
export function finalStatuses(records: StepRecord[]): Map<number, { status: StepRecord["status"]; record: StepRecord }> {
  const out = new Map<number, { status: StepRecord["status"]; record: StepRecord }>();
  for (const r of records) {
    if (role(r) === "install") continue;
    const prev = out.get(r.step.index);
    const fixed = prev?.status === "fixed" || r.status === "fixed";
    out.set(r.step.index, { status: fixed ? "fixed" : r.status, record: r });
  }
  return out;
}

const FIX_MAX = 60;

/** First fix of the step (summary clipped), plus a count of the rest; renderFrictionDetails has them all. */
function fixCell(fixes: FixRecord[], stepIndex: number): string {
  const mine = fixes.filter((f) => f.stepIndex === stepIndex);
  if (mine.length === 0) return "";
  const f = mine[0]!;
  const sum = f.summary.length > FIX_MAX ? `${f.summary.slice(0, FIX_MAX - 1)}…` : f.summary;
  return `${f.target}: ${sum} (${f.where})${mine.length > 1 ? ` (+${mine.length - 1} more)` : ""}`;
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

const HEADER = ["#", "step", "status", "time", "tokens", "prompts/denials", "friction", "fix"];

function rows(report: SmokeReport): string[][] {
  return report.steps.map((r) => [
    indexCell(r),
    stepCell(r),
    r.status,
    seconds(r.durationMs),
    r.tokens === null ? "-" : String(r.tokens),
    String(r.prompts.length + r.denials.length),
    r.friction.map((f) => f.kind).join(", "),
    role(r) === "original" ? fixCell(report.fixes, r.step.index) : "",
  ]);
}

function footerLines(report: SmokeReport): string[] {
  const finals = [...finalStatuses(report.steps).values()];
  const count = (s: string) => finals.filter((f) => f.status === s).length;
  const totalMs = report.steps.reduce((n, r) => n + r.durationMs, 0);
  const totalTokens = report.steps.reduce((n, r) => n + (r.tokens ?? 0), 0);
  const keychain =
    report.hostKeychainUnchanged === null ? "n/a" : report.hostKeychainUnchanged ? "yes" : "no";
  return [
    `steps: ${finals.length} (pass ${count("pass")}, fail ${count("fail")}, fixed ${count("fixed")}, skipped ${count("skipped")})`,
    `total time: ${seconds(totalMs)}, total tokens: ${totalTokens}${report.fixAgentTokens ? ` (+ ${report.fixAgentTokens} fix-agent)` : ""}`,
    `host keychain unchanged: ${keychain}`,
    `reaped pids: ${report.reapedPids.length}`,
    `stubbed requests: ${report.stubbedRequests.length}`,
  ];
}

export function renderFrictionTable(
  report: SmokeReport,
  opts: { format?: "text" | "markdown" } = {},
): string {
  const body = rows(report);
  const footer = footerLines(report);
  if (opts.format === "markdown") {
    const esc = (c: string) => c.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\n/g, " ");
    const line = (cells: string[]) => `| ${cells.map(esc).join(" | ")} |`;
    return [
      line(HEADER),
      `| ${HEADER.map(() => "---").join(" | ")} |`,
      ...body.map(line),
      "",
      ...footer.map((f) => `- ${f}`),
    ].join("\n");
  }
  const widths = HEADER.map((h, c) => Math.max(h.length, ...body.map((r) => r[c]!.length)));
  const line = (cells: string[]) =>
    cells
      .map((cell, c) => cell.padEnd(widths[c]!))
      .join("  ")
      .trimEnd();
  return [
    line(HEADER),
    widths.map((w) => "-".repeat(w)).join("  "),
    ...body.map(line),
    "",
    ...footer,
  ].join("\n");
}

export function renderFrictionDetails(report: SmokeReport): string {
  const out: string[] = [];
  for (const r of report.steps) {
    const label = role(r) === "original" ? `step ${r.step.index}` : `step ${indexCell(r)}`;
    for (const f of r.friction) {
      out.push(`${label} [${f.kind}] ${f.detail}`);
      if (f.evidence) {
        for (const l of f.evidence.split("\n")) out.push(`    ${l}`);
      }
    }
    if (role(r) !== "original") continue;
    for (const fx of report.fixes.filter((x) => x.stepIndex === r.step.index)) {
      const rerun = fx.rerunPassed === null ? "not rerun" : fx.rerunPassed ? "pass" : "fail";
      out.push(`  fix (${fx.target}) at ${fx.where}: ${fx.summary}; rerunPassed: ${rerun}`);
    }
  }
  return out.join("\n");
}

// ---------------------------------------------------------------- message edits

export function applyEdits(message: string, edits: MessageEdit[]): string {
  const lines = message.split("\n");
  const mismatch = (e: MessageEdit, why: string) =>
    new HarnessError(`edit at line ${e.line} does not apply: ${why}`, "SMOKE_EDIT_MISMATCH");

  interface Op {
    pos: number; // splice index in the original line array
    del: number;
    ins: string[];
    rank: number; // application order at the same pos (lower first)
    seq: number;
  }
  const spanOf = (e: MessageEdit) => (e.original !== undefined ? e.original.split("\n").length : 1);
  const replaceStarts = new Map<number, number>();
  for (const e of edits) {
    if (e.op === "replace") replaceStarts.set(e.line, spanOf(e));
  }

  const ops: Op[] = edits.map((e, seq) => {
    if (!Number.isInteger(e.line) || e.line < 1 || e.line > lines.length) {
      throw mismatch(e, `line out of range (message has ${lines.length} lines)`);
    }
    const ins = e.text.split("\n");
    if (e.op === "replace") {
      let del = 1;
      if (e.original !== undefined) {
        const want = e.original.split("\n");
        for (let k = 0; k < want.length; k++) {
          if (lines[e.line - 1 + k] !== want[k]) {
            throw mismatch(e, `original text not found at that line (expected ${JSON.stringify(want[k])})`);
          }
        }
        del = want.length;
      }
      return { pos: e.line - 1, del, ins, rank: 0, seq };
    }
    if (e.op === "insert-before") return { pos: e.line - 1, del: 0, ins, rank: 1, seq };
    const span = replaceStarts.get(e.line) ?? 1;
    return { pos: e.line - 1 + span, del: 0, ins, rank: 2, seq };
  });

  // Bottom-up by original position; at one position replace first, then
  // insert-before, then insert-after (each later splice lands earlier), and
  // reversed input order within a kind so the final order matches input order.
  ops.sort((a, b) => b.pos - a.pos || a.rank - b.rank || b.seq - a.seq);
  for (const op of ops) lines.splice(op.pos, op.del, ...op.ins);
  return lines.join("\n");
}

// ---------------------------------------------------------------- markdown -> html

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function inlineText(s: string): string {
  const stash: string[] = [];
  const hold = (html: string) => `\u0000${stash.push(html) - 1}\u0000`;
  let t = esc(s);
  t = t.replace(/`([^`]+)`/g, (_m, c: string) => hold(`<code>${c}</code>`));
  t = t.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, text: string, url: string) => {
    if (!/^(https?:\/\/|mailto:)/i.test(url)) return m;
    return hold(`<a href="${url}">${text}</a>`);
  });
  t = t.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  t = t.replace(/(?<![*\w])\*(?![\s*])(.+?)(?<![\s*])\*(?![*\w])/g, "<em>$1</em>");
  return t.replace(/\u0000(\d+)\u0000/g, (_m, n: string) => stash[Number(n)]!);
}

export function markdownToHtml(md: string): string {
  const lines = md.split(/\r?\n/);
  const out: string[] = [];
  let para: string[] = [];
  const flush = () => {
    if (para.length) out.push(`<p>${inlineText(para.join(" "))}</p>`);
    para = [];
  };
  let i = 0;
  while (i < lines.length) {
    const ln = lines[i]!;
    const fence = /^\s{0,3}(`{3,}|~{3,})/.exec(ln);
    if (fence) {
      flush();
      const body: string[] = [];
      i++;
      while (i < lines.length) {
        const c = /^\s{0,3}(`{3,}|~{3,})\s*$/.exec(lines[i]!);
        if (c && c[1]![0] === fence[1]![0] && c[1]!.length >= fence[1]!.length) break;
        body.push(lines[i]!);
        i++;
      }
      i++;
      out.push(`<pre><code>${esc(body.join("\n"))}</code></pre>`);
      continue;
    }
    const h = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(ln);
    if (h) {
      flush();
      out.push(`<h${h[1]!.length}>${inlineText(h[2]!)}</h${h[1]!.length}>`);
      i++;
      continue;
    }
    const li = /^\s*(?:([-*+])|(\d+)[.)])\s+(.*)$/.exec(ln);
    if (li) {
      flush();
      const ordered = li[2] !== undefined;
      const items: string[] = [];
      while (i < lines.length) {
        const m = /^\s*(?:([-*+])|(\d+)[.)])\s+(.*)$/.exec(lines[i]!);
        if (!m || (m[2] !== undefined) !== ordered) break;
        items.push(`<li>${inlineText(m[3]!)}</li>`);
        i++;
      }
      const tag = ordered ? "ol" : "ul";
      out.push(`<${tag}>${items.join("")}</${tag}>`);
      continue;
    }
    if (ln.trim() === "") flush();
    else para.push(ln.trim());
    i++;
  }
  flush();
  return out.join("\n");
}

// ---------------------------------------------------------------- clipboard

export interface RunResult {
  status: number | null;
  stderr: string;
  /** Present for tools whose output feeds the next stage (textutil -> pbcopy). */
  stdout?: string;
}
/** JXA: read {html, rtf, plain} JSON on stdin, write all three flavors to the general pasteboard. */
const PASTEBOARD_JXA = [
  'ObjC.import("AppKit");',
  "var d = $.NSFileHandle.fileHandleWithStandardInput.readDataToEndOfFile;",
  "var p = JSON.parse($.NSString.alloc.initWithDataEncoding(d, $.NSUTF8StringEncoding).js);",
  "var pb = $.NSPasteboard.generalPasteboard;",
  "pb.clearContents;",
  'var ok = pb.setStringForType($(p.html), "public.html") && pb.setStringForType($(p.rtf), "public.rtf") && pb.setStringForType($(p.plain), "public.utf8-plain-text");',
  'ok ? "ok" : "fail";',
].join("\n");

export type RunTool = (cmd: string, args: string[], input: string) => RunResult;

const defaultRun: RunTool = (cmd, args, input) => {
  try {
    const r = spawnSync(cmd, args, { input, encoding: "utf8", timeout: 15_000 });
    return { status: r.error ? null : r.status, stderr: r.stderr ?? "", stdout: r.stdout ?? "" };
  } catch (err) {
    return { status: null, stderr: String(err) };
  }
};

export function copyRichText(
  html: string,
  plain: string,
  deps: { platform?: NodeJS.Platform; run?: RunTool } = {},
): { copied: boolean; how: string } {
  const platform = deps.platform ?? process.platform;
  const run = deps.run ?? defaultRun;
  try {
    if (platform === "darwin") {
      const conv = run("/usr/bin/textutil", ["-convert", "rtf", "-format", "html", "-stdin", "-stdout"], html);
      if (conv.status !== 0 || !conv.stdout) {
        return { copied: false, how: `textutil failed (status ${conv.status}): ${conv.stderr.trim()}` };
      }
      // `pbcopy -Prefer rtf` puts ONLY the RTF flavor on the pasteboard: pbpaste
      // and plain-text fields then get nothing, and Chrome (Gmail, Slack web)
      // reads HTML, not RTF. One NSPasteboard write carries all three flavors.
      const payload = JSON.stringify({ html, rtf: conv.stdout, plain });
      const cp = run("/usr/bin/osascript", ["-l", "JavaScript", "-e", PASTEBOARD_JXA], payload);
      if (cp.status !== 0 || (cp.stdout ?? "").trim() !== "ok") {
        return { copied: false, how: `pasteboard write failed (status ${cp.status}): ${cp.stderr.trim() || (cp.stdout ?? "").trim()}` };
      }
      return { copied: true, how: "textutil -> NSPasteboard (html, rtf, plain text)" };
    }
    const tools: Array<[string, string[]]> = [
      ["xclip", ["-selection", "clipboard", "-t", "text/html"]],
      ["wl-copy", ["--type", "text/html"]],
    ];
    for (const [cmd, args] of tools) {
      if (run(cmd, args, html).status === 0) return { copied: true, how: cmd };
    }
    return { copied: false, how: "no clipboard tool" };
  } catch (err) {
    return { copied: false, how: `clipboard error: ${String(err)}` };
  }
}
