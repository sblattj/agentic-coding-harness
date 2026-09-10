// Kiro token tap via mitmproxy.
//
// startKiroMitm() spawns `mitmdump` with an inline-generated addon that watches
// kiro traffic and emits one JSON line per metering/metadata EventStream frame.
//
// To route kiro-cli through the tap (no cert pinning as of kiro-cli 2.10, so a
// mitmproxy CA cert is trusted directly):
//
//   HTTPS_PROXY=http://127.0.0.1:8888 \
//   SSL_CERT_FILE=~/.mitmproxy/mitmproxy-ca-cert.pem \
//   kiro-cli chat --no-interactive --trust-all-tools --output-format stream-json --v3 "<prompt>"
//
// tapEnv() below builds exactly that env. Create the CA first: `mitmproxy`
// writes it on first run.
//
// parseMitmLine() emits the core CanonicalTokenRecord (src/core/types.ts):
// inputTokens is UNCACHED input (the AWS uncachedInputTokens), cache slices map
// to cacheReadTokens/cacheWriteTokens, and kiro-specifics (totalTokens,
// credits, contextUsagePercentage, event, url, raw line) ride in `extra` —
// canonical semantics keep no stored total (derive at render time).

import { spawn as nodeSpawn, spawnSync, type ChildProcessByStdio } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import type { Readable } from 'node:stream';
import type { CanonicalTokenRecord } from '../core/types.js';

export const DEFAULT_MITM_PORT = 8888;

export const METADATA_EVENTS = ['messageMetadataEvent', 'metadataEvent', 'meteringEvent'] as const;

export interface TokenUsage {
  uncachedInputTokens: number;
  cacheReadInputTokens: number;
  cacheWriteInputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface MitmEmitLine {
  event: string;
  tokenUsage: TokenUsage;
  credits: number | string | null;
  contextUsagePercentage: number | null;
  ts: number;
  url?: string;
}

// parseMitmLine() below returns the core CanonicalTokenRecord (the historical
// local TODO-MERGE mirror of it was deleted at integration time; kiro
// specifics ride in `extra`).

// ---------------------------------------------------------------------------
// AWS EventStream framing (TS mirror of the Python addon, used for tests and
// offline replay of captured streams).
//
// Frame layout (big-endian throughout):
//   [0..4)   total frame length (headers + payload + trailer included)
//   [4..8)   headers length
//   [8..12)  CRC32 of bytes [0..8)          (prelude CRC)
//   [12..12+headers_len) header blocks
//   [...  total-4)       payload
//   [total-4..total)     CRC32 of bytes [0..total-4) (message CRC)
//
// Header block: 1-byte name length, name (utf8), 1-byte value type, value.
// Value types: 0 true, 1 false, 2 byte, 3 short, 4 int, 5 long, 6 byte-array
// (u16 length prefix), 7 string (u16 length prefix), 8 timestamp (i64 ms),
// 9 uuid (16 bytes). `:event-type` (type 7) carries the event name.
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? (0xedb88320 ^ (c >>> 1)) >>> 0 : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = ((CRC_TABLE[(c ^ (buf[i] ?? 0)) & 0xff] ?? 0) ^ (c >>> 8)) >>> 0;
  }
  return (c ^ 0xffffffff) >>> 0;
}

export type EventStreamHeaderValue = string | number | boolean | Buffer;

export function parseEventStreamHeaders(blob: Buffer): Record<string, EventStreamHeaderValue> {
  const headers: Record<string, EventStreamHeaderValue> = {};
  let off = 0;
  while (off + 2 <= blob.length) {
    const nameLen = blob[off++] ?? 0;
    if (off + nameLen + 1 > blob.length) return headers;
    const name = blob.subarray(off, off + nameLen).toString('utf8');
    off += nameLen;
    const vtype = blob[off++];
    try {
      switch (vtype) {
        case 0:
          headers[name] = true;
          break;
        case 1:
          headers[name] = false;
          break;
        case 2:
          headers[name] = blob[off] ?? 0;
          off += 1;
          break;
        case 3:
          headers[name] = blob.readInt16BE(off);
          off += 2;
          break;
        case 4:
          headers[name] = blob.readInt32BE(off);
          off += 4;
          break;
        case 5:
        case 8:
          headers[name] = Number(blob.readBigInt64BE(off));
          off += 8;
          break;
        case 6: {
          const len = blob.readUInt16BE(off);
          off += 2;
          headers[name] = Buffer.from(blob.subarray(off, off + len));
          off += len;
          break;
        }
        case 7: {
          const len = blob.readUInt16BE(off);
          off += 2;
          headers[name] = blob.subarray(off, off + len).toString('utf8');
          off += len;
          break;
        }
        case 9:
          headers[name] = Buffer.from(blob.subarray(off, off + 16)).toString('hex');
          off += 16;
          break;
        default:
          return headers;
      }
    } catch {
      return headers;
    }
  }
  return headers;
}

export interface EventStreamFrame {
  eventType: string | null;
  headers: Record<string, EventStreamHeaderValue>;
  payload: Buffer;
}

// Tolerant streaming parser: parses well-formed consecutive frames and stops
// at the first malformed/truncated/CRC-failed one (never throws).
export function parseEventStreamFrames(data: Uint8Array): EventStreamFrame[] {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const frames: EventStreamFrame[] = [];
  let off = 0;
  while (off + 12 <= buf.length) {
    const total = buf.readUInt32BE(off);
    const headersLen = buf.readUInt32BE(off + 4);
    if (total < 16 || off + total > buf.length || headersLen + 12 + 4 > total) break;
    if (buf.readUInt32BE(off + 8) !== crc32(buf.subarray(off, off + 8))) break;
    if (buf.readUInt32BE(off + total - 4) !== crc32(buf.subarray(off, off + total - 4))) break;
    const headers = parseEventStreamHeaders(buf.subarray(off + 12, off + 12 + headersLen));
    const payload = Buffer.from(buf.subarray(off + 12 + headersLen, off + total - 4));
    const eventType = typeof headers[':event-type'] === 'string' ? (headers[':event-type'] as string) : null;
    frames.push({ eventType, headers, payload });
    off += total;
  }
  return frames;
}

function encodeStringHeader(name: string, value: string): Buffer {
  const nameBuf = Buffer.from(name, 'utf8');
  const valBuf = Buffer.from(value, 'utf8');
  const out = Buffer.alloc(1 + nameBuf.length + 1 + 2 + valBuf.length);
  let o = 0;
  out[o++] = nameBuf.length;
  nameBuf.copy(out, o);
  o += nameBuf.length;
  out[o++] = 7;
  out.writeUInt16BE(valBuf.length, o);
  o += 2;
  valBuf.copy(out, o);
  return out;
}

// Test/replay helper: builds one valid EventStream frame with string headers.
export function buildEventStreamFrame(eventType: string, payload: Uint8Array | string | object): Buffer {
  const payloadBuf = Buffer.isBuffer(payload)
    ? payload
    : Buffer.from(typeof payload === 'string' ? payload : JSON.stringify(payload), 'utf8');
  const headers = Buffer.concat([
    encodeStringHeader(':message-type', 'event'),
    encodeStringHeader(':content-type', 'application/json'),
    encodeStringHeader(':event-type', eventType),
  ]);
  const total = 12 + headers.length + payloadBuf.length + 4;
  const frame = Buffer.alloc(total);
  frame.writeUInt32BE(total, 0);
  frame.writeUInt32BE(headers.length, 4);
  frame.writeUInt32BE(crc32(frame.subarray(0, 8)), 8);
  headers.copy(frame, 12);
  payloadBuf.copy(frame, 12 + headers.length);
  frame.writeUInt32BE(crc32(frame.subarray(0, total - 4)), total - 4);
  return frame;
}

// ---------------------------------------------------------------------------
// Line normalization shared by the addon (Python) and TS consumers.
// ---------------------------------------------------------------------------

function toNum(v: unknown, dflt = 0): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return dflt;
}

function toNumOrNull(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = toNum(v, Number.NaN);
  return Number.isFinite(n) ? n : null;
}

function normalizeTokenUsage(tu: Record<string, unknown>): TokenUsage {
  return {
    uncachedInputTokens: toNum(tu.uncachedInputTokens),
    cacheReadInputTokens: toNum(tu.cacheReadInputTokens),
    cacheWriteInputTokens: toNum(tu.cacheWriteInputTokens),
    outputTokens: toNum(tu.outputTokens),
    totalTokens: toNum(tu.totalTokens ?? tu.total),
  };
}

// TS mirror of the addon's emit shape: converts one parsed metadata frame into
// the JSON line the addon would print. Returns null for non-metering frames.
export function frameToMitmLine(frame: EventStreamFrame, ts = Date.now() / 1000, url?: string): MitmEmitLine | null {
  if (!frame.eventType || !(METADATA_EVENTS as readonly string[]).includes(frame.eventType)) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(frame.payload.toString('utf8'));
  } catch {
    return null;
  }
  if (typeof obj !== 'object' || obj === null) return null;
  const o = obj as Record<string, unknown>;
  const tu = (o.tokenUsage ?? {}) as Record<string, unknown>;
  return {
    event: frame.eventType,
    tokenUsage: normalizeTokenUsage(tu),
    credits: (o.credits ?? o.units ?? null) as number | string | null,
    contextUsagePercentage: toNumOrNull(o.contextUsagePercentage ?? o.contextUsage),
    ts,
    ...(url ? { url } : {}),
  };
}

// Converts one addon stdout line into a core CanonicalTokenRecord; non-JSON
// lines (mitmdump banners, warnings) and malformed objects yield null.
export function parseMitmLine(line: string, now = Date.now()): CanonicalTokenRecord | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{')) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const o = parsed as Record<string, unknown>;
  if (typeof o.event !== 'string' || o.event.length === 0) return null;
  const tu = (o.tokenUsage ?? {}) as Record<string, unknown>;
  const hasTokenFields = ['uncachedInputTokens', 'cacheReadInputTokens', 'cacheWriteInputTokens', 'outputTokens', 'totalTokens'].some(
    (k) => k in tu,
  );
  if (!hasTokenFields && o.credits === undefined && o.contextUsagePercentage === undefined) return null;
  const timestamp = typeof o.ts === 'number' && Number.isFinite(o.ts) ? Math.round(o.ts * 1000) : now;
  const extra: Record<string, unknown> = {
    event: o.event,
    totalTokens: toNum(tu.totalTokens ?? tu.total),
    credits: toNumOrNull(o.credits ?? o.units),
    contextUsagePercentage: toNumOrNull(o.contextUsagePercentage ?? o.contextUsage),
    raw: o,
  };
  if (typeof o.url === 'string') extra.url = o.url;
  return {
    agent: 'kiro',
    ...(typeof o.model === 'string' && o.model !== '' ? { model: o.model } : {}),
    inputTokens: toNum(tu.uncachedInputTokens),
    outputTokens: toNum(tu.outputTokens),
    cacheReadTokens: toNum(tu.cacheReadInputTokens),
    cacheWriteTokens: toNum(tu.cacheWriteInputTokens),
    timestamp,
    extra,
  };
}

// ---------------------------------------------------------------------------
// Inline mitmproxy addon (written to a temp file and passed via `mitmdump -s`).
// ---------------------------------------------------------------------------

export const KIRO_MITM_ADDON = String.raw`"""kiro-mitm addon: AWS EventStream token tap for kiro-cli traffic.

Loaded by mitmdump (-s). Prints one JSON line per metering/metadata frame:
{"event": ..., "tokenUsage": {...}, "credits": ..., "contextUsagePercentage": ..., "ts": ..., "url": ...}

Direct run supports a selftest: python3 <this file> --selftest <hex-encoded frame>
"""
from __future__ import annotations

import json
import os
import re
import struct
import sys
import time
import zlib

try:
    from mitmproxy import http  # type: ignore
except ImportError:  # allows running the selftest directly without mitmproxy
    http = None

WATCH_RE = re.compile(
    r"(codewhisperer\.[^/?#]*\.amazonaws\.com/generateAssistantResponse"
    r"|runtime\.[^/?#]*\.kiro\.dev)"
)

METADATA_EVENTS = ("messageMetadataEvent", "metadataEvent", "meteringEvent")


def _parse_headers(blob):
    """Parse AWS EventStream header blocks into a dict (best-effort)."""
    headers = {}
    off = 0
    n = len(blob)
    while off + 2 <= n:
        name_len = blob[off]
        off += 1
        if off + name_len + 1 > n:
            return headers
        name = blob[off:off + name_len].decode("utf-8", "replace")
        off += name_len
        vtype = blob[off]
        off += 1
        try:
            if vtype == 0:
                headers[name] = True
            elif vtype == 1:
                headers[name] = False
            elif vtype == 2:
                headers[name] = blob[off]
                off += 1
            elif vtype == 3:
                (headers[name],) = struct.unpack_from(">h", blob, off)
                off += 2
            elif vtype == 4:
                (headers[name],) = struct.unpack_from(">i", blob, off)
                off += 4
            elif vtype in (5, 8):
                (headers[name],) = struct.unpack_from(">q", blob, off)
                off += 8
            elif vtype == 6:
                (vlen,) = struct.unpack_from(">H", blob, off)
                off += 2
                headers[name] = blob[off:off + vlen]
                off += vlen
            elif vtype == 7:
                (vlen,) = struct.unpack_from(">H", blob, off)
                off += 2
                headers[name] = blob[off:off + vlen].decode("utf-8", "replace")
                off += vlen
            elif vtype == 9:
                headers[name] = blob[off:off + 16].hex()
                off += 16
            else:
                return headers
        except struct.error:
            return headers
    return headers


def parse_eventstream(data):
    """Yield (headers, payload) per frame; stop at the first bad frame."""
    off = 0
    n = len(data)
    while off + 12 <= n:
        total, headers_len = struct.unpack_from(">II", data, off)
        if total < 16 or off + total > n or headers_len + 12 + 4 > total:
            return
        (prelude_crc,) = struct.unpack_from(">I", data, off + 8)
        if (zlib.crc32(data[off:off + 8]) & 0xFFFFFFFF) != prelude_crc:
            return
        (msg_crc,) = struct.unpack_from(">I", data, off + total - 4)
        if (zlib.crc32(data[off:off + total - 4]) & 0xFFFFFFFF) != msg_crc:
            return
        headers = _parse_headers(data[off + 12:off + 12 + headers_len])
        payload = data[off + 12 + headers_len:off + total - 4]
        yield headers, payload
        off += total


def _num(value, default=0):
    try:
        f = float(value)
        return f
    except (TypeError, ValueError):
        return default


def handle_frames(data, url=""):
    for headers, payload in parse_eventstream(data):
        event_type = headers.get(":event-type")
        if event_type not in METADATA_EVENTS:
            continue
        if os.environ.get("KIRO_MITM_DEBUG"):
            sys.stderr.write(
                f"FRAME {event_type} {url} {payload[:400]!r}\n"
            )
            sys.stderr.flush()
        try:
            obj = json.loads(payload.decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            continue
        if not isinstance(obj, dict):
            continue
        tu = obj.get("tokenUsage") or {}
        line = {
            "event": event_type,
            "tokenUsage": {
                "uncachedInputTokens": int(_num(tu.get("uncachedInputTokens"))),
                "cacheReadInputTokens": int(_num(tu.get("cacheReadInputTokens"))),
                "cacheWriteInputTokens": int(_num(tu.get("cacheWriteInputTokens"))),
                "outputTokens": int(_num(tu.get("outputTokens"))),
                "totalTokens": int(_num(tu.get("totalTokens", tu.get("total")))),
            },
            "credits": obj.get("credits", obj.get("usage", obj.get("units"))),
            "contextUsagePercentage": obj.get(
                "contextUsagePercentage", obj.get("contextUsage")
            ),
            "ts": time.time(),
        }
        if url:
            line["url"] = url
        print(json.dumps(line), flush=True)


def response(flow) -> None:
    if http is None:
        return
    if not WATCH_RE.search(flow.request.pretty_url):
        return
    body = flow.response.content
    if body is None:
        body = flow.response.raw_content or b""
    handle_frames(body, flow.request.pretty_url)


def _selftest(hex_frame):
    handle_frames(bytes.fromhex(hex_frame))


if __name__ == "__main__":
    args = sys.argv[1:]
    if "--selftest" in args:
        idx = args.index("--selftest")
        _selftest(args[idx + 1])
`;

export function writeAddonScript(dir: string = os.tmpdir()): string {
  const file = path.join(dir, `kiro-mitm-addon-${process.pid}.py`);
  writeFileSync(file, KIRO_MITM_ADDON, { mode: 0o755 });
  return file;
}

// ---------------------------------------------------------------------------
// Auto-tap helpers (used by KiroAdapter.launch; src/adapters/kiro.ts)
// ---------------------------------------------------------------------------

/**
 * First bindable TCP port in [from, to] on 127.0.0.1, or null when the whole
 * range is taken. Each candidate is bound and immediately released; a race
 * between release and mitmdump's own bind is possible but harmless (mitmdump
 * errors out, the tap yields no records, the run itself is unaffected).
 */
export async function findKiroMitmPort(
  from = 8900,
  to = 8999,
  host = '127.0.0.1',
): Promise<number | null> {
  const canBind = (port: number): Promise<boolean> =>
    new Promise((resolve) => {
      const srv = net.createServer();
      srv.once('error', () => resolve(false));
      srv.listen(port, host, () => srv.close(() => resolve(true)));
    });
  for (let port = from; port <= to; port++) {
    if (await canBind(port)) return port;
  }
  return null;
}

let mitmdumpProbe: { bin: string; available: boolean } | null = null;

/**
 * Cached existence probe for the mitmdump binary: paths containing '/' are
 * checked with existsSync, bare names via `command -v` through /bin/sh.
 * Probed at most once per binary per process.
 */
export function mitmdumpAvailable(bin: string = process.env.MITMDUMP_BIN ?? 'mitmdump'): boolean {
  if (mitmdumpProbe?.bin === bin) return mitmdumpProbe.available;
  const available = bin.includes('/')
    ? existsSync(bin)
    : spawnSync('/bin/sh', ['-c', `command -v ${bin}`], { stdio: 'ignore' }).status === 0;
  mitmdumpProbe = { bin, available };
  return available;
}

// Env to launch kiro-cli through the tap (see module comment).
export function tapEnv(
  port: number = DEFAULT_MITM_PORT,
  caPath: string = path.join(os.homedir(), '.mitmproxy', 'mitmproxy-ca-cert.pem'),
): NodeJS.ProcessEnv {
  return { HTTPS_PROXY: `http://127.0.0.1:${port}`, SSL_CERT_FILE: caPath };
}

export interface KiroMitmHandle extends EventEmitter {
  port: number;
  child: ChildProcessByStdio<null, Readable, Readable>;
  scriptPath: string;
  stop(): Promise<void>;
}

export interface KiroMitmOptions {
  scriptPath?: string;
  mitmdumpBin?: string;
  env?: Record<string, string>;
}

// Emits: 'record' (CanonicalTokenRecord), 'line' (raw stdout line),
// 'stderr' (mitmdump log line), 'error' (spawn failure, e.g. mitmdump missing).
export function startKiroMitm(port: number = DEFAULT_MITM_PORT, opts: KiroMitmOptions = {}): KiroMitmHandle {
  const scriptPath = opts.scriptPath ?? writeAddonScript();
  const bin = opts.mitmdumpBin ?? process.env.MITMDUMP_BIN ?? 'mitmdump';
  const child = nodeSpawn(bin, ['-p', String(port), '-s', scriptPath], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...(opts.env ?? {}) },
  });
  const handle = new EventEmitter() as KiroMitmHandle;
  handle.port = port;
  handle.child = child;
  handle.scriptPath = scriptPath;

  const rl = createInterface({ input: child.stdout });
  rl.on('line', (line) => {
    handle.emit('line', line);
    const rec = parseMitmLine(line);
    if (rec) handle.emit('record', rec);
    else handle.emit('unparsed', line);
  });
  const rlErr = createInterface({ input: child.stderr });
  rlErr.on('line', (line) => handle.emit('stderr', line));
  child.on('error', (err) => handle.emit('error', err));

  handle.stop = () =>
    new Promise((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) return resolve();
      let settled = false;
      const settle = (): void => {
        if (settled) return;
        settled = true;
        resolve();
      };
      child.once('close', settle);
      child.kill('SIGTERM');
      const t = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      }, 2000);
      t.unref();
      // Hard ceiling: a grandchild inheriting the stdio pipes can hold
      // 'close' open; never let stop() hang run resolution.
      const ceiling = setTimeout(settle, 3000);
      ceiling.unref();
    });

  return handle;
}
