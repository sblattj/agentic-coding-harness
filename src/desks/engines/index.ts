// Engine factory (#204). opencode -> OpenCodeEngine (serve + HTTP), every other agent -> DriverEngine
// (each turn = one core driver run with resume, recorded as a child run). Owners: engine seats.
import type { Engine, EngineKind } from "../types.ts";

export function engineKindFor(agent: string): EngineKind {
  return agent === "opencode" ? "opencode" : "driver";
}

export async function createEngine(kind: EngineKind): Promise<Engine> {
  if (kind === "opencode") return new (await import("./opencode.ts")).OpenCodeEngine();
  return new (await import("./driver.ts")).DriverEngine();
}
