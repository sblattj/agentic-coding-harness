// Pure-string sparklines over existing aggregates (issue #85). No dependencies.

const BLOCKS = "▁▂▃▄▅▆▇█";

export interface SparkOptions {
  /** Render plain `min=<x> max=<y>` text instead of block characters. */
  ascii?: boolean;
  /** Formats min/max in ASCII mode. Default String. */
  fmt?: (n: number) => string;
}

const clean = (v: number): number => (Number.isFinite(v) && v > 0 ? v : 0);

export function sparkline(values: number[], opts: SparkOptions = {}): string {
  if (values.length === 0) return "";
  const vs = values.map(clean);
  const min = Math.min(...vs);
  const max = Math.max(...vs);
  if (opts.ascii) {
    const fmt = opts.fmt ?? String;
    return `min=${fmt(min)} max=${fmt(max)}`;
  }
  if (max === min) return (max === 0 ? BLOCKS[0]! : BLOCKS[3]!).repeat(vs.length);
  const top = BLOCKS.length - 1;
  return vs.map((v) => BLOCKS[Math.min(top, Math.max(0, Math.round(((v - min) / (max - min)) * top)))]!).join("");
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export interface DayBucket {
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
}

/**
 * Last n calendar days (day keys, YYYY-MM-DD) ending at `endKey` (inclusive), or at the
 * latest day in byDay when endKey is omitted. Days with no bucket are 0.
 */
export function lastNDays(byDay: Record<string, DayBucket>, n: number, metric: "cost" | "tokens", endKey?: string): number[] {
  if (n <= 0) return [];
  const keys = Object.keys(byDay).filter((k) => DAY_RE.test(k));
  const latest = endKey !== undefined && DAY_RE.test(endKey) ? endKey : keys.sort().at(-1);
  if (latest === undefined) return new Array<number>(n).fill(0);
  const end = Date.parse(`${latest}T00:00:00Z`);
  const out: number[] = [];
  for (let i = n - 1; i >= 0; i--) {
    const key = new Date(end - i * 86_400_000).toISOString().slice(0, 10);
    const b = byDay[key];
    out.push(b ? (metric === "cost" ? b.costUsd : b.inputTokens + b.outputTokens) : 0);
  }
  return out;
}

/** False only on TERM dumb/linux or an explicit non-UTF locale (first of LC_ALL, LC_CTYPE, LANG that is set). */
export function sparkSupported(env: Record<string, string | undefined> = process.env): boolean {
  if (env.TERM === "dumb" || env.TERM === "linux") return false;
  for (const k of ["LC_ALL", "LC_CTYPE", "LANG"]) {
    const v = env[k];
    if (v !== undefined && v !== "") return /utf-?8/i.test(v);
  }
  return true;
}
