// Descriptor pricing hints (#38): per-model per-1M USD overrides layered over
// the bundled pricer for one agents.d agent.
//
// Honesty rules:
//  - a record that carries a provider-REPORTED costUsd is never re-priced: the
//    reported number is returned and stamped `provenance: "reported"`;
//  - a hinted model is priced from the hint and stamped `provenance:
//    "computed"` with `source: "<descriptor file>#pricingHints"`, plus one
//    warning per model naming the hint source, so a hint is never silent;
//  - any other model falls through to the bundled pricer untouched.
// The stamp lives on record.extra.pricing, which rides RunResult.tokens.
import type { Pricer } from './pricing.js';
import type { CanonicalTokenRecord } from './types.js';

/** Per-1M-token USD prices for one model. */
export interface PricingHint {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
}

export interface PricingProvenance {
  provenance: 'reported' | 'computed';
  source?: string;
}

function stamp(rec: CanonicalTokenRecord, pricing: PricingProvenance): void {
  rec.extra = { ...(rec.extra ?? {}), pricing };
}

export function withPricingHints(base: Pricer, hints: Record<string, PricingHint>, sourceFile: string): Pricer {
  const source = `${sourceFile}#pricingHints`;
  const byKey = new Map<string, PricingHint>();
  for (const [model, hint] of Object.entries(hints)) {
    byKey.set(model.toLowerCase(), hint);
    byKey.set(base.resolveAlias(model), hint);
  }
  const warned = new Set<string>();
  const warnings: string[] = [];

  return {
    price(rec: CanonicalTokenRecord): number {
      if (typeof rec.costUsd === 'number' && Number.isFinite(rec.costUsd)) {
        stamp(rec, { provenance: 'reported' });
        return rec.costUsd;
      }
      const model = rec.model;
      const hint = model ? (byKey.get(model.toLowerCase()) ?? byKey.get(base.resolveAlias(model))) : undefined;
      if (!hint || !model) return base.price(rec);
      if (!warned.has(model)) {
        warned.add(model);
        warnings.push(`pricing: model "${model}" priced from ${source} (provenance: computed)`);
      }
      stamp(rec, { provenance: 'computed', source });
      return (
        ((rec.inputTokens ?? 0) * hint.input +
          (rec.cacheReadTokens ?? 0) * (hint.cacheRead ?? 0) +
          (rec.cacheWriteTokens ?? 0) * (hint.cacheWrite ?? 0) +
          (rec.outputTokens ?? 0) * hint.output) /
        1_000_000
      );
    },
    resolveAlias: base.resolveAlias,
    drainWarnings(): string[] {
      return [...warnings.splice(0, warnings.length), ...base.drainWarnings()];
    },
  };
}
