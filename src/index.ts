// Library entry for the published package (package.json "exports").
//
// The CLI (src/cli/ach.ts) re-exports this barrel so importing EITHER the
// library entry (dist/index.js) or the CLI bundle (dist/cli/ach.js) as a
// module yields the programmatic API with no CLI side effects — the CLI main
// only runs when the bundle is the process entry point (bin execution).
//
// Consumer contract (agentic-coding-harness#5): createDriver, defaultAdapters
// and the adapter classes must be importable from the npm package directly.

export { createDriver, defaultAdapters, type DriverOptions, type Driver } from './core/driver.ts';
export type {
  AgentAdapter,
  AgentEvent,
  AgentHandle,
  ExitStatus,
  RunResult,
  RunSpec,
  SandboxPolicy,
} from './core/types.ts';
export { ClaudeCodeAdapter } from './adapters/claude.ts';
export { KiroAdapter } from './adapters/kiro.ts';
export { CodexAdapter } from './adapters/codex.ts';
export { GeminiAdapter } from './adapters/gemini.ts';
export { OpenCodeAdapter } from './adapters/opencode.ts';
export { VERSION } from './version.ts';
