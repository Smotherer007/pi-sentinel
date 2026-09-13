/**
 * TracePruner — pure formatting functions for pruning terminal output.
 *
 * Failed tool executions produce huge, noisy outputs (bundler logs, lint
 * waterfalls, full stack traces). Sentinel prunes these down to the most
 * *valuable* lines, not merely the first or last ones: compiler diagnostics
 * and failing tests outrank stack frames, source locations outrank context,
 * and download notices rank last (see `lines.ts` for the ordering).
 *
 * These are pure string-in / string-out functions (like pi-email's
 * formatting/formatters.ts) — no I/O, no side effects.
 */

import { RANK, dedupeLines, isDiagnosticRank, rankLine, stripAnsi } from "./lines.ts";
import { failureAdvice, failureHeadline } from "./classify.ts";
import type { FailureKind, GraphImpact, Regression, RollbackConflict } from "../types.ts";

interface RankedLine {
  line: string;
  rank: number;
  /** Position in the original output, used to keep a stable order. */
  index: number;
}

/**
 * Extract the most informative error lines from raw process output.
 *
 * Ordering: focus paths first (the files just mutated), then by rank, then by
 * original position. When the output contains no diagnostic at all, the
 * first/last lines are kept as anchors rather than returning nothing.
 *
 * @param rawOutput    Raw combined stdout/stderr of the failed step.
 * @param maxLines     Hard cap on returned lines (including the "..." marker).
 * @param focusPaths   Optional file paths to prioritise (absolute or relative).
 */
export function pruneTrace(rawOutput: string, maxLines: number, focusPaths: string[] = []): string {
  if (!rawOutput.trim()) return "";
  if (maxLines <= 0) return "";

  const lines = stripAnsi(rawOutput).split("\n").map((line) => line.trimEnd());
  const focusNeedles = focusPaths
    .filter(Boolean)
    .map((path) => path.replace(/\\/g, "/"));

  const ranked: RankedLine[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line) continue;
    // Focused lines are kept even if they don't look like errors — a compiler
    // pointing at the file we just touched is always the most useful signal.
    const normalised = line.replace(/\\/g, "/");
    const focused = focusNeedles.some((needle) => normalised.includes(needle));
    ranked.push({ line, rank: focused ? RANK.focus : rankLine(line), index });
  }

  const hasDiagnostics = ranked.some((entry) => isDiagnosticRank(entry.rank));

  let selected: RankedLine[];
  if (hasDiagnostics) {
    // Context (an indented continuation, a caret line, a source snippet) is
    // only useful directly next to a diagnostic it belongs to.
    const adjacent = new Set<number>();
    for (const entry of ranked) {
      if (!isDiagnosticRank(entry.rank)) continue;
      adjacent.add(entry.index + 1);
      adjacent.add(entry.index - 1);
    }
    selected = ranked.filter(
      (entry) => isDiagnosticRank(entry.rank) || (entry.rank === RANK.context && adjacent.has(entry.index)),
    );
  } else {
    // Nothing looked diagnostic: keep first/last lines as anchors.
    const anchors: RankedLine[] = ranked.slice(0, 3);
    if (ranked.length > 6) {
      anchors.push({ line: "...", rank: RANK.noise, index: -1 });
      anchors.push(...ranked.slice(-3));
    }
    selected = anchors;
  }

  let result = dedupeLines(
    [...selected]
      .sort((a, b) => a.rank - b.rank || a.index - b.index)
      .map((entry) => entry.line),
  );

  // Cap to maxLines while keeping a header *and* a footer anchor.
  if (result.length > maxLines) {
    if (maxLines <= 2) {
      return result.slice(0, maxLines).join("\n").trim();
    }
    const tailCount = Math.min(3, maxLines - 2);
    const headCount = maxLines - tailCount - 1;
    result = [...result.slice(0, headCount), "...", ...result.slice(-tailCount)];
  }

  return result.join("\n").trim();
}

/**
 * Format a verification failure into a human-readable error payload
 * intended for injection back into the agent loop (as the tool result).
 * Keeps the format terse so the model can act on it immediately.
 *
 * `rolledBack` must reflect what actually happened — claiming a rollback
 * that never occurred makes the model re-apply changes that are still
 * present.
 */
export function formatError(failure: {
  step: string;
  exitCode: number;
  durationMs: number;
  prunedTrace: string;
  rawOutput: string;
  warnOnly: boolean;
  rolledBack?: boolean;
  /** P2: files that dropped away from a state that used to pass. */
  regressions?: Regression[];
  /** Mindplace synergy: blast radius of the files involved. */
  impact?: GraphImpact[];
  /** Identity of the code state this result refers to. */
  stateHash?: string;
  /** P0: bounded-retry accounting for this attempt. */
  attempt?: { attempt: number; max: number; stopped?: boolean };
  /** P6: what kind of failure this was, and what it means. */
  failureKind?: FailureKind;
  /** P6: true when the step was killed because it exceeded its timeout. */
  timedOut?: boolean;
  /** P6: one-line summary of the failure. */
  errorSummary?: string;
  /** P6: the same failure has now been seen this many times. */
  escalation?: { count: number; max: number };
  /** P6: files left untouched because they changed since the snapshot. */
  conflicts?: RollbackConflict[];
  /**
   * Files sentinel could not restore (oversized, unreadable, a symlink). Their
   * state is unknown — the advice must say so instead of claiming the changes
   * are either restored or still in place.
   */
  restoreSkipped?: string[];
  /** P6: how many attempts the step needed (only when > 1). */
  attempts?: number;
}): string {
  const header = `[sentinel] Verification failed at step "${failure.step}"`;
  const exitParts = [`exit code: ${failure.exitCode}`, `duration: ${failure.durationMs}ms`];
  if (failure.attempts && failure.attempts > 1) exitParts.push(`attempts: ${failure.attempts}`);
  if (failure.failureKind) exitParts.push(`kind: ${failureHeadline(failure.failureKind)}`);
  if (failure.timedOut) exitParts.push("timed out");
  const exit = exitParts.join(" | ");
  const trace = failure.prunedTrace || failure.rawOutput.slice(0, 2000);

  const conflicts = failure.conflicts ?? [];
  const skipped = failure.restoreSkipped ?? [];

  let advice: string;
  if (failure.warnOnly) {
    advice = "This is a WARNING only; no rollback was performed.";
  } else if (failure.rolledBack) {
    advice = "Your changes were rolled back. Re-apply them only after fixing the cause.";
  } else if (conflicts.length > 0) {
    advice =
      "Sentinel restored what it could and left the conflicted files as they are. Review those files before editing again — the restore did not finish.";
  } else if (skipped.length > 0) {
    advice =
      "Sentinel restored only part of the changed files: the ones below could not be restored, so their state is UNKNOWN. Inspect them before editing again — do not assume either kind of change is still present.";
  } else {
    advice =
      "Your changes are still in place. Fix the reported error; do not repeat the same edit.";
  }

  const lines = [header, exit];
  if (failure.errorSummary) lines.push(`what failed: ${failure.errorSummary}`);
  if (failure.stateHash) lines.push(`state: ${failure.stateHash}`);
  lines.push("─".repeat(60), trace, "─".repeat(60));

  // P6: a file that the agent did not write and sentinel therefore refuses to
  // touch. This is the one message that must never be softened: the restore
  // did *not* happen.
  if (conflicts.length > 0) {
    lines.push(`ROLLBACK CONFLICT (${conflicts.length} file(s)) — NOT overwritten:`);
    for (const conflict of conflicts.slice(0, 5)) {
      lines.push(`  ${shortPath(conflict.path)} was modified after the Sentinel snapshot.`);
      if (conflict.expectedHash || conflict.actualHash) {
        lines.push(
          `    expected: ${conflict.expectedHash?.slice(0, 12) ?? "absent"} | current: ${conflict.actualHash?.slice(0, 12) ?? "absent"}`,
        );
      }
    }
    lines.push("  The file was NOT overwritten. Manual recovery required.");
  }

  // A file sentinel could not restore is neither restored nor untouched. Say
  // so explicitly: the state is unknown, and guessing either way is unsafe.
  if (skipped.length > 0) {
    lines.push(`RESTORE INCOMPLETE (${skipped.length} file(s)) — state UNKNOWN:`);
    for (const file of skipped.slice(0, 5)) lines.push(`  ${shortPath(file)} could not be restored.`);
    lines.push("  These files were NOT touched by the rollback. Verify them by hand.");
  }

  // P2: the strongest signal sentinel can give — this used to be green.
  const regressions = failure.regressions ?? [];
  if (regressions.length > 0) {
    lines.push(`Regressed from a verified state (${regressions.length} file(s)):`);
    for (const r of regressions.slice(0, 5)) {
      const when = r.verifiedAt.replace("T", " ").slice(0, 19);
      const action = r.reverted ? " — restored to the verified state" : "";
      lines.push(`  • ${shortPath(r.path)} — was green at ${when} (${r.verifiedStep})${action}`);
      if (!r.reverted) {
        lines.push(
          `    current: ${r.currentHash.slice(0, 12)} vs verified: ${r.verifiedHash.slice(0, 12)}`,
        );
      }
    }
  }

  // Mindplace synergy: what else this change can break.
  const impact = failure.impact ?? [];
  if (impact.length > 0) {
    lines.push("Impact (code graph):");
    for (const i of impact.slice(0, 4)) {
      const deps = i.dependents.length > 0 ? i.dependents.join(", ") : "none";
      const symbols = i.symbols.length > 0 ? ` [${i.symbols.slice(0, 4).join(", ")}]` : "";
      lines.push(`  • ${i.file}${symbols} → ${deps}`);
    }
  }

  lines.push(advice);

  // P6: do not send the agent back to edit code that the failure was not
  // about (timeouts, missing binaries, environment problems).
  if (failure.failureKind && !failure.warnOnly) {
    const kindAdvice = failureAdvice(failure.failureKind);
    if (kindAdvice) lines.push(kindAdvice);
  }

  // P0: bounded retries, reported to the model so it knows when to stop.
  if (failure.attempt && !failure.warnOnly) {
    const { attempt, max, stopped } = failure.attempt;
    lines.push(
      stopped
        ? `Repair attempt ${attempt}/${max} produced an identical code state — stop editing and report instead.`
        : `Repair attempt ${attempt}/${max}. After ${max}, stop and report what still fails instead of editing again.`,
    );
  }

  // P6: the same failure has repeated — the current approach is not working.
  if (failure.escalation) {
    const { count, max } = failure.escalation;
    lines.push(
      "Repeated verification failure detected.",
      `The same error occurred ${count} time(s) (threshold ${max}). Do not repeat the same approach — re-evaluate the implementation before editing again.`,
    );
  }

  return lines.join("\n");
}

/** Keep feedback terse: absolute paths burn context for no benefit. */
function shortPath(absPath: string): string {
  const parts = absPath.split(/[\\/]/);
  return parts.length > 2 ? parts.slice(-2).join("/") : absPath;
}
