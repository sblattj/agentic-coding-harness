// Budget-threshold alerts and near-limit warnings (#20): warn WITHOUT aborting.
//
// One crossing engine serves both families:
//   - budget alerts   : fractions of RunBudget.usd       (metric 'usd')
//   - near-limit warns: fractions of maxTurns / wallMs    (metrics 'turns' | 'wall')
//
// A threshold t fires for a source when the observed fraction CROSSES it
// (prev < t <= cur — edge-triggered, never "while above") AND the last time
// that (source, t) fired is at least `cooldownMs` ago. The cooldown state is
// persisted in <stateDir>/alerts.json so a second process (a dash refresh, the
// next watch tick, a retried run with the same runId) does not re-announce a
// threshold inside the cooldown. Deleting the file re-arms every warning.
//
// The engine NEVER aborts anything: enforcement is the driver's separate,
// explicit cap (RunBudget.onExceed).
import fs from "node:fs";
import path from "node:path";
import { HarnessError } from "./types.ts";

export type AlertFamily = "budget" | "near-limit";
export type AlertMetric = "usd" | "turns" | "wall";

/** Default cooldown between re-announcements of one (source, threshold). */
export const DEFAULT_COOLDOWN_MS = 24 * 3_600_000;

/** Env knob for the cooldown, in HOURS (fractional allowed). */
export const COOLDOWN_ENV = "AGENTIC_CODING_HARNESS_WARN_COOLDOWN_H";

/** Persisted alert state: `fired[key]` = epoch ms the key last fired. */
export interface AlertState {
  version: 1;
  fired: Record<string, number>;
}

export function freshAlertState(): AlertState {
  return { version: 1, fired: {} };
}

/** `<stateDir>/alerts.json` — documented in docs/BUDGET-ALERTS.md. */
export function alertStateFile(stateDir: string): string {
  return path.join(stateDir, "alerts.json");
}

function isAlertState(v: unknown): v is AlertState {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  if (o.version !== 1) return false;
  if (typeof o.fired !== "object" || o.fired === null || Array.isArray(o.fired)) return false;
  return Object.values(o.fired as Record<string, unknown>).every((t) => typeof t === "number" && Number.isFinite(t));
}

/**
 * Read the state file. Missing -> fresh state, no warning. Unreadable,
 * unparseable or wrong-shaped -> fresh state PLUS a warning; never throws, so
 * a corrupt file can never crash a run or a dashboard.
 */
export function loadAlertState(file: string): { state: AlertState; warning?: string } {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { state: freshAlertState() };
    return { state: freshAlertState(), warning: `alerts: state file ${file} unreadable (${(err as Error).message}); starting fresh` };
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (err) {
    return { state: freshAlertState(), warning: `alerts: state file ${file} unreadable (${(err as Error).message}); starting fresh` };
  }
  if (!isAlertState(json)) {
    return { state: freshAlertState(), warning: `alerts: state file ${file} unreadable (unexpected shape); starting fresh` };
  }
  return { state: { version: 1, fired: { ...json.fired } } };
}

/** Atomic write (tmp + rename), same pattern as writeRunRecord. Throws on I/O failure. */
export function saveAlertState(file: string, state: AlertState): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, file);
}

/**
 * Validate threshold fractions: each must be a finite number in (0, 1].
 * Returns them sorted ascending and de-duplicated; throws a USAGE
 * HarnessError naming `label` otherwise (a percent like 85 gets a hint).
 */
export function validateThresholds(values: readonly number[], label: string): number[] {
  for (const v of values) {
    if (!Number.isFinite(v) || v <= 0 || v > 1) {
      const hint = Number.isFinite(v) && v > 1 && v <= 100 ? ` (write ${v / 100} for ${v}%)` : "";
      throw new HarnessError(`${label}: threshold '${v}' is not a fraction in (0, 1]${hint}`, "USAGE");
    }
  }
  return [...new Set(values)].sort((a, b) => a - b);
}

/**
 * Parse a comma-separated threshold list ("0.5,0.8,0.95"). 'off' / 'none'
 * (or the empty string) disable the family and return [].
 */
export function parseThresholds(raw: string, label: string): number[] {
  const trimmed = raw.trim();
  if (trimmed === "" || trimmed === "off" || trimmed === "none") return [];
  const values = trimmed.split(",").map((part) => {
    const s = part.trim();
    const n = s === "" ? Number.NaN : Number(s);
    if (!Number.isFinite(n)) {
      throw new HarnessError(`${label}: threshold '${s}' is not a number (expected fractions like 0.5,0.8,0.95)`, "USAGE");
    }
    return n;
  });
  return validateThresholds(values, label);
}

/** Cooldown from AGENTIC_CODING_HARNESS_WARN_COOLDOWN_H (hours); default 24h. */
export function cooldownMsFromEnv(env: Record<string, string | undefined>): number {
  const raw = env[COOLDOWN_ENV];
  if (raw === undefined || raw.trim() === "") return DEFAULT_COOLDOWN_MS;
  const h = Number(raw);
  if (!Number.isFinite(h) || h < 0) {
    throw new HarnessError(`${COOLDOWN_ENV} expects a non-negative number of hours, got '${raw}'`, "USAGE");
  }
  return Math.round(h * 3_600_000);
}

export interface ThresholdAlerterOptions {
  thresholds: readonly number[];
  cooldownMs: number;
  /** Mutable persisted state; the alerter records fire times into it. */
  state: AlertState;
  /** Injected clock (tests); defaults to Date.now. */
  now?: () => number;
}

/** Edge-triggered, cooldown-gated threshold crossing engine. Pure except for `state`. */
export class ThresholdAlerter {
  readonly state: AlertState;
  readonly #thresholds: number[];
  readonly #cooldownMs: number;
  readonly #now: () => number;
  /** Last observed fraction per source (in-memory; a new process starts at 0). */
  readonly #prev = new Map<string, number>();

  constructor(opts: ThresholdAlerterOptions) {
    this.#thresholds = [...new Set(opts.thresholds)].sort((a, b) => a - b);
    this.#cooldownMs = opts.cooldownMs;
    this.state = opts.state;
    this.#now = opts.now ?? Date.now;
  }

  static key(source: string, threshold: number): string {
    return `${source}|${threshold}`;
  }

  /**
   * Observe the current fraction for `source`; returns the thresholds that
   * fire NOW (ascending). NaN / non-finite fractions are ignored (a number the
   * harness cannot know never triggers an alert).
   */
  observe(source: string, fraction: number): number[] {
    if (!Number.isFinite(fraction)) return [];
    const prev = this.#prev.get(source) ?? 0;
    this.#prev.set(source, fraction);
    const now = this.#now();
    const fired: number[] = [];
    for (const t of this.#thresholds) {
      if (!(prev < t && fraction >= t)) continue;
      const key = ThresholdAlerter.key(source, t);
      const last = this.state.fired[key];
      if (last !== undefined && now - last < this.#cooldownMs) continue;
      this.state.fired[key] = now;
      fired.push(t);
    }
    return fired;
  }
}

/** A fired crossing, ready to become a `budget.alert` event / RunRecord.alerts row. */
export interface FiredAlert {
  at: number;
  family: AlertFamily;
  metric: AlertMetric;
  threshold: number;
  value: number;
  limit: number;
}

export interface RunAlertsOptions {
  runId: string;
  stateDir: string;
  usd?: number;
  maxTurns?: number;
  wallMs?: number;
  /** Fractions of `usd` (budget family). */
  alerts?: readonly number[];
  /** Fractions of `maxTurns` / `wallMs` (near-limit family). */
  warnAt?: readonly number[];
  cooldownMs?: number;
  /** Load / save problems land here (run warnings); never thrown. */
  onWarning: (w: string) => void;
  now?: () => number;
}

export interface RunAlerts {
  observe(metric: AlertMetric, value: number): FiredAlert[];
}

/**
 * Per-run wiring used by the driver: one alerter per family, the run id as
 * the source key (`run:<runId>:<metric>`), and the persisted state file under
 * the driver's stateDir. Returns null when nothing is configured, so an
 * alert-less run never touches alerts.json.
 */
export function createRunAlerts(opts: RunAlertsOptions): RunAlerts | null {
  const limits: Record<AlertMetric, number | undefined> = { usd: opts.usd, turns: opts.maxTurns, wall: opts.wallMs };
  const budgetT = opts.usd !== undefined ? (opts.alerts ?? []) : [];
  const nearT = opts.maxTurns !== undefined || opts.wallMs !== undefined ? (opts.warnAt ?? []) : [];
  if (budgetT.length === 0 && nearT.length === 0) return null;

  const file = alertStateFile(opts.stateDir);
  const loaded = loadAlertState(file);
  if (loaded.warning !== undefined) opts.onWarning(loaded.warning);
  const cooldownMs = opts.cooldownMs ?? DEFAULT_COOLDOWN_MS;
  const now = opts.now ?? Date.now;
  const budget = new ThresholdAlerter({ thresholds: budgetT, cooldownMs, state: loaded.state, now });
  const near = new ThresholdAlerter({ thresholds: nearT, cooldownMs, state: loaded.state, now });
  let saveWarned = false;

  return {
    observe(metric, value) {
      const limit = limits[metric];
      if (limit === undefined || !(limit > 0)) return [];
      const family: AlertFamily = metric === "usd" ? "budget" : "near-limit";
      const engine = family === "budget" ? budget : near;
      const fired = engine.observe(`run:${opts.runId}:${metric}`, value / limit);
      if (fired.length === 0) return [];
      try {
        saveAlertState(file, loaded.state);
      } catch (err) {
        if (!saveWarned) {
          saveWarned = true;
          opts.onWarning(`alerts: could not persist ${file} (${err instanceof Error ? err.message : String(err)})`);
        }
      }
      const at = now();
      return fired.map((threshold) => ({ at, family, metric, threshold, value, limit }));
    },
  };
}

/** Human line for a fired alert (event `data`, stderr, dash banner). */
export function describeAlert(a: {
  metric: AlertMetric;
  threshold: number;
  value: number;
  limit: number;
}): string {
  const pct = `${Math.round(a.threshold * 100)}%`;
  switch (a.metric) {
    case "usd":
      return `usd ${pct} ($${a.value.toFixed(4)} of $${a.limit.toFixed(4)})`;
    case "turns":
      return `turns ${pct} (${a.value} of ${a.limit})`;
    case "wall":
      return `wall ${pct} (${Math.round(a.value / 1000)}s of ${Math.round(a.limit / 1000)}s)`;
  }
}
