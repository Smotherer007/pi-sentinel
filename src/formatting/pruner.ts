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

/** Matches ANSI SGR / CSI escape sequences emitted by colourised tools. */
// eslint-disable-next-line no-control-regex
const ANSI_PATTERN = /\u001b\[[0-9;]*[A-Za-z]/g;

/** Signals that a line is worth keeping (errors, diagnostics, stack frames). */
const CRITICAL_PATTERNS: RegExp[] = [
  /error/i,
  /fail/i,
  /\bTS\d{4}\b/,
  /:\d+:\d+/,
  /^error\[/,
  /^\w+\.error/,
  /^Error:/,
  /^\s*at\s/, // Node stack frames
];

function isCritical(line: string): boolean {
  return CRITICAL_PATTERNS.some((re) => re.test(line));
}

/** Collapse consecutive duplicate lines while keeping the first occurrence. */
function dedupe(lines: string[]): string[] {
  const out: string[] = [];
  for (const line of lines) {
    if (out.length > 0 && out[out.length - 1] === line) continue;
    out.push(line);
  }
  return out;
}

/**
 * Extract the most informative error lines from raw process output.
 *
 * Heuristics:
 *   - Lines containing /error/i, /fail/i, /warning/i
 *   - Lines with file:line:column patterns (TS, eslint, gcc, etc.)
 *   - Lines starting with known error codes (TS####, E####, error[E####])
 *   - Stack frames (`  at foo (file:line:col)`)
 *   - Lines mentioning one of `focusPaths` (the files just mutated) are
 *     promoted to the front — those are the diagnostics the agent can act on.
 *   - First/last lines of a trace are kept as context anchors when nothing
 *     matched at all.
 *
 * @param rawOutput    Raw combined stdout/stderr of the failed step.
 * @param maxLines     Hard cap on returned lines (including the "..." marker).
 * @param focusPaths   Optional file paths to prioritise (absolute or relative).
 */
export function pruneTrace(rawOutput: string, maxLines: number, focusPaths: string[] = []): string {
  if (!rawOutput.trim()) return "";
  if (maxLines <= 0) return "";

  const clean = rawOutput.replace(ANSI_PATTERN, "");
  const lines = clean.split("\n").map((l) => l.trimEnd());

  const focused: string[] = [];
  const critical: string[] = [];
  const focusNeedles = focusPaths
    .filter(Boolean)
    .map((p) => p.replace(/\\/g, "/"));

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Focused lines are kept even if they don't look like errors — a compiler
    // pointing at the file we just touched is always the most useful signal.
    const normalised = trimmed.replace(/\\/g, "/");
    if (focusNeedles.some((needle) => normalised.includes(needle))) {
      focused.push(trimmed);
      continue;
    }
    if (isCritical(trimmed)) critical.push(trimmed);
  }

  let result = dedupe([...focused, ...critical]);

  // If nothing looked critical, keep first/last lines as anchors.
  if (result.length === 0) {
    const anchors: string[] = lines.slice(0, 3).map((l) => l.trim());
    if (lines.length > 6) {
      anchors.push("...");
      anchors.push(...lines.slice(-3).map((l) => l.trim()));
    }
    result = dedupe(anchors.filter((l) => l.length > 0));
  }

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
}): string {
  const header = `[sentinel] Verification failed at step "${failure.step}"`;
  const exit = `exit code: ${failure.exitCode} | duration: ${failure.durationMs}ms`;
  const trace = failure.prunedTrace || failure.rawOutput.slice(0, 2000);

  let advice: string;
  if (failure.warnOnly) {
    advice = "This is a WARNING only; no rollback was performed.";
  } else if (failure.rolledBack) {
    advice = "Your changes were rolled back. Re-apply them only after fixing the cause.";
  } else {
    advice =
      "Your changes are still in place. Fix the reported error; do not repeat the same edit.";
  }

  return [
    header,
    exit,
    "─".repeat(60),
    trace,
    "─".repeat(60),
    advice,
  ].join("\n");
}
