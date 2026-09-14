/**
 * WorkspaceScan — sees changes the hooks cannot (P3).
 *
 * Sentinel only observes `edit` and `write`. A large share of real edits does
 * not travel through them: `sed -i`, a formatter, `git apply`, a code
 * generator, `npm run fix`. Claude Code's checkpointing has the same blind
 * spot and documents the workaround explicitly: ask the working tree itself,
 * e.g. via `git status --porcelain`, which also lists untracked files that
 * `git diff` misses.
 *
 * Two properties make that answer usable rather than merely available:
 *
 *   1. **Root-relative paths.** `git status --porcelain` prints paths relative
 *      to the *repository root*, never to the current directory. Resolving
 *      them against the cwd produces paths that do not exist as soon as the
 *      agent runs in a subdirectory of the repo.
 *   2. **A turn baseline.** The working tree lists everything uncommitted,
 *      not everything this turn changed. Without a baseline every file the
 *      user already had in flight is attributed to the agent's turn — which
 *      then lands in the verification focus and, through it, in the state hash
 *      that bounds the repair loop. The baseline is captured at `turn_start`
 *      and the scan reports the difference.
 */

import { execSync } from "node:child_process";
import * as fs from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";

import { repoRoot } from "./git-client.ts";
import { MAX_SNAPSHOT_BYTES } from "./snapshot.ts";
import type { OutOfBandChange } from "../types.ts";

/**
 * Fingerprint of a path in the working tree, used to tell "already dirty when
 * the turn started" from "changed during the turn".
 *
 * Content hash for anything small enough to read, size+mtime beyond that, and
 * the link target for a symlink (whose *content* is the target, not the file
 * it points at). `-` means the path is not there.
 */
export function fingerprintOf(absPath: string): string {
  try {
    const link = fs.lstatSync(absPath);
    if (link.isSymbolicLink()) return `L:${fs.readlinkSync(absPath)}`;
    if (!link.isFile()) return `T:${link.mode}`;
    if (link.size > MAX_SNAPSHOT_BYTES) return `S:${link.size}:${link.mtimeMs}`;
    return `H:${createHash("sha1").update(fs.readFileSync(absPath)).digest("hex")}`;
  } catch {
    return "-";
  }
}

/** Absolute path → fingerprint, for every path git reported as dirty. */
export type WorkspaceBaseline = Map<string, string>;

/**
 * Parse `git status --porcelain` output into structured changes.
 *
 * Handles the three shapes that matter: normal entries (` M src/a.ts`),
 * untracked files (`?? new.ts`) and renames (`R  old.ts -> new.ts`).
 * Paths containing spaces are quoted by git and unquoted here.
 *
 * @param root Repository root the printed paths are relative to.
 */
export function parsePorcelain(stdout: string, root: string): OutOfBandChange[] {
  const out: OutOfBandChange[] = [];

  for (const rawLine of stdout.split("\n")) {
    const line = rawLine.trimEnd();
    if (!line.trim()) continue;

    const status = line.slice(0, 2);
    const rest = line.slice(3);
    if (!rest) continue;

    // "R  old -> new": the new path is what exists now.
    const arrow = rest.indexOf(" -> ");
    const target = arrow >= 0 ? rest.slice(arrow + 4) : rest;

    let file = target.trim();
    if (file.startsWith('"') && file.endsWith('"') && file.length > 1) {
      file = file.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
    }
    if (!file) continue;

    out.push({ status, path: resolve(root, file) });
  }

  return out;
}

/**
 * Every path git currently reports as changed, or `[]` outside a repo.
 *
 * Non-git projects simply get no out-of-band detection — the mutation hooks
 * keep working, so this is a capability gap, never a failure.
 */
export function changedPaths(cwd: string): OutOfBandChange[] {
  const root = repoRoot(cwd);
  if (!root) return [];

  // One retry on purpose: a transient failure (fork/exec pressure, a
  // momentarily locked index) must not silently disable out-of-band detection
  // for a whole turn.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const stdout = execSync("git status --porcelain --untracked-files=all", {
        cwd: root,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 10_000,
        maxBuffer: 8 * 1024 * 1024,
      });
      return parsePorcelain(stdout, root);
    } catch {
      /* retry once, then report nothing */
    }
  }
  return [];
}

/**
 * Fingerprint every currently-dirty path, so a later scan can subtract the
 * work that was already in flight before the turn began.
 *
 * Cheap in the case that matters (a handful of dirty files) and bounded in the
 * case that does not: beyond `maxFiles` the baseline stops growing and the
 * extra paths are simply treated as pre-existing, which under-reports rather
 * than inventing changes the agent never made.
 */
export function captureBaseline(cwd: string, maxFiles = 2000): WorkspaceBaseline {
  const baseline: WorkspaceBaseline = new Map();
  for (const change of changedPaths(cwd)) {
    if (baseline.size >= maxFiles) break;
    baseline.set(resolve(change.path), fingerprintOf(change.path));
  }
  return baseline;
}

/**
 * Changes that did not come through the mutation hooks.
 *
 * @param known    Absolute paths already accounted for by `edit`/`write`.
 * @param ignore   Predicate for paths that should never trigger verification.
 * @param baseline Working-tree state when the turn started. Paths whose
 *                 fingerprint is unchanged since then were dirty *before* the
 *                 turn and are not attributed to it. Omit it to report every
 *                 dirty path, which is the pre-baseline behaviour.
 */
export function outOfBandChanges(
  cwd: string,
  known: string[],
  ignore: (absPath: string) => boolean = () => false,
  baseline?: WorkspaceBaseline,
): OutOfBandChange[] {
  const knownSet = new Set(known.map((p) => resolve(p)));
  return changedPaths(cwd).filter((change) => {
    const abs = resolve(change.path);
    if (knownSet.has(abs)) return false;
    if (ignore(change.path)) return false;
    if (!baseline) return true;
    const before = baseline.get(abs);
    // Absent from the baseline: the path was clean when the turn started, so
    // whatever it is now happened during the turn.
    if (before === undefined) return true;
    return before !== fingerprintOf(change.path);
  });
}

/**
 * Paths that were dirty at the baseline and have since vanished from the
 * working tree entirely (committed, stashed or reverted mid-turn). They are
 * changes too, and `changedPaths` can no longer see them.
 */
export function disappearedSinceBaseline(
  cwd: string,
  baseline: WorkspaceBaseline,
): string[] {
  const current = new Set(changedPaths(cwd).map((c) => resolve(c.path)));
  const gone: string[] = [];
  for (const [abs, before] of baseline) {
    if (current.has(abs)) continue;
    if (fingerprintOf(abs) !== before) gone.push(abs);
  }
  return gone;
}
