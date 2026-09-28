// Registry of read-only transcript sources: CLIs whose local session files
// ach meters but never launches (#22). Contract and per-CLI matrix:
// docs/transcript-adapters.md.
//
// Adding a CLI = one parser module + one entry below + fixtures/tests. No
// change to src/core: these agents are deliberately NOT in core AGENTS, so
// `ach run --agent <x>` cannot reach the driver (cmdRun rejects them with
// readOnlySourceMessage()).

import { basename, dirname, extname, join } from "node:path";
import type { CanonicalTokenRecord } from "./transcripts.ts";
import { parseAmpThread } from "./amp.ts";
import { parseGooseDb } from "./goose.ts";
import { parseQwenChat } from "./qwen.ts";

export interface TranscriptSource {
  /** Agent label stamped on every record (also the `--agent` filter value). */
  agent: CanonicalTokenRecord["agent"];
  /** Root directories walked recursively when no override is given. */
  defaultRoots(home: string): string[];
  /** Which files under a root are this source's transcripts. */
  keep(filePath: string): boolean;
  /** Parse one file. Must never throw: skip bad records and warn instead. */
  parse(filePath: string): Promise<CanonicalTokenRecord[]>;
}

export const TRANSCRIPT_SOURCES: readonly TranscriptSource[] = [
  {
    agent: "amp",
    defaultRoots: (home) => [join(home, ".local", "share", "amp", "threads")],
    keep: (f) => extname(f) === ".json",
    parse: (f) => parseAmpThread(f),
  },
  {
    agent: "goose",
    defaultRoots: (home) => [
      join(home, ".local", "share", "goose", "sessions"),
      join(home, "Library", "Application Support", "goose", "sessions"),
      join(home, ".local", "share", "Block", "goose", "sessions"),
    ],
    keep: (f) => basename(f) === "sessions.db",
    parse: (f) => parseGooseDb(f),
  },
  {
    agent: "qwen",
    defaultRoots: (home) => [join(home, ".qwen", "projects")],
    keep: (f) => extname(f) === ".jsonl" && basename(dirname(f)) === "chats",
    parse: (f) => parseQwenChat(f),
  },
];

export type TranscriptOnlyAgent = "amp" | "goose" | "qwen";

export function isTranscriptOnlyAgent(a: string): a is TranscriptOnlyAgent {
  return TRANSCRIPT_SOURCES.some((s) => s.agent === a);
}

/** Error text for `ach run --agent <read-only source>`. */
export function readOnlySourceMessage(agent: string): string {
  return (
    `'${agent}' is a read-only transcript source: ach meters its local session files ` +
    `but cannot launch it. Use 'ach stats --agent ${agent}' or 'ach watch' instead ` +
    `(see docs/transcript-adapters.md).`
  );
}
