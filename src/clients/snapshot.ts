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
 *   - `capturePost(toolCallId)`       — what the *agent's* mutation left behind.
 *   - `rollbackCall(id)`              — undo exactly one mutation.
 *   - `rollbackTurn()`                — undo every file touched this turn.
 *
 * Restoring is purely file-based, so it is safe for untracked files and
 * never touches anything the agent did not change.
 *
 * Conflict safety: the post-state hash recorded by `capturePost` is what
 * makes a blind overwrite impossible. If the file differs from the state the
 * agent left, somebody else (a formatter, another process, the user) wrote it
 * in the meantime, and sentinel reports the conflict instead of restoring —
 * the later work is what the user can see, so it wins.
 *
 * This module is the I/O isolation layer; it performs no business logic and
 * has no dependencies on the pipeline or git layers.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";

import type { RollbackConflict } from "../types.ts";

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
  /** SHA-1 of the pre-mutation content; undefined when it did not exist. */
  contentHash?: string;
  /** Pre-mutation size in bytes. */
  size?: number;
  /** Pre-mutation permission bits, so a restore can put them back. */
  mode?: number;
  /** When the pre-state was read (epoch milliseconds). */
  capturedAt?: number;
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
  /** Files left untouched because they changed since the agent's mutation. */
  conflicted: string[];
  /** Details for every conflicted file, for the agent-facing message. */
  conflicts: RollbackConflict[];
  /** True when at least one file could not be restored. */
  partial: boolean;
}

function emptyReport(): RestoreReport {
  return {
    attempted: false,
    restored: [],
    deleted: [],
    skipped: [],
    conflicted: [],
    conflicts: [],
    partial: false,
  };
}

/** Exported so the checkpoint store can report restores the same way. */
export function emptyRestoreReport(): RestoreReport {
  return emptyReport();
}

/** SHA-1 of a buffer or file, or `null` when the file does not exist. */
export function hashFile(absPath: string): string | null {
  try {
    return createHash("sha1").update(fs.readFileSync(absPath)).digest("hex");
  } catch {
    return null;
  }
}

function readSnapshot(absPath: string): FileSnapshot {
  const capturedAt = Date.now();
  try {
    // A symlink is a distinct object, not a copy of its target. Recording the
    // target's bytes and writing them back at the link path would replace the
    // link with a regular file while leaving the real target changed — a
    // corrupt state. Mark it incomplete so a restore skips it and never
    // destroys the link.
    const link = fs.lstatSync(absPath);
    if (link.isSymbolicLink()) {
      return {
        path: absPath,
        existed: true,
        data: null,
        incomplete: true,
        size: link.size,
        capturedAt,
      };
    }
    const stat = fs.statSync(absPath);
    if (!stat.isFile() || stat.size > MAX_SNAPSHOT_BYTES) {
      return {
        path: absPath,
        existed: true,
        data: null,
        incomplete: true,
        size: stat.size,
        mode: stat.mode & 0o777,
        capturedAt,
      };
    }
    const data = fs.readFileSync(absPath);
    return {
      path: absPath,
      existed: true,
      data,
      incomplete: false,
      contentHash: createHash("sha1").update(data).digest("hex"),
      size: data.length,
      mode: stat.mode & 0o777,
      capturedAt,
    };
  } catch (err) {
    // Only a genuine absence is "did not exist". Any other failure (EACCES,
    // EPERM, ELOOP, EBUSY, ...) means a file we could not read; treating it as
    // absent would make a rollback *delete* it — the one outcome a snapshot
    // must never cause. Record it as incomplete so a restore skips it and
    // reports a partial rollback instead of destroying data.
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    const absent = code === "ENOENT" || code === "ENOTDIR";
    return {
      path: absPath,
      existed: !absent,
      data: null,
      incomplete: !absent,
      capturedAt,
    };
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
    // Write to a sibling temp file and rename: a crash or a full disk midway
    // through must never leave a half-written source file behind. Rename is
    // atomic on the same filesystem.
    const tmp = `${snap.path}.sentinel-${process.pid}.tmp`;
    try {
      fs.writeFileSync(tmp, snap.data);
      if (snap.mode !== undefined) {
        try {
          fs.chmodSync(tmp, snap.mode);
        } catch {
          /* permissions are best-effort; the content is what matters */
        }
      }
      fs.renameSync(tmp, snap.path);
    } catch (err) {
      try {
        fs.rmSync(tmp, { force: true });
      } catch {
        /* ignore */
      }
      throw err;
    }
    return "restored";
  } catch {
    return "skipped";
  }
}

/** Options that control how strictly a restore is guarded. */
export interface RestoreOptions {
  /**
   * Hash recorded for each path *after* the agent's mutation. A path that is
   * present in the map but no longer matches is a conflict. Paths absent from
   * the map carry no information and are restored as before.
   */
  postHashes?: Map<string, string | null>;
  /** Restore even conflicted files. Only for an explicit user request. */
  force?: boolean;
}

/** True when the file changed after the agent's own mutation. */
function conflictFor(
  snap: FileSnapshot,
  postHashes: Map<string, string | null> | undefined,
): RollbackConflict | null {
  if (!postHashes || !postHashes.has(snap.path)) return null;
  const expectedHash = postHashes.get(snap.path) ?? null;
  const actualHash = hashFile(snap.path);
  if (expectedHash === actualHash) return null;
  // The rollback of a file the agent *created* is a deletion. If it is already
  // gone there is nothing to protect, and there is no overwrite risk.
  if (!snap.existed && actualHash === null) return null;
  return {
    path: snap.path,
    expectedHash,
    actualHash,
    reason: "modified after the Sentinel snapshot",
  };
}

/**
 * Write a snapshot back to disk. Exported because the durable checkpoint
 * store restores the very same `FileSnapshot` shape it reads from disk.
 */
export const restoreFileSnapshot = restoreSnapshot;

/** Read the pre-state of a file, for callers outside the capture hooks. */
export function snapshotFile(absPath: string): FileSnapshot {
  return readSnapshot(absPath);
}

/** Pure-ish restore driver shared with the checkpoint store. */
export function restoreSnapshots(
  scope: Map<string, FileSnapshot>,
  options: RestoreOptions = {},
): RestoreReport {
  const report = emptyReport();
  report.attempted = true;
  // Reverse insertion order: later mutations of the same file undo first.
  for (const snap of [...scope.values()].reverse()) {
    const conflict = options.force ? null : conflictFor(snap, options.postHashes);
    if (conflict) {
      report.conflicted.push(snap.path);
      report.conflicts.push(conflict);
      continue;
    }
    const outcome = restoreSnapshot(snap);
    if (outcome === "restored") report.restored.push(snap.path);
    else if (outcome === "deleted") report.deleted.push(snap.path);
    else report.skipped.push(snap.path);
  }
  report.partial = report.skipped.length > 0 || report.conflicted.length > 0;
  return report;
}

export class SnapshotStore {
  /** Pre-state per tool call id, so a failed mutation can be undone alone. */
  private callScopes = new Map<string, Map<string, FileSnapshot>>();
  /** First pre-state per path within the current turn. */
  private turnScope = new Map<string, FileSnapshot>();
  /** Post-mutation hash per call id: what the agent's write left behind. */
  private callPosts = new Map<string, Map<string, string | null>>();
  /** Post-mutation hash per path within the current turn (latest write wins). */
  private turnPost = new Map<string, string | null>();

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

  /**
   * Record what the agent's mutation left on disk, so a later rollback can
   * tell "still exactly what the agent wrote" from "somebody edited it since".
   * Call this from `tool_result`, i.e. *after* the mutation succeeded.
   */
  capturePost(toolCallId: string): void {
    const scope = this.callScopes.get(toolCallId);
    if (!scope) return;
    let posts = this.callPosts.get(toolCallId);
    if (!posts) {
      posts = new Map();
      this.callPosts.set(toolCallId, posts);
    }
    for (const absPath of scope.keys()) {
      const hash = hashFile(absPath);
      posts.set(absPath, hash);
      // The turn-level view tracks the newest agent-produced state per path.
      this.turnPost.set(absPath, hash);
    }
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

  /** Absolute paths captured this turn (first touch per path). */
  turnPaths(): string[] {
    return [...this.turnScope.keys()];
  }

  /**
   * The raw turn snapshots, so the checkpoint store can persist exactly what
   * the in-memory rollback would have restored — no second disk read.
   */
  turnSnapshots(): FileSnapshot[] {
    return [...this.turnScope.values()];
  }

  /** Post-mutation hashes of the current turn, for durable checkpoints. */
  turnPostHashes(): Map<string, string | null> {
    return new Map(this.turnPost);
  }

  /** Pre-state of a single tool call, for the verified-state ledger. */
  callSnapshots(toolCallId: string): FileSnapshot[] {
    const scope = this.callScopes.get(toolCallId);
    return scope ? [...scope.values()] : [];
  }

  // ── Rollback ───────────────────────────────────────────────────────────

  /** Undo a single mutation by restoring its captured pre-state. */
  rollbackCall(toolCallId: string, options: RestoreOptions = {}): RestoreReport {
    const scope = this.callScopes.get(toolCallId);
    const posts = this.callPosts.get(toolCallId);
    this.callScopes.delete(toolCallId);
    this.callPosts.delete(toolCallId);
    if (!scope || scope.size === 0) return emptyReport();
    return restoreSnapshots(scope, { postHashes: posts, ...options });
  }

  /** Undo every file touched during the current turn. */
  rollbackTurn(options: RestoreOptions = {}): RestoreReport {
    if (this.turnScope.size === 0) return emptyReport();
    const report = restoreSnapshots(this.turnScope, {
      postHashes: this.turnPost,
      ...options,
    });
    this.turnScope.clear();
    this.turnPost.clear();
    return report;
  }

  /** Start a new turn — drop the previous turn's capture set. */
  beginTurn(): void {
    this.turnScope.clear();
    this.turnPost.clear();
  }

  /** Drop a finished tool call's capture (kept only for the failed case). */
  endCall(toolCallId: string): void {
    this.callScopes.delete(toolCallId);
    this.callPosts.delete(toolCallId);
  }

  /** @internal Reset internals — for testing only */
  reset(): void {
    this.callScopes.clear();
    this.turnScope.clear();
    this.callPosts.clear();
    this.turnPost.clear();
  }

  private evictStaleScopes(): void {
    while (this.callScopes.size > MAX_CALL_SCOPES) {
      const oldest = this.callScopes.keys().next().value;
      if (oldest === undefined) break;
      this.callScopes.delete(oldest);
      this.callPosts.delete(oldest);
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
  if (report.conflicted?.length) parts.push(`left ${report.conflicted.length} conflicted file(s)`);
  if (parts.length === 0) return "nothing to restore";
  return parts.join(", ") + (report.partial ? " (partial)" : "");
}
