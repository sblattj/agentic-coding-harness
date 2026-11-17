// HTTP client for the Host API (#204). Owner: host seat. Signatures frozen in wave 0.
import type { DeskMessage, GoalStatus, HostEvent, HostEventType, HostHealth, Sender } from "./types.ts";

const NI = (fn: string): never => {
  throw new Error(`desks: ${fn} not implemented yet`);
};

export async function hostHealth(_url: string, _timeoutMs?: number): Promise<HostHealth | null> {
  return NI("hostHealth");
}
export async function hostSend(_url: string, _from: Sender, _text: string): Promise<Pick<DeskMessage, "id" | "delivered">> {
  return NI("hostSend");
}
export async function hostNote(_url: string, _text: string): Promise<void> {
  NI("hostNote");
}
export async function hostRecord(_url: string, _type: HostEventType, _data: Record<string, unknown>): Promise<number> {
  return NI("hostRecord");
}
export async function hostGoal(_url: string): Promise<GoalStatus> {
  return NI("hostGoal");
}
export async function hostSetGoal(_url: string, _objective: string): Promise<void> {
  NI("hostSetGoal");
}
export async function hostMcp(_url: string): Promise<Record<string, string>> {
  return NI("hostMcp");
}
export async function hostEvents(_url: string, _since?: number): Promise<HostEvent[]> {
  return NI("hostEvents");
}
/** SSE subscription; returns an unsubscribe function. */
export function hostSubscribe(_url: string, _since: number, _onEvent: (e: HostEvent) => void): () => void {
  return NI("hostSubscribe");
}
export async function hostAttach(_url: string): Promise<string[]> {
  return NI("hostAttach");
}
export async function hostStop(_url: string): Promise<void> {
  NI("hostStop");
}
