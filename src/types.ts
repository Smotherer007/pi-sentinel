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

  // ── P0: close the loop (Stop-hook equivalent) ───────────────────────────
  /** Re-prompt the agent with the pruned failure when a turn ends red. */
  autoFix: boolean;
  /** Max consecutive auto-fix continuations before giving up. */
  maxAutoRetries: number;

  // ── P1: durable checkpoints ─────────────────────────────────────────────
  /** How many turn checkpoints to keep on disk. */
  checkpointRetention: number;

  // ── P2: state-bound evidence ────────────────────────────────────────────
  /** Remember content hashes of files whose checks passed. */
  trackVerifiedState: boolean;
  /** Restore a file that regressed away from its last verified state. */
  revertOnRegression: boolean;
  /** Mark older sentinel failure messages as superseded before each LLM call. */
  pruneStaleTraces: boolean;

  // ── P3: out-of-band mutations ───────────────────────────────────────────
  /** Also verify files changed outside edit/write (bash, formatters, git). */
  detectOutOfBand: boolean;

  // ── P4: revision contract ───────────────────────────────────────────────
  /** Inject the repair rules (bounded retries, never revise green code). */
  revisionContract: boolean;

  // ── P5: background checks & output budget ───────────────────────────────
  /** Run onTurnEnd pipelines in the background and re-wake on failure. */
  backgroundTurnEnd: boolean;
  /** Approximate token cap for model-visible verification output. */
  maxOutputTokens: number;

  // ── Mindplace synergy ───────────────────────────────────────────────────
  /** Extend verification focus to graph dependents of mutated files. */
  impactAwareFocus: boolean;

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

// ── P1: durable checkpoints ───────────────────────────────────────────────

export interface CheckpointSummary {
  id: string;
  /** Monotonic sequence number; higher is newer. */
  seq: number;
  at: string;
  turnIndex: number;
  /** Human label, e.g. "parseConfig, deepMerge (src/config.ts)". */
  label: string;
  fileCount: number;
  /** Session-tree entry the turn started from (for conversation rewind). */
  entryId?: string;
  files: string[];
}

// ── P2: state-bound evidence ──────────────────────────────────────────────

/** A file state that passed verification, with a restorable copy of it. */
export interface VerifiedStateEntry {
  path: string;
  hash: string;
  at: string;
  /** Pipeline step that was green for this state. */
  step: string;
  /** Blob name inside the verified store, when the content was kept. */
  blob?: string;
}

/**
 * A file that previously passed verification and no longer matches that
 * state — i.e. a revision regressed something that used to be green.
 */
export interface Regression {
  path: string;
  verifiedAt: string;
  verifiedStep: string;
  verifiedHash: string;
  currentHash: string;
  /** True when sentinel restored the verified state instead of reporting. */
  reverted: boolean;
}

// ── P3: out-of-band changes ───────────────────────────────────────────────

export interface OutOfBandChange {
  /** Git porcelain status code, e.g. " M", "??". */
  status: string;
  /** Absolute path. */
  path: string;
}

// ── P5: output budget ─────────────────────────────────────────────────────

export interface SpillResult {
  text: string;
  /** Set when the full output was written to disk instead of inlined. */
  spilledPath?: string;
}

// ── Mindplace synergy ─────────────────────────────────────────────────────

/** Impact of a file according to the code knowledge graph. */
export interface GraphImpact {
  file: string;
  /** Files that depend on `file`, most connected first. */
  dependents: string[];
  /** Symbols defined in `file`, most central first. */
  symbols: string[];
}

export interface GraphStatus {
  present: boolean;
  stale: boolean;
  nodeCount: number;
  edgeCount: number;
  /** ISO timestamp derived from graph.json's mtime. */
  builtAt?: string;
}

// ── Tool events ───────────────────────────────────────────────────────────

export type ToolName = "edit" | "write" | "bash" | "read" | string;

export interface ToolExecutionEvent {
  toolName: ToolName;
  toolCallId: string;
  input: Record<string, unknown>;
}

export type TriggerType = "onFileMutation" | "onTurnEnd";
