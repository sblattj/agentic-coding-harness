// desks.yaml loading (#204). Owner: roster seat. Signatures frozen in wave 0.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { validName } from "./roster.ts";
import type { Layout } from "./types.ts";

const here = dirname(fileURLToPath(import.meta.url));

/** Candidate dirs holding a bundled asset: next to the bundle (dist/cli/<name>), then the repo root (src/desks/../../<name>). */
function assetCandidates(name: string): string[] {
  return [join(here, name), join(here, "..", "..", name)];
}

/** Absolute path of the built-in roles/ dir (repo root roles/, or next to the bundle in dist). */
export function builtinRolesDir(): string {
  const c = assetCandidates("roles");
  return c.find((p) => existsSync(p)) ?? resolve(here, "..", "..", "roles");
}

function builtinDefaultFile(): string {
  const c = assetCandidates("desks.default.yaml");
  return c.find((p) => existsSync(p)) ?? resolve(here, "..", "..", "desks.default.yaml");
}

/** The built-in default layout (ORCHESTRATOR, DECISIONS, LISTENER), from the repo's desks.default.yaml. */
export function defaultLayout(): Layout {
  const f = builtinDefaultFile();
  return parseLayout(readFileSync(f, "utf8"), f);
}

/** Find + parse + validate + fill defaults. Search: explicit, ./desks.yaml, ~/.config/ach/desks.yaml, built-in. Throws with a field path on invalid input. */
export function loadLayout(file?: string): { layout: Layout; file: string | null } {
  const candidates: string[] = [];
  if (file) {
    const f = resolve(file);
    if (!existsSync(f)) throw new Error(`desks: layout file not found: ${f}`);
    candidates.push(f);
  } else {
    candidates.push(resolve("desks.yaml"), join(homedir(), ".config", "ach", "desks.yaml"));
  }
  for (const f of candidates) {
    if (existsSync(f)) return { layout: parseLayout(readFileSync(f, "utf8"), f), file: f };
  }
  return { layout: defaultLayout(), file: null };
}

const strList = z.array(z.string());
const cmd = z.array(z.string()).min(1, "must be a non-empty argv array");

const feedSchema = z.object({
  command: cmd,
  fullContext: cmd.optional(),
  activeCheck: cmd.optional(),
  batchSeconds: z.number().positive().optional(),
  immediate: strList.optional(),
  heartbeatType: z.string().optional(),
  endType: z.string().optional(),
});

const deskSchema = z.object({
  name: z.string(),
  role: z.string().min(1),
  agent: z.string().optional(),
  model: z.string().optional(),
  mcps: strList.default([]),
  pane: z.enum(["left", "right-top", "right-bottom", "none"]).optional(),
  feed: feedSchema.optional(),
  cwd: z.string().optional(),
});

const lanesSchema = z.object({
  defaultMcps: strList.default([]),
  ports: z.tuple([z.number().int(), z.number().int()]).default([10, 99]),
  approval: z.enum(["decisions", "none"]).optional(),
  defaultGoalFlags: z.string().optional(),
  agent: z.string().optional(),
  model: z.string().optional(),
  budgetUsd: z.number().nonnegative().optional(),
});

const layoutSchema = z.object({
  portBase: z.number().int().default(4800),
  stack: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/, "must be a simple name").optional(),
  agent: z.string().optional(),
  model: z.string().optional(),
  cwd: z.string().optional(),
  rolesDir: z.string().optional(),
  mcpServers: z
    .record(z.string(), z.object({ command: z.string(), args: strList.optional(), env: z.record(z.string(), z.string()).optional() }))
    .optional(),
  desks: z.array(deskSchema),
  lanes: lanesSchema.default({ defaultMcps: [], ports: [10, 99], approval: "none" }),
});

const fieldPath = (path: PropertyKey[]): string =>
  path.reduce<string>((acc, seg) => (typeof seg === "number" ? `${acc}[${seg}]` : acc ? `${acc}.${String(seg)}` : String(seg)), "");

function fail(source: string, path: string, msg: string): never {
  throw new Error(`desks: invalid layout ${source}: ${path ? `${path}: ` : ""}${msg}`);
}

/** Parse YAML or JSON text into a validated Layout (throws with a field path). */
export function parseLayout(text: string, source: string): Layout {
  let raw: unknown;
  try {
    raw = parseYaml(text); // YAML 1.2 is a JSON superset
  } catch (e) {
    throw new Error(`desks: cannot parse layout ${source}: ${(e as Error).message}`);
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) fail(source, "", "expected a mapping at the top level");
  const r = layoutSchema.safeParse(raw);
  if (!r.success) {
    const i = r.error.issues[0]!;
    fail(source, fieldPath(i.path), i.message);
  }
  const p = r.data;

  const seen = new Set<string>();
  p.desks.forEach((d, i) => {
    if (!validName(d.name, "desk")) fail(source, `desks[${i}].name`, `invalid desk name "${d.name}" (want /^[A-Z][A-Z0-9_-]{0,31}$/)`);
    if (seen.has(d.name)) fail(source, `desks[${i}].name`, `duplicate "${d.name}"`);
    seen.add(d.name);
  });

  const [lo, hi] = p.lanes.ports;
  if (lo > hi) fail(source, "lanes.ports", `[${lo}, ${hi}] must be ascending`);
  if (lo < 1) fail(source, "lanes.ports[0]", `${lo} must be >= 1`);
  const lastDesk = p.portBase + p.desks.length; // desk i = portBase + 1 + i
  if (p.portBase < 1) fail(source, "portBase", `${p.portBase} must be >= 1`);
  if (lastDesk + 1 > p.portBase + lo - 1) {
    fail(source, "lanes.ports[0]", `${lo} overlaps the ${p.desks.length} desk port(s) ${p.portBase + 1}..${lastDesk}; use at least ${p.desks.length + 2}`);
  }
  if (p.portBase + hi > 65535) fail(source, "lanes.ports[1]", `portBase + ${hi} = ${p.portBase + hi} exceeds 65535`);

  const layout: Layout = {
    portBase: p.portBase,
    stack: p.stack ?? (p.portBase === 4800 ? "default" : `p${p.portBase}`),
    agent: p.agent,
    model: p.model,
    cwd: p.cwd,
    rolesDir: p.rolesDir && !isAbsolute(p.rolesDir) && source && isAbsolute(source) ? resolve(dirname(source), p.rolesDir) : p.rolesDir,
    mcpServers: p.mcpServers,
    desks: p.desks.map((d) => ({
      ...d,
      agent: d.agent ?? p.agent ?? "opencode",
      model: d.model ?? p.model,
    })),
    lanes: { ...p.lanes, ports: p.lanes.ports as [number, number] },
  };
  return stripUndefined(layout);
}

function stripUndefined<T>(v: T): T {
  if (Array.isArray(v)) return v.map(stripUndefined) as T;
  if (v && typeof v === "object") {
    const o: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) if (x !== undefined) o[k] = stripUndefined(x);
    return o as T;
  }
  return v;
}

/** [common.md, <role>.md] absolute paths: layout.rolesDir first, then builtin. Throws when <role>.md is missing everywhere. */
export function roleFiles(layout: Layout, role: string): string[] {
  const dirs = [...(layout.rolesDir ? [layout.rolesDir] : []), builtinRolesDir()];
  const find = (file: string): string | undefined => dirs.map((d) => join(d, file)).find((p) => existsSync(p));
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(role)) throw new Error(`desks: invalid role name "${role}"`);
  const common = find("common.md");
  if (!common) throw new Error(`desks: roles/common.md not found in: ${dirs.join(", ")}`);
  const specific = find(`${role}.md`);
  if (!specific) throw new Error(`desks: role file ${role}.md not found in: ${dirs.join(", ")}`);
  return [common, specific].map((p) => resolve(p));
}

/** Port of desk index i / of lane slot k. */
export function deskPort(layout: Layout, index: number): number {
  return layout.portBase + 1 + index;
}
