/**
 * ChangePolicy — turn the *shape* of an agent turn into an enforceable rule.
 *
 * Verification answers "does it work?". A change policy answers a different
 * question: "is this the kind of change that was supposed to happen?" — twenty
 * unrelated files, a 500-line diff, or a rewritten CI workflow can all be
 * green and still be a serious mistake. Codex and Claude Code both gate this
 * class of change behind an explicit approval; sentinel turns it into a
 * structured error the agent has to answer.
 *
 * The engine is pure: it receives the before/after content of every changed
 * file and returns counts plus violations. I/O (reading the current file,
 * taking the pre-state from the snapshot store) stays in the callers, which is
 * what makes the rules unit-testable without a repository.
 *
 * Design rules:
 *   - Opt-in. `enabled: false` means every other field is inert.
 *   - `0` limits mean "no limit", never "zero allowed".
 *   - Line stats are a bounded LCS diff, so a huge generated file cannot turn
 *     a policy check into a CPU sink.
 */

import * as path from "node:path";

import { matchesGlob } from "../config.ts";
import type {
  PolicyConfig,
  PolicyReport,
  PolicyStats,
  PolicyViolation,
  SensitiveKind,
} from "../types.ts";

/** Before/after view of one file as the turn changed it. */
export interface PolicyChange {
  /** Absolute path of the file. */
  path: string;
  /** Content before the turn, or `null` when the file did not exist. */
  before: string | null;
  /**
   * False when the pre-state was never observed (e.g. a bash-only change).
   * Line statistics are then skipped instead of being invented.
   */
  beforeKnown: boolean;
  /** Content after the turn, or `null` when the file no longer exists. */
  after: string | null;
}

/** Lockfiles we recognise as "generated, review carefully". */
const LOCKFILES = new Set([
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lockb",
  "Cargo.lock",
  "Gemfile.lock",
  "poetry.lock",
  "composer.lock",
  "go.sum",
]);

/** Above this many DP cells the diff is approximated rather than computed. */
export const MAX_DIFF_CELLS = 4_000_000;

function normalisePath(p: string): string {
  return p.replace(/\\/g, "/");
}

function basename(p: string): string {
  const parts = normalisePath(p).split("/");
  return parts[parts.length - 1] ?? p;
}

/** Project-relative path for a message, falling back to the raw path. */
export function relativePath(cwd: string, absPath: string): string {
  const rel = path.relative(cwd, absPath);
  if (!rel || rel.startsWith("..")) return normalisePath(absPath);
  return normalisePath(rel);
}

/** A file with a NUL byte is binary; line counting would be meaningless. */
function looksBinary(text: string | null): boolean {
  return text !== null && text.includes("\0");
}

/** Split into lines, dropping the single trailing newline artefact. */
export function splitLines(text: string | null): string[] {
  if (text === null || text === "") return [];
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/**
 * Added/removed line counts via a bounded LCS.
 *
 * Exact for anything a human would review (the DP cell budget covers two
 * ~2000-line files), and a conservative whole-file approximation beyond that:
 * over-reporting a generated file is safe for a policy whose job is to stop
 * large changes, under-reporting would not be.
 */
export function countLineDiff(
  before: string[],
  after: string[],
): { added: number; removed: number } {
  const n = before.length;
  const m = after.length;
  if (n === 0) return { added: m, removed: 0 };
  if (m === 0) return { added: 0, removed: n };
  if (n * m > MAX_DIFF_CELLS) return { added: m, removed: n };

  let previous = new Uint32Array(m + 1);
  let current = new Uint32Array(m + 1);
  for (let i = 1; i <= n; i += 1) {
    for (let j = 1; j <= m; j += 1) {
      current[j] =
        before[i - 1] === after[j - 1]
          ? previous[j - 1] + 1
          : previous[j] >= current[j - 1]
            ? previous[j]
            : current[j - 1];
    }
    const swap = previous;
    previous = current;
    current = swap;
    current.fill(0);
  }

  const longestCommon = previous[m];
  return { added: m - longestCommon, removed: n - longestCommon };
}

/**
 * Classify a path against the built-in sensitive groups and custom globs.
 *
 * The argument must be project-relative: custom `sensitivePaths` are globs in
 * the same dialect as `include`/`exclude`, and an anchored pattern such as
 * `secrets/**` can never match an absolute path.
 */
export function sensitiveKind(projectPath: string, config: PolicyConfig): SensitiveKind | null {
  const rel = normalisePath(projectPath);
  if (/(^|\/)\.github\/workflows\//.test(rel)) return "workflow";
  const base = basename(rel);
  if (base === "package.json") return "package";
  if (LOCKFILES.has(base)) return "lockfile";
  const custom = config.sensitivePaths ?? [];
  if (custom.some((pattern) => matchesGlob(pattern, rel))) return "custom";
  return null;
}

function isAllowed(kind: SensitiveKind, config: PolicyConfig): boolean {
  switch (kind) {
    case "package":
      return config.allowPackageChanges !== false;
    case "lockfile":
      return config.allowLockfileChanges !== false;
    case "workflow":
      return config.allowWorkflowChanges !== false;
    default:
      // A custom `sensitivePaths` entry is an explicit "do not touch".
      return false;
  }
}

function violationFor(kind: SensitiveKind, rel: string): PolicyViolation {
  switch (kind) {
    case "workflow":
      return {
        rule: "allowWorkflowChanges",
        message: `Policy violation:\n${rel} may not be modified.`,
        paths: [rel],
      };
    case "package":
      return {
        rule: "allowPackageChanges",
        message: `Policy violation:\n${rel} may not be modified (dependency manifest).`,
        paths: [rel],
      };
    case "lockfile":
      return {
        rule: "allowLockfileChanges",
        message: `Policy violation:\n${rel} may not be modified (lockfile).`,
        paths: [rel],
      };
    default:
      return {
        rule: "sensitivePaths",
        message: `Policy violation:\n${rel} is a protected path and may not be modified.`,
        paths: [rel],
      };
  }
}

function emptyStats(): PolicyStats {
  return {
    changedFiles: 0,
    addedFiles: 0,
    deletedFiles: 0,
    modifiedFiles: 0,
    addedLines: 0,
    removedLines: 0,
    sensitive: [],
  };
}

/**
 * Evaluate one turn's changes against the policy.
 *
 * @param changes  Before/after view of every file the turn touched.
 * @param config   The `policy` block (already merged with defaults).
 * @param cwd      Project root, used for project-relative messages.
 */
export function evaluatePolicy(
  changes: PolicyChange[],
  config: PolicyConfig,
  cwd: string,
): PolicyReport {
  const stats = emptyStats();
  const violations: PolicyViolation[] = [];
  const disallowed: Array<{ kind: SensitiveKind; rel: string }> = [];

  for (const change of changes) {
    const before = change.before;
    const after = change.after;
    // Without an observed pre-state the caller has already established that the
    // path changed (that is what put it in `changes`), so it must not be
    // dropped here — a bash-driven deletion of a protected file is exactly the
    // case a policy has to catch.
    const changed = change.beforeKnown ? before !== after : true;
    if (!changed) continue;

    stats.changedFiles += 1;
    if (change.beforeKnown && before === null && after !== null) stats.addedFiles += 1;
    else if (change.beforeKnown && before !== null && after === null) stats.deletedFiles += 1;
    else stats.modifiedFiles += 1;

    if (change.beforeKnown && !looksBinary(before) && !looksBinary(after)) {
      const diff = countLineDiff(splitLines(before), splitLines(after));
      stats.addedLines += diff.added;
      stats.removedLines += diff.removed;
    }

    // `sensitiveKind` works on project-relative paths, like every other glob
    // in sentinel; `relativePath` also produces the label the agent reads.
    const rel = relativePath(cwd, change.path);
    const kind = sensitiveKind(rel, config);
    if (!kind) continue;
    stats.sensitive.push({ path: rel, kind });
    if (!isAllowed(kind, config)) disallowed.push({ kind, rel });
  }

  if (config.maxChangedFiles > 0 && stats.changedFiles > config.maxChangedFiles) {
    violations.push({
      rule: "maxChangedFiles",
      message:
        `Policy violation:\n${stats.changedFiles} files were changed, but at most ` +
        `${config.maxChangedFiles} are allowed per turn.`,
      paths: [],
    });
  }

  if (config.maxAddedLines > 0 && stats.addedLines > config.maxAddedLines) {
    violations.push({
      rule: "maxAddedLines",
      message:
        `Policy violation:\n${stats.addedLines} lines were added, but at most ` +
        `${config.maxAddedLines} are allowed per turn.`,
      paths: [],
    });
  }

  // One violation per file, so the agent is told exactly what to revert rather
  // than a count it cannot act on.
  for (const entry of disallowed) violations.push(violationFor(entry.kind, entry.rel));

  return { passed: violations.length === 0, stats, violations };
}

/** Model-visible rendering of a failed policy report. */
export function formatPolicyReport(report: PolicyReport, cwd: string): string {
  const lines = [
    "[sentinel] Change policy violation — the turn was not accepted.",
    "",
    "Change summary:",
    `  files changed: ${report.stats.changedFiles} (added ${report.stats.addedFiles}, modified ${report.stats.modifiedFiles}, deleted ${report.stats.deletedFiles})`,
    `  lines added:   ${report.stats.addedLines} | lines removed: ${report.stats.removedLines}`,
  ];

  if (report.stats.sensitive.length > 0) {
    lines.push("  sensitive:     " + report.stats.sensitive.map((s) => `${s.path} (${s.kind})`).join(", "));
  }

  lines.push("", "Violations:");
  for (const violation of report.violations) lines.push(`  • ${violation.message.replace(/\n/g, " ")}`);

  const restoreHint =
    "Revert the offending change (use `sentinel_rollback` or edit the file back). " +
    "If the change is intended, the user must relax the policy in sentinel.config.ts.";
  lines.push("", restoreHint, `Project root: ${cwd}`);
  return lines.join("\n");
}
