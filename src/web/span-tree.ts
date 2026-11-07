import type { Span } from "./derive.ts";

/**
 * Pure span tree (#65): the waterfall's flat Span[] regrouped by `parentId`.
 * Nodes carry only the span id and shape, never a copy of the span, so the
 * waterfall and the tree always describe the same underlying spans (the
 * client joins by id).
 */
export interface SpanTreeNode {
  id: string;
  children: SpanTreeNode[];
  /** Number of spans below this node (0 for a leaf). */
  descendants: number;
}

/**
 * Group spans under their parents, children in start order (ties keep the
 * derivation order). Spans whose parent is absent or null become roots, so a
 * truncated list still renders. A parent cycle makes its members roots.
 */
export function buildSpanTree(spans: Span[]): SpanTreeNode[] {
  const nodes = new Map<string, SpanTreeNode>();
  for (const s of spans) nodes.set(s.id, { id: s.id, children: [], descendants: 0 });
  const order = new Map<string, number>();
  spans.forEach((s, i) => order.set(s.id, i));
  const start = new Map(spans.map((s) => [s.id, s.startMs] as const));
  const roots: SpanTreeNode[] = [];
  for (const s of spans) {
    const node = nodes.get(s.id)!;
    const parent = s.parentId !== null ? nodes.get(s.parentId) : undefined;
    if (parent !== undefined && parent !== node) parent.children.push(node);
    else roots.push(node);
  }
  const byStart = (a: SpanTreeNode, b: SpanTreeNode): number =>
    (start.get(a.id) ?? 0) - (start.get(b.id) ?? 0) || (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0);
  const seen = new Set<string>();
  const finish = (n: SpanTreeNode): number => {
    if (seen.has(n.id)) return 0;
    seen.add(n.id);
    n.children.sort(byStart);
    let total = 0;
    for (const c of n.children) total += 1 + finish(c);
    n.descendants = total;
    return total;
  };
  roots.sort(byStart);
  for (const r of roots) finish(r);
  // A parent cycle (a<->b) is unreachable from any root: promote its members
  // (in span order) to roots instead of dropping them.
  for (const s of spans) {
    const node = nodes.get(s.id)!;
    if (seen.has(node.id)) continue;
    const parent = s.parentId !== null ? nodes.get(s.parentId) : undefined;
    if (parent !== undefined) parent.children = parent.children.filter((c) => c !== node);
    roots.push(node);
    finish(node);
  }
  roots.sort(byStart);
  return roots;
}
