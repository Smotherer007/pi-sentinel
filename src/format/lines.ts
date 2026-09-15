/**
 * Line ranking — the shared vocabulary of "which lines matter".
 *
 * Two consumers need the same answer to that question:
 *   - `pruner.ts` decides which lines of a failed run reach the agent,
 *   - `classify.ts` decides what kind of failure the run was.
 *
 * Keeping the ranking in one pure module means a line can never be "critical"
 * for the pruner and "noise" for the classifier.
 *
 * Ranks (lower = more valuable), mirroring the priority order in the docs:
 *   0 focus          a path the agent just mutated
 *   1 compiler error TS/CS/MSB/rustc/gcc style diagnostics
 *   2 test failure   a named failing test
 *   3 assertion      expected/actual pairs
 *   4 stack          stack frames, `Caused by`
 *   5 location       file:line:column, (line,col)
 *   6 context        indented continuation, caret, source snippet
 *   7 noise          npm notices, download logs, everything else
 */

/** Matches ANSI SGR / CSI escape sequences emitted by colourised tools. */
// eslint-disable-next-line no-control-regex
const ANSI_PATTERN = /\u001b\[[0-9;]*[A-Za-z]/g;

export const RANK = {
  focus: 0,
  compilerError: 1,
  testFailure: 2,
  assertion: 3,
  stack: 4,
  location: 5,
  context: 6,
  noise: 7,
} as const;

/** Highest rank that still counts as a real diagnostic. */
export const DIAGNOSTIC_RANK = RANK.location;

interface Ranked {
  rank: number;
  pattern: RegExp;
}

/**
 * First match wins, so the more specific a signal, the earlier it must be.
 */
const RANKED_PATTERNS: Ranked[] = [
  // ── compiler / type checker ───────────────────────────────────────────
  { rank: RANK.compilerError, pattern: /\berror TS\d{4}\b/ },
  { rank: RANK.compilerError, pattern: /\bTS\d{4}:/ },
  { rank: RANK.compilerError, pattern: /^\S*\(\d+,\d+\):\s*error\b/ },
  { rank: RANK.compilerError, pattern: /\berror\[E\d+\]/ },
  { rank: RANK.compilerError, pattern: /\berror (CS|MSB|LNK|BC)\d+/ },
  { rank: RANK.compilerError, pattern: /^error:/i },
  { rank: RANK.compilerError, pattern: /\berror:/i },
  { rank: RANK.compilerError, pattern: /^\S+:\d+(:\d+)?:\s*error\b/ },
  { rank: RANK.compilerError, pattern: /is not assignable to type/ },
  { rank: RANK.compilerError, pattern: /\bBUILD FAILED\b/ },

  // ── failing tests ─────────────────────────────────────────────────────
  { rank: RANK.testFailure, pattern: /^\s*[✖✕]/ },
  { rank: RANK.testFailure, pattern: /^\s*not ok\b/ },
  { rank: RANK.testFailure, pattern: /^\s*(FAIL|FAILED)\b/ },
  { rank: RANK.testFailure, pattern: /\bAssertionError\b/ },
  { rank: RANK.testFailure, pattern: /^Tests:\s.*\bfailed\b/ },
  { rank: RANK.testFailure, pattern: /\b\d+\s+(failed|failing)\b/i },
  { rank: RANK.testFailure, pattern: /\btest(s)? (failed|failure)\b/i },
  { rank: RANK.testFailure, pattern: /\bFAILED:/ },

  // ── assertions ────────────────────────────────────────────────────────
  { rank: RANK.assertion, pattern: /^\s*(expected|actual|received)\b/i },
  { rank: RANK.assertion, pattern: /^\s*[-+]\s*(expected|received)/i },
  { rank: RANK.assertion, pattern: /^\s*Expected .*(to|:) / },

  // ── stack traces ──────────────────────────────────────────────────────
  { rank: RANK.stack, pattern: /^\s+at\s+\S/ },
  { rank: RANK.stack, pattern: /^\s*Caused by:/ },
  { rank: RANK.stack, pattern: /^\s*File ".*", line \d+/ },
  { rank: RANK.stack, pattern: /^\s*at .*:\d+:\d+/ },

  // ── source locations / context ────────────────────────────────────────
  { rank: RANK.location, pattern: /:\d+:\d+/ },
  { rank: RANK.location, pattern: /\(\d+,\d+\)/ },
  { rank: RANK.context, pattern: /^\s*\d+\s*[|│]/ },
  { rank: RANK.context, pattern: /^\s*\^+\s*$/ },
  { rank: RANK.context, pattern: /^\s{2,}\S/ },
];

/** Remove ANSI colour codes. */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, "");
}

/** Rank a single (already trimmed) line; 7 for anything unrecognised. */
export function rankLine(line: string): number {
  for (const { rank, pattern } of RANKED_PATTERNS) {
    if (pattern.test(line)) return rank;
  }
  return RANK.noise;
}

/** True when the rank is a real diagnostic rather than context or noise. */
export function isDiagnosticRank(rank: number): boolean {
  return rank <= DIAGNOSTIC_RANK;
}

/** Collapse consecutive duplicate lines while keeping the first occurrence. */
export function dedupeLines(lines: string[]): string[] {
  const out: string[] = [];
  for (const line of lines) {
    if (out.length > 0 && out[out.length - 1] === line) continue;
    out.push(line);
  }
  return out;
}

/**
 * The diagnostic lines of a raw output, most valuable first.
 * Used by the classifier to build a stable failure signature.
 */
export function errorLines(output: string, limit = 3): string[] {
  const out: string[] = [];
  for (const raw of stripAnsi(output).split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const rank = rankLine(line);
    if (!isDiagnosticRank(rank)) continue;
    if (out.includes(line)) continue;
    out.push(line);
    if (out.length >= limit) break;
  }
  return out;
}
