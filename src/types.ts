/**
 * Core type definitions for @patimweb/pi-sentinel.
 *
 * Data-oriented design (following the pi-email pattern):
 *   - All domain data is represented as plain immutable interfaces here.
 *   - I/O is isolated in clients/.
 *   - Pure formatting functions live in formatting/.
 *   - Each pipeline step / tool is a single-responsibility module.
 */

// ── Failure classification ────────────────────────────────────────────────

/**
 * Why a verification step failed. The kind decides how the agent should
 * react: a timeout or a missing binary must not send the agent off to
 * rewrite source code, while a type error must.
 */
export type FailureKind =
  | "type-error"
  | "lint-error"
  | "test-failure"
  | "build-failure"
  | "timeout"
  | "command-not-found"
  | "environment-error"
  | "unknown";

/**
 * How much a failing step matters.
 *
 *   - `critical`: blocks the turn and is allowed to trigger a rollback.
 *   - `normal`:   blocks the turn (same as the pre-3.0 default).
 *   - `warning`:  never blocks and never triggers a rollback (== `warnOnly`).
 */
export type StepPriority = "critical" | "normal" | "warning";

/** Opt-in retries for *infrastructure* failures only. */
export interface RetryPolicy {
  /** Total attempts including the first one. */
  maxAttempts: number;
  /** Only these kinds are retried; a real compile/test error never is. */
  retryOn: FailureKind[];
  /** Delay between attempts in milliseconds. Default 0. */
  delayMs?: number;
}

// ── Pipeline configuration ────────────────────────────────────────────────

export interface PipelineStep {
  /** Display name of the pipeline step. */
  name: string;
  /** Command to run (e.g. "npx tsc --noEmit"). */
  cmd: string;
  /** Timeout in milliseconds. */
  timeoutMs: number;
  /** Working directory override, resolved inside the project root. */
  cwd?: string;
  /** Environment variables to merge into the child process. */
  env?: Record<string, string>;
  /** When true, failures from this step do NOT trigger rollback. */
  warnOnly?: boolean;
  /**
   * Phase this step belongs to. `onFileMutation` runs `mutation` steps,
   * `onTurnEnd` runs `turn` steps; an unset phase accepts both.
   */
  phase?: "mutation" | "turn";
  /** Blocking weight; defaults to `normal` (or `warning` when warnOnly). */
  priority?: StepPriority;
  /**
   * Glob patterns for the files this step applies to, e.g. every TypeScript
   * source file or everything under a docs directory. An empty or absent list
   * means "always relevant", so an unconfigured step behaves as before.
   */
  files?: string[];
  /** Retry policy for infrastructure failures. */
  retry?: RetryPolicy;
  /**
   * Whether a passing run may be reused for an identical code state.
   * Set `false` for non-deterministic steps (flaky test suites).
   */
  cacheable?: boolean;
}

/** Verification cache configuration. */
export interface VerificationCacheConfig {
  enabled: boolean;
  /** Entries older than this are ignored; `0` disables expiry. */
  ttlMs: number;
  maxEntries: number;
  /** Keep the cache on disk so a new session can reuse it. */
  persist: boolean;
  /** Only these step names are cacheable; absent means "all of them". */
  steps?: string[];
}

/** Repeated-failure escalation configuration. */
export interface FailureEscalationConfig {
  enabled: boolean;
  /** Identical failures before sentinel tells the agent to change approach. */
  maxRepeatedFailures: number;
}

/** Performance-oriented verification settings. */
export interface VerificationSettings {
  /** Coalesce mutation verifications within this window (0 = no debounce). */
  debounceMs: number;
  /** Upper bound on the combined stdout/stderr buffer of one step. */
  maxOutputBytes: number;
  /** SIGTERM → SIGKILL grace period when a step times out. */
  killGraceMs: number;
  cache: VerificationCacheConfig;
  failureEscalation: FailureEscalationConfig;
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
  /** Performance, cache and escalation settings (P6). */
  verification: VerificationSettings;
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
  /** Structured classification, so callers can react per failure type. */
  failureKind: FailureKind;
  /** True when the step was killed because it exceeded its timeout. */
  timedOut: boolean;
  /** Signal that terminated the process, when it was not a plain exit. */
  signal?: string;
  /** One-line description of what actually went wrong. */
  errorSummary?: string;
  /** Files the step was run for. */
  affectedFiles?: string[];
  /** How many attempts the step needed. */
  attempts: number;
  /** Stable identity of this failure, for repeated-failure escalation. */
  signature: string;
  /** Blocking weight of the step that failed. */
  priority: StepPriority;
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
  /** Classification of the warning. */
  failureKind: FailureKind;
  /** True when the step timed out. */
  timedOut: boolean;
}

/** One step of a run: successful, failed or skipped. */
export interface PipelineStepResult {
  name: string;
  passed: boolean;
  durationMs: number;
  exitCode: number;
  /** Set when the step was not run at all (phase/file mismatch). */
  skipped?: string;
  /** Set when the run was served from the verification cache. */
  cached?: boolean;
  /** Attempts needed (including the first). */
  attempts?: number;
  /** Classification, only for failures. */
  failureKind?: FailureKind;
}

export interface PipelineRunResult {
  /** Overall pass/fail across all steps. */
  passed: boolean;
  /** First critical failure (or null if all critical steps passed). */
  failure: VerificationResult | null;
  /** Non-blocking failures from `warnOnly` steps, surfaced to the caller. */
  warnings: PipelineWarning[];
  /** All steps that ran, including successes and skips. */
  steps: PipelineStepResult[];
  /** True when every step was answered from the verification cache. */
  cached?: boolean;
}

// ── Rollback results ──────────────────────────────────────────────────────

/**
 * A file that was *not* restored because it changed after sentinel's own
 * mutation — overwriting it would silently destroy that later work.
 */
export interface RollbackConflict {
  path: string;
  /** Hash sentinel recorded for the file after the agent's mutation. */
  expectedHash: string | null;
  /** Hash the file has right now. */
  actualHash: string | null;
  reason: string;
}

export interface RollbackResult {
  success: boolean;
  method: string;
  message: string;
  command: string;
  committedAt?: string;
  branch?: string;
  /** Files left untouched because they changed since the snapshot. */
  conflicts?: RollbackConflict[];
  /** True when at least one file could not be restored. */
  partial?: boolean;
}

// ── Performance metrics ───────────────────────────────────────────────────

/** Counters sentinel keeps for `/sentinel status` (P6). */
export interface SentinelMetrics {
  checks: number;
  successes: number;
  failures: number;
  timeouts: number;
  skippedSteps: number;
  retries: number;
  escalations: number;
  cacheHits: number;
  cacheMisses: number;
  totalDurationMs: number;
  rollbacks: number;
  partialRollbacks: number;
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
