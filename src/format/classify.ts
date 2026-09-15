/**
 * FailureClassify — turns a failed command into a *category*, not just an
 * exit code.
 *
 * The category is what makes the agent's reaction correct. A timeout or a
 * missing binary means "the pipeline/environment is broken, do not touch the
 * source"; a type error means "fix the code". Treating all of them as "the
 * check failed" is what sends agents off rewriting working code when only
 * `npx` was slow.
 *
 * Pure: strings in, values out. Heuristics are ordered most-specific-first so
 * a `tsc` failure inside a test runner is still a type error.
 */

import { createHash } from "node:crypto";

import { errorLines } from "./lines.ts";
import type { FailureKind } from "../types.ts";

export interface ClassifyInput {
  stepName: string;
  cmd: string;
  exitCode: number;
  timedOut?: boolean;
  output: string;
}

interface Probe {
  kind: FailureKind;
  pattern: RegExp;
}

/** Generic evidence in the output, most specific first. */
const PROBES: Probe[] = [
  // The command could not be started at all.
  { kind: "command-not-found", pattern: /\bcommand not found\b/i },
  { kind: "command-not-found", pattern: /is not recognized as an internal or external command/i },
  { kind: "command-not-found", pattern: /\bspawn\b[^\n]*\bENOENT\b/i },
  { kind: "command-not-found", pattern: /terminated with exit code 127\b/ },

  // The environment, not the code, failed the step.
  { kind: "environment-error", pattern: /\bEACCES\b|\bEPERM\b|\bENOSPC\b|\bENOMEM\b/i },
  { kind: "environment-error", pattern: /\bECONNREFUSED\b|\bECONNRESET\b|\bEAI_AGAIN\b|\bENOTFOUND\b/ },
  { kind: "environment-error", pattern: /\bEADDRINUSE\b|\bETIMEDOUT\b/ },
  { kind: "environment-error", pattern: /npm ERR!\s+network\b/i },
  { kind: "environment-error", pattern: /\bnetwork (error|timeout|is unreachable)\b/i },
  { kind: "environment-error", pattern: /\bcwd\b[^\n]*escapes the project root/i },
  { kind: "environment-error", pattern: /\bunable to resolve dependency tree\b/i },
  { kind: "environment-error", pattern: /\bpermission denied\b/i },

  // A step the project cannot run *at all*: no such script, no test files, a
  // harness that was never set up. It is named like a command problem because
  // that is what it is — the pipeline points at something this project does not
  // have — and classifying it as a code failure made a project without a `test`
  // script (a plain Node 26 project, say) report a red turn after every edit and
  // spend repair attempts on a file nobody broke. Nothing here is evidence about
  // the diff, so it must never roll anything back or re-prompt the agent.
  { kind: "environment-error", pattern: /npm ERR!\s+Missing script\b/i },
  { kind: "environment-error", pattern: /\bMissing script:?\s+["'`]?[\w:-]+/i },
  { kind: "environment-error", pattern: /ERR_PNPM_NO_SCRIPT\b/ },
  { kind: "environment-error", pattern: /Couldn't find a script named/i },
  { kind: "environment-error", pattern: /\bNo test files found,/i },
  { kind: "environment-error", pattern: /\bnpm run\b[^\n]*\bmissing script\b/i },

  // Source-level diagnostics.
  { kind: "type-error", pattern: /\berror TS\d{4}\b/ },
  { kind: "type-error", pattern: /\bTS\d{4}:\s/ },
  { kind: "type-error", pattern: /is not assignable to type/ },
  { kind: "build-failure", pattern: /\berror\[E\d+\]/ },
  { kind: "build-failure", pattern: /\berror (CS|MSB|LNK|BC)\d+/ },
  { kind: "build-failure", pattern: /\bBUILD FAILED\b/ },
  { kind: "build-failure", pattern: /\bCompilation (failed|error)\b/i },
  { kind: "build-failure", pattern: /Undefined symbols for architecture/ },
  { kind: "build-failure", pattern: /\b(linker|link) command failed\b/i },
  { kind: "build-failure", pattern: /^\s*make(\[\d+\])?: \*\*\*/m },
  { kind: "build-failure", pattern: /^\S+\.go:\d+:\d+:/m },

  // Linters name themselves.
  { kind: "lint-error", pattern: /\b(eslint|stylelint|prettier|biome|clippy|ruff|flake8)\b/i },
  { kind: "lint-error", pattern: /\d+ problems? \(\d+ errors?/i },
  { kind: "lint-error", pattern: /^\s*✖\s*\d+ problems?/m },

  // Test runners and their assertions.
  { kind: "test-failure", pattern: /\bAssertionError\b/ },
  { kind: "test-failure", pattern: /^\s*not ok \d+/m },
  { kind: "test-failure", pattern: /^Tests:\s.*\bfailed\b/m },
  { kind: "test-failure", pattern: /^\s*(FAIL|FAILED)\b/m },
  { kind: "test-failure", pattern: /^\s*[✖✕]/m },
  { kind: "test-failure", pattern: /\b\d+\s+(failed|failing)\b/i },
  { kind: "test-failure", pattern: /\b(expected|received)\b.*\bassert/i },
];

/** Step-name hints, used only when the output gave nothing conclusive. */
const NAME_PROBES: Probe[] = [
  { kind: "type-error", pattern: /type[-_ ]?check|tsc|typecheck/i },
  { kind: "lint-error", pattern: /lint|eslint|stylelint|prettier/i },
  { kind: "test-failure", pattern: /test|spec|jest|vitest|mocha|pytest/i },
  { kind: "build-failure", pattern: /build|compile|bundle|link/i },
];

/**
 * Classify a failed step.
 *
 * `timedOut` wins over everything: a killed process did not tell us anything
 * about the code, so claiming it was a type error would be a guess.
 */
export function classifyFailure(input: ClassifyInput): FailureKind {
  if (input.timedOut) return "timeout";
  if (input.exitCode === 124) return "timeout";
  if (input.exitCode === 127) return "command-not-found";

  const haystack = `${input.stepName}\n${input.cmd}\n${input.output}`;
  for (const probe of PROBES) {
    if (probe.pattern.test(haystack)) return probe.kind;
  }
  for (const probe of NAME_PROBES) {
    if (probe.pattern.test(input.stepName)) return probe.kind;
  }
  return "unknown";
}

/** Human-readable label for the feedback header. */
export function failureHeadline(kind: FailureKind): string {
  switch (kind) {
    case "type-error":
      return "type error";
    case "lint-error":
      return "lint problem";
    case "test-failure":
      return "failing test";
    case "build-failure":
      return "build failure";
    case "timeout":
      return "timeout";
    case "command-not-found":
      return "command not found";
    case "environment-error":
      return "environment error";
    default:
      return "unclassified failure";
  }
}

/**
 * What the agent should do about this kind of failure.
 *
 * The two `null` cases are deliberate: for a type or test error the generic
 * advice in `formatError` is already the right one, and an extra sentence
 * would only cost tokens.
 */
export function failureAdvice(kind: FailureKind): string | null {
  switch (kind) {
    case "timeout":
      return "This is a timeout, not a code error: the step was killed after its budget. Re-run it, or raise `timeoutMs` — do not rewrite working code because a check was slow.";
    case "command-not-found":
      return "The command could not be started. Fix the pipeline configuration or install the tool — do not change application code for this.";
    case "environment-error":
      return "The environment failed the step, not the code. Retry, or fix the environment/tooling instead of rewriting source.";
    case "lint-error":
      return "Fix the reported lint findings; run the linter again yourself before claiming it passes.";
    case "build-failure":
      return "The build failed. Fix the first error in the trace — later errors are usually its consequences.";
    case "unknown":
      return "Read the trace before editing: nothing in the output identifies a code error sentinel could act on.";
    default:
      return null;
  }
}

/** One-line summary of the most valuable error line (bounded). */
export function summarizeFailure(kind: FailureKind, output: string, maxLength = 160): string {
  if (kind === "timeout") return "step exceeded its timeout and was killed";
  const [first] = errorLines(output, 1);
  if (!first) return failureHeadline(kind);
  return first.length > maxLength ? `${first.slice(0, maxLength - 1)}…` : first;
}

/**
 * Stable identity of a failure, so "the same error again" can be detected.
 * Whitespace-insensitive and normalised, so a re-run with different line
 * numbers inside a duplicated message still counts as the same failure.
 */
export function failureSignature(kind: FailureKind, output: string): string {
  const lines = errorLines(output, 3).map((line) => line.replace(/\s+/g, " ").trim());
  return createHash("sha1").update(`${kind}\n${lines.join("\n")}`).digest("hex").slice(0, 12);
}
