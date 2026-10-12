// `ach smoke` (agentic-coding-harness#139): run a how-to message as a
// brand-new user in an isolated sandbox, record the friction, fix it, rerun.
//
// Shared contract for the smoke modules:
//   parse.ts        message file  -> SmokeStep[]
//   sandbox.ts      fresh HOME / config dirs / minimal PATH / own keychain,
//                   host-keychain guard, process-group reaping
//   runner.ts       one SmokeStep in a Sandbox -> StepRecord
//   browser-auth.ts OAuth / SSO / device-code steps over CDP in the user's
//                   real browser (new tab, account guard, policy fallback)
//   stubs.ts        local HTTP stubs for outward write integrations
//   fix.ts          patch the instructions (and optionally the tool) and rerun
//   report.ts       friction table, revised message, rich-text clipboard
//   index.ts        runSmoke(): the end-to-end flow the CLI calls

/** What a step is, as the reader would experience it. */
export type StepKind =
  /** A shell command line the reader types (from a sh/bash/zsh/console fence or a `$ ` line). */
  | "shell"
  /** A prompt the reader types into an agent CLI (```prompt fence). */
  | "prompt"
  /** A URL the reader is told to open (```open fence, or a bare https URL line). */
  | "open";

export interface SmokeStep {
  /** 1-based, in document order. */
  index: number;
  kind: StepKind;
  /** The literal text, exactly as written in the message (one command line, one prompt, one URL). */
  text: string;
  /** 1-based line in the message file where `text` starts. */
  line: number;
  /** Fence info-string attributes, e.g. ```sh account=me@example.com timeout=120 -> {account, timeout}. */
  attrs: Record<string, string>;
  /** Heading the step sits under (nearest preceding markdown heading), if any. */
  section?: string;
}

/** Why a step needed a deviation; one per friction row. */
export type FrictionKind =
  | "missing-prereq" // command not found / binary absent / unstated install
  | "wrong-flag" // unknown option, bad usage
  | "unstated-assumption" // needed a file, env var, login, or dir the message never set up
  | "interactive-prompt" // the step waited on input the message did not mention
  | "denied" // permission denied / EACCES / policy refusal
  | "auth-policy-blocked" // e.g. device-code login blocked by conditional access
  | "auth-wrong-account" // browser signed in to an account other than the step's
  | "auth-needs-human" // auth could not be completed automatically; login script handed over
  | "keychain" // a keychain prompt / missing keychain surfaced
  | "side-effect-stubbed" // an outward write hit a local stub instead of a real system
  | "tool-lied" // the tool reported success/found when the state says otherwise
  | "timeout"
  | "failed"; // nonzero exit not matching a more specific kind

export interface Friction {
  kind: FrictionKind;
  /** One sentence: what broke, in the reader's terms. */
  detail: string;
  /** Evidence line(s) from the step's output (trimmed, <= 400 chars). */
  evidence?: string;
}

export type StepStatus = "pass" | "fail" | "skipped" | "fixed";

export interface StepRecord {
  step: SmokeStep;
  status: StepStatus;
  exitCode: number | null;
  durationMs: number;
  /** Tokens the step consumed (prompt steps run through an agent); null when not applicable/unknown. */
  tokens: number | null;
  /** Interactive prompts the step printed (e.g. "? Continue (y/N)", "Password:"). */
  prompts: string[];
  /** Permission / policy denials seen. */
  denials: string[];
  friction: Friction[];
  /** Last ~4 KB of combined stdout+stderr. */
  outputTail: string;
  /** Set when this record is a rerun after a fix. */
  attempt: number;
}

/** A fix the harness applied, in place. */
export interface FixRecord {
  stepIndex: number;
  /** "instructions" = the message was wrong/missing a step; "tool" = the tool itself lied or broke. */
  target: "instructions" | "tool";
  /** What changed, one sentence. */
  summary: string;
  /** Where: "message:L12" for instructions, "<repo>/<path>" for a tool patch. */
  where: string;
  /** Did the rerun of the step pass after the fix? */
  rerunPassed: boolean | null;
}

export interface SmokeReport {
  messageFile: string;
  sandboxRoot: string;
  startedAt: string;
  durationMs: number;
  steps: StepRecord[];
  fixes: FixRecord[];
  /** The message with every instruction fix applied (markdown). */
  revisedMessage: string;
  /** Host keychain search list before == after (null when not macOS). */
  hostKeychainUnchanged: boolean | null;
  /** Background processes still alive at teardown that the harness killed. */
  reapedPids: number[];
  /** Outward requests captured by stubs. */
  stubbedRequests: StubRequest[];
}

export interface StubRequest {
  stub: string;
  method: string;
  path: string;
  body: string;
  at: string;
}

// ---------------------------------------------------------------- auth (browser-auth.ts <-> runner.ts)

/** An auth step the runner noticed: a URL the CLI printed or tried to `open`. */
export interface AuthRequest {
  stepIndex: number;
  url: string;
  /** Device-code flows: the code the reader must enter. */
  userCode?: string;
  kind: "device-code" | "browser";
  /** The account the step needs (fence attr `account=` or --account); undefined = unknown. */
  account?: string;
  /** The step's command text, for the hand-over login script. */
  command?: string;
}

export interface AuthOutcome {
  status: "completed" | "wrong-account" | "policy-blocked" | "needs-human" | "failed";
  /** One sentence for the friction table. */
  detail: string;
  /** Accounts the browser showed as signed in (never cookies or tokens). */
  seenAccounts: string[];
  /** wrong-account / needs-human: the one-line command the user runs themselves. */
  loginScript?: string;
  /** policy-blocked: the flow the reader will actually use instead. */
  fallback?: "browser";
}

export type AuthHandler = (req: AuthRequest) => Promise<AuthOutcome>;

// ---------------------------------------------------------------- message edits (fix.ts -> report.ts)

/** One edit to the message, addressed by 1-based source line of the ORIGINAL message. */
export interface MessageEdit {
  line: number;
  op: "replace" | "insert-before" | "insert-after";
  /** For replace: the exact original text being replaced (a step's `text`), checked before applying. */
  original?: string;
  text: string;
  /** Why, for the friction table's "fixed" column. */
  reason: string;
}
