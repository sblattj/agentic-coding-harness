import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import type { AgentEvent, CanonicalTokenRecord, EventTimestamp } from '../core/types.js';

export type { EventTimestamp };

const SCHEMA_VERSION = 'ATIF-v1.7' as const;

/**
 * Canonical-first usage reader: uses the 5-field canonical record when the
 * legacy promptTokens/completionTokens/cachedTokens aliases are absent
 * (prompt = input + cache slices; see docs/TOKEN-COUNTING.md).
 */
function effectiveUsage(u: CanonicalTokenRecord): {
  prompt: number;
  completion: number;
  cached: number;
  cacheWrite: number;
  reasoning: number;
  cost: number;
} {
  const cacheRead = u.cacheReadTokens ?? 0;
  const cacheWrite = u.cacheWriteTokens ?? 0;
  return {
    prompt: u.promptTokens ?? (u.inputTokens ?? 0) + cacheRead + cacheWrite,
    completion: u.completionTokens ?? (u.outputTokens ?? 0),
    cached: u.cachedTokens ?? cacheRead,
    cacheWrite,
    reasoning: u.reasoningTokens ?? 0,
    cost: u.costUsd ?? 0,
  };
}

export interface AtifToolCall {
  tool_call_id: string;
  function_name: string;
  arguments: Record<string, unknown> | string;
}

export interface AtifObservationResult {
  source_call_id: string;
  content: string;
}

export interface AtifObservation {
  results: AtifObservationResult[];
}

export interface AtifStepMetrics {
  prompt_tokens: number;
  completion_tokens: number;
  cached_tokens: number;
  cost_usd: number;
  extra?: Record<string, unknown>;
}

export interface AtifStep {
  step_id: number;
  timestamp: string;
  source: 'system' | 'user' | 'agent';
  message: string;
  reasoning_content?: string;
  tool_calls: AtifToolCall[];
  observation: AtifObservation;
  metrics: AtifStepMetrics;
  llm_call_count: number;
}

export interface AtifFinalMetrics {
  total_prompt_tokens: number;
  total_completion_tokens: number;
  total_cached_tokens: number;
  total_cost_usd: number;
  total_steps: number;
}

export interface AtifTrajectory {
  schema_version: typeof SCHEMA_VERSION;
  session_id: string;
  trajectory_id: string;
  agent: {
    name: string;
    version: string;
    model_name: string;
    tool_definitions?: unknown[];
  };
  steps: AtifStep[];
  final_metrics: AtifFinalMetrics;
  extra: Record<string, unknown>;
}

export interface StartTrajectoryOptions {
  agent: string;
  version: string;
  modelName: string;
  sessionId?: string;
  trajectoryId?: string;
  toolDefinitions?: unknown[];
}

export interface AddStepOptions {
  source: 'system' | 'user' | 'agent';
  message: string;
  reasoningContent?: string;
  toolCalls?: AtifToolCall[];
  observation?: AtifObservation;
  metrics?: Partial<AtifStepMetrics> & { extra?: Record<string, unknown> };
  llmCallCount?: number;
  timestamp?: EventTimestamp;
}

export interface ValidateResult {
  ok: boolean;
  errors: string[];
}

function toIso(ts?: EventTimestamp): string {
  if (ts === undefined) return new Date().toISOString();
  if (ts instanceof Date) return ts.toISOString();
  if (typeof ts === 'number') return new Date(ts).toISOString();
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
}

function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

interface StepDraft {
  timestamp?: EventTimestamp;
  source: 'system' | 'user' | 'agent';
  message: string;
  reasoningContent?: string;
  toolCalls: AtifToolCall[];
  observationResults: AtifObservationResult[];
  metrics: AtifStepMetrics;
  llmCallCount: number;
}

export class AtifWriter {
  private agent!: StartTrajectoryOptions;
  private steps: StepDraft[] = [];
  private subagents: AtifTrajectory[] = [];
  private started = false;

  startTrajectory(opts: StartTrajectoryOptions): this {
    this.agent = {
      agent: opts.agent,
      version: opts.version,
      modelName: opts.modelName,
      sessionId: opts.sessionId ?? randomUUID(),
      trajectoryId: opts.trajectoryId ?? randomUUID(),
      toolDefinitions: opts.toolDefinitions,
    };
    this.started = true;
    return this;
  }

  addSubagent(trajectory: AtifWriter | AtifTrajectory): this {
    const doc = trajectory instanceof AtifWriter ? trajectory.toTrajectory() : trajectory;
    this.subagents.push(doc);
    return this;
  }

  addStep(opts: AddStepOptions): this {
    this.assertStarted();
    const draft: StepDraft = {
      timestamp: opts.timestamp,
      source: opts.source,
      message: opts.message,
      reasoningContent: opts.reasoningContent,
      toolCalls: opts.toolCalls ? [...opts.toolCalls] : [],
      observationResults: opts.observation ? [...opts.observation.results] : [],
      metrics: {
        prompt_tokens: opts.metrics?.prompt_tokens ?? 0,
        completion_tokens: opts.metrics?.completion_tokens ?? 0,
        cached_tokens: opts.metrics?.cached_tokens ?? 0,
        cost_usd: opts.metrics?.cost_usd ?? 0,
      },
      llmCallCount: opts.llmCallCount ?? 0,
    };
    if (opts.metrics?.extra) draft.metrics.extra = { ...opts.metrics.extra };
    this.steps.push(draft);
    return this;
  }

  toTrajectory(): AtifTrajectory {
    this.assertStarted();
    const steps = this.steps.map((draft, i) => this.draftToStep(draft, i + 1));
    const totals = this.steps.reduce(
      (acc, s) => ({
        prompt: acc.prompt + s.metrics.prompt_tokens,
        completion: acc.completion + s.metrics.completion_tokens,
        cached: acc.cached + s.metrics.cached_tokens,
        cost: acc.cost + s.metrics.cost_usd,
      }),
      { prompt: 0, completion: 0, cached: 0, cost: 0 },
    );
    const trajectory: AtifTrajectory = {
      schema_version: SCHEMA_VERSION,
      session_id: this.agent.sessionId as string,
      trajectory_id: this.agent.trajectoryId as string,
      agent: {
        name: this.agent.agent,
        version: this.agent.version,
        model_name: this.agent.modelName,
      },
      steps,
      final_metrics: {
        total_prompt_tokens: totals.prompt,
        total_completion_tokens: totals.completion,
        total_cached_tokens: totals.cached,
        total_cost_usd: round6(totals.cost),
        total_steps: steps.length,
      },
      extra: {},
    };
    if (this.agent.toolDefinitions) {
      trajectory.agent.tool_definitions = this.agent.toolDefinitions;
    }
    if (this.subagents.length > 0) {
      trajectory.extra.subagents = this.subagents;
    }
    return trajectory;
  }

  finalize(outPath: string): AtifTrajectory {
    const trajectory = this.toTrajectory();
    mkdirSync(dirname(resolve(outPath)), { recursive: true });
    writeFileSync(resolve(outPath), JSON.stringify(trajectory, null, 2), 'utf8');
    return trajectory;
  }

  static validate(path: string): ValidateResult {
    const errors: string[] = [];
    let doc: unknown;
    try {
      doc = JSON.parse(readFileSync(path, 'utf8'));
    } catch (err) {
      return { ok: false, errors: [`unreadable or invalid JSON: ${(err as Error).message}`] };
    }
    if (typeof doc !== 'object' || doc === null) {
      return { ok: false, errors: ['document is not an object'] };
    }
    const t = doc as Partial<AtifTrajectory> & { steps?: unknown };

    if (!t.schema_version) {
      errors.push('missing schema_version');
    }
    if (!Array.isArray(t.steps)) {
      errors.push('missing steps array');
    } else {
      t.steps.forEach((step, i) => {
        const s = step as Partial<AtifStep>;
        if (s.step_id !== i + 1) {
          errors.push(`step order broken at index ${i}: expected step_id ${i + 1}, got ${String(s.step_id)}`);
        }
      });
      const toolCallIds = new Set<string>();
      for (const step of t.steps as AtifStep[]) {
        for (const call of step.tool_calls ?? []) {
          toolCallIds.add(call.tool_call_id);
        }
      }
      (t.steps as AtifStep[]).forEach((step, i) => {
        for (const result of step.observation?.results ?? []) {
          if (!toolCallIds.has(result.source_call_id)) {
            errors.push(
              `step ${i + 1} observation references unknown tool_call_id: ${result.source_call_id}`,
            );
          }
        }
      });
    }
    return { ok: errors.length === 0, errors };
  }

  /**
   * Convert a harness event stream into an ATIF trajectory.
   * message events -> steps; tool_call/tool_result -> step tool_calls + observation;
   * usage events -> metrics on the most recent step; totals accumulate into final_metrics.
   */
  static fromEvents(
    events: AgentEvent[],
    opts?: Omit<StartTrajectoryOptions, 'sessionId' | 'trajectoryId'> & {
      sessionId?: string;
      trajectoryId?: string;
    },
  ): AtifWriter {
    const writer = new AtifWriter();
    writer.startTrajectory({
      agent: opts?.agent ?? 'unknown-agent',
      version: opts?.version ?? '0.0.0',
      modelName: opts?.modelName ?? 'unknown-model',
      sessionId: opts?.sessionId,
      trajectoryId: opts?.trajectoryId,
    });

    let current: StepDraft | null = null;
    // Tool activity and LLM usage belong to agent steps: reuse the current step
    // only when it is an agent step, otherwise open a fresh one.
    const ensureStep = (ts?: EventTimestamp): StepDraft => {
      if (!current || current.source !== 'agent') {
        current = {
          timestamp: ts,
          source: 'agent',
          message: '',
          toolCalls: [],
          observationResults: [],
          metrics: { prompt_tokens: 0, completion_tokens: 0, cached_tokens: 0, cost_usd: 0 },
          llmCallCount: 0,
        };
        writer.steps.push(current);
      }
      return current;
    };
    const applyUsage = (draft: StepDraft, usage: CanonicalTokenRecord): void => {
      const e = effectiveUsage(usage);
      draft.metrics.prompt_tokens += e.prompt;
      draft.metrics.completion_tokens += e.completion;
      draft.metrics.cached_tokens += e.cached;
      draft.metrics.cost_usd += e.cost;
      draft.llmCallCount += 1;
      const extra: Record<string, unknown> = { ...(draft.metrics.extra ?? {}) };
      if (e.reasoning > 0) {
        extra.reasoning_tokens = ((extra.reasoning_tokens as number | undefined) ?? 0) + e.reasoning;
      }
      if (e.cacheWrite > 0) {
        extra.cache_write_tokens = ((extra.cache_write_tokens as number | undefined) ?? 0) + e.cacheWrite;
      }
      if (usage.extra) Object.assign(extra, usage.extra);
      if (Object.keys(extra).length > 0) draft.metrics.extra = extra;
    };

    for (const ev of events) {
      const ts = ev.timestamp;
      switch (ev.type) {
        case 'message': {
          const draft: StepDraft = {
            timestamp: ts,
            source: ev.source === 'user' || ev.source === 'system' ? ev.source : 'agent',
            message: typeof ev.content === 'string' ? ev.content : JSON.stringify(ev.content ?? ''),
            reasoningContent: ev.reasoningContent,
            toolCalls: [],
            observationResults: [],
            metrics: { prompt_tokens: 0, completion_tokens: 0, cached_tokens: 0, cost_usd: 0 },
            llmCallCount: 0,
          };
          writer.steps.push(draft);
          current = draft;
          break;
        }
        case 'tool_call': {
          if (typeof ev.toolCallId !== 'string' || typeof ev.functionName !== 'string') break;
          const draft = ensureStep(ts);
          draft.toolCalls.push({
            tool_call_id: ev.toolCallId,
            function_name: ev.functionName,
            arguments: ev.arguments ?? {},
          });
          break;
        }
        case 'tool_result': {
          if (typeof ev.toolCallId !== 'string') break;
          const draft = ensureStep(ts);
          draft.observationResults.push({
            source_call_id: ev.toolCallId,
            content: typeof ev.content === 'string' ? ev.content : JSON.stringify(ev.content ?? ''),
          });
          break;
        }
        case 'usage':
        case 'model_call_end': {
          if (!ev.usage) break;
          const draft = ensureStep(ts);
          applyUsage(draft, ev.usage);
          break;
        }
        default:
          break; // session_start/session_end/model_call_start carry no step content
      }
    }
    return writer;
  }

  private draftToStep(draft: StepDraft, stepId: number): AtifStep {
    const metrics: AtifStepMetrics = {
      prompt_tokens: draft.metrics.prompt_tokens,
      completion_tokens: draft.metrics.completion_tokens,
      cached_tokens: draft.metrics.cached_tokens,
      cost_usd: round6(draft.metrics.cost_usd),
    };
    if (draft.metrics.extra) metrics.extra = draft.metrics.extra;
    const step: AtifStep = {
      step_id: stepId,
      timestamp: toIso(draft.timestamp),
      source: draft.source,
      message: draft.message,
      tool_calls: draft.toolCalls,
      observation: { results: draft.observationResults },
      metrics,
      llm_call_count: draft.llmCallCount,
    };
    if (draft.reasoningContent !== undefined) {
      step.reasoning_content = draft.reasoningContent;
    }
    return step;
  }

  private assertStarted(): void {
    if (!this.started) {
      throw new Error('trajectory not started: call startTrajectory() first');
    }
  }
}
