// Privacy modes for shared reports and exports (#46).
//
// Pure module, layered on #71's masking: `maskForExport` (src/core/masking.ts)
// applies the privacy transform first and secret masking second, so every
// export path that already calls the chokepoint gets privacy for free.
//
// Modes:
//   off     nothing changes (the default; output is byte-identical to today's).
//   redact  path-valued fields (`cwd`, `rawTranscript`, `rootDir`, ...) become
//           their basename; `$HOME` is collapsed to `~` in every string; other
//           users' home dirs go through #71's `home-path` detector
//           (`[REDACTED_HOME]`). Numbers are never touched.
//   anon    redact, plus: prompt text (`prompt`, `promptPreview`, `task`, and
//           the content of user and system messages) becomes
//           `[REDACTED_PROMPT]`; run and session ids become stable short
//           hashes (`anon-<12 hex>`, unsalted sha256, so the same input gives
//           the same hash on every run and machine), everywhere they appear;
//           repo-dir names (`cwd`) are hashed the same way.
//
// Only string leaves change. Arrays keep their length and order, objects keep
// their keys, so ATIF step ids, OTel span counts and every token, cost and
// duration number come out identical.
//
// This module imports nothing from masking.ts (masking.ts imports it), so
// #71's home-path detector comes in as the `otherHomes` hook.
import { createHash } from "node:crypto";

export const PRIVACY_MODES = ["off", "redact", "anon"] as const;
export type PrivacyMode = (typeof PRIVACY_MODES)[number];

/** The built-in default: `off` keeps every output byte-identical to the pre-#46 releases. */
export const DEFAULT_PRIVACY_MODE: PrivacyMode = "off";

/** Env var that sets the privacy mode (beats the config file, loses to `--privacy`). */
export const PRIVACY_ENV = "AGENTIC_CODING_HARNESS_PRIVACY";

/** What anon writes in place of prompt text. */
export const PROMPT_PLACEHOLDER = "[REDACTED_PROMPT]";

export interface PrivacyPolicy {
  mode: PrivacyMode;
  /** The home directory collapsed to `~` (the CLI passes $HOME). Absent = only #71's home-path detector runs. */
  home?: string;
}

export const NO_PRIVACY: PrivacyPolicy = { mode: DEFAULT_PRIVACY_MODE };

export function parsePrivacyMode(v: string, label: string): PrivacyMode {
  if ((PRIVACY_MODES as readonly string[]).includes(v)) return v as PrivacyMode;
  throw new Error(`${label} expects one of ${PRIVACY_MODES.join("|")}, got '${v}'`);
}

/** The parseArgs option table for `--privacy` (ach emit, ach report). */
export const PRIVACY_OPTIONS = {
  privacy: { type: "string" },
} as const;

const normKey = (k: string) => k.toLowerCase().replace(/[^a-z]/g, "");

/** Keys whose absolute-path value becomes its basename under redact. */
const PATH_KEYS = new Set(["cwd", "rawtranscript", "rootdir", "trialdir", "tempdir", "transcriptpath", "reporoot", "repodir", "workdir"]);
/** Keys whose value names the repo dir; anon hashes the basename. */
const REPO_KEYS = new Set(["cwd", "reporoot", "repodir", "workdir"]);
/** Keys holding prompt text; anon replaces the value. */
const PROMPT_KEYS = new Set(["prompt", "promptpreview", "task"]);
/** Keys holding run / session ids; anon hashes the value (and every other occurrence of it). */
const ID_KEYS = new Set(["runid", "sessionid", "parentrunid", "parentsessionid", "conversationid", "nativesessionid"]);
/** Keys holding a list of session ids (RunResult.usage child sessions); anon hashes each item. */
const ID_LIST_KEYS = new Set(["childsessionids", "missingchildsessionids"]);
/** Message fields that carry the text. */
const TEXT_FIELDS = ["content", "data", "text"] as const;
const PROMPT_ROLES = new Set(["user", "system"]);
/** Ids shorter than this are hashed where they sit but not searched for inside other strings. */
const MIN_EMBEDDED_ID = 6;

const ANON_RE = /^anon-[0-9a-f]{12}$/;

/** Stable short hash of an id: `anon-` + the first 12 hex chars of sha256(id). No salt, by design. */
export function anonId(id: string): string {
  if (ANON_RE.test(id)) return id;
  return `anon-${createHash("sha256").update(id).digest("hex").slice(0, 12)}`;
}

function isAbsolutePath(s: string): boolean {
  return s.startsWith("/") || /^[A-Za-z]:[\\/]/.test(s) || s.startsWith("~/");
}

function basename(s: string): string {
  const parts = s.replace(/[\\/]+$/, "").split(/[\\/]+/);
  return parts[parts.length - 1] || s;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== "object") return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/** A user or system message: a harness event (`type: message`) or a chat message (`{role, content}`). */
function isPromptMessage(o: Record<string, unknown>): boolean {
  const who = typeof o.source === "string" ? o.source : typeof o.role === "string" ? o.role : undefined;
  if (who === undefined || !PROMPT_ROLES.has(who)) return false;
  if (o.type === "message") return true;
  return o.type === undefined && typeof o.role === "string" && "content" in o;
}

/**
 * Apply a privacy mode to a JSON-like value (a run, an event stream, the
 * report model, SFT samples). Returns the same reference in mode `off`, a
 * transformed copy otherwise. The input is never mutated. `otherHomes` masks
 * home dirs other than `policy.home` (maskForExport passes #71's home-path
 * detector).
 */
export function applyPrivacy<T>(value: T, policy: PrivacyPolicy = NO_PRIVACY, otherHomes?: (s: string) => string): T {
  if (policy.mode === "off") return value;
  const anon = policy.mode === "anon";
  const home = policy.home !== undefined && policy.home.replace(/[\\/]+$/, "").length > 1 ? policy.home.replace(/[\\/]+$/, "") : undefined;
  const homeRe = home === undefined ? undefined : new RegExp(`${escapeRe(home)}(?=[\\\\/"'\\s:;,)\\]}<>]|$)`, "g");

  // anon: every id value under an id key, so its other occurrences (file
  // names, attribute values) get the same hash.
  const ids = new Set<string>();
  if (anon) {
    const collect = (v: unknown, key: string | undefined): void => {
      if (typeof v === "string") {
        if (key !== undefined && ID_KEYS.has(normKey(key)) && v !== "" && !ANON_RE.test(v)) ids.add(v);
      } else if (Array.isArray(v)) v.forEach((x) => collect(x, key !== undefined && ID_LIST_KEYS.has(normKey(key)) ? "sessionId" : undefined));
      else if (isPlainObject(v)) for (const [k, x] of Object.entries(v)) collect(x, k);
    };
    collect(value, undefined);
  }
  const embedded = [...ids].filter((id) => id.length >= MIN_EMBEDDED_ID).sort((a, b) => b.length - a.length);
  const idRe = embedded.length > 0 ? new RegExp(embedded.map(escapeRe).join("|"), "g") : undefined;

  const scrubText = (s: string): string => {
    let out = s;
    if (homeRe !== undefined) out = out.replace(homeRe, "~");
    if (otherHomes !== undefined) out = otherHomes(out);
    if (idRe !== undefined) out = out.replace(idRe, (m) => anonId(m));
    return out;
  };

  const walkString = (s: string, key: string | undefined): string => {
    if (s === "" || key === undefined) return scrubText(s);
    const k = normKey(key);
    if (anon && PROMPT_KEYS.has(k)) return PROMPT_PLACEHOLDER;
    if (anon && ID_KEYS.has(k)) return anonId(s);
    if (PATH_KEYS.has(k) && isAbsolutePath(s)) {
      const base = basename(s);
      return anon && REPO_KEYS.has(k) ? anonId(base) : scrubText(base);
    }
    return scrubText(s);
  };

  const walk = (v: unknown, key: string | undefined): unknown => {
    if (typeof v === "string") return walkString(v, key);
    if (Array.isArray(v)) {
      const itemKey = anon && key !== undefined && ID_LIST_KEYS.has(normKey(key)) ? "sessionId" : undefined;
      return v.map((x) => walk(x, itemKey));
    }
    if (isPlainObject(v)) {
      const prompt = anon && isPromptMessage(v);
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v)) {
        out[k] = prompt && (TEXT_FIELDS as readonly string[]).includes(k) && x !== undefined && x !== null && x !== "" ? PROMPT_PLACEHOLDER : walk(x, k);
      }
      return out;
    }
    return v;
  };
  return walk(value, undefined) as T;
}

/** Hash one id the way `applyPrivacy` would under anon (for ids that come from flags or defaults). */
export function privacyId(id: string, mode: PrivacyMode): string {
  return mode === "anon" && id !== "" ? anonId(id) : id;
}

/** One-line description of what a mode did, for stamps and notes. */
export function describePrivacy(mode: PrivacyMode): string {
  switch (mode) {
    case "off":
      return "privacy off: nothing removed";
    case "redact":
      return "privacy redact: paths shortened to basenames, $HOME collapsed to ~; numbers unchanged";
    case "anon":
      return "privacy anon: paths shortened, prompt text removed, run/session ids and repo names hashed; numbers unchanged";
  }
}
