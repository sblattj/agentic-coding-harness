// Warning sink shared by the read-only transcript parsers.
//
// Contract (docs/transcript-adapters.md): a parser never throws on bad input.
// A record it cannot read is skipped and one line is pushed here; the caller
// (`ach stats`, `ach watch`) drains the sink to stderr as `[warn] ...`, the
// same shape the pricer uses (createPricer().drainWarnings()).

const pending: string[] = [];

/** Record one skipped-record / unreadable-file warning. */
export function warnTranscript(message: string): void {
  pending.push(message);
}

/** Return and clear every warning recorded since the last drain. */
export function drainTranscriptWarnings(): string[] {
  return pending.splice(0, pending.length);
}

/** A warning callback; parsers accept one so tests can capture per call. */
export type WarnFn = (message: string) => void;
