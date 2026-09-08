/**
 * sentinel_rollback tool -- Manually roll back the working tree.
 *
 * Allows the agent (or user) to restore the working tree to HEAD at any
 * time, e.g. after a bad batch of edits or when a verification invariant
 * is violated before automation kicks in.
 */

import { Type } from "typebox";

import { GitClient } from "../clients/git-client.ts";
import { getConfig, recordRollback } from "../config.ts";

export const SentinelRollbackTool = {
  name: "sentinel_rollback",
  label: "Rollback",
  description:
    "Roll back the working tree to the last git HEAD commit, discarding uncommitted changes to tracked files.",
  parameters: Type.Object({}),

  async execute(_toolCallId: string, _params: Record<string, never>) {
    const conf = getConfig();
    if (!conf.autoRollback) {
      return {
        content: [
          {
            type: "text" as const,
            text: "[sentinel] autoRollback is disabled; refusing to roll back. Enable it in sentinel.config.ts or set autoRollback: true.",
          },
        ],
        details: { rolledBack: false, method: "", branch: "", head: "" },
      };
    }

    const cwd = process.cwd();
    const result = GitClient.rollback(cwd);

    if (result.success) {
      const meta = GitClient.gitMeta(cwd);
      recordRollback({
        at: new Date().toISOString(),
        branch: meta?.branch ?? "unknown",
        head: meta?.head ?? "unknown",
        reason: "manual",
        method: result.method,
      });
    }

    return {
      content: [
        {
          type: "text" as const,
          text: result.success
            ? `[sentinel] ${result.message}`
            : `[sentinel] ${result.message}`,
        },
      ],
      details: {
        rolledBack: result.success,
        method: result.method,
        branch: result.branch,
        head: result.committedAt,
      },
    };
  },
};
