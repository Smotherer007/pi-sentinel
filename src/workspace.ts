/**
 * What git knows about the working tree: which files changed, and what a clean
 * tracked file looked like before (its HEAD version).
 *
 * This is how changes made through `bash` — formatters, codegen, `sed -i`,
 * `git checkout` — are both verified and rewindable without guarding the shell.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

function git(args: string[], cwd: string, encoding: "utf-8" | "buffer" = "utf-8"): string | Buffer | null {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: encoding === "utf-8" ? "utf-8" : undefined,
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 15_000,
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch {
    return null;
  }
}

const roots = new Map<string, string | null>();

export function repoRoot(cwd: string): string | null {
  const key = path.resolve(cwd);
  if (!roots.has(key)) {
    const top = (git(["rev-parse", "--show-toplevel"], key) as string | null)?.trim();
    if (!top) {
      roots.set(key, null);
    } else {
      // Express the root through the caller's spelling of the path, so paths
      // from git line up with the paths pi's tools use (/var vs /private/var).
      let real = key;
      try {
        real = fs.realpathSync(key);
      } catch {
        /* keep the given path */
      }
      const up = path.relative(real, top);
      roots.set(key, up === "" ? key : up.split(path.sep).every((s) => s === "..") ? path.resolve(key, up) : top);
    }
  }
  return roots.get(key) ?? null;
}

export function _clearRepoRootCache(): void {
  roots.clear();
}

/** Content fingerprint of a path ("-" when absent). */
export function fingerprint(absPath: string): string {
  try {
    const stat = fs.lstatSync(absPath);
    if (stat.isSymbolicLink()) return `L:${fs.readlinkSync(absPath)}`;
    if (!stat.isFile()) return `T:${stat.mode}`;
    return createHash("sha1").update(fs.readFileSync(absPath)).digest("hex");
  } catch {
    return "-";
  }
}

/** Parse `git status --porcelain -z` into absolute paths. */
export function parsePorcelainZ(stdout: string, root: string): string[] {
  const out: string[] = [];
  const parts = stdout.split("\0");
  for (let i = 0; i < parts.length; i += 1) {
    const entry = parts[i];
    if (entry.length < 4) continue;
    const status = entry.slice(0, 2);
    out.push(path.join(root, entry.slice(3)));
    // Renames and copies carry the source path as the next field.
    if (status.includes("R") || status.includes("C")) i += 1;
  }
  return out;
}

/** Changed and untracked files, as absolute paths. Empty outside a repository. */
export function dirtyFiles(cwd: string): string[] {
  const root = repoRoot(cwd);
  if (!root) return [];
  const stdout = git(["status", "--porcelain", "-z", "--untracked-files=all"], root) as string | null;
  return stdout ? parsePorcelainZ(stdout, root) : [];
}

export type Baseline = Map<string, string>;

/** Fingerprints of everything already dirty before the agent started. */
export function captureBaseline(cwd: string, maxFiles = 5_000): Baseline {
  const baseline: Baseline = new Map();
  for (const file of dirtyFiles(cwd)) {
    if (baseline.size >= maxFiles) break;
    baseline.set(file, fingerprint(file));
  }
  return baseline;
}

/** Files that changed since the baseline was taken. */
export function changedSince(cwd: string, baseline: Baseline): string[] {
  const now = dirtyFiles(cwd);
  const changed = now.filter((file) => baseline.get(file) !== fingerprint(file));
  // A file that was dirty and is now clean (e.g. `git checkout -- file`) changed too.
  const current = new Set(now);
  for (const [file, before] of baseline) {
    if (!current.has(file) && fingerprint(file) !== before) changed.push(file);
  }
  return changed;
}

/**
 * The HEAD version of a file that was clean when the run started.
 * `undefined` means "not tracked" (the file did not exist before).
 */
export function headContent(cwd: string, absPath: string): Buffer | undefined {
  const root = repoRoot(cwd);
  if (!root) return undefined;
  const rel = path.relative(root, absPath).split(path.sep).join("/");
  const out = git(["show", `HEAD:${rel}`], root, "buffer");
  return out === null ? undefined : (out as Buffer);
}
