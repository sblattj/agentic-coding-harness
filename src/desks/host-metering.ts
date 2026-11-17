// Run registry + token records + budget for one desk host (#204). Owner: metering seat.
//
// One HostMeter per desk/lane host. It writes:
//   - the run's registry record  <stateDir>/runs/<runId>.json  (src/core/registry.ts),
//   - one canonical token record per usage sample under
//     <stateDir>/raw/<agent>/<session>.jsonl (the layout `ach stats` already reads), and
//   - budget alerts into RunRecord.alerts via the existing createRunAlerts engine.
//
// Repeated messageId: opencode re-reports a message's growing totals. We keep the
// LAST sample per messageId in memory and append only the DELTA (new - old, clamped at
// 0 per field) to the raw file. Stats sums raw lines, so the sum of deltas equals the
// latest total: idempotent for stats without any special casing. The in-memory map
// resets if the host process restarts; a restarted host's messages get new ids, so
// no double count arises in practice.
import fs from "node:fs";
import path from "node:path";
import { createRunAlerts, describeAlert, type RunAlerts } from "../core/budget-alerts.ts";
import { parseNotifyConfig, sendNotification } from "../core/notify.ts";
import { createPricer, type Pricer } from "../core/pricing.ts";
import { patchRunRecord, readRunRecord, writeRunRecord, type RunAlert, type RunRecord } from "../core/registry.ts";
import { sanitizeSession } from "../core/store.ts";
import type { CanonicalTokenRecord } from "../core/types.ts";
import type { HostSpec, HostState } from "./types.ts";

export interface UsageSample {
  model?: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Engine-reported cost; null/0 from an unpriced provider -> computed by the ach pricer when the model is known. */
  costUsd: number | null;
  /** Engine message id; a repeated id replaces (not adds to) the earlier sample. */
  messageId?: string;
  at: number;
  /**
   * True when the engine's own child run already wrote token records for this usage
   * (driver engine: each turn is a core-driver run). The meter still counts it toward
   * totals and budget but writes no raw line, so `ach stats` never counts it twice.
   */
  recorded?: boolean;
}

export interface HostMeter {
  /** Writes the RunRecord (status running, desk info, parentRunId, cwd, agent, sessionId). */
  begin(o: { sessionId?: string; pid: number }): void;
  usage(s: UsageSample): void;
  /** updatedAt heartbeat + lastEvent preview. */
  heartbeat(state: HostState, lastEvent?: string): void;
  /** Budget check: true when spec.budgetUsd is set and the run's cost crossed it (an alert is recorded once). */
  overBudget(): boolean;
  finish(status: "success" | "error" | "aborted"): void;
  totals(): { costUsd: number | null; inputTokens: number; outputTokens: number };
}

/** Optional injection points (tests); production passes nothing. */
export interface HostMeterOptions {
  now?: () => number;
  pricer?: Pricer;
  onWarning?: (w: string) => void;
}

/** Minimum gap between RunRecord totals patches (finish always patches). */
export const TOTALS_THROTTLE_MS = 2000;
/** Max chars of the lastEvent preview. */
export const LAST_EVENT_MAX = 200;

interface MessageState {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Engine-reported cost when > 0, else null. */
  reported: number | null;
  /** Pricer cost when the engine reported none and the model is known, else null. */
  computed: number | null;
}

const d = (next: number, prev: number): number => Math.max(0, next - prev);

export function createHostMeter(spec: HostSpec, opts: HostMeterOptions = {}): HostMeter {
  const now = opts.now ?? Date.now;
  const warn = opts.onWarning ?? (() => {});
  let pricer: Pricer | null = opts.pricer ?? null;
  const getPricer = (): Pricer => (pricer ??= createPricer());

  const stateDir = spec.stateDir;
  const runId = spec.runId;
  const desk = { stack: spec.stack, name: spec.name, kind: spec.kind } as const;

  let sessionId: string | undefined;
  let begun = false;
  let anon = 0;
  const messages = new Map<string, MessageState>();
  let lastModel: string | undefined;
  let lastTotalsWrite = Number.NEGATIVE_INFINITY;
  let dirty = false;
  let budgetCrossed = false;
  let notified = false;

  const runAlerts: RunAlerts | null =
    spec.budgetUsd !== undefined && spec.budgetUsd > 0
      ? createRunAlerts({ runId, stateDir, usd: spec.budgetUsd, alerts: [1], onWarning: warn, now })
      : null;

  const priceTokens = (model: string | undefined, t: Pick<MessageState, "inputTokens" | "outputTokens" | "cacheReadTokens" | "cacheWriteTokens">): number | null => {
    if (!model || model === "unknown") return null;
    const rec: CanonicalTokenRecord = { model, ...t };
    const p = getPricer();
    const c = p.price(rec, { computedOnly: true });
    for (const w of p.drainWarnings()) warn(w);
    return Number.isFinite(c) ? c : null;
  };

  const effective = (m: MessageState): number | null => m.reported ?? m.computed;

  const sums = () => {
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheReadTokens = 0;
    let cacheWriteTokens = 0;
    let cost = 0;
    let anyCost = false;
    let anyReported = false;
    let anyComputed = false;
    for (const m of messages.values()) {
      inputTokens += m.inputTokens;
      outputTokens += m.outputTokens;
      cacheReadTokens += m.cacheReadTokens;
      cacheWriteTokens += m.cacheWriteTokens;
      const e = effective(m);
      if (e !== null) {
        cost += e;
        anyCost = true;
        if (m.reported !== null) anyReported = true;
        else anyComputed = true;
      }
    }
    return { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, costUsd: anyCost ? cost : null, anyReported, anyComputed };
  };

  const totals = () => {
    const s = sums();
    return { costUsd: s.costUsd, inputTokens: s.inputTokens, outputTokens: s.outputTokens };
  };

  const writeTotals = (): void => {
    const s = sums();
    const patch: Partial<RunRecord> = {
      totals: {
        inputTokens: s.inputTokens,
        outputTokens: s.outputTokens,
        cacheReadTokens: s.cacheReadTokens,
        cacheWriteTokens: s.cacheWriteTokens,
        // RunRecord.totals.costUsd is a required number; null (nothing priceable) is written as 0
        // exactly like a driver run with no priced usage. totals() still returns null.
        costUsd: s.costUsd ?? 0,
        ...(s.costUsd === null && s.inputTokens + s.outputTokens + s.cacheReadTokens + s.cacheWriteTokens > 0 ? { costUnpriced: true } : {}),
        ...(s.anyReported !== s.anyComputed ? { costSource: s.anyReported ? ("reported" as const) : ("computed" as const) } : {}),
      },
      updatedAt: now(),
    };
    patchRunRecord(stateDir, runId, patch);
    lastTotalsWrite = now();
    dirty = false;
  };

  const maybeWriteTotals = (): void => {
    if (!dirty) return;
    if (now() - lastTotalsWrite >= TOTALS_THROTTLE_MS) writeTotals();
  };

  const rawFile = (): string => path.join(stateDir, "raw", spec.agent, `${sanitizeSession(sessionId ?? runId)}.jsonl`);

  const checkBudget = (): void => {
    if (spec.budgetUsd === undefined || spec.budgetUsd <= 0) return;
    const cost = sums().costUsd;
    if (cost === null) return;
    if (cost >= spec.budgetUsd) budgetCrossed = true;
    if (runAlerts === null) return;
    const fired = runAlerts.observe("usd", cost);
    if (fired.length === 0) return;
    const rows: RunAlert[] = fired.map((a) => ({ at: a.at, family: a.family, metric: a.metric, threshold: a.threshold, value: a.value, limit: a.limit }));
    const cur = readRunRecord(stateDir, runId);
    patchRunRecord(stateDir, runId, {
      alerts: [...(cur?.alerts ?? []), ...rows],
      lastEvent: `budget.alert ${describeAlert(fired[0]!)}`.slice(0, LAST_EVENT_MAX),
    });
    if (!notified) {
      notified = true;
      try {
        if (parseNotifyConfig(process.env).events.has("budget")) {
          sendNotification(`ach desk ${spec.name}`, `budget alert: ${describeAlert(fired[0]!)}`);
        }
      } catch {
        // best effort
      }
    }
  };

  return {
    begin(o) {
      if (begun) {
        // The host calls begin twice: once before engine.start ({pid}) and once
        // when the session exists ({sessionId, pid}). The second call only fills
        // in the session; it never resets startedAt or totals.
        if (o.sessionId !== undefined && o.sessionId !== sessionId) {
          sessionId = o.sessionId;
          patchRunRecord(stateDir, runId, { sessionId: o.sessionId, pid: o.pid, updatedAt: now() });
        }
        return;
      }
      sessionId = o.sessionId;
      begun = true;
      const t = now();
      const rec: RunRecord = {
        runId,
        agent: spec.agent,
        ...(o.sessionId !== undefined ? { sessionId: o.sessionId } : {}),
        pid: o.pid,
        cwd: spec.cwd,
        ...(spec.parentRunId !== undefined ? { parentRunId: spec.parentRunId } : {}),
        desk: { ...desk },
        startedAt: t,
        updatedAt: t,
        status: "running",
        source: "local",
        producer: "ach-desk-host",
        totals: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 },
        ...(spec.model !== undefined ? { metadata: { model: spec.model, hostState: "starting" } } : { metadata: { hostState: "starting" } }),
      };
      writeRunRecord(stateDir, rec);
      lastTotalsWrite = t;
    },

    usage(s) {
      const model = s.model ?? spec.model;
      if (model !== undefined) lastModel = model;
      const key = s.messageId ?? `anon-${anon++}`;
      const prev = messages.get(key);
      const reported = typeof s.costUsd === "number" && Number.isFinite(s.costUsd) && s.costUsd > 0 ? s.costUsd : null;
      const next: MessageState = {
        inputTokens: s.inputTokens,
        outputTokens: s.outputTokens,
        cacheReadTokens: s.cacheReadTokens,
        cacheWriteTokens: s.cacheWriteTokens,
        reported,
        computed: reported === null ? priceTokens(model, s) : null,
      };
      const delta = {
        inputTokens: d(next.inputTokens, prev?.inputTokens ?? 0),
        outputTokens: d(next.outputTokens, prev?.outputTokens ?? 0),
        cacheReadTokens: d(next.cacheReadTokens, prev?.cacheReadTokens ?? 0),
        cacheWriteTokens: d(next.cacheWriteTokens, prev?.cacheWriteTokens ?? 0),
      };
      messages.set(key, next);
      const deltaReported = reported === null ? null : d(reported, prev?.reported ?? 0);
      const empty = delta.inputTokens + delta.outputTokens + delta.cacheReadTokens + delta.cacheWriteTokens === 0 && !(deltaReported && deltaReported > 0);
      if (!empty && s.recorded !== true) {
        const line = {
          ts: s.at,
          agent: spec.agent,
          sessionId: sessionId ?? runId,
          ...(model !== undefined ? { model } : {}),
          ...delta,
          reasoningTokens: 0,
          // Only an engine-REPORTED cost goes on the line; stats prices unreported lines itself
          // (auto cost mode), so desk usage needs no special casing and nothing is double priced.
          ...(deltaReported !== null && deltaReported > 0 ? { costUsd: deltaReported } : {}),
          extra: { source: "desk-host", runId, desk, ...(s.messageId !== undefined ? { messageId: s.messageId } : {}) },
        };
        try {
          const f = rawFile();
          fs.mkdirSync(path.dirname(f), { recursive: true });
          fs.appendFileSync(f, JSON.stringify(line) + "\n");
        } catch (err) {
          warn(`desk metering: could not append token record (${err instanceof Error ? err.message : String(err)})`);
        }
      }
      dirty = true;
      checkBudget();
      maybeWriteTotals();
    },

    heartbeat(state, lastEvent) {
      const cur = readRunRecord(stateDir, runId);
      const patch: Partial<RunRecord> = {
        updatedAt: now(),
        metadata: { ...(cur?.metadata ?? {}), hostState: state, ...(lastModel !== undefined ? { model: lastModel } : {}) },
        ...(lastEvent !== undefined ? { lastEvent: lastEvent.slice(0, LAST_EVENT_MAX) } : {}),
      };
      patchRunRecord(stateDir, runId, patch);
      maybeWriteTotals();
    },

    overBudget() {
      return budgetCrossed;
    },

    finish(status) {
      if (!begun) return;
      writeTotals();
      const cur = readRunRecord(stateDir, runId);
      patchRunRecord(stateDir, runId, {
        status,
        exitStatus: status,
        endedAt: now(),
        updatedAt: now(),
        metadata: { ...(cur?.metadata ?? {}), hostState: "stopping" },
      });
    },

    totals,
  };
}
