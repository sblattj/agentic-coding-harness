/**
 * Scripted fake `kiro-cli acp` server.
 *
 * Speaks the same newline-delimited JSON-RPC 2.0 dialect on stdio that
 * kiro-cli 2.21.2 does, replaying the REAL recorded traffic in
 * `acp-prompt-2.21.2.jsonl` for the `ok` scenario (client `>> ` lines are
 * stripped; response ids are rewritten to match the incoming request).
 *
 * Every automated test drives this, never the paid binary.
 *
 * Env:
 *   FAKE_ACP_SCENARIO   see SCENARIOS below (default `ok`)
 *   FAKE_ACP_STDIN_LOG  optional path; every client→server line is appended,
 *                       which is how tests assert message ORDER.
 */

import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

type Json = Record<string, unknown>;

export const SCENARIOS = [
  'ok',
  'silent-initialize',
  'slow-initialize',
  'reject-model',
  'wrong-mode',
  'permission',
  'mcp-fail',
  'crash-mid-prompt',
  'ignore-sigterm',
  'fs-request',
] as const;
export type FakeAcpScenario = (typeof SCENARIOS)[number];

const scenario = (process.env.FAKE_ACP_SCENARIO ?? 'ok') as FakeAcpScenario;
const stdinLog = process.env.FAKE_ACP_STDIN_LOG;

// ---------------------------------------------------------------------------
// Fixture replay table: method -> { notifications[], result }
// ---------------------------------------------------------------------------

interface Step {
  notifications: Json[];
  result: Json;
}

function loadFixture(): Map<string, Step> {
  const text = readFileSync(join(import.meta.dirname, 'acp-prompt-2.21.2.jsonl'), 'utf8');
  const steps = new Map<string, Step>();
  let current: Step | null = null;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('!! ')) continue;
    if (line.startsWith('>> ')) {
      const req = JSON.parse(line.slice(3)) as Json;
      current = { notifications: [], result: {} };
      steps.set(String(req.method), current);
      continue;
    }
    const msg = JSON.parse(line) as Json;
    if (!current) continue;
    if (msg.id !== undefined && msg.id !== null) current.result = (msg.result ?? {}) as Json;
    else current.notifications.push(msg);
  }
  return steps;
}

const FIXTURE = loadFixture();

function stepFor(method: string): Step {
  return FIXTURE.get(method) ?? { notifications: [], result: {} };
}

// ---------------------------------------------------------------------------
// Wire helpers
// ---------------------------------------------------------------------------

function send(msg: Json): void {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

function respond(id: unknown, result: unknown): void {
  send({ jsonrpc: '2.0', result, id } as Json);
}

function respondError(id: unknown, code: number, message: string): void {
  send({ jsonrpc: '2.0', error: { code, message }, id } as Json);
}

function emit(notifications: Json[]): void {
  for (const n of notifications) send(n);
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Server→client requests awaiting a client response, keyed by our own id. */
const outbound = new Map<number, (msg: Json) => void>();
let outboundId = 9000;

function ask(method: string, params: unknown): Promise<Json> {
  const id = outboundId++;
  return new Promise<Json>((resolve) => {
    outbound.set(id, resolve);
    send({ jsonrpc: '2.0', id, method, params } as Json);
  });
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async function handle(req: Json): Promise<void> {
  const { id, method } = req;
  const params = (req.params ?? {}) as Json;

  switch (method) {
    case 'initialize': {
      if (scenario === 'silent-initialize') return; // never answers, by design
      if (scenario === 'slow-initialize') await sleep(1500);
      respond(id, stepFor('initialize').result);
      return;
    }

    case 'session/new': {
      const step = stepFor('session/new');
      emit(step.notifications);
      const result = structuredClone(step.result) as Json;
      if (scenario === 'wrong-mode') {
        const modes = result.modes as Json;
        modes.currentModeId = 'kiro_default';
      }
      respond(id, result);
      if (scenario === 'mcp-fail') {
        send({
          jsonrpc: '2.0',
          method: '_kiro.dev/mcp/governance_disabled',
          params: { sessionId: result.sessionId, apiFailure: true },
        } as Json);
      }
      return;
    }

    case 'session/load': {
      respond(id, {});
      return;
    }

    case 'session/set_model': {
      if (scenario === 'reject-model') {
        respondError(id, -32602, `model '${String(params.modelId)}' is not supported`);
        return;
      }
      emit(stepFor('session/set_model').notifications);
      respond(id, {});
      return;
    }

    case 'session/prompt': {
      const step = stepFor('session/prompt');
      if (scenario === 'crash-mid-prompt') {
        send(step.notifications[0] as Json);
        await sleep(20);
        process.exit(1);
      }
      if (scenario === 'fs-request') {
        // The recorded 2.21.2 run never asked for fs, but the agent may: the
        // client advertises fs:false, so both of these must come back -32601.
        const readAnswer = await ask('fs/read_text_file', { sessionId: params.sessionId, path: '/etc/hosts' });
        const termAnswer = await ask('terminal/create', { sessionId: params.sessionId, command: 'ls' });
        respond(id, {
          stopReason: 'end_turn',
          _probe: { read: readAnswer.error, terminal: termAnswer.error },
        });
        return;
      }
      if (scenario === 'permission') {
        const answer = await ask('session/request_permission', {
          sessionId: params.sessionId,
          toolCall: { toolCallId: 'tooluse_fake', title: 'read', kind: 'read' },
          options: [
            { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
            { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
          ],
        });
        const outcome = ((answer.result as Json | undefined)?.outcome ?? {}) as Json;
        send({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: params.sessionId,
            update: {
              sessionUpdate: 'tool_call_update',
              toolCallId: 'tooluse_fake',
              status: outcome.outcome === 'selected' ? 'completed' : 'failed',
              _meta: { permissionOutcome: outcome.outcome ?? 'unknown' },
            },
          },
        } as Json);
        respond(id, { stopReason: outcome.outcome === 'selected' ? 'end_turn' : 'refusal' });
        return;
      }
      emit(step.notifications);
      respond(id, step.result);
      return;
    }

    case 'session/cancel':
      return; // notification; nothing to answer

    default:
      if (id !== undefined && id !== null) respondError(id, -32601, `Method not found: ${String(method)}`);
      return;
  }
}

// ---------------------------------------------------------------------------
// stdio loop
// ---------------------------------------------------------------------------

if (scenario === 'ignore-sigterm') {
  process.on('SIGTERM', () => {
    /* deliberately ignored so the SIGKILL path is exercised */
  });
  // Keep the loop alive after stdin ends; otherwise node would exit on its own
  // and the test would never reach the kill path.
  setInterval(() => {}, 1000);
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk: string) => {
  buf += chunk;
  let idx: number;
  while ((idx = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, idx);
    buf = buf.slice(idx + 1);
    if (!line.trim()) continue;
    if (stdinLog) appendFileSync(stdinLog, `${line}\n`);
    let msg: Json;
    try {
      msg = JSON.parse(line) as Json;
    } catch {
      continue;
    }
    // A response to one of OUR requests (has an id but no method).
    if (msg.method === undefined && msg.id !== undefined) {
      const waiter = outbound.get(Number(msg.id));
      if (waiter) {
        outbound.delete(Number(msg.id));
        waiter(msg);
      }
      continue;
    }
    void handle(msg);
  }
});

process.stdin.on('end', () => {
  // `ignore-sigterm` also refuses the polite shutdown, so close() must escalate
  // all the way to SIGKILL.
  if (scenario !== 'ignore-sigterm') process.exit(0);
});
