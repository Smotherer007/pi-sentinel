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
import { getConfig, recordRollback } from "../config.ts";

/** One stable details shape across every return path. */
interface VerifyDetails {
  passed: boolean;
  step: string;
  exitCode: number;
  rolledBack: boolean;
  steps: Array<{ name: string; passed: boolean; durationMs: number; exitCode: number }>;
  warnings: number;
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
    const run = await runner.runAll(trigger, cwd, { signal, focusPaths });

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

    if (doRollback && !failure.warnOnly) {
      const rb = rollbackTurn(cwd);
      rolledBack = rb.success;
      rollbackMsg = `\n${rb.message}`;
      if (rb.success) {
        recordRollback({
          at: new Date().toISOString(),
          branch: rb.branch ?? "unknown",
          head: rb.committedAt ?? "unknown",
          reason: `tool:${failure.step}`,
          method: rb.method,
        });
      }
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
      }),
    };
  },
};
