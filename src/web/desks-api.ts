// Desks Web API (#205): every /api/desks route of `ach web`. Contract: WEB API block
// in src/desks/types.ts. Returns true when it handled the request. Filled by the web seat.
import type { IncomingMessage, ServerResponse } from "node:http";

export interface DesksApiOptions {
  stateDir: string;
  token?: string;
}

export async function handleDesksApi(
  _req: IncomingMessage,
  _res: ServerResponse,
  _url: URL,
  _opts: DesksApiOptions,
): Promise<boolean> {
  return false;
}
