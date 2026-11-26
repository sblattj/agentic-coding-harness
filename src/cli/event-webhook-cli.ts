// CLI glue for the HTTP event tap (#64): flags and env -> an EventWebhook.
// Delivery, the envelope and signing live in src/core/event-webhook.ts.
import { HarnessError } from "../core/types.ts";
import { isLoopbackUrl } from "../core/offline.ts";
import {
  createEventWebhook,
  DEFAULT_WEBHOOK_USAGE_INTERVAL_MS,
  EVENT_WEBHOOK_ENV,
  EVENT_WEBHOOK_SECRET_ENV,
  parseWebhookEvents,
  parseWebhookUrl,
  webhookOrigin,
  type EventWebhook,
} from "../core/event-webhook.ts";
import type { MaskFlags } from "../core/masking.ts";
import { maskPolicyFor, notePrivacy } from "./mask-cli.ts";

/** The parseArgs option table `ach run` and `ach watch` share. */
export const EVENT_WEBHOOK_OPTIONS = {
  "event-webhook": { type: "string" },
  "webhook-events": { type: "string" },
  "webhook-usage-ms": { type: "string" },
} as const;

export interface EventWebhookFlags extends MaskFlags {
  "event-webhook"?: string | undefined;
  "webhook-events"?: string | undefined;
  "webhook-usage-ms"?: string | undefined;
}

/**
 * Build the tap from `--event-webhook` (else env EVENT_WEBHOOK_ENV; a config
 * file `run.eventWebhook` arrives as the flag through the config choke point).
 * Returns undefined when no URL is set. The HMAC secret is env only.
 * Bad values are USAGE errors, raised before the run starts.
 */
export function eventWebhookFromFlags(
  values: EventWebhookFlags,
  opts: { env?: NodeJS.ProcessEnv; offline?: boolean; log?: (line: string) => void } = {},
): EventWebhook | undefined {
  const env = opts.env ?? process.env;
  const raw = values["event-webhook"] ?? env[EVENT_WEBHOOK_ENV];
  if (raw === undefined || raw.trim() === "") {
    if (values["webhook-events"] !== undefined) throw new HarnessError("--webhook-events needs --event-webhook <url> (or AGENTIC_CODING_HARNESS_EVENT_WEBHOOK)", "USAGE");
    return undefined;
  }
  const url = parseWebhookUrl(raw);
  if (opts.offline === true && !isLoopbackUrl(url.toString())) {
    throw new HarnessError(`--offline refuses a non-loopback webhook (${webhookOrigin(url)}); drop one of them`, "USAGE");
  }
  const events = parseWebhookEvents(values["webhook-events"]);
  let usageIntervalMs = DEFAULT_WEBHOOK_USAGE_INTERVAL_MS;
  const usageRaw = values["webhook-usage-ms"];
  if (usageRaw !== undefined) {
    const n = Number(usageRaw);
    if (!Number.isInteger(n) || n < 0) throw new HarnessError(`--webhook-usage-ms expects a non-negative integer (0 = off), got '${usageRaw}'`, "USAGE");
    usageIntervalMs = n;
  }
  const secret = env[EVENT_WEBHOOK_SECRET_ENV];
  const mask = maskPolicyFor("webhook", values);
  // #46: sanitizing is never silent; one note per run, not per event.
  notePrivacy(`webhook ${webhookOrigin(url)}`, mask.privacy?.mode ?? "off");
  return createEventWebhook({
    url: url.toString(),
    ...(secret !== undefined && secret !== "" ? { secret } : {}),
    events,
    mask,
    usageIntervalMs,
    ...(opts.log !== undefined ? { log: opts.log } : {}),
  });
}
