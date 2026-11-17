// JSONL feed runner (#204, guide section 7). Owner: feeds seat.
import type { FeedSpec } from "./types.ts";

export interface FeedHandle {
  pid: number;
  stop(): Promise<void>;
}

/**
 * Start `spec.command`; deliver(text) is called with each message for the desk:
 * full context on the first heartbeat when active (else a waiting note), batched
 * events every batchSeconds, immediate events at once, a closing message on endType.
 */
export function startFeed(_spec: FeedSpec, _deliver: (text: string) => Promise<void>, _opts?: {
    cwd?: string;
    env?: Record<string, string>;
    /** Feed lifecycle notes and errors (spawn failure, exit, malformed line) -> host 'feed' / 'error' events. */
    onNote?: (note: string) => void;
    onError?: (error: string) => void;
  }): FeedHandle {
  throw new Error("desks: startFeed not implemented yet");
}
