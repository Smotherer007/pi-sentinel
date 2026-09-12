/**
 * Core type definitions for @patimweb/pi-sentinel.
 *
 * Data-oriented design (following the pi-email pattern):
 *   - All domain data is represented as plain immutable interfaces here.
 *   - I/O is isolated in clients/.
 *   - Pure formatting functions live in formatting/.
 *   - Each pipeline step / tool is a single-responsibility module.
 */

// ── Pipeline configuration ────────────────────────────────────────────────

export interface PipelineStep {
  /** Display name of the pipeline step. */
  name: string;
  /** Command to run (e.g. "npx tsc --noEmit"). */
  cmd: string;
  /** Timeout in milliseconds. */
  timeoutMs: number;
  /** Working directory override (defaults to project cwd). */
  cwd?: string;
  /** Environment variables to merge into the child process. */
  env?: Record<string, string>;
  /** When true, failures from this step do NOT trigger rollback. */
  warnOnly?: boolean;
}

export interface SentinelPipelines {
  /** Pipelines run after an edit/write tool mutation. */
  onFileMutation: PipelineStep[];
  /** Pipelines run at end of an agent turn. */
  onTurnEnd: PipelineStep[];
}

export interface SentinelConfig {
  /** Master switch. When false the extension loads but does nothing. */
  enabled: boolean;
  /** Automatically git-rollback on invariant violation. */
  autoRollback: boolean;
  /** Max number of critical error lines to keep in pruned trace. */
  maxTraceLines: number;
  /** Validation pipelines for each trigger point. */
  pipelines: SentinelPipelines;
  /** Glob-style path patterns to exclude from verification. */
  exclude: string[];
  /** Additional glob patterns that trigger verification. */
  include: string[];
}

// ── Verification results ──────────────────────────────────────────────────

export interface VerificationResult {
  passed: boolean;
  step: string;
  /** Raw stdout from the failed step. */
  rawOutput: string;
  /** Pruned critical error lines. */
  prunedTrace: string;
  /** Formatted (color-coded) error for injection into the loop. */
  formattedError: string;
  /** Exit code of the failed process. */
  exitCode: number;
  /** Millisecond duration of the verification run. */
  durationMs: number;
  /** Whether this failure is only a warning (warnOnly step). */
  warnOnly: boolean;
}

export interface PipelineWarning {
  /** Name of the warnOnly step that failed. */
  step: string;
  /** Exit code of the failed step. */
  exitCode: number;
  /** Millisecond duration of the step. */
  durationMs: number;
  /** Pruned critical output of the failed step. */
  prunedTrace: string;
}

export interface PipelineRunResult {
  /** Overall pass/fail across all steps. */
  passed: boolean;
  /** First critical failure (or null if all critical steps passed). */
  failure: VerificationResult | null;
  /** Non-blocking failures from `warnOnly` steps, surfaced to the caller. */
  warnings: PipelineWarning[];
  /** All steps that ran, including successes. */
  steps: Array<{
    name: string;
    passed: boolean;
    durationMs: number;
    exitCode: number;
  }>;
}

// ── Rollback results ──────────────────────────────────────────────────────

export interface RollbackResult {
  success: boolean;
  method: string;
  message: string;
  command: string;
  committedAt?: string;
  branch?: string;
}

// ── Tool events ───────────────────────────────────────────────────────────

export type ToolName = "edit" | "write" | "bash" | "read" | string;

export interface ToolExecutionEvent {
  toolName: ToolName;
  toolCallId: string;
  input: Record<string, unknown>;
}

export type TriggerType = "onFileMutation" | "onTurnEnd";
