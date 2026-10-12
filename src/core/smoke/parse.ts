// `ach smoke` message parser (agentic-coding-harness#139): turn a how-to
// message (markdown) into the literal steps a brand-new reader would perform.
//
// Decisions:
//  - Only fences whose info-string language is a shell (sh/bash/zsh/shell/
//    console/terminal), `prompt`/`agent`, or `open` produce steps. json, yaml,
//    text and bare fences are illustrations, not instructions.
//  - One logical command = one step. `\` continuations and heredocs are folded
//    into the step; `text` keeps the original newlines and backslashes so the
//    runner executes exactly what the reader would paste.
//  - console/terminal fences mix commands and sample output: only `$ ` / `% `
//    prompt lines are commands.
//  - line numbers are 1-based lines of the ORIGINAL file so fix.ts can address
//    edits (see applyEdits in report.ts).
import type { SmokeStep, StepKind } from "./types.ts";

const SHELL_LANGS = new Set(["sh", "bash", "zsh", "shell", "console", "terminal"]);
const PROMPT_LANGS = new Set(["prompt", "agent"]);
const PROMPTED_LANGS = new Set(["console", "terminal"]);

/** Split a fence info string into its language (first word) and key=value attrs. */
export function parseFenceInfo(info: string): { lang: string; attrs: Record<string, string> } {
  const s = info.trim();
  const m = /^(\S*)\s*(.*)$/.exec(s)!;
  const lang = m[1]!.toLowerCase();
  const attrs: Record<string, string> = {};
  const rest = m[2]!;
  const re = /([A-Za-z_][\w.-]*)=(?:"([^"]*)"|'([^']*)'|(\S*))/g;
  let a: RegExpExecArray | null;
  while ((a = re.exec(rest))) attrs[a[1]!] = a[2] ?? a[3] ?? a[4] ?? "";
  return { lang, attrs };
}

interface SrcLine {
  text: string;
  line: number;
}

function heredocTerminator(text: string): string | null {
  const m = /<<(?!<)-?\s*(?:'([^']+)'|"([^"]+)"|\\?([A-Za-z_][\w]*))/.exec(text);
  return m ? (m[1] ?? m[2] ?? m[3]!) : null;
}

/** Fold physical lines into logical commands (continuations, heredocs). */
function collectCommands(
  lines: SrcLine[],
  prompted: boolean,
  stripDollar: boolean,
  limit = Infinity,
): SrcLine[] {
  const out: SrcLine[] = [];
  let i = 0;
  while (i < lines.length && out.length < limit) {
    let raw = lines[i]!.text;
    const start = lines[i]!.line;
    const trimmed = raw.trim();
    if (trimmed === "" || trimmed.startsWith("#")) {
      i++;
      continue;
    }
    if (prompted) {
      const pm = /^\s*[$%] (.*)$/.exec(raw);
      if (!pm) {
        i++;
        continue;
      }
      raw = pm[1]!;
    } else if (stripDollar) {
      raw = raw.replace(/^(\s*)\$ /, "$1");
    }
    const parts = [raw];
    let term = heredocTerminator(raw);
    let cont = /\\$/.test(raw);
    i++;
    while (i < lines.length && (term !== null || cont)) {
      const next = lines[i]!.text;
      parts.push(next);
      i++;
      if (term !== null) {
        if (next.trim() === term) {
          term = null;
          cont = false;
        }
        continue;
      }
      const t2 = heredocTerminator(next);
      if (t2 !== null) term = t2;
      cont = /\\$/.test(next);
    }
    out.push({ text: parts.join("\n"), line: start });
  }
  return out;
}

const OPEN_LEAD = /^\s*(?:open|go to|visit|navigate)\b/i;

function openUrl(line: string): string | null {
  if (!OPEN_LEAD.test(line)) return null;
  const urls = line.match(/https?:\/\/[^\s<>"'`]+/g);
  if (!urls || urls.length !== 1) return null;
  return urls[0]!.replace(/[.,;:!?)\]]+$/, "");
}

export function parseMessage(text: string): SmokeStep[] {
  const lines = text.split(/\r?\n/);
  const steps: SmokeStep[] = [];
  let section: string | undefined;

  const push = (kind: StepKind, t: string, line: number, attrs: Record<string, string>) => {
    const step: SmokeStep = { index: steps.length + 1, kind, text: t, line, attrs };
    if (section !== undefined) step.section = section;
    steps.push(step);
  };

  let i = 0;
  while (i < lines.length) {
    const ln = lines[i]!;
    const fence = /^\s{0,3}(`{3,}|~{3,})\s*(.*)$/.exec(ln);
    if (fence && !(fence[1]![0] === "`" && fence[2]!.includes("`"))) {
      const marker = fence[1]!;
      const { lang, attrs } = parseFenceInfo(fence[2]!);
      const body: SrcLine[] = [];
      let j = i + 1;
      for (; j < lines.length; j++) {
        const c = /^\s{0,3}(`{3,}|~{3,})\s*$/.exec(lines[j]!);
        if (c && c[1]![0] === marker[0] && c[1]!.length >= marker.length) break;
        body.push({ text: lines[j]!, line: j + 1 });
      }
      if (SHELL_LANGS.has(lang)) {
        for (const c of collectCommands(body, PROMPTED_LANGS.has(lang), true)) {
          push("shell", c.text, c.line, attrs);
        }
      } else if (PROMPT_LANGS.has(lang)) {
        let a = 0;
        let b = body.length;
        while (a < b && body[a]!.text.trim() === "") a++;
        while (b > a && body[b - 1]!.text.trim() === "") b--;
        if (b > a) {
          push("prompt", body.slice(a, b).map((l) => l.text).join("\n"), body[a]!.line, attrs);
        }
      } else if (lang === "open") {
        for (const l of body) if (l.text.trim() !== "") push("open", l.text.trim(), l.line, attrs);
      }
      i = j + 1;
      continue;
    }

    const h = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/.exec(ln);
    if (h) {
      section = h[1]!;
      i++;
      continue;
    }

    if (/^\s*\$ /.test(ln)) {
      const rest: SrcLine[] = [];
      for (let k = i; k < lines.length; k++) rest.push({ text: lines[k]!, line: k + 1 });
      const cmd = collectCommands(rest, false, true, 1)[0]!;
      push("shell", cmd.text, cmd.line, {});
      i += cmd.text.split("\n").length;
      continue;
    }

    const code = /^\s*`([^`]+)`\s*$/.exec(ln);
    if (code) {
      push("shell", code[1]!, i + 1, {});
      i++;
      continue;
    }

    const url = openUrl(ln);
    if (url) push("open", url, i + 1, {});
    i++;
  }
  return steps;
}
