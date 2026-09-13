/**
 * FailureFeedback — one place that turns a red verification run into the
 * payload the model actually reads.
 *
 * Both the hooks (index.ts) and the `sentinel_verify` tool must produce the
 * exact same feedback, otherwise the agent learns two different dialects of
 * "the check failed". This module composes:
 *
 *   pruned trace (pruner.ts)
 *     + regressed verified states   (P2, evidence.ts)
 *     + impact from the code graph  (mindplace.ts)
 *     + bounded-retry accounting    (P0)
 *     + output budget & spill       (P5, spill.ts)
 *
 * Pure with respect to sentinel's own state: it reads the ledger and the graph
 * but writes nothing except the optional spill file.
 */

import * as path from "node:path";

import { projectDir } from "../config.ts";
import { formatError } from "./pruner.ts";
import { applyOutputCap } from "../clients/spill.ts";
import { detectRegressions, stateHashOf } from "../clients/evidence.ts";
import { impactOfAll } from "../clients/mindplace.ts";
import type { FailureKind, Regression, RollbackConflict, SpillResult } from "../types.ts";

export interface FailureFeedbackInput {
  cwd: string;
  step: string;
  exitCode: number;
  durationMs: number;
  prunedTrace: string;
  rawOutput: string;
  warnOnly: boolean;
  rolledBack: boolean;
  /** Files this verification was about — the evidence & impact scope. */
  focusPaths: string[];
  /** Identity of the verified code state (evidence.ts:stateHashOf). */
  stateHash?: string;
  /** P0 retry accounting, omitted for on-demand runs. */
  attempt?: { attempt: number; max: number; stopped?: boolean };
  /** P6: classification of the failure, and what it implies. */
  failureKind?: FailureKind;
  /** P6: true when the step was killed because it exceeded its timeout. */
  timedOut?: boolean;
  /** P6: one-line summary of what failed. */
  errorSummary?: string;
  /** P6: attempts needed by the failing step (only interesting when > 1). */
  attempts?: number;
  /** P6: the same failure has now been seen this many times. */
  escalation?: { count: number; max: number };
  /** P6: files left untouched because they changed since the snapshot. */
  conflicts?: RollbackConflict[];
  /**
   * Regressions detected *before* any revert ran. Callers that restore files
   * must pass the pre-revert list, otherwise the feedback would claim
   * everything was fine after sentinel itself repaired it.
   */
  regressions?: Regression[];
  /** P2: detect regressions here (default true); ignored when `regressions` is given. */
  includeRegressions?: boolean;
  /** Mindplace: include the code-graph blast radius (default true). */
  includeImpact?: boolean;
  /** P5 token budget; 0 disables the cap. */
  maxOutputTokens: number;
}

/** Absolute path the full verification output is spilled into. */
export function spillDir(cwd: string): string {
  return path.join(projectDir(cwd), "spills");
}

/**
 * Build the model-visible failure payload, bounded by the output budget.
 */
export function buildFailureFeedback(input: FailureFeedbackInput): SpillResult {
  const regressions =
    input.regressions ??
    (input.includeRegressions === false ? [] : detectRegressions(input.cwd, input.focusPaths));

  const impact =
    input.includeImpact === false ? [] : impactOfAll(input.cwd, input.focusPaths);

  const text = formatError({
    step: input.step,
    exitCode: input.exitCode,
    durationMs: input.durationMs,
    prunedTrace: input.prunedTrace,
    rawOutput: input.rawOutput,
    warnOnly: input.warnOnly,
    rolledBack: input.rolledBack,
    regressions,
    impact,
    // The payload always carries the identity of the state it describes, even
    // when a caller forgot to compute it.
    stateHash: input.stateHash ?? stateHashOf(input.focusPaths),
    attempt: input.attempt,
    failureKind: input.failureKind,
    timedOut: input.timedOut,
    errorSummary: input.errorSummary,
    attempts: input.attempts,
    escalation: input.escalation,
    conflicts: input.conflicts,
  });

  return applyOutputCap(text, input.maxOutputTokens, spillDir(input.cwd), input.step);
}
