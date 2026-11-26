// CLI glue for export masking (#71): flags -> policy, preview listing, counts.
// The detectors and the chokepoint live in src/core/masking.ts.
import { HarnessError } from "../core/types.ts";
import {
  formatMaskedNote,
  formatPreview,
  resolveMaskPolicy,
  type Finding,
  type MaskFlags,
  type MaskPolicy,
  type MaskSink,
} from "../core/masking.ts";
import { loadedMaskConfig } from "./config.ts";

/** The policy for `sink`: --mask flags > env > config file `mask` > DEFAULT_MASK_MODE. */
export function maskPolicyFor(sink: MaskSink, flags: MaskFlags): MaskPolicy {
  try {
    return resolveMaskPolicy({ sink, flags, config: loadedMaskConfig() });
  } catch (e) {
    throw new HarnessError(e instanceof Error ? e.message : String(e), "USAGE");
  }
}

/** `--mask preview` output: one line per finding, then a summary; nothing was written or sent. */
export function writeMaskPreview(source: string, findings: readonly Finding[], out: NodeJS.WritableStream = process.stdout): void {
  out.write(formatPreview(source, findings));
}

/** `--mask all` note on stderr, so masking is never silent. */
export function noteMasked(source: string, findings: readonly Finding[]): void {
  process.stderr.write(formatMaskedNote(source, findings));
}
