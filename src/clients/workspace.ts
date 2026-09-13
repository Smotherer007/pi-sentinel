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
 * This module does exactly that, and nothing else.
 */

import { execSync } from "node:child_process";
import { resolve } from "node:path";

import type { OutOfBandChange } from "../types.ts";

/**
 * Parse `git status --porcelain` output into structured changes.
 *
 * Handles the three shapes that matter: normal entries (` M src/a.ts`),
 * untracked files (`?? new.ts`) and renames (`R  old.ts -> new.ts`).
 * Paths containing spaces are quoted by git and unquoted here.
 */
export function parsePorcelain(stdout: string, cwd: string): OutOfBandChange[] {
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

    out.push({ status, path: resolve(cwd, file) });
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
  try {
    const stdout = execSync("git status --porcelain --untracked-files=all", {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 10_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    return parsePorcelain(stdout, cwd);
  } catch {
    return [];
  }
}

/**
 * Changes that did not come through the mutation hooks.
 *
 * @param known Absolute paths already accounted for by `edit`/`write`.
 * @param ignore Predicate for paths that should never trigger verification.
 */
export function outOfBandChanges(
  cwd: string,
  known: string[],
  ignore: (absPath: string) => boolean = () => false,
): OutOfBandChange[] {
  const knownSet = new Set(known.map((p) => resolve(p)));
  return changedPaths(cwd).filter(
    (change) => !knownSet.has(resolve(change.path)) && !ignore(change.path),
  );
}
