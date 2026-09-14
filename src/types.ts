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
  /**
   * Per-step override for how many critical error lines the pruner keeps.
   * A noisy linter and a terse compiler want different budgets; the global
   * `maxTraceLines` stays the default, so an unset value changes nothing.
   */
  maxTraceLines?: number;
}

/**
 * Bounded automatic error correction.
 *
 * The recovery loop re-prompts the agent with a pruned failure. It is bounded
 * so a coding agent can never be trapped in an endless correction cycle:
 * after `maxAttempts` consecutive red turns the loop stops, and — when
 * `rollbackAfterExhaustion` is set — the working tree is restored to the state
 * it had before the first turn of the failing cycle.
 *
 * Legacy `autoFix` / `maxAutoRetries` are mapped onto this block by
 * `config.ts`, so old configurations keep working unchanged.
 */
/**
 * How strictly a repair cycle is confined to the files it started from.
 *
 *   - `off`:    no scope is tracked.
 *   - `report`: a widening change set is named in the failure payload.
 *   - `block`:  an edit outside the scope is refused before it is written.
 *
 * A repair loop that keeps reaching further from the original failure is the
 * documented way these loops cause damage, so the default reports it.
 */
export type ScopeGuard = "off" | "report" | "block";

export interface RecoveryConfig {
  /** Whether the agent is re-prompted on a red turn at all. */
  enabled: boolean;
  /** Consecutive recovery attempts before the loop stops (>= 1). */
  maxAttempts: number;
  /** Restore the pre-cycle state once `maxAttempts` is reached. */
  rollbackAfterExhaustion: boolean;
  /** How a repair cycle that widens its file set is handled. */
  scopeGuard: ScopeGuard;
}

/**
 * How strictly shell commands are governed.
 *
 *   - `off`:    `bash` is not inspected at all (pre-3.x behaviour).
 *   - `report`: risky commands are named to the human, then run.
 *   - `block`:  a command sentinel cannot make undoable is refused.
 */
export type BashGuardMode = "off" | "report" | "block";

/**
 * Governance for the `bash` tool.
 *
 * Every other guarantee sentinel makes is keyed to `edit` and `write`: the
 * snapshot store, the checkpoints, the verified-state ledger. `bash` walks past
 * all of it, so an `rm -rf src` or a `git reset --hard` is invisible and
 * unrecoverable. This block closes that, in the only way that is honest: by
 * capturing the pre-state of what a command would destroy *before* it runs, and
 * refusing the ones whose damage cannot be captured at all.
 *
 * It is not a sandbox and must not be sold as one — shell is a programming
 * language and a determined command can always hide its intent. It catches the
 * destructive command an agent writes when it is confused, which is the case
 * that actually happens. Real isolation comes from a container or a micro-VM.
 */
export interface BashGuardConfig {
  /** Master switch for shell governance. */
  enabled: boolean;
  /** What happens when a command is judged unsafe. */
  mode: BashGuardMode;
  /** Capture the pre-state of files a destructive command would touch. */
  snapshotBeforeDestructive: boolean;
  /**
   * Upper bound on files captured for one command. A blast radius beyond this
   * cannot be made undoable, so in `block` mode the command is refused rather
   * than run with a partial safety net.
   */
  maxProtectedFiles: number;
  /**
   * Command prefixes that are always allowed, checked against the raw command
   * line. The escape hatch for a project whose normal work looks destructive.
   */
  allow: string[];
}

/** Kind of sensitive file a change policy reacts to. */
export type SensitiveKind = "package" | "lockfile" | "workflow" | "custom";

/**
 * Optional diff/change policy for a single agent turn.
 *
 * Disabled by default: enabling it is a deliberate choice, so upgrading never
 * blocks an existing workflow. When enabled it turns the measured shape of a
 * turn (how many files, how many added lines, whether sensitive files were
 * touched) into a structured, non-negotiable error the agent must answer.
 */
export interface PolicyConfig {
  enabled: boolean;
  /** Maximum changed files per turn; `0` disables the limit. */
  maxChangedFiles: number;
  /** Maximum added lines per turn; `0` disables the limit. */
  maxAddedLines: number;
  /** May the turn change a `package.json`? */
  allowPackageChanges: boolean;
  /** May the turn change a lockfile (`package-lock.json`, …)? */
  allowLockfileChanges: boolean;
  /** May the turn change `.github/workflows/**`? */
  allowWorkflowChanges: boolean;
  /** Extra globs that must never be modified. */
  sensitivePaths: string[];
  /**
   * Refuse a write to a protected path *before* it happens, instead of only
   * reporting it once the turn is over. A refusal the agent reads as a tool
   * error is cheaper than a rollback and leaves nothing to undo; the turn-end
   * evaluation still covers changes that never went through edit/write.
   */
  blockBeforeWrite: boolean;
  /** Restore the turn's files when the policy is violated. */
  rollbackOnViolation: boolean;
}

/** Aggregate shape of the changes a turn made. */
export interface PolicyStats {
  changedFiles: number;
  addedFiles: number;
  deletedFiles: number;
  modifiedFiles: number;
  addedLines: number;
  removedLines: number;
  sensitive: Array<{ path: string; kind: SensitiveKind }>;
}

/** One structured policy failure. `message` is what the agent reads. */
export interface PolicyViolation {
  /** Stable rule id, e.g. "maxChangedFiles" or "allowWorkflowChanges". */
  rule: string;
  message: string;
  /** Project-relative paths the violation refers to (may be empty). */
  paths: string[];
}

export interface PolicyReport {
  passed: boolean;
  stats: PolicyStats;
  violations: PolicyViolation[];
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
  /** Automatically restore the mutated files on a failing critical check. */
  autoRollback: boolean;

  // ── P0: close the loop (Stop-hook equivalent) ───────────────────────────
  /**
   * Legacy alias of `recovery.enabled`, kept in sync by `config.ts` so older
   * configurations and readers keep working.
   */
  autoFix: boolean;
  /** Legacy alias of `recovery.maxAttempts`, kept in sync by `config.ts`. */
  maxAutoRetries: number;

  /** Bounded automatic error correction (the canonical recovery settings). */
  recovery: RecoveryConfig;

  /** Optional diff/change policy for a turn (disabled by default). */
  policy: PolicyConfig;

  /** Governance for the `bash` tool (P9). */
  bash: BashGuardConfig;

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
  /**
   * Learn, from observation, which undeclared tools write files.
   *
   * A tool nobody declared — a hashline editor, an apply-patch — is caught by
   * comparing the file before and after one of its calls. Learning it means the
   * *next* call is snapshotted before it runs, so a failed turn stays undoable.
   *
   * Off means sentinel falls back to the declared names and their shapes only:
   * less protection, and nothing about a project's own tooling is remembered.
   * Which tools were learned is shown by `sentinel_status` and `/sentinel
   * doctor`, because a decision like this has to be readable, not implicit.
   */
  learnMutationTools: boolean;
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

// ── P0: the repair loop ───────────────────────────────────────────────────

/**
 * What the guard did with a red turn, as written to `.autoFixHistory`.
 *
 *   - `injected`:   the agent was re-prompted with the pruned failure.
 *   - `stopped`:    the code state did not move, so the loop stopped itself.
 *   - `exhausted`:  the attempt budget is spent.
 */
export type AutoFixOutcome = "injected" | "stopped" | "exhausted" | "superseded";

/**
 * The decision the repair state machine reached for a red turn.
 *
 * `none` means the failure was reported without being repaired — a `warnOnly`
 * step or an environment failure, neither of which says anything about the
 * code.
 */
export type AutoFixAction = "inject" | "stop-unchanged" | "exhausted" | "none";

/**
 * Everything one verification run concluded, including what it did to the
 * working tree.
 *
 * Produced by the runner (`onFileMutation` and `onTurnEnd` both), consumed by
 * the failure feedback and by the repair state machine.
 */
export interface VerificationOutcome {
  passed: boolean;
  /** Identity of the code state the outcome refers to. */
  stateHash: string;
  /**
   * The inputs this verdict was bound to, as a content hash.
   *
   * Deliberately wider than `changedPaths`: the *run* is invalidated by a change
   * to any file it could read, and the delivery check must use the same rule or
   * it is stricter than the run it is guarding. A message that passes the run's
   * own gate and then sits in a queue while an unrelated file changes would
   * otherwise arrive as a current instruction — which is exactly how a late
   * verdict kept reaching the agent after the code it described was fixed.
   */
  binding?: { stateHash: string; paths: string[] };
  /**
   * True when the working tree moved while the run held it.
   *
   * Non-empty means the verdict describes a tree that no longer exists: the
   * callers must not re-prompt the agent with it, and the run must not have
   * spent a repair attempt. Decided *before* sentinel's own restore, so its own
   * revert is never mistaken for the tree moving.
   */
  staleInputs?: string[];
  /**
   * The files this turn actually changed (a coalesced batch covers several).
   *
   * Deliberately *not* the run's diagnostic focus, which is this set widened by
   * the code graph's dependents. Only a file that changed may become evidence,
   * may define the code state a repair loop is about, or may be judged a
   * regression — a neighbour that was merely recompiled alongside it is none of
   * those things.
   */
  changedPaths: string[];
  /** First critical failure, when the run failed. */
  failure?: VerificationResult;
  warnings: PipelineRunResult["warnings"];
  /** True when the working tree was restored as part of this outcome. */
  rolledBack: boolean;
  /**
   * Regressions as they were *before* sentinel restored anything, so the
   * feedback can say "this was green, I put it back" instead of hiding it.
   */
  regressions: Regression[];
  /** Files left untouched because they changed after the agent's mutation. */
  conflicts: RollbackConflict[];
  /** Files the rollback could not restore at all, so their state is unknown. */
  restoreSkipped: string[];
  /** Set once the same failure has been seen often enough to escalate. */
  escalation?: { count: number; max: number };
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
  /**
   * Files that could not be restored (oversized, unreadable, a symlink). Their
   * state is unknown: sentinel deliberately did nothing to them, so the caller
   * must not claim the tree is either restored or untouched.
   */
  skipped?: string[];
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
  /** Turns stopped by the change policy. */
  policyViolations: number;
  /** Writes refused before they happened (policy or repair scope). */
  blockedWrites: number;
  /** Shell commands refused before they ran. */
  blockedCommands: number;
  /** Files whose pre-state was captured ahead of a destructive command. */
  protectedFiles: number;
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
