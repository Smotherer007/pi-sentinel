/**
 * TracePruner — pure formatting functions for pruning terminal output.
 *
 * Failed tool executions produce huge, noisy outputs (bundler logs, lint
 * waterfalls, full stack traces). Sentinel prunes these down to the N most
 * critical lines, saving tokens and keeping the loop's context clean.
 *
 * These are pure string-in / string-out functions (like pi-email's
 * formatting/formatters.ts) — no I/O, no side effects.
 */

/**
 * Extract the most informative error lines from raw process output.
 *
 * Heuristics:
 *   - Lines containing /error/i, /fail/i, /warning/i
 *   - Lines with file:line:column patterns (TS, eslint, gcc, etc.)
 *   - Lines starting with known error codes (TS####, E####, error[E####])
 *   - The first and last few lines of a trace (context anchors)
 */
export function pruneTrace(rawOutput: string, maxLines: number): string {
  if (!rawOutput.trim()) return "";

  const lines = rawOutput.split("\n").map((l) => l.trimEnd());
  const critical: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    if (
      /error/i.test(trimmed) ||
      /fail/i.test(trimmed) ||
      /\bTS\d{4}\b/.test(trimmed) ||
      /:\d+:\d+/.test(trimmed) ||
      /^error\[/.test(trimmed) ||
      /^\w+\.error/.test(trimmed) ||
      /^Error:/.test(trimmed) ||
      /^\s*at\s/.test(trimmed) // Node stack frames
    ) {
      critical.push(line.trim());
    }
  }

  // If no critical lines found, keep first/last lines as anchors.
  let result = critical;
  if (result.length === 0 && lines.length > 0) {
    const anchors: string[] = [];
    anchors.push(...lines.slice(0, 3).map((l) => l.trim()));
    if (lines.length > 6) {
      anchors.push("...");
      anchors.push(...lines.slice(-3).map((l) => l.trim()));
    }
    result = anchors;
  }

  // Cap at maxLines, but preserve header/footer context.
  if (result.length > maxLines) {
    const head = result.slice(0, maxLines - 3);
    const tail = result.slice(-3);
    result = [...head, "...", ...tail];
    if (result.length > maxLines) result = result.slice(0, maxLines);
  }

  return result.join("\n").trim();
}

/**
 * Format a verification failure into a human-readable error payload
 * intended for injection back into the agent loop (as the tool result).
 * Keeps the format terse so the model can act on it immediately.
 */
export function formatError(failure: {
  step: string;
  exitCode: number;
  durationMs: number;
  prunedTrace: string;
  rawOutput: string;
  warnOnly: boolean;
}): string {
  const header = `[sentinel] Verification failed at step "${failure.step}"`;
  const exit = `exit code: ${failure.exitCode} | duration: ${failure.durationMs}ms`;
  const trace = failure.prunedTrace || failure.rawOutput.slice(0, 2000);

  return [
    header,
    exit,
    "─".repeat(60),
    trace,
    "─".repeat(60),
    failure.warnOnly
      ? "This is a WARNING only; no rollback was performed."
      : "The working tree has been rolled back. Re-run the failed mutation.",
  ].join("\n");
}
