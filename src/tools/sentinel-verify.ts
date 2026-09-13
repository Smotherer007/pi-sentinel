/**
 * sentinel_verify tool -- Run verification pipelines and report result.
 *
 * Exposed as a tool so the agent can trigger verification on demand
 * (e.g. before committing, or when it wants to confirm a batch of edits).
 *
 * Since P2/P5 this tool reports the same enriched payload the hooks produce:
 * regressed verified states, code-graph impact, and an output budget.
 */

import { Type } from "typebox";

import { PipelineRunner } from "../clients/pipeline-runner.ts";
import { rollbackTurn } from "../clients/rollback.ts";
import { snapshots } from "../clients/snapshot.ts";
import { recordVerified, stateHashOf } from "../clients/evidence.ts";
import { buildFailureFeedback } from "../formatting/feedback.ts";
import { getConfig, recordMetrics, recordRollback } from "../config.ts";
import type { FailureKind, RollbackConflict } from "../types.ts";

/** One stable details shape across every return path. */
interface VerifyDetails {
  passed: boolean;
  step: string;
  exitCode: number;
  rolledBack: boolean;
  steps: Array<{
    name: string;
    passed: boolean;
    durationMs: number;
    exitCode: number;
    skipped?: string;
    cached?: boolean;
  }>;
  warnings: number;
  /** Classification of the failure, when there was one. */
  failureKind?: FailureKind;
  /** Files left untouched because they changed since the snapshot. */
  conflicts?: RollbackConflict[];
}

function detailsFor(extra: Partial<VerifyDetails> = {}): VerifyDetails {
  return {
    passed: false,
    step: "",
    exitCode: 0,
    rolledBack: false,
    steps: [],
    warnings: 0,
    ...extra,
  };
}

export const SentinelVerifyTool = {
  name: "sentinel_verify",
  label: "Verify",
  description:
    "Run configured verification pipelines (type-check, lint, tests) and report the outcome. Optionally roll back on failure.",
  parameters: Type.Object({
    trigger: Type.Optional(
      Type.String({
        description:
          "Which pipeline group to run: 'mutation' (onFileMutation) or 'turn' (onTurnEnd). Default: 'mutation'.",
        enum: ["mutation", "turn"],
      }),
    ),
    rollback: Type.Optional(
      Type.Boolean({
        description:
          "If true and verification fails, roll back the files changed this turn. Defaults to the project's autoRollback setting.",
      }),
    ),
  }),
  async execute(
    _toolCallId: string,
    params: { trigger?: "mutation" | "turn"; rollback?: boolean },
    signal: AbortSignal | undefined,
    _onUpdate: unknown,
    ctx?: { cwd: string },
  ) {
    const cwd = ctx?.cwd ?? process.cwd();
    const config = getConfig();
    const runner = new PipelineRunner();
    const trigger = params.trigger === "turn" ? "onTurnEnd" : "onFileMutation";

    // The files this turn touched are what a failure is actually about, so
    // they drive both evidence and the code-graph impact section.
    const focusPaths = snapshots.turnPaths();
    // An explicit request means "run the checks": results are never taken
    // from the cache, and the debounce window is bypassed.
    const run = await runner.runAll(trigger, cwd, { signal, focusPaths, skipCache: true });

    if (run.passed) {
      if (config.trackVerifiedState && focusPaths.length > 0 && run.steps.length > 0) {
        try {
          recordVerified(cwd, focusPaths, `${trigger}:${run.steps.map((s) => s.name).join("+")}`);
        } catch {
          /* evidence is an optimisation */
        }
      }

      const warnText =
        run.warnings.length > 0
          ? `\nNon-blocking warnings:\n${run.warnings
              .map((w) => `• ${w.step} (exit ${w.exitCode}):\n${w.prunedTrace}`)
              .join("\n")}`
          : "";

      return {
        content: [
          {
            type: "text" as const,
            text: `[sentinel] All ${run.steps.length} verification step(s) passed.${warnText}`,
          },
        ],
        details: detailsFor({
          passed: true,
          steps: run.steps,
          warnings: run.warnings.length,
        }),
      };
    }

    const failure = run.failure!;
    const doRollback = params.rollback ?? config.autoRollback;
    let rolledBack = false;
    let rollbackMsg = "";
    let conflicts: RollbackConflict[] = [];

    if (doRollback && !failure.warnOnly) {
      const rb = rollbackTurn(cwd);
      // A conflict means at least one file was deliberately left alone.
      rolledBack = rb.success && !rb.partial;
      conflicts = rb.conflicts ?? [];
      rollbackMsg = `\n${rb.message}`;
      recordMetrics({ rollbacks: 1, partialRollbacks: rb.partial ? 1 : 0 });
      recordRollback({
        at: new Date().toISOString(),
        branch: rb.branch ?? "unknown",
        head: rb.committedAt ?? "unknown",
        reason: `tool:${failure.step}`,
        method: rb.method,
      });
    }

    const { text } = buildFailureFeedback({
      cwd,
      step: failure.step,
      exitCode: failure.exitCode,
      durationMs: failure.durationMs,
      prunedTrace: failure.prunedTrace,
      rawOutput: failure.rawOutput,
      warnOnly: failure.warnOnly,
      rolledBack,
      focusPaths,
      stateHash: stateHashOf(focusPaths),
      failureKind: failure.failureKind,
      timedOut: failure.timedOut,
      errorSummary: failure.errorSummary,
      attempts: failure.attempts,
      conflicts,
      maxOutputTokens: config.maxOutputTokens,
    });

    return {
      content: [{ type: "text" as const, text: `${text}${rollbackMsg}` }],
      details: detailsFor({
        passed: false,
        step: failure.step,
        exitCode: failure.exitCode,
        rolledBack,
        steps: run.steps,
        warnings: run.warnings.length,
        failureKind: failure.failureKind,
        conflicts,
      }),
    };
  },
};
