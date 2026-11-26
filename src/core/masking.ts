// Secret masking and PII scrubbing for every export path (#71).
//
// Pure module: detectors, a text masker, a deep JSON-value masker, the export
// chokepoint (`maskForExport`) and the mode resolver. No I/O here; the CLI
// sinks (`ach emit`, `ach report`, `ach scrub`, the MCP emit tool) call
// `resolveMaskPolicy` once and `maskForExport` on what they are about to
// write or send.
//
// Modes (the issue spells them `none | preview | all`):
//   none     nothing is scanned or changed (today's behavior).
//   preview  dry run: list every finding, write and send nothing.
//   all      replace every finding with a labeled placeholder before export.
//
// Placeholders are stable and label the detector (`[REDACTED_API_KEY]`), so
// masking is idempotent: no placeholder matches any detector.
import { z } from "zod";
import {
  applyPrivacy,
  DEFAULT_PRIVACY_MODE,
  parsePrivacyMode,
  PRIVACY_ENV,
  PRIVACY_MODES,
  type PrivacyMode,
  type PrivacyPolicy,
} from "./privacy.ts";

export const MASK_MODES = ["none", "preview", "all"] as const;
export type MaskMode = (typeof MASK_MODES)[number];

/**
 * The built-in mode for LOCAL sinks (atif, sft, report, scrub, export): `none`,
 * so a file written on this machine stays byte-identical to the pre-#71
 * releases. Outbound sinks default to `all`; the per-sink table
 * `SINK_DEFAULT_MASK_MODE` below is what `resolveMaskPolicy` falls back to.
 */
export const DEFAULT_MASK_MODE: MaskMode = "none";

/** `replace` writes `[REDACTED_<LABEL>]`; `partial` keeps a short prefix (`sk-ant-api...****`). */
export const MASK_STYLES = ["replace", "partial"] as const;
export type MaskStyle = (typeof MASK_STYLES)[number];
export const DEFAULT_MASK_STYLE: MaskStyle = "replace";

/** Export sinks with their own config toggle (`mask.<sink>` in the config file). */
export const MASK_SINKS = ["atif", "otel", "langfuse", "sft", "report", "scrub", "export"] as const;
export type MaskSink = (typeof MASK_SINKS)[number];

/**
 * Owner decision (#71): the built-in mode per sink, the last step of the
 * precedence chain. Outbound sinks (otel, langfuse: the data leaves the
 * machine) mask everything; local sinks keep today's raw output. Typed as a
 * full Record, so a new sink without a default is a compile error. Any
 * `--mask`, env var, `mask.<sink>` or `mask.mode` setting beats it.
 */
export const SINK_DEFAULT_MASK_MODE: Record<MaskSink, MaskMode> = {
  atif: DEFAULT_MASK_MODE,
  otel: "all",
  langfuse: "all",
  sft: DEFAULT_MASK_MODE,
  report: DEFAULT_MASK_MODE,
  scrub: DEFAULT_MASK_MODE,
  export: DEFAULT_MASK_MODE,
};

/** Env var that sets the global mode (beats the config file, loses to `--mask`). */
export const MASK_ENV = "AGENTIC_CODING_HARNESS_MASK";

// ---------------------------------------------------------------- detectors

export interface Detector {
  /** Stable id shown in findings and counts (`anthropic-key`). */
  id: string;
  /** Placeholder label: `[REDACTED_<label>]`. */
  label: string;
  /** Global regex. A named group `secret` limits the replaced span; the rest of the match is kept. */
  re: RegExp;
  /** Whether `partial` style may keep a prefix (false for emails, paths, key blocks, URL credentials). */
  partial: boolean;
  /** Extra acceptance check on the secret span (entropy detector). */
  accept?: (secret: string) => boolean;
}

const SECRET_FIELD_RE = /^(?:password|passwd|secret|clientsecret|apikey|accesstoken|authtoken|refreshtoken|authorization|privatekey|secretkey|secretaccesskey)$/;

/** Built-in detectors, in match order (specific shapes before generic ones). */
export const BUILTIN_DETECTORS: readonly Detector[] = [
  {
    id: "private-key",
    label: "PRIVATE_KEY",
    // A PEM block; an unterminated one runs to the end of its base64 body.
    re: /-----BEGIN[A-Z0-9 ]*PRIVATE KEY-----(?:[\s\S]*?-----END[A-Z0-9 ]*PRIVATE KEY-----|[A-Za-z0-9+/=\s]*)/g,
    partial: false,
  },
  { id: "anthropic-key", label: "API_KEY", re: /\bsk-ant-[A-Za-z0-9_-]{16,}/g, partial: true },
  { id: "openai-key", label: "API_KEY", re: /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}/g, partial: true },
  { id: "github-token", label: "GITHUB_TOKEN", re: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})/g, partial: true },
  { id: "aws-access-key", label: "AWS_ACCESS_KEY", re: /\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b/g, partial: true },
  {
    id: "aws-secret-key",
    label: "AWS_SECRET_KEY",
    re: /(?<pre>aws_?secret_?access_?key["']?\s*[:=]\s*["']?)(?<secret>[A-Za-z0-9/+]{40})(?![A-Za-z0-9/+])/gi,
    partial: true,
  },
  { id: "gcp-api-key", label: "API_KEY", re: /\bAIza[0-9A-Za-z_-]{35}/g, partial: true },
  { id: "slack-token", label: "SLACK_TOKEN", re: /\bxox[abposr]-[A-Za-z0-9-]{10,}/g, partial: true },
  { id: "stripe-key", label: "API_KEY", re: /\b[sr]k_(?:live|test)_[A-Za-z0-9]{16,}/g, partial: true },
  { id: "jwt", label: "JWT", re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, partial: true },
  {
    id: "bearer-token",
    label: "BEARER_TOKEN",
    re: /(?<pre>\b(?:Bearer|Basic)\s+)(?<secret>(?!\[REDACTED_)[A-Za-z0-9._~+/-]{16,}=*)/g,
    partial: true,
  },
  {
    id: "url-credentials",
    label: "CREDENTIALS",
    // user:password in a connection string or URL (postgres://u:p@host).
    re: /(?<pre>\b[a-zA-Z][a-zA-Z0-9+.-]*:\/\/)(?<secret>[^\s:/@"'<>\\[\]]+:[^\s@"'<>\\/]+)(?=@)/g,
    partial: false,
  },
  {
    id: "credential-assignment",
    label: "SECRET",
    // KEY=value / "password": "value" pairs (.env files, configs, shell echoes).
    re: /(?<pre>[A-Za-z0-9_-]*(?:password|passwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token|private[_-]?key)["']?\s*[:=]\s*["']?)(?<secret>(?!\[REDACTED_)[^\s"'\\,;&<>*]{8,})/gi,
    partial: true,
    // A star preview left by `partial` style (`abc...****`) is not a new secret.
    accept: (s) => !s.endsWith("..."),
  },
  { id: "email", label: "EMAIL", re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/g, partial: false },
  {
    id: "home-path",
    label: "HOME",
    // /Users/<name>, /home/<name>, C:\Users\<name> (also with JSON-doubled backslashes).
    re: /(?:\/Users\/|\/home\/|\b[A-Za-z]:\\{1,2}Users\\{1,2})(?!Shared\b)[^/\\\s"'<>:*?|[\]]+/g,
    partial: false,
  },
];

/** Shannon entropy in bits per character. */
export function shannonEntropy(s: string): number {
  if (s.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let h = 0;
  for (const n of counts.values()) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

/** Minimum bits/char for the opt-in entropy detector. */
export const ENTROPY_THRESHOLD = 4.0;

/**
 * Opt-in high-entropy detector: 24+ chars of base62/base64 alphabet with
 * upper, lower and digits, entropy >= ENTROPY_THRESHOLD. Never matches pure
 * numbers, hex (UUIDs, git SHAs, trace/span ids) or prefixed ids
 * (`toolu_...`, `call_...`, `msg_...`), so tool-call pairing survives.
 */
export const ENTROPY_DETECTOR: Detector = {
  id: "high-entropy",
  label: "HIGH_ENTROPY",
  re: /(?<![A-Za-z0-9+/_=-])[A-Za-z0-9+/_=-]{24,}(?![A-Za-z0-9+/_=-])/g,
  partial: true,
  accept: (s) =>
    !/^[0-9a-fA-F-]+$/.test(s) &&
    !/^[a-z]{2,}[_-]/.test(s) &&
    !s.includes("REDACTED_") &&
    /[A-Z]/.test(s) &&
    /[a-z]/.test(s) &&
    /[0-9]/.test(s) &&
    shannonEntropy(s) >= ENTROPY_THRESHOLD,
};

// ---------------------------------------------------------------- options

export interface MaskOptions {
  style?: MaskStyle;
  /** Enable the high-entropy detector (off by default). */
  entropy?: boolean;
  /** User regexes (`--mask-pattern`); a named group `secret` limits the replaced span. */
  patterns?: readonly RegExp[];
}

/** Compile a user pattern; a bad regex is a usage error the caller reports. */
export function compilePattern(src: string): RegExp {
  try {
    return new RegExp(src, "g");
  } catch (e) {
    throw new Error(`invalid --mask-pattern '${src}': ${e instanceof Error ? e.message : String(e)}`);
  }
}

export function detectorsFor(opts: MaskOptions = {}): Detector[] {
  const out = [...BUILTIN_DETECTORS];
  (opts.patterns ?? []).forEach((re, i) => {
    out.push({
      id: opts.patterns!.length === 1 ? "custom" : `custom-${i + 1}`,
      label: "CUSTOM",
      re: re.global ? re : new RegExp(re.source, re.flags + "g"),
      partial: true,
    });
  });
  if (opts.entropy) out.push(ENTROPY_DETECTOR);
  return out;
}

// ---------------------------------------------------------------- findings

export interface Finding {
  detector: string;
  /** JSON path (`$.events[3].content`) for values, `line:col` for text. */
  location: string;
  /** Star-preview of the secret: never the plaintext. */
  sample: string;
  /** What masking writes in its place. */
  replacement: string;
}

/** `sk-ant-api...****`: up to 10 chars, at most a third of the secret. */
export function starPreview(secret: string): string {
  const keep = Math.min(10, Math.floor(secret.length / 3));
  return `${secret.slice(0, keep)}...****`;
}

function placeholder(d: Detector, secret: string, style: MaskStyle): string {
  return style === "partial" && d.partial ? starPreview(secret) : `[REDACTED_${d.label}]`;
}

function lineCol(text: string, offset: number): string {
  let line = 1;
  let last = -1;
  for (let i = 0; i < offset; i++) {
    if (text.charCodeAt(i) === 10) {
      line++;
      last = i;
    }
  }
  return `${line}:${offset - last}`;
}

export interface MaskTextResult {
  text: string;
  findings: Finding[];
}

/**
 * Mask one string. `where` is the location prefix for findings: a JSON path
 * (findings get `<path>`, plus `@<offset>` when the string holds several), or
 * undefined for a text file (findings get `line:col` in the original text).
 */
export function maskText(text: string, opts: MaskOptions = {}, where?: string, detectors: readonly Detector[] = detectorsFor(opts)): MaskTextResult {
  const style = opts.style ?? DEFAULT_MASK_STYLE;
  const findings: Finding[] = [];
  let cur = text;
  // Offsets map back to the original only for the first pass; later passes
  // run on text already masked, so text-file locations use the current text,
  // which differs from the original only inside earlier placeholders.
  for (const d of detectors) {
    d.re.lastIndex = 0;
    cur = cur.replace(d.re, (...args: unknown[]) => {
      const match = args[0] as string;
      const last = args[args.length - 1];
      const groups = (typeof last === "object" && last !== null ? last : undefined) as Record<string, string | undefined> | undefined;
      const offset = args[groups !== undefined ? args.length - 3 : args.length - 2] as number;
      const src = args[groups !== undefined ? args.length - 2 : args.length - 1] as string;
      const secret = groups?.secret ?? match;
      const pre = groups?.secret !== undefined ? (groups.pre ?? match.slice(0, match.indexOf(secret))) : "";
      const post = groups?.secret !== undefined ? match.slice(pre.length + secret.length) : "";
      if (secret === "" || (d.accept !== undefined && !d.accept(secret))) return match;
      const rep = placeholder(d, secret, style);
      const at = offset + pre.length;
      findings.push({
        detector: d.id,
        location: where === undefined ? lineCol(src, at) : where,
        sample: d.partial ? starPreview(secret) : `[REDACTED_${d.label}]`,
        replacement: rep,
      });
      return pre + rep + post;
    });
  }
  return { text: cur, findings };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== "object") return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

const normKey = (k: string) => k.toLowerCase().replace(/[^a-z]/g, "");
const propPath = (base: string, key: string) => (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? `${base}.${key}` : `${base}[${JSON.stringify(key)}]`);

export interface MaskValueResult<T> {
  value: T;
  findings: Finding[];
}

/**
 * Deep-mask a JSON-like value: every string leaf goes through maskText, and a
 * string under a secret-named key (`password`, `apiKey`, `authorization`, ...)
 * is replaced whole. Arrays and plain objects are copied; numbers, booleans,
 * null and non-plain objects (Date, Map) are kept as they are. Object keys
 * are never changed. The input is not mutated.
 */
export function maskValue<T>(value: T, opts: MaskOptions = {}, root = "$"): MaskValueResult<T> {
  const detectors = detectorsFor(opts);
  const style = opts.style ?? DEFAULT_MASK_STYLE;
  const findings: Finding[] = [];
  const walk = (v: unknown, at: string, key: string | undefined): unknown => {
    if (typeof v === "string") {
      if (key !== undefined && v !== "" && !v.startsWith("[REDACTED_") && !v.endsWith("...****") && SECRET_FIELD_RE.test(normKey(key))) {
        const d: Detector = { id: "secret-field", label: "SECRET", re: /$^/g, partial: true };
        const rep = placeholder(d, v, style);
        findings.push({ detector: d.id, location: at, sample: starPreview(v), replacement: rep });
        return rep;
      }
      const r = maskText(v, opts, at, detectors);
      findings.push(...r.findings);
      return r.text;
    }
    if (Array.isArray(v)) return v.map((x, i) => walk(x, `${at}[${i}]`, undefined));
    if (isPlainObject(v)) {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v)) out[k] = walk(x, propPath(at, k), k);
      return out;
    }
    return v;
  };
  return { value: walk(value, root, undefined) as T, findings };
}

/** Per-detector counts, sorted by detector id. */
export function countByDetector(findings: readonly Finding[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const f of [...findings].sort((a, b) => a.detector.localeCompare(b.detector))) out[f.detector] = (out[f.detector] ?? 0) + 1;
  return out;
}

/** `anthropic-key 1, email 2` (or `none`). */
export function formatCounts(findings: readonly Finding[]): string {
  const c = Object.entries(countByDetector(findings));
  return c.length === 0 ? "none" : c.map(([k, n]) => `${k} ${n}`).join(", ");
}

/** One line per finding, prefixed by `source` (a file or sink name). Never prints plaintext. */
export function formatFindings(source: string, findings: readonly Finding[]): string {
  return findings.map((f) => `${source}\t${f.location}\t${f.detector}\t${f.sample} -> ${f.replacement}\n`).join("");
}

const plural = (n: number) => `${n} finding${n === 1 ? "" : "s"}`;

/** The whole `--mask preview` listing for one source: finding lines plus a summary line. */
export function formatPreview(source: string, findings: readonly Finding[]): string {
  return formatFindings(source, findings) + `mask preview: ${source}: ${plural(findings.length)} (${formatCounts(findings)}); nothing written or sent\n`;
}

/** The `--mask all` note (stderr), so masking is never silent. */
export function formatMaskedNote(source: string, findings: readonly Finding[]): string {
  return `mask: ${source}: masked ${plural(findings.length)} (${formatCounts(findings)})\n`;
}

// ---------------------------------------------------------------- policy

export interface MaskPolicy {
  mode: MaskMode;
  options: MaskOptions;
  /** #46: privacy mode, applied before secret masking; absent = off. */
  privacy?: PrivacyPolicy;
}

/** The policy that changes nothing (mode none; the local sinks' built-in default). */
export const NO_MASK: MaskPolicy = { mode: DEFAULT_MASK_MODE, options: {} };

export interface ExportGateResult<T> {
  /** The value to export: the same reference in mode `none`/`preview`, a masked copy in `all`. */
  value: T;
  findings: Finding[];
  mode: MaskMode;
  /** #46: the privacy mode that was applied (stamp it into the output when not `off`). */
  privacy: PrivacyMode;
}

/** #46: `[REDACTED_HOME]` for home dirs other than the collapsed $HOME (#71's home-path detector). */
const HOME_DETECTORS = BUILTIN_DETECTORS.filter((d) => d.id === "home-path");
const maskOtherHomes = (s: string): string => (/\/Users\/|\/home\/|Users\\/.test(s) ? maskText(s, {}, "$", HOME_DETECTORS).text : s);

/**
 * The one chokepoint every export path calls on what it is about to write or
 * send. `none` returns the value untouched without scanning (zero cost, zero
 * change); `preview` scans and returns the original plus findings (the
 * caller must then write and send nothing); `all` returns a masked copy.
 */
export function maskForExport<T>(value: T, policy: MaskPolicy = NO_MASK): ExportGateResult<T> {
  // #46: privacy first (off returns the same reference), then secret masking.
  const privacy = policy.privacy?.mode ?? DEFAULT_PRIVACY_MODE;
  const v = privacy === "off" ? value : applyPrivacy(value, policy.privacy, maskOtherHomes);
  if (policy.mode === "none") return { value: v, findings: [], mode: "none", privacy };
  const r = maskValue(v, policy.options);
  return { value: policy.mode === "all" ? r.value : v, findings: r.findings, mode: policy.mode, privacy };
}

/** The config file's top-level `mask` object (validated by config.ts). */
export const MaskConfigSchema = z
  .strictObject({
    mode: z.enum(MASK_MODES).optional().describe(`global mask mode for every export; unset, each sink uses its built-in default (otel and langfuse 'all', the local sinks '${DEFAULT_MASK_MODE}'); mask.<sink>, env ${MASK_ENV} and --mask win`),
    style: z.enum(MASK_STYLES).optional().describe("replace = [REDACTED_<LABEL>], partial = short prefix + ...****"),
    entropy: z.boolean().optional().describe("enable the high-entropy detector (off by default)"),
    patterns: z
      .array(
        z.string().refine((src) => {
          try {
            new RegExp(src, "g");
            return true;
          } catch {
            return false;
          }
        }, "is not a valid regular expression"),
      )
      .optional().describe("extra regexes to mask (a named group 'secret' limits the replaced span)"),
    ...Object.fromEntries(MASK_SINKS.map((s) => [s, z.enum(MASK_MODES).optional().describe(`${s === "export" ? "mask mode for ach export" : `mask mode for the ${s} export`} (beats mask.mode; built-in default '${SINK_DEFAULT_MASK_MODE[s]}')`)])),
    privacy: z
      .enum(PRIVACY_MODES)
      .optional()
      .describe(`privacy mode for shared reports and exports (#46): off | redact | anon (default '${DEFAULT_PRIVACY_MODE}'); env ${PRIVACY_ENV} and --privacy win`),
  })
  .describe("secret masking before export (#71): see docs/MASKING.md");
export type MaskConfig = {
  mode?: MaskMode;
  style?: MaskStyle;
  entropy?: boolean;
  patterns?: string[];
  privacy?: PrivacyMode;
} & Partial<Record<MaskSink, MaskMode>>;

function parseMode(v: string, label: string): MaskMode {
  if ((MASK_MODES as readonly string[]).includes(v)) return v as MaskMode;
  throw new Error(`${label} expects one of ${MASK_MODES.join("|")}, got '${v}'`);
}

export interface MaskFlags {
  mask?: string | undefined;
  "mask-style"?: string | undefined;
  "mask-entropy"?: boolean | undefined;
  "mask-pattern"?: string[] | undefined;
  /** #46: `--privacy off|redact|anon`. */
  privacy?: string | undefined;
}

/** The parseArgs option table every masking command shares. */
export const MASK_OPTIONS = {
  mask: { type: "string" },
  "mask-style": { type: "string" },
  "mask-entropy": { type: "boolean" },
  "mask-pattern": { type: "string", multiple: true },
} as const;

/**
 * Resolve one sink's policy. Mode precedence: `--mask` > env MASK_ENV >
 * config `mask.<sink>` > config `mask.mode` > SINK_DEFAULT_MASK_MODE[sink]. Style,
 * entropy and patterns: flag > config > default; flag patterns add to the
 * config's. Throws Error on a bad value (callers wrap it as a usage error).
 */
export function resolveMaskPolicy(input: {
  sink: MaskSink;
  flags?: MaskFlags;
  config?: MaskConfig | undefined;
  env?: Record<string, string | undefined>;
  /** #46: the home dir privacy collapses to `~` (default env HOME, else USERPROFILE). */
  home?: string;
}): MaskPolicy {
  const flags = input.flags ?? {};
  const cfg = input.config ?? {};
  const env = input.env ?? process.env;
  const envMode = env[MASK_ENV];
  const mode =
    flags.mask !== undefined
      ? parseMode(flags.mask, "--mask")
      : envMode !== undefined && envMode !== ""
        ? parseMode(envMode, MASK_ENV)
        : cfg[input.sink] ?? cfg.mode ?? SINK_DEFAULT_MASK_MODE[input.sink];
  const styleRaw = flags["mask-style"] ?? cfg.style ?? DEFAULT_MASK_STYLE;
  if (!(MASK_STYLES as readonly string[]).includes(styleRaw)) {
    throw new Error(`--mask-style expects one of ${MASK_STYLES.join("|")}, got '${styleRaw}'`);
  }
  const patterns = [...(cfg.patterns ?? []), ...(flags["mask-pattern"] ?? [])].map(compilePattern);
  const options: MaskOptions = { style: styleRaw as MaskStyle };
  if (flags["mask-entropy"] === true || cfg.entropy === true) options.entropy = true;
  if (patterns.length > 0) options.patterns = patterns;
  // #46: --privacy > env PRIVACY_ENV > config mask.privacy > DEFAULT_PRIVACY_MODE.
  const envPrivacy = env[PRIVACY_ENV];
  const privacy =
    flags.privacy !== undefined
      ? parsePrivacyMode(flags.privacy, "--privacy")
      : envPrivacy !== undefined && envPrivacy !== ""
        ? parsePrivacyMode(envPrivacy, PRIVACY_ENV)
        : cfg.privacy ?? DEFAULT_PRIVACY_MODE;
  if (privacy === "off") return { mode, options };
  const home = input.home ?? env.HOME ?? env.USERPROFILE;
  return { mode, options, privacy: home !== undefined && home !== "" ? { mode: privacy, home } : { mode: privacy } };
}
