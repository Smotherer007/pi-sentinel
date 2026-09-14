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
 *   - The repair loop's state and stop conditions are data with a pure
 *     transition (clients/repair.ts), so this file only performs the effects a
 *     decision asks for
 *   - Each capability is a single-responsibility tool module (tools/)
 *   - Config/state lives in `ConfigStore` and everything a session owns in
 *     `SentinelRuntime`, both created here and handed down as values
 *     (config.ts, runtime.ts) with atomic, permission-safe persistence
 *
 * This file is the wiring: it registers the tools and commands, maps host
 * hooks onto the clients, and decides nothing that a client could decide.
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
import { describeRestore } from "./src/clients/snapshot.ts";
import {
  stateHashOf,
  recordVerified,
  detectRegressions,
  revertToVerified,
  hashFile,
  currentlyVerified,
} from "./src/clients/evidence.ts";
import {
  evaluatePolicy,
  formatPolicyReport,
  relativePath,
  forbiddenKind,
  violationFor,
} from "./src/clients/policy.ts";
import type { PolicyChange } from "./src/clients/policy.ts";
import { outOfBandChanges, captureBaseline } from "./src/clients/workspace.ts";
import {
  classifyCommand,
  planProtection,
  riskHeadline,
  worstSeverity,
} from "./src/clients/bash-guard.ts";
import type { BashRisk } from "./src/clients/bash-guard.ts";
import type { WorkspaceBaseline } from "./src/clients/workspace.ts";
import { describeChange, expandWithDependents, graphStatus } from "./src/clients/mindplace.ts";
import { VerificationQueue } from "./src/clients/queue.ts";
import { shouldEscalate } from "./src/clients/escalation.ts";
import {
  autoFixOutcomeOf,
  decideRepair,
  deltaPathsOf,
  initialRepairState,
  scopeEscapeOf,
  traceIsStale,
  withPolicySignature,
  writeInScope,
} from "./src/clients/repair.ts";
import type { RepairState } from "./src/clients/repair.ts";
import {
  EMPTY_BACKGROUND_SLOT,
  foldBackgroundRequest,
  takeBackgroundRequest,
} from "./src/clients/background.ts";
import type { BackgroundRequest, BackgroundSlot } from "./src/clients/background.ts";
import { buildFailureFeedback, spillDir } from "./src/formatting/feedback.ts";
import { applyOutputCap } from "./src/clients/spill.ts";
import { metricsLines, turnHistoryLines } from "./src/formatting/status.ts";
import { redactEnv } from "./src/formatting/redact.ts";
import { revisionContractText } from "./src/prompt/contract.ts";
import {
  shouldVerify,
  projectDir,
  policyOf,
  bashGuardOf,
  recoveryOf,
} from "./src/config.ts";
import type {
  FailureKind,
  SentinelConfig,
  PipelineRunResult,
  PolicyReport,
  Regression,
  RollbackConflict,
  VerificationOutcome,
} from "./src/types.ts";

import { createRuntime } from "./src/runtime.ts";
import type { SentinelRuntime } from "./src/runtime.ts";
import { createSentinelVerifyTool } from "./src/tools/sentinel-verify.ts";
import { createSentinelRollbackTool } from "./src/tools/sentinel-rollback.ts";
import { createSentinelRewindTool } from "./src/tools/sentinel-rewind.ts";
import { createSentinelStatusTool } from "./src/tools/sentinel-status.ts";

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

/**
 * `customType` of sentinel's standing notices (the post-compaction restate).
 *
 * Deliberately *not* `SENTINEL_MESSAGE_TYPE`: a notice is not a verification
 * result, so the trace hygiene in the `context` hook must never supersede it
 * as if a newer run had answered it.
 */
export const SENTINEL_NOTICE_TYPE = "sentinel-notice";

const SUPERSEDED_TRACE =
  "[sentinel] This verification result is superseded by a later run — ignore it and act on the most recent sentinel message.";

/**
 * Prefixed onto the newest trace once the code it describes has moved on.
 *
 * Superseding older traces only helps while a newer one exists. The live trace
 * goes stale the moment the agent acts on it, and a repair loop that keeps
 * reading it is exactly the documented failure: revising code against evidence
 * bound to a state that no longer exists. The diagnostics are kept — some of
 * them may still be unfixed — but they stop being treated as current.
 */
const STALE_TRACE_NOTICE =
  "[sentinel] STALE: the files this result describes have changed since it was produced, so it no longer proves anything about the current code. Re-run the check before concluding that something still fails — and never report these diagnostics as the present state.";

/** How many diagnostics from dependents we promote into the pruner focus. */
const MAX_IMPACT_FOCUS = 10;

/**
 * Failure kinds that say nothing about the code.
 *
 * Sentinel already tells the agent "this is a timeout / a missing binary / an
 * environment problem, do not rewrite working code" — and then used to roll
 * that code back anyway and spend a repair attempt on it. A broken `npx`, a
 * busy CI box or an unreachable registry must never cost the user their work.
 */
const INFRASTRUCTURE_KINDS: ReadonlySet<FailureKind> = new Set<FailureKind>([
  "timeout",
  "command-not-found",
  "environment-error",
]);

/** True when a failure is about the environment rather than the code. */
export function isInfrastructureFailure(kind: FailureKind | undefined): boolean {
  return kind !== undefined && INFRASTRUCTURE_KINDS.has(kind);
}

/**
 * Whether at least one configured step actually executed. A step skipped by a
 * phase or file filter still appears in `run.steps`, so counting the array
 * would let a run that proved nothing be recorded as verified evidence.
 */
function ranAnyStep(run: PipelineRunResult): boolean {
  return run.steps.some((step) => !step.skipped);
}

/**
 * Whether a mutated file path lies inside the project the sentinel guards.
 * The sentinel should only verify/rollback mutations that actually touch its
 * own repo — otherwise it reacts to edits in unrelated projects.
 */
function targetInScope(target: string | undefined, cwd: string): boolean {
  if (!target) return true;
  const abs = isAbsolute(target) ? target : resolve(cwd, target);
  const rel = relative(cwd, abs);
  if (rel === "") return true;
  // ".." as a whole segment is outside; a file literally named "..foo.ts" is
  // inside and must still be guarded (`startsWith("..")` would wrongly skip it).
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function absPath(target: string, cwd: string): string {
  return isAbsolute(target) ? target : resolve(cwd, target);
}

/** Files sentinel itself produced — never a reason to verify or roll back. */
function isSentinelArtifact(cwd: string, absTarget: string): boolean {
  const graphOut = resolve(cwd, "graph-out") + sep;
  return absTarget.startsWith(graphOut) || absTarget.startsWith(projectDir(cwd) + sep);
}

interface VerificationState {
  // placeholder — unused
}

/**
 * One mutation's verification request, batched by the queue.
 *
 * Kept here rather than in the queue module because it is the payload the
 * `tool_result` hook builds, including a host context object — the queue
 * itself is transport-agnostic.
 */
interface MutationRequest {
  cwd: string;
  ctx: { ui: ExtensionUIContext };
  /** What the run is about, widened by graph dependents (diagnostic focus). */
  focusPaths: string[];
  /** What the agent actually wrote — the only thing evidence may bind to. */
  changedPaths: string[];
  toolCallIds: string[];
}

/**
 * The host calls this with the extension API alone.
 *
 * A runtime may be injected instead: it is the session's whole state, so a test
 * can assert on what the extension recorded without reading a global, and an
 * embedder can hand two extensions the same session.
 */
export default function (pi: ExtensionAPI, deps: { runtime?: SentinelRuntime } = {}) {
  // Every store that belongs to *this* session. Created here rather than at
  // module scope, so a second session in the same process gets its own
  // configuration, its own turn snapshots, its own checkpoints and its own
  // failure counters.
  const runtime = deps.runtime ?? createRuntime();
  // ── Repair-loop bookkeeping (P0 + P8) ───────────────────────────────────
  //
  // The loop's memory is one plain value in src/clients/repair.ts, so its stop
  // conditions are a pure function of (state, red turn) rather than something
  // only observable by driving the whole extension. Everything below performs
  // the effects a decision asks for; nothing decides on its own.

  let repair: RepairState = initialRepairState();
  /** In-flight background verification (P5); one at a time. */
  let backgroundRun: Promise<void> | null = null;
  /**
   * A turn whose background checks could not start because an earlier run was
   * still going. Dropping it would let a turn reach the user unverified, which
   * is the one outcome the guard exists to prevent, so it is folded into the
   * next run instead (see src/clients/background.ts).
   */
  let background: BackgroundSlot = EMPTY_BACKGROUND_SLOT;
  /** Working-tree fingerprint when the current turn started (P3 baseline). */
  let turnBaseline: WorkspaceBaseline | null = null;
  /**
   * Build time of the code graph the last staleness warning was about.
   *
   * Sentinel *knew* the graph was out of date and only ever said so in
   * `/sentinel status`, so `impactAwareFocus` degraded silently: the focus set
   * kept being expanded with dependents taken from a map of an older revision.
   * The warning is worth making once per graph, not once per turn.
   */
  let warnedStaleGraphAt: string | null = null;
  /**
   * When this session began.
   *
   * Staleness alone is the wrong trigger: editing one file makes the graph
   * technically older than the code, so reporting that would fire after every
   * turn and say only what the agent just did. What is worth a word is a graph
   * that predates the work entirely — built before this session started, which
   * is the case where dependents are genuinely missing.
   */
  let sessionStartedAtMs = Date.now();

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
      const changedPaths = [...new Set(requests.flatMap((request) => request.changedPaths))];
      const outcome = await runVerificationSafely({
        trigger: "onFileMutation",
        cwd: first.cwd,
        ctx: first.ctx,
        // One run, the union of every request in the batch.
        focusPaths,
        changedPaths,
        toolCallIds: [...new Set(requests.flatMap((request) => request.toolCallIds))],
      });
      if (outcome) return outcome;
      // The runner threw: do not invent a failure. The mutation stands and the
      // human was told the check could not complete.
      return {
        passed: true,
        stateHash: "",
        changedPaths,
        warnings: [],
        rolledBack: false,
        regressions: [],
        conflicts: [],
        restoreSkipped: [],
      };
    },
    0,
  );

  /**
   * Resolve configuration on every session event (cwd-aware). We reload
   * each time so editing `sentinel.config.ts` takes effect without a pi
   * restart — `ConfigStore.load` cache-busts the module by its file content.
   */
  async function ensureConfig(cwd: string): Promise<void> {
    await runtime.config.load(cwd);
    // The debounce window is configuration, and configuration can change.
    mutationQueue.setDebounce(runtime.config.config().verification.debounceMs);
  }

  /**
   * What the ledger can currently prove, as project-relative paths.
   *
   * Reading it is best-effort: an unreadable ledger costs the contract one
   * sentence, never the turn.
   */
  function contractEvidence(cwd: string, conf: SentinelConfig) {
    if (!conf.trackVerifiedState) return {};
    try {
      const entries = currentlyVerified(cwd);
      return { verified: entries.map((entry) => relativePath(cwd, entry.path)) };
    } catch {
      return {};
    }
  }

  /**
   * Tell the human when impact analysis has quietly stopped being accurate.
   *
   * A stale graph is not an error — most dependents it lists are still real —
   * but it is evidence about an older revision, and sentinel has been treating
   * it as current. Reported once per graph build, so a session that ignores it
   * is not nagged every turn.
   */
  function reportGraphFreshness(cwd: string, ctx: { ui: ExtensionUIContext }, changed: number): void {
    if (changed === 0) return;
    const conf = runtime.config.config();
    if (!conf.impactAwareFocus) return;

    let graph;
    try {
      graph = graphStatus(cwd);
    } catch {
      return;
    }
    if (!graph.present || !graph.stale) return;
    // A graph built during this session is as current as it is going to get;
    // the agent's own edits are what made it "stale" and it knows about those.
    if (!graph.builtAt) return;
    if (Date.parse(graph.builtAt) >= sessionStartedAtMs) return;

    const builtAt = graph.builtAt;
    if (warnedStaleGraphAt === builtAt) return;
    warnedStaleGraphAt = builtAt;

    ctx.ui.notify(
      `Sentinel: the code graph is older than the code (built ${builtAt.replace("T", " ").slice(0, 19)}). ` +
        "Impact analysis and the verification focus are working from an earlier revision — " +
        "run mindplace_build to restore them.",
      "warning",
    );
  }

  function resetRepairBudget(): void {
    repair = initialRepairState();
    // A new user turn (or a repaired loop) is a fresh start for escalation.
    runtime.escalations.reset();
  }

  /**
   * Verification focus: the mutated files plus — when a code graph exists —
   * their dependents, so diagnostics in affected files are promoted instead of
   * being buried under unrelated output.
   */
  function focusFor(cwd: string, paths: string[]): string[] {
    const conf = runtime.config.config();
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
    const pre = new Map(runtime.snapshots.turnSnapshots().map((snap) => [snap.path, snap]));
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
   * Whether this mutation must not happen at all.
   *
   * Two independent reasons, both of which the agent can act on:
   *   - the path is protected by the change policy, or
   *   - the repair cycle is confined to a file set this path is not in.
   *
   * Returns null when the write may proceed.
   */
  function refuseMutation(
    target: string,
    cwd: string,
    conf: SentinelConfig,
  ): { reason: string; summary: string } | null {
    const abs = absPath(target, cwd);
    if (isSentinelArtifact(cwd, abs)) return null;
    const rel = relativePath(cwd, abs);

    const policy = policyOf(conf);
    if (policy.enabled && policy.blockBeforeWrite) {
      const kind = forbiddenKind(rel, policy);
      if (kind) {
        const violation = violationFor(kind, rel);
        runtime.config.recordPolicyViolation({
          at: new Date().toISOString(),
          rules: [violation.rule],
          files: [rel],
        });
        runtime.config.recordMetrics({ policyViolations: 1 });
        return {
          summary: `${rel} is protected (${violation.rule})`,
          reason:
            `${violation.message.replace(/\n/g, " ")}\n` +
            "The write was refused, so nothing changed on disk. Do not retry it: " +
            "either solve the task without touching this path, or ask the user to relax " +
            "`policy` in sentinel.config.ts.",
        };
      }
    }

    const recovery = recoveryOf(conf);
    if (!writeInScope(repair, abs, recovery.scopeGuard)) {
      const allowed = (repair.scope ?? []).slice(0, 5).map((p) => relativePath(cwd, p));
      return {
        summary: `${rel} is outside the current repair scope`,
        reason:
          `[sentinel] This repair cycle is about ${allowed.join(", ")}. ` +
          `${rel} was not part of the failure it started from, so the write was refused ` +
          "and nothing changed on disk.\n" +
          "Fix the cause inside the original scope. If the fix genuinely belongs " +
          "elsewhere, stop and report that instead of editing further — widening the " +
          "change set is how a repair loop turns one failure into several.",
      };
    }

    return null;
  }

  /**
   * Decide what happens to a shell command, and make what it destroys undoable.
   *
   * Three outcomes, in the order they are considered:
   *
   *   1. **Refuse.** Nothing sentinel can do makes the command undoable — it
   *      pipes the network into an interpreter, force-pushes, publishes, or
   *      escalates privileges. The only honest answer is no.
   *   2. **Protect, then allow.** The command removes or overwrites files that
   *      sentinel guards. Their pre-state is captured into the turn scope
   *      first, so `sentinel_rollback` and `/sentinel rewind` can undo it just
   *      like an `edit`. If the blast radius cannot be captured — a glob the
   *      shell would expand, more files than the cap — the command becomes a
   *      refusal, because allowing it would break the guarantee silently.
   *   3. **Note.** An ordinary push or a docker prune: worth telling the human,
   *      not worth stopping.
   *
   * Returns a refusal reason, or null when the command may run.
   */
  function guardBashCommand(
    command: string,
    toolCallId: string,
    cwd: string,
    conf: SentinelConfig,
    ctx: { ui: ExtensionUIContext },
  ): { reason: string; summary: string } | null {
    const guard = bashGuardOf(conf);
    if (!guard.enabled || guard.mode === "off") return null;

    const trimmed = command.trim();
    if (guard.allow.some((prefix) => trimmed.startsWith(prefix))) return null;

    const risks = classifyCommand(command);
    const severity = worstSeverity(risks);
    if (severity === null) return null;

    const describe = (subset: BashRisk[]) =>
      [...new Set(subset.map((r) => `${riskHeadline(r.kind)} (${r.evidence.trim()})`))].join("; ");

    // ── 1. nothing can make this undoable ────────────────────────────────
    const refusals = risks.filter((r) => r.severity === "refuse");
    if (refusals.length > 0) {
      if (guard.mode === "report") {
        ctx.ui.notify(`Sentinel: risky command allowed in report mode — ${describe(refusals)}`, "warning");
        return null;
      }
      return {
        summary: describe(refusals),
        reason:
          `[sentinel] This command was refused: it ${describe(refusals)}.\n` +
          "Nothing ran, so nothing changed. Sentinel refuses commands whose effects it " +
          "cannot undo — this is not a judgement about your intent, it is that there " +
          "would be no way back.\n" +
          "Do the task another way, or ask the user to run this command themselves.",
      };
    }

    // ── 2. destructive, but capturable ───────────────────────────────────
    const destructive = risks.filter((r) => r.severity === "protect");
    if (destructive.length === 0) {
      ctx.ui.notify(`Sentinel: ${describe(risks)}`, "info");
      return null;
    }

    if (!guard.snapshotBeforeDestructive) return null;

    const named = [...new Set(destructive.flatMap((r) => r.paths))];
    const plan = planProtection(cwd, named, {
      maxFiles: guard.maxProtectedFiles,
      // Exactly the predicate the mutation hooks use, so the two can never
      // disagree about what is sentinel's to protect.
      shouldProtect: (abs) => !isSentinelArtifact(cwd, abs) && shouldVerify(abs, conf, cwd),
    });

    // A command that names no resolvable path is the dangerous case: `rm -rf $TARGET`,
    // `git reset --hard`, `sed -i ... *.ts`. Sentinel cannot say what it would
    // destroy, so it cannot promise to restore it.
    const blind = plan.unresolved.length > 0 || plan.overflowed || named.length === 0;

    if (blind && guard.mode === "block") {
      const why = plan.overflowed
        ? `more than ${guard.maxProtectedFiles} files would be affected`
        : plan.unresolved.length > 0
          ? `the paths ${plan.unresolved.join(", ")} can only be resolved by the shell itself`
          : "it names no path sentinel can capture in advance";
      return {
        summary: `${describe(destructive)} — blast radius not capturable`,
        reason:
          `[sentinel] This command was refused: it ${describe(destructive)}, and ${why}.\n` +
          "Nothing ran. Sentinel only allows a destructive command when it has first " +
          "captured what the command would destroy, so that it stays undoable.\n" +
          "Name the exact paths instead of a pattern, narrow the command, or ask the " +
          "user to run it themselves.",
      };
    }

    if (plan.files.length > 0) {
      for (const file of plan.files) {
        runtime.snapshots.captureCall(toolCallId, file);
        runtime.snapshots.captureTurn(file);
      }
      runtime.config.recordMetrics({ protectedFiles: plan.files.length });
      ctx.ui.notify(
        `Sentinel captured ${plan.files.length} file(s) before a command that ${describe(destructive)}.`,
        "info",
      );
    } else if (blind) {
      // report mode, or nothing of ours is at stake.
      ctx.ui.notify(
        `Sentinel: running a command that ${describe(destructive)} without a safety net.`,
        "warning",
      );
    }

    return null;
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
    const policy = policyOf(runtime.config.config());
    const files = [...new Set(args.report.violations.flatMap((v) => v.paths))];
    runtime.config.recordPolicyViolation({
      at: new Date().toISOString(),
      rules: args.report.violations.map((v) => v.rule),
      files,
    });
    runtime.config.recordMetrics({ policyViolations: 1 });

    let rolledBack = false;
    if (policy.rollbackOnViolation) {
      const rb = rollbackTurn(args.cwd, runtime.snapshots);
      rolledBack = rb.success;
      if (rb.conflicts && rb.conflicts.length > 0) {
        args.ctx.ui.notify(
          `Sentinel left ${rb.conflicts.length} file(s) untouched (policy violation).`,
          "error",
        );
      } else if (rb.success) {
        runtime.config.recordRollback({
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

    if (repair.policySignature === signature) {
      args.ctx.ui.notify(
        "Sentinel: the same policy violation repeated — stopping instead of re-prompting.",
        "warning",
      );
      return;
    }
    repair = withPolicySignature(repair, signature);
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
    const conf = runtime.config.config();
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
    /**
     * Files the run is about, widened by graph dependents. This is the
     * *diagnostic* focus: the pruner promotes errors about these files, and the
     * failure payload names their blast radius.
     */
    focusPaths: string[];
    /**
     * Files this turn actually changed. Evidence, the state hash and regression
     * detection bind to these, never to the widened focus set — a dependent that
     * was merely recompiled is not something sentinel verified, and must not be
     * claimed as green.
     */
    changedPaths: string[];
    /** Mutations this verification belongs to (a coalesced batch holds several). */
    toolCallIds?: string[];
    /**
     * Files the agent itself wrote this turn (absolute). Only these may be
     * reverted on a regression; a user's uncommitted edit is never sentinel's
     * to undo. Passed explicitly for background runs, whose in-memory turn
     * scope has already been cleared.
     */
    mutablePaths?: string[];
    /** Post-mutation hashes for `mutablePaths`, from the snapshot store. */
    postHashes?: Map<string, string | null>;
    /** Set false in background mode: a later turn owns the tree by then. */
    allowRollback?: boolean;
    /** Bypass the verification cache (explicit runs). */
    skipCache?: boolean;
  }): Promise<VerificationOutcome> {
    const conf = runtime.config.config();
    const runner = new PipelineRunner(runtime.config);
    const run = await runner.runAll(args.trigger, args.cwd, {
      focusPaths: args.focusPaths,
      changedFiles: args.changedPaths,
      skipCache: args.skipCache,
    });
    const stateHash = stateHashOf(args.changedPaths);

    if (run.passed) {
      args.ctx.ui.setStatus("sentinel", undefined);
      // A green run means the repair loop converged: stop escalating. Runs that
      // executed nothing at all prove nothing, so they must not clear the
      // counters either (an empty mutation group fires after every edit).
      if (ranAnyStep(run)) runtime.escalations.reset();
      // Evidence only counts when something actually ran: an empty pipeline
      // group proves nothing, and claiming "verified" for it would be a lie.
      // Only the changed files are recorded — see the note on `changedPaths`.
      if (conf.trackVerifiedState && args.changedPaths.length > 0 && ranAnyStep(run)) {
        try {
          recordVerified(
            args.cwd,
            args.changedPaths,
            `${args.trigger}:${run.steps.filter((s) => !s.skipped).map((s) => s.name).join("+") || "none"}`,
          );
        } catch {
          /* evidence is an optimisation, never a failure source */
        }
      }
      notifyWarnings(args.ctx, run.warnings, args.cwd);
      return {
        passed: true,
        stateHash,
        changedPaths: args.changedPaths,
        warnings: run.warnings,
        rolledBack: false,
        regressions: [],
        conflicts: [],
        restoreSkipped: [],
      };
    }

    const failure = run.failure!;
    args.ctx.ui.setStatus("sentinel", undefined);

    // Files the agent itself wrote this turn — the only ones whose regression
    // sentinel may attribute (and revert). Out-of-band diffs are still verified,
    // but sentinel cannot tell a user's pre-turn edit from an agent's bash edit,
    // so it must not claim either one regressed from a verified state.
    const ownedPaths = new Set(
      args.mutablePaths ??
        (args.toolCallIds && args.toolCallIds.length > 0
          ? args.toolCallIds.flatMap((id) =>
              runtime.snapshots.callSnapshots(id).map((snap) => snap.path),
            )
          : runtime.snapshots.turnPaths()),
    );

    // 0) Detect regressions first: a later revert must not erase the evidence
    //    that the file *was* green before this revision. Judged only over what
    //    changed — `ownedPaths` would filter the rest out anyway.
    let regressions =
      conf.trackVerifiedState
        ? detectRegressionsSafe(args.cwd, args.changedPaths).filter((r) =>
            ownedPaths.has(r.path),
          )
        : [];

    // A failure the environment caused is not evidence about the code. It
    // must not restore files, must not revert a regression and must not spend
    // a repair attempt — sentinel already tells the agent exactly that, and
    // doing the opposite is how a slow `npx` costs somebody their work.
    const infrastructure = isInfrastructureFailure(failure.failureKind);

    // 1) Whole-scope rollback (opt-in, never for warnOnly or environment steps).
    let rolledBack = false;
    let conflicts: RollbackConflict[] = [];
    let restoreSkipped: string[] = [];
    if (conf.autoRollback && !failure.warnOnly && !infrastructure && args.allowRollback !== false) {
      const ids = args.toolCallIds ?? [];
      const rb =
        ids.length > 1
          ? rollbackMutations(ids, args.cwd, runtime.snapshots)
          : ids.length === 1
            ? rollbackMutation(ids[0], args.cwd, runtime.snapshots)
            : rollbackTurn(args.cwd, runtime.snapshots);
      rolledBack = rb.success;
      conflicts = rb.conflicts ?? [];
      restoreSkipped = rb.skipped ?? [];
      runtime.config.recordMetrics({ rollbacks: 1, partialRollbacks: rb.partial ? 1 : 0 });
      // The rollback *was* attempted, so it belongs in the history even when
      // it came back partial — that is exactly the case a user must know about.
      runtime.config.recordRollback({
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
      } else if (restoreSkipped.length > 0) {
        // A partial restore is not "restored" and not "still in place".
        args.ctx.ui.notify(
          `Sentinel restored only part of the turn (${failure.step} failed): ${restoreSkipped.length} file(s) could not be restored, so their state is unknown.`,
          "error",
        );
      } else {
        args.ctx.ui.notify(`Sentinel rollback failed: ${rb.message}`, "error");
      }
    }

    // 2) Otherwise, only the individual files that regressed from a state
    //    which used to pass. This is the P2 revert, and it is narrower than a
    //    turn rollback: it leaves the rest of the turn's work alone.
    //
    //    Two guards keep it from destroying work sentinel does not own:
    //    the file must be one the agent itself wrote this turn, and it must
    //    still be exactly what the agent left (a later edit by the user, a
    //    formatter or another process is never overwritten).
    if (!rolledBack && !infrastructure && conf.trackVerifiedState && conf.revertOnRegression) {
      const postHashes = args.postHashes ?? runtime.snapshots.turnPostHashes();
      regressions = regressions.map((regression) => {
        if (!ownedPaths.has(regression.path)) return regression;
        if (!postHashes.has(regression.path)) return regression;
        if (hashFile(regression.path) !== postHashes.get(regression.path)) return regression;
        if (!revertToVerified(args.cwd, regression.path)) return regression;
        runtime.config.recordRegression({
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
    const seen = runtime.escalations.record(failure.signature);
    let escalation: { count: number; max: number } | undefined;
    if (escalationSettings.enabled && shouldEscalate(seen, escalationSettings.maxRepeatedFailures)) {
      escalation = { count: seen, max: escalationSettings.maxRepeatedFailures };
      runtime.config.recordEscalation({
        at: new Date().toISOString(),
        step: failure.step,
        kind: failure.failureKind,
        count: seen,
        signature: failure.signature,
      });
      runtime.config.recordMetrics({ escalations: 1 });
    }

    notifyWarnings(args.ctx, run.warnings, args.cwd);
    return {
      passed: false,
      stateHash,
      changedPaths: args.changedPaths,
      failure,
      warnings: run.warnings,
      rolledBack,
      regressions,
      conflicts,
      restoreSkipped,
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
    cwd: string,
    attempt?: { attempt: number; max: number; stopped?: boolean },
    stateHashOverride?: string,
    scopeEscape?: string[],
  ): string {
    const conf = runtime.config.config();
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
      // The changed files, so the impact section names the dependents of what
      // was actually edited instead of filtering them out as its own scope.
      focusPaths: outcome.changedPaths,
      stateHash: stateHashOverride ?? outcome.stateHash,
      regressions: outcome.regressions,
      attempt,
      failureKind: failure.failureKind,
      timedOut: failure.timedOut,
      errorSummary: failure.errorSummary,
      attempts: failure.attempts,
      escalation: outcome.escalation,
      conflicts: outcome.conflicts,
      restoreSkipped: outcome.restoreSkipped,
      scopeEscape,
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
    cwd: string;
    ctx: { ui: ExtensionUIContext };
    /** Pre-state checkpoint of this turn, used by rollbackAfterExhaustion. */
    checkpointId?: string;
    /** Files the agent itself wrote this turn, for the cycle scope check. */
    touchedPaths?: string[];
  }): void {
    const conf = runtime.config.config();
    const recovery = recoveryOf(conf);
    const failure = args.outcome.failure!;

    // Measured against the scope as it stands *before* this attempt can set
    // it: the first failing turn defines the scope, later attempts are judged
    // against it.
    const scopeEscape = scopeEscapeOf(repair, args.touchedPaths, recovery.scopeGuard);

    // The state the stop condition is judged against. A turn that changed
    // nothing still refers to the files of the previous attempt, so both are
    // hashed over the same path set.
    const deltaPaths = deltaPathsOf(repair, args.outcome.changedPaths);
    const stateHash = stateHashOf([...deltaPaths]);

    const decision = decideRepair(repair, {
      recoverable:
        recovery.enabled && !failure.warnOnly && !isInfrastructureFailure(failure.failureKind),
      maxAttempts: recovery.maxAttempts,
      scopeGuard: recovery.scopeGuard,
      rollbackAfterExhaustion: recovery.rollbackAfterExhaustion,
      step: failure.step,
      stateHash,
      paths: deltaPaths,
      checkpointId: args.checkpointId,
    });
    repair = decision.state;

    // The effects the decision asked for. Everything below is I/O or host
    // interaction; nothing here makes a policy choice of its own.
    if (decision.restoreCheckpointId) {
      // Bounded recovery: the attempt budget is spent, so return to the state
      // before the first turn of this failing cycle — neither the agent nor
      // the user should inherit a half-finished edit.
      //
      // `force` on purpose: the conflict check refuses to overwrite a file
      // that changed after the checkpoint, which is exactly the set of
      // intermediate repair attempts this restore is meant to discard. Only
      // files in the checkpoint are touched, so unrelated work stays.
      const report = runtime.checkpoints.restore(args.cwd, decision.restoreCheckpointId, { force: true });
      if (report.attempted) {
        args.outcome.rolledBack = !report.partial;
        args.outcome.conflicts = report.conflicts;
        runtime.config.recordRollback({
          at: new Date().toISOString(),
          branch: "checkpoint",
          head: decision.restoreCheckpointId,
          reason: `recovery-exhausted:${failure.step}`,
          method: "checkpoint:recovery",
        });
        runtime.config.recordMetrics({ rollbacks: 1, partialRollbacks: report.partial ? 1 : 0 });
        args.ctx.ui.notify(
          `Sentinel: recovery exhausted — restored the state before the failing cycle (${describeRestore(report)}).`,
          "warning",
        );
      }
    }

    const auditOutcome = autoFixOutcomeOf(decision.action);
    if (auditOutcome) {
      runtime.config.recordAutoFix({
        at: new Date().toISOString(),
        step: failure.step,
        attempt: repair.attempts,
        outcome: auditOutcome,
        reason: decision.reason,
      });
    }

    const text = renderFailure(
      args.outcome,
      args.cwd,
      decision.attempt,
      stateHash,
      scopeEscape,
    );

    if (scopeEscape.length > 0) {
      args.ctx.ui.notify(
        `Sentinel: this repair attempt changed ${scopeEscape.length} file(s) outside the failure it started from.`,
        "warning",
      );
    }

    if (decision.action === "inject") {
      pi.sendMessage(
        {
          customType: SENTINEL_MESSAGE_TYPE,
          content: text,
          display: true,
          details: {
            step: failure.step,
            stateHash,
            attempt: decision.attempt?.attempt,
            max: decision.attempt?.max,
          },
        },
        { deliverAs: "followUp", triggerTurn: true },
      );
      args.ctx.ui.notify(
        `Sentinel: ${failure.step} failed — re-prompting the agent (attempt ${repair.attempts}/${decision.maxAttempts})`,
        "warning",
      );
      return;
    }

    args.ctx.ui.notify(text, "error");

    if (decision.action === "stop-unchanged") {
      resetRepairBudget();
      args.ctx.ui.notify(
        "Sentinel: the code state did not change since the last repair attempt — stopping the loop instead of repeating it.",
        "warning",
      );
    } else if (decision.action === "exhausted") {
      args.ctx.ui.notify(
        `Sentinel: ${decision.maxAttempts} recovery attempts exhausted — reporting instead of editing further.`,
        "warning",
      );
    } else if (isInfrastructureFailure(failure.failureKind)) {
      args.ctx.ui.notify(
        `Sentinel: "${failure.step}" failed for an environment reason (${failure.failureKind}) — the code was left untouched and no repair attempt was spent.`,
        "warning",
      );
    }
  }

  // ── Tools ──────────────────────────────────────────────────────────────

  pi.registerTool(createSentinelVerifyTool(runtime));
  pi.registerTool(createSentinelRollbackTool(runtime));
  pi.registerTool(createSentinelRewindTool(runtime));
  pi.registerTool(createSentinelStatusTool(runtime));

  // ── Hook: session_start ────────────────────────────────────────────────

  pi.on("session_start", async (_event, ctx) => {
    warnedStaleGraphAt = null;
    sessionStartedAtMs = Date.now();
    await ensureConfig(ctx.cwd);
    resetRepairBudget();
    const conf = runtime.config.config();
    if (conf.enabled) {
      const extras = [
        conf.autoFix ? "auto-fix" : null,
        conf.autoRollback ? "auto-rollback" : null,
        conf.trackVerifiedState ? "evidence" : null,
        conf.detectOutOfBand ? "out-of-band" : null,
        conf.bash.enabled && conf.bash.mode !== "off" ? `shell guard (${conf.bash.mode})` : null,
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
    const conf = runtime.config.config();
    if (!conf.enabled) return;

    const contract = revisionContractText(conf, contractEvidence(ctx.cwd, conf));
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
    runtime.snapshots.beginTurn();
    await ensureConfig(ctx.cwd);
    const conf = runtime.config.config();
    if (!conf.enabled) return;

    // P3 — what was already dirty before the agent did anything. Without this
    // the turn-end scan attributes the user's in-flight work to the agent, and
    // the state hash that bounds the repair loop starts drifting with files
    // nobody in this turn touched.
    turnBaseline = null;
    if (conf.detectOutOfBand) {
      try {
        turnBaseline = captureBaseline(ctx.cwd);
      } catch {
        turnBaseline = null;
      }
    }

    let entryId: string | undefined;
    try {
      entryId = ctx.sessionManager.getLeafId() ?? undefined;
    } catch {
      entryId = undefined;
    }

    runtime.checkpoints.begin({
      turnIndex: event.turnIndex,
      entryId,
      session: safeSessionFile(ctx),
    });
  });

  // ── Hook: tool_call ────────────────────────────────────────────────────

  pi.on("tool_call", async (event: ToolCallEvent, ctx) => {
    await ensureConfig(ctx.cwd);
    const conf = runtime.config.config();
    if (!conf.enabled) return;

    // ── bash (P9) ────────────────────────────────────────────────────────
    // Every other guarantee in this file is keyed to edit/write. A shell
    // command walks past all of them, so it is inspected here: refused when
    // its damage could never be undone, and otherwise made undoable by
    // capturing the pre-state of what it is about to destroy.
    if (isToolCallEventType("bash", event)) {
      const command = (event.input as { command?: unknown })?.command;
      if (typeof command !== "string" || command.trim() === "") return;
      let refusal: { reason: string; summary: string } | null = null;
      try {
        refusal = guardBashCommand(command, event.toolCallId, ctx.cwd, conf, ctx);
      } catch {
        // A guard that throws must not take the session down, and must not
        // silently turn into permission either: say so and let the turn stop.
        ctx.ui.notify(
          "Sentinel could not inspect a shell command; it was refused rather than run unchecked.",
          "error",
        );
        return {
          block: true,
          reason:
            "[sentinel] The shell guard failed while inspecting this command, so it was not run. Report this; do not work around it.",
        };
      }
      if (refusal) {
        ctx.ui.notify(`Sentinel refused a command: ${refusal.summary}`, "error");
        runtime.config.recordMetrics({ blockedCommands: 1 });
        return { block: true, reason: refusal.reason };
      }
      return;
    }

    const isMutation =
      isToolCallEventType("edit", event) || isToolCallEventType("write", event);
    if (!isMutation) return;

    const input = event.input as Record<string, unknown>;
    const target = (input.path ?? input.filePath ?? input.file) as string | undefined;
    if (target && !targetInScope(target, ctx.cwd)) return;

    // ── Pre-write gate ───────────────────────────────────────────────────
    // Checked before the verification filters on purpose: a protected path is
    // protected whether or not sentinel would have type-checked it, and the
    // cheapest rollback is the write that never happened.
    if (target) {
      const refusal = refuseMutation(target, ctx.cwd, conf);
      if (refusal) {
        ctx.ui.notify(`Sentinel refused a write: ${refusal.summary}`, "error");
        runtime.config.recordMetrics({ blockedWrites: 1 });
        return { block: true, reason: refusal.reason };
      }
    }

    if (target && !shouldVerify(target, conf, ctx.cwd)) return;

    if (target) {
      const abs = absPath(target, ctx.cwd);
      // Captured *before* the mutation runs, so a failure can be undone
      // precisely — including files the agent newly creates.
      runtime.snapshots.captureCall(event.toolCallId, abs);
      runtime.snapshots.captureTurn(abs);
    }

    ctx.ui.setStatus("sentinel", "Mutation detected — verifying...");
  });

  // ── Hook: tool_result (mutation pipeline) ──────────────────────────────

  pi.on("tool_result", async (event: ToolResultEvent, ctx) => {
    await ensureConfig(ctx.cwd);
    const conf = runtime.config.config();
    if (!conf.enabled) return;

    // A guarded bash command captured its own pre-state in `tool_call`; record
    // what it left on disk so a later rollback can tell "still what the command
    // produced" from "somebody wrote it since", exactly as for an edit.
    if (event.toolName === "bash") {
      runtime.snapshots.capturePost(event.toolCallId);
      runtime.snapshots.endCall(event.toolCallId);
      return;
    }

    const isMutation = event.toolName === "edit" || event.toolName === "write";
    if (!isMutation) return;

    // A failed edit/write changed nothing — no need to verify.
    if (event.isError) {
      runtime.snapshots.endCall(event.toolCallId);
      return;
    }

    const target = (event.input?.path ?? event.input?.filePath) as string | undefined;
    if (target && !targetInScope(target, ctx.cwd)) {
      runtime.snapshots.endCall(event.toolCallId);
      return;
    }
    if (target && !shouldVerify(target, conf, ctx.cwd)) {
      runtime.snapshots.endCall(event.toolCallId);
      return;
    }

    // Byte-identical rewrite: nothing changed, skip the pipeline entirely.
    if (runtime.snapshots.isCallUnchanged(event.toolCallId)) {
      runtime.snapshots.endCall(event.toolCallId);
      return;
    }

    // Record what the agent's write left on disk. A later rollback compares
    // the file against this state, so an edit that happens in between (a
    // formatter, another process, the user) is never overwritten silently.
    runtime.snapshots.capturePost(event.toolCallId);

    // Two sets on purpose: `changedPaths` is what the agent wrote, and is the
    // only thing that may become evidence; `focusPaths` widens it with graph
    // dependents so their diagnostics are promoted out of the raw output.
    const changedPaths = target ? [absPath(target, ctx.cwd)] : [];
    const focusPaths = focusFor(ctx.cwd, changedPaths);
    const outcome = await mutationQueue.enqueue(ctx.cwd, {
      cwd: ctx.cwd,
      ctx,
      focusPaths,
      changedPaths,
      toolCallIds: [event.toolCallId],
    });

    runtime.snapshots.endCall(event.toolCallId);

    if (outcome.passed) return;

    // Prepend the pruned error while keeping the original result blocks. The
    // run may have covered more files than this hook did (coalesced batch), so
    // the scope of the run is what the payload describes. Formatting is
    // best-effort: a broken ledger must not turn into a hook exception.
    let failureText: string;
    try {
      failureText = renderFailure(outcome, ctx.cwd);
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
    const conf = runtime.config.config();

    // Everything below must read the turn scope *before* it is cleared.
    const turnPaths = runtime.snapshots.turnPaths();

    // P3 — changes that never went through edit/write (bash, formatters, git).
    let outOfBand: string[] = [];
    if (conf.enabled && conf.detectOutOfBand) {
      try {
        outOfBand = outOfBandChanges(
          ctx.cwd,
          turnPaths,
          (p) => {
            const abs = resolve(p);
            if (isSentinelArtifact(ctx.cwd, abs)) return true;
            return !shouldVerify(abs, conf, ctx.cwd);
          },
          turnBaseline ?? undefined,
        ).map((change) => change.path);
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
          // Persist the turn's pre-state before stopping it: a policy stop must
          // still leave a rewind handle, otherwise the offending change can only
          // be undone with a destructive `mode: "head"` reset.
          try {
            runtime.checkpoints.captureSnapshots(runtime.snapshots.turnSnapshots(), runtime.snapshots.turnPostHashes());
            runtime.checkpoints.setLabel(describeChange(ctx.cwd, focusPaths));
            runtime.checkpoints.flush(ctx.cwd, conf.checkpointRetention);
          } catch {
            /* a lost checkpoint must not change the policy decision */
          }
          handlePolicyViolation({ report, cwd: ctx.cwd, ctx, focusPaths });
          runtime.snapshots.beginTurn();
          return;
        }
        // A clean turn reopens the policy stop, so a later identical violation
        // is reported to the agent again.
        repair = withPolicySignature(repair, null);
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
        runtime.checkpoints.captureSnapshots(runtime.snapshots.turnSnapshots(), runtime.snapshots.turnPostHashes());
        runtime.checkpoints.setLabel(describeChange(ctx.cwd, focusPaths));
        const summary = runtime.checkpoints.flush(ctx.cwd, conf.checkpointRetention);
        checkpointId = summary?.id;
      } catch {
        checkpointId = undefined;
      }
    }

    if (!conf.enabled) {
      runtime.snapshots.beginTurn();
      return;
    }

    if (outOfBand.length > 0) {
      ctx.ui.notify(
        `Sentinel: ${outOfBand.length} file(s) changed outside edit/write — verifying them too.`,
        "info",
      );
    }

    // The graph feeds `focusFor`, so an out-of-date one degrades verification
    // itself, not just the impact section. Say so instead of letting it rot.
    reportGraphFreshness(ctx.cwd, ctx, focusPaths.length);

    if (conf.pipelines.onTurnEnd.length === 0) {
      runtime.snapshots.beginTurn();
      return;
    }

    // P5 — background mode: do not make the turn wait for the slow checks.
    if (conf.backgroundTurnEnd) {
      startBackgroundChecks({
        cwd: ctx.cwd,
        ctx,
        focusPaths,
        changedPaths: focusPaths,
        checkpointId,
        // The in-memory scope is cleared right below; hand the background run
        // the agent's own files so its regression revert stays scoped.
        mutablePaths: turnPaths,
        postHashes: runtime.snapshots.turnPostHashes(),
      });
      runtime.snapshots.beginTurn();
      return;
    }

    const outcome = await runVerificationSafely({
      trigger: "onTurnEnd",
      cwd: ctx.cwd,
      ctx,
      focusPaths,
      // Nothing widens the turn-end set, so both are the same files: the
      // mutations plus whatever changed out of band.
      changedPaths: focusPaths,
      mutablePaths: turnPaths,
      postHashes: runtime.snapshots.turnPostHashes(),
    });

    if (!outcome) {
      // Verification failed in an unexpected way — never crash the session.
      runtime.snapshots.beginTurn();
      return;
    }

    runtime.config.recordTurnOutcome({
      at: new Date().toISOString(),
      turnIndex: turnIndexOf(event),
      passed: outcome.passed,
      step: outcome.failure?.step,
    });

    if (outcome.passed) {
      resetRepairBudget();
    } else {
      handleRedTurnSafely({
        outcome,
        cwd: ctx.cwd,
        ctx,
        checkpointId,
        touchedPaths: turnPaths,
      });
    }

    // The turn is over — drop its snapshot scope either way.
    runtime.snapshots.beginTurn();
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
    changedPaths: string[];
    toolCallIds?: string[];
    mutablePaths?: string[];
    postHashes?: Map<string, string | null>;
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
    cwd: string;
    ctx: { ui: ExtensionUIContext };
    checkpointId?: string;
    touchedPaths?: string[];
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
  function startBackgroundChecks(args: BackgroundRequest): void {
    if (backgroundRun) {
      // Never drop the turn. Skipping it would let unverified code reach the
      // user with no trace at all — the silent version of exactly the failure
      // this guard exists to prevent.
      background = foldBackgroundRequest(background, args);
      args.ctx.ui.notify(
        "Sentinel: a background verification is still running — this turn was folded into the next run.",
        "info",
      );
      return;
    }

    const conf = runtime.config.config();
    args.ctx.ui.setStatus("sentinel", "Checks running in background…");

    backgroundRun = (async () => {
      try {
        // Fingerprint the state this run is about. A background check easily
        // outlives it — the agent can already be editing the next turn while
        // `npm test` is still running — and acting on a failure that no longer
        // describes the tree is exactly the stale trace that sends repair
        // loops after code that has already moved on.
        const startHash = stateHashOf(args.focusPaths);
        const outcome = await runVerification({
          trigger: "onTurnEnd",
          cwd: args.cwd,
          ctx: args.ctx,
          focusPaths: args.focusPaths,
          changedPaths: args.changedPaths,
          mutablePaths: args.mutablePaths,
          postHashes: args.postHashes,
          allowRollback: false,
        });

        if (outcome.passed) {
          resetRepairBudget();
          return;
        }

        // The code moved while the check ran: report the stale result to the
        // human, but never re-prompt the agent or restore files on it.
        if (stateHashOf(args.focusPaths) !== startHash) {
          args.ctx.ui.notify(
            `Sentinel: background check "${outcome.failure?.step ?? "unknown"}" failed, but the code changed while it ran — the stale result was discarded.`,
            "warning",
          );
          return;
        }

        runtime.config.recordTurnOutcome({
          at: new Date().toISOString(),
          turnIndex: -1,
          passed: false,
          step: outcome.failure?.step,
        });

        if (
          conf.autoRollback &&
          args.checkpointId &&
          !outcome.failure?.warnOnly &&
          runtime.checkpoints.latest(args.cwd)?.id === args.checkpointId
        ) {
          const report = runtime.checkpoints.restore(args.cwd, args.checkpointId);
          if (report.attempted) {
            outcome.rolledBack = !report.partial;
            runtime.config.recordRollback({
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
          cwd: args.cwd,
          ctx: args.ctx,
          checkpointId: args.checkpointId,
          touchedPaths: args.mutablePaths,
        });
      } catch {
        /* background verification must never crash the session */
      } finally {
        backgroundRun = null;
        args.ctx.ui.setStatus("sentinel", undefined);
        // A turn that arrived while this one ran is now owed a verification.
        const next = takeBackgroundRequest(background);
        background = next.slot;
        if (next.request) startBackgroundChecks(next.request);
      }
    })();
  }

  // ── Hook: session_compact (P8 — survive a shortened context) ───────────
  //
  // Compaction replaces the conversation with a summary. Everything sentinel
  // relies on being *in* the context goes with it: the revision contract, the
  // live failure trace, and the evidence about what is green. What survives is
  // a prose summary — and a summarized "the tests passed" is exactly the kind
  // of unbound evidence that makes a repair loop act on a state that no longer
  // exists. So the invariants are restated, as facts, right after the cut.
  //
  // The repair budget is deliberately *not* reset here: a loop that could buy
  // itself fresh attempts by triggering a compaction would not be bounded at
  // all.

  pi.on("session_compact", async (_event, ctx) => {
    await ensureConfig(ctx.cwd);
    const conf = runtime.config.config();
    if (!conf.enabled) return;

    const recovery = recoveryOf(conf);
    const lines = [
      "[sentinel] The conversation was compacted.",
      "",
      "Every verification result from before the compaction is gone from this context. A check result recalled from a summary is not evidence: it is not bound to any code state you can still see. Do not report anything as passing or failing on that basis — run the check again.",
    ];

    const contract = revisionContractText(conf, contractEvidence(ctx.cwd, conf));
    if (contract) lines.push("", contract);

    if (repair.attempts > 0) {
      lines.push(
        "",
        `Repair budget carried over: attempt ${repair.attempts} of ${recovery.maxAttempts} in the cycle that is still open. Compaction does not reset it.`,
      );
    }

    try {
      pi.sendMessage(
        {
          customType: SENTINEL_NOTICE_TYPE,
          content: lines.join("\n"),
          display: false,
          details: { compaction: true, attempt: repair.attempts },
        },
        { deliverAs: "nextTurn", triggerTurn: false },
      );
    } catch {
      /* a notice is never worth breaking a compaction over */
    }
  });

  // ── Hook: context (P2 — stale-trace hygiene) ───────────────────────────
  // The strongest documented harm in repair loops is acting on a verification
  // trace that no longer describes the current code. Sentinel keeps only its
  // newest trace live and marks older ones superseded.

  pi.on("context", async (event) => {
    const conf = runtime.config.config();
    if (!conf.enabled || !conf.pruneStaleTraces) return;

    const messages = event.messages as unknown as Array<Record<string, unknown>>;
    if (!Array.isArray(messages) || messages.length === 0) return;

    const sentinelIndices = new Set<number>();
    for (let i = 0; i < messages.length; i += 1) {
      const message = messages[i];
      if (message?.role === "custom" && message.customType === SENTINEL_MESSAGE_TYPE) {
        sentinelIndices.add(i);
      }
    }
    if (sentinelIndices.size === 0) return;

    const ordered = [...sentinelIndices];
    const newest = ordered[ordered.length - 1];
    const newestIsStale = injectedTraceIsStale();

    let changed = false;
    const next = messages.map((message, i) => {
      if (!sentinelIndices.has(i)) return message;

      if (i !== newest) {
        // An older trace is not merely stale, it is answered: a newer run
        // exists. Nothing of it is worth the context it occupies.
        if (message.content === SUPERSEDED_TRACE) return message;
        changed = true;
        return {
          ...message,
          content: Array.isArray(message.content)
            ? [{ type: "text", text: SUPERSEDED_TRACE }]
            : SUPERSEDED_TRACE,
        };
      }

      if (!newestIsStale || containsText(message.content, STALE_TRACE_NOTICE)) return message;
      changed = true;
      return { ...message, content: prefixContent(message.content, STALE_TRACE_NOTICE) };
    });

    if (!changed) return;
    return { messages: next as unknown as typeof event.messages };
  });

  /**
   * Whether the trace sentinel most recently injected still describes the tree.
   *
   * The repair loop already records the state hash it re-prompted for and the
   * paths that hash covered; comparing them against the files as they are now
   * is the whole test.
   */
  function injectedTraceIsStale(): boolean {
    if (repair.injectedPaths.length === 0) return false;
    try {
      return traceIsStale(repair, stateHashOf([...repair.injectedPaths]));
    } catch {
      return false;
    }
  }

  // ── Command: /sentinel ─────────────────────────────────────────────────

  pi.registerCommand("sentinel", {
    description: "Sentinel verification, repair & rollback control",
    getArgumentCompletions: (prefix) => {
      const options = ["status", "verify", "test", "rollback", "rewind", "config", "help"];
      return options.filter((o) => o.startsWith(prefix)).map((o) => ({ label: o, value: o }));
    },
    handler: async (args, ctx) => {
      await ensureConfig(ctx.cwd);
      const conf = runtime.config.config();
      const [sub = "help"] = (args ?? "").trim().split(/\s+/);

      switch (sub) {
        case "status": {
          ctx.ui.setWidget("sentinel", statusLines(ctx.cwd, conf));
          return;
        }
        case "verify": {
          const runner = new PipelineRunner(runtime.config);
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
          const runner = new PipelineRunner(runtime.config);
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
          const result = runtime.snapshots.hasTurnSnapshot()
            ? rollbackTurn(ctx.cwd, runtime.snapshots)
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
    const list = runtime.checkpoints.list(ctx.cwd, 10);
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
      const report = runtime.checkpoints.restore(ctx.cwd, checkpoint.id);
      if (report.attempted) {
        runtime.config.recordRollback({
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
  function statusLines(cwd: string, conf: SentinelConfig): string[] {
    const repo = GitClient.gitMeta(cwd);
    const state = runtime.config.state();
    const latest = runtime.checkpoints.latest(cwd);

    const lines = [
      "[sentinel] Status",
      `  enabled: ${conf.enabled} | autoRollback: ${conf.autoRollback}`,
      `  recovery: ${conf.recovery.enabled} (max ${conf.recovery.maxAttempts} attempts, rollback-after-exhaustion ${conf.recovery.rollbackAfterExhaustion}, scope guard ${conf.recovery.scopeGuard})`,
      `  policy: ${conf.policy.enabled} (max ${conf.policy.maxChangedFiles || "unlimited"} file(s), ${conf.policy.maxAddedLines || "unlimited"} added line(s), block-before-write ${conf.policy.blockBeforeWrite})`,
      `  shell guard: ${conf.bash.enabled ? conf.bash.mode : "off"} (snapshot ${conf.bash.snapshotBeforeDestructive}, max ${conf.bash.maxProtectedFiles} protected file(s))`,
      `  evidence: ${conf.trackVerifiedState} (revert ${conf.revertOnRegression}) | out-of-band: ${conf.detectOutOfBand}`,
      `  background checks: ${conf.backgroundTurnEnd} | output budget: ${conf.maxOutputTokens} tokens`,
      `  debounce: ${conf.verification.debounceMs}ms | cache: ${conf.verification.cache.enabled} | escalation: ${conf.verification.failureEscalation.enabled}`,
      `  pipelines: mutation ${conf.pipelines.onFileMutation.length} | turn ${conf.pipelines.onTurnEnd.length}`,
      repo ? `  Git: ${repo.branch} @ ${repo.head}` : "  Git: not a repo",
      `  turn snapshot: ${runtime.snapshots.hasTurnSnapshot() ? "captured (rollback available)" : "empty"}`,
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

/** True when a message body already carries `needle`. */
function containsText(content: unknown, needle: string): boolean {
  if (typeof content === "string") return content.includes(needle);
  if (!Array.isArray(content)) return false;
  return content.some(
    (block) =>
      typeof (block as { text?: unknown })?.text === "string" &&
      ((block as { text: string }).text).includes(needle),
  );
}

/** Put `prefix` in front of a message body, whatever shape it has. */
function prefixContent(content: unknown, prefix: string): unknown {
  if (Array.isArray(content)) return [{ type: "text", text: prefix }, ...content];
  return `${prefix}\n\n${typeof content === "string" ? content : ""}`;
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
