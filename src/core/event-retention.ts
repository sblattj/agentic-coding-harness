// Bounded event buffers (#197, #199). A long interactive run streams events
// for as long as a person keeps typing, so neither the adapter's queue nor
// the driver's RunResult.events may grow with the transcript.
import type { AgentEvent } from "./types.ts";

/**
 * Single-consumer event queue between an adapter and the driver (#197).
 * attach() releases each event once it is yielded, so memory is bounded by
 * the unconsumed window, not by the transcript length. Events pushed before
 * attach() wait in the queue. Because consumed events are gone, a second
 * attach() only sees what the first has not taken; the driver attaches once
 * per run.
 */
export class EventQueue<T = AgentEvent> {
  #items: Array<T | undefined> = [];
  #head = 0;
  #done = false;
  readonly #waiters = new Set<() => void>();

  push(e: T): void {
    this.#items.push(e);
    this.#wake();
  }

  /** No more events: attach() returns once it has drained the rest. */
  close(): void {
    this.#done = true;
    this.#wake();
  }

  /** Events still held (pushed, not yet yielded). */
  get retained(): number {
    return this.#items.length - this.#head;
  }

  /** Array slots in use, consumed holes included (tests: proves compaction). */
  get capacity(): number {
    return this.#items.length;
  }

  async *attach(): AsyncGenerator<T> {
    for (;;) {
      while (this.#head < this.#items.length) {
        const e = this.#items[this.#head]!;
        this.#items[this.#head++] = undefined; // free the payload now
        this.#compact();
        yield e;
      }
      if (this.#done) return;
      await new Promise<void>((r) => this.#waiters.add(r));
    }
  }

  #compact(): void {
    if (this.#head === this.#items.length) {
      this.#items = [];
      this.#head = 0;
    } else if (this.#head >= 1024 && this.#head * 2 >= this.#items.length) {
      this.#items = this.#items.slice(this.#head);
      this.#head = 0;
    }
  }

  #wake(): void {
    for (const w of this.#waiters) w();
    this.#waiters.clear();
  }
}

/**
 * The events a RunResult keeps (#199). With no cap it keeps every event, as
 * before. With a cap it keeps the last `cap` events in order (a ring buffer)
 * and counts the rest, so memory stays bounded however long the run goes.
 */
export class EventTail {
  readonly cap: number | undefined;
  #ring: AgentEvent[] = [];
  #start = 0;
  #total = 0;

  constructor(cap?: number) {
    this.cap = cap !== undefined && Number.isFinite(cap) && cap > 0 ? Math.floor(cap) : undefined;
  }

  push(e: AgentEvent): void {
    this.#total++;
    if (this.cap === undefined || this.#ring.length < this.cap) {
      this.#ring.push(e);
      return;
    }
    this.#ring[this.#start] = e;
    this.#start = (this.#start + 1) % this.cap;
  }

  /** Events seen, kept or not. */
  get total(): number {
    return this.#total;
  }

  /** Events held right now (at most cap). */
  get retained(): number {
    return this.#ring.length;
  }

  /** The kept events, oldest first. */
  toArray(): AgentEvent[] {
    if (this.#start === 0) return this.#ring.slice();
    return [...this.#ring.slice(this.#start), ...this.#ring.slice(0, this.#start)];
  }
}
