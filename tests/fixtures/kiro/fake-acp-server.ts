import { fileURLToPath } from "node:url";
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
  'slow-prompt',
  'ignore-sigterm',
  'fs-request',
  'load-not-found',
  'load-exit',
  'v3',
  'v3-permission',
  'v3-late-models',
] as const;
export type FakeAcpScenario = (typeof SCENARIOS)[number];

const scenario = (process.env.FAKE_ACP_SCENARIO ?? 'ok') as FakeAcpScenario;
const stdinLog = process.env.FAKE_ACP_STDIN_LOG;
const isV3 = scenario === 'v3' || scenario === 'v3-permission' || scenario === 'v3-late-models';
/**
 * `v3-late-models`: a fresh workspace on 2.29.0 can answer session/new and
 * the first set_config_option BEFORE its model catalog has loaded, so neither
 * carries a `model` option; it shows up in a later `config_option_update`.
 */
let modelsLoaded = scenario !== 'v3-late-models';

// ---------------------------------------------------------------------------
// Engine v3 (`--agent-engine v3`) as measured on kiro-cli 2.29.0 (#127):
//  - `session/new` returns `modes` (custom agents included) and `configOptions`
//    but NO `models`; the `model` option arrives in a `config_option_update`
//    notification right after the result.
//  - `session/set_model` is not implemented (-32603 Internal error).
//  - `session/set_config_option {configId, value}` answers `{configOptions}`.
//    An unknown mode is ignored (the mode stays, `_kiro/customAgent/not_found`
//    is pushed); an unknown model id is stored verbatim; an unknown effort is
//    ignored. `effortLevel` only exists while the model supports it (not haiku).
// ---------------------------------------------------------------------------

const V3_SESSION = 'sess_fake-v3';
const V3_MODES = ['vibe', 'plan', 'demo-agent'];
const V3_MODELS = ['claude-sonnet-5.5', 'claude-opus-5.5', 'claude-haiku-4.5'];
const V3_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const v3State: { mode: string; model: string; effort: string } = {
  mode: 'vibe',
  model: 'claude-haiku-4.5',
  effort: 'medium',
};

function v3ConfigOptions(withModelRequested: boolean): Json[] {
  const withModel = withModelRequested && modelsLoaded;
  const select = (id: string, currentValue: string, values: string[]): Json => ({
    type: 'select',
    id,
    name: id,
    currentValue,
    options: values.map((value) => ({ value, name: value })),
  });
  const out: Json[] = [select('mode', v3State.mode, V3_MODES)];
  if (withModel) {
    out.push(select('model', v3State.model, V3_MODELS));
    if (v3State.model !== 'claude-haiku-4.5') out.push(select('effortLevel', v3State.effort, V3_EFFORTS));
  }
  out.push(select('autopilot', 'on', ['on', 'off']));
  return out;
}

function v3SessionResult(): Json {
  return {
    sessionId: V3_SESSION,
    modes: {
      currentModeId: v3State.mode,
      availableModes: V3_MODES.map((id) => ({ id, name: id })),
    },
    configOptions: v3ConfigOptions(false),
  };
}

function v3ConfigUpdate(): Json {
  return {
    jsonrpc: '2.0',
    method: 'session/update',
    params: {
      sessionId: V3_SESSION,
      update: { sessionUpdate: 'config_option_update', configOptions: v3ConfigOptions(true) },
    },
  };
}

// ---------------------------------------------------------------------------
// Fixture replay table: method -> { notifications[], result }
// ---------------------------------------------------------------------------

interface Step {
  notifications: Json[];
  result: Json;
}

function loadFixture(): Map<string, Step> {
  const text = readFileSync(join(fileURLToPath(new URL('.', import.meta.url)), 'acp-prompt-2.21.2.jsonl'), 'utf8');
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

/** Set by a `session/cancel` notification; read by the `slow-prompt` scenario. */
let cancelled = false;

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
      if (isV3) {
        respond(id, v3SessionResult());
        if (scenario === 'v3-late-models') {
          setTimeout(() => {
            modelsLoaded = true;
            send(v3ConfigUpdate());
          }, 300);
          return;
        }
        send(v3ConfigUpdate());
        return;
      }
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
      // Mirrors kiro-cli 2.21.2 / 2.28.0 as measured 2026-10-07 (#117):
      //  - no `cwd` in params: the process exits 0 with NO response and no stderr;
      //  - unknown session: -32603 `Internal error` with the reason in `data`;
      //  - otherwise: the session's history is replayed as `session/update`
      //    notifications BEFORE the result, which carries `modes` + `models`
      //    (the session/new shape without `sessionId`).
      // `load-exit` forces that same silent death even with a cwd.
      if (typeof params.cwd !== 'string' || scenario === 'load-exit') process.exit(0);
      const sid = String(params.sessionId);
      if (isV3) {
        const { sessionId: _sid, ...loaded } = v3SessionResult();
        void _sid;
        respond(id, loaded);
        send(v3ConfigUpdate());
        return;
      }
      if (scenario === 'load-not-found') {
        send({
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Internal error', data: `Failed to start session: Session not found: ${sid}` },
          id,
        } as Json);
        return;
      }
      emit([
        { jsonrpc: '2.0', method: 'session/update', params: { sessionId: sid, update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'REPLAYED-USER' } } } },
        { jsonrpc: '2.0', method: 'session/update', params: { sessionId: sid, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'REPLAYED-HISTORY' } } } },
      ]);
      const { sessionId: _drop, ...result } = structuredClone(stepFor('session/new').result) as Json;
      void _drop;
      respond(id, result);
      return;
    }

    case 'session/set_model': {
      if (isV3) {
        send({
          jsonrpc: '2.0',
          error: {
            code: -32603,
            message: 'Internal error',
            data: { details: 'Ext method "session/set_model" has no persistence classification.' },
          },
          id,
        } as Json);
        return;
      }
      if (scenario === 'reject-model') {
        respondError(id, -32602, `model '${String(params.modelId)}' is not supported`);
        return;
      }
      emit(stepFor('session/set_model').notifications);
      respond(id, {});
      return;
    }

    case 'session/set_config_option': {
      if (!isV3) {
        respondError(id, -32601, `Method not found: ${String(method)}`);
        return;
      }
      const value = String(params.value);
      if (params.configId === 'mode') {
        if (V3_MODES.includes(value)) v3State.mode = value;
        else send({ jsonrpc: '2.0', method: '_kiro/customAgent/not_found', params: { sessionId: V3_SESSION, name: value } } as Json);
      } else if (params.configId === 'model') {
        v3State.model = value; // stored verbatim, even when not offered
      } else if (params.configId === 'effortLevel') {
        if (V3_EFFORTS.includes(value) && v3State.model !== 'claude-haiku-4.5') v3State.effort = value;
      }
      respond(id, { configOptions: v3ConfigOptions(true) });
      if (modelsLoaded) send(v3ConfigUpdate());
      return;
    }

    case 'session/prompt': {
      if (scenario === 'v3-permission') {
        const answer = await ask('session/request_permission', {
          sessionId: params.sessionId,
          toolCall: {
            toolCallId: 'run_command_fake',
            title: 'Write a file',
            kind: 'execute',
            rawInput: { command: 'echo ok > out.txt' },
            _meta: { kiro: { toolId: 'shell' } },
          },
          options: [
            { optionId: 'allow-always', name: 'Always allow', kind: 'allow_always' },
            { optionId: 'allow-once', name: 'Allow', kind: 'allow_once' },
            { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
          ],
        });
        const outcome = ((answer.result as Json | undefined)?.outcome ?? {}) as Json;
        respond(id, { stopReason: outcome.outcome === 'selected' ? 'end_turn' : 'refusal' });
        return;
      }
      if (scenario === 'v3') {
        send({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: params.sessionId,
            update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'pineapple' } },
          },
        } as Json);
        respond(id, { stopReason: 'end_turn' });
        return;
      }
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
      if (scenario === 'slow-prompt') {
        // Stays in flight so a test can cancel it. Answers `cancelled` when
        // session/cancel arrives, exactly as the real agent does.
        for (let i = 0; i < 200 && !cancelled; i++) await sleep(10);
        respond(id, cancelled ? { stopReason: 'cancelled' } : step.result);
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
      cancelled = true;
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
