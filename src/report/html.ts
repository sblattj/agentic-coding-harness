// Single-file HTML report renderer for `harness report`.
//
// Everything the browser needs — CSS, chart SVGs, sorting/show-more JS — is
// inlined; the output has zero external resources. All agent-derived text
// (names, models, event content) passes through esc() before embedding.
import fs from "node:fs/promises";
import type { LoadedRun, TrialSet } from "./model.ts";
import { VERSION } from "../version.ts";

const MESSAGE_CAP = 2000;
const TIMELINE_CAP = 500;

// ---------------------------------------------------------------- escaping

export function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ---------------------------------------------------------------- formats

function fmtInt(n: number): string {
  return n.toLocaleString("en-US");
}

function fmtCost(usd: number | undefined): string {
  if (usd === undefined) return "n/a";
  return `$${usd >= 1 ? usd.toFixed(2) : usd.toFixed(4)}`;
}

function toMs(t: unknown): number | null {
  if (typeof t === "number" && Number.isFinite(t)) return t;
  if (typeof t === "string") {
    const p = Date.parse(t);
    if (Number.isFinite(p)) return p;
  }
  return null;
}

function fmtOffset(ms: number | null, t0: number | null): string {
  if (ms === null || t0 === null) return "";
  const d = Math.max(0, ms - t0);
  if (d < 1000) return `${d}ms`;
  if (d < 60_000) return `${(d / 1000).toFixed(1)}s`;
  const m = Math.floor(d / 60_000);
  return `${m}m${Math.round((d % 60_000) / 1000)}s`;
}

function fmtDuration(run: LoadedRun): string {
  const ms =
    typeof run.result.durationMs === "number" && Number.isFinite(run.result.durationMs)
      ? run.result.durationMs
      : run.wallSecs !== null
        ? run.wallSecs * 1000
        : null;
  return ms === null ? "n/a" : fmtOffset(ms, 0).replace(/^0ms$/, "0s");
}

function clip(s: string, max: number): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > max ? one.slice(0, max - 1) + "…" : one;
}

// ---------------------------------------------------------------- timeline

function eventSummary(run: LoadedRun, e: Record<string, unknown>): string {
  const str = (v: unknown): string => (typeof v === "string" ? v : "");
  switch (e.type) {
    case "message": {
      const src = str(e.source) || str(e.role) || "?";
      const content = typeof e.content === "string" ? e.content : str(e.data);
      return `${src}: ${clip(content, 140)}`;
    }
    case "tool":
    case "tool_call": {
      const name = str(e.toolName) || str(e.functionName) || "?";
      return e.phase === "result" ? `${name} → result` : name;
    }
    case "tool_result":
      return `${str(e.toolCallId) || "tool"} ${e.isError ? "✗ error" : "→ result"}`;
    case "usage": {
      const u = (e.usage ?? {}) as Record<string, unknown>;
      const i = Number(u.inputTokens ?? 0);
      const o = Number(u.outputTokens ?? 0);
      return `in ${fmtInt(Number.isFinite(i) ? i : 0)} · out ${fmtInt(Number.isFinite(o) ? o : 0)}`;
    }
    case "progress":
      return clip(str(e.text) || str(e.data), 140);
    case "error":
      return clip(str(e.message) || str(e.data), 140);
    case "session":
      return str(e.sessionId) ? `id ${str(e.sessionId)}` : "";
    default:
      return clip(str(e.data), 100);
  }
}

function finalAssistantMessage(events: unknown[]): string | null {
  let last: string | null = null;
  for (const e of events) {
    if (typeof e !== "object" || e === null) continue;
    const o = e as Record<string, unknown>;
    if (o.type !== "message") continue;
    const src = o.source ?? o.role;
    if (src !== "agent" && src !== "assistant") continue;
    const content = typeof o.content === "string" ? o.content : "";
    if (content.trim()) last = content;
  }
  return last;
}

function renderTimeline(run: LoadedRun): string {
  const events = run.result.events as unknown[];
  if (events.length === 0) return `<p class="muted">no events</p>`;
  const times = events.map((e) =>
    toMs(typeof e === "object" && e !== null ? (e as Record<string, unknown>).timestamp : null),
  );
  const t0 = times.find((t) => t !== null) ?? null;
  const shown = events.slice(0, TIMELINE_CAP);
  const rows = shown
    .map((e, i) => {
      const o = (typeof e === "object" && e !== null ? e : {}) as Record<string, unknown>;
      const type = esc(String(o.type ?? "?"));
      const time = esc(fmtOffset(times[i] ?? null, t0));
      const summary = esc(eventSummary(run, o));
      return `        <tr><td class="t">${time}</td><td class="ty">${type}</td><td>${summary || '<span class="muted">—</span>'}</td></tr>`;
    })
    .join("\n");
  const more =
    events.length > TIMELINE_CAP
      ? `\n      <p class="muted">… ${fmtInt(events.length - TIMELINE_CAP)} more events not shown</p>`
      : "";
  return `    <table class="timeline">
      <thead><tr><th>time</th><th>type</th><th>summary</th></tr></thead>
      <tbody>
${rows}
      </tbody>
    </table>${more}`;
}

function renderFinalMessage(events: unknown[]): string {
  const msg = finalAssistantMessage(events);
  if (msg === null) return "";
  const full = esc(msg);
  if (full.length <= MESSAGE_CAP) {
    return `    <h4>final assistant message</h4>
    <pre class="msg">${full}</pre>`;
  }
  const head = full.slice(0, MESSAGE_CAP);
  const tail = full.slice(MESSAGE_CAP);
  return `    <h4>final assistant message</h4>
    <pre class="msg"><span class="msg-head">${head}</span><span class="msg-tail" hidden>${tail}</span><button type="button" class="show-more" data-target="msg-tail" data-label-more="show more (${fmtInt(msg.length - MESSAGE_CAP)} chars)" data-label-less="show less">show more (${fmtInt(msg.length - MESSAGE_CAP)} chars)</button></pre>`;
}

// ---------------------------------------------------------------- charts

interface BarClass {
  key: keyof Pick<
    LoadedRun,
    "inputTokens" | "outputTokens" | "cacheReadTokens" | "cacheWriteTokens" | "reasoningTokens"
  >;
  label: string;
  color: string;
}

const TOKEN_CLASSES: BarClass[] = [
  { key: "inputTokens", label: "input", color: "#7aa2f7" },
  { key: "outputTokens", label: "output", color: "#9ece6a" },
  { key: "cacheReadTokens", label: "cache read", color: "#e0af68" },
  { key: "cacheWriteTokens", label: "cache write", color: "#bb9af7" },
  { key: "reasoningTokens", label: "reasoning", color: "#f7768e" },
];

function niceMax(v: number): number {
  if (v <= 0) return 1;
  const pow = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 2.5, 5, 10]) {
    if (m * pow >= v) return m * pow;
  }
  return 10 * pow;
}

function fmtAxis(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(n % 1000 === 0 ? 0 : 1)}k`;
  return String(n);
}

/** Grouped token bars per agent + a cost-per-agent bar chart, both hand-rolled
 * SVG. Agents with no token data at all are skipped; an empty state renders
 * when nothing is chartable. */
function renderCharts(runs: LoadedRun[]): string {
  const withTokens = runs.filter((r) =>
    TOKEN_CLASSES.some((c) => r[c.key] > 0),
  );
  const tokenSvg = withTokens.length === 0 ? emptyChart("no token data") : tokenBarChart(withTokens);
  const costRuns = runs.filter((r) => r.costUsd !== undefined);
  const costSvg =
    costRuns.length === 0 ? emptyChart("no cost data") : costBarChart(costRuns);
  return `  <section class="charts">
    <div class="chart-card"><h3>tokens by class</h3>${tokenSvg}</div>
    <div class="chart-card"><h3>cost (USD)</h3>${costSvg}</div>
  </section>`;
}

function emptyChart(note: string): string {
  return `<div class="chart-empty">${esc(note)}</div>`;
}

const AXIS_LABELS = 4;

function tokenBarChart(runs: LoadedRun[]): string {
  const barW = 10;
  const barGap = 2;
  const groupGap = 18;
  const h = 180;
  const padL = 40;
  const padB = 34;
  const padT = 10;
  const plotH = h - padB - padT;
  const groups = runs.length;
  const groupW = TOKEN_CLASSES.length * (barW + barGap) - barGap;
  const w = padL + groups * groupW + (groups - 1) * groupGap + 10;
  const max = niceMax(Math.max(...runs.flatMap((r) => TOKEN_CLASSES.map((c) => r[c.key]))));
  const gridlines: string[] = [];
  for (let i = 0; i <= AXIS_LABELS; i++) {
    const y = padT + plotH - (plotH * i) / AXIS_LABELS;
    const v = (max * i) / AXIS_LABELS;
    gridlines.push(
      `    <line x1="${padL}" y1="${y.toFixed(1)}" x2="${w - 4}" y2="${y.toFixed(1)}" class="grid"/><text x="${padL - 6}" y="${(y + 3).toFixed(1)}" text-anchor="end" class="axis">${fmtAxis(v)}</text>`,
    );
  }
  let x = padL;
  const bars: string[] = [];
  const labels: string[] = [];
  for (const r of runs) {
    TOKEN_CLASSES.forEach((c, ci) => {
      const v = r[c.key];
      if (v <= 0) return;
      const bh = Math.max(1, (plotH * v) / max);
      const bx = x + ci * (barW + barGap);
      bars.push(
        `    <rect x="${bx}" y="${(padT + plotH - bh).toFixed(1)}" width="${barW}" height="${bh.toFixed(1)}" fill="${c.color}" rx="1"><title>${esc(r.agent)} ${c.label}: ${fmtInt(v)}</title></rect>`,
      );
    });
    labels.push(
      `    <text x="${(x + groupW / 2).toFixed(1)}" y="${h - 14}" text-anchor="middle" class="axis agent-label">${esc(r.agent)}</text>`,
    );
    x += groupW + groupGap;
  }
  const legend = TOKEN_CLASSES.map(
    (c) =>
      `<span class="legend-key"><span class="swatch" style="background:${c.color}"></span>${esc(c.label)}</span>`,
  ).join("");
  return `<div class="chart-wrap"><svg viewBox="0 0 ${w.toFixed(0)} ${h}" role="img" aria-label="tokens by class per agent" preserveAspectRatio="xMidYMid meet">
${gridlines.join("\n")}
${bars.join("\n")}
${labels.join("\n")}
  </svg><div class="legend">${legend}</div></div>`;
}

function costBarChart(runs: LoadedRun[]): string {
  const barW = 26;
  const gap = 16;
  const h = 180;
  const padL = 56;
  const padB = 34;
  const padT = 10;
  const plotH = h - padB - padT;
  const w = padL + runs.length * (barW + gap) - gap + 10;
  const maxVal = Math.max(...runs.map((r) => r.costUsd ?? 0));
  const max = niceMax(maxVal <= 0 ? 1 : maxVal);
  const gridlines: string[] = [];
  for (let i = 0; i <= AXIS_LABELS; i++) {
    const y = padT + plotH - (plotH * i) / AXIS_LABELS;
    const v = (max * i) / AXIS_LABELS;
    gridlines.push(
      `    <line x1="${padL}" y1="${y.toFixed(1)}" x2="${w - 4}" y2="${y.toFixed(1)}" class="grid"/><text x="${padL - 6}" y="${(y + 3).toFixed(1)}" text-anchor="end" class="axis">$${fmtAxis(v)}</text>`,
    );
  }
  const bars: string[] = [];
  const labels: string[] = [];
  runs.forEach((r, i) => {
    const v = r.costUsd ?? 0;
    const bh = Math.max(1, (plotH * v) / max);
    const bx = padL + i * (barW + gap);
    bars.push(
      `    <rect x="${bx}" y="${(padT + plotH - bh).toFixed(1)}" width="${barW}" height="${bh.toFixed(1)}" fill="#7dcfff" rx="2"><title>${esc(r.agent)}: ${fmtCost(r.costUsd)}</title></rect>`,
    );
    labels.push(
      `    <text x="${(bx + barW / 2).toFixed(1)}" y="${h - 14}" text-anchor="middle" class="axis agent-label">${esc(r.agent)}</text>`,
    );
  });
  return `<div class="chart-wrap"><svg viewBox="0 0 ${w.toFixed(0)} ${h}" role="img" aria-label="cost in USD per agent" preserveAspectRatio="xMidYMid meet">
${gridlines.join("\n")}
${bars.join("\n")}
${labels.join("\n")}
  </svg></div>`;
}

// ---------------------------------------------------------------- table

function statusBadge(s: string): string {
  return `<span class="badge st-${esc(s)}">${esc(s)}</span>`;
}

/** `n/a` cell — the honest rendering of an unknowable number (never `0`). */
const NA_CELL = `<td data-v="" class="num na">n/a</td>`;

/** DERIVED context occupancy, worded so it can't be mistaken for billed tokens. */
function contextCell(r: LoadedRun): string {
  const ctx = r.usage?.context;
  if (ctx?.available !== true || ctx.tokens === undefined) return NA_CELL;
  const pct = ctx.percentage === undefined ? "" : ` (${ctx.percentage.toFixed(1)}%)`;
  const title = ctx.windowSource === "assumed" ? " title=\"context window assumed, not reported\"" : "";
  return `<td data-v="${ctx.tokens}" class="num"${title}>ctx ≈ ${fmtInt(ctx.tokens)} tok${esc(pct)}</td>`;
}

function renderComparisonTable(runs: LoadedRun[], multiTrial: boolean): string {
  const showCredits = runs.some((r) => r.credits !== null);
  const showContext = runs.some((r) => r.usage?.context?.available === true);
  // Identity column (spec §6.3): when ANY run carries a variant label the
  // comparison groups by variant (matching the live /compare view's default
  // experiment×variant rollup); otherwise the historical by-agent column.
  // Both groupings render through this one table builder.
  const byVariant = runs.some((r) => r.variant !== undefined);
  const groupKey = byVariant ? "variant" : "agent";
  const head = [
    `<th data-k="${groupKey}" data-t="s">${groupKey}</th>`,
    ...(multiTrial ? [`<th data-k="trial" data-t="s">trial</th>`] : []),
    `<th data-k="model" data-t="s">model</th>`,
    `<th data-k="input" data-t="n" class="num">input</th>`,
    `<th data-k="output" data-t="n" class="num">output</th>`,
    `<th data-k="cacheread" data-t="n" class="num">cache read</th>`,
    `<th data-k="cachewrite" data-t="n" class="num">cache write</th>`,
    `<th data-k="reasoning" data-t="n" class="num">reasoning</th>`,
    `<th data-k="cost" data-t="n" class="num">cost USD</th>`,
    ...(showCredits ? [`<th data-k="credits" data-t="n" class="num">credits</th>`] : []),
    ...(showContext ? [`<th data-k="context" data-t="n" class="num">context</th>`] : []),
    `<th data-k="dur" data-t="n" class="num">duration</th>`,
    `<th data-k="exit" data-t="s">exit status</th>`,
  ].join("");
  const rows = runs
    .map((r) => {
      // `usage.usd.available === false` is a positive claim that no price is
      // derivable (kiro: credits only) — never print $0.0000 for it.
      const costCell =
        r.usdUnavailable || r.costUsd === undefined
          ? NA_CELL
          : `<td data-v="${r.costUsd}" class="num">${esc(fmtCost(r.costUsd))}</td>`;
      const tokenCell = (v: number): string =>
        r.tokensUnavailable ? NA_CELL : `<td data-v="${v}" class="num">${fmtInt(v)}</td>`;
      const cells = [
        byVariant
          ? `<td data-v="${esc(r.variant ?? "")}" class="agent-cell">${r.variant ? esc(r.variant) : '<span class="muted">—</span>'}</td>`
          : `<td data-v="${esc(r.agent)}" class="agent-cell">${esc(r.agent)}</td>`,
        ...(multiTrial ? [`<td data-v="${esc(r.trialLabel)}">${esc(r.trialLabel)}</td>`] : []),
        `<td data-v="${esc(r.model ?? "")}">${r.model ? esc(r.model) : '<span class="muted">—</span>'}</td>`,
        tokenCell(r.inputTokens),
        tokenCell(r.outputTokens),
        tokenCell(r.cacheReadTokens),
        tokenCell(r.cacheWriteTokens),
        tokenCell(r.reasoningTokens),
        costCell,
        ...(showCredits
          ? [
              r.credits === null
                ? NA_CELL
                : `<td data-v="${r.credits}" class="num">${fmtInt(r.credits)}</td>`,
            ]
          : []),
        ...(showContext ? [contextCell(r)] : []),
        `<td data-v="${esc(fmtDuration(r))}" class="num">${esc(fmtDuration(r))}</td>`,
        `<td data-v="${esc(r.result.exitStatus ?? "unknown")}">${statusBadge(r.result.exitStatus ?? "unknown")}</td>`,
      ];
      return `      <tr data-agent="${esc(r.agent)}" data-trial="${esc(r.trialLabel)}">${cells.join("")}</tr>`;
    })
    .join("\n");
  return `  <table class="cmp sortable" id="comparison">
    <thead><tr>${head}</tr></thead>
    <tbody>
${rows}
    </tbody>
  </table>`;
}

// ---------------------------------------------------------------- sections

function renderAgentSection(r: LoadedRun): string {
  const events = r.result.events as unknown[];
  const warnings = (Array.isArray(r.result.warnings) ? r.result.warnings : [])
    .filter((w) => typeof w === "string" && w !== "")
    .map((w) => `      <li>${esc(w)}</li>`)
    .join("\n");
  const warnBlock =
    warnings === ""
      ? ""
      : `    <h4>warnings</h4>\n    <ul class="warnings">\n${warnings}\n    </ul>`;
  const meta = [
    `session <code>${esc(r.result.sessionId ?? "?")}</code>`,
    r.model ? `model <code>${esc(r.model)}</code>` : null,
    r.wallSecs !== null ? `wall ${r.wallSecs}s` : null,
    r.hasStderr ? "stderr captured" : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return `  <details class="agent-sec" data-agent="${esc(r.agent)}" data-trial="${esc(r.trialLabel)}">
    <summary>${esc(r.agent)} <span class="muted">· ${esc(r.trialLabel)}</span> ${statusBadge(r.result.exitStatus ?? "unknown")}</summary>
    <div class="sec-meta">${meta}</div>
${renderTimeline(r)}
${renderFinalMessage(events)}
${warnBlock}
  </details>`;
}

// ---------------------------------------------------------------- page

const CSS = `
:root { color-scheme: dark; }
* { box-sizing: border-box; }
body { margin: 0; padding: 32px 24px 48px; background: #16161e; color: #c0caf5;
  font: 15px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 1080px; margin: 0 auto; }
h1 { margin: 0 0 4px; font-size: 26px; color: #e6e6ef; letter-spacing: -0.02em; }
h3 { margin: 0 0 12px; font-size: 14px; color: #9aa5ce; text-transform: uppercase; letter-spacing: 0.08em; }
h4 { margin: 18px 0 6px; font-size: 12px; color: #9aa5ce; text-transform: uppercase; letter-spacing: 0.08em; }
.meta { color: #9aa5ce; margin: 0 0 28px; font-size: 13px; }
.meta .sep { margin: 0 8px; color: #565f89; }
.chips { display: flex; flex-wrap: wrap; gap: 8px; margin: 14px 0 0; }
.chip { background: #1f2335; border: 1px solid #2f334d; border-radius: 999px;
  padding: 3px 12px; font-size: 12px; color: #a9b1d6; }
.chip b { color: #e6e6ef; font-weight: 600; }
section { margin: 26px 0; }
table { border-collapse: collapse; width: 100%; font-size: 13px; }
th, td { text-align: left; padding: 7px 10px; border-bottom: 1px solid #2f334d; }
th { color: #9aa5ce; font-weight: 600; font-size: 12px; text-transform: uppercase;
  letter-spacing: 0.05em; white-space: nowrap; }
th.num, td.num { text-align: right; font-variant-numeric: tabular-nums; }
tbody tr:hover { background: #1c1e2e; }
.sortable th { cursor: pointer; user-select: none; }
.sortable th:hover { color: #e6e6ef; }
th.sorted-asc::after { content: " ↑"; color: #7dcfff; }
th.sorted-desc::after { content: " ↓"; color: #7dcfff; }
.na { color: #565f89; font-style: italic; }
.muted { color: #565f89; }
.agent-cell { font-weight: 600; color: #e6e6ef; }
.badge { display: inline-block; border-radius: 6px; padding: 1px 8px; font-size: 11px;
  font-weight: 600; letter-spacing: 0.03em; vertical-align: middle; }
.st-success { background: #1f2b23; color: #9ece6a; border: 1px solid #2d4a33; }
.st-error { background: #2d1f23; color: #f7768e; border: 1px solid #4a2d33; }
.st-timeout, .st-aborted, .st-cancelled, .st-budget_exceeded, .st-turn_limit {
  background: #2d281f; color: #e0af68; border: 1px solid #4a3f2d; }
.charts { display: grid; grid-template-columns: 1fr 1fr; gap: 18px; }
@media (max-width: 800px) { .charts { grid-template-columns: 1fr; } }
.chart-card { background: #1a1a26; border: 1px solid #2f334d; border-radius: 10px; padding: 16px; }
.chart-wrap { overflow-x: auto; }
.chart-wrap svg { display: block; width: 100%; min-width: 320px; height: auto; }
.chart-empty { color: #565f89; font-style: italic; padding: 24px 8px; text-align: center; }
.grid { stroke: #2f334d; stroke-width: 1; }
.axis { fill: #9aa5ce; font-size: 10px; font-family: ui-monospace, "SF Mono", Menlo, monospace; }
.agent-label { fill: #c0caf5; font-size: 11px; }
.legend { display: flex; flex-wrap: wrap; gap: 12px; margin-top: 8px; font-size: 12px; color: #a9b1d6; }
.legend-key { display: inline-flex; align-items: center; gap: 5px; }
.swatch { width: 10px; height: 10px; border-radius: 2px; display: inline-block; }
details.agent-sec { background: #1a1a26; border: 1px solid #2f334d; border-radius: 10px;
  padding: 12px 16px; margin: 10px 0; }
details.agent-sec summary { cursor: pointer; font-weight: 600; color: #e6e6ef;
  display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.sec-meta { color: #9aa5ce; font-size: 12px; margin: 8px 0 2px; }
.sec-meta code { background: #1f2335; padding: 1px 6px; border-radius: 4px; font-size: 11px; }
.timeline { font-size: 12px; margin-top: 8px; }
.timeline td, .timeline th { padding: 4px 8px; }
.timeline .t { color: #565f89; font-variant-numeric: tabular-nums; white-space: nowrap; width: 1%; }
.timeline .ty { color: #7dcfff; white-space: nowrap; width: 1%; }
pre.msg { background: #10101a; border: 1px solid #2f334d; border-radius: 8px; padding: 12px;
  overflow-x: auto; white-space: pre-wrap; word-break: break-word;
  font: 12px/1.55 ui-monospace, "SF Mono", Menlo, Consolas, monospace; color: #a9b1d6; }
button.show-more { background: #1f2335; color: #7dcfff; border: 1px solid #2f334d;
  border-radius: 6px; padding: 2px 10px; font-size: 11px; cursor: pointer; margin-top: 6px; }
button.show-more:hover { background: #2f334d; }
.warnings { color: #e0af68; font-size: 12px; padding-left: 20px; }
footer { margin-top: 40px; color: #565f89; font-size: 12px; border-top: 1px solid #2f334d; padding-top: 14px; }
`;

const JS = `
(function () {
  "use strict";
  var STATE = {};
  document.querySelectorAll("table.sortable").forEach(function (table) {
    var tbody = table.querySelector("tbody");
    if (!tbody) return;
    table.querySelectorAll("thead th").forEach(function (th, col) {
      th.addEventListener("click", function () {
        var asc = STATE[table.id] === col + ":a" ? false : true;
        STATE[table.id] = col + ":" + (asc ? "a" : "d");
        table.querySelectorAll("th").forEach(function (o) { o.classList.remove("sorted-asc", "sorted-desc"); });
        th.classList.add(asc ? "sorted-asc" : "sorted-desc");
        var rows = Array.prototype.slice.call(tbody.querySelectorAll("tr"));
        rows.sort(function (ra, rb) {
          var va = ra.children[col] ? ra.children[col].getAttribute("data-v") : "";
          var vb = rb.children[col] ? rb.children[col].getAttribute("data-v") : "";
          var na = va !== null && va !== "" && !isNaN(parseFloat(va)) && isFinite(Number(va));
          var cmp;
          if (na && vb !== null && vb !== "" && !isNaN(parseFloat(vb)) && isFinite(Number(vb))) {
            cmp = parseFloat(va) - parseFloat(vb);
          } else {
            cmp = String(va === null ? "" : va).localeCompare(String(vb === null ? "" : vb));
          }
          return asc ? cmp : -cmp;
        });
        rows.forEach(function (r) { tbody.appendChild(r); });
      });
    });
  });
  document.querySelectorAll("button.show-more").forEach(function (btn) {
    btn.addEventListener("click", function () {
      var span = btn.closest("pre").querySelector("." + btn.getAttribute("data-target"));
      if (!span) return;
      span.hidden = !span.hidden;
      btn.textContent = span.hidden
        ? btn.getAttribute("data-label-more")
        : btn.getAttribute("data-label-less");
    });
  });
})();
`;

export interface RenderOptions {
  version: string;
  generatedAt: Date;
}

/** Render the complete self-contained HTML document for a loaded trial set. */
export function renderReport(trialSet: TrialSet, opts: RenderOptions): string {
  const { runs, labels } = trialSet;
  const multiTrial = labels.length > 1;
  const task = runs.find((r) => r.task)?.task ?? null;
  const tsChips = labels
    .map((l) => `<span class="chip">${esc(labelToTimestamp(l) ?? l)}</span>`)
    .join("");
  const agents = [...new Set(runs.map((r) => r.agent))];
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>agentic-coding-harness report · ${esc(labels.join(", "))}</title>
<style>${CSS}</style>
</head>
<body>
<main>
  <header>
    <h1>Agent trial report</h1>
    <p class="meta">${multiTrial ? `${labels.length} trials` : `trial ${esc(labels[0] ?? "")}`}<span class="sep">·</span>${agents.length} agent${agents.length === 1 ? "" : "s"}<span class="sep">·</span>task: ${task ? esc(clip(task, 120)) : "same-prompt comparison (task not captured)"}</p>
    <div class="chips">${tsChips}</div>
  </header>
  <section>
    <h3>comparison</h3>
${renderComparisonTable(runs, multiTrial)}
  </section>
${renderCharts(runs)}
  <section>
    <h3>per-agent detail</h3>
${runs.map(renderAgentSection).join("\n")}
  </section>
  <footer>generated by agentic-coding-harness ${esc(opts.version)} · ${esc(opts.generatedAt.toISOString())}</footer>
</main>
<script>${JS}</script>
</body>
</html>
`;
}

/** Trial dir names are `YYYYMMDD-HHMMSS` timestamps; render them readably. */
function labelToTimestamp(label: string): string | null {
  const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})$/.exec(label);
  if (!m) return null;
  const iso = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}`;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC");
}

/** Package version for the footer. */
export async function readVersion(): Promise<string> {
  return VERSION;
}
