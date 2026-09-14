/**
 * FailureEscalation — notice that the agent is going in circles.
 *
 * A repair loop fails in a characteristic way: the same compiler error comes
 * back turn after turn while the edits get bigger and less related to the
 * cause. Sentinel already stops *itself* re-prompting when the code state does
 * not move; this tracker covers the other case, where the state keeps changing
 * but the error is identical — the agent is trying variations of an approach
 * that does not work.
 *
 * Counting is by failure *signature* (kind + the first diagnostic lines), so
 * a genuinely new error resets nothing and is not treated as a repeat.
 * In-memory per session: a repaired failure must not stay "escalated" after a
 * restart, and the durable part (the audit trail) is written to state.
 */

export interface EscalationStatus {
  signature: string;
  count: number;
  /** True once the count reached the configured threshold. */
  escalated: boolean;
}

export class FailureEscalationTracker {
  private counts = new Map<string, number>();

  /** Record one occurrence; returns the new count for that signature. */
  record(signature: string): number {
    const next = (this.counts.get(signature) ?? 0) + 1;
    this.counts.set(signature, next);
    return next;
  }

  count(signature: string): number {
    return this.counts.get(signature) ?? 0;
  }

  /** Forget every counter — a green verification means the loop converged. */
  reset(): void {
    this.counts.clear();
  }

  /** Every tracked signature with its count, most frequent first. */
  snapshot(): EscalationStatus[] {
    return [...this.counts.entries()]
      .map(([signature, count]) => ({ signature, count, escalated: false }))
      .sort((a, b) => b.count - a.count);
  }

  size(): number {
    return this.counts.size;
  }
}

/**
 * Whether a count has reached the escalation threshold.
 * A threshold of 0 or less disables escalation entirely.
 */
export function shouldEscalate(count: number, maxRepeatedFailures: number): boolean {
  if (maxRepeatedFailures <= 0) return false;
  return count >= maxRepeatedFailures;
}
