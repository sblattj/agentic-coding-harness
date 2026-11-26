// Alert rules engine (#74): declarative rules over the run registry that tell
// a human or a downstream system when runs keep failing or a live run hangs.
//
// Two rule classes, configured under the top-level `alerts` key of the config
// file (src/cli/config.ts, docs/ALERTS.md):
//   error_rate  N of the last M runs with a verdict failed, and/or K
//               consecutive failures (runVerdict decides what a failure is)
//   idle        an in-flight run (status running, pid alive) recorded no agent
//               event for X seconds (RunRecord.lastEventAt)
//
// Firing is edge-triggered (the debounce): one hit per episode. An error_rate
// episode starts at the run that tipped the condition and lasts until it
// clears; an idle episode is one quiet spell of one run (a new event ends it).
// On top of that a per-rule cooldown rate-limits hits; a hit inside the
// cooldown is suppressed (counted, not delayed) and the next delivered hit
// reports how many were suppressed. Episode and cooldown state persist in
// <stateDir>/alert-rules-state.json so a restarted `ach watch` or a cron'd
// `ach alerts --once` does not re-announce an episode already sent.
//
// This module is pure apart from the state file helpers: the clock, the pid
// probe, the registry records and the destinations are all injected. The
// destinations (webhook through src/core/event-webhook.ts, desktop through
// src/core/notify.ts) fail open: a failed delivery never throws to the caller.
//
// Distinct from the budget alerts of #20 (src/core/budget-alerts.ts), which
// watch ONE run's spend; those keep their own `<stateDir>/alerts.json`.
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { HarnessError } from "./types.ts";
import { runVerdict, type RunRecord } from "./registry.ts";
import { ALERT_WEBHOOK_EVENT, webhookOrigin, type EventWebhook } from "./event-webhook.ts";

/** Top-level config file key holding the rules. */
export const ALERTS_KEY = "alerts";
/** Rule names: no dots or spaces, so they stay usable as state keys and in logs. */
export const ALERT_RULE_NAME_RE = /^[A-Za-z0-9_][A-Za-z0-9_-]*$/;
/** Default per-rule cooldown between two delivered hits, in seconds. */
export const DEFAULT_ALERT_COOLDOWN_SEC = 600;
export const ALERT_RULE_TYPES = ["error_rate", "idle"] as const;
export type AlertRuleType = (typeof ALERT_RULE_TYPES)[number];

// ---------------------------------------------------------------- schema

const posInt = () => z.number().int("must be a whole number").min(1, "must be at least 1");

export const WebhookDestinationSchema = z.strictObject({
  type: z.literal("webhook"),
  url: z.string().regex(/^https?:\/\/\S+$/i, "must be an absolute http(s) URL").describe("receiver URL; the POST uses the #64 envelope with type \"alert\" (docs/EVENT-WEBHOOK.md)"),
});

export const DesktopDestinationSchema = z.strictObject({
  type: z.literal("desktop"),
  sound: z.boolean().optional().describe("play the platform alert sound"),
});

export const AlertDestinationSchema = z.discriminatedUnion("type", [WebhookDestinationSchema, DesktopDestinationSchema]);
export type AlertDestination = z.infer<typeof AlertDestinationSchema>;

const ruleBase = {
  name: z.string().regex(ALERT_RULE_NAME_RE, "must be letters, digits, '_' or '-'").describe("unique rule name (state key, shown in every hit)"),
  agent: z.string().min(1).optional().describe("only runs of this agent"),
  cooldownSec: z.number().min(0, "must be >= 0").optional().describe(`minimum seconds between two delivered hits of this rule (default ${DEFAULT_ALERT_COOLDOWN_SEC})`),
  destinations: z.array(AlertDestinationSchema).min(1, "needs at least one destination").describe("where a hit goes: webhook and/or desktop"),
};

export const ErrorRateRuleSchema = z.strictObject({
  ...ruleBase,
  type: z.literal("error_rate"),
  failures: posInt().optional().describe("fire when this many of the last `window` runs failed"),
  window: posInt().optional().describe("how many recent runs with a verdict `failures` counts over"),
  consecutive: posInt().optional().describe("fire when this many runs in a row failed"),
});

export const IdleRuleSchema = z.strictObject({
  ...ruleBase,
  type: z.literal("idle"),
  idleSec: z.number().positive("must be > 0").describe("fire when an in-flight run records no event for this many seconds"),
});

export const AlertRuleSchema = z.discriminatedUnion("type", [ErrorRateRuleSchema, IdleRuleSchema]);
export type ErrorRateRule = z.infer<typeof ErrorRateRuleSchema>;
export type IdleRule = z.infer<typeof IdleRuleSchema>;
export type AlertRule = z.infer<typeof AlertRuleSchema>;

export const AlertsConfigSchema = z
  .strictObject({
    rules: z.array(AlertRuleSchema).optional().describe("alert rules evaluated by `ach watch` and `ach alerts` (docs/ALERTS.md)"),
  })
  .describe("alert rules engine (#74): error_rate and idle rules with webhook and desktop destinations");
export type AlertsConfig = z.infer<typeof AlertsConfigSchema>;

const typeName = (v: unknown): string => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v);

/**
 * Every problem in an `alerts` value, as messages naming the dotted path
 * (empty = valid). Unknown keys, bad thresholds and the cross-field rules
 * (failures needs window, failures <= window, one condition at least, unique
 * names) are all reported here.
 */
export function alertsConfigProblems(body: unknown, label: string = ALERTS_KEY): string[] {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return [`'${label}' must be an object, got ${typeName(body)}`];
  const r = AlertsConfigSchema.safeParse(body);
  if (!r.success) {
    return r.error.issues.map((i) => {
      const at = [label, ...i.path.map(String)].join(".");
      if (i.code === "unrecognized_keys") return i.keys.map((k) => `'${at}' has unknown key '${k}'`).join("; ");
      if (i.code === "invalid_union" && "discriminator" in i) return `'${at}' must be one of: ${at.includes("destinations") ? "webhook, desktop" : ALERT_RULE_TYPES.join(", ")}`;
      return `'${at}' ${i.message}`;
    });
  }
  const problems: string[] = [];
  const seen = new Set<string>();
  (r.data.rules ?? []).forEach((rule, i) => {
    const at = `${label}.rules.${i}`;
    if (seen.has(rule.name)) problems.push(`'${at}.name' duplicates rule '${rule.name}' (names must be unique)`);
    seen.add(rule.name);
    if (rule.type === "error_rate") {
      const hasN = rule.failures !== undefined;
      const hasM = rule.window !== undefined;
      if (!hasN && !hasM && rule.consecutive === undefined) problems.push(`'${at}' (error_rate) needs failures + window, consecutive, or both`);
      if (hasN !== hasM) problems.push(`'${at}' (error_rate) sets ${hasN ? "failures without window" : "window without failures"}; give both`);
      if (hasN && hasM && rule.failures! > rule.window!) problems.push(`'${at}.failures' (${rule.failures}) cannot exceed window (${rule.window})`);
    }
  });
  return problems;
}

/** Parse and validate; throws a CONFIG HarnessError naming the first problem. */
export function parseAlertsConfig(body: unknown, label: string = ALERTS_KEY): AlertRule[] {
  const [first] = alertsConfigProblems(body, label);
  if (first !== undefined) throw new HarnessError(`alerts: ${first}`, "CONFIG");
  return AlertsConfigSchema.parse(body).rules ?? [];
}

// ---------------------------------------------------------------- hits

export type AlertMetricName = "consecutive_failures" | "failures_in_window" | "idle_seconds";

/** One rule hit: what a destination receives. */
export interface AlertHit {
  rule: string;
  ruleType: AlertRuleType;
  /** ms epoch the condition became true (a replay uses history's clock). */
  at: number;
  /** The run that tipped an error_rate rule, or the idle run. */
  runId: string;
  agent: string;
  metric: AlertMetricName;
  /** The configured threshold that was breached (K, N, or idleSec). */
  threshold: number;
  /** The observed value (failures counted, or seconds idle). */
  value: number;
  /** error_rate N-of-M only: M. */
  window?: number;
  /** error_rate: the failed runs counted, oldest first. */
  runs?: Array<{ runId: string; agent: string; status: string; endedAt: number }>;
  /** idle: ms epoch of the run's last event (startedAt when it never had one). */
  lastEventAt?: number;
  /** Hits of this rule suppressed by the cooldown since the last delivered one. */
  suppressedSinceLastFire: number;
  message: string;
}

/** The hit's webhook payload (the envelope adds runId, type and timestamp). */
export function alertPayload(hit: AlertHit): Record<string, unknown> {
  return {
    rule: hit.rule,
    ruleType: hit.ruleType,
    metric: hit.metric,
    threshold: hit.threshold,
    value: hit.value,
    ...(hit.window !== undefined ? { window: hit.window } : {}),
    agent: hit.agent,
    ...(hit.runs !== undefined ? { runs: hit.runs } : {}),
    ...(hit.lastEventAt !== undefined ? { lastEventAt: new Date(hit.lastEventAt).toISOString() } : {}),
    suppressedSinceLastFire: hit.suppressedSinceLastFire,
    message: hit.message,
  };
}

// ---------------------------------------------------------------- conditions

/** When a terminal run ended: explicit endedAt, else its last write, else its start. */
export function runEndAt(rec: RunRecord): number {
  return rec.endedAt ?? rec.updatedAt ?? rec.startedAt;
}

interface VerdictRun {
  rec: RunRecord;
  failed: boolean;
  endAt: number;
}

/** The runs a rule counts: matching agent, a success or failure verdict, oldest end first. */
function verdictRuns(rule: ErrorRateRule, records: readonly RunRecord[], now: number): VerdictRun[] {
  const out: VerdictRun[] = [];
  for (const rec of records) {
    if (rule.agent !== undefined && rec.agent !== rule.agent) continue;
    const v = runVerdict(rec, now);
    if (v !== "success" && v !== "failure") continue;
    out.push({ rec, failed: v === "failure", endAt: runEndAt(rec) });
  }
  out.sort((a, b) => a.endAt - b.endAt || a.rec.startedAt - b.rec.startedAt);
  return out;
}

const runRef = (v: VerdictRun) => ({ runId: v.rec.runId, agent: v.rec.agent, status: v.rec.status ?? v.rec.exitStatus ?? "unknown", endedAt: v.endAt });

/**
 * The error_rate condition over `seq` (oldest first), as a hit without its
 * bookkeeping fields, or null when it does not hold. Consecutive is checked
 * first, so a rule with both reports the streak.
 */
function errorRateHit(rule: ErrorRateRule, seq: readonly VerdictRun[]): Omit<AlertHit, "suppressedSinceLastFire"> | null {
  const last = seq[seq.length - 1];
  if (last === undefined || !last.failed) return null;
  const scope = rule.agent !== undefined ? ` of agent ${rule.agent}` : "";
  if (rule.consecutive !== undefined) {
    let streak = 0;
    for (let i = seq.length - 1; i >= 0 && seq[i]!.failed; i--) streak++;
    if (streak >= rule.consecutive) {
      return {
        rule: rule.name,
        ruleType: "error_rate",
        at: last.endAt,
        runId: last.rec.runId,
        agent: last.rec.agent,
        metric: "consecutive_failures",
        threshold: rule.consecutive,
        value: streak,
        runs: seq.slice(seq.length - streak).map(runRef),
        message: `${streak} consecutive failed runs${scope} (limit ${rule.consecutive})`,
      };
    }
  }
  if (rule.failures !== undefined && rule.window !== undefined) {
    const win = seq.slice(Math.max(0, seq.length - rule.window));
    const failed = win.filter((v) => v.failed);
    if (win.length >= rule.window && failed.length >= rule.failures) {
      return {
        rule: rule.name,
        ruleType: "error_rate",
        at: last.endAt,
        runId: last.rec.runId,
        agent: last.rec.agent,
        metric: "failures_in_window",
        threshold: rule.failures,
        value: failed.length,
        window: rule.window,
        runs: failed.map(runRef),
        message: `${failed.length} of the last ${rule.window} runs${scope} failed (limit ${rule.failures})`,
      };
    }
  }
  return null;
}

/** pid answers kill(pid, 0) (EPERM still means it exists). */
export function defaultPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * In flight = a local run whose record says running and whose harness pid is
 * still alive. The 15s heartbeat test of isLive() is deliberately NOT used: a
 * hung run writes no heartbeat, which is exactly what this rule looks for.
 */
export function isInFlight(rec: RunRecord, pidAlive: (pid: number) => boolean = defaultPidAlive): boolean {
  if (rec.source === "external" || rec.source === "imported") return false;
  if (rec.status !== "running" || rec.pid === undefined) return false;
  return pidAlive(rec.pid);
}

function idleHit(rule: IdleRule, rec: RunRecord, quietSince: number, at: number, now: number): Omit<AlertHit, "suppressedSinceLastFire"> {
  const seconds = Math.floor((now - quietSince) / 1000);
  return {
    rule: rule.name,
    ruleType: "idle",
    at,
    runId: rec.runId,
    agent: rec.agent,
    metric: "idle_seconds",
    threshold: rule.idleSec,
    value: seconds,
    lastEventAt: quietSince,
    message: `run ${rec.runId.slice(0, 8)} (${rec.agent}) recorded no event for ${seconds}s (limit ${rule.idleSec}s)`,
  };
}

// ---------------------------------------------------------------- state

/** Per-rule debounce + cooldown state. */
export interface AlertRuleStateEntry {
  /** ms epoch of the last DELIVERED hit (the cooldown clock). */
  lastFiredAt?: number;
  /** Episodes already announced (or suppressed) that still hold. */
  episodes: string[];
  /** Hits suppressed by the cooldown since the last delivered one. */
  suppressed: number;
}

export interface AlertRulesState {
  version: 1;
  rules: Record<string, AlertRuleStateEntry>;
}

export function freshAlertRulesState(): AlertRulesState {
  return { version: 1, rules: {} };
}

/** `<stateDir>/alert-rules-state.json` (budget alerts own `alerts.json`). */
export function alertRulesStateFile(stateDir: string): string {
  return path.join(stateDir, "alert-rules-state.json");
}

const EntrySchema = z.object({
  lastFiredAt: z.number().optional(),
  episodes: z.array(z.string()),
  suppressed: z.number().int().min(0),
});
const StateSchema = z.object({ version: z.literal(1), rules: z.record(z.string(), EntrySchema) });

/** Missing -> fresh. Unreadable or wrong shape -> fresh plus a warning; never throws. */
export function loadAlertRulesState(file: string): { state: AlertRulesState; warning?: string } {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { state: freshAlertRulesState() };
    return { state: freshAlertRulesState(), warning: `alerts: state file ${file} unreadable (${(e as Error).message}); starting fresh` };
  }
  try {
    const r = StateSchema.safeParse(JSON.parse(text));
    if (r.success) return { state: r.data as AlertRulesState };
  } catch {
    // fall through
  }
  return { state: freshAlertRulesState(), warning: `alerts: state file ${file} unreadable (unexpected shape); starting fresh` };
}

/** Atomic write (tmp + rename). Throws on I/O failure; callers fail open. */
export function saveAlertRulesState(file: string, state: AlertRulesState): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, file);
}

const entryOf = (state: AlertRulesState, name: string): AlertRuleStateEntry => {
  let e = state.rules[name];
  if (e === undefined) {
    e = { episodes: [], suppressed: 0 };
    state.rules[name] = e;
  }
  return e;
};

const cooldownMs = (rule: AlertRule): number => (rule.cooldownSec ?? DEFAULT_ALERT_COOLDOWN_SEC) * 1000;

/** A candidate episode the conditions produced at one evaluation. */
interface Candidate {
  key: string;
  hit: Omit<AlertHit, "suppressedSinceLastFire">;
}

export interface AlertDecision {
  hit: AlertHit;
  /** true = inside the cooldown: counted, not delivered. */
  suppressed: boolean;
}

/**
 * Apply debounce + cooldown for one rule at one evaluation. `active` are the
 * episodes that hold now; episodes no longer active are forgotten (they
 * re-arm). Mutates `state`; returns one decision per NEW episode.
 */
function decide(rule: AlertRule, active: readonly Candidate[], state: AlertRulesState, now: number): AlertDecision[] {
  const entry = entryOf(state, rule.name);
  const known = new Set(entry.episodes);
  const out: AlertDecision[] = [];
  for (const c of active) {
    if (known.has(c.key)) continue;
    const inCooldown = entry.lastFiredAt !== undefined && now - entry.lastFiredAt < cooldownMs(rule);
    if (inCooldown) {
      entry.suppressed++;
      out.push({ hit: { ...c.hit, suppressedSinceLastFire: 0 }, suppressed: true });
    } else {
      out.push({ hit: { ...c.hit, suppressedSinceLastFire: entry.suppressed }, suppressed: false });
      entry.lastFiredAt = now;
      entry.suppressed = 0;
    }
  }
  entry.episodes = active.map((c) => c.key);
  return out;
}

export interface EvaluateOptions {
  rules: readonly AlertRule[];
  records: readonly RunRecord[];
  state: AlertRulesState;
  now: number;
  pidAlive?: (pid: number) => boolean;
}

/**
 * One live evaluation (an `ach watch` tick, or `ach alerts --once`) over the
 * current registry snapshot. Mutates `state`. Deterministic for injected
 * `now` and `pidAlive`.
 */
export function evaluateAlertRules(opts: EvaluateOptions): AlertDecision[] {
  const pidAlive = opts.pidAlive ?? defaultPidAlive;
  const out: AlertDecision[] = [];
  for (const rule of opts.rules) {
    const active: Candidate[] = [];
    if (rule.type === "error_rate") {
      const seq = verdictRuns(rule, opts.records, opts.now);
      const hit = errorRateHit(rule, seq);
      if (hit !== null) {
        // The episode is named by the run that TIPPED the condition: walk back
        // while it still held, so later failures extend the same episode.
        let tip = seq.length - 1;
        while (tip > 0 && errorRateHit(rule, seq.slice(0, tip)) !== null) tip--;
        const tipHit = errorRateHit(rule, seq.slice(0, tip + 1)) ?? hit;
        active.push({ key: `tip:${seq[tip]!.rec.runId}`, hit: { ...hit, at: tipHit.at } });
      }
    } else {
      for (const rec of opts.records) {
        if (rule.agent !== undefined && rec.agent !== rule.agent) continue;
        if (!isInFlight(rec, pidAlive)) continue;
        const quietSince = rec.lastEventAt ?? rec.startedAt;
        const limitAt = quietSince + rule.idleSec * 1000;
        if (opts.now < limitAt) continue;
        active.push({ key: `idle:${rec.runId}@${quietSince}`, hit: idleHit(rule, rec, quietSince, opts.now, opts.now) });
      }
    }
    out.push(...decide(rule, active, opts.state, opts.now));
  }
  return out;
}

// ---------------------------------------------------------------- replay (--dry-run)

export interface ReplayOptions {
  rules: readonly AlertRule[];
  records: readonly RunRecord[];
  /**
   * Epoch-ms timestamps of a run's recorded events, any order (the idle
   * replay measures gaps between them). Return [] when unknown.
   */
  eventTimes: (rec: RunRecord) => number[];
  /** Only hits at or after this time are reported (state still warms up before it). */
  sinceMs?: number;
  now?: number;
  pidAlive?: (pid: number) => boolean;
}

/**
 * Replay history oldest first and report every hit the rules WOULD have
 * produced, delivered or suppressed, with history's own clock: error_rate is
 * re-evaluated after each run with a verdict (in end order); idle measures
 * every quiet gap of every run (start, each recorded event, end). Sends
 * nothing and touches no state file.
 */
export function replayAlertHistory(opts: ReplayOptions): AlertDecision[] {
  const now = opts.now ?? Date.now();
  const out: AlertDecision[] = [];
  for (const rule of opts.rules) {
    const state = freshAlertRulesState();
    const decisions: AlertDecision[] = [];
    if (rule.type === "error_rate") {
      const seq = verdictRuns(rule, opts.records, now);
      for (let i = 0; i < seq.length; i++) {
        const prefix = seq.slice(0, i + 1);
        const hit = errorRateHit(rule, prefix);
        const prevKey = state.rules[rule.name]?.episodes[0];
        const key = hit === null ? null : (prevKey ?? `tip:${seq[i]!.rec.runId}`);
        decisions.push(...decide(rule, hit === null || key === null ? [] : [{ key, hit }], state, seq[i]!.endAt));
      }
    } else {
      // Every quiet gap long enough, as a timed candidate; then walk them in
      // time order so the cooldown sees history's clock.
      const gaps: Array<{ at: number; rec: RunRecord; quietSince: number; until: number }> = [];
      for (const rec of opts.records) {
        if (rule.agent !== undefined && rec.agent !== rule.agent) continue;
        const end = isInFlight(rec, opts.pidAlive ?? defaultPidAlive) ? now : runEndAt(rec);
        const times = [rec.startedAt, ...opts.eventTimes(rec).filter((t) => Number.isFinite(t) && t >= rec.startedAt && t <= end), end].sort((a, b) => a - b);
        for (let i = 1; i < times.length; i++) {
          const from = times[i - 1]!;
          const to = times[i]!;
          if (to - from >= rule.idleSec * 1000) gaps.push({ at: from + rule.idleSec * 1000, rec, quietSince: from, until: to });
        }
      }
      gaps.sort((a, b) => a.at - b.at);
      for (const g of gaps) {
        const key = `idle:${g.rec.runId}@${g.quietSince}`;
        const known = state.rules[rule.name]?.episodes ?? [];
        const hit = idleHit(rule, g.rec, g.quietSince, g.at, g.until);
        decisions.push(...decide(rule, [...known.map((k) => ({ key: k, hit })), { key, hit }], state, g.at));
      }
    }
    out.push(...decisions.filter((d) => opts.sinceMs === undefined || d.hit.at >= opts.sinceMs));
  }
  out.sort((a, b) => a.hit.at - b.hit.at || a.hit.rule.localeCompare(b.hit.rule));
  return out;
}

// ---------------------------------------------------------------- destinations

/** Raise one desktop notification (src/core/notify.ts sendNotification in production). */
export type AlertNotifier = (title: string, body: string, opts: { sound: boolean }) => void;

export interface AlertDispatcherOptions {
  /** One EventWebhook per URL, built lazily (the #64 delivery: retries, signing, masking). */
  webhookFor: (url: string) => EventWebhook;
  notify: AlertNotifier;
  log?: (line: string) => void;
}

export interface AlertDispatcher {
  /** Send one hit to every destination of its rule. Never throws, never blocks. */
  deliver(rule: AlertRule, hit: AlertHit): void;
  /** Bounded flush of every webhook used (EventWebhook.flush bound each). */
  flush(): Promise<void>;
}

/** Plain text for the desktop body and log lines (no transcript content ever reaches a hit). */
export function describeDestination(d: AlertDestination): string {
  return d.type === "webhook" ? `webhook ${webhookOrigin(d.url)}` : "desktop";
}

export function createAlertDispatcher(opts: AlertDispatcherOptions): AlertDispatcher {
  const hooks = new Map<string, EventWebhook>();
  const log = opts.log ?? ((line: string) => void process.stderr.write(line));
  return {
    deliver(rule, hit) {
      for (const d of rule.destinations) {
        try {
          if (d.type === "webhook") {
            let hook = hooks.get(d.url);
            if (hook === undefined) {
              hook = opts.webhookFor(d.url);
              hooks.set(d.url, hook);
            }
            hook.post(hit.runId, ALERT_WEBHOOK_EVENT, alertPayload(hit), hit.at);
          } else {
            const extra = hit.suppressedSinceLastFire > 0 ? ` (+${hit.suppressedSinceLastFire} suppressed)` : "";
            opts.notify(`ach alert: ${hit.rule}`, `${hit.message}${extra}`, { sound: d.sound === true });
          }
        } catch (e) {
          // fail open: one broken destination never stops the others or the caller
          log(`[warn] alerts: ${hit.rule}: ${describeDestination(d)} failed (${e instanceof Error ? e.message : String(e)})\n`);
        }
      }
    },
    async flush() {
      await Promise.all([...hooks.values()].map((h) => h.flush().catch(() => undefined)));
    },
  };
}
