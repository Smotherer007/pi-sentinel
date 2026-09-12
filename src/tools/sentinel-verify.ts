/**
 * sentinel_verify tool -- Run verification pipelines and report result.
 *
 * Exposed as a tool so the agent can trigger verification on demand
 * (e.g. before committing, or when it wants to confirm a batch of edits).
 */

import { Type } from "typebox";

import { PipelineRunner } from "../clients/pipeline-runner.ts";
import { rollbackTurn } from "../clients/rollback.ts";
import { formatError } from "../formatting/pruner.ts";
import { getConfig, recordRollback } from "../config.ts";

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
    const run = await runner.runAll(trigger, cwd, { signal });

    if (run.passed) {
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
        details: {
          passed: true,
          warnings: run.warnings,
          steps: run.steps,
          step: "",
          exitCode: 0,
          rolledBack: false,
        },
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
      recordRollback({
        at: new Date().toISOString(),
        branch: rb.branch ?? "unknown",
        head: rb.committedAt ?? "unknown",
        reason: `tool:${failure.step}`,
        method: rb.method,
      });
    }

    const formatted = formatError({
      step: failure.step,
      exitCode: failure.exitCode,
      durationMs: failure.durationMs,
      prunedTrace: failure.prunedTrace,
      rawOutput: failure.rawOutput,
      warnOnly: failure.warnOnly,
      rolledBack,
    });

    return {
      content: [{ type: "text" as const, text: `${formatted}${rollbackMsg}` }],
      details: {
        passed: false,
        step: failure.step,
        exitCode: failure.exitCode,
        rolledBack,
        warnings: run.warnings,
        steps: run.steps,
      },
    };
  },
};
