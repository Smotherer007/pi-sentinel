/**
 * RepairState — the repair loop's memory, as data (P0 + P8).
 *
 * The loop that makes sentinel useful is also the one that can do damage: a
 * red turn is re-prompted, the agent edits again, and if nothing bounds that
 * it keeps going. What bounds it is a small amount of memory carried from turn
 * to turn — how many attempts are spent, which code state was already
 * re-prompted for, which files the cycle is about, where the cycle began.
 *
 * That memory used to live as six closure variables inside the extension
 * factory, interleaved with the effects it drives (restoring a checkpoint,
 * re-prompting the agent, notifying the human). Mixed together, the *policy*
 * — "stop when the state did not move" — could only be tested by driving the
 * whole extension against a fake host.
 *
 * Here it is data instead. Every field is a plain value, every transition is
 * a pure function `(state, input) => decision`, and the decision carries the
 * next state. Nothing in this module reads a file, writes one or talks to the
 * host; the caller performs the effects a decision asks for. The stop
 * conditions are therefore unit-testable as a truth table.
 */

import type { AutoFixAction, AutoFixOutcome, ScopeGuard } from "../types.ts";

/**
 * What the loop remembers between turns.
 *
 * Deliberately a value, not a class: the whole state is one flat record, so a
 * decision is reproducible from it and a test can assert on the exact next
 * state rather than on a sequence of mutations.
 */
export interface RepairState {
  /** Consecutive repair continuations since the last green turn or user message. */
  readonly attempts: number;
  /**
   * Identity of the code state the last re-prompt referred to.
   *
   * A red turn whose hash matches it has nothing new to say, so the guard
   * stops instead of repeating itself — this is Codex's "the remaining delta
   * stops changing" stop condition, made observable.
   */
  readonly injectedStateHash: string | null;
  /**
   * The paths the hash covered. A turn that changed nothing still refers to
   * the files of the previous attempt, so both are compared over the same set.
   */
  readonly injectedPaths: readonly string[];
  /**
   * Checkpoint of the *first* turn of the current red cycle.
   *
   * Exhaustion restores exactly this, so `rollbackAfterExhaustion` returns to
   * the state before the cycle began rather than merely undoing the last
   * attempt.
   */
  readonly startCheckpointId: string | null;
  /**
   * The files the current cycle is about, or null before its first attempt.
   *
   * A later attempt that reaches past this set is varying an approach instead
   * of fixing a cause — the documented way one failure becomes several.
   */
  readonly scope: readonly string[] | null;
  /**
   * Signature of the last policy violation already sent to the agent.
   *
   * An identical violation is shown to the human but never re-sent, so a
   * policy stop cannot become a loop of its own. It shares this record because
   * it shares the lifecycle: a new user message or a green turn reopens it.
   */
  readonly policySignature: string | null;
  /**
   * The code state a cycle already gave up on.
   *
   * Stopping used to *clear* the loop's memory, which erased the very record
   * that had detected the stall: the next red turn found no hash to compare
   * against, re-prompted, stalled again, cleared again. A live session turned
   * `maxAttempts: 2` into eight alternating inject/stop cycles that way — the
   * guard's own reset was the thing keeping the loop alive.
   *
   * A stall is therefore remembered rather than forgotten. It is lifted the
   * only two ways a cycle should end: a real user message, or a green run.
   */
  readonly stalledStateHash: string | null;
}

/** The state a fresh cycle starts from — also the reset after a green turn. */
export function initialRepairState(): RepairState {
  return {
    attempts: 0,
    injectedStateHash: null,
    injectedPaths: [],
    startCheckpointId: null,
    scope: null,
    policySignature: null,
    stalledStateHash: null,
  };
}

/** What the failure payload should say about the attempt it reports. */
export interface AttemptInfo {
  attempt: number;
  max: number;
  /** The loop stopped because the code state did not move. */
  stopped?: boolean;
}

/** Everything a red turn must supply for the state machine to decide. */
export interface RepairInput {
  /**
   * False when the failure says nothing the agent should be re-prompted for:
   * a `warnOnly` step, or a failure the environment caused (a timeout, a
   * missing binary). Those are reported, never repaired.
   */
  recoverable: boolean;
  /** Upper bound on consecutive attempts within one cycle. */
  maxAttempts: number;
  /** How strictly the cycle is confined to the files it started from. */
  scopeGuard: ScopeGuard;
  /** Restore the pre-cycle state once the attempt budget is spent. */
  rollbackAfterExhaustion: boolean;
  /** The step that failed, for the audit trail. */
  step: string;
  /** Identity of the code state this failure refers to. */
  stateHash: string;
  /** The paths `stateHash` was computed over. */
  paths: readonly string[];
  /** Pre-state checkpoint of this turn, when one was captured. */
  checkpointId?: string;
}

/** What to do after a red turn, plus the state the next turn starts from. */
export interface RepairDecision {
  state: RepairState;
  action: AutoFixAction;
  /** The attempt budget this decision was made against. */
  maxAttempts: number;
  /** Why the loop decided this — written to the audit trail verbatim. */
  reason: string;
  /** Rendered into the failure payload, so the agent sees its budget. */
  attempt?: AttemptInfo;
  /**
   * A checkpoint the caller must restore, set only when the budget is spent
   * and `rollbackAfterExhaustion` is on. Naming it here keeps the decision
   * pure — restoring is the caller's effect to perform.
   */
  restoreCheckpointId: string | null;
}

/**
 * The path set a failure is judged against.
 *
 * A turn that changed nothing still refers to the files of the previous
 * attempt, so both are hashed over the same paths. Without that, the "the
 * delta stopped changing" stop condition could never trigger — every no-op
 * turn would produce a hash of the empty set and look like a new state.
 */
export function deltaPathsOf(
  state: RepairState,
  focusPaths: readonly string[],
): readonly string[] {
  if (focusPaths.length > 0) return focusPaths;
  return state.injectedPaths.length > 0 ? state.injectedPaths : focusPaths;
}

/**
 * Decide what happens after a red turn.
 *
 * The three stop conditions, in the order they are checked:
 *
 *   1. **Not recoverable** — nothing to repair. A `warnOnly` step or an
 *      environment failure is reported and spends no attempt.
 *   2. **The state did not move** — the same hash was already re-prompted for,
 *      so another attempt would repeat itself.
 *   3. **The budget is spent** — the attempt count reached `maxAttempts`.
 *
 * Only when none of them holds is the budget charged and an attempt injected.
 */
export function decideRepair(state: RepairState, input: RepairInput): RepairDecision {
  const max = Math.max(1, Math.floor(input.maxAttempts));

  if (!input.recoverable) {
    return {
      state,
      action: "none",
      maxAttempts: max,
      reason: `${input.step} is not a repair target`,
      restoreCheckpointId: null,
    };
  }

  // Already given up on exactly this state: say nothing at all. Repeating the
  // report every turn would be noise, and re-deciding would restart the loop.
  if (state.stalledStateHash !== null && state.stalledStateHash === input.stateHash) {
    return {
      state,
      action: "none",
      maxAttempts: max,
      reason: "the loop already stopped for this code state",
      restoreCheckpointId: null,
    };
  }

  if (state.injectedStateHash !== null && state.injectedStateHash === input.stateHash) {
    return {
      // The stall is recorded, not cleared. Everything else is kept so a later
      // turn cannot mistake an abandoned cycle for a fresh one.
      state: { ...state, stalledStateHash: input.stateHash },
      action: "stop-unchanged",
      maxAttempts: max,
      reason: "identical code state",
      attempt: { attempt: state.attempts, max, stopped: true },
      restoreCheckpointId: null,
    };
  }

  if (state.attempts + 1 > max) {
    return {
      // The cycle is over either way; a spent budget must not be inherited by
      // a later cycle through a stale start checkpoint.
      state: { ...state, startCheckpointId: null },
      action: "exhausted",
      maxAttempts: max,
      reason: `recovery.maxAttempts=${max}`,
      // No attempt info on purpose: the payload reports the failure, not a
      // continuation that will not happen.
      restoreCheckpointId: input.rollbackAfterExhaustion ? state.startCheckpointId : null,
    };
  }

  const attempts = state.attempts + 1;
  return {
    state: {
      attempts,
      injectedStateHash: input.stateHash,
      injectedPaths: [...input.paths],
      // The first attempt of a cycle remembers where the cycle began; later
      // attempts must not overwrite it, or exhaustion would restore the wrong
      // state.
      startCheckpointId: state.startCheckpointId ?? input.checkpointId ?? null,
      // Likewise the scope is set by the first attempt and never widened.
      scope: state.scope ?? (input.scopeGuard === "off" ? null : unique(input.paths)),
      policySignature: state.policySignature,
      // A genuinely new state is worth an attempt, so the old stall no longer
      // describes anything.
      stalledStateHash: null,
    },
    action: "inject",
    maxAttempts: max,
    reason: input.step,
    attempt: { attempt: attempts, max },
    restoreCheckpointId: null,
  };
}

/**
 * The audit-trail outcome for a decision, or null when there is nothing to
 * record. Keeps the vocabulary of `/sentinel status` in one place.
 */
export function autoFixOutcomeOf(action: AutoFixAction): AutoFixOutcome | null {
  switch (action) {
    case "inject":
      return "injected";
    case "stop-unchanged":
      return "stopped";
    case "exhausted":
      return "exhausted";
    case "none":
      return null;
  }
}

/**
 * Files this turn touched which the open cycle was not about.
 *
 * Reported (or, with `scopeGuard: "block"`, refused) because a widening change
 * set is the earliest observable sign that the agent is varying an approach
 * instead of fixing a cause. Empty while no cycle is open, and while the guard
 * is off.
 */
export function scopeEscapeOf(
  state: RepairState,
  touchedPaths: readonly string[] | undefined,
  scopeGuard: ScopeGuard,
): string[] {
  if (scopeGuard === "off" || !state.scope) return [];
  return (touchedPaths ?? []).filter((path) => !state.scope!.includes(path));
}

/**
 * Whether a write to `absPath` is allowed by the open cycle.
 *
 * Only `scopeGuard: "block"` refuses anything; the other values let the write
 * happen and name it in the failure payload afterwards.
 */
export function writeInScope(
  state: RepairState,
  absPath: string,
  scopeGuard: ScopeGuard,
): boolean {
  if (scopeGuard !== "block" || !state.scope) return true;
  return state.scope.includes(absPath);
}

/**
 * Whether the trace sentinel last injected still describes the current code.
 *
 * Compaction and stale results are the same problem seen twice: evidence that
 * is not bound to a state the agent can still see. The caller supplies the
 * hash of the files as they are now.
 */
export function traceIsStale(state: RepairState, currentStateHash: string): boolean {
  if (state.injectedStateHash === null || state.injectedPaths.length === 0) return false;
  return currentStateHash !== state.injectedStateHash;
}

/**
 * The state a sentinel message was bound to, as it travels through the session.
 *
 * A verification payload is composed when a run finishes and delivered at the
 * next turn boundary — minutes later, in the worst case. By then the code it
 * describes may be fixed, and the payload that says "fix this" is describing a
 * tree that no longer exists. Reading the binding back off the message is what
 * lets the delivery check ask *its own* question instead of the current repair
 * cycle's: "is the state this message names still the state on disk?".
 */
export interface TraceBinding {
  readonly stateHash: string;
  readonly paths: readonly string[];
}

/**
 * Read a message's own binding, or `null` when it carries none.
 *
 * Messages sent before this existed, notices and resolutions carry no paths —
 * for those the caller keeps whatever behaviour it had.
 */
export function readTraceBinding(details: unknown): TraceBinding | null {
  if (typeof details !== "object" || details === null) return null;
  const record = details as { stateHash?: unknown; paths?: unknown };
  if (typeof record.stateHash !== "string" || record.stateHash.length === 0) return null;
  if (!Array.isArray(record.paths) || record.paths.length === 0) return null;
  const paths = record.paths.filter((p): p is string => typeof p === "string" && p.length > 0);
  if (paths.length === 0) return null;
  return { stateHash: record.stateHash, paths };
}

/**
 * Did the state this message names move since it was written?
 *
 * `hashOf` is injected so this stays pure: the caller brings the hashing, the
 * decision is testable without a filesystem.
 */
export function bindingIsStale(
  binding: TraceBinding | null,
  hashOf: (paths: readonly string[]) => string,
): boolean {
  if (!binding) return false;
  try {
    return hashOf(binding.paths) !== binding.stateHash;
  } catch {
    return false;
  }
}

/** Remember (or, with null, reopen) the policy violation already re-prompted for. */
export function withPolicySignature(
  state: RepairState,
  signature: string | null,
): RepairState {
  return state.policySignature === signature ? state : { ...state, policySignature: signature };
}

/** De-duplicate while preserving order — the scope is read as a file list. */
function unique(paths: readonly string[]): string[] {
  return [...new Set(paths)];
}
