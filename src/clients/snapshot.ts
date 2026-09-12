/**
 * SnapshotStore — precise, file-level undo for agent mutations.
 *
 * The old rollback strategy (`git checkout -- .`) had two problems:
 *   1. It discarded *all* uncommitted changes in the repo, including the
 *      user's unrelated work.
 *   2. It never removed files the agent *created* via `write` (untracked
 *      files survive `git checkout`).
 *
 * This store fixes both by recording the pre-state of every file the agent
 * touches, captured in the `tool_call` hook (i.e. *before* the mutation):
 *
 *   - `captureCall(toolCallId, path)` — pre-state for a single mutation.
 *   - `captureTurn(path)`             — first pre-state seen in this turn.
 *   - `rollbackCall(id)`              — undo exactly one mutation.
 *   - `rollbackTurn()`                — undo every file touched this turn.
 *
 * Restoring is purely file-based, so it is safe for untracked files and
 * never touches anything the agent did not change. This module is the I/O
 * isolation layer; it performs no business logic and has no dependencies on
 * the pipeline or git layers.
 */

import * as fs from "node:fs";
import * as path from "node:path";

/** Maximum file size we keep a full snapshot for (larger files fall back). */
export const MAX_SNAPSHOT_BYTES = 4 * 1024 * 1024;

/** Upper bound on remembered per-mutation scopes (guards against leaks). */
const MAX_CALL_SCOPES = 200;

export interface FileSnapshot {
  /** Absolute path of the file. */
  path: string;
  /** Whether the file existed before the mutation. */
  existed: boolean;
  /** Pre-mutation content, when small enough to capture. */
  data: Buffer | null;
  /** True when the file was too large / not a regular file to capture. */
  incomplete: boolean;
}

export interface RestoreReport {
  /** Whether there was anything to restore at all. */
  attempted: boolean;
  /** Files whose previous content was written back. */
  restored: string[];
  /** Files that did not exist before and were removed. */
  deleted: string[];
  /** Files that could not be restored (too large, permission error, ...). */
  skipped: string[];
  /** True when at least one file could not be restored. */
  partial: boolean;
}

function emptyReport(): RestoreReport {
  return { attempted: false, restored: [], deleted: [], skipped: [], partial: false };
}

function readSnapshot(absPath: string): FileSnapshot {
  try {
    const stat = fs.statSync(absPath);
    if (!stat.isFile() || stat.size > MAX_SNAPSHOT_BYTES) {
      return { path: absPath, existed: true, data: null, incomplete: true };
    }
    return { path: absPath, existed: true, data: fs.readFileSync(absPath), incomplete: false };
  } catch {
    // File does not exist (or is unreadable) — treat as "did not exist".
    return { path: absPath, existed: false, data: null, incomplete: false };
  }
}

function restoreSnapshot(snap: FileSnapshot): "restored" | "deleted" | "skipped" {
  try {
    if (!snap.existed) {
      fs.rmSync(snap.path, { force: true });
      return "deleted";
    }
    if (snap.incomplete || snap.data === null) return "skipped";
    fs.mkdirSync(path.dirname(snap.path), { recursive: true });
    fs.writeFileSync(snap.path, snap.data);
    return "restored";
  } catch {
    return "skipped";
  }
}

export class SnapshotStore {
  /** Pre-state per tool call id, so a failed mutation can be undone alone. */
  private callScopes = new Map<string, Map<string, FileSnapshot>>();
  /** First pre-state per path within the current turn. */
  private turnScope = new Map<string, FileSnapshot>();

  // ── Capture ────────────────────────────────────────────────────────────

  /** Record the pre-state of a file before a mutation executes. */
  captureCall(toolCallId: string, absPath: string): void {
    let scope = this.callScopes.get(toolCallId);
    if (!scope) {
      scope = new Map();
      this.callScopes.set(toolCallId, scope);
      this.evictStaleScopes();
    }
    if (!scope.has(absPath)) scope.set(absPath, readSnapshot(absPath));
  }

  /** Record the turn-level pre-state (first touch wins). */
  captureTurn(absPath: string): void {
    if (!this.turnScope.has(absPath)) this.turnScope.set(absPath, readSnapshot(absPath));
  }

  // ── Inspection ─────────────────────────────────────────────────────────

  /** True when the mutation left the file byte-identical (nothing to verify). */
  isCallUnchanged(toolCallId: string): boolean {
    const scope = this.callScopes.get(toolCallId);
    if (!scope || scope.size === 0) return false;
    for (const snap of scope.values()) {
      if (snap.incomplete) return false;
      if (!snap.existed) {
        if (fs.existsSync(snap.path)) return false;
        continue;
      }
      try {
        if (!fs.readFileSync(snap.path).equals(snap.data!)) return false;
      } catch {
        return false;
      }
    }
    return true;
  }

  /** Whether the current turn has any captured state worth rolling back. */
  hasTurnSnapshot(): boolean {
    return this.turnScope.size > 0;
  }

  // ── Rollback ───────────────────────────────────────────────────────────

  /** Undo a single mutation by restoring its captured pre-state. */
  rollbackCall(toolCallId: string): RestoreReport {
    const scope = this.callScopes.get(toolCallId);
    this.callScopes.delete(toolCallId);
    if (!scope || scope.size === 0) return emptyReport();
    return this.restoreAll(scope);
  }

  /** Undo every file touched during the current turn. */
  rollbackTurn(): RestoreReport {
    if (this.turnScope.size === 0) return emptyReport();
    const report = this.restoreAll(this.turnScope);
    this.turnScope.clear();
    return report;
  }

  /** Start a new turn — drop the previous turn's capture set. */
  beginTurn(): void {
    this.turnScope.clear();
  }

  /** Drop a finished tool call's capture (kept only for the failed case). */
  endCall(toolCallId: string): void {
    this.callScopes.delete(toolCallId);
  }

  /** @internal Reset internals — for testing only */
  reset(): void {
    this.callScopes.clear();
    this.turnScope.clear();
  }

  private restoreAll(scope: Map<string, FileSnapshot>): RestoreReport {
    const report = emptyReport();
    report.attempted = true;
    // Reverse insertion order: later mutations of the same file undo first.
    for (const snap of [...scope.values()].reverse()) {
      const outcome = restoreSnapshot(snap);
      if (outcome === "restored") report.restored.push(snap.path);
      else if (outcome === "deleted") report.deleted.push(snap.path);
      else report.skipped.push(snap.path);
    }
    report.partial = report.skipped.length > 0;
    return report;
  }

  private evictStaleScopes(): void {
    while (this.callScopes.size > MAX_CALL_SCOPES) {
      const oldest = this.callScopes.keys().next().value;
      if (oldest === undefined) break;
      this.callScopes.delete(oldest);
    }
  }
}

/** Shared process-wide store, mirroring the module-level config design. */
export const snapshots = new SnapshotStore();

/** Human-readable one-line summary of a restore report. */
export function describeRestore(report: RestoreReport): string {
  const parts: string[] = [];
  if (report.restored.length) parts.push(`restored ${report.restored.length} file(s)`);
  if (report.deleted.length) parts.push(`removed ${report.deleted.length} newly created file(s)`);
  if (report.skipped.length) parts.push(`skipped ${report.skipped.length} file(s)`);
  if (parts.length === 0) return "nothing to restore";
  return parts.join(", ") + (report.partial ? " (partial)" : "");
}
