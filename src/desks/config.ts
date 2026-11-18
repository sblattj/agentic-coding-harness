// desks.yaml loading (#204). Owner: roster seat. Signatures frozen in wave 0.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { reservedName, STACK_NAME_RE, validName } from "./roster.ts";
import { ENGINE_PORT_OFFSET, type Layout } from "./types.ts";
import { stateDir } from "../core/store.ts";
import { VERSION } from "../version.ts";
import { BUILTIN_DESK_ASSETS } from "./builtin-assets.gen.ts";

const here = dirname(fileURLToPath(import.meta.url));

/** Candidate dirs holding a bundled asset: next to the bundle (dist/cli/<name>), then the repo root (src/desks/../../<name>). */
function assetCandidates(name: string): string[] {
  return [join(here, name), join(here, "..", "..", name)];
}

/**
 * Single-file builds (the bun-compiled binary, the PyPI _vendor/ach.mjs bundle) have no
 * roles/ or desks.default.yaml beside them. Write the embedded copies once to
 * <stateDir>/desks/builtin/<version>/ and use that dir, so hosts still get real file paths.
 */
export function materializeBuiltinAssets(dir: string = join(stateDir(), "desks", "builtin", VERSION)): string {
  for (const [rel, text] of Object.entries(BUILTIN_DESK_ASSETS)) {
    const f = join(dir, rel);
    if (existsSync(f) && readFileSync(f, "utf8") === text) continue;
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, text);
  }
  return dir;
}

/** Absolute path of the built-in roles/ dir (repo root roles/, next to the bundle in dist, else the embedded copy). */
export function builtinRolesDir(): string {
  const c = assetCandidates("roles");
  return c.find((p) => existsSync(join(p, "common.md"))) ?? join(materializeBuiltinAssets(), "roles");
}

function builtinDefaultFile(): string {
  const c = assetCandidates("desks.default.yaml");
  return c.find((p) => existsSync(p)) ?? join(materializeBuiltinAssets(), "desks.default.yaml");
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
  stack: z.string().regex(STACK_NAME_RE, "must be a simple name").optional(),
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
    if (reservedName(d.name)) fail(source, `desks[${i}].name`, `"${d.name}" is reserved (the human's identity)`);
    if (!validName(d.name, "desk")) fail(source, `desks[${i}].name`, `invalid desk name "${d.name}" (want /^[A-Z][A-Z0-9_-]{0,31}$/)`);
    if (seen.has(d.name)) fail(source, `desks[${i}].name`, `duplicate "${d.name}"`);
    seen.add(d.name);
  });

  const [lo, hi] = p.lanes.ports;
  if (lo > hi) fail(source, "lanes.ports", `[${lo}, ${hi}] must be ascending`);
  if (lo < 1) fail(source, "lanes.ports[0]", `${lo} must be >= 1`);
  const lastDesk = p.portBase + p.desks.length; // desk i = portBase + 1 + i
  if (p.portBase < 1) fail(source, "portBase", `${p.portBase} must be >= 1`);
  // Desks occupy offsets 1..N, so the first lane offset may be N + 1 (adjacent, no overlap).
  if (p.portBase + lo <= lastDesk) {
    fail(source, "lanes.ports[0]", `${lo} overlaps the ${p.desks.length} desk port(s) ${p.portBase + 1}..${lastDesk}; use at least ${p.desks.length + 1}`);
  }
  if (p.portBase + hi > 65535) fail(source, "lanes.ports[1]", `portBase + ${hi} = ${p.portBase + hi} exceeds 65535`);
  // Every desk and lane on port P may run its opencode engine on P + ENGINE_PORT_OFFSET (the agent is chosen per
  // desk, per lane request, and on desk switch), so those ports are reserved too: no host port may equal another
  // host's engine port, and no engine port may pass 65535. Desks sit below lanes, so engine ports of desks never
  // overlap engine ports of lanes when the host ports do not.
  const E = ENGINE_PORT_OFFSET;
  const n = p.desks.length;
  if (p.portBase + hi + E > 65535) {
    fail(source, "lanes.ports[1]", `the opencode engine port of the last lane, portBase + ${hi} + ${E} = ${p.portBase + hi + E}, exceeds 65535`);
  }
  if (n > E) fail(source, "desks", `${n} desks: desk ports ${p.portBase + 1}..${lastDesk} overlap their own opencode engine ports (desk port + ${E}); use at most ${E} desks`);
  if (n > 0 && lo <= n + E && hi >= 1 + E) {
    fail(
      source,
      "lanes.ports",
      `lane ports ${p.portBase + lo}..${p.portBase + hi} overlap the desks' opencode engine ports ${p.portBase + 1 + E}..${lastDesk + E} (desk port + ${E})`,
    );
  }
  if (hi - lo >= E) {
    fail(source, "lanes.ports", `[${lo}, ${hi}] spans ${hi - lo + 1} ports: a lane port would equal another lane's opencode engine port (lane port + ${E}); keep the range under ${E} ports wide`);
  }

  const layout: Layout = {
    portBase: p.portBase,
    stack: p.stack ?? (p.portBase === 4800 ? "default" : `p${p.portBase}`),
    agent: p.agent,
    model: p.model,
    cwd: p.cwd,
    rolesDir: resolveRolesDir(p.rolesDir, source),
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

/** `~` and `~/x` mean the home directory; any other relative path is relative to the layout file. */
function resolveRolesDir(dir: string | undefined, source: string | undefined): string | undefined {
  if (!dir) return dir;
  const expanded = dir === "~" ? homedir() : dir.startsWith("~/") ? join(homedir(), dir.slice(2)) : dir;
  return !isAbsolute(expanded) && source && isAbsolute(source) ? resolve(dirname(source), expanded) : expanded;
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
