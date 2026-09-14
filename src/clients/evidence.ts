/**
 * EvidenceLedger — state-bound evidence (P2).
 *
 * The measurable failure mode of repair loops is not "too few retries". It is
 * revising code that already passed: forcing extra revisions degraded
 * correctness by 14.7 percentage points, with *stale verification traces* as
 * the primary mechanism (arXiv 2607.24604). The fix is to bind evidence to the
 * exact code state that produced it.
 *
 * This ledger records, per file, the content hash of the state that last
 * passed verification — plus a restorable copy of that state. Two things
 * become possible that sentinel could not do before:
 *
 *   1. Detect a regression: a file that was green at hash X differs now and
 *      the check is red → report *that*, instead of repeating the raw error
 *      the agent already failed to fix.
 *   2. Revert that single file to its verified state (opt-in via
 *      `revertOnRegression`), without touching anything else.
 *
 * Layout: `<projectDir>/verified.json` + `<projectDir>/verified-blobs/…`.
 * All writes are atomic and permission-safe, like the state file.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";

import { projectDir } from "../config.ts";
import { MAX_SNAPSHOT_BYTES, snapshotFile, restoreFileSnapshot } from "./snapshot.ts";
import type { Regression, VerifiedStateEntry } from "../types.ts";

interface LedgerFile {
  version: number;
  files: Record<string, VerifiedStateEntry>;
}

function ledgerPath(cwd: string): string {
  return path.join(projectDir(cwd), "verified.json");
}

function blobDir(cwd: string): string {
  return path.join(projectDir(cwd), "verified-blobs");
}

/** SHA-1 of file content, or null when the file does not exist. */
export function hashFile(absPath: string): string | null {
  try {
    return createHash("sha1").update(fs.readFileSync(absPath)).digest("hex");
  } catch {
    return null;
  }
}

/**
 * Hash of a *set* of files — the identity of the code state a verification
 * result refers to. Used to notice that a failure is about an unchanged state
 * (so re-prompting would repeat itself) versus a genuinely new revision.
 *
 * An empty set has no identity and returns `""` rather than the SHA-1 of the
 * empty string (`da39a3ee5e6b`). That constant is a valid-looking hash, and the
 * failure payload printed it as the state a red run was about — so a run that
 * verified nothing appeared to be bound to something. Every caller that prints
 * or compares a hash treats the empty string as "no state".
 */
export function stateHashOf(absPaths: string[]): string {
  const unique = [...new Set(absPaths)];
  if (unique.length === 0) return "";
  const parts = unique
    .map((p) => path.resolve(p))
    .sort()
    .map((p) => `${p}:${hashFile(p) ?? "missing"}`);
  return createHash("sha1").update(parts.join("\n")).digest("hex").slice(0, 12);
}

function readLedger(cwd: string): LedgerFile {
  try {
    const raw = JSON.parse(fs.readFileSync(ledgerPath(cwd), "utf-8")) as LedgerFile;
    if (raw && typeof raw === "object" && raw.files && typeof raw.files === "object") {
      return { version: 1, files: raw.files };
    }
  } catch {
    /* absent or corrupt — start clean */
  }
  return { version: 1, files: {} };
}

function writeLedger(cwd: string, ledger: LedgerFile): void {
  const file = ledgerPath(cwd);
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(ledger, null, 2), { encoding: "utf-8", mode: 0o600 });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, file);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* ignore */
    }
    throw err;
  }
}

/** Remove a superseded blob, best-effort. */
function removeBlob(cwd: string, blob: string | undefined): void {
  if (!blob) return;
  try {
    fs.unlinkSync(path.join(blobDir(cwd), blob));
  } catch {
    /* ignore */
  }
}

/**
 * Record a green state for each existing path.
 *
 * @param step  Which verification produced this evidence (group + steps).
 * @param at    Timestamp for the entry (ISO string).
 * @returns the entries that were actually updated.
 */
export function recordVerified(
  cwd: string,
  absPaths: string[],
  step: string,
  at: string = new Date().toISOString(),
): VerifiedStateEntry[] {
  const ledger = readLedger(cwd);
  const updated: VerifiedStateEntry[] = [];

  for (const absPath of new Set(absPaths.map((p) => path.resolve(p)))) {
    const hash = hashFile(absPath);
    if (hash === null) continue;

    const existing = ledger.files[absPath];
    if (existing && existing.hash === hash && existing.step === step) continue;

    let blob: string | undefined;
    const snap = snapshotFile(absPath);
    if (snap.existed && !snap.incomplete && snap.data) {
      try {
        fs.mkdirSync(blobDir(cwd), { recursive: true, mode: 0o700 });
        blob = `${createHash("sha1").update(absPath).digest("hex").slice(0, 10)}-${hash}.blob`;
        fs.writeFileSync(path.join(blobDir(cwd), blob), snap.data, { mode: 0o600 });
      } catch {
        blob = undefined;
      }
    }

    // The previous blob is now unreachable — drop it so the store stays small.
    if (existing?.blob && existing.blob !== blob) removeBlob(cwd, existing.blob);

    const entry: VerifiedStateEntry = { path: absPath, hash, at, step, blob };
    ledger.files[absPath] = entry;
    updated.push(entry);
  }

  if (updated.length > 0) writeLedger(cwd, ledger);
  return updated;
}

/**
 * Files that were green at some earlier state and differ from it now.
 * Files that no longer exist count as regressed (they were deleted).
 */
export function detectRegressions(cwd: string, absPaths: string[]): Regression[] {
  const ledger = readLedger(cwd);
  const out: Regression[] = [];

  for (const absPath of new Set(absPaths.map((p) => path.resolve(p)))) {
    const entry = ledger.files[absPath];
    if (!entry) continue;
    const currentHash = hashFile(absPath) ?? "missing";
    if (currentHash === entry.hash) continue;
    out.push({
      path: absPath,
      verifiedAt: entry.at,
      verifiedStep: entry.step,
      verifiedHash: entry.hash,
      currentHash,
      reverted: false,
    });
  }

  return out;
}

/** Verified state for one path, if any. */
export function verifiedEntry(cwd: string, absPath: string): VerifiedStateEntry | null {
  const entry = readLedger(cwd).files[path.resolve(absPath)];
  return entry ?? null;
}

/** All verified entries, newest first. */
export function allVerified(cwd: string): VerifiedStateEntry[] {
  return Object.values(readLedger(cwd).files).sort((a, b) => b.at.localeCompare(a.at));
}

/** Ledger entries scanned when answering "what is green right now". */
export const MAX_VERIFIED_SCAN = 200;

/**
 * The files that passed verification and are *still* in that exact state.
 *
 * `allVerified` answers "what did we ever record"; this answers the question
 * the agent actually needs before it edits: which files are green as of this
 * moment. An entry whose file has since changed is not evidence about the
 * current tree and is deliberately left out rather than reported stale.
 */
export function currentlyVerified(cwd: string, limit = 12): VerifiedStateEntry[] {
  const out: VerifiedStateEntry[] = [];
  let scanned = 0;
  for (const entry of allVerified(cwd)) {
    if (scanned >= MAX_VERIFIED_SCAN || out.length >= limit) break;
    scanned += 1;
    if (hashFile(entry.path) !== entry.hash) continue;
    out.push(entry);
  }
  return out;
}

/**
 * Restore a file to the state that last passed verification.
 * Returns false when there is no usable blob for it.
 */
export function revertToVerified(cwd: string, absPath: string): boolean {
  const entry = verifiedEntry(cwd, absPath);
  if (!entry?.blob) return false;

  let data: Buffer;
  try {
    data = fs.readFileSync(path.join(blobDir(cwd), entry.blob));
  } catch {
    return false;
  }

  const outcome = restoreFileSnapshot({ path: entry.path, existed: true, data, incomplete: false });
  return outcome === "restored";
}

/**
 * Forget evidence for the given paths (e.g. after a revert, so the restored
 * state is not immediately reported as a regression again).
 */
export function forgetVerified(cwd: string, absPaths: string[]): void {
  const ledger = readLedger(cwd);
  let changed = false;
  for (const absPath of absPaths) {
    const key = path.resolve(absPath);
    const entry = ledger.files[key];
    if (!entry) continue;
    removeBlob(cwd, entry.blob);
    delete ledger.files[key];
    changed = true;
  }
  if (changed) writeLedger(cwd, ledger);
}

/** @internal Size guard reused by the checkpoint store. */
export const MAX_EVIDENCE_BYTES = MAX_SNAPSHOT_BYTES;
