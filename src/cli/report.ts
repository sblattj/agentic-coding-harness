// `harness report` — render a self-contained single-file HTML comparison of
// agent trial runs (per-agent RunResult JSON + .secs + .stderr artifacts).
import fs from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { HarnessError } from "../core/types.ts";
import { loadTrials } from "../report/model.ts";
import { readVersion, renderReport } from "../report/html.ts";

export async function cmdReport(rest: string[]): Promise<number> {
  const args = parseArgs({
    args: rest,
    options: { out: { type: "string" } },
    allowPositionals: true,
  });
  const roots = args.positionals;
  if (roots.length === 0) {
    throw new HarnessError("report requires a trials directory (e.g. trials/20260910-091011)", "USAGE");
  }

  // One positional may expand to many trials (a `trials/` root scans its
  // subdirectories); several positionals are reported side by side.
  let runs: Awaited<ReturnType<typeof loadTrials>>["runs"] = [];
  const labels = new Set<string>();
  let rootDir: string | null = null;
  for (const root of roots) {
    const trialSet = await loadTrials(root);
    if (rootDir === null) rootDir = trialSet.rootDir;
    runs = runs.concat(trialSet.runs);
    for (const l of trialSet.labels) labels.add(l);
  }
  const root = rootDir ?? path.resolve(roots[0] ?? ".");

  const out =
    args.values.out ??
    (roots.length === 1 ? path.join(root, "report.html") : path.resolve("report.html"));
  const html = renderReport(
    { rootDir: root, labels: [...labels].sort(), runs },
    { version: await readVersion(), generatedAt: new Date() },
  );
  await fs.mkdir(path.dirname(path.resolve(out)), { recursive: true });
  await fs.writeFile(out, html);
  process.stdout.write(
    `wrote ${out} (${runs.length} runs · ${labels.size} trial${labels.size === 1 ? "" : "s"})\n`,
  );
  return 0;
}
