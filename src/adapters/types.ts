// Pure re-exports — the canonical type home is src/core/types.ts.
//
// The historical adapter-lane names are aliased to their canonical spellings
// so existing `./types` imports under src/adapters/ keep compiling unchanged:
//   CanonicalTokenRecord -> AdapterTokenRecord (CLI-lane token accounting)
//   RunHandle            -> AdapterRunHandle   (CLI-lane run handle)
//   AgentAdapter         -> CliAgentAdapter    (CLI-lane adapter contract)
// The driver-lane AgentAdapter/RunHandle/CanonicalTokenRecord live in
// ../core/types.js under their canonical names; new code should import there.
export type {
  AdapterCapabilities,
  CanonicalEvent,
  RunOptions,
  AdapterTokenRecord as CanonicalTokenRecord,
  AdapterRunHandle as RunHandle,
  CliAgentAdapter as AgentAdapter,
} from "../core/types.js";
