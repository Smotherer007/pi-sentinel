/**
 * Revision contract (P4) — the rules that make a repair loop converge.
 *
 * Codex's own guidance for iterative repair loops is that a loop must know
 * when to stop, and the measured evidence is blunt: forcing extra revisions
 * *lowered* correctness by 14.7 percentage points, because agents revise code
 * that already passes (arXiv 2607.24604). The recommended countermeasure is a
 * written contract, not more retries:
 *
 *   - never revise code whose checks pass unless explicitly asked,
 *   - bound the number of repair attempts per failure,
 *   - never claim success without running the check,
 *   - when evidence is bound to an older state, say so instead of guessing.
 *
 * Sentinel injects this contract once per user turn, so it is scoped to work
 * the user actually asked for and never accumulates in the system prompt.
 */

import type { SentinelConfig } from "../types.ts";

/** Marker so other extensions (and tests) can recognise the block. */
export const CONTRACT_MARKER = "[sentinel:revision-contract]";

/**
 * What sentinel knows about the tree right now, so the contract can state it
 * instead of merely asserting the rule.
 */
export interface ContractEvidence {
  /** Project-relative paths that are verified green as of this turn. */
  verified?: string[];
  /** How many verified files exist beyond the ones listed. */
  more?: number;
}

/** Most files named in the contract; beyond this it is a count, not a list. */
export const MAX_CONTRACT_FILES = 12;

/**
 * Build the contract text for the active configuration.
 * Returns an empty string when the contract is disabled.
 *
 * `evidence` turns the first rule from an assertion into a fact. "Do not
 * rewrite code whose checks passed" is unactionable if the agent cannot tell
 * which code that is — the ledger knows, so the contract says it.
 */
export function revisionContractText(
  config: SentinelConfig,
  evidence: ContractEvidence = {},
): string {
  if (!config.revisionContract) return "";

  const rules = [
    `- A green check is evidence. Do not rewrite code whose checks just passed unless the user asked for exactly that change.`,
    `- At most ${config.maxAutoRetries} repair attempts per failing check. If the last attempt fails again, stop and report what you tried and what still fails — do not keep editing.`,
    "- Never state that a check passes unless you ran it in this turn (the step's own command, or `sentinel_verify`).",
  ];

  if (config.trackVerifiedState) {
    rules.push(
      "- If sentinel reports that a file regressed from a verified state, either restore that file or justify the change explicitly. Do not silently keep both.",
    );
    const verified = evidence.verified ?? [];
    if (verified.length > 0) {
      const listed = verified.slice(0, MAX_CONTRACT_FILES);
      const hidden = (evidence.more ?? 0) + Math.max(0, verified.length - listed.length);
      const suffix = hidden > 0 ? ` (+${hidden} more)` : "";
      rules.push(
        `- Verified green right now, at their current content: ${listed.join(", ")}${suffix}. Treat these as evidence: read them freely, but do not rewrite them unless the user asked for exactly that change or a failure names them.`,
      );
    }
  }
  if (config.autoRollback) {
    rules.push(
      "- autoRollback is on: a failing check restores the files you changed. Re-apply your edit only after you have fixed the cause.",
    );
  }
  if (config.impactAwareFocus) {
    rules.push(
      "- When sentinel lists dependents from the code graph, treat them as the blast radius: fix the cause in place, then check the dependents it names.",
    );
  }
  if (config.verification?.failureEscalation?.enabled) {
    rules.push(
      `- When the same failure comes back ${config.verification.failureEscalation.maxRepeatedFailures} times, stop varying the same edit: re-read the code and change the approach.`,
    );
  }

  return [`${CONTRACT_MARKER} active in this repository:`, ...rules].join("\n");
}
