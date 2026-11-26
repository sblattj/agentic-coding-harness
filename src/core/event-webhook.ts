// HTTP event tap (#64): POST run lifecycle events to a webhook URL for
// external automation (a Slack relay, a CI trigger on failure, a ledger).
//
// One module owns delivery: the event filter, the stable envelope
// {schemaVersion, runId, type, timestamp, payload}, the optional HMAC-SHA256
// signature, a sequential in-memory queue with bounded retries and
// exponential backoff, and a bounded flush at run end. The driver and
// `ach watch` only call `post()` (never blocks) and `flush()` (bounded).
//
// Fail open by construction: nothing here throws to the caller, nothing
// touches RunResult or the run's artifacts, and failures are reported only
// as stderr lines through `log`. Docs: docs/EVENT-WEBHOOK.md.
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { HarnessError } from "./types.ts";
import { formatMaskedNote, formatPreview, maskForExport, NO_MASK, type MaskPolicy } from "./masking.ts";

/** Webhook URL (same as `--event-webhook`; the flag wins). */
export const EVENT_WEBHOOK_ENV = "AGENTIC_CODING_HARNESS_EVENT_WEBHOOK";
/** HMAC-SHA256 key. Env only: never a flag or config key, so it stays out of argv and RunRecords. */
export const EVENT_WEBHOOK_SECRET_ENV = "AGENTIC_CODING_HARNESS_EVENT_WEBHOOK_SECRET";

/** Bumped only on a breaking envelope change. */
export const WEBHOOK_SCHEMA_VERSION = 1;

/** Every event type the tap can post. None is per-token chatter. */
export const WEBHOOK_EVENT_TYPES = ["start", "exit", "budget", "usage"] as const;
export type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number];
/** Default filter: every lifecycle event (the tap never posts raw agent events). */
export const DEFAULT_WEBHOOK_EVENTS: readonly WebhookEventType[] = WEBHOOK_EVENT_TYPES;

/** `sha256=<hex HMAC-SHA256 of the raw body>`, GitHub style. Sent only when a secret is set. */
export const WEBHOOK_SIGNATURE_HEADER = "x-ach-signature-256";
/** The envelope `type`, so a receiver can route before parsing. */
export const WEBHOOK_EVENT_HEADER = "x-ach-event";
/** A per-delivery uuid, identical across retries (receivers can dedupe on it). */
export const WEBHOOK_DELIVERY_HEADER = "x-ach-delivery";

export interface WebhookRetryPolicy {
  /** Attempts per event, the first one included. */
  maxAttempts: number;
  /** Wait before retry 1; each later retry doubles it. */
  baseDelayMs: number;
  /** One attempt's deadline (a receiver that accepts and never answers). */
  attemptTimeoutMs: number;
}

/**
 * Defaults: 4 attempts (1 + 3 retries), backoff 250ms, 500ms, 1000ms, 2s per
 * attempt. Any non-2xx status or network error is retried.
 */
export const DEFAULT_WEBHOOK_RETRY: WebhookRetryPolicy = { maxAttempts: 4, baseDelayMs: 250, attemptTimeoutMs: 2000 };

/**
 * The most the tap adds to a run's end: `flush()` waits at most this long for
 * the queue to drain, then aborts the in-flight POST, cancels pending backoff
 * and drops what is still queued (counted as failures).
 */
export const DEFAULT_WEBHOOK_FLUSH_MS = 5000;

/** How often a running run posts a `usage` summary (only while it is running). */
export const DEFAULT_WEBHOOK_USAGE_INTERVAL_MS = 60_000;

export interface WebhookEnvelope<P = Record<string, unknown>> {
  schemaVersion: typeof WEBHOOK_SCHEMA_VERSION;
  runId: string;
  type: WebhookEventType;
  /** ISO 8601, when the event happened. */
  timestamp: string;
  payload: P;
}

/**
 * Parse a `--webhook-events` list (`exit,budget`). `all` = every type.
 * Unknown tokens are a USAGE error: a typo that silently dropped the exit
 * event would be worse than a refused run.
 */
export function parseWebhookEvents(raw: string | undefined, label = "--webhook-events"): Set<WebhookEventType> {
  if (raw === undefined || raw.trim() === "") return new Set(DEFAULT_WEBHOOK_EVENTS);
  const out = new Set<WebhookEventType>();
  for (const part of raw.split(",")) {
    const tok = part.trim().toLowerCase();
    if (tok === "") continue;
    if (tok === "all") {
      for (const t of WEBHOOK_EVENT_TYPES) out.add(t);
      continue;
    }
    if (!(WEBHOOK_EVENT_TYPES as readonly string[]).includes(tok)) {
      throw new HarnessError(`${label}: unknown event '${part.trim()}' (expected a comma list of ${WEBHOOK_EVENT_TYPES.join(", ")}, or all)`, "USAGE");
    }
    out.add(tok as WebhookEventType);
  }
  if (out.size === 0) throw new HarnessError(`${label}: no events named (expected ${WEBHOOK_EVENT_TYPES.join(", ")}, or all)`, "USAGE");
  return out;
}

/** Validate a webhook URL: absolute http(s) only. Returns the parsed URL. */
export function parseWebhookUrl(raw: string, label = "--event-webhook"): URL {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new HarnessError(`${label} expects an absolute http(s) URL`, "USAGE");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new HarnessError(`${label} expects an http(s) URL, got '${url.protocol}'`, "USAGE");
  }
  return url;
}

/**
 * What logs may show of a webhook URL: its origin only. A Slack incoming
 * webhook URL is itself a bearer credential (the path is the token).
 */
export function webhookOrigin(url: string | URL): string {
  try {
    return new URL(String(url)).origin;
  } catch {
    return "<invalid url>";
  }
}

/** `sha256=<hex>` over the exact bytes POSTed. */
export function signWebhookBody(secret: string, body: string): string {
  return `sha256=${createHmac("sha256", secret).update(body, "utf8").digest("hex")}`;
}

/** Receiver-side check, constant time. `header` is the X-Ach-Signature-256 value. */
export function verifyWebhookSignature(secret: string, body: string, header: string | undefined | null): boolean {
  if (typeof header !== "string") return false;
  const want = Buffer.from(signWebhookBody(secret, body));
  const got = Buffer.from(header.trim());
  return want.length === got.length && timingSafeEqual(want, got);
}

/** Per-run delivery counters (the failure counter the stderr line reports). */
export interface WebhookRunStats {
  posted: number;
  delivered: number;
  failed: number;
}

export interface EventWebhookOptions {
  url: string;
  secret?: string | undefined;
  events?: ReadonlySet<WebhookEventType>;
  /** `mask.webhook` / `mask.mode` / `--mask` (#71); default: nothing masked. */
  mask?: MaskPolicy;
  retry?: Partial<WebhookRetryPolicy>;
  /** Flush bound in ms (DEFAULT_WEBHOOK_FLUSH_MS). */
  flushMs?: number;
  usageIntervalMs?: number;
  /** Stderr sink for failure lines. */
  log?: (line: string) => void;
  /** Injected for tests. */
  fetch?: typeof fetch;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  now?: () => number;
}

export interface EventWebhook {
  readonly events: ReadonlySet<WebhookEventType>;
  readonly usageIntervalMs: number;
  readonly flushMs: number;
  /** True when `type` passes the filter (callers skip building payloads otherwise). */
  wants(type: WebhookEventType): boolean;
  /** Queue one event. Never blocks, never throws. */
  post(runId: string, type: WebhookEventType, payload: Record<string, unknown>, at?: number): void;
  /**
   * Wait for the queue to drain, at most `flushMs`. On the deadline the
   * in-flight POST is aborted and the rest is dropped. Logs the per-run
   * failure counter when anything failed. Never throws.
   */
  flush(runId?: string): Promise<void>;
  stats(runId: string): WebhookRunStats;
}

interface Delivery {
  runId: string;
  type: WebhookEventType;
  body: string;
  id: string;
}

/** Abortable sleep: resolves early (never rejects) when `signal` fires. */
const defaultSleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done(): void {
      clearTimeout(t);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });

const errText = (err: unknown): string => {
  if (err instanceof Error) {
    const cause = (err as { cause?: unknown }).cause;
    const code = typeof cause === "object" && cause !== null ? (cause as { code?: unknown }).code : undefined;
    if (err.name === "TimeoutError" || err.name === "AbortError") return "timed out";
    return typeof code === "string" ? code : err.message;
  }
  return String(err);
};

/** Build the tap. Returns an object whose every method is fail-open. */
export function createEventWebhook(opts: EventWebhookOptions): EventWebhook {
  const url = parseWebhookUrl(opts.url).toString();
  const origin = webhookOrigin(url);
  const events: ReadonlySet<WebhookEventType> = opts.events ?? new Set(DEFAULT_WEBHOOK_EVENTS);
  const retry: WebhookRetryPolicy = { ...DEFAULT_WEBHOOK_RETRY, ...(opts.retry ?? {}) };
  const flushMs = opts.flushMs ?? DEFAULT_WEBHOOK_FLUSH_MS;
  const usageIntervalMs = opts.usageIntervalMs ?? DEFAULT_WEBHOOK_USAGE_INTERVAL_MS;
  const mask = opts.mask ?? NO_MASK;
  const log = opts.log ?? ((line: string) => void process.stderr.write(line));
  const doFetch = opts.fetch ?? ((...a: Parameters<typeof fetch>) => globalThis.fetch(...a));
  const sleep = opts.sleep ?? defaultSleep;
  const now = opts.now ?? Date.now;
  const secret = opts.secret !== undefined && opts.secret !== "" ? opts.secret : undefined;

  const queue: Delivery[] = [];
  const counters = new Map<string, WebhookRunStats>();
  let abort = new AbortController();
  let worker: Promise<void> | null = null;
  let previewNoted = false;

  const counter = (runId: string): WebhookRunStats => {
    let c = counters.get(runId);
    if (c === undefined) {
      c = { posted: 0, delivered: 0, failed: 0 };
      counters.set(runId, c);
    }
    return c;
  };

  const attempt = async (d: Delivery, signal: AbortSignal): Promise<string | null> => {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "user-agent": "agentic-coding-harness-webhook",
      [WEBHOOK_EVENT_HEADER]: d.type,
      [WEBHOOK_DELIVERY_HEADER]: d.id,
    };
    if (secret !== undefined) headers[WEBHOOK_SIGNATURE_HEADER] = signWebhookBody(secret, d.body);
    try {
      const res = await doFetch(url, {
        method: "POST",
        headers,
        body: d.body,
        signal: AbortSignal.any([signal, AbortSignal.timeout(retry.attemptTimeoutMs)]),
      });
      // Drain so the socket is released; the body is never read for meaning.
      await res.arrayBuffer().catch(() => undefined);
      return res.ok ? null : `HTTP ${res.status}`;
    } catch (err) {
      return errText(err);
    }
  };

  const deliver = async (d: Delivery, signal: AbortSignal): Promise<void> => {
    const c = counter(d.runId);
    let last = "unknown error";
    for (let n = 1; n <= retry.maxAttempts; n++) {
      if (signal.aborted) break;
      const err = await attempt(d, signal);
      if (err === null) {
        c.delivered++;
        return;
      }
      last = signal.aborted ? "flush deadline reached" : err;
      if (n < retry.maxAttempts && !signal.aborted) await sleep(retry.baseDelayMs * 2 ** (n - 1), signal);
    }
    c.failed++;
    log(`[warn] webhook: ${d.type} event for run ${d.runId.slice(0, 8)} not delivered to ${origin} (${last}); failures this run: ${c.failed}\n`);
  };

  const pump = async (): Promise<void> => {
    while (queue.length > 0) {
      const d = queue.shift()!;
      const signal = abort.signal;
      if (signal.aborted) {
        queue.unshift(d);
        return;
      }
      try {
        await deliver(d, signal);
      } catch {
        // deliver never throws; belt and braces for fail-open.
      }
    }
  };

  const kick = (): void => {
    if (worker !== null) return;
    worker = pump().finally(() => {
      worker = null;
      if (queue.length > 0 && !abort.signal.aborted) kick();
    });
  };

  return {
    events,
    usageIntervalMs,
    flushMs,
    wants: (type) => events.has(type),

    post(runId, type, payload, at) {
      try {
        if (!events.has(type)) return;
        const envelope: WebhookEnvelope = {
          schemaVersion: WEBHOOK_SCHEMA_VERSION,
          runId,
          type,
          timestamp: new Date(at ?? now()).toISOString(),
          payload,
        };
        const gate = maskForExport(envelope, mask);
        if (gate.mode === "preview") {
          // Preview lists findings and sends nothing (docs/MASKING.md).
          log(formatPreview(`webhook ${type}`, gate.findings));
          if (!previewNoted) {
            previewNoted = true;
            log(`webhook: mask preview mode: no event is POSTed to ${origin}\n`);
          }
          return;
        }
        if (gate.mode === "all" && gate.findings.length > 0) log(formatMaskedNote(`webhook ${type}`, gate.findings));
        // Serialized once: the signature covers exactly these bytes, on every retry.
        const body = JSON.stringify(gate.value);
        counter(runId).posted++;
        queue.push({ runId, type, body, id: randomUUID() });
        kick();
      } catch {
        // fail open
      }
    },

    async flush(runId) {
      try {
        if (worker !== null || queue.length > 0) {
          kick();
          let timer: ReturnType<typeof setTimeout> | undefined;
          const deadline = new Promise<"deadline">((resolve) => {
            timer = setTimeout(() => resolve("deadline"), flushMs);
          });
          const idle = (async () => {
            while (worker !== null) await worker;
            return "idle" as const;
          })();
          const won = await Promise.race([idle, deadline]);
          clearTimeout(timer);
          if (won === "deadline") {
            abort.abort();
            // The in-flight attempt sees the abort and settles promptly.
            while (worker !== null) await worker;
            for (const d of queue.splice(0)) {
              const c = counter(d.runId);
              c.failed++;
              log(`[warn] webhook: ${d.type} event for run ${d.runId.slice(0, 8)} dropped at the ${flushMs}ms flush deadline; failures this run: ${c.failed}\n`);
            }
            abort = new AbortController();
          }
        }
        if (runId !== undefined) {
          const c = counters.get(runId);
          if (c !== undefined && c.failed > 0) {
            log(`[warn] webhook: ${c.failed} of ${c.posted} event${c.posted === 1 ? "" : "s"} for run ${runId.slice(0, 8)} not delivered to ${origin}; the run itself is unaffected\n`);
          }
        }
      } catch {
        // fail open
      }
    },

    stats(runId) {
      return { ...counter(runId) };
    },
  };
}

/** Token sums for a payload; placeholder records (extra.tokensAvailable === false) count nothing. */
export function sumWebhookTokens(
  tokens: ReadonlyArray<{ inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; extra?: Record<string, unknown> | undefined }>,
): { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number } {
  const out = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  for (const t of tokens) {
    if (t.extra?.tokensAvailable === false) continue;
    out.inputTokens += t.inputTokens;
    out.outputTokens += t.outputTokens;
    out.cacheReadTokens += t.cacheReadTokens;
    out.cacheWriteTokens += t.cacheWriteTokens;
  }
  return out;
}
