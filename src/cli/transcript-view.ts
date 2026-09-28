// Read-only dashboard projection. These rows are never persisted to the registry.
import { createHash } from 'node:crypto';
import { descriptorDirs, loadAgentDescriptors, readDescriptorTap } from '../core/agent-descriptors.ts';
import { withPricingHints } from '../core/pricing-hints.ts';
import { createPricer } from '../core/pricing.ts';
import type { RunRecord } from '../core/registry.ts';
import { scanAll, type ScanOptions } from '../monitors/transcripts.ts';
import { drainTranscriptWarnings } from '../monitors/transcript-warnings.ts';
import { reportCatalogIssues } from './custom-agents.ts';

export async function transcriptView(dir: string, runs: RunRecord[], scan: ScanOptions = {}): Promise<RunRecord[]> {
  const claimed = new Set(runs.filter((r) => r.sessionId).map((r) => `${r.agent}\0${r.sessionId}`));
  const rows = new Map<string, RunRecord>();
  const pricer = createPricer();
  const add = (agent: string, session: string | null, origin: string, ts: string | null, input: number, output: number, read: number, write: number, cost: number | undefined, reported: boolean): void => {
    const key = `${agent}\0${session ?? origin}`;
    if (claimed.has(key)) return; // native transcripts mirror harness-owned sessions
    const time = ts ? Date.parse(ts) : NaN;
    const at = Number.isFinite(time) ? time : 0;
    let r = rows.get(key);
    if (!r) {
      r = { runId: `transcript-${createHash('sha256').update(key).digest('hex').slice(0, 24)}`, agent,
        ...(session ? { sessionId: session } : {}), startedAt: at, updatedAt: at,
        source: 'external', metadata: { source: 'transcript' }, lastEvent: 'source: transcript',
        totals: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 },
        usage: { tokens: { available: true, source: 'tap' }, credits: { available: false }, usd: { available: cost !== undefined } } };
      rows.set(key, r);
    }
    r.startedAt = Math.min(r.startedAt, at);
    r.updatedAt = Math.max(r.updatedAt ?? 0, at);
    r.endedAt = r.updatedAt;
    r.totals!.inputTokens += input; r.totals!.outputTokens += output;
    r.totals!.cacheReadTokens += read; r.totals!.cacheWriteTokens += write;
    r.totals!.costUsd += cost ?? 0;
    if (cost === undefined) r.usage!.usd.available = false;
    if (cost !== undefined) r.totals!.costSource = !reported || r.totals!.costSource === 'computed' ? 'computed' : 'reported';
  };
  for await (const r of scanAll(scan)) {
    const price = r.model ? pricer.price({ model: r.model, inputTokens: r.input, outputTokens: r.output, cacheReadTokens: r.cacheRead, cacheWriteTokens: r.cacheWrite }) : NaN;
    add(r.agent, r.sessionId, r.sourcePath ?? '', r.timestamp, r.input, r.output, r.cacheRead, r.cacheWrite, Number.isFinite(price) ? price : undefined, false);
  }
  const catalog = loadAgentDescriptors({ dirs: descriptorDirs({ cwd: process.cwd(), stateDir: dir }) });
  reportCatalogIssues(catalog);
  const warnings: string[] = [];
  for (const descriptor of catalog.descriptors) {
    const priced = descriptor.descriptor.pricingHints ? withPricingHints(pricer, descriptor.descriptor.pricingHints, descriptor.file) : pricer;
    for (const r of await readDescriptorTap(descriptor)) {
      const value = r.costUsd ?? (r.model ? priced.price({ model: r.model, inputTokens: r.inputTokens, outputTokens: r.outputTokens, cacheReadTokens: r.cacheReadTokens, cacheWriteTokens: r.cacheWriteTokens }) : NaN);
      add(r.agent, r.sessionId, descriptor.file, r.ts, r.inputTokens, r.outputTokens, r.cacheReadTokens, r.cacheWriteTokens, Number.isFinite(value) ? value : undefined, r.costUsd !== undefined);
    }
    if (priced !== pricer) warnings.push(...priced.drainWarnings());
  }
  for (const w of [...warnings, ...drainTranscriptWarnings(), ...pricer.drainWarnings()]) process.stderr.write(`[warn] ${w}\n`);
  return [...rows.values()];
}
