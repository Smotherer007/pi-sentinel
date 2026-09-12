/**
 * sentinel_rollback tool -- Manually roll back agent changes.
 *
 * Two modes:
 *   - "turn" (default when the current turn has captured changes): restore
 *     every file the agent touched this turn. Precise and non-destructive —
 *     unrelated uncommitted work is left alone.
 *   - "head": hard reset tracked files to HEAD (the classic behaviour).
 */

import { Type } from "typebox";

import { rollbackToHead, rollbackTurn } from "../clients/rollback.ts";
import { snapshots } from "../clients/snapshot.ts";
import { getConfig, recordRollback } from "../config.ts";

export const SentinelRollbackTool = {
  name: "sentinel_rollback",
  label: "Rollback",
  description:
    "Roll back agent changes. By default restores the files changed in the current turn; pass mode='head' to hard-reset tracked files to the last git commit.",
  parameters: Type.Object({
    mode: Type.Optional(
      Type.String({
        description:
          "'turn' restores files changed this turn (safe, default). 'head' resets tracked files to HEAD (destructive).",
        enum: ["turn", "head"],
      }),
    ),
    force: Type.Optional(
      Type.Boolean({
        description:
          "Allow a destructive 'head' reset even when autoRollback is disabled. Default: false.",
      }),
    ),
  }),

  async execute(
    _toolCallId: string,
    params: { mode?: "turn" | "head"; force?: boolean },
    _signal: AbortSignal | undefined,
    _onUpdate: unknown,
    ctx?: { cwd: string },
  ) {
    const cwd = ctx?.cwd ?? process.cwd();
    const conf = getConfig();
    const mode = params.mode ?? "turn";

    if (mode === "head" && !conf.autoRollback && !params.force) {
      return {
        content: [
          {
            type: "text" as const,
            text: "[sentinel] 'head' reset is disabled because autoRollback is false. Pass force: true to override, or use mode: 'turn' to restore only this turn's changes.",
          },
        ],
        details: { rolledBack: false, method: "", branch: "", head: "" },
      };
    }

    if (mode === "turn" && !snapshots.hasTurnSnapshot()) {
      return {
        content: [
          {
            type: "text" as const,
            text: "[sentinel] No changes captured for the current turn; nothing to restore. Use mode: 'head' to reset to git HEAD.",
          },
        ],
        details: { rolledBack: false, method: "", branch: "", head: "" },
      };
    }

    const result = mode === "head" ? rollbackToHead(cwd) : rollbackTurn(cwd);

    if (result.success) {
      recordRollback({
        at: new Date().toISOString(),
        branch: result.branch ?? "unknown",
        head: result.committedAt ?? "unknown",
        reason: `manual:${mode}`,
        method: result.method,
      });
    }

    return {
      content: [{ type: "text" as const, text: `[sentinel] ${result.message}` }],
      details: {
        rolledBack: result.success,
        method: result.method,
        branch: result.branch,
        head: result.committedAt,
      },
    };
  },
};
