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
 */

import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

import type { RollbackResult } from "../types.ts";

export class GitClient {
  /** Check whether the current cwd is a git repo. */
  static isGitRepo(cwd: string): boolean {
    return existsSync(join(cwd, ".git"));
  }

  /** Get the current git branch and HEAD commit for metadata. */
  static gitMeta(cwd: string): { branch: string; head: string } | null {
    if (!GitClient.isGitRepo(cwd)) return null;
    try {
      const branch = execSync("git rev-parse --abbrev-ref HEAD", {
        cwd,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      const head = execSync("git rev-parse --short HEAD", {
        cwd,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      return { branch, head };
    } catch {
      return null;
    }
  }

  /**
   * Roll back tracked file modifications in the working tree.
   *
   * Strategy (most conservative first):
   *   1. `git checkout -- .` (classic, widely compatible)
   *   2. `git restore .` (newer git, fallback)
   */
  static rollback(cwd: string): RollbackResult {
    if (!GitClient.isGitRepo(cwd)) {
      return {
        success: false,
        method: "none",
        message: "Not a git repository; rollback skipped.",
        command: "",
      };
    }

    const meta = GitClient.gitMeta(cwd);
    const attempts: Array<{ method: string; command: string }> = [
      { method: "git-checkout", command: "git checkout -- ." },
      { method: "git-restore", command: "git restore ." },
    ];

    for (const attempt of attempts) {
      try {
        execSync(attempt.command, {
          cwd,
          encoding: "utf-8",
          stdio: ["ignore", "pipe", "ignore"],
        });

        const result: RollbackResult = {
          success: true,
          method: attempt.method,
          message: `Working tree restored to ${meta?.head ?? "HEAD"} on branch ${meta?.branch ?? "unknown"}.`,
          command: attempt.command,
          committedAt: meta?.head,
          branch: meta?.branch,
        };
        return result;
      } catch {
        // Try next strategy
      }
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
