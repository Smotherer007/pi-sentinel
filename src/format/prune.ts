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
