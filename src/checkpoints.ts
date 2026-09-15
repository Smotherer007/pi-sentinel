/**
 * Checkpoints: the state of every file an agent run changed, from before the
 * run, so the whole run can be rewound.
 *
 * Capture has two sources:
 *   - `edit`/`write` calls: the file is read right before the tool writes it;
 *   - everything else (bash, formatters, git): at the end of the run, git says
 *     which files changed. A file that was clean when the run started is
 *     restored from HEAD; a new untracked file is deleted on rewind. A file that
 *     was already dirty and then changed by a shell command has no recoverable
 *     pre-state — it is recorded as such instead of being guessed.
 *
 * A rewind never overwrites a file that changed after the checkpoint was taken
 * unless forced.
 */

import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import { captureBaseline, changedSince, fingerprint, headContent } from "./workspace.ts";
import type { Baseline } from "./workspace.ts";
import type { CheckpointSummary } from "./types.ts";

export const MAX_SNAPSHOT_BYTES = 8 * 1024 * 1024;

interface PreState {
  path: string;
  existed: boolean;
  /** null when the pre-state could not be captured (too large, symlink, unknown). */
  data: Buffer | null;
  mode?: number;
}

function readPreState(absPath: string): PreState {
  try {
    const stat = fs.lstatSync(absPath);
    if (!stat.isFile() || stat.size > MAX_SNAPSHOT_BYTES) return { path: absPath, existed: true, data: null };
    return { path: absPath, existed: true, data: fs.readFileSync(absPath), mode: stat.mode & 0o777 };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    const absent = code === "ENOENT" || code === "ENOTDIR";
    return { path: absPath, existed: !absent, data: null };
  }
}

function hashOf(data: Buffer | null, existed: boolean): string {
  if (!existed) return "-";
  return data ? createHash("sha1").update(data).digest("hex") : "?";
}

interface StoredFile {
  path: string;
  existed: boolean;
  blob?: string;
  mode?: number;
  /** Fingerprint right after the run; a rewind refuses to overwrite anything newer. */
  after: string;
}

interface Manifest {
  version: 3;
  id: string;
  seq: number;
  at: string;
  label: string;
  files: StoredFile[];
}

export interface RestoreReport {
  found: boolean;
  id?: string;
  restored: string[];
  deleted: string[];
  conflicts: string[];
  unrecoverable: string[];
}

/** Tracks one agent run. */
export class RunRecorder {
  readonly cwd: string;
  readonly label: string;
  private readonly useGit: boolean;
  private readonly baseline: Baseline;
  private readonly pre = new Map<string, PreState>();

  constructor(cwd: string, label: string, useGit = true) {
    this.cwd = cwd;
    this.label = label;
    this.useGit = useGit;
    this.baseline = useGit ? captureBaseline(cwd) : new Map();
  }

  /** Call before a tool writes `absPath`. The first capture in a run wins. */
  captureBefore(absPath: string): void {
    const key = path.resolve(absPath);
    if (!this.pre.has(key)) this.pre.set(key, readPreState(key));
  }

  /** Files this run actually changed so far (content differs from the pre-state). */
  changedFiles(): string[] {
    const changed = new Set<string>();
    for (const state of this.pre.values()) {
      if (hashOf(state.data, state.existed) === "?" || fingerprint(state.path) !== hashOf(state.data, state.existed)) {
        changed.add(state.path);
      }
    }
    if (this.useGit) {
      for (const file of changedSince(this.cwd, this.baseline)) changed.add(file);
    }
    return [...changed];
  }

  /** Pre-state for files changed outside edit/write, derived from git. */
  private outOfBandPreState(file: string): PreState {
    if (this.baseline.has(file)) return { path: file, existed: true, data: null };
    const head = headContent(this.cwd, file);
    return head === undefined ? { path: file, existed: false, data: null } : { path: file, existed: true, data: head };
  }

  /** Persist the checkpoint. Returns null when the run changed nothing. */
  save(store: CheckpointStore, changed = this.changedFiles()): CheckpointSummary | null {
    if (changed.length === 0) return null;
    const states = changed.map((file) => this.pre.get(file) ?? this.outOfBandPreState(file));
    return store.write(this.label, states);
  }
}

export class CheckpointStore {
  private readonly dir: string;
  private readonly retention: number;

  constructor(dir: string, retention: number) {
    this.dir = dir;
    this.retention = retention;
  }

  private manifests(): Manifest[] {
    let names: string[];
    try {
      names = fs.readdirSync(this.dir);
    } catch {
      return [];
    }
    const out: Manifest[] = [];
    for (const name of names) {
      try {
        const manifest = JSON.parse(fs.readFileSync(path.join(this.dir, name, "manifest.json"), "utf-8")) as Manifest;
        if (manifest?.version === 3 && Array.isArray(manifest.files)) out.push(manifest);
      } catch {
        /* not a checkpoint */
      }
    }
    return out.sort((a, b) => b.seq - a.seq);
  }

  write(label: string, states: PreState[]): CheckpointSummary | null {
    const existing = this.manifests();
    const seq = (existing[0]?.seq ?? 0) + 1;
    const id = `${seq}-${randomUUID().slice(0, 6)}`;
    const target = path.join(this.dir, id);
    try {
      fs.mkdirSync(path.join(target, "blobs"), { recursive: true, mode: 0o700 });
      const files: StoredFile[] = states.map((state, index) => {
        const entry: StoredFile = { path: state.path, existed: state.existed, after: fingerprint(state.path) };
        if (state.data) {
          entry.blob = `${index}.blob`;
          entry.mode = state.mode;
          fs.writeFileSync(path.join(target, "blobs", entry.blob), state.data, { mode: 0o600 });
        }
        return entry;
      });
      const manifest: Manifest = { version: 3, id, seq, at: new Date().toISOString(), label, files };
      fs.writeFileSync(path.join(target, "manifest.json"), JSON.stringify(manifest, null, 2), { mode: 0o600 });
      for (const old of [manifest, ...existing].slice(this.retention)) {
        fs.rmSync(path.join(this.dir, old.id), { recursive: true, force: true });
      }
      return summarise(manifest);
    } catch {
      fs.rmSync(target, { recursive: true, force: true });
      return null;
    }
  }

  list(limit = 20): CheckpointSummary[] {
    return this.manifests().slice(0, limit).map(summarise);
  }

  private find(id?: string): Manifest | undefined {
    const all = this.manifests();
    if (!id) return all[0];
    return all.find((m) => m.id === id || m.id.startsWith(`${id}-`) || String(m.seq) === id);
  }

  /** Restore the files of a checkpoint (default: the newest) to their pre-run state. */
  restore(id?: string, options: { force?: boolean } = {}): RestoreReport {
    const manifest = this.find(id);
    const report: RestoreReport = { found: Boolean(manifest), id: manifest?.id, restored: [], deleted: [], conflicts: [], unrecoverable: [] };
    if (!manifest) return report;

    for (const file of manifest.files) {
      if (!options.force && fingerprint(file.path) !== file.after) {
        report.conflicts.push(file.path);
        continue;
      }
      try {
        if (!file.existed) {
          fs.rmSync(file.path, { force: true });
          report.deleted.push(file.path);
          continue;
        }
        if (!file.blob) {
          report.unrecoverable.push(file.path);
          continue;
        }
        const data = fs.readFileSync(path.join(this.dir, manifest.id, "blobs", file.blob));
        fs.mkdirSync(path.dirname(file.path), { recursive: true });
        const tmp = `${file.path}.sentinel-${process.pid}.tmp`;
        fs.writeFileSync(tmp, data);
        if (file.mode !== undefined) fs.chmodSync(tmp, file.mode);
        fs.renameSync(tmp, file.path);
        report.restored.push(file.path);
      } catch {
        report.unrecoverable.push(file.path);
      }
    }
    return report;
  }
}

function summarise(manifest: Manifest): CheckpointSummary {
  return { id: manifest.id, at: manifest.at, label: manifest.label, files: manifest.files.map((f) => f.path) };
}
