/**
 * The repair loop's decision, as a pure function.
 *
 * When the agent finishes with a red gate, sentinel may send it back. Two
 * things bound that loop: an attempt budget per user prompt, and progress — a
 * repair round that changed no code cannot have fixed anything, so asking
 * again would only burn tokens.
 */

export interface RepairState {
  /** Repair prompts sent since the last user prompt. */
  attempts: number;
}

export const initialRepairState = (): RepairState => ({ attempts: 0 });

export type RepairDecision =
  | { action: "skip" } // nothing changed, nothing open: no checks needed
  | { action: "stop"; reason: "no-progress" } // a repair round changed nothing
  | { action: "check" }; // run the gate

/** Before running the gate. */
export function beforeGate(state: RepairState, changedThisRun: number): RepairDecision {
  if (changedThisRun > 0) return { action: "check" };
  return state.attempts > 0 ? { action: "stop", reason: "no-progress" } : { action: "skip" };
}

export type RedDecision =
  | { action: "repair"; attempt: number; next: RepairState }
  | { action: "stop"; reason: "exhausted" | "disabled"; next: RepairState };

/** After the gate came back red with a code failure. */
export function onRed(state: RepairState, options: { enabled: boolean; maxAttempts: number }): RedDecision {
  if (!options.enabled || options.maxAttempts <= 0) {
    return { action: "stop", reason: "disabled", next: initialRepairState() };
  }
  if (state.attempts >= options.maxAttempts) {
    return { action: "stop", reason: "exhausted", next: initialRepairState() };
  }
  const attempt = state.attempts + 1;
  return { action: "repair", attempt, next: { attempts: attempt } };
}
