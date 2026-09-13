/**
 * pi-sentinel — In-loop Verification, Repair & Rollback Hardening for Pi.
 *
 * Astra/Codex-style guard that runs after file mutations and at turn end.
 * If a verification pipeline fails (type-check, lint, tests), it prunes the
 * error trace to save tokens and feeds a corrected signal back so the agent
 * can self-correct — optionally restoring the working tree to its
 * pre-mutation state.
 *
 * Beyond the original verify-and-report loop, this file wires up the five
 * mechanisms that make the guard behave like Codex / Claude Code:
 *
 *   P0 close the loop   turn_end re-prompts the agent instead of only
 *                       notifying the human (the `Stop` hook equivalent),
 *                       bounded by maxAutoRetries and by "the code state did
 *                       not change, so stop".
 *   P1 checkpoints      the turn's pre-state is flushed to disk, so a later
 *                       turn (or a resumed session) can rewind it.
 *   P2 evidence         files that passed are hashed; a failing check on a
 *                       regressed verified file says so, and older sentinel
 *                       failure traces are marked superseded before every LLM
 *                       call — the measured #1 cause of repair-loop damage.
 *   P3 out-of-band      bash/formatter/git changes are detected via the git
 *                       working tree and verified too.
 *   P4 contract         bounded-repair rules injected into the system prompt.
 *   P5 budget           long checks can run in the background and re-wake the
 *                       agent; model-visible output is capped and spilled.
 *
 * Design (following the pi-email data-oriented pattern):
 *   - All domain data in plain immutable interfaces (src/types.ts)
 *   - I/O isolated in clients/ (pipeline-runner, git-client, snapshot,
 *     checkpoints, evidence, workspace, spill, mindplace)
 *   - Pure formatting functions in formatting/ (pruner, feedback)
 *   - Each capability is a single-responsibility tool module (tools/)
 *   - Config/state in config.ts with atomic, permission-safe persistence
 *
 * Tools:
 *   - sentinel_verify:   Run verification pipelines on demand
 *   - sentinel_rollback: Restore this turn's changes, or reset to HEAD
 *   - sentinel_rewind:   List/restore durable turn checkpoints
 *   - sentinel_status:   Show config, git state, history
 *
 * Hooks:
 *   - session_start:      Make config cwd-aware, announce armed state.
 *   - before_agent_start: Reset the repair budget, inject the contract (P4).
 *   - turn_start:         Begin a snapshot + checkpoint scope.
 *   - tool_call:          Snapshot the target file before an edit/write.
 *   - tool_result:        Run onFileMutation pipelines, record evidence.
 *   - turn_end:           Flush the checkpoint (P1), scan for out-of-band
 *                         changes (P3), run onTurnEnd pipelines (P5) and
 *                         re-prompt on failure (P0).
 *   - context:            Mark superseded sentinel traces (P2).
 *
 * Commands:
 *   - /sentinel:  status / verify / test / rollback / rewind / config / help
 */

import type {
  ExtensionAPI,
  ExtensionUIContext,
  ToolCallEvent,
  ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import { isAbsolute, resolve, relative, sep } from "node:path";

import { PipelineRunner } from "./src/clients/pipeline-runner.ts";
import { GitClient } from "./src/clients/git-client.ts";
import {
  rollbackMutation,
  rollbackMutations,
  rollbackTurn,
  rollbackToHead,
} from "./src/clients/rollback.ts";
import { snapshots, describeRestore } from "./src/clients/snapshot.ts";
import { checkpoints } from "./src/clients/checkpoints.ts";
import { stateHashOf, recordVerified, detectRegressions, revertToVerified } from "./src/clients/evidence.ts";
import { evaluatePolicy, formatPolicyReport, relativePath } from "./src/clients/policy.ts";
import type { PolicyChange } from "./src/clients/policy.ts";
import { outOfBandChanges } from "./src/clients/workspace.ts";
import { describeChange, expandWithDependents } from "./src/clients/mindplace.ts";
import { VerificationQueue } from "./src/clients/queue.ts";
import { escalations, shouldEscalate } from "./src/clients/escalation.ts";
import { buildFailureFeedback, spillDir } from "./src/formatting/feedback.ts";
import { applyOutputCap } from "./src/clients/spill.ts";
import { metricsLines, turnHistoryLines } from "./src/formatting/status.ts";
import { redactEnv } from "./src/formatting/redact.ts";
import { revisionContractText } from "./src/prompt/contract.ts";
import {
  loadConfig,
  getConfig,
  shouldVerify,
  getState,
  recordRollback,
  recordAutoFix,
  recordRegression,
  recordMetrics,
  recordEscalation,
  recordPolicyViolation,
  recordTurnOutcome,
  projectDir,
  policyOf,
  recoveryOf,
} from "./src/config.ts";
import type {
  PipelineRunResult,
  PolicyReport,
  Regression,
  RollbackConflict,
  VerificationResult,
} from "./src/types.ts";

import { SentinelVerifyTool } from "./src/tools/sentinel-verify.ts";
import { SentinelRollbackTool } from "./src/tools/sentinel-rollback.ts";
import { SentinelRewindTool } from "./src/tools/sentinel-rewind.ts";
import { SentinelStatusTool } from "./src/tools/sentinel-status.ts";

// Re-exported so `import { defineConfig } from "@patimweb/pi-sentinel"` works
// for the documented config manifest.
export { defineConfig } from "./src/config.ts";
export { DEFAULT_CONFIG } from "./src/config.ts";
export type { SentinelConfig, PipelineStep } from "./src/types.ts";

/**
 * `customType` of the messages sentinel injects into the conversation, so the
 * context hook can find (and supersede) its own older failure traces.
 */
export const SENTINEL_MESSAGE_TYPE = "sentinel-verify";

const SUPERSEDED_TRACE =
  "[sentinel] This verification result is superseded by a later run — ignore it and act on the most recent sentinel message.";

/** How many diagnostics from dependents we promote into the pruner focus. */
const MAX_IMPACT_FOCUS = 10;

/**
 * Whether a mutated file path lies inside the project the sentinel guards.
 * The sentinel should only verify/rollback mutations that actually touch its
 * own repo — otherwise it reacts to edits in unrelated projects.
 */
function targetInScope(target: string | undefined, cwd: string): boolean {
  if (!target) return true;
  const abs = isAbsolute(target) ? target : resolve(cwd, target);
  const rel = relative(cwd, abs);
  return rel === "" || !rel.startsWith("..");
}

function absPath(target: string, cwd: string): string {
  return isAbsolute(target) ? target : resolve(cwd, target);
}

/** Files sentinel itself produced — never a reason to verify or roll back. */
function isSentinelArtifact(cwd: string, absTarget: string): boolean {
  const graphOut = resolve(cwd, "graph-out") + sep;
  return absTarget.startsWith(graphOut) || absTarget.startsWith(projectDir(cwd) + sep);
}

interface VerificationOutcome {
  passed: boolean;
  /** Identity of the code state the outcome refers to. */
  stateHash: string;
  /** The files the run actually covered (a coalesced batch covers several). */
  focusPaths: string[];
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
  /** Set once the same failure has been seen often enough to escalate. */
  escalation?: { count: number; max: number };
}

/** One mutation's verification request, batched by the queue. */
interface MutationRequest {
  cwd: string;
  ctx: { ui: ExtensionUIContext };
  focusPaths: string[];
  toolCallIds: string[];
}

type AutoFixAction = "inject" | "stop-unchanged" | "exhausted" | "none";

export default function (pi: ExtensionAPI) {
  // ── Repair-loop bookkeeping (P0) ────────────────────────────────────────

  /** Consecutive auto-fix continuations since the last green run / prompt. */
  let autoFixAttempts = 0;
  /** State hash we already re-prompted for — stops the loop when nothing moves. */
  let lastInjectedStateHash: string | null = null;
  /** The paths that hash referred to, so a no-op turn can be compared at all. */
  let lastInjectedPaths: string[] = [];
  /**
   * Checkpoint of the *first* turn in the current red cycle. Recovery
   * exhaustion restores exactly this, so `rollbackAfterExhaustion` returns to
   * the state before the first failed attempt rather than merely undoing the
   * last one.
   */
  let recoveryStartCheckpointId: string | null = null;
  /** In-flight background verification (P5); one at a time. */
  let backgroundRun: Promise<void> | null = null;
  /**
   * Signature of the last policy violation we already re-prompted for. An
   * identical violation is reported to the human but never re-sent to the
   * agent, which is what keeps a policy stop from becoming a loop.
   */
  let lastPolicySignature: string | null = null;

  /**
   * Mutation verifications are batched: with a debounce window, edits that
   * land together (parallel tool calls in one assistant message) produce a
   * single run instead of one run per edit. With the default window of `0`
   * this is a direct pass-through and behaves exactly as before.
   */
  const mutationQueue = new VerificationQueue<string, MutationRequest, VerificationOutcome>(
    async (_key, requests) => {
      const first = requests[0];
      const focusPaths = [...new Set(requests.flatMap((request) => request.focusPaths))];
      const outcome = await runVerificationSafely({
        trigger: "onFileMutation",
        cwd: first.cwd,
        ctx: first.ctx,
        // One run, the union of every request in the batch.
        focusPaths,
        toolCallIds: [...new Set(requests.flatMap((request) => request.toolCallIds))],
      });
      if (outcome) return outcome;
      // The runner threw: do not invent a failure. The mutation stands and the
      // human was told the check could not complete.
      return {
        passed: true,
        stateHash: "",
        focusPaths,
        warnings: [],
        rolledBack: false,
        regressions: [],
        conflicts: [],
      };
    },
    0,
  );

  /**
   * Resolve configuration on every session event (cwd-aware). We reload
   * each time so editing `sentinel.config.ts` takes effect without a pi
   * restart — loadConfig cache-busts the module by its file content.
   */
  async function ensureConfig(cwd: string): Promise<void> {
    await loadConfig(cwd);
    // The debounce window is configuration, and configuration can change.
    mutationQueue.setDebounce(getConfig().verification.debounceMs);
  }

  function resetRepairBudget(): void {
    autoFixAttempts = 0;
    lastInjectedStateHash = null;
    lastInjectedPaths = [];
    recoveryStartCheckpointId = null;
    lastPolicySignature = null;
    // A new user turn (or a repaired loop) is a fresh start for escalation.
    escalations.reset();
  }

  /**
   * Verification focus: the mutated files plus — when a code graph exists —
   * their dependents, so diagnostics in affected files are promoted instead of
   * being buried under unrelated output.
   */
  function focusFor(cwd: string, paths: string[]): string[] {
    const conf = getConfig();
    if (!conf.impactAwareFocus || paths.length === 0) return paths;
    try {
      return expandWithDependents(cwd, paths, MAX_IMPACT_FOCUS);
    } catch {
      return paths;
    }
  }

  /**
   * Build the change-policy view of a turn: pre-state from the snapshot
   * journal, post-state from disk. A file whose pre-state was never captured
   * (a bash-only change) is marked unknown, so its line counts are reported as
   * zero instead of being invented.
   */
  function policyChangesFor(cwd: string, paths: string[]): PolicyChange[] {
    const pre = new Map(snapshots.turnSnapshots().map((snap) => [snap.path, snap]));
    const changes: PolicyChange[] = [];
    for (const raw of [...new Set(paths.map((p) => absPath(p, cwd)))]) {
      const snap = pre.get(raw);
      let after: string | null = null;
      try {
        after = fs.readFileSync(raw, "utf-8");
      } catch {
        after = null;
      }
      if (snap && !snap.incomplete && snap.data !== null) {
        changes.push({ path: raw, before: snap.data.toString("utf-8"), beforeKnown: true, after });
      } else if (snap && !snap.existed) {
        changes.push({ path: raw, before: null, beforeKnown: true, after });
      } else {
        changes.push({ path: raw, before: null, beforeKnown: false, after });
      }
    }
    return changes;
  }

  /**
   * Stop a turn whose change shape violates the policy.
   *
   * The violation is recorded, optionally rolled back, and — once per distinct
   * violation — sent to the agent as a follow-up. A repeated identical
   * violation is reported to the human but never re-sent, so a policy stop can
   * never turn into a loop of its own.
   */
  function handlePolicyViolation(args: {
    report: PolicyReport;
    cwd: string;
    ctx: { ui: ExtensionUIContext };
    focusPaths: string[];
  }): void {
    const policy = policyOf(getConfig());
    const files = [...new Set(args.report.violations.flatMap((v) => v.paths))];
    recordPolicyViolation({
      at: new Date().toISOString(),
      rules: args.report.violations.map((v) => v.rule),
      files,
    });
    recordMetrics({ policyViolations: 1 });

    let rolledBack = false;
    if (policy.rollbackOnViolation) {
      const rb = rollbackTurn(args.cwd);
      rolledBack = rb.success;
      if (rb.conflicts && rb.conflicts.length > 0) {
        args.ctx.ui.notify(
          `Sentinel left ${rb.conflicts.length} file(s) untouched (policy violation).`,
          "error",
        );
      } else if (rb.success) {
        recordRollback({
          at: new Date().toISOString(),
          branch: rb.branch ?? "unknown",
          head: rb.committedAt ?? "unknown",
          reason: "policy",
          method: rb.method,
        });
      }
    }

    const text =
      formatPolicyReport(args.report, args.cwd) +
      (rolledBack ? "\n\nThe violating files were restored to their pre-turn state." : "");
    // Hash the offending files themselves, resolved against the project root so
    // the signature never depends on the process working directory. A rule with
    // no paths (maxChangedFiles/maxAddedLines) falls back to the turn scope.
    const signaturePaths = (files.length > 0 ? files : args.focusPaths).map((p) =>
      absPath(p, args.cwd),
    );
    const signature = `${stateHashOf(signaturePaths)}:${args.report.violations
      .map((v) => v.rule)
      .join(",")}`;

    args.ctx.ui.notify(text, "error");

    if (lastPolicySignature === signature) {
      args.ctx.ui.notify(
        "Sentinel: the same policy violation repeated — stopping instead of re-prompting.",
        "warning",
      );
      return;
    }
    lastPolicySignature = signature;
    pi.sendMessage(
      {
        customType: SENTINEL_MESSAGE_TYPE,
        content: text,
        display: true,
        details: { policy: true, rules: args.report.violations.map((v) => v.rule) },
      },
      { deliverAs: "followUp", triggerTurn: true },
    );
  }

  function notifyWarnings(ctx: { ui: ExtensionUIContext }, warnings: PipelineRunResult["warnings"], cwd: string): void {
    if (warnings.length === 0) return;
    const conf = getConfig();
    const detail = warnings
      .map((w) => `${w.step} (exit ${w.exitCode}):\n${w.prunedTrace}`)
      .join("\n");
    const capped = applyOutputCap(
      `Sentinel warnings:\n${detail}`,
      conf.maxOutputTokens,
      spillDir(cwd),
      "warnings",
    );
    ctx.ui.notify(capped.text, "warning");
  }

  /**
   * Run a pipeline group, record evidence on success, and — on failure —
   * decide what actually happened to the working tree (rollback, regression
   * revert, or nothing).
   */
  async function runVerification(args: {
    trigger: "onFileMutation" | "onTurnEnd";
    cwd: string;
    ctx: { ui: ExtensionUIContext };
    focusPaths: string[];
    /** Mutations this verification belongs to (a coalesced batch holds several). */
    toolCallIds?: string[];
    /** Set false in background mode: a later turn owns the tree by then. */
    allowRollback?: boolean;
    /** Bypass the verification cache (explicit runs). */
    skipCache?: boolean;
  }): Promise<VerificationOutcome> {
    const conf = getConfig();
    const runner = new PipelineRunner();
    const run = await runner.runAll(args.trigger, args.cwd, {
      focusPaths: args.focusPaths,
      changedFiles: args.focusPaths,
      skipCache: args.skipCache,
    });
    const stateHash = stateHashOf(args.focusPaths);

    if (run.passed) {
      args.ctx.ui.setStatus("sentinel", undefined);
      // A green run means the repair loop converged: stop escalating. Runs that
      // executed nothing at all prove nothing, so they must not clear the
      // counters either (an empty mutation group fires after every edit).
      if (run.steps.length > 0) escalations.reset();
      // Evidence only counts when something actually ran: an empty pipeline
      // group proves nothing, and claiming "verified" for it would be a lie.
      if (conf.trackVerifiedState && args.focusPaths.length > 0 && run.steps.length > 0) {
        try {
          recordVerified(
            args.cwd,
            args.focusPaths,
            `${args.trigger}:${run.steps.map((s) => s.name).join("+") || "none"}`,
          );
        } catch {
          /* evidence is an optimisation, never a failure source */
        }
      }
      notifyWarnings(args.ctx, run.warnings, args.cwd);
      return {
        passed: true,
        stateHash,
        focusPaths: args.focusPaths,
        warnings: run.warnings,
        rolledBack: false,
        regressions: [],
        conflicts: [],
      };
    }

    const failure = run.failure!;
    args.ctx.ui.setStatus("sentinel", undefined);

    // 0) Detect regressions first: a later revert must not erase the evidence
    //    that the file *was* green before this revision.
    let regressions =
      conf.trackVerifiedState ? detectRegressionsSafe(args.cwd, args.focusPaths) : [];

    // 1) Whole-scope rollback (opt-in, never for warnOnly steps).
    let rolledBack = false;
    let conflicts: RollbackConflict[] = [];
    if (conf.autoRollback && !failure.warnOnly && args.allowRollback !== false) {
      const ids = args.toolCallIds ?? [];
      const rb =
        ids.length > 1
          ? rollbackMutations(ids, args.cwd)
          : ids.length === 1
            ? rollbackMutation(ids[0], args.cwd)
            : rollbackTurn(args.cwd);
      rolledBack = rb.success;
      conflicts = rb.conflicts ?? [];
      recordMetrics({ rollbacks: 1, partialRollbacks: rb.partial ? 1 : 0 });
      // The rollback *was* attempted, so it belongs in the history even when
      // it came back partial — that is exactly the case a user must know about.
      recordRollback({
        at: new Date().toISOString(),
        branch: rb.branch ?? "unknown",
        head: rb.committedAt ?? "unknown",
        reason: failure.step,
        method: rb.method,
      });
      if (conflicts.length > 0) {
        args.ctx.ui.notify(
          `Sentinel left ${conflicts.length} file(s) untouched: they changed after its snapshot.`,
          "error",
        );
      } else if (rb.success) {
        args.ctx.ui.notify(`Sentinel restored your changes (${failure.step} failed)`, "error");
      } else if (rb.method === "none") {
        // No snapshot existed, so there was nothing safe to restore. Say so
        // plainly instead of calling it a failure — the work is still there.
        args.ctx.ui.notify(
          `Sentinel did not roll back (${failure.step} failed): no snapshot was captured, so the changes are still in place.`,
          "warning",
        );
      } else {
        args.ctx.ui.notify(`Sentinel rollback failed: ${rb.message}`, "error");
      }
    }

    // 2) Otherwise, only the individual files that regressed from a state
    //    which used to pass. This is the P2 revert, and it is narrower than a
    //    turn rollback: it leaves the rest of the turn's work alone.
    if (!rolledBack && conf.trackVerifiedState && conf.revertOnRegression) {
      regressions = regressions.map((regression) => {
        if (!revertToVerified(args.cwd, regression.path)) return regression;
        recordRegression({
          at: new Date().toISOString(),
          path: regression.path,
          verifiedAt: regression.verifiedAt,
          reverted: true,
        });
        args.ctx.ui.notify(
          `Sentinel restored ${relative(args.cwd, regression.path)} to its verified state`,
          "warning",
        );
        return { ...regression, reverted: true };
      });
    }

    if (rolledBack) {
      // The whole tree came back, so every listed regression is already undone.
      regressions = regressions.map((r) => ({ ...r, reverted: true }));
    }

    // 3) Repeated-failure escalation: the state keeps changing but the error
    //    does not, which means the *approach* is wrong, not the last edit.
    const escalationSettings = conf.verification.failureEscalation;
    const seen = escalations.record(failure.signature);
    let escalation: { count: number; max: number } | undefined;
    if (escalationSettings.enabled && shouldEscalate(seen, escalationSettings.maxRepeatedFailures)) {
      escalation = { count: seen, max: escalationSettings.maxRepeatedFailures };
      recordEscalation({
        at: new Date().toISOString(),
        step: failure.step,
        kind: failure.failureKind,
        count: seen,
        signature: failure.signature,
      });
      recordMetrics({ escalations: 1 });
    }

    notifyWarnings(args.ctx, run.warnings, args.cwd);
    return {
      passed: false,
      stateHash,
      focusPaths: args.focusPaths,
      failure,
      warnings: run.warnings,
      rolledBack,
      regressions,
      conflicts,
      escalation,
    };
  }

  /** Never let a ledger read break a verification run. */
  function detectRegressionsSafe(cwd: string, paths: string[]): Regression[] {
    try {
      return detectRegressions(cwd, paths);
    } catch {
      return [];
    }
  }

  /** Render the model-visible failure payload for one red verification run. */
  function renderFailure(
    outcome: VerificationOutcome,
    focusPaths: string[],
    cwd: string,
    attempt?: { attempt: number; max: number; stopped?: boolean },
    stateHashOverride?: string,
  ): string {
    const conf = getConfig();
    const failure = outcome.failure!;
    return buildFailureFeedback({
      cwd,
      step: failure.step,
      exitCode: failure.exitCode,
      durationMs: failure.durationMs,
      prunedTrace: failure.prunedTrace,
      rawOutput: failure.rawOutput,
      warnOnly: failure.warnOnly,
      rolledBack: outcome.rolledBack,
      focusPaths,
      stateHash: stateHashOverride ?? outcome.stateHash,
      regressions: outcome.regressions,
      attempt,
      failureKind: failure.failureKind,
      timedOut: failure.timedOut,
      errorSummary: failure.errorSummary,
      attempts: failure.attempts,
      escalation: outcome.escalation,
      conflicts: outcome.conflicts,
      maxOutputTokens: conf.maxOutputTokens,
    }).text;
  }

  /**
   * P0 — decide what happens after a red turn, then either re-prompt the agent
   * or hand the failure to the human.
   *
   * The stop conditions mirror Codex's repair-loop guidance: the checks pass,
   * the retry budget is exhausted, or the code state did not change (so another
   * attempt would repeat itself) — the latter is what "the remaining delta
   * stops changing" means in practice.
   */
  function handleRedTurn(args: {
    outcome: VerificationOutcome;
    focusPaths: string[];
    cwd: string;
    ctx: { ui: ExtensionUIContext };
    /** Pre-state checkpoint of this turn, used by rollbackAfterExhaustion. */
    checkpointId?: string;
  }): void {
    const conf = getConfig();
    const recovery = recoveryOf(conf);
    const failure = args.outcome.failure!;

    // "The remaining delta stops changing" (Codex's stop condition) needs a
    // stable subject: a turn that changed nothing still refers to the files of
    // the previous attempt, so both are hashed over the same path set.
    const deltaPaths =
      args.focusPaths.length > 0
        ? args.focusPaths
        : lastInjectedPaths.length > 0
          ? lastInjectedPaths
          : args.focusPaths;
    const stateHash = stateHashOf(deltaPaths);

    let action: AutoFixAction = "none";
    let attemptInfo: { attempt: number; max: number; stopped?: boolean } | undefined;

    if (recovery.enabled && !failure.warnOnly) {
      if (lastInjectedStateHash === stateHash) {
        action = "stop-unchanged";
        recordAutoFix({
          at: new Date().toISOString(),
          step: failure.step,
          attempt: autoFixAttempts,
          outcome: "stopped",
          reason: "identical code state",
        });
      } else if (autoFixAttempts + 1 > recovery.maxAttempts) {
        action = "exhausted";
        // Bounded recovery: the attempt budget is spent. Optionally return to
        // the state before the first turn of this failing cycle, so neither
        // the agent nor the user inherits a half-finished edit.
        if (recovery.rollbackAfterExhaustion && recoveryStartCheckpointId) {
          // `force` on purpose: the conflict check refuses to overwrite a file
          // that changed after the checkpoint, which is exactly the set of
          // intermediate repair attempts this restore is meant to discard.
          // Only files in the checkpoint are touched, so unrelated work stays.
          const report = checkpoints.restore(args.cwd, recoveryStartCheckpointId, { force: true });
          if (report.attempted) {
            args.outcome.rolledBack = !report.partial;
            args.outcome.conflicts = report.conflicts;
            recordRollback({
              at: new Date().toISOString(),
              branch: "checkpoint",
              head: recoveryStartCheckpointId,
              reason: `recovery-exhausted:${failure.step}`,
              method: "checkpoint:recovery",
            });
            recordMetrics({ rollbacks: 1, partialRollbacks: report.partial ? 1 : 0 });
            args.ctx.ui.notify(
              `Sentinel: recovery exhausted — restored the state before the failing cycle (${describeRestore(report)}).`,
              "warning",
            );
          }
        }
        recoveryStartCheckpointId = null;
        recordAutoFix({
          at: new Date().toISOString(),
          step: failure.step,
          attempt: autoFixAttempts,
          outcome: "exhausted",
          reason: `recovery.maxAttempts=${recovery.maxAttempts}`,
        });
      } else {
        autoFixAttempts += 1;
        // Remember where this failing cycle began: exhaustion restores from
        // here, not from the last attempt.
        if (recoveryStartCheckpointId === null && args.checkpointId) {
          recoveryStartCheckpointId = args.checkpointId;
        }
        lastInjectedStateHash = stateHash;
        lastInjectedPaths = deltaPaths;
        attemptInfo = { attempt: autoFixAttempts, max: recovery.maxAttempts };
        action = "inject";
        recordAutoFix({
          at: new Date().toISOString(),
          step: failure.step,
          attempt: autoFixAttempts,
          outcome: "injected",
          reason: failure.step,
        });
      }
    }

    const text = renderFailure(
      args.outcome,
      args.focusPaths,
      args.cwd,
      action === "stop-unchanged"
        ? { attempt: autoFixAttempts, max: recovery.maxAttempts, stopped: true }
        : attemptInfo,
      stateHash,
    );

    if (action === "inject") {
      pi.sendMessage(
        {
          customType: SENTINEL_MESSAGE_TYPE,
          content: text,
          display: true,
          details: {
            step: failure.step,
            stateHash,
            attempt: attemptInfo?.attempt,
            max: attemptInfo?.max,
          },
        },
        { deliverAs: "followUp", triggerTurn: true },
      );
      args.ctx.ui.notify(
        `Sentinel: ${failure.step} failed — re-prompting the agent (attempt ${autoFixAttempts}/${recovery.maxAttempts})`,
        "warning",
      );
      return;
    }

    args.ctx.ui.notify(text, "error");

    if (action === "stop-unchanged") {
      resetRepairBudget();
      args.ctx.ui.notify(
        "Sentinel: the code state did not change since the last repair attempt — stopping the loop instead of repeating it.",
        "warning",
      );
    } else if (action === "exhausted") {
      args.ctx.ui.notify(
        `Sentinel: ${recovery.maxAttempts} recovery attempts exhausted — reporting instead of editing further.`,
        "warning",
      );
    }
  }

  // ── Tools ──────────────────────────────────────────────────────────────

  pi.registerTool(SentinelVerifyTool);
  pi.registerTool(SentinelRollbackTool);
  pi.registerTool(SentinelRewindTool);
  pi.registerTool(SentinelStatusTool);

  // ── Hook: session_start ────────────────────────────────────────────────

  pi.on("session_start", async (_event, ctx) => {
    await ensureConfig(ctx.cwd);
    resetRepairBudget();
    const conf = getConfig();
    if (conf.enabled) {
      const extras = [
        conf.autoFix ? "auto-fix" : null,
        conf.autoRollback ? "auto-rollback" : null,
        conf.trackVerifiedState ? "evidence" : null,
        conf.detectOutOfBand ? "out-of-band" : null,
        mutationQueue.debouncing ? `debounce ${conf.verification.debounceMs}ms` : null,
        conf.verification.cache.enabled ? "cache" : null,
        conf.verification.failureEscalation.enabled ? "escalation" : null,
      ].filter(Boolean);
      ctx.ui.notify(`Sentinel armed (${extras.join(", ")})`, "info");
    }
  });

  // ── Hook: before_agent_start (P4) ──────────────────────────────────────
  // The contract is (re)stated per user turn, so the rules are scoped to the
  // work that was actually asked for.

  pi.on("before_agent_start", async (event, ctx) => {
    await ensureConfig(ctx.cwd);
    const conf = getConfig();
    if (!conf.enabled) return;

    const contract = revisionContractText(conf);
    if (!contract) return;

    return { systemPrompt: `${event.systemPrompt}\n\n${contract}` };
  });

  // ── Hook: message_start (P0 budget) ────────────────────────────────────
  // Only a real user message starts a fresh repair budget. Sentinel's own
  // auto-fix continuations arrive as `custom` messages, so they keep counting
  // towards maxAutoRetries instead of resetting it every round — which is the
  // difference between a bounded loop and an unbounded one.

  pi.on("message_start", async (event) => {
    const role = (event.message as { role?: string } | undefined)?.role;
    if (role === "user") resetRepairBudget();
  });

  // ── Hook: turn_start (P1) ──────────────────────────────────────────────

  pi.on("turn_start", async (event, ctx) => {
    snapshots.beginTurn();
    await ensureConfig(ctx.cwd);
    const conf = getConfig();
    if (!conf.enabled) return;

    let entryId: string | undefined;
    try {
      entryId = ctx.sessionManager.getLeafId() ?? undefined;
    } catch {
      entryId = undefined;
    }

    checkpoints.begin({
      turnIndex: event.turnIndex,
      entryId,
      session: safeSessionFile(ctx),
    });
  });

  // ── Hook: tool_call ────────────────────────────────────────────────────

  pi.on("tool_call", async (event: ToolCallEvent, ctx) => {
    await ensureConfig(ctx.cwd);
    const conf = getConfig();
    if (!conf.enabled) return;

    const isMutation =
      isToolCallEventType("edit", event) || isToolCallEventType("write", event);
    if (!isMutation) return;

    const input = event.input as Record<string, unknown>;
    const target = (input.path ?? input.filePath ?? input.file) as string | undefined;
    if (target && !targetInScope(target, ctx.cwd)) return;
    if (target && !shouldVerify(target, conf, ctx.cwd)) return;

    if (target) {
      const abs = absPath(target, ctx.cwd);
      // Captured *before* the mutation runs, so a failure can be undone
      // precisely — including files the agent newly creates.
      snapshots.captureCall(event.toolCallId, abs);
      snapshots.captureTurn(abs);
    }

    ctx.ui.setStatus("sentinel", "Mutation detected — verifying...");
  });

  // ── Hook: tool_result (mutation pipeline) ──────────────────────────────

  pi.on("tool_result", async (event: ToolResultEvent, ctx) => {
    await ensureConfig(ctx.cwd);
    const conf = getConfig();
    if (!conf.enabled) return;

    const isMutation = event.toolName === "edit" || event.toolName === "write";
    if (!isMutation) return;

    // A failed edit/write changed nothing — no need to verify.
    if (event.isError) {
      snapshots.endCall(event.toolCallId);
      return;
    }

    const target = (event.input?.path ?? event.input?.filePath) as string | undefined;
    if (target && !targetInScope(target, ctx.cwd)) {
      snapshots.endCall(event.toolCallId);
      return;
    }
    if (target && !shouldVerify(target, conf, ctx.cwd)) {
      snapshots.endCall(event.toolCallId);
      return;
    }

    // Byte-identical rewrite: nothing changed, skip the pipeline entirely.
    if (snapshots.isCallUnchanged(event.toolCallId)) {
      snapshots.endCall(event.toolCallId);
      return;
    }

    // Record what the agent's write left on disk. A later rollback compares
    // the file against this state, so an edit that happens in between (a
    // formatter, another process, the user) is never overwritten silently.
    snapshots.capturePost(event.toolCallId);

    const focusPaths = focusFor(ctx.cwd, target ? [absPath(target, ctx.cwd)] : []);
    const outcome = await mutationQueue.enqueue(ctx.cwd, {
      cwd: ctx.cwd,
      ctx,
      focusPaths,
      toolCallIds: [event.toolCallId],
    });

    snapshots.endCall(event.toolCallId);

    if (outcome.passed) return;

    // Prepend the pruned error while keeping the original result blocks. The
    // run may have covered more files than this hook did (coalesced batch), so
    // the scope of the run is what the payload describes. Formatting is
    // best-effort: a broken ledger must not turn into a hook exception.
    let failureText: string;
    try {
      failureText = renderFailure(outcome, outcome.focusPaths, ctx.cwd);
    } catch {
      failureText = `[sentinel] Verification failed at step "${outcome.failure?.step ?? "unknown"}" (exit ${outcome.failure?.exitCode ?? -1}). The failure could not be formatted; inspect the output manually.`;
    }
    return {
      content: [
        { type: "text" as const, text: failureText },
        ...(event.content ?? []),
      ],
      isError: true as const,
    };
  });

  // ── Hook: turn_end (P1 + P3 + P5 + P0) ─────────────────────────────────

  pi.on("turn_end", async (event, ctx) => {
    await ensureConfig(ctx.cwd);
    const conf = getConfig();

    // Everything below must read the turn scope *before* it is cleared.
    const turnPaths = snapshots.turnPaths();

    // P3 — changes that never went through edit/write (bash, formatters, git).
    let outOfBand: string[] = [];
    if (conf.enabled && conf.detectOutOfBand) {
      try {
        outOfBand = outOfBandChanges(ctx.cwd, turnPaths, (p) => {
          const abs = resolve(p);
          if (isSentinelArtifact(ctx.cwd, abs)) return true;
          return !shouldVerify(abs, conf, ctx.cwd);
        }).map((change) => change.path);
      } catch {
        outOfBand = [];
      }
    }

    const focusPaths = [...new Set([...turnPaths, ...outOfBand])];

    // Change policy — evaluated before anything is verified or persisted. A
    // violation is a hard stop for the turn, and it is the one check whose
    // whole point is that green code can still be the wrong change.
    if (conf.enabled && conf.policy.enabled && focusPaths.length > 0) {
      try {
        const report = evaluatePolicy(policyChangesFor(ctx.cwd, focusPaths), conf.policy, ctx.cwd);
        if (!report.passed) {
          handlePolicyViolation({ report, cwd: ctx.cwd, ctx, focusPaths });
          snapshots.beginTurn();
          return;
        }
        // A clean turn reopens the policy stop, so a later identical violation
        // is reported to the agent again.
        lastPolicySignature = null;
      } catch {
        // A policy bug must never block verification: report nothing and let
        // the normal pipeline decide.
      }
    }

    // P1 — persist the turn's pre-state so it can be rewound later. The
    // post-mutation hashes come along, so a rewind can refuse to overwrite a
    // file that changed after that turn.
    let checkpointId: string | undefined;
    if (conf.enabled) {
      try {
        checkpoints.captureSnapshots(snapshots.turnSnapshots(), snapshots.turnPostHashes());
        checkpoints.setLabel(describeChange(ctx.cwd, focusPaths));
        const summary = checkpoints.flush(ctx.cwd, conf.checkpointRetention);
        checkpointId = summary?.id;
      } catch {
        checkpointId = undefined;
      }
    }

    if (!conf.enabled) {
      snapshots.beginTurn();
      return;
    }

    if (outOfBand.length > 0) {
      ctx.ui.notify(
        `Sentinel: ${outOfBand.length} file(s) changed outside edit/write — verifying them too.`,
        "info",
      );
    }

    if (conf.pipelines.onTurnEnd.length === 0) {
      snapshots.beginTurn();
      return;
    }

    // P5 — background mode: do not make the turn wait for the slow checks.
    if (conf.backgroundTurnEnd) {
      startBackgroundChecks({ cwd: ctx.cwd, ctx, focusPaths, checkpointId });
      snapshots.beginTurn();
      return;
    }

    const outcome = await runVerificationSafely({
      trigger: "onTurnEnd",
      cwd: ctx.cwd,
      ctx,
      focusPaths,
    });

    if (!outcome) {
      // Verification failed in an unexpected way — never crash the session.
      snapshots.beginTurn();
      return;
    }

    recordTurnOutcome({
      at: new Date().toISOString(),
      turnIndex: turnIndexOf(event),
      passed: outcome.passed,
      step: outcome.failure?.step,
    });

    if (outcome.passed) {
      resetRepairBudget();
    } else {
      handleRedTurnSafely({ outcome, focusPaths, cwd: ctx.cwd, ctx, checkpointId });
    }

    // The turn is over — drop its snapshot scope either way.
    snapshots.beginTurn();
  });

  /**
   * A verification failure must never take the agent session down with it.
   * Returns null when the runner itself threw (disk full, spawn abuse, …).
   */
  async function runVerificationSafely(args: {
    trigger: "onFileMutation" | "onTurnEnd";
    cwd: string;
    ctx: { ui: ExtensionUIContext };
    focusPaths: string[];
    toolCallIds?: string[];
    allowRollback?: boolean;
    skipCache?: boolean;
  }): Promise<VerificationOutcome | null> {
    try {
      return await runVerification(args);
    } catch (err) {
      args.ctx.ui.setStatus("sentinel", undefined);
      args.ctx.ui.notify(
        `Sentinel: verification could not complete (${(err as Error)?.message ?? "unknown error"}). The code was left untouched.`,
        "error",
      );
      return null;
    }
  }

  /** Feedback delivery is best-effort: it must not break the turn either. */
  function handleRedTurnSafely(args: {
    outcome: VerificationOutcome;
    focusPaths: string[];
    cwd: string;
    ctx: { ui: ExtensionUIContext };
    checkpointId?: string;
  }): void {
    try {
      handleRedTurn(args);
    } catch {
      /* the failure is already visible through the status line */
    }
  }

  /**
   * P5 — run the slow pipelines without blocking the turn end, then wake the
   * agent if they fail.
   *
   * Rollback is only attempted while the failed turn is still the newest
   * checkpoint: if the agent already produced a newer turn, restoring the old
   * state would silently discard work the user has not seen yet, so sentinel
   * reports instead.
   */
  function startBackgroundChecks(args: {
    cwd: string;
    ctx: { ui: ExtensionUIContext };
    focusPaths: string[];
    checkpointId?: string;
  }): void {
    if (backgroundRun) {
      args.ctx.ui.notify(
        "Sentinel: a background verification is still running — skipping this turn's checks.",
        "info",
      );
      return;
    }

    const conf = getConfig();
    args.ctx.ui.setStatus("sentinel", "Checks running in background…");

    backgroundRun = (async () => {
      try {
        const outcome = await runVerification({
          trigger: "onTurnEnd",
          cwd: args.cwd,
          ctx: args.ctx,
          focusPaths: args.focusPaths,
          allowRollback: false,
        });

        if (outcome.passed) {
          resetRepairBudget();
          return;
        }

        recordTurnOutcome({
          at: new Date().toISOString(),
          turnIndex: -1,
          passed: false,
          step: outcome.failure?.step,
        });

        if (
          conf.autoRollback &&
          args.checkpointId &&
          !outcome.failure?.warnOnly &&
          checkpoints.latest(args.cwd)?.id === args.checkpointId
        ) {
          const report = checkpoints.restore(args.cwd, args.checkpointId);
          if (report.attempted) {
            outcome.rolledBack = !report.partial;
            recordRollback({
              at: new Date().toISOString(),
              branch: "unknown",
              head: "checkpoint",
              reason: `background:${outcome.failure?.step ?? "unknown"}`,
              method: "checkpoint:turn",
            });
            args.ctx.ui.notify(
              `Sentinel restored this turn (${describeRestore(report)}) after a background failure.`,
              "error",
            );
          }
        }

        handleRedTurnSafely({
          outcome,
          focusPaths: args.focusPaths,
          cwd: args.cwd,
          ctx: args.ctx,
          checkpointId: args.checkpointId,
        });
      } catch {
        /* background verification must never crash the session */
      } finally {
        backgroundRun = null;
        args.ctx.ui.setStatus("sentinel", undefined);
      }
    })();
  }

  // ── Hook: context (P2 — stale-trace hygiene) ───────────────────────────
  // The strongest documented harm in repair loops is acting on a verification
  // trace that no longer describes the current code. Sentinel keeps only its
  // newest trace live and marks older ones superseded.

  pi.on("context", async (event) => {
    const conf = getConfig();
    if (!conf.enabled || !conf.pruneStaleTraces) return;

    const messages = event.messages as unknown as Array<Record<string, unknown>>;
    if (!Array.isArray(messages) || messages.length === 0) return;

    const indices: number[] = [];
    for (let i = 0; i < messages.length; i += 1) {
      const message = messages[i];
      if (message?.role === "custom" && message.customType === SENTINEL_MESSAGE_TYPE) {
        indices.push(i);
      }
    }
    if (indices.length <= 1) return;

    const newest = indices[indices.length - 1];
    let changed = false;
    const next = messages.map((message, i) => {
      if (i === newest || !indices.includes(i)) return message;
      if (message.content === SUPERSEDED_TRACE) return message;
      changed = true;
      return {
        ...message,
        content: Array.isArray(message.content)
          ? [{ type: "text", text: SUPERSEDED_TRACE }]
          : SUPERSEDED_TRACE,
      };
    });

    if (!changed) return;
    return { messages: next as unknown as typeof event.messages };
  });

  // ── Command: /sentinel ─────────────────────────────────────────────────

  pi.registerCommand("sentinel", {
    description: "Sentinel verification, repair & rollback control",
    getArgumentCompletions: (prefix) => {
      const options = ["status", "verify", "test", "rollback", "rewind", "config", "help"];
      return options.filter((o) => o.startsWith(prefix)).map((o) => ({ label: o, value: o }));
    },
    handler: async (args, ctx) => {
      await ensureConfig(ctx.cwd);
      const conf = getConfig();
      const [sub = "help"] = (args ?? "").trim().split(/\s+/);

      switch (sub) {
        case "status": {
          ctx.ui.setWidget("sentinel", statusLines(ctx.cwd, conf));
          return;
        }
        case "verify": {
          const runner = new PipelineRunner();
          const run = await runner.runAll("onFileMutation", ctx.cwd);
          ctx.ui.setWidget(
            "sentinel",
            run.passed
              ? [`[sentinel] All ${run.steps.length} checks passed.`]
              : run.failure!.formattedError.split("\n"),
          );
          return;
        }
        case "test": {
          const runner = new PipelineRunner();
          const run = await runner.runAll("onTurnEnd", ctx.cwd);
          ctx.ui.setWidget(
            "sentinel",
            run.passed
              ? [`[sentinel] All ${run.steps.length} turn-end checks passed.`]
              : run.failure!.formattedError.split("\n"),
          );
          return;
        }
        case "rollback": {
          const result = snapshots.hasTurnSnapshot()
            ? rollbackTurn(ctx.cwd)
            : rollbackToHead(ctx.cwd);
          ctx.ui.setWidget("sentinel", [`[sentinel] ${result.message}`]);
          return;
        }
        case "rewind": {
          await runRewindCommand(ctx);
          return;
        }
        case "config": {
          // Never print configured credentials: the config is injected into
          // the conversation, so an env token pasted into it would leak.
          const safe = {
            ...conf,
            pipelines: {
              onFileMutation: conf.pipelines.onFileMutation.map((step) => ({
                ...step,
                env: redactEnv(step.env),
              })),
              onTurnEnd: conf.pipelines.onTurnEnd.map((step) => ({
                ...step,
                env: redactEnv(step.env),
              })),
            },
          };
          ctx.ui.setWidget("sentinel", JSON.stringify(safe, null, 2).split("\n"));
          return;
        }
        case "help":
        default: {
          ctx.ui.setWidget("sentinel", [
            "[sentinel] Commands",
            "  /sentinel           Show this help",
            "  /sentinel status    Show current state",
            "  /sentinel verify    Run onFileMutation pipelines now",
            "  /sentinel test      Run onTurnEnd pipelines now",
            "  /sentinel rollback  Restore this turn's changes (or HEAD)",
            "  /sentinel rewind    Restore code / conversation from a checkpoint",
            "  /sentinel config    Dump the active configuration",
          ]);
        }
      }
    },
  });

  /** P1 — the rewind menu: code, conversation, both, or summarize. */
  async function runRewindCommand(ctx: {
    cwd: string;
    ui: ExtensionUIContext;
    sessionManager: { getLeafId(): string | null };
    navigateTree(
      targetId: string,
      options?: { summarize?: boolean; customInstructions?: string },
    ): Promise<unknown>;
  }): Promise<void> {
    const list = checkpoints.list(ctx.cwd, 10);
    if (list.length === 0) {
      ctx.ui.setWidget("sentinel", [
        "[sentinel] No checkpoints yet — one is stored at the end of every turn that changed files.",
      ]);
      return;
    }

    const choice = await ctx.ui.select(
      "Rewind to which checkpoint?",
      list.map((cp) => {
        const when = cp.at.replace("T", " ").slice(0, 19);
        return `${cp.id} — ${cp.label} (${cp.fileCount} file(s), turn ${cp.turnIndex}, ${when})`;
      }),
    );
    if (!choice) return;

    const checkpoint = list.find((cp) => choice.startsWith(cp.id));
    if (!checkpoint) return;

    const action = await ctx.ui.select("What should be restored?", [
      "Code only",
      "Code and conversation",
      "Conversation only",
      "Summarize from here",
      "Cancel",
    ]);
    if (!action || action === "Cancel") return;

    const lines: string[] = [];

    if (action === "Code only" || action === "Code and conversation") {
      const report = checkpoints.restore(ctx.cwd, checkpoint.id);
      if (report.attempted) {
        recordRollback({
          at: new Date().toISOString(),
          branch: GitClient.gitMeta(ctx.cwd)?.branch ?? "unknown",
          head: checkpoint.id,
          reason: `rewind:${action}`,
          method: "checkpoint:turn",
        });
        lines.push(`[sentinel] Code: ${describeRestore(report)}.`);
      } else {
        lines.push("[sentinel] Code: checkpoint could not be read; nothing restored.");
      }
    }

    if (action !== "Code only") {
      const target =
        action === "Summarize from here"
          ? (ctx.sessionManager.getLeafId() ?? checkpoint.entryId)
          : checkpoint.entryId;

      if (!target) {
        lines.push("[sentinel] Conversation: no session entry recorded for this checkpoint.");
      } else {
        try {
          await ctx.navigateTree(
            target,
            action === "Summarize from here"
              ? {
                  summarize: true,
                  customInstructions:
                    "Summarize the work since this checkpoint, keeping what failed and why.",
                }
              : {},
          );
          lines.push("[sentinel] Conversation moved to the checkpoint.");
        } catch (err) {
          lines.push(
            `[sentinel] Conversation: could not move the session tree (${(err as Error).message}).`,
          );
        }
      }
    }

    ctx.ui.setWidget("sentinel", lines);
  }

  /** Read-only status lines, shared by the command and kept testable. */
  function statusLines(cwd: string, conf: ReturnType<typeof getConfig>): string[] {
    const repo = GitClient.gitMeta(cwd);
    const state = getState();
    const latest = checkpoints.latest(cwd);

    const lines = [
      "[sentinel] Status",
      `  enabled: ${conf.enabled} | autoRollback: ${conf.autoRollback}`,
      `  recovery: ${conf.recovery.enabled} (max ${conf.recovery.maxAttempts} attempts, rollback-after-exhaustion ${conf.recovery.rollbackAfterExhaustion})`,
      `  policy: ${conf.policy.enabled} (max ${conf.policy.maxChangedFiles || "unlimited"} file(s), ${conf.policy.maxAddedLines || "unlimited"} added line(s))`,
      `  evidence: ${conf.trackVerifiedState} (revert ${conf.revertOnRegression}) | out-of-band: ${conf.detectOutOfBand}`,
      `  background checks: ${conf.backgroundTurnEnd} | output budget: ${conf.maxOutputTokens} tokens`,
      `  debounce: ${conf.verification.debounceMs}ms | cache: ${conf.verification.cache.enabled} | escalation: ${conf.verification.failureEscalation.enabled}`,
      `  pipelines: mutation ${conf.pipelines.onFileMutation.length} | turn ${conf.pipelines.onTurnEnd.length}`,
      repo ? `  Git: ${repo.branch} @ ${repo.head}` : "  Git: not a repo",
      `  turn snapshot: ${snapshots.hasTurnSnapshot() ? "captured (rollback available)" : "empty"}`,
      latest
        ? `  latest checkpoint: ${latest.id} — ${latest.label} (${latest.fileCount} file(s))`
        : "  latest checkpoint: none",
      "",
      ...metricsLines(state.metrics),
      "",
      state.turnHistory.length > 0
        ? ["History (newest first):", ...turnHistoryLines(state.turnHistory)].join("\n")
        : "History: none",
    ];
    return lines;
  }
}

/** Session file of the active session, when available. */
function safeSessionFile(ctx: {
  sessionManager: { getSessionFile(): string | undefined };
}): string | undefined {
  try {
    return ctx.sessionManager.getSessionFile() ?? undefined;
  } catch {
    return undefined;
  }
}

/** Turn index of a `turn_end` event, when the host provides one. */
function turnIndexOf(event: { turnIndex?: number }): number {
  return typeof event.turnIndex === "number" ? event.turnIndex : -1;
}
