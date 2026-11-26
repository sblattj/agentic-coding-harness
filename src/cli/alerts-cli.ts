// CLI glue for the alert rules engine (#74): config rules -> destinations,
// the live runner `ach watch` ticks, and `ach alerts` (list, --once,
// --dry-run). Rule semantics live in src/core/alert-rules.ts; docs/ALERTS.md.
import fs from "node:fs";
import { parseArgs } from "./config.ts";
import { loadedAlertRules } from "./config.ts";
import { HarnessError } from "../core/types.ts";
import { isLoopbackUrl } from "../core/offline.ts";
import { stateDir as defaultStateDir } from "../core/store.ts";
import { parseFramedLine } from "../core/hash-chain.ts";
import { resolveRawTranscript, scanRunRecords, skippedRunRecordsWarning, type RunRecord } from "../core/registry.ts";
import { sendNotification, type NotifyExec } from "../core/notify.ts";
import { ALERT_WEBHOOK_EVENT, createEventWebhook, EVENT_WEBHOOK_SECRET_ENV, webhookOrigin, type EventWebhook } from "../core/event-webhook.ts";
import { MASK_OPTIONS, type MaskFlags } from "../core/masking.ts";
import { PRIVACY_OPTIONS } from "../core/privacy.ts";
import { maskPolicyFor, notePrivacy } from "./mask-cli.ts";
import {
  alertRulesStateFile,
  createAlertDispatcher,
  DEFAULT_ALERT_COOLDOWN_SEC,
  describeDestination,
  evaluateAlertRules,
  loadAlertRulesState,
  replayAlertHistory,
  saveAlertRulesState,
  type AlertDecision,
  type AlertDispatcher,
  type AlertNotifier,
  type AlertRule,
} from "../core/alert-rules.ts";

export interface AlertRunnerOptions {
  rules: readonly AlertRule[];
  stateDir: string;
  /** --mask / --privacy flags for the webhook sink. */
  flags?: MaskFlags;
  offline?: boolean;
  env?: NodeJS.ProcessEnv;
  log?: (line: string) => void;
  /** Injected for tests (production: the #64 delivery and the #63 notifier). */
  webhookFor?: (url: string) => EventWebhook;
  notify?: AlertNotifier;
  /** Injected for tests: desktop platform and launcher. */
  platform?: NodeJS.Platform;
  exec?: NotifyExec;
  pidAlive?: (pid: number) => boolean;
}

export interface AlertRunner {
  readonly rules: readonly AlertRule[];
  /** Evaluate the registry snapshot once, persist state, deliver new hits. Never throws. */
  tick(now?: number): AlertDecision[];
  flush(): Promise<void>;
}

/** Refuse a non-loopback alert webhook under --offline, the same USAGE error #64 raises. */
export function checkOfflineAlertRules(rules: readonly AlertRule[]): void {
  for (const r of rules) {
    for (const d of r.destinations) {
      if (d.type === "webhook" && !isLoopbackUrl(d.url)) {
        throw new HarnessError(`--offline refuses a non-loopback webhook (${webhookOrigin(d.url)}) in alert rule '${r.name}'; drop one of them`, "USAGE");
      }
    }
  }
}

function dispatcherFor(opts: AlertRunnerOptions): AlertDispatcher {
  const env = opts.env ?? process.env;
  const log = opts.log ?? ((line: string) => void process.stderr.write(line));
  const secret = env[EVENT_WEBHOOK_SECRET_ENV];
  let noted = false;
  const webhookFor =
    opts.webhookFor ??
    ((url: string): EventWebhook => {
      const mask = maskPolicyFor("webhook", opts.flags ?? {});
      if (!noted) {
        noted = true;
        notePrivacy(`alerts webhook ${webhookOrigin(url)}`, mask.privacy?.mode ?? "off");
      }
      return createEventWebhook({
        url,
        events: new Set([ALERT_WEBHOOK_EVENT]),
        mask,
        ...(secret !== undefined && secret !== "" ? { secret } : {}),
        log,
      });
    });
  const notify: AlertNotifier =
    opts.notify ??
    ((title, body, o) =>
      sendNotification(title, body, {
        sound: o.sound,
        ...(opts.platform !== undefined ? { platform: opts.platform } : {}),
        ...(opts.exec !== undefined ? { exec: opts.exec } : {}),
      }));
  return createAlertDispatcher({ webhookFor, notify, log });
}

const hitLine = (rule: AlertRule, d: AlertDecision): string => {
  const where = rule.destinations.map(describeDestination).join(", ");
  const extra = d.hit.suppressedSinceLastFire > 0 ? ` (+${d.hit.suppressedSinceLastFire} suppressed since the last hit)` : "";
  return d.suppressed
    ? `alert: ${d.hit.rule} suppressed by its ${rule.cooldownSec ?? DEFAULT_ALERT_COOLDOWN_SEC}s cooldown: ${d.hit.message}\n`
    : `alert: ${d.hit.rule} fired: ${d.hit.message}${extra} -> ${where}\n`;
};

/** The live runner: one `tick` per `ach watch` poll, or one for `ach alerts --once`. */
export function createAlertRunner(opts: AlertRunnerOptions): AlertRunner {
  if (opts.offline === true) checkOfflineAlertRules(opts.rules);
  const log = opts.log ?? ((line: string) => void process.stderr.write(line));
  const dispatcher = dispatcherFor(opts);
  const file = alertRulesStateFile(opts.stateDir);
  const byName = new Map(opts.rules.map((r) => [r.name, r]));
  let warnedState = false;
  return {
    rules: opts.rules,
    tick(now = Date.now()) {
      try {
        const { state, warning } = loadAlertRulesState(file);
        if (warning !== undefined && !warnedState) {
          warnedState = true;
          log(`[warn] ${warning}\n`);
        }
        const { records } = scanRunRecords(opts.stateDir);
        const decisions = evaluateAlertRules({ rules: opts.rules, records, state, now, ...(opts.pidAlive !== undefined ? { pidAlive: opts.pidAlive } : {}) });
        if (decisions.length > 0 || Object.keys(state.rules).length > 0) {
          try {
            saveAlertRulesState(file, state);
          } catch (e) {
            log(`[warn] alerts: could not save ${file} (${e instanceof Error ? e.message : String(e)}); an episode may be announced again\n`);
          }
        }
        for (const d of decisions) {
          const rule = byName.get(d.hit.rule)!;
          log(hitLine(rule, d));
          if (!d.suppressed) dispatcher.deliver(rule, d.hit);
        }
        return decisions;
      } catch (e) {
        log(`[warn] alerts: evaluation failed (${e instanceof Error ? e.message : String(e)}); will retry next tick\n`);
        return [];
      }
    },
    flush: () => dispatcher.flush(),
  };
}

/** Event timestamps (ms) of one run from its raw transcript; [] when unreadable. */
export function transcriptEventTimes(stateDir: string, rec: RunRecord): number[] {
  const file = resolveRawTranscript(stateDir, rec);
  if (file === "") return [];
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const out: number[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    const framed = parseFramedLine(line);
    // A session transcript can hold several runs: keep this run's chained lines.
    if (framed !== null && framed.run !== rec.runId) continue;
    let ev: unknown;
    try {
      ev = JSON.parse(framed?.body ?? line);
    } catch {
      continue;
    }
    const ts = (ev as { timestamp?: unknown }).timestamp;
    const ms = typeof ts === "number" ? ts : typeof ts === "string" ? Date.parse(ts) : NaN;
    if (Number.isFinite(ms)) out.push(ms);
  }
  return out;
}

const ruleSummary = (r: AlertRule): string => {
  const cond =
    r.type === "error_rate"
      ? [r.failures !== undefined ? `${r.failures} of the last ${r.window} runs failed` : undefined, r.consecutive !== undefined ? `${r.consecutive} consecutive failures` : undefined]
          .filter((x) => x !== undefined)
          .join(" or ")
      : `no event for ${r.idleSec}s while running`;
  const scope = r.agent !== undefined ? ` [agent ${r.agent}]` : "";
  return `${r.name}  ${r.type}  ${cond}${scope}  cooldown ${r.cooldownSec ?? DEFAULT_ALERT_COOLDOWN_SEC}s  -> ${r.destinations.map(describeDestination).join(", ")}`;
};

export interface CmdAlertsDeps {
  rules?: readonly AlertRule[];
  stateDir?: string;
  out?: (s: string) => void;
  err?: (s: string) => void;
  now?: number;
}

/**
 * `ach alerts [--dry-run | --once] [--json] [--offline]`.
 *   (no mode)  validate and list the configured rules
 *   --dry-run  replay the registry history; print what would have fired and when; sends nothing
 *   --once     evaluate the current snapshot once and deliver new hits (cron-friendly)
 * Exit 0 unless the flags or the rules are invalid: a failed destination never changes it.
 */
export async function cmdAlerts(rest: string[], deps: CmdAlertsDeps = {}): Promise<number> {
  const args = parseArgs({
    args: rest,
    options: {
      "dry-run": { type: "boolean", default: false },
      once: { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      offline: { type: "boolean", default: false },
      ...MASK_OPTIONS,
      ...PRIVACY_OPTIONS,
    },
    allowPositionals: false,
  });
  const out = deps.out ?? ((s: string) => void process.stdout.write(s));
  const err = deps.err ?? ((s: string) => void process.stderr.write(s));
  if (args.values["dry-run"] && args.values.once) throw new HarnessError("alerts: --dry-run and --once are exclusive (a dry run sends nothing)", "USAGE");
  const rules = deps.rules ?? loadedAlertRules();
  const state = deps.stateDir ?? defaultStateDir();
  const json = args.values.json === true;
  if (args.values.offline) checkOfflineAlertRules(rules);
  if (rules.length === 0) {
    if (json) out(JSON.stringify({ rules: [], hits: [] }) + "\n");
    else err("alerts: no rules configured (add an `alerts.rules` list to the config file; see docs/ALERTS.md)\n");
    return 0;
  }

  if (args.values["dry-run"]) {
    const scan = scanRunRecords(state);
    const warn = skippedRunRecordsWarning(state, scan.skipped);
    if (warn !== null) err(warn + "\n");
    const wantsIdle = rules.some((r) => r.type === "idle");
    const decisions = replayAlertHistory({
      rules,
      records: scan.records,
      eventTimes: (rec) => (wantsIdle ? transcriptEventTimes(state, rec) : []),
      ...(deps.now !== undefined ? { now: deps.now } : {}),
    });
    const counts = rules.map((r) => ({
      rule: r.name,
      type: r.type,
      wouldFire: decisions.filter((d) => d.hit.rule === r.name && !d.suppressed).length,
      suppressed: decisions.filter((d) => d.hit.rule === r.name && d.suppressed).length,
    }));
    // #72: below `full`, step/tool events are not recorded, so a gap is measured on what was kept.
    const partial = wantsIdle ? scan.records.filter((r) => r.captureMode !== undefined && r.captureMode !== "full").length : 0;
    if (json) {
      out(JSON.stringify({ dryRun: true, runs: scan.records.length, hits: decisions.map((d) => ({ ...d.hit, at: new Date(d.hit.at).toISOString(), suppressed: d.suppressed })), rules: counts, ...(partial > 0 ? { idleGapsFromPartialCapture: partial } : {}) }, null, 2) + "\n");
      return 0;
    }
    out(`alerts: dry run over ${scan.records.length} run${scan.records.length === 1 ? "" : "s"} (no destination is contacted, no state is written)\n`);
    const byName = new Map(rules.map((r) => [r.name, r]));
    for (const d of decisions) {
      const r = byName.get(d.hit.rule)!;
      const tail = d.suppressed ? `(suppressed: ${r.cooldownSec ?? DEFAULT_ALERT_COOLDOWN_SEC}s cooldown)` : `-> ${r.destinations.map(describeDestination).join(", ")}`;
      out(`${new Date(d.hit.at).toISOString()}  ${d.hit.rule}  ${d.hit.ruleType}  run ${d.hit.runId.slice(0, 8)}  ${d.hit.message}  ${tail}\n`);
    }
    for (const c of counts) out(`rule ${c.rule} (${c.type}): ${c.wouldFire} would fire${c.suppressed > 0 ? `, ${c.suppressed} suppressed by cooldown` : ""}\n`);
    if (partial > 0) out(`note: ${partial} run${partial === 1 ? "" : "s"} recorded below capture tier full; idle gaps there are measured on the kept events only (docs/CAPTURE.md)\n`);
    return 0;
  }

  if (args.values.once) {
    const runner = createAlertRunner({ rules, stateDir: state, flags: args.values, offline: args.values.offline === true, log: err });
    const decisions = runner.tick(deps.now);
    await runner.flush();
    if (json) out(JSON.stringify({ hits: decisions.map((d) => ({ ...d.hit, at: new Date(d.hit.at).toISOString(), suppressed: d.suppressed })) }, null, 2) + "\n");
    else if (decisions.length === 0) out("alerts: no rule fired\n");
    return 0;
  }

  if (json) out(JSON.stringify({ rules }, null, 2) + "\n");
  else {
    out(`alerts: ${rules.length} rule${rules.length === 1 ? "" : "s"} valid\n`);
    for (const r of rules) out(`${ruleSummary(r)}\n`);
  }
  return 0;
}
