/**
 * sentinel_verify tool -- Run verification pipelines and report result.
 *
 * Exposed as a tool so the agent can trigger verification on demand
 * (e.g. before committing, or when it wants to confirm a batch of edits).
 */

import { Type } from "typebox";

import { PipelineRunner } from "../clients/pipeline-runner.ts";
import { getConfig } from "../config.ts";

export const SentinelVerifyTool = {
  name: "sentinel_verify",
  label: "Verify",
  description:
    "Run configured verification pipelines (type-check, lint, tests) and report the outcome. Optionally trigger rollback on failure.",
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
          "If true and verification fails, immediately roll back the working tree. Default: true (respects autoRollback config).",
      }),
    ),
  }),

  async execute(
    _toolCallId: string,
    params: { trigger?: "mutation" | "turn"; rollback?: boolean },
  ) {
    const runner = new PipelineRunner();
    const trigger = params.trigger === "turn" ? "onTurnEnd" : "onFileMutation";
    const run = await runner.runAll(trigger, process.cwd());

    if (run.passed) {
      return {
        content: [
          {
            type: "text" as const,
            text: `[sentinel] All ${run.steps.length} verification step(s) passed.`,
          },
        ],
        details: { passed: true, steps: run.steps, step: "", exitCode: 0 },
      };
    }

    const failure = run.failure!;
    const doRollback = params.rollback ?? getConfig().autoRollback;
    let rollbackMsg = "";
    if (doRollback && failure.warnOnly === false) {
      const { GitClient } = await import("../clients/git-client.ts");
      const rb = GitClient.rollback(process.cwd());
      rollbackMsg = `\n${rb.message}`;
    }

    return {
      content: [
        {
          type: "text" as const,
          text: `${failure.formattedError}${rollbackMsg}`,
        },
      ],
      details: { passed: false, step: failure.step, exitCode: failure.exitCode, steps: run.steps },
    };
  },
};
