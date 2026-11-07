// `--offline` contract (issue #40). Pricing is a static bundled load (see
// pricing.ts), so nothing in stats/watch/dash/web NEEDS the network. This
// module turns that into an enforced guarantee: installOfflineGuard() wraps
// the outbound primitives (global fetch, node:http/https request+get) so any
// attempt to reach a non-loopback host throws a named OfflineViolation
// instead of silently going out.
//
// Loopback (localhost, 127.0.0.0/8, ::1) stays allowed: it never leaves the
// machine, and `ach web` / the kiro IDE CDP probe talk to local ports. Only a
// call that would leave the host is a violation.
import http from 'node:http';
import https from 'node:https';

/** Thrown by the offline guard; `url` is the refused destination. */
export class OfflineViolation extends Error {
  readonly url: string;
  constructor(url: string, via: string) {
    super(`OfflineViolation: --offline refused a network call via ${via} to ${url}`);
    this.name = 'OfflineViolation';
    this.url = url;
  }
}

/** True for localhost, 127.0.0.0/8, ::1 and the IPv4-mapped loopback. */
export function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/^\[|\]$/g, '');
  return h === 'localhost' || h.endsWith('.localhost') || h === '::1' || /^127(?:\.\d{1,3}){3}$/.test(h) || h === '::ffff:127.0.0.1';
}

/** True when `url` parses and names a loopback host. An unparseable URL is not loopback. */
export function isLoopbackUrl(url: string): boolean {
  try {
    return isLoopbackHost(new URL(url).hostname);
  } catch {
    return false;
  }
}

let installed: { fetch: typeof globalThis.fetch; httpRequest: typeof http.request; httpGet: typeof http.get; httpsRequest: typeof https.request; httpsGet: typeof https.get } | null = null;

export function offlineGuardInstalled(): boolean {
  return installed !== null;
}

function describeFetchInput(input: unknown): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  const u = (input as { url?: unknown } | null)?.url;
  return typeof u === 'string' ? u : String(input);
}

function describeNodeArgs(proto: string, args: unknown[]): string {
  const first = args[0];
  if (typeof first === 'string') return first;
  if (first instanceof URL) return first.toString();
  const o = (first ?? {}) as { hostname?: string; host?: string; port?: number | string; path?: string };
  const host = o.hostname ?? o.host ?? 'localhost';
  return `${proto}//${host}${o.port !== undefined ? `:${o.port}` : ''}${o.path ?? ''}`;
}

function nodeHost(args: unknown[]): string {
  const first = args[0];
  if (typeof first === 'string') return first.includes('://') ? first : `http://${first}`;
  if (first instanceof URL) return first.toString();
  const o = (first ?? {}) as { hostname?: string; host?: string };
  return `http://${o.hostname ?? o.host ?? 'localhost'}`;
}

/** Install the guard (idempotent). Returns a function that restores the originals. */
export function installOfflineGuard(): () => void {
  if (installed !== null) return uninstallOfflineGuard;
  installed = {
    fetch: globalThis.fetch,
    httpRequest: http.request,
    httpGet: http.get,
    httpsRequest: https.request,
    httpsGet: https.get,
  };
  const real = installed;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = describeFetchInput(input);
    if (!isLoopbackUrl(url)) throw new OfflineViolation(url, 'fetch');
    return real.fetch(input, init);
  }) as typeof fetch;
  const wrap = <F extends (...a: never[]) => unknown>(orig: F, proto: string, name: string): F =>
    ((...a: unknown[]) => {
      if (!isLoopbackUrl(nodeHost(a))) throw new OfflineViolation(describeNodeArgs(proto, a), name);
      return (orig as unknown as (...x: unknown[]) => unknown)(...a);
    }) as unknown as F;
  http.request = wrap(real.httpRequest, 'http:', 'http.request');
  http.get = wrap(real.httpGet, 'http:', 'http.get');
  https.request = wrap(real.httpsRequest, 'https:', 'https.request');
  https.get = wrap(real.httpsGet, 'https:', 'https.get');
  return uninstallOfflineGuard;
}

/** Restore the primitives replaced by {@link installOfflineGuard}. */
export function uninstallOfflineGuard(): void {
  if (installed === null) return;
  globalThis.fetch = installed.fetch;
  http.request = installed.httpRequest;
  http.get = installed.httpGet;
  https.request = installed.httpsRequest;
  https.get = installed.httpsGet;
  installed = null;
}

/**
 * Refuse a configured remote run source under --offline (before any poll
 * starts), with a message that names the flag. Loopback sources are fine.
 */
export function assertOfflineSource(url: string): void {
  if (!isLoopbackUrl(url)) {
    throw new OfflineViolation(url, 'web --source');
  }
}
