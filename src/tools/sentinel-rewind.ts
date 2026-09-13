/**
 * sentinel_rewind tool -- time travel over the working tree (P1).
 *
 * The `sentinel_rollback` tool can only undo the turn that is *currently*
 * running, because the in-memory snapshot scope is dropped at `turn_end`.
 * Turn checkpoints are flushed to disk, so this tool can undo an earlier turn
 * — including after a session restart.
 *
 * Conversation rewind is intentionally not exposed as a tool: navigating the
 * session tree requires command-only context. Use `/sentinel rewind` for the
 * menu that also offers *conversation* and *both*.
 */

import { Type } from "typebox";

import { checkpoints } from "../clients/checkpoints.ts";
import { describeRestore } from "../clients/snapshot.ts";
import { recordRollback } from "../config.ts";
import type { CheckpointSummary } from "../types.ts";

/** One stable details shape, so every return path matches the same schema. */
interface RewindDetails {
  mode: "list" | "code";
  checkpoints: CheckpointSummary[];
  rewound: boolean;
  restored: string[];
  deleted: string[];
  skipped: string[];
  /** Files left untouched because they changed after that turn. */
  conflicted: string[];
  partial: boolean;
}

function detailsFor(
  mode: "list" | "code",
  list: CheckpointSummary[],
  extra: Partial<RewindDetails> = {},
): RewindDetails {
  return {
    mode,
    checkpoints: list,
    rewound: false,
    restored: [],
    deleted: [],
    skipped: [],
    conflicted: [],
    partial: false,
    ...extra,
  };
}

export const SentinelRewindTool = {
  name: "sentinel_rewind",
  label: "Rewind",
  description:
    "List or restore sentinel's turn checkpoints. mode='list' shows recent checkpoints with their labels; mode='code' (default) restores the working tree to the state before the newest — or a chosen — turn. Restoring never touches files that turn did not change. To rewind the conversation as well, use the /sentinel rewind command.",
  parameters: Type.Object({
    mode: Type.Optional(
      Type.String({
        description: "'list' to inspect checkpoints, 'code' to restore one. Default: 'code'.",
        enum: ["list", "code"],
      }),
    ),
    checkpointId: Type.Optional(
      Type.String({
        description:
          "Checkpoint id or sequence number from mode='list'. Defaults to the newest checkpoint.",
      }),
    ),
  }),

  async execute(
    _toolCallId: string,
    params: { mode?: "list" | "code"; checkpointId?: string },
    _signal: AbortSignal | undefined,
    _onUpdate: unknown,
    ctx?: { cwd: string },
  ) {
    const cwd = ctx?.cwd ?? process.cwd();
    const mode: "list" | "code" = params.mode === "list" ? "list" : "code";
    const list = checkpoints.list(cwd, 10);

    // ── list ──────────────────────────────────────────────────────────────
    if (mode === "list") {
      if (list.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: "[sentinel] No checkpoints yet. One is stored at the end of every turn that changed files.",
            },
          ],
          details: detailsFor(mode, list),
        };
      }

      const lines = ["[sentinel] Checkpoints (newest first):"];
      for (const cp of list) {
        const when = cp.at.replace("T", " ").slice(0, 19);
        lines.push(
          `  ${cp.id}  ${when}  turn ${cp.turnIndex}  ${cp.fileCount} file(s)  ${cp.label}`,
        );
      }
      lines.push("", 'Restore with sentinel_rewind({ checkpointId: "<id>" }).');

      return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
        details: detailsFor(mode, list),
      };
    }

    // ── code ──────────────────────────────────────────────────────────────
    if (list.length === 0) {
      return {
        content: [
          {
            type: "text" as const,
            text: "[sentinel] No checkpoint available to restore. Use sentinel_rollback (mode: 'head') to reset tracked files to git HEAD instead.",
          },
        ],
        details: detailsFor(mode, list),
      };
    }

    const targetId = params.checkpointId ?? list[0].id;
    const target = list.find((c) => c.id === targetId || String(c.seq) === targetId);

    const report = checkpoints.restore(cwd, targetId);
    if (!report.attempted) {
      return {
        content: [
          {
            type: "text" as const,
            text: `[sentinel] Checkpoint ${targetId} could not be read; nothing was restored.`,
          },
        ],
        details: detailsFor(mode, list),
      };
    }

    recordRollback({
      at: new Date().toISOString(),
      branch: "unknown",
      head: "checkpoint",
      reason: `rewind:${targetId}`,
      method: "checkpoint:turn",
    });

    const conflictText =
      report.conflicted.length > 0
        ? `\nROLLBACK CONFLICT: ${report.conflicted.length} file(s) changed after that turn and were NOT overwritten:\n${report.conflicted
            .slice(0, 5)
            .map((file) => `  ${file}`)
            .join("\n")}\nManual recovery required.`
        : "";

    return {
      content: [
        {
          type: "text" as const,
          text: `[sentinel] Rewound to ${target?.label ?? targetId}: ${describeRestore(report)}.${conflictText}`,
        },
      ],
      details: detailsFor(mode, list, {
        rewound: report.restored.length > 0 || report.deleted.length > 0,
        restored: report.restored,
        deleted: report.deleted,
        skipped: report.skipped,
        conflicted: report.conflicted,
        partial: report.partial,
      }),
    };
  },
};
