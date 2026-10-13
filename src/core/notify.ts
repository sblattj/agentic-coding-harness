// Desktop notifications (issue #63). One shared, best-effort delivery helper
// used by `ach queue run --notify` and by the run-lifecycle hook in the driver.
//
// Opt-in only: with no AGENTIC_CODING_HARNESS_NOTIFY set, nothing is sent.
// Delivery is OS-native (macOS osascript, Linux notify-send); a missing
// binary or an unsupported platform is a silent no-op (never stderr, never a
// throw). The body is built ONLY from run metadata (RunNotice below) so
// transcript/agent output cannot reach it by construction.
import { execFile } from "node:child_process";
import type { ExitStatus } from "./types.ts";

/** Comma list of enabled events: finish, fail, budget (or "all"). Unset = nothing. */
export const NOTIFY_ENV = "AGENTIC_CODING_HARNESS_NOTIFY";
/** "1"/"true"/"yes"/"on" plays the platform alert sound with the notification. */
export const NOTIFY_SOUND_ENV = "AGENTIC_CODING_HARNESS_NOTIFY_SOUND";

export type NotifyEvent = "finish" | "fail" | "budget";
const ALL_EVENTS: readonly NotifyEvent[] = ["finish", "fail", "budget"];

export interface NotifyConfig {
  events: ReadonlySet<NotifyEvent>;
  sound: boolean;
}

/** Fire-and-forget process launcher. Injectable so tests assert argv without spawning. */
export type NotifyExec = (file: string, args: string[]) => void;

export interface NotifyOptions {
  sound?: boolean;
  platform?: NodeJS.Platform;
  exec?: NotifyExec;
}

/** Default launcher: errors (ENOENT included) are swallowed, nothing reaches stderr. */
export const defaultNotifyExec: NotifyExec = (file, args) => {
  try {
    const child = execFile(file, args, () => {});
    child.on("error", () => {});
    child.stdin?.on("error", () => {});
  } catch {
    // best-effort
  }
};

const esc = (x: string): string => x.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

/** Raise one desktop notification. Never throws; no-op on unsupported platforms / missing tools. */
export function sendNotification(title: string, message: string, opts: NotifyOptions = {}): void {
  const platform = opts.platform ?? process.platform;
  const exec = opts.exec ?? defaultNotifyExec;
  try {
    if (platform === "darwin") {
      const sound = opts.sound === true ? ' sound name "default"' : "";
      exec("osascript", ["-e", `display notification "${esc(message)}" with title "${esc(title)}"${sound}`]);
    } else if (platform === "linux") {
      // Sound is best-effort on Linux: the freedesktop sound-name hint, honoured by
      // servers that support it and ignored by the rest.
      const hint = opts.sound === true ? ["--hint=string:sound-name:message-new-instant"] : [];
      exec("notify-send", [...hint, "--", title, message]);
    }
  } catch {
    // never let a notification break the caller
  }
}

/** Parse the opt-in config from env. Unknown tokens are ignored; unset = no events. */
export function parseNotifyConfig(env: NodeJS.ProcessEnv = process.env): NotifyConfig {
  const events = new Set<NotifyEvent>();
  for (const raw of (env[NOTIFY_ENV] ?? "").split(",")) {
    const tok = raw.trim().toLowerCase();
    if (tok === "all") for (const e of ALL_EVENTS) events.add(e);
    else if ((ALL_EVENTS as readonly string[]).includes(tok)) events.add(tok as NotifyEvent);
  }
  const sound = /^(1|true|yes|on)$/i.test((env[NOTIFY_SOUND_ENV] ?? "").trim());
  return { events, sound };
}

/**
 * Final ExitStatus -> notification event (null = no notification).
 *   success                                  -> finish
 *   error, unavailable                       -> fail
 *   budget_exceeded, turn_limit, timeout     -> budget
 *   aborted, cancelled                       -> none (deliberate stop by the user)
 */
export function eventForExit(exit: ExitStatus): NotifyEvent | null {
  switch (exit) {
    case "success":
      return "finish";
    case "error":
    case "unavailable":
      return "fail";
    case "budget_exceeded":
    case "turn_limit":
    case "timeout":
      return "budget";
    default:
      return null;
  }
}

/** Run metadata the notification may show. Deliberately has no transcript/event field. */
export interface RunNotice {
  runId: string;
  agent: string;
  /** The task prompt (first line is shown, truncated). */
  prompt?: string;
  exitStatus: ExitStatus;
  costUsd?: number;
}

const TITLES: Record<NotifyEvent, string> = {
  finish: "ach: run finished",
  fail: "ach: run failed",
  budget: "ach: run hit its budget",
};

const clean = (s: string): string => s.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();

export function formatRunNotice(event: NotifyEvent, n: RunNotice): { title: string; body: string } {
  const task = clean((n.prompt ?? "").split("\n", 1)[0] ?? "");
  const parts = [
    task === "" ? undefined : `task: ${task.length > 60 ? `${task.slice(0, 59)}…` : task}`,
    `agent: ${clean(n.agent)}`,
    `run ${clean(n.runId).slice(0, 8)}`,
    `status: ${n.exitStatus}`,
    typeof n.costUsd === "number" && Number.isFinite(n.costUsd) ? `cost: $${n.costUsd.toFixed(4)}` : undefined,
  ].filter((p): p is string => p !== undefined);
  return { title: TITLES[event], body: parts.join(" | ") };
}

/** Notify for a run whose final status is already durable. Returns the event sent, or null. */
export function notifyRunEnd(
  n: RunNotice,
  opts: { env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform; exec?: NotifyExec } = {},
): NotifyEvent | null {
  try {
    const cfg = parseNotifyConfig(opts.env ?? process.env);
    const event = eventForExit(n.exitStatus);
    if (event === null || !cfg.events.has(event)) return null;
    const { title, body } = formatRunNotice(event, n);
    sendNotification(title, body, {
      sound: cfg.sound,
      ...(opts.platform !== undefined ? { platform: opts.platform } : {}),
      ...(opts.exec !== undefined ? { exec: opts.exec } : {}),
    });
    return event;
  } catch {
    return null;
  }
}
