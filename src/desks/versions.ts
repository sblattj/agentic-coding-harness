// ach version comparison shared by `ach desk reload --stale` (service.ts staleDesks, from the
// roster's achVersion) and the host's automatic reload after an upgrade (auto-reload.ts).

/** -1, 0, 1 comparing dotted numeric versions (a pre-release tag after "-" is ignored). */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string): number[] => v.split("-")[0]!.split(".").map((x) => Number.parseInt(x, 10) || 0);
  const pa = parts(a);
  const pb = parts(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}
