/*
 * HarnessFeed — a framework-free structured log feed for agent runs.
 *
 * Served at /feed.js. Consumers (index.html, grid.html, trio.html) create a
 * feed over a container element and either push events into it directly or
 * let `connect()` drive it from the dashboard's /ws run socket.
 *
 * The feed is APPEND-ONLY: when a run ends nothing is torn down or swapped
 * for a player — `setEnded()` just appends a terminal line. Events are the
 * persisted core AgentEvent rows (see src/core/types.ts); the server also
 * attaches a pre-rendered `text` field for legacy consumers, which this
 * module deliberately ignores — every row is rendered from structure.
 *
 * Streamed `chunk` steps coalesce into one row per contiguous run of a single
 * kind: `agent_thought_chunk` text lands in a dim `.hf-reason` row, every other
 * chunk in an `.hf-msg-agent` row, and a change of kind opens a fresh row. Dim
 * status rows (progress, modelAck, stderrNotice) print WITHOUT closing that
 * block, so an interleaved heartbeat can no longer shred one message into a row
 * per delta; only a message, a tool card or a terminal row ends the stream.
 *
 * All event-derived text goes through textContent; nothing is ever parsed as
 * HTML or markdown.
 */
(function () {
  "use strict";

  var CSS_ID = "harness-feed-css";
  var NEAR_BOTTOM_PX = 48;
  var DEFAULT_MAX_ITEMS = 5000;
  var ARGS_SUMMARY_MAX = 120;
  var OUTPUT_CAP = 64 * 1024;
  var LIVE_WINDOW_MS = 60000;
  var RECONNECT_MIN_MS = 1000;
  var RECONNECT_MAX_MS = 15000;

  var CSS = [
    ".hf-scroll{position:relative;overflow:auto;background:var(--feed-bg,#0b0e14);",
    "color:var(--feed-fg,#c9d4e3);",
    "font:12px/1.55 var(--feed-mono,\"SF Mono\",Menlo,Consolas,\"DejaVu Sans Mono\",monospace);}",
    ".hf-scroll::-webkit-scrollbar{width:8px;height:8px}",
    ".hf-scroll::-webkit-scrollbar-thumb{background:var(--feed-line,#1d2534)}",
    ".hf-scroll::-webkit-scrollbar-track{background:transparent}",
    ".hf-rows{display:flex;flex-direction:column;padding:10px 14px 40px 10px;gap:2px;min-height:100%}",
    ".hf-row{display:grid;grid-template-columns:6ch minmax(0,1fr);gap:10px;align-items:start}",
    ".hf-gutter{color:var(--feed-dim,#5d6b82);opacity:.65;text-align:right;",
    "font-variant-numeric:tabular-nums;user-select:none;padding-top:1px}",
    ".hf-body{min-width:0}",
    ".hf-text{white-space:pre-wrap;overflow-wrap:anywhere}",
    ".hf-msg-agent{color:var(--feed-fg,#c9d4e3);padding:2px 0}",
    ".hf-msg-user{color:var(--feed-blue,#7aa2f7);border-left:2px solid var(--feed-blue,#7aa2f7);",
    "padding:2px 0 2px 8px}",
    ".hf-msg-system{color:var(--feed-dim,#5d6b82)}",
    ".hf-reason{color:var(--feed-dim,#5d6b82);font-style:italic;white-space:pre-wrap;",
    "overflow-wrap:anywhere;margin-bottom:3px}",
    ".hf-dim{color:var(--feed-dim,#5d6b82)}",
    ".hf-warn{color:var(--feed-yellow,#e5c07b)}",
    ".hf-err{color:var(--feed-red,#e06c75)}",
    ".hf-ok{color:var(--feed-green,#4cc38a)}",
    ".hf-status{font-weight:700;letter-spacing:.5px;padding:3px 0}",
    ".hf-card{border:1px solid var(--feed-line,#1d2534);border-radius:4px;",
    "background:rgba(255,255,255,.02);margin:2px 0}",
    ".hf-card.hf-card-err{border-color:var(--feed-red,#e06c75);background:rgba(224,108,117,.07)}",
    ".hf-head{display:flex;align-items:baseline;gap:8px;padding:3px 8px;cursor:pointer;",
    "white-space:nowrap}",
    ".hf-head:hover{background:rgba(255,255,255,.04)}",
    ".hf-head:focus-visible{outline:1px solid var(--feed-blue,#7aa2f7);outline-offset:-1px}",
    ".hf-tri{color:var(--feed-dim,#5d6b82);width:1ch;flex:none;user-select:none}",
    ".hf-fn{font-weight:700;color:var(--feed-blue,#7aa2f7);flex:none}",
    ".hf-args{color:var(--feed-dim,#5d6b82);overflow:hidden;text-overflow:ellipsis;flex:1 1 auto;",
    "min-width:0}",
    ".hf-chip{flex:none;width:2ch;text-align:center}",
    ".hf-chip-pending{color:var(--feed-yellow,#e5c07b);animation:hf-pulse 1.2s ease-in-out infinite}",
    ".hf-chip-ok{color:var(--feed-green,#4cc38a)}",
    ".hf-chip-err{color:var(--feed-red,#e06c75)}",
    "@keyframes hf-pulse{0%,100%{opacity:1}50%{opacity:.25}}",
    "@media (prefers-reduced-motion:reduce){.hf-chip-pending{animation:none}}",
    ".hf-ms{flex:none;color:var(--feed-dim,#5d6b82);font-variant-numeric:tabular-nums}",
    ".hf-detail{border-top:1px solid var(--feed-line,#1d2534);padding:6px 8px}",
    ".hf-detail[hidden]{display:none}",
    ".hf-sec{color:var(--feed-dim,#5d6b82);text-transform:uppercase;letter-spacing:.6px;",
    "margin:4px 0 2px}",
    ".hf-sec:first-child{margin-top:0}",
    ".hf-pre{white-space:pre-wrap;overflow-wrap:anywhere;max-height:40vh;overflow:auto;",
    "margin:0;font:inherit;color:var(--feed-fg,#c9d4e3)}",
    ".hf-more{background:none;border:1px solid var(--feed-line,#1d2534);border-radius:3px;",
    "color:var(--feed-dim,#5d6b82);font:inherit;cursor:pointer;padding:1px 6px;margin-top:4px}",
    ".hf-more:hover{color:var(--feed-fg,#c9d4e3)}",
    ".hf-pill{position:absolute;right:16px;bottom:12px;z-index:5;background:var(--feed-bg,#0b0e14);",
    "border:1px solid var(--feed-line,#1d2534);border-radius:999px;color:var(--feed-fg,#c9d4e3);",
    "font:inherit;cursor:pointer;padding:3px 10px;box-shadow:0 2px 8px rgba(0,0,0,.45)}",
    ".hf-pill[hidden]{display:none}",
    ".hf-pill:hover{border-color:var(--feed-green,#4cc38a);color:var(--feed-green,#4cc38a)}",
  ].join("");

  function injectCss() {
    if (typeof document === "undefined") return;
    if (document.getElementById(CSS_ID)) return;
    var style = document.createElement("style");
    style.id = CSS_ID;
    style.textContent = CSS;
    (document.head || document.documentElement).appendChild(style);
  }

  /* ------------------------------------------------------------ helpers */

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = String(text);
    return n;
  }

  function isFiniteNum(v) {
    return typeof v === "number" && isFinite(v);
  }

  function fmtTok(n) {
    if (!isFiniteNum(n)) return "-";
    if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
    if (n >= 1e3) return (n / 1e3).toFixed(1) + "k";
    return String(n);
  }

  function fmtRel(ms) {
    if (!isFiniteNum(ms) || ms < 0) ms = 0;
    var s = ms / 1000;
    if (s < 100) return "+" + s.toFixed(1) + "s";
    if (s < 3600) return "+" + Math.round(s) + "s";
    return "+" + Math.floor(s / 3600) + "h" + String(Math.floor((s % 3600) / 60)).padStart(2, "0");
  }

  function fmtDurMs(ms) {
    if (!isFiniteNum(ms) || ms < 0) return "";
    if (ms < 1000) return Math.round(ms) + "ms";
    if (ms < 60000) return (ms / 1000).toFixed(1) + "s";
    return Math.floor(ms / 60000) + "m" + String(Math.round((ms % 60000) / 1000)).padStart(2, "0") + "s";
  }

  function tsOf(ev) {
    var t = ev && ev.timestamp;
    if (isFiniteNum(t)) return t;
    if (typeof t === "string") {
      var p = Date.parse(t);
      if (isFiniteNum(p)) return p;
    }
    return null;
  }

  function pretty(value) {
    if (value == null) return "";
    if (typeof value === "string") return value;
    try {
      return JSON.stringify(value, null, 2);
    } catch (e) {
      return String(value);
    }
  }

  function compact(value) {
    if (value == null) return "";
    if (typeof value === "string") return value;
    try {
      return JSON.stringify(value);
    } catch (e) {
      return String(value);
    }
  }

  var ARG_PREFERRED = [
    "command", "file_path", "filePath", "path", "pattern", "prompt",
    "query", "url", "description", "text", "content",
  ];

  function argsSummary(args) {
    var raw;
    if (args == null) raw = "";
    else if (typeof args === "string") raw = args;
    else if (typeof args !== "object") raw = String(args);
    else {
      raw = "";
      for (var i = 0; i < ARG_PREFERRED.length; i++) {
        var v = args[ARG_PREFERRED[i]];
        if (typeof v === "string" && v.length > 0) { raw = v; break; }
      }
      if (raw === "") {
        var keys = Object.keys(args);
        for (var k = 0; k < keys.length; k++) {
          var val = args[keys[k]];
          if (typeof val === "string" && val.length > 0) { raw = val; break; }
        }
      }
      if (raw === "") raw = compact(args);
    }
    raw = String(raw).replace(/\s+/g, " ").trim();
    if (raw.length > ARGS_SUMMARY_MAX) raw = raw.slice(0, ARGS_SUMMARY_MAX - 1) + "…";
    return raw;
  }

  /** Step payloads ride `data` on the persisted wire form, `payload` in-adapter. */
  function stepData(ev) {
    var d = ev && ev.data != null ? ev.data : ev && ev.payload;
    return d != null && typeof d === "object" ? d : null;
  }

  /** Kiro metadata heartbeats carry all-zero tokens and no credits: nothing to say. */
  function usageIsEmpty(ev) {
    var u = (ev && ev.usage) || {};
    var tok = (u.inputTokens || 0) + (u.outputTokens || 0) + (u.cacheReadTokens || 0) + (u.cacheWriteTokens || 0);
    var credits = u.extra && u.extra.credits;
    return tok === 0 && !isFiniteNum(credits) && !isFiniteNum(u.costUsd);
  }

  function usageLine(ev) {
    var u = (ev && ev.usage) || {};
    var parts = [
      fmtTok(u.inputTokens) + " in",
      fmtTok(u.outputTokens) + " out",
      fmtTok(u.cacheReadTokens) + " cache-r",
      fmtTok(u.cacheWriteTokens) + " cache-w",
    ];
    var credits = u.extra && u.extra.credits;
    if (isFiniteNum(credits)) parts.push(Number(credits).toFixed(3) + " credits");
    if (isFiniteNum(u.costUsd)) parts.push("$" + Number(u.costUsd).toFixed(4));
    return "usage " + parts.join(" · ");
  }

  /* --------------------------------------------------------------- feed */

  function create(container, opts) {
    if (!container) throw new Error("HarnessFeed.create: container required");
    injectCss();
    var options = opts || {};
    var maxItems = isFiniteNum(options.maxItems) && options.maxItems > 0
      ? Math.floor(options.maxItems)
      : DEFAULT_MAX_ITEMS;
    var compactMode = options.compact === true;

    container.textContent = "";
    container.classList.add("hf-scroll");
    var rows = el("div", "hf-rows");
    if (compactMode) rows.style.padding = "4px 8px 24px 6px";
    container.appendChild(rows);
    var pill = el("button", "hf-pill", "↓ latest");
    pill.type = "button";
    pill.hidden = true;
    pill.addEventListener("click", function () {
      container.scrollTop = container.scrollHeight;
      pill.hidden = true;
    });
    container.appendChild(pill);

    var state = {
      first: null,      // first event timestamp (ms)
      count: 0,
      ended: false,
      byId: Object.create(null),   // toolCallId -> card
      unresolved: [],              // cards awaiting a result, oldest first
      pending: [],                 // cards with a live spinner chip
      stream: null,                // { pre, text, kind } chunk block; kind "message" | "reasoning"
    };

    function atBottom() {
      return container.scrollHeight - container.scrollTop - container.clientHeight < NEAR_BOTTOM_PX;
    }

    container.addEventListener("scroll", function () {
      if (atBottom()) pill.hidden = true;
    });

    function addRow(ts, bodyNode) {
      var near = atBottom();
      var row = el("div", "hf-row");
      if (state.first === null && ts !== null) state.first = ts;
      var rel = ts !== null && state.first !== null ? fmtRel(ts - state.first) : "";
      row.appendChild(el("span", "hf-gutter", rel));
      var body = el("div", "hf-body");
      body.appendChild(bodyNode);
      row.appendChild(body);
      rows.appendChild(row);
      state.count += 1;
      while (rows.childElementCount > maxItems) {
        rows.removeChild(rows.firstChild);
      }
      if (near) {
        container.scrollTop = container.scrollHeight;
        pill.hidden = true;
      } else {
        pill.hidden = false;
      }
      return row;
    }

    function line(ts, cls, text) {
      return addRow(ts, el("div", "hf-text " + cls, text));
    }

    function endStream() {
      state.stream = null;
    }

    /* ---- tool cards ---- */

    function makeCard(ts, name, args, hasArgs) {
      var card = el("div", "hf-card");
      var head = el("div", "hf-head");
      head.tabIndex = 0;
      head.setAttribute("role", "button");
      head.setAttribute("aria-expanded", "false");
      var tri = el("span", "hf-tri", "▸");
      var fn = el("span", "hf-fn", name || "tool");
      var summary = el("span", "hf-args", argsSummary(args));
      var chip = el("span", "hf-chip hf-chip-pending", "…");
      var ms = el("span", "hf-ms", "");
      head.appendChild(tri);
      head.appendChild(fn);
      head.appendChild(summary);
      head.appendChild(chip);
      head.appendChild(ms);
      card.appendChild(head);

      var detail = el("div", "hf-detail");
      detail.hidden = true;
      card.appendChild(detail);

      var inputSec = null;
      if (hasArgs) {
        detail.appendChild(el("div", "hf-sec", "input"));
        inputSec = el("pre", "hf-pre", pretty(args));
        detail.appendChild(inputSec);
      }

      function toggle() {
        detail.hidden = !detail.hidden;
        tri.textContent = detail.hidden ? "▸" : "▾";
        head.setAttribute("aria-expanded", detail.hidden ? "false" : "true");
      }
      head.addEventListener("click", toggle);
      head.addEventListener("keydown", function (e) {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); }
      });

      var rec = {
        card: card, chip: chip, ms: ms, detail: detail, summary: summary,
        ts: ts, resolved: false, hasInput: inputSec !== null,
      };
      state.pending.push(rec);
      return rec;
    }

    function attachOutput(rec, value, isError) {
      var text = typeof value === "string" ? value : pretty(value);
      rec.detail.appendChild(el("div", "hf-sec", isError ? "output (error)" : "output"));
      var pre = el("pre", "hf-pre", text.length > OUTPUT_CAP ? text.slice(0, OUTPUT_CAP) : text);
      rec.detail.appendChild(pre);
      if (text.length > OUTPUT_CAP) {
        var shown = false;
        var btn = el("button", "hf-more", "show all (" + fmtTok(text.length) + " chars)");
        btn.type = "button";
        btn.addEventListener("click", function (e) {
          e.stopPropagation();
          shown = !shown;
          pre.textContent = shown ? text : text.slice(0, OUTPUT_CAP);
          btn.textContent = shown ? "show less" : "show all (" + fmtTok(text.length) + " chars)";
        });
        rec.detail.appendChild(btn);
      }
    }

    function resolveCard(rec, ev, content, isError) {
      rec.resolved = true;
      var idx = state.pending.indexOf(rec);
      if (idx >= 0) state.pending.splice(idx, 1);
      idx = state.unresolved.indexOf(rec);
      if (idx >= 0) state.unresolved.splice(idx, 1);
      rec.chip.className = "hf-chip " + (isError ? "hf-chip-err" : "hf-chip-ok");
      rec.chip.textContent = isError ? "✖" : "✔";
      if (isError) rec.card.classList.add("hf-card-err");
      var end = tsOf(ev);
      if (end !== null && rec.ts !== null) rec.ms.textContent = fmtDurMs(end - rec.ts);
      attachOutput(rec, content, isError);
    }

    function findCall(id) {
      if (typeof id === "string" && id.length > 0) {
        var hit = state.byId[id];
        if (hit && !hit.resolved) return hit;
        return null;
      }
      return state.unresolved.length > 0 ? state.unresolved[0] : null;
    }

    function openCall(ev, id, name, args, hasArgs) {
      endStream();
      var ts = tsOf(ev);
      var rec = makeCard(ts, name, args, hasArgs);
      if (typeof id === "string" && id.length > 0) state.byId[id] = rec;
      state.unresolved.push(rec);
      addRow(ts, rec.card);
      return rec;
    }

    function orphanResult(ev, name, content, isError) {
      endStream();
      var ts = tsOf(ev);
      var rec = makeCard(ts, name || "result", null, false);
      resolveCard(rec, ev, content, isError);
      addRow(ts, rec.card);
    }

    /* ---- per-event dispatch ---- */

    function renderMessage(ev) {
      var content = typeof ev.content === "string" ? ev.content : "";
      var source = ev.source === "assistant" ? "agent" : ev.source;
      var reasoning = typeof ev.reasoningContent === "string" ? ev.reasoningContent : "";
      if (content.trim() === "" && reasoning.trim() === "") return;

      if (
        (source === "agent" || source === undefined) &&
        state.stream !== null &&
        state.stream.kind === "message"
      ) {
        // A coalesced MESSAGE block that the adapter is now confirming: replace
        // the streamed text in place rather than emitting a duplicate row. A
        // live reasoning block is never merged into — the message opens its own
        // row below it.
        if (state.stream.text.trim() === content.trim() && content.trim() !== "") {
          state.stream.pre.textContent = content;
          endStream();
          return;
        }
      }
      endStream();
      var box = el("div", "");
      if (reasoning.trim() !== "") box.appendChild(el("div", "hf-reason", reasoning));
      if (content.trim() !== "") {
        var cls = source === "user" ? "hf-msg-user" : source === "system" ? "hf-msg-system" : "hf-msg-agent";
        box.appendChild(el("div", "hf-text " + cls, content));
      }
      addRow(tsOf(ev), box);
    }

    /** `kind` is "reasoning" (agent thoughts) or "message" (the answer). */
    function renderChunk(ev, text, kind) {
      if (typeof text !== "string" || text === "") return;
      var want = kind === "reasoning" ? "reasoning" : "message";
      // A change of kind closes the current block so thoughts and the answer
      // never share a row; same-kind chunks keep appending.
      if (state.stream !== null && state.stream.kind !== want) endStream();
      if (state.stream === null) {
        var cls = want === "reasoning" ? "hf-text hf-reason" : "hf-text hf-msg-agent";
        var pre = el("div", cls, text);
        addRow(tsOf(ev), pre);
        state.stream = { pre: pre, text: text, kind: want };
        return;
      }
      state.stream.text += text;
      state.stream.pre.textContent = state.stream.text;
      if (atBottom()) container.scrollTop = container.scrollHeight;
    }

    function renderStep(ev) {
      var d = stepData(ev);
      if (d === null) return;
      var kind = d.kind;
      if (kind === "chunk") {
        var text = typeof d.text === "string" ? d.text : "";
        // Kiro sends reasoning and answer over the same `chunk` step; only
        // chunkKind separates them (see src/adapters/kiro-events.ts).
        renderChunk(ev, text, d.chunkKind === "agent_thought_chunk" ? "reasoning" : "message");
        return;
      }
      if (kind === "modelAck") {
        // Dim advisory rows print below the live block without closing it.
        var ack = typeof d.raw === "string" ? d.raw : typeof d.warning === "string" ? d.warning : compact(d);
        line(tsOf(ev), "hf-warn", ack);
        return;
      }
      if (kind === "stderrNotice") {
        var warn = typeof d.warning === "string" ? d.warning : typeof d.raw === "string" ? d.raw : compact(d);
        line(tsOf(ev), "hf-warn", warn);
        return;
      }
      if (kind === "runFinished") {
        endStream();
        var st = typeof d.status === "string" ? d.status : "finished";
        var cls = st === "success" ? "hf-ok" : "hf-err";
        line(tsOf(ev), "hf-status " + cls, "— " + String(st).toUpperCase() + " —");
        return;
      }
      // every other step kind is bookkeeping; the feed stays quiet
    }

    function renderToolLane(ev) {
      // adapter-lane shape: {type:'tool', phase, toolName, input, output, status}
      var id = typeof ev.toolCallId === "string" ? ev.toolCallId : "";
      if (ev.phase === "start") {
        openCall(ev, id, ev.toolName, ev.input, ev.input !== undefined && ev.input !== null);
        return;
      }
      var isError = ev.status === "error";
      var target = findCall(id);
      if (target === null) {
        orphanResult(ev, ev.toolName, ev.output, isError);
        return;
      }
      resolveCard(target, ev, ev.output, isError);
    }

    function renderOne(ev) {
      if (ev == null || typeof ev !== "object") return;
      switch (ev.type) {
        case "message":
          renderMessage(ev);
          return;
        case "tool_call":
          openCall(
            ev,
            typeof ev.toolCallId === "string" ? ev.toolCallId : "",
            ev.functionName,
            ev.arguments,
            ev.arguments !== undefined && ev.arguments !== null,
          );
          return;
        case "tool_result": {
          var isError = ev.isError === true;
          var target = findCall(typeof ev.toolCallId === "string" ? ev.toolCallId : "");
          if (target === null) orphanResult(ev, ev.functionName, ev.content, isError);
          else resolveCard(target, ev, ev.content, isError);
          return;
        }
        case "tool":
          renderToolLane(ev);
          return;
        case "step":
          renderStep(ev);
          return;
        case "progress": {
          // Heartbeats interleave with chunks; ending the stream here shredded
          // the agent's text into one row per delta.
          var text = typeof ev.text === "string" ? ev.text : "";
          if (text.trim() === "") return;
          line(tsOf(ev), /warn|fail|retry/i.test(text) ? "hf-warn" : "hf-dim", text);
          return;
        }
        case "error":
          endStream();
          line(tsOf(ev), "hf-err", typeof ev.message === "string" && ev.message !== "" ? ev.message : "error");
          return;
        case "usage":
          if (!usageIsEmpty(ev)) line(tsOf(ev), "hf-dim", usageLine(ev));
          return;
        case "done": {
          endStream();
          var exit = typeof ev.exitStatus === "string" ? ev.exitStatus : "done";
          line(tsOf(ev), "hf-status " + (exit === "success" ? "hf-ok" : "hf-dim"),
            "— " + exit.toUpperCase() + " —");
          return;
        }
        case "aborted":
          endStream();
          line(tsOf(ev), "hf-status hf-err", "— ABORTED —");
          return;
        case "session_end":
          endStream();
          line(tsOf(ev), "hf-status hf-dim", "— SESSION END —");
          return;
        default:
          // session, session_start, model_call_start/end, usage_raw, idle: ignored
          return;
      }
    }

    var handle = {
      append: function (events) {
        if (!events) return handle;
        var list = Array.isArray(events) ? events : [events];
        for (var i = 0; i < list.length; i++) renderOne(list[i]);
        return handle;
      },
      reset: function () {
        rows.textContent = "";
        state.first = null;
        state.count = 0;
        state.ended = false;
        state.byId = Object.create(null);
        state.unresolved = [];
        state.pending = [];
        state.stream = null;
        pill.hidden = true;
        return handle;
      },
      setEnded: function (note) {
        for (var i = 0; i < state.pending.length; i++) {
          var rec = state.pending[i];
          rec.chip.className = "hf-chip";
          rec.chip.textContent = "·";
        }
        state.pending = [];
        state.stream = null;
        if (state.ended) return handle;
        state.ended = true;
        var near = atBottom();
        var row = el("div", "hf-row");
        row.appendChild(el("span", "hf-gutter", ""));
        var body = el("div", "hf-body");
        body.appendChild(el("div", "hf-text hf-dim", note || "— stream ended —"));
        row.appendChild(body);
        rows.appendChild(row);
        if (near) container.scrollTop = container.scrollHeight;
        return handle;
      },
      destroy: function () {
        rows.textContent = "";
        if (pill.parentNode) pill.parentNode.removeChild(pill);
        if (rows.parentNode) rows.parentNode.removeChild(rows);
        container.classList.remove("hf-scroll");
        state.byId = Object.create(null);
        state.unresolved = [];
        state.pending = [];
        state.stream = null;
      },
      container: container,
    };
    Object.defineProperty(handle, "count", { get: function () { return state.count; } });
    return handle;
  }

  /* ------------------------------------------------------------- socket */

  function wsUrl(runId, token) {
    var parts = ["runId=" + encodeURIComponent(runId)];
    if (token) parts.push("token=" + encodeURIComponent(token));
    var scheme = location.protocol === "https:" ? "wss://" : "ws://";
    return scheme + location.host + "/ws?" + parts.join("&");
  }

  function connect(feed, opts) {
    var o = opts || {};
    var runId = o.runId;
    if (!runId) throw new Error("HarnessFeed.connect: runId required");
    var closedByCaller = false;
    var sock = null;
    var timer = null;
    var backoff = RECONNECT_MIN_MS;
    var lastRecord = null;
    var ended = false;

    function status(s) {
      if (typeof o.onStatus === "function") { try { o.onStatus(s); } catch (e) { /* noop */ } }
    }

    function stillLive() {
      return lastRecord !== null &&
        lastRecord.status === "running" &&
        Date.now() - (lastRecord.updatedAt || 0) < LIVE_WINDOW_MS;
    }

    function open() {
      if (closedByCaller || ended) return;
      var ws;
      try {
        ws = new WebSocket(wsUrl(runId, o.token));
      } catch (e) {
        return;
      }
      sock = ws;
      status("connecting");
      ws.onopen = function () {
        if (ws !== sock) return;
        backoff = RECONNECT_MIN_MS;
        status("open");
      };
      ws.onmessage = function (m) {
        if (ws !== sock) return;
        var msg;
        try { msg = JSON.parse(m.data); } catch (e) { return; }
        if (msg.type === "record" && msg.record) {
          lastRecord = msg.record;
          if (typeof o.onRecord === "function") o.onRecord(msg.record);
          return;
        }
        if (msg.type === "backlog" && Array.isArray(msg.events)) {
          feed.reset();
          feed.append(msg.events);
          return;
        }
        if (msg.type === "event" && msg.event) {
          feed.append([msg.event]);
          return;
        }
        if (msg.type === "end") {
          ended = true;
          feed.setEnded();
          status("ended");
          if (typeof o.onEnd === "function") o.onEnd();
        }
      };
      ws.onclose = function () {
        if (ws !== sock) return;
        sock = null;
        status("closed");
        if (closedByCaller || ended || !stillLive()) return;
        timer = setTimeout(function () {
          timer = null;
          if (!closedByCaller && !ended && stillLive()) open();
        }, backoff);
        backoff = Math.min(RECONNECT_MAX_MS, backoff * 2);
        status("reconnecting");
      };
      ws.onerror = function () { try { ws.close(); } catch (e) { /* noop */ } };
    }

    open();

    return {
      close: function () {
        closedByCaller = true;
        if (timer !== null) { clearTimeout(timer); timer = null; }
        var ws = sock;
        sock = null;
        if (ws) {
          ws.onclose = null;
          ws.onmessage = null;
          try { ws.close(); } catch (e) { /* noop */ }
        }
      },
    };
  }

  window.HarnessFeed = { create: create, connect: connect, version: 1 };
})();
