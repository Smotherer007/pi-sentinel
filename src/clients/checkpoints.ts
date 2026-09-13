/**
 * CheckpointStore — durable turn checkpoints (P1).
 *
 * The in-memory `SnapshotStore` can undo a turn only *while* the turn is
 * running: `turn_end` clears the scope. That leaves the most common recovery
 * case unsolved — "the last turn broke something, take it back" — and it
 * cannot survive a session restart. Claude Code's checkpointing and `/rewind`
 * cover exactly that gap, keeping snapshots for the last N checkpoints.
 *
 * This store closes it: the turn's pre-state is flushed to disk when the turn
 * ends, so it can be restored later, from a new turn, or after resuming the
 * session. Storage mirrors the snapshot store: real file bytes plus a manifest,
 * so a restore is byte-accurate and never touches files the turn did not touch.
 *
 * Layout:
 *   <projectDir>/checkpoints/<seq>-<id>/manifest.json
 *   <projectDir>/checkpoints/<seq>-<id>/blobs/<n>.blob
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID, createHash } from "node:crypto";

import { projectDir } from "../config.ts";
import {
  emptyRestoreReport,
  restoreFileSnapshot,
  snapshotFile,
  MAX_SNAPSHOT_BYTES,
} from "./snapshot.ts";
import type { FileSnapshot, RestoreReport } from "./snapshot.ts";
import type { CheckpointSummary } from "../types.ts";

export interface CheckpointMeta {
  turnIndex: number;
  /** Session-tree entry the turn started at, for conversation rewind. */
  entryId?: string;
  /** Human label, usually built from the code graph. */
  label?: string;
  /** Session file, so a checkpoint can be traced back to its conversation. */
  session?: string;
}

interface StoredFile {
  path: string;
  existed: boolean;
  incomplete: boolean;
  blob?: string;
  hash?: string;
}

interface Manifest extends CheckpointMeta {
  version: number;
  id: string;
  seq: number;
  at: string;
  files: StoredFile[];
}

interface Pending {
  meta: CheckpointMeta;
  files: Map<string, FileSnapshot>;
}

function checkpointsDir(cwd: string): string {
  return path.join(projectDir(cwd), "checkpoints");
}

function hashBuffer(data: Buffer): string {
  return createHash("sha1").update(data).digest("hex");
}

export class CheckpointStore {
  private pending: Pending | null = null;

  /** Start a new checkpoint scope for a turn. */
  begin(meta: CheckpointMeta): void {
    this.pending = { meta, files: new Map() };
  }

  /** True while a turn is being captured. */
  get isCapturing(): boolean {
    return this.pending !== null;
  }

  /** Paths captured so far this turn. */
  pendingPaths(): string[] {
    return this.pending ? [...this.pending.files.keys()] : [];
  }

  /** Record a file's pre-state (first touch wins). */
  capture(absPath: string): void {
    if (!this.pending) return;
    const key = path.resolve(absPath);
    if (this.pending.files.has(key)) return;
    this.pending.files.set(key, snapshotFile(key));
  }

  /**
   * Import snapshots the in-memory store already read, so a turn is never
   * read from disk twice.
   */
  captureSnapshots(snaps: FileSnapshot[]): void {
    if (!this.pending) return;
    for (const snap of snaps) {
      const key = path.resolve(snap.path);
      if (!this.pending.files.has(key)) this.pending.files.set(key, snap);
    }
  }

  /** Attach the final label (computed after all mutations are known). */
  setLabel(label: string): void {
    if (this.pending) this.pending.meta = { ...this.pending.meta, label };
  }

  setEntryId(entryId: string | undefined): void {
    if (this.pending) this.pending.meta = { ...this.pending.meta, entryId };
  }

  /**
   * Persist the pending turn to disk and prune old checkpoints.
   * Returns null when the turn touched nothing (or nothing was captured).
   */
  flush(cwd: string, retention: number, at: string = new Date().toISOString()): CheckpointSummary | null {
    const pending = this.pending;
    this.pending = null;
    if (!pending || pending.files.size === 0) return null;

    const seq = nextSeq(cwd);
    const id = `${seq}-${randomUUID().slice(0, 8)}`;
    const dir = path.join(checkpointsDir(cwd), id);
    const blobDir = path.join(dir, "blobs");

    const files: StoredFile[] = [];
    try {
      fs.mkdirSync(blobDir, { recursive: true, mode: 0o700 });

      let index = 0;
      for (const snap of pending.files.values()) {
        const entry: StoredFile = {
          path: snap.path,
          existed: snap.existed,
          incomplete: snap.incomplete,
        };
        if (snap.data && !snap.incomplete && snap.data.length <= MAX_SNAPSHOT_BYTES) {
          const blob = `${index}.blob`;
          fs.writeFileSync(path.join(blobDir, blob), snap.data, { mode: 0o600 });
          entry.blob = blob;
          entry.hash = hashBuffer(snap.data);
          index += 1;
        }
        files.push(entry);
      }

      const manifest: Manifest = {
        version: 1,
        id,
        seq,
        at,
        turnIndex: pending.meta.turnIndex,
        entryId: pending.meta.entryId,
        label: pending.meta.label,
        session: pending.meta.session,
        files,
      };
      fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 2), {
        encoding: "utf-8",
        mode: 0o600,
      });

      prune(cwd, retention);
      return summarise(manifest);
    } catch {
      // A checkpoint is a convenience, never a hard requirement: on failure we
      // clean up and let the turn continue.
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
      return null;
    }
  }

  /** Newest-first checkpoint list (manifests only, no blobs read). */
  list(cwd: string, limit = 20): CheckpointSummary[] {
    const dir = checkpointsDir(cwd);
    let entries: string[];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      return [];
    }

    const manifests = entries
      .map((name) => readManifest(path.join(dir, name)))
      .filter((m): m is Manifest => m !== null)
      .sort((a, b) => b.seq - a.seq);

    return manifests.slice(0, limit).map((m) => summarise(m));
  }

  /** The most recent checkpoint, or null. */
  latest(cwd: string): CheckpointSummary | null {
    return this.list(cwd, 1)[0] ?? null;
  }

  /** Restore a checkpoint (default: the newest) onto the working tree. */
  restore(cwd: string, id?: string): RestoreReport {
    const manifest = id ? findManifest(cwd, id) : latestManifest(cwd);
    if (!manifest) return emptyRestoreReport();

    const report = emptyRestoreReport();
    report.attempted = true;
    const dir = path.join(checkpointsDir(cwd), manifest.id);

    // Reverse order, matching the in-memory store: later writes undo first.
    for (const file of [...manifest.files].reverse()) {
      const snapshot = materialise(dir, file);
      const outcome = restoreFileSnapshot(snapshot);
      if (outcome === "restored") report.restored.push(file.path);
      else if (outcome === "deleted") report.deleted.push(file.path);
      else report.skipped.push(file.path);
    }

    report.partial = report.skipped.length > 0;
    return report;
  }

  /** Delete every stored checkpoint. Returns how many were removed. */
  clear(cwd: string): number {
    const dir = checkpointsDir(cwd);
    let entries: string[];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      return 0;
    }
    let removed = 0;
    for (const name of entries) {
      try {
        fs.rmSync(path.join(dir, name), { recursive: true, force: true });
        removed += 1;
      } catch {
        /* ignore */
      }
    }
    return removed;
  }
}

function materialise(dir: string, file: StoredFile): FileSnapshot {
  if (!file.existed) return { path: file.path, existed: false, data: null, incomplete: false };
  if (!file.blob) return { path: file.path, existed: true, data: null, incomplete: true };
  try {
    const data = fs.readFileSync(path.join(dir, "blobs", file.blob));
    return { path: file.path, existed: true, data, incomplete: false };
  } catch {
    return { path: file.path, existed: true, data: null, incomplete: true };
  }
}

function readManifest(dir: string): Manifest | null {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf-8")) as Manifest;
    if (!raw || typeof raw !== "object" || !Array.isArray(raw.files) || !raw.id) return null;
    return raw;
  } catch {
    return null;
  }
}

function findManifest(cwd: string, id: string): Manifest | null {
  const dir = checkpointsDir(cwd);
  if (readManifest(path.join(dir, id))) return readManifest(path.join(dir, id));
  // Allow restoring by sequence number alone ("/sentinel rewind 12").
  try {
    for (const name of fs.readdirSync(dir)) {
      if (name === id || name.startsWith(`${id}-`)) {
        const found = readManifest(path.join(dir, name));
        if (found) return found;
      }
    }
  } catch {
    /* ignore */
  }
  return null;
}

function latestManifest(cwd: string): Manifest | null {
  const dir = checkpointsDir(cwd);
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return null;
  }
  const manifests = names
    .map((name) => readManifest(path.join(dir, name)))
    .filter((m): m is Manifest => m !== null)
    .sort((a, b) => b.seq - a.seq);
  return manifests[0] ?? null;
}

function nextSeq(cwd: string): number {
  const dir = checkpointsDir(cwd);
  let highest = 0;
  try {
    for (const name of fs.readdirSync(dir)) {
      const n = Number.parseInt(name.split("-")[0] ?? "", 10);
      if (Number.isFinite(n) && n > highest) highest = n;
    }
  } catch {
    /* first checkpoint */
  }
  return highest + 1;
}

function prune(cwd: string, retention: number): void {
  if (retention <= 0) return;
  const dir = checkpointsDir(cwd);
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }

  const ordered = names
    .map((name) => ({ name, seq: Number.parseInt(name.split("-")[0] ?? "", 10) }))
    .filter((e) => Number.isFinite(e.seq))
    .sort((a, b) => b.seq - a.seq);

  for (const stale of ordered.slice(retention)) {
    try {
      fs.rmSync(path.join(dir, stale.name), { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

function summarise(manifest: Manifest): CheckpointSummary {
  return {
    id: manifest.id,
    seq: manifest.seq,
    at: manifest.at,
    turnIndex: manifest.turnIndex,
    label: manifest.label ?? "unlabelled",
    fileCount: manifest.files.length,
    entryId: manifest.entryId,
    files: manifest.files.map((f) => f.path),
  };
}

/** Shared process-wide store, mirroring the module-level config design. */
export const checkpoints = new CheckpointStore();
