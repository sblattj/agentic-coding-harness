// `--offline` contract (issue #40). Pricing is a static bundled load (see
// pricing.ts), so nothing in stats/watch/dash/web NEEDS the network. This
// module turns that into an enforced guarantee: installOfflineGuard() wraps
// the outbound primitives (global fetch, node:http/https request+get,
// net.connect/createConnection, tls.connect, dns.lookup) so any
// attempt to reach a non-loopback host throws a named OfflineViolation
// instead of silently going out.
//
// Loopback (localhost, 127.0.0.0/8, ::1) stays allowed: it never leaves the
// machine, and `ach web` / the kiro IDE CDP probe talk to local ports. Only a
// call that would leave the host is a violation.
import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
import net from 'node:net';
import tls from 'node:tls';

import { HarnessError } from './types.ts';

/** Thrown by the offline guard; `url` is the refused destination. */
export class OfflineViolation extends HarnessError {
  readonly url: string;
  constructor(url: string, via: string) {
    super(`OfflineViolation: --offline refused a network call via ${via} to ${url}`, 'OFFLINE_VIOLATION', 1);
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

type Fn = (...a: never[]) => unknown;
interface Saved {
  fetch: typeof globalThis.fetch;
  patched: Array<{ obj: Record<string, unknown>; key: string; orig: unknown }>;
}
let installed: Saved | null = null;

export function offlineGuardInstalled(): boolean {
  return installed !== null;
}

function describeFetchInput(input: unknown): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  const u = (input as { url?: unknown } | null)?.url;
  return typeof u === 'string' ? u : String(input);
}

interface HostOpts { hostname?: string; host?: string; port?: number | string; path?: string }

/**
 * Merge the request arguments the way node:http does: a URL (or URL string)
 * first argument is converted to options, then an options object (second
 * argument after a URL, first otherwise) overrides it field by field. The
 * effective host is `hostname || host || 'localhost'`. An unparseable URL
 * string yields host '' (never loopback, so it is refused).
 */
function mergedNodeOpts(args: unknown[]): HostOpts {
  const first = args[0];
  let base: HostOpts = {};
  let over: unknown = first;
  if (typeof first === 'string' || first instanceof URL) {
    over = args[1];
    try {
      const u = typeof first === 'string' ? new URL(first.includes('://') ? first : `http://${first}`) : first;
      base = { hostname: u.hostname, port: u.port === '' ? undefined : u.port, path: `${u.pathname}${u.search}` };
    } catch {
      base = { hostname: '' };
    }
  }
  const o = typeof over === 'object' && over !== null && typeof over !== 'function' ? (over as HostOpts) : {};
  return { ...base, ...Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null)) };
}

function nodeHostname(args: unknown[]): string {
  const m = mergedNodeOpts(args);
  return m.hostname || m.host || (typeof args[0] === 'string' || args[0] instanceof URL ? '' : 'localhost');
}

function describeNodeArgs(proto: string, args: unknown[]): string {
  const m = mergedNodeOpts(args);
  const host = nodeHostname(args) || String(args[0]);
  return `${proto}//${host}${m.port !== undefined ? `:${m.port}` : ''}${m.path ?? ''}`;
}

/** Destination host of a net.connect / tls.connect call, or null for IPC (unix socket) or an existing socket. */
function netHost(args: unknown[]): string | null {
  const first = args[0];
  if (typeof first === 'object' && first !== null) {
    const o = first as { host?: string; port?: unknown; path?: string; socket?: unknown };
    if (o.socket !== undefined) return null;
    if (o.path !== undefined && o.port === undefined) return null;
    return o.host ?? 'localhost';
  }
  if (typeof first === 'string' && !/^\d+$/.test(first)) return null; // IPC path
  const second = args[1];
  return typeof second === 'string' ? second : 'localhost';
}

function dnsHost(args: unknown[]): string {
  return typeof args[0] === 'string' ? args[0] : '';
}

/** Install the guard (idempotent). Returns a function that restores the originals. */
export function installOfflineGuard(): () => void {
  if (installed !== null) return uninstallOfflineGuard;
  const saved: Saved = { fetch: globalThis.fetch, patched: [] };
  installed = saved;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = describeFetchInput(input);
    if (!isLoopbackUrl(url)) throw new OfflineViolation(url, 'fetch');
    return saved.fetch(input, init);
  }) as typeof fetch;
  const patch = (obj: unknown, key: string, make: (orig: Fn) => unknown): void => {
    const o = obj as Record<string, unknown>;
    const orig = o[key];
    if (typeof orig !== 'function') return;
    saved.patched.push({ obj: o, key, orig });
    o[key] = make(orig as Fn);
  };
  const call = (orig: Fn, a: unknown[]): unknown => (orig as unknown as (...x: unknown[]) => unknown)(...a);
  const wrapHttp = (proto: string, name: string) => (orig: Fn) => (...a: unknown[]) => {
    if (!isLoopbackHost(nodeHostname(a))) throw new OfflineViolation(describeNodeArgs(proto, a), name);
    return call(orig, a);
  };
  const wrapNet = (name: string) => (orig: Fn) => (...a: unknown[]) => {
    const host = netHost(a);
    if (host !== null && !isLoopbackHost(host)) throw new OfflineViolation(host, name);
    return call(orig, a);
  };
  const wrapDns = (name: string) => (orig: Fn) => (...a: unknown[]) => {
    const host = dnsHost(a);
    if (host !== '' && !isLoopbackHost(host)) throw new OfflineViolation(host, name);
    return call(orig, a);
  };
  patch(http, 'request', wrapHttp('http:', 'http.request'));
  patch(http, 'get', wrapHttp('http:', 'http.get'));
  patch(https, 'request', wrapHttp('https:', 'https.request'));
  patch(https, 'get', wrapHttp('https:', 'https.get'));
  patch(net, 'connect', wrapNet('net.connect'));
  patch(net, 'createConnection', wrapNet('net.createConnection'));
  patch(tls, 'connect', wrapNet('tls.connect'));
  patch(dns, 'lookup', wrapDns('dns.lookup'));
  patch(dns.promises, 'lookup', wrapDns('dns.promises.lookup'));
  // Without this, `import { get } from "node:https"` and namespace imports
  // keep the original functions: only the default export object was patched.
  syncBuiltinESMExports();
  return uninstallOfflineGuard;
}

/** Restore the primitives replaced by {@link installOfflineGuard}. */
export function uninstallOfflineGuard(): void {
  if (installed === null) return;
  globalThis.fetch = installed.fetch;
  for (const { obj, key, orig } of installed.patched.reverse()) obj[key] = orig;
  installed = null;
  syncBuiltinESMExports();
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
