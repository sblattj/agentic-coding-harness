// Flush stdout/stderr before a forced process.exit (#128).
//
// When stdout is a pipe, writes can be asynchronous: `stream.write()` queues
// the bytes and returns false, and the stream emits 'drain' once the queue has
// reached the kernel. process.exit() does not wait for that queue, so a large
// payload (e.g. `ach dash --json --all | wc -c`) was cut off at the pipe
// buffer size (64 KiB in compiled binaries, 128 KiB from source under Bun).
//
// The old guard, an empty `write("", cb)`, is not enough on Bun: its callback
// fires before earlier queued bytes drain, and Bun reports writableLength 0 /
// writableNeedDrain false while bytes are still queued. The one signal both
// runtimes agree on is the write() return value plus the 'drain' event, so we
// record backpressure at write time and wait for 'drain' at exit time.

type Stdio = NodeJS.WriteStream;

const pending = new WeakMap<Stdio, boolean>();
const tracked = new WeakSet<Stdio>();

function defaultStreams(): Stdio[] {
  return [process.stdout, process.stderr];
}

/**
 * Wrap write() on each stream so a `false` return (backpressure) is remembered
 * until the stream emits 'drain'. Idempotent; call once at CLI start.
 */
export function trackStdioBackpressure(streams: Stdio[] = defaultStreams()): void {
  for (const stream of streams) {
    if (tracked.has(stream)) continue;
    tracked.add(stream);
    const original = stream.write;
    const wrapped = function (this: Stdio, ...args: unknown[]): boolean {
      const ok = (original as (...a: unknown[]) => boolean).apply(this, args);
      if (!ok) pending.set(stream, true);
      return ok;
    };
    stream.write = wrapped as Stdio["write"];
    stream.on("drain", () => pending.set(stream, false));
  }
}

function waitForDrain(stream: Stdio): Promise<void> {
  return new Promise<void>((resolve) => {
    if (stream.destroyed || stream.writableEnded) return resolve();
    const needsDrain = pending.get(stream) === true || stream.writableNeedDrain === true;
    const done = (): void => {
      stream.off("drain", onDrain);
      stream.off("error", done);
      stream.off("close", done);
      resolve();
    };
    const onDrain = (): void => {
      // A write issued after the first false return can still be queued;
      // only stop once no backpressure remains.
      if (pending.get(stream) === true || stream.writableNeedDrain === true) return;
      done();
    };
    if (!needsDrain) return resolve();
    // Registered after the tracker's own 'drain' listener, so pending is
    // already cleared by the time onDrain runs.
    stream.on("drain", onDrain);
    stream.once("error", done);
    stream.once("close", done);
  }).then(() => new Promise<void>((resolve) => {
    // Belt and braces for Node: an empty write's callback runs after every
    // previously queued chunk has been handed to the OS.
    if (stream.destroyed || stream.writableEnded) return resolve();
    try {
      stream.write("", () => resolve());
    } catch {
      resolve();
    }
  }));
}

/** Resolve once stdout and stderr have handed all queued bytes to the OS. */
export async function flushStdio(streams: Stdio[] = defaultStreams()): Promise<void> {
  await Promise.all(streams.map(waitForDrain));
}

/** Flush stdout/stderr, then process.exit(code). Use for every forced exit. */
export async function flushAndExit(code: number): Promise<never> {
  try {
    await flushStdio();
  } finally {
    process.exit(code);
  }
}
