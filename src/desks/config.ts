// desks.yaml loading (#204). Owner: roster seat. Signatures frozen in wave 0.
import type { Layout } from "./types.ts";

const NI = (fn: string): never => {
  throw new Error(`desks: ${fn} not implemented yet`);
};

/** Absolute path of the built-in roles/ dir (repo root roles/, or next to the bundle in dist). */
export function builtinRolesDir(): string {
  return NI("builtinRolesDir");
}

/** The built-in default layout (ORCHESTRATOR, DECISIONS, LISTENER), from the repo's desks.default.yaml. */
export function defaultLayout(): Layout {
  return NI("defaultLayout");
}

/** Find + parse + validate + fill defaults. Search: explicit, ./desks.yaml, ~/.config/ach/desks.yaml, built-in. Throws with a field path on invalid input. */
export function loadLayout(_file?: string): { layout: Layout; file: string | null } {
  return NI("loadLayout");
}

/** Parse YAML or JSON text into a validated Layout (throws with a field path). */
export function parseLayout(_text: string, _source: string): Layout {
  return NI("parseLayout");
}

/** [common.md, <role>.md] absolute paths: layout.rolesDir first, then builtin. Throws when <role>.md is missing everywhere. */
export function roleFiles(_layout: Layout, _role: string): string[] {
  return NI("roleFiles");
}

/** Port of desk index i / of lane slot k. */
export function deskPort(_layout: Layout, _index: number): number {
  return NI("deskPort");
}
