/**
 * Rollback orchestration — combines the precise snapshot store with the
 * conservative git fallback.
 *
 * Preference order:
 *   1. Snapshot restore (file-accurate, never touches unrelated work).
 *   2. `git checkout/restore` — only when no snapshot was captured (e.g. a
 *      mutation that arrived through a path we did not hook).
 *
 * This module is the only place that decides *which* strategy runs, keeping
 * the tools and hooks free of rollback policy.
 */

import { GitClient } from "./git-client.ts";
import { snapshots, describeRestore } from "./snapshot.ts";
import type { RollbackResult } from "../types.ts";

function gitMeta(cwd: string): { branch?: string; committedAt?: string } {
  const meta = GitClient.gitMeta(cwd);
  return { branch: meta?.branch, committedAt: meta?.head };
}

/** Undo a single mutation (identified by its tool call id). */
export function rollbackMutation(toolCallId: string, cwd: string): RollbackResult {
  const report = snapshots.rollbackCall(toolCallId);
  if (!report.attempted) return GitClient.rollback(cwd);
  return {
    success: !report.partial,
    method: "snapshot:mutation",
    message: `Mutation rolled back — ${describeRestore(report)}.`,
    command: "",
    ...gitMeta(cwd),
  };
}

/** Undo every file the agent touched during the current turn. */
export function rollbackTurn(cwd: string): RollbackResult {
  const report = snapshots.rollbackTurn();
  if (!report.attempted) return GitClient.rollback(cwd);
  return {
    success: !report.partial,
    method: "snapshot:turn",
    message: `Turn rolled back — ${describeRestore(report)}.`,
    command: "",
    ...gitMeta(cwd),
  };
}

/** Explicit reset of the working tree to HEAD (destructive, user-initiated). */
export function rollbackToHead(cwd: string): RollbackResult {
  return GitClient.rollback(cwd);
}
