/**
 * Rollback orchestration — combines the precise snapshot store with the
 * conservative git fallback.
 *
 * Preference order:
 *   1. Snapshot restore (file-accurate, never touches unrelated work).
 *   2. Nothing. An automatic rollback with no snapshot is a no-op — it must
 *      never widen into `git checkout -- .`, because that discards *every*
 *      uncommitted change in the repository, including the user's own work.
 *      A full HEAD reset stays available as an explicit, user-initiated
 *      `mode: "head"` action (`rollbackToHead`).
 *
 * This module is the only place that decides *which* strategy runs, keeping
 * the tools and hooks free of rollback policy.
 */

import { GitClient } from "./git-client.ts";
import { snapshots, describeRestore, emptyRestoreReport } from "./snapshot.ts";
import type { RestoreReport } from "./snapshot.ts";
import type { RollbackResult } from "../types.ts";

function gitMeta(cwd: string): { branch?: string; committedAt?: string } {
  const meta = GitClient.gitMeta(cwd);
  return { branch: meta?.branch, committedAt: meta?.head };
}

/**
 * What an automatic rollback reports when it never captured a pre-state.
 *
 * Deliberately *not* successful: nothing was restored, and pretending
 * otherwise is the one lie that would make the agent re-apply changes that are
 * still present (or, worse, convince a user a destructive reset happened).
 */
function noSnapshot(cwd: string, scope: string): RollbackResult {
  return {
    success: false,
    method: "none",
    message: `No ${scope} snapshot was captured, so nothing was restored. The changes are still in place; use mode "head" for an explicit git reset.`,
    command: "",
    ...gitMeta(cwd),
  };
}

/**
 * Turn a snapshot restore report into a rollback result.
 *
 * A conflicted file makes the rollback `partial` and the result is reported as
 * unsuccessful on purpose: something the user can see was *not* restored, and
 * claiming otherwise would be the most damaging lie sentinel could tell.
 */
function fromReport(report: RestoreReport, method: string, cwd: string): RollbackResult {
  return {
    success: !report.partial,
    method,
    message: `${method === "snapshot:mutation" ? "Mutation" : "Turn"} rolled back — ${describeRestore(report)}.`,
    command: "",
    conflicts: report.conflicts,
    skipped: report.skipped,
    partial: report.partial,
    ...gitMeta(cwd),
  };
}

/** Undo a single mutation (identified by its tool call id). */
export function rollbackMutation(toolCallId: string, cwd: string): RollbackResult {
  const report = snapshots.rollbackCall(toolCallId);
  if (!report.attempted) return noSnapshot(cwd, "mutation");
  return fromReport(report, "snapshot:mutation", cwd);
}

/** Undo every file the agent touched during the current turn. */
export function rollbackTurn(cwd: string): RollbackResult {
  const report = snapshots.rollbackTurn();
  if (!report.attempted) return noSnapshot(cwd, "turn");
  return fromReport(report, "snapshot:turn", cwd);
}

/**
 * Undo several mutations at once (a coalesced verification batch).
 * Each call restores exactly the files that call touched.
 */
export function rollbackMutations(toolCallIds: string[], cwd: string): RollbackResult {
  const merged: RestoreReport = emptyRestoreReport();
  let attempted = false;

  for (const toolCallId of toolCallIds) {
    const report = snapshots.rollbackCall(toolCallId);
    if (!report.attempted) continue;
    attempted = true;
    merged.restored.push(...report.restored);
    merged.deleted.push(...report.deleted);
    merged.skipped.push(...report.skipped);
    merged.conflicted.push(...report.conflicted);
    merged.conflicts.push(...report.conflicts);
  }

  if (!attempted) return noSnapshot(cwd, "mutation");
  merged.attempted = true;
  merged.partial = merged.skipped.length > 0 || merged.conflicted.length > 0;
  return fromReport(merged, "snapshot:mutation", cwd);
}

/** Explicit reset of the working tree to HEAD (destructive, user-initiated). */
export function rollbackToHead(cwd: string): RollbackResult {
  return GitClient.rollback(cwd);
}
