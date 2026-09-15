/**
 * Plain data shared by the modules. No behaviour lives here.
 */

/** What kind of failure a red step was — decides whether the agent should act. */
export type FailureKind =
  | "type-error"
  | "lint-error"
  | "test-failure"
  | "build-failure"
  | "timeout"
  | "command-not-found"
  | "environment-error"
  | "unknown";

/** One command sentinel runs. */
export interface Step {
  /** Short, stable name shown in feedback ("typecheck", "test"). */
  name: string;
  /** Shell command, run from the project root (or `cwd`). */
  cmd: string;
  /** Hard deadline; the whole process tree is killed after it. Default 120 s. */
  timeoutMs?: number;
  /** Working directory relative to the project root. Must stay inside it. */
  cwd?: string;
  /** Extra environment variables for the command. */
  env?: Record<string, string>;
  /**
   * Only run when a changed file matches one of these globs. Unset runs always.
   * `["**\/*.ts"]` keeps a type-check from running because a README changed.
   */
  files?: string[];
  /** Report a failure, but never block or re-prompt on it. */
  warnOnly?: boolean;
}

export interface SentinelConfig {
  enabled: boolean;
  checks: {
    /**
     * Fast checks after each `edit`/`write`. Their result is attached to the
     * tool result as a hint — a multi-file change is allowed to be red in the
     * middle. `"auto"` uses the detected type-check.
     */
    afterEdit: Step[] | "auto";
    /**
     * The gate at the end of an agent run. A red result re-prompts the agent
     * (bounded by `repair`). `"auto"` uses the detected type-check, lint and
     * test commands.
     */
    beforeDone: Step[] | "auto";
  };
  repair: {
    /** Re-prompt the agent when `beforeDone` is red. */
    enabled: boolean;
    /** Repair rounds per user prompt before sentinel stops and reports. */
    maxAttempts: number;
  };
  checkpoints: {
    enabled: boolean;
    /** How many checkpoints to keep per project. */
    retention: number;
  };
  /** Cap on model-visible feedback; the full output is written to a file. */
  maxOutputTokens: number;
  /** Diagnostic lines kept from a failing command. */
  maxTraceLines: number;
  /** Changes to these paths never trigger checks. */
  exclude: string[];
  /** Name dependents from pi-mindplace's `graph-out/graph.json` in failures. */
  mindplace: boolean;
  /** Add the short working rules to the system prompt. */
  contract: boolean;
}

/** The result of running one step. */
export interface StepResult {
  name: string;
  cmd: string;
  passed: boolean;
  exitCode: number;
  durationMs: number;
  output: string;
  warnOnly: boolean;
  timedOut: boolean;
  kind?: FailureKind;
  skipped?: string;
}

/** The result of running a group of steps. Stops at the first blocking failure. */
export interface CheckRun {
  passed: boolean;
  steps: StepResult[];
  /** The first blocking failure, if any. */
  failure?: StepResult;
  /** Non-blocking failures (`warnOnly`). */
  warnings: StepResult[];
}

export interface CheckpointSummary {
  id: string;
  at: string;
  label: string;
  files: string[];
}
