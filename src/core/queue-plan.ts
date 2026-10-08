// Queue plan-file parsing (issue #115 part A). Pure TypeScript, no shell: a
// quote-aware tokenizer per line, so macOS bash 3.2 / zsh word-splitting
// never enters the picture.
//
//   <label> <cwd> <agent> <model> <prompt-file> [--pre "<cmd>"] [--post "<cmd>"] [ach run flags...]
//
// `#` starts a comment at the start of a token; blank lines are skipped.
// `--pre` / `--post` are consumed by the queue; every other trailing token is
// passed through to `ach run` unchanged. `-` as the model means "no --model".
import os from "node:os";
import path from "node:path";
import { HarnessError } from "./types.ts";

export interface PlanSlice {
  label: string;
  cwd: string;
  agent: string;
  model?: string;
  promptFile: string;
  runArgs: string[];
  preCmd?: string;
  postCmd?: string;
  /** 1-based plan line, for error messages. */
  line: number;
}

/** Split one line into tokens. Single quotes are literal; double quotes allow
 *  \" and \\ escapes; outside quotes a backslash escapes the next char. A `#`
 *  at the start of a token ends the line. Throws on an unterminated quote. */
export function tokenizeLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inTok = false;
  let i = 0;
  while (i < line.length) {
    const c = line[i]!;
    if (c === "'" ) {
      const end = line.indexOf("'", i + 1);
      if (end === -1) throw new Error("unterminated single quote");
      cur += line.slice(i + 1, end);
      inTok = true;
      i = end + 1;
    } else if (c === '"') {
      i++;
      let closed = false;
      while (i < line.length) {
        const d = line[i]!;
        if (d === "\\" && (line[i + 1] === '"' || line[i + 1] === "\\")) {
          cur += line[i + 1];
          i += 2;
        } else if (d === '"') {
          closed = true;
          i++;
          break;
        } else {
          cur += d;
          i++;
        }
      }
      if (!closed) throw new Error("unterminated double quote");
      inTok = true;
    } else if (c === "\\" && i + 1 < line.length) {
      cur += line[i + 1];
      inTok = true;
      i += 2;
    } else if (/\s/.test(c)) {
      if (inTok) out.push(cur);
      cur = "";
      inTok = false;
      i++;
    } else if (c === "#" && !inTok) {
      break;
    } else {
      cur += c;
      inTok = true;
      i++;
    }
  }
  if (inTok) out.push(cur);
  return out;
}

const LABEL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const RESERVED_PASSTHROUGH = new Set(["--agent", "--model"]);

function resolveAgainst(baseDir: string, p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return path.resolve(baseDir, p);
}

/** Parse plan text. Relative cwd / prompt-file paths resolve against `baseDir`
 *  (the plan file's directory). */
export function parsePlan(text: string, baseDir: string): PlanSlice[] {
  const slices: PlanSlice[] = [];
  const seen = new Set<string>();
  const lines = text.split(/\r?\n/);
  for (let n = 0; n < lines.length; n++) {
    const lineNo = n + 1;
    const fail = (msg: string): never => {
      throw new HarnessError(`plan line ${lineNo}: ${msg}`, "USAGE");
    };
    let toks: string[];
    try {
      toks = tokenizeLine(lines[n]!);
    } catch (e) {
      return fail((e as Error).message);
    }
    if (toks.length === 0) continue;
    if (toks.length < 5) {
      fail(`expected '<label> <cwd> <agent> <model> <prompt-file> [flags...]', got ${toks.length} field(s)`);
    }
    const [label, cwd, agent, model, promptFile, ...rest] = toks as [string, string, string, string, string, ...string[]];
    if (!LABEL_RE.test(label)) fail(`label '${label}' must match ${LABEL_RE} (it names the slice log file)`);
    if (seen.has(label)) fail(`duplicate label '${label}'`);
    seen.add(label);
    const runArgs: string[] = [];
    let preCmd: string | undefined;
    let postCmd: string | undefined;
    for (let i = 0; i < rest.length; i++) {
      const t = rest[i]!;
      const hook = /^--(pre|post)(?:=(.*))?$/.exec(t);
      if (hook) {
        const which = hook[1] as "pre" | "post";
        let val = hook[2];
        if (val === undefined) {
          val = rest[++i];
          if (val === undefined) fail(`--${which} needs a command`);
        }
        if (!val!.trim()) fail(`--${which} needs a non-empty command`);
        if (which === "pre") preCmd = val;
        else postCmd = val;
        continue;
      }
      const flagName = t.split("=")[0]!;
      if (RESERVED_PASSTHROUGH.has(flagName)) fail(`${flagName} is a plan column, not a trailing flag`);
      runArgs.push(t);
    }
    slices.push({
      label,
      cwd: resolveAgainst(baseDir, cwd),
      agent,
      ...(model === "-" ? {} : { model }),
      promptFile: resolveAgainst(baseDir, promptFile),
      runArgs,
      ...(preCmd !== undefined ? { preCmd } : {}),
      ...(postCmd !== undefined ? { postCmd } : {}),
      line: lineNo,
    });
  }
  if (slices.length === 0) throw new HarnessError("plan has no slices", "USAGE");
  return slices;
}
