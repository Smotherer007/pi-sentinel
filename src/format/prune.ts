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

  const blocks = assertionBlocks(lines);
  const ranked: RankedLine[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line) continue;
    const block = blocks.get(index);
    if (block !== undefined) {
      if (block !== RANK.noise) ranked.push({ line, rank: block, index });
      continue;
    }
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

/** YAML block keys test runners use for the failure itself (node:test TAP, tap). */
const BLOCK_KEY = /^(\s*)(error|expected|actual|diff|message|found|wanted):\s*[|>][-+]?\s*$/;

/**
 * Lines inside `error: |-` / `expected: |-` / `actual: |-` blocks carry the
 * values that explain a failing assertion, but on their own they look like
 * indented context. Rank them as assertions; the key line itself is noise
 * (`error: |-` would otherwise look like a compiler error).
 */
function assertionBlocks(lines: string[]): Map<number, number> {
  const out = new Map<number, number>();
  for (let i = 0; i < lines.length; i += 1) {
    const key = BLOCK_KEY.exec(lines[i]);
    if (!key) continue;
    // `expected:` / `actual:` label the values that follow; `error: |-` would read as a compiler error.
    out.set(i, key[2] === "error" || key[2] === "message" ? RANK.noise : RANK.assertion);
    const indent = key[1].length;
    let taken = 0;
    for (let j = i + 1; j < lines.length; j += 1) {
      const raw = lines[j];
      if (raw.trim() === "") continue;
      if (raw.length - raw.trimStart().length <= indent) break;
      if (taken < 12) out.set(j, Math.min(rankLine(raw.trim()), RANK.assertion));
      else out.set(j, RANK.noise);
      taken += 1;
      i = j;
    }
  }
  return out;
}
