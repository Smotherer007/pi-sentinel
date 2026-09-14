/**
 * GitClient — git working-tree rollback operations.
 *
 * This is the I/O isolation layer for git interactions (parallel to
 * pi-email's clients/). It only talks to the git CLI; it never mutates
 * business state itself.
 *
 * Safe by design:
 *   - Defaults to `git checkout -- .` for tracked-file restores.
 *   - Falls back to `git restore .` for newer git versions.
 *   - Never deletes untracked files unless explicitly configured.
 *
 * Repository identity: every operation resolves the *repository root* first.
 * Running an agent in a directory below the root is completely normal (a
 * package inside a monorepo), and `existsSync(cwd/.git)` answers "no" for all
 * of them — which used to disable rollback, git metadata and out-of-band
 * detection in a perfectly healthy repository.
 */

import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import type { RollbackResult } from "../types.ts";

/** Resolved repository root per working directory. Positive results only. */
const rootCache = new Map<string, string>();

function git(command: string, cwd: string): string | null {
  try {
    return execSync(command, {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 10_000,
    }).trim();
  } catch {
    return null;
  }
}

/**
 * The repository root for `cwd`, expressed in the caller's own namespace.
 *
 * `git rev-parse --show-toplevel` returns a *canonical* path: on macOS a
 * repository created under `/var/folders/...` comes back as `/private/var/...`.
 * Handing that back would make every derived absolute path disagree with the
 * paths the mutation hooks captured, so the canonical root is mapped back
 * through the caller's own (possibly symlinked) prefix.
 *
 * Returns `null` when `cwd` is not inside a git repository.
 */
export function repoRoot(cwd: string): string | null {
  const key = path.resolve(cwd);
  const cached = rootCache.get(key);
  if (cached !== undefined) return cached;

  // Only positive answers are memoised. "Not a repository" is a state the
  // user can leave (`git init` mid-session), and two extra `git rev-parse`
  // calls per turn are nothing next to running a type-checker.
  const top = git("git rev-parse --show-toplevel", key);
  if (!top) return null;

  let real: string;
  try {
    real = fs.realpathSync(key);
  } catch {
    real = key;
  }

  // How far up from the (canonical) cwd the root lies. Every segment must be
  // "..", otherwise the two paths are unrelated and git's own answer is the
  // only one we can trust.
  const up = path.relative(real, top);
  let resolved: string;
  if (up === "") {
    resolved = key;
  } else if (up.split(path.sep).every((segment) => segment === "..")) {
    resolved = path.resolve(key, up);
  } else {
    resolved = top;
  }

  rootCache.set(key, resolved);
  return resolved;
}

/** @internal Drop the memoised repository roots — for testing only. */
export function _clearRepoRootCache(): void {
  rootCache.clear();
}

export class GitClient {
  /** Check whether `cwd` lies inside a git repo (a subdirectory counts). */
  static isGitRepo(cwd: string): boolean {
    return repoRoot(cwd) !== null;
  }

  /** The repository root for `cwd`, or null outside a repository. */
  static root(cwd: string): string | null {
    return repoRoot(cwd);
  }

  /** Get the current git branch and HEAD commit for metadata. */
  static gitMeta(cwd: string): { branch: string; head: string } | null {
    const root = repoRoot(cwd);
    if (!root) return null;
    const branch = git("git rev-parse --abbrev-ref HEAD", root);
    const head = git("git rev-parse --short HEAD", root);
    if (branch === null || head === null) return null;
    return { branch, head };
  }

  /**
   * Roll back tracked file modifications in the working tree.
   *
   * Strategy (most conservative first):
   *   1. `git checkout -- .` (classic, widely compatible)
   *   2. `git restore .` (newer git, fallback)
   *
   * Always executed at the repository root: run from a subdirectory, `.`
   * would silently restore only that subtree while reporting a full reset.
   */
  static rollback(cwd: string): RollbackResult {
    const root = repoRoot(cwd);
    if (!root) {
      return {
        success: false,
        method: "none",
        message: "Not a git repository; rollback skipped.",
        command: "",
      };
    }

    const meta = GitClient.gitMeta(root);
    const attempts: Array<{ method: string; command: string }> = [
      { method: "git-checkout", command: "git checkout -- ." },
      { method: "git-restore", command: "git restore ." },
    ];

    for (const attempt of attempts) {
      if (git(attempt.command, root) === null) continue;
      return {
        success: true,
        method: attempt.method,
        message: `Working tree restored to ${meta?.head ?? "HEAD"} on branch ${meta?.branch ?? "unknown"}.`,
        command: attempt.command,
        committedAt: meta?.head,
        branch: meta?.branch,
      };
    }

    return {
      success: false,
      method: "none",
      message: "All rollback strategies failed. Manual intervention required.",
      command: attempts.map((a) => a.command).join(" ; "),
      branch: meta?.branch,
    };
  }
}
