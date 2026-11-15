// PTY relay over a Unix socket (#195).
//
// The `ach run --interactive` process serves its LivePty here; `ach web`
// (browser tiles) and `ach attach` (a terminal) connect as clients. Several
// clients can watch at once; every client can type (single-writer
// arbitration is not built yet).
//
// Wire format: one JSON object per line, both directions.
//   server -> client  {t:"hello", runId, sessionId, agent, cols, rows, steps}
//                     {t:"scrollback", d}   (always the 2nd frame; may be "")
//                     {t:"out", d}          raw PTY bytes, ANSI intact
//                     {t:"state", steps}    --then progress / pause state
//                     {t:"exit", code}      then the server closes the socket
//   client -> server  {t:"in", d} keystrokes · {t:"resize", cols, rows}
//                     {t:"continue"} release a --pause-between pause
import { StringDecoder } from "node:string_decoder";
import { rmSync } from "node:fs";
import net from "node:net";

export interface LiveTarget {
  readonly alive: boolean;
  readonly exitCode: number | null;
  readonly size: { cols: number; rows: number };
  scrollback(): string;
  onData(cb: (d: string) => void): () => void;
  onExit(cb: (code: number) => void): () => void;
  write(data: string): boolean;
  resize(cols: number, rows: number): boolean;
}

/** `--then` progress, shown by `ach attach`, the web tile and the owner. */
export interface StepState {
  /** Prompts queued with --then. */
  total: number;
  /** How many of them were typed into the TUI so far. */
  sent: number;
  /** --pause-between: true while the next step waits for a keypress or button. */
  waiting: boolean;
  /** The next prompt, when one is queued. */
  next?: string;
}

export interface LiveControls {
  state(): StepState | null;
  /** Release a pause. False when nothing is waiting. */
  continue(): boolean;
  onState(cb: (s: StepState) => void): () => void;
}

export interface LiveServerOptions {
  socketPath: string;
  runId: string;
  sessionId: string;
  agent: string;
  target: LiveTarget;
  controls?: LiveControls;
}

export interface LiveServerHandle {
  readonly socketPath: string;
  /** Connected clients right now. */
  clients(): number;
  close(): Promise<void>;
}

type Frame = Record<string, unknown> & { t: string };

/** Unflushed bytes a client may queue before it is dropped. A viewer that
 *  stops reading (a frozen browser tab) would otherwise grow the run
 *  process's memory without bound; a dropped viewer reconnects and gets the
 *  scrollback again. */
export const MAX_CLIENT_BACKLOG = 8 * 1024 * 1024;

function send(sock: net.Socket, frame: Frame): void {
  if (sock.destroyed || !sock.writable) return;
  if (sock.writableLength > MAX_CLIENT_BACKLOG) {
    sock.destroy();
    return;
  }
  sock.write(JSON.stringify(frame) + "\n");
}

/** Split a byte stream into JSON frames; malformed lines are dropped. */
export function frameReader(onFrame: (f: Frame) => void): (chunk: Buffer | string) => void {
  let buf = "";
  // A multi-byte character can straddle two socket chunks; the decoder holds
  // the partial bytes until the rest arrives instead of emitting U+FFFD.
  const decoder = new StringDecoder("utf8");
  return (chunk) => {
    buf += typeof chunk === "string" ? chunk : decoder.write(chunk);
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (line.trim() === "") continue;
      try {
        const f = JSON.parse(line) as unknown;
        if (typeof f === "object" && f !== null && typeof (f as Frame).t === "string") onFrame(f as Frame);
      } catch {
        /* skip */
      }
    }
  };
}

export async function startLiveServer(opts: LiveServerOptions): Promise<LiveServerHandle> {
  const { target, controls } = opts;
  const sockets = new Set<net.Socket>();
  if (process.platform !== "win32") rmSync(opts.socketPath, { force: true });

  const server = net.createServer((sock) => {
    sockets.add(sock);
    const offs: Array<() => void> = [];
    const cleanup = () => {
      for (const off of offs.splice(0)) off();
      sockets.delete(sock);
    };
    sock.on("close", cleanup);
    sock.on("error", () => sock.destroy());
    send(sock, {
      t: "hello",
      runId: opts.runId,
      sessionId: opts.sessionId,
      agent: opts.agent,
      cols: target.size.cols,
      rows: target.size.rows,
      steps: controls?.state() ?? null,
    });
    send(sock, { t: "scrollback", d: target.scrollback() });
    if (!target.alive) {
      send(sock, { t: "exit", code: target.exitCode });
      sock.end();
      return;
    }
    offs.push(target.onData((d) => send(sock, { t: "out", d })));
    offs.push(
      target.onExit((code) => {
        send(sock, { t: "exit", code });
        sock.end();
      }),
    );
    if (controls !== undefined) offs.push(controls.onState((s) => send(sock, { t: "state", steps: s })));
    sock.on(
      "data",
      frameReader((f) => {
        if (f.t === "in" && typeof f.d === "string") target.write(f.d);
        else if (f.t === "resize") target.resize(Number(f.cols), Number(f.rows));
        else if (f.t === "continue") controls?.continue();
      }),
    );
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });

  return {
    socketPath: opts.socketPath,
    clients: () => sockets.size,
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => {
          if (process.platform !== "win32") rmSync(opts.socketPath, { force: true });
          resolve();
        });
      }),
  };
}

export interface LiveHello {
  runId: string;
  sessionId: string;
  agent: string;
  cols: number;
  rows: number;
  steps: StepState | null;
}

export interface LiveClientHandlers {
  onHello?: (h: LiveHello) => void;
  onScrollback?: (d: string) => void;
  onOut?: (d: string) => void;
  onState?: (s: StepState) => void;
  onExit?: (code: number | null) => void;
  /** Socket closed (after exit, on detach, or the owner went away). */
  onClose?: () => void;
}

export interface LiveClient {
  input(d: string): void;
  resize(cols: number, rows: number): void;
  continueStep(): void;
  close(): void;
}

/** Connect to a run's PTY relay. Resolves once connected. */
export function connectLive(socketPath: string, h: LiveClientHandlers): Promise<LiveClient> {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(socketPath);
    let connected = false;
    sock.once("connect", () => {
      connected = true;
      resolve({
        input: (d) => send(sock, { t: "in", d }),
        resize: (cols, rows) => send(sock, { t: "resize", cols, rows }),
        continueStep: () => send(sock, { t: "continue" }),
        close: () => sock.end(),
      });
    });
    sock.on("error", (err) => {
      if (!connected) reject(err);
    });
    sock.on("close", () => h.onClose?.());
    sock.on(
      "data",
      frameReader((f) => {
        if (f.t === "hello") h.onHello?.(f as unknown as LiveHello);
        else if (f.t === "scrollback") h.onScrollback?.(String(f.d ?? ""));
        else if (f.t === "out") h.onOut?.(String(f.d ?? ""));
        else if (f.t === "state") h.onState?.(f.steps as StepState);
        else if (f.t === "exit") h.onExit?.(typeof f.code === "number" ? f.code : null);
      }),
    );
  });
}

/** Read a run's hello frame (size, session, --then state) and disconnect. */
export function probeLive(socketPath: string, timeoutMs = 2000): Promise<LiveHello> {
  return new Promise((resolve, reject) => {
    let done = false;
    let client: LiveClient | null = null;
    const timer = setTimeout(() => finish(new Error("live socket did not answer")), timeoutMs);
    const finish = (err: Error | null, hello?: LiveHello) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      client?.close();
      if (err) reject(err);
      else resolve(hello!);
    };
    connectLive(socketPath, {
      onHello: (h) => finish(null, h),
      onClose: () => finish(new Error("live socket closed before hello")),
    }).then(
      (c) => {
        client = c;
        if (done) c.close();
      },
      (err: Error) => finish(err),
    );
  });
}

/** Send one `continue` and disconnect. */
export async function continueLive(socketPath: string): Promise<void> {
  const c = await connectLive(socketPath, {});
  c.continueStep();
  await new Promise((r) => setTimeout(r, 50));
  c.close();
}
