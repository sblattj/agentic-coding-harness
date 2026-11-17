// DriverEngine (#204). Owner: driver engine seat. Implements the Engine contract in ../types.ts.
import type { Engine, EngineEvent, GoalStatus, HostSpec } from "../types.ts";

const NI = (fn: string): never => {
  throw new Error(`desks: DriverEngine.${fn} not implemented yet`);
};

export class DriverEngine implements Engine {
  readonly kind = "driver" as const;
  async start(_spec: HostSpec): Promise<{ sessionId?: string; engineUrl?: string; childPid?: number }> {
    return NI("start");
  }
  async send(_text: string): Promise<void> {
    NI("send");
  }
  async note(_text: string): Promise<void> {
    NI("note");
  }
  async state(): Promise<"busy" | "idle"> {
    return NI("state");
  }
  async setGoal(_objective: string): Promise<void> {
    NI("setGoal");
  }
  async goalStatus(): Promise<GoalStatus> {
    return NI("goalStatus");
  }
  async mcpStatus(): Promise<Record<string, string>> {
    return NI("mcpStatus");
  }
  attachCommand(): string[] {
    return NI("attachCommand");
  }
  onEvent(_cb: (e: EngineEvent) => void): void {
    NI("onEvent");
  }
  async stop(): Promise<void> {
    NI("stop");
  }
}
