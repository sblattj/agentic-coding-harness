// Queue panel for `ach web` (#115 part A): GET /api/queues (JSON) and
// GET /queues (server-rendered, auto-refreshing page). Rendered server-side
// with escapeHtml on every dynamic string — labels, agents, models, runIds and
// errors all originate in user plan files — so the page needs no bundled
// asset and no client-side HTML building.
import { fmtDuration, queueSummaryLine, sliceDetail, QUEUE_RECENT_HOURS, type QueueView } from "../core/queue-view.ts";

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

export const QUEUES_PAGE_REFRESH_S = 5;

const CSS = `body{background:#0b0f17;color:#cbd5e1;font:13px/1.5 "SF Mono",Menlo,Consolas,monospace;margin:0;padding:16px 24px}
a{color:#7aa2f7}h1{font-size:15px;margin:0 0 12px}h2{font-size:13px;margin:18px 0 4px}
table{border-collapse:collapse;margin:4px 0 8px}td,th{padding:2px 14px 2px 0;text-align:left;white-space:nowrap}
th{color:#64748b;font-weight:normal}.dim{color:#64748b}
.s-running{color:#4ade80}.s-done{color:#64748b}.s-failed,.s-pre-failed,.s-died{color:#f87171}.s-queued{color:#cbd5e1}`;

export function renderQueuesPage(queues: QueueView[], opts: { token?: string } = {}): string {
  const qs = opts.token ? `?token=${encodeURIComponent(opts.token)}` : "";
  const body: string[] = [];
  if (queues.length === 0) {
    body.push(`<p class="dim">no queues running or ended in the last ${QUEUE_RECENT_HOURS}h — start one with <code>ach queue run &lt;plan&gt;</code></p>`);
  }
  for (const q of queues) {
    const phaseCls = q.died ? "died" : q.phase === "running" ? "running" : "done";
    body.push(`<h2><span class="s-${phaseCls}">${escapeHtml(queueSummaryLine(q))}</span></h2>`);
    if (q.died) body.push(`<p class="s-died">queue process died (pid ${q.queuePid}) &mdash; <code>${escapeHtml(q.resumeHint ?? "")}</code></p>`);
    body.push("<table><tr><th>slice</th><th>agent/model</th><th>status</th><th>runs / pid</th><th>elapsed</th></tr>");
    for (const sl of q.slices) {
      const am = sl.model !== undefined ? `${sl.agent}/${sl.model}` : sl.agent;
      const err = sl.error !== undefined ? ` <span class="dim">${escapeHtml(sl.error)}</span>` : "";
      body.push(
        `<tr><td>${escapeHtml(sl.label)}</td><td>${escapeHtml(am)}</td>` +
          `<td class="s-${escapeHtml(sl.status)}">${escapeHtml(sl.status)}</td>` +
          `<td>${escapeHtml(sliceDetail(sl))}</td>` +
          `<td>${sl.elapsedMs !== undefined ? escapeHtml(fmtDuration(sl.elapsedMs)) : ""}${err}</td></tr>`,
      );
    }
    body.push("</table>");
  }
  return `<!doctype html><html><head><meta charset="utf-8"><title>ach queues</title>` +
    `<meta http-equiv="refresh" content="${QUEUES_PAGE_REFRESH_S}"><style>${CSS}</style></head><body>` +
    `<h1>queues <span class="dim">&mdash; <a href="/${qs}">runs</a> &middot; <a href="/api/queues${qs}">json</a></span></h1>` +
    body.join("\n") + `</body></html>`;
}
