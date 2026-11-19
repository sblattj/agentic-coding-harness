// Which role prompt a desk's agent session last received (#214 `desk reload`).
//
// A reload continues the same agent session, which already holds the role prompt it was given at
// its start. When the role files changed since (an edited role, or an ach upgrade that ships new
// built-in roles), the resumed session must get the current text once, as a refresh; when they
// did not, repeating the whole prompt on every reload would only grow the history. Engines record
// the delivered prompt's hash per desk here, keyed by session id:
//   <stateDir>/desks/<stack>/role-sent/<name>.json  {sessionId, sha256, at}
// No record (a session that predates it, or a lost file) counts as changed: deliver once.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { deskPaths } from "./roster.ts";
import type { HostSpec } from "./types.ts";

type Who = Pick<HostSpec, "stateDir" | "stack" | "name">;

export interface RoleSent {
  sessionId: string;
  sha256: string;
  at: number;
}

export function roleSentFile(w: Who): string {
  return join(deskPaths(w.stateDir, w.stack).root, "role-sent", `${w.name}.json`);
}

export function roleHash(prompt: string): string {
  return createHash("sha256").update(prompt, "utf8").digest("hex");
}

export function readRoleSent(w: Who): RoleSent | null {
  try {
    const r = JSON.parse(readFileSync(roleSentFile(w), "utf8")) as Partial<RoleSent>;
    return typeof r.sessionId === "string" && typeof r.sha256 === "string" ? { sessionId: r.sessionId, sha256: r.sha256, at: Number(r.at) || 0 } : null;
  } catch {
    return null;
  }
}

/** Record that session `sessionId` now holds `prompt`. Best effort: a failed write only means one extra refresh later. */
export function writeRoleSent(w: Who, sessionId: string, prompt: string): void {
  try {
    const f = roleSentFile(w);
    mkdirSync(dirname(f), { recursive: true });
    const tmp = `${f}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify({ sessionId, sha256: roleHash(prompt), at: Date.now() } satisfies RoleSent)}\n`);
    renameSync(tmp, f);
  } catch {
    /* best effort */
  }
}

/**
 * True when resumed session `sessionId` may hold another role prompt than `prompt` (or none recorded).
 * An empty current prompt (the role was removed) needs a refresh only when the record says this
 * session got a non-empty one: then the session must be told it no longer applies. With no record
 * for this session there is nothing known to retract.
 */
export function roleNeedsRefresh(w: Who, sessionId: string, prompt: string): boolean {
  const r = readRoleSent(w);
  if (prompt === "") return r !== null && r.sessionId === sessionId && r.sha256 !== roleHash("");
  return r === null || r.sessionId !== sessionId || r.sha256 !== roleHash(prompt);
}

/**
 * The note a resumed session gets when its role prompt changed: the full current prompt, marked as
 * replacing the old one, or (empty prompt, the role was removed) word that the earlier one no longer applies.
 */
export function roleRefreshNote(prompt: string): string {
  if (prompt === "") {
    return "[ach: your role prompt was removed since this session started. The earlier role prompt in this conversation no longer applies; you have no role prompt now. No reply needed.]";
  }
  return `[ach: your role prompt changed since this session started. The text below is the current one; it replaces the earlier role prompt in this conversation. No reply needed.]\n\n${prompt}`;
}
